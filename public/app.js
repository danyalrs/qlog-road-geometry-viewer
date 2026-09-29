/** Main application controller. */

let processData = null;
let lastProcessedSegmentSelection = [];
let renderer = null;
let playStepTimer = null;
let playRafId = null;
let playbackAnim = null;
let routeTransition = {
  state: 'idle',
  pendingBoundaryIndex: null,
  pendingBoundarySegmentId: null,
  pendingBoundaryLocalTimeS: 0,
  boundarySwitchToken: 0,
  resumeAfterBoundary: false,
  boundaryLoadingStartedAt: null,
  frozenBoundaryIndex: null,
  boundaryFrozenPose: null,
  boundaryFrozenEast: null,
  boundaryFrozenNorth: null,
  frozenTimelineValue: null,
  frozenLogMonoTime: null,
  frozenTickCount: 0,
  arrowMovementDuringBoundaryM: 0,
  timelineMovementDuringBoundaryS: 0,
  staleCallbackCount: 0,
  bridgeCenterlinePoints: null,
  bridgeMetadata: null,
  bridgeProgress: 0,
  bridgeStartTimestampMs: null,
  bridgePausedAtMs: null,
  bridgePausedDurationMs: 0,
  bridgeDurationS: null,
  bridgeLengthM: 0,
  bridgeDistanceTravelledM: 0,
  nextVideoReady: false,
  arrowHeldAtBridgeEnd: false,
  bridgeFromSourceFile: null,
  bridgeToSourceFile: null,
  bridgeFromTimelineIndex: null,
  bridgeToTimelineIndex: null,
  bridgeMissingVideo: false,
  bridgeLastError: null,
  bridgeTransitionLabel: null,
};
let playSpeed = 1;
let localPlaybackVideo = null;
let stationaryMapCache = new Map();
let stationaryMapBuildCount = 0;
let lastLocalPlaybackState = null;
let connectedAccumulatedCache = null;
let roadGuidedStaticCache = null;
let roadGuidedRankedCache = null;
let roadGuidedSequenceCache = null;
let progressiveCombinedState = {
  availableSegments: [],
  prefix: [],
  visiblePrefix: [],
  processPrefix: [],
  hiddenLookahead: null,
  fullMap: null,
  displayMap: null,
  fullProcessData: null,
  displayProcessData: null,
  stateSnapshots: new Map(),
};
let progressiveViewportFollowArrow = false;
let progressiveViewportFollowSuspended = false;
let uiMode = 'review';
let mapBackgroundMode = 'grey';
let geographicMap = null;
let uiPresetApplying = false;
let primaryActionBusy = false;

const $ = (id) => document.getElementById(id);

function parseUiModeFromLocation() {
  const Ui = window.UiMode;
  if (Ui?.parseUiMode) return Ui.parseUiMode(window.location.search);
  return 'review';
}

function parseMapBackgroundFromLocation(streetAvailable = true) {
  const Ui = window.UiMode;
  if (Ui?.parseMapBackground) return Ui.parseMapBackground(window.location.search, { streetAvailable });
  return streetAvailable ? 'street' : 'grey';
}

function replaceUrlParams(updates) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(updates)) {
    if (value == null || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  window.history.replaceState({}, '', url);
}

function setControlChecked(id, checked, { dispatch = true } = {}) {
  const el = $(id);
  if (!el || el.type !== 'checkbox') return;
  if (el.checked === checked) return;
  el.checked = checked;
  if (dispatch && !uiPresetApplying) {
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function setSelectValue(id, value, { dispatch = true } = {}) {
  const el = $(id);
  if (!el || el.tagName !== 'SELECT') return;
  if (el.value === value) return;
  el.value = value;
  if (dispatch && !uiPresetApplying) {
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function applyUiLayerPreset(mode) {
  const preset = window.UiModePresets?.presetForUiMode?.(mode);
  if (!preset) return;
  uiPresetApplying = true;
  try {
    for (const [key, value] of Object.entries(preset)) {
      if (key === 'connectedAccumulatedMode') {
        setSelectValue('connectedAccumulatedMode', value, { dispatch: false });
      } else {
        setControlChecked(key, value === true, { dispatch: false });
      }
    }
    const modeSel = $('connectedAccumulatedMode');
    if (modeSel) modeSel.dispatchEvent(new Event('change', { bubbles: true }));
    const layerCb = $('layerConnectedAccumulated');
    const repCb = $('layerRepresentativeLaneLines');
    const fusedCb = $('layerFusedLanes');
    layerCb?.dispatchEvent(new Event('change', { bubbles: true }));
    repCb?.dispatchEvent(new Event('change', { bubbles: true }));
    fusedCb?.dispatchEvent(new Event('change', { bubbles: true }));
    if (getActiveProgressiveDisplayData() && renderer) {
      applyRendererPlaybackData();
      const map = renderer.stationaryLocalMap;
      if (map) refreshConnectedAccumulatedPolylines(map, { timelineIndex: parseInt($('timeline')?.value ?? '0', 10) });
      syncEvidenceTogglesFromLayers();
      syncGeographicMapScene();
      renderer.draw();
    }
  } finally {
    uiPresetApplying = false;
  }
}

function syncEvidenceTogglesFromLayers() {
  const dots = $('evidenceToggleDots');
  const curves = $('evidenceToggleCurves');
  const lines = $('evidenceToggleDetectedLines');
  const fused = $('layerFusedLanes');
  const conn = $('layerConnectedAccumulated');
  const rep = $('layerRepresentativeLaneLines');
  if (dots && fused) dots.checked = fused.checked === true;
  if (curves && conn) curves.checked = conn.checked === true;
  if (lines && rep) lines.checked = rep.checked === true;
}

function updateUiModeDescription(mode) {
  const el = $('uiModeDescription');
  if (!el) return;
  const text = window.UiModePresets?.MODE_DESCRIPTIONS?.[mode] || '';
  el.textContent = text;
}

function updateMapBackgroundStatus(_code, detail) {
  const el = $('mapBackgroundStatus');
  if (!el) return;
  el.textContent = detail || '—';
}

function updateMapDebugDiagnostics() {
  const el = $('mapDebugDiagnostics');
  if (!el || uiMode !== 'debug') return;
  const d = geographicMap?.getDiagnostics?.() ?? {};
  el.textContent = JSON.stringify(d, null, 2);
}

function syncGeographicMapContext() {
  if (!geographicMap) return;
  const playbackData = getActiveProgressiveDisplayData() || processData;
  const map = renderer?.stationaryLocalMap;
  geographicMap.setGeographicContext({
    processOrigin: playbackData?.origin ?? null,
    mapReferencePose: map?.referencePose ?? null,
    stationaryMap: map,
  });
  geographicMap.resize?.();
  syncGeographicMapScene();
  updateMapDebugDiagnostics();
}

function buildGeographicMapScenePayload() {
  const playbackData = getActiveProgressiveDisplayData() || processData;
  const map = renderer?.stationaryLocalMap;
  const timelineIdx = parseInt($('timeline')?.value ?? '0', 10);
  const layers = getLayers();
  const repPolylines = layers.representativeLaneLines
    ? (renderer?.buildRepresentativePolylinesForGeographic?.(timelineIdx) || [])
    : [];
  return {
    stationaryMap: map,
    playbackData,
    playbackPose: renderer?.playbackPose,
    uiMode,
    layerFlags: {
      representativeLaneLines: layers.representativeLaneLines,
      observationDots: $('evidenceToggleDots')?.checked === true,
      sourceCurves: $('evidenceToggleCurves')?.checked === true,
    },
    representativePolylines: repPolylines,
    perFramePolylines: renderer?._connectedAccumulatedPolylines,
    cacheKey: map?.cacheKey ?? null,
  };
}

function syncGeographicMapScene() {
  if (!geographicMap) return;
  const native = geographicMap.isNativeActive?.() === true;
  renderer?.setMapNativeActive?.(native);
  if (!native) return;
  geographicMap.refreshGeographicMapData?.(buildGeographicMapScenePayload());
  updateRepresentativeLaneLinesDiag();
  updateReviewCompactStatus();
  updateMapDebugDiagnostics();
}

function initMapDebugLayerIsolation() {
  const ids = [
    ['mapDebugLayerTiles', 'baseTiles'],
    ['mapDebugLayerRoute', 'gpsRoute'],
    ['mapDebugLayerVehicle', 'vehicle'],
    ['mapDebugLayerLanes', 'laneLines'],
    ['mapDebugLayerDots', 'observationDots'],
    ['mapDebugLayerCurves', 'sourceCurves'],
  ];
  const readFlags = () => {
    const out = {};
    for (const [elId, key] of ids) {
      const el = $(elId);
      out[key] = el ? el.checked : true;
    }
    return out;
  };
  const apply = () => {
    if (uiMode === 'debug') geographicMap?.setDebugLayerIsolation?.(readFlags());
  };
  for (const [elId] of ids) {
    $(elId)?.addEventListener('change', apply);
  }
  apply();
}

async function initGeographicMap() {
  const container = $('geographicMapContainer');
  const createMap = window.createGeographicMapNative || window.createGeographicMap;
  if (!container || !createMap) return;
  geographicMap = createMap({
    container,
    stage: $('geometryStage'),
    rootStage: $('mapStageRoot') || container?.closest?.('.map-stage'),
    canvas: $('canvas'),
    onRedraw: () => syncGeographicMapScene(),
    onStatus: (code, detail) => {
      updateMapBackgroundStatus(code, detail);
      updateMapDebugDiagnostics();
    },
    onDiagnostics: () => updateMapDebugDiagnostics(),
    getUiMode: () => uiMode,
  });
  renderer?.setGeographicMapController?.(geographicMap);
  window.addEventListener('resize', () => geographicMap?.resize?.());
  let streetAvailable = true;
  try {
    const cfg = await geographicMap.loadConfig();
    streetAvailable = cfg?.street?.available === true;
    refreshMapBackgroundSelectOptions(cfg);
  } catch (_) {
    streetAvailable = false;
  }
  mapBackgroundMode = parseMapBackgroundFromLocation(streetAvailable);
  const sel = $('mapBackgroundMode');
  if (sel) {
    sel.disabled = false;
    sel.removeAttribute('aria-disabled');
    sel.value = mapBackgroundMode;
  }
  await geographicMap.setBackground(mapBackgroundMode);
  syncGeographicMapContext();
}

function refreshMapBackgroundSelectOptions(cfg) {
  const sel = $('mapBackgroundMode');
  if (!sel || !cfg) return;
  const streetOpt = sel.querySelector('option[value="street"]');
  const satOpt = sel.querySelector('option[value="satellite"]');
  if (streetOpt) {
    streetOpt.disabled = !cfg.street?.available;
    streetOpt.textContent = cfg.street?.available ? 'Street' : 'Street — unavailable';
  }
  if (satOpt) {
    satOpt.disabled = !cfg.satellite?.available;
    satOpt.textContent = cfg.satellite?.available ? 'Satellite' : 'Satellite — not configured';
  }
}

function initMapBackgroundControls() {
  const sel = $('mapBackgroundMode');
  if (!sel) return;
  sel.addEventListener('change', async () => {
    const next = sel.value === 'satellite' || sel.value === 'street' ? sel.value : 'grey';
    mapBackgroundMode = next;
    replaceUrlParams({ mapBackground: next });
    await geographicMap?.setBackground?.(next);
    syncGeographicMapContext();
    if (next === 'street' || next === 'satellite') {
      renderer?.fitToLocalView?.();
      syncGeographicMapScene();
    } else {
      renderer?.setMapNativeActive?.(false);
      renderer?.draw?.();
    }
  });
}

function formatPlaybackTimeSeconds() {
  const idx = parseInt($('timeline')?.value ?? '0', 10);
  const t = getPlaybackTimeline()?.[idx];
  if (!t) return null;
  const sec = t.elapsedSec ?? t.elapsedS ?? t.timeSec;
  if (Number.isFinite(sec)) return `${Number(sec).toFixed(1)} s`;
  return null;
}

function segmentLabelFromFile(file) {
  const m = String(file || '').match(/_(\d+)\./);
  return m ? m[1] : (file || '—');
}

function loadedSegmentLabel() {
  const files = lastProcessedSegmentSelection?.length
    ? lastProcessedSegmentSelection
    : getPlaybackSegmentSelection();
  const last = files?.slice(-1)[0];
  return segmentLabelFromFile(last);
}

function selectedSegmentLabel() {
  const sel = selectedSegments();
  const last = sel?.slice(-1)[0];
  return segmentLabelFromFile(last);
}

function selectionMatchesLoadedSegments() {
  const a = [...selectedSegments()].sort().join('|');
  const b = [...(lastProcessedSegmentSelection || [])].sort().join('|');
  return a.length > 0 && a === b;
}

function updatePendingSegmentSelectionStatus() {
  if (!processData) return;
  if (selectionMatchesLoadedSegments()) return;
  const pending = selectedSegmentLabel();
  const loaded = loadedSegmentLabel();
  setStatus(`Seg${pending} selected — click Load segment (currently showing Seg${loaded})`);
}

function updateReviewCompactStatus() {
  if (uiMode !== 'review') return;
  const el = $('toolbarStatus');
  if (!el || primaryActionBusy) return;
  const map = renderer?.stationaryLocalMap;
  if (!map?.valid) {
    el.textContent = 'Process a segment to begin';
    el.dataset.state = 'idle';
    return;
  }
  if (!selectionMatchesLoadedSegments()) {
    updatePendingSegmentSelectionStatus();
  }
  const d = renderer?.getRepresentativeLaneLinesDiagnostics?.();
  const geo = geographicMap?.getDiagnostics?.();
  const repLayerOn = $('layerRepresentativeLaneLines')?.checked === true;
  const lanes = d?.logicalLaneCount ?? d?.laneCount;
  const sections = d?.representativeLineCount ?? d?.lineSectionCount;
  const hasRep = repLayerOn && (d?.candidateActive || (geo?.laneLines > 0));
  const laneText = hasRep && lanes != null ? `${lanes}` : (hasRep && geo?.laneLines > 0 ? `${geo.laneLines}` : null);
  const sectionText = hasRep && sections != null ? `${sections}` : (hasRep && geo?.laneLines > 0 ? `${geo.laneLines}` : null);
  const loadedSeg = loadedSegmentLabel();
  const timeStr = formatPlaybackTimeSeconds();
  const showingPrefix = selectionMatchesLoadedSegments() ? '' : `Currently showing Seg${loadedSeg} · `;
  if (repLayerOn && laneText == null && sectionText == null) {
    el.textContent = `${showingPrefix}Detected lane overlay unavailable · Seg${loadedSeg}${timeStr ? ` · ${timeStr}` : ''}`;
  } else if (laneText == null || sectionText == null) {
    if (geographicMap?.isNativeActive?.() && geo?.gpsRoutePoints >= 2) {
      el.textContent = `${showingPrefix}Route ready · Seg${loadedSeg}${timeStr ? ` · ${timeStr}` : ''}`;
    } else {
      el.textContent = `${showingPrefix}Route loading… · Seg${loadedSeg}${timeStr ? ` · ${timeStr}` : ''}`;
    }
  } else {
    el.textContent = `${showingPrefix}${laneText} lanes · ${sectionText} line sections · Seg${loadedSeg}${timeStr ? ` · ${timeStr}` : ''}`;
  }
  el.dataset.state = 'ready';
}

function applyUiMode(mode, { fromUser = false } = {}) {
  uiMode = mode === 'evidence' || mode === 'debug' ? mode : 'review';
  document.body.classList.remove('ui-mode-review', 'ui-mode-evidence', 'ui-mode-debug');
  document.body.classList.add(`ui-mode-${uiMode}`);
  const sel = $('uiModeSelect');
  if (sel && sel.value !== uiMode) sel.value = uiMode;
  const details = $('advancedSettingsPanel');
  if (details && uiMode === 'debug') details.open = true;
  updateUiModeDescription(uiMode);
  if (uiMode !== 'debug') applyUiLayerPreset(uiMode);
  if (fromUser) replaceUrlParams({ uiMode });
  syncGeographicMapScene();
  updateReviewCompactStatus();
  updateEvidenceCompactCounts();
  updateMapDebugDiagnostics();
}

function initUiModeControls() {
  uiMode = parseUiModeFromLocation();
  document.body.classList.remove('ui-mode-review', 'ui-mode-evidence', 'ui-mode-debug');
  document.body.classList.add(`ui-mode-${uiMode}`);
  const sel = $('uiModeSelect');
  if (sel) sel.value = uiMode;
  updateUiModeDescription(uiMode);
  if (!sel) return;
  sel.addEventListener('change', () => {
    applyUiMode(sel.value, { fromUser: true });
  });
}

function syncProgressiveViewportBodyClass() {
  const on = isProgressiveViewportCandidateEnabled();
  document.body.classList.toggle('progressive-viewport-active', on);
}

function setPrimaryBusy(busy, shortLabel = null) {
  primaryActionBusy = !!busy;
  const ids = ['btnProcess', 'btnReprocess', 'btnProcessAll', 'btnProgressiveAppend', 'btnProgressiveAppendContinue', 'btnProgressiveRemoveLast'];
  for (const id of ids) {
    const el = $(id);
    if (el) el.disabled = primaryActionBusy;
  }
  if (shortLabel) setToolbarStatus(shortLabel, busy ? 'processing' : 'ready');
}

function setToolbarStatus(msg, state = 'ready') {
  const el = $('toolbarStatus');
  if (!el) return;
  el.textContent = msg;
  el.dataset.state = state;
}

function updateEvidenceCompactCounts() {
  const el = $('evidenceCompactCounts');
  if (!el) return;
  const map = renderer?.stationaryLocalMap;
  const playbackData = getActiveProgressiveDisplayData() || processData;
  const frames = playbackData?.timeline?.length ?? 0;
  const pts = map?.pointAccumulated?.points?.length ?? 0;
  const d = renderer?.getRepresentativeLaneLinesDiagnostics?.();
  const lanes = d?.laneCount ?? d?.representativeLaneCount ?? 0;
  const sections = d?.representativeLineCount ?? d?.lineSectionCount ?? 0;
  const rejected = d?.rejectedCurveCount ?? d?.rejectedCurves ?? 0;
  el.textContent = `frames ${frames} · observations ${pts} · detected lanes ${lanes} · line sections ${sections} · rejected curves ${rejected}`;
}

function localGeometryUI() {
  return window.LocalGeometryUI || {
    LOCAL_GEOMETRY_DEFAULT_MODE: 'pointAccumulated',
    LOCAL_GEOMETRY_STORAGE_KEY: 'qlogLocalGeometryMode',
    LOCAL_GEOMETRY_SESSION_KEY: 'qlogLocalGeometryModeSession',
    VIZ_MODE_DEFAULT: 'local',
    VIZ_MODE_SESSION_KEY: 'qlogVizModeSession',
    normalizeLocalGeometrySelection: (v) => (v === 'observations' || v === 'fused' || v === 'pointAccumulated' ? v : 'pointAccumulated'),
    normalizeVizModeSelection: (v) => (v === 'global' || v === 'vehicle' || v === 'local' ? v : 'local'),
    resolveInitialLocalGeometryMode: (search, sessionValue, htmlValue) => {
      const params = typeof search === 'string' ? new URLSearchParams(search) : search;
      const fromUrl = params?.get?.('geometry') || params?.get?.('localGeometry') || null;
      if (fromUrl === 'observations' || fromUrl === 'fused' || fromUrl === 'pointAccumulated') return fromUrl;
      if (sessionValue === 'observations' || sessionValue === 'fused' || sessionValue === 'pointAccumulated') return sessionValue;
      return (htmlValue === 'observations' || htmlValue === 'fused' || htmlValue === 'pointAccumulated')
        ? htmlValue
        : 'pointAccumulated';
    },
    resolveInitialVizMode: (search, sessionValue, htmlValue) => {
      const params = typeof search === 'string' ? new URLSearchParams(search) : search;
      const viz = params?.get?.('viz') || params?.get?.('vizMode') || null;
      if (viz === 'global' || viz === 'vehicle' || viz === 'local') return viz;
      if (params?.get?.('local') === '1') return 'local';
      if (sessionValue === 'global' || sessionValue === 'vehicle' || sessionValue === 'local') return sessionValue;
      return (htmlValue === 'global' || htmlValue === 'vehicle' || htmlValue === 'local') ? htmlValue : 'local';
    },
  };
}

function normalizeLocalGeometrySelection(value) {
  return localGeometryUI().normalizeLocalGeometrySelection(value);
}

function persistLocalGeometryMode(mode) {
  try {
    sessionStorage.setItem(localGeometryUI().LOCAL_GEOMETRY_SESSION_KEY, mode);
  } catch (_) { /* ignore */ }
  try {
    localStorage.setItem(localGeometryUI().LOCAL_GEOMETRY_STORAGE_KEY, mode);
  } catch (_) { /* ignore quota / private mode */ }
}

function persistVizMode(mode) {
  try {
    sessionStorage.setItem(localGeometryUI().VIZ_MODE_SESSION_KEY, mode);
  } catch (_) { /* ignore */ }
}

function readSessionGeometryMode() {
  try {
    return sessionStorage.getItem(localGeometryUI().LOCAL_GEOMETRY_SESSION_KEY);
  } catch (_) {
    return null;
  }
}

function readSessionVizMode() {
  try {
    return sessionStorage.getItem(localGeometryUI().VIZ_MODE_SESSION_KEY);
  } catch (_) {
    return null;
  }
}

function initLocalGeometryModeSelect() {
  const sel = $('localGeometryMode');
  const ui = localGeometryUI();
  if (!sel) return ui.LOCAL_GEOMETRY_DEFAULT_MODE;
  const mode = (ui.resolveInitialLocalGeometryMode || normalizeLocalGeometrySelection)(
    typeof window !== 'undefined' ? window.location.search : '',
    readSessionGeometryMode(),
    sel.value,
  );
  sel.value = normalizeLocalGeometrySelection(mode);
  persistLocalGeometryMode(sel.value);
  return sel.value;
}

function initVizModeSelect() {
  const sel = $('vizMode');
  const ui = localGeometryUI();
  if (!sel) return ui.VIZ_MODE_DEFAULT || 'local';
  const mode = (ui.resolveInitialVizMode || ((s, sess, html) => html || 'local'))(
    typeof window !== 'undefined' ? window.location.search : '',
    readSessionVizMode(),
    sel.value,
  );
  const normalized = ui.normalizeVizModeSelection
    ? ui.normalizeVizModeSelection(mode)
    : (mode === 'global' || mode === 'vehicle' || mode === 'local' ? mode : 'local');
  sel.value = normalized;
  persistVizMode(sel.value);
  return sel.value;
}

function saveLocalPlaybackViewState() {
  if (!renderer || !processData) return;
  lastLocalPlaybackState = {
    timelineIndex: parseInt($('timeline')?.value ?? '0', 10),
    geometryMode: normalizeLocalGeometrySelection($('localGeometryMode')?.value),
    scale: renderer.scale,
    offsetX: renderer.offsetX,
    offsetY: renderer.offsetY,
    localViewportBounds: renderer.getLocalViewportBounds?.() ?? null,
  };
}

function restoreLocalPlaybackViewState() {
  if (!renderer || !lastLocalPlaybackState) return false;
  renderer.scale = lastLocalPlaybackState.scale ?? renderer.scale;
  renderer.offsetX = lastLocalPlaybackState.offsetX ?? renderer.offsetX;
  renderer.offsetY = lastLocalPlaybackState.offsetY ?? renderer.offsetY;
  if (lastLocalPlaybackState.localViewportBounds) {
    renderer._localViewportBounds = lastLocalPlaybackState.localViewportBounds;
  }
  return true;
}

function getLayers() {
  return {
    gps: $('layerGps').checked,
    vehicle: $('layerVehicle').checked,
    raw: $('layerRawLanes').checked,
    rawFrame: $('layerRawFrame').checked,
    fused: $('layerFusedLanes').checked,
    fusedTracks: $('layerFusedTracks').checked,
    trackConnections: $('layerTrackConnections').checked,
    colorByTrack: $('layerColorByTrack').checked,
    trackIds: $('layerTrackIds').checked,
    laneOnly: $('layerLaneOnly').checked,
    centre: $('layerCentre').checked,
    roadSurface: $('layerRoadSurface').checked,
    markers: $('layerMarkers').checked,
    colorByChunk: $('layerColorByChunk').checked,
    colorByPass: $('layerColorByPass').checked,
    passBoundaries: $('layerPassBoundaries').checked,
    suspiciousGps: $('layerSuspiciousGps').checked,
    rejectedObs: $('layerRejectedObs').checked,
    constructedFragments: $('layerConstructedFragments')?.checked === true,
    joinedPolylines: $('layerJoinedPolylines')?.checked === true,
    joinCandidates: $('layerJoinCandidates')?.checked === true,
    fittedPolylines: $('layerFittedPolylines')?.checked === true,
    fittedEndpoints: $('layerFittedEndpoints')?.checked === true,
    fittedOutliers: $('layerFittedOutliers')?.checked === true,
    fittedUnverified: $('layerFittedUnverified')?.checked === true,
    fittedGaps: $('layerFittedGaps')?.checked === true,
    unconfirmedCandidates: $('layerUnconfirmedCandidates')?.checked === true,
    connectedAccumulated: $('layerConnectedAccumulated')?.checked === true,
    representativeLaneLines: $('layerRepresentativeLaneLines')?.checked === true,
    diagPhysicalBoundary: $('layerDiagPhysicalBoundary')?.checked,
    diagTrackIds: $('layerDiagTrackIds')?.checked,
    diagFragmentIds: $('layerDiagFragmentIds')?.checked,
    diagDisconnections: $('layerDiagDisconnections')?.checked,
    diagRepairedGaps: $('layerDiagRepairedGaps')?.checked,
    diagStructuralBridges: $('layerDiagStructuralBridges')?.checked,
    diagInterpolatedBridges: $('layerDiagInterpolatedBridges')?.checked,
  };
}

function getEffectiveLayers(displayMode) {
  const layers = getLayers();
  if (displayMode !== 'local') return layers;
  return {
    ...layers,
    gps: false,
    raw: false,
    fusedTracks: false,
    trackConnections: false,
    laneOnly: false,
    centre: false,
    markers: false,
    colorByChunk: false,
    passBoundaries: false,
    suspiciousGps: false,
    rejectedObs: false,
    // Stationary local playback layer mapping (checkbox labels unchanged):
    // Model vehicle path → stationary trajectory
    // Fused lane lines → stationary mapped lane observations
    // Road edges → stationary road edges
    // Road surface → stationary road-surface polygons
    // Raw frame detections → current-observation diagnostic only
    vehicle: layers.vehicle,
    fused: layers.fused,
    edges: layers.edges,
    roadSurface: layers.roadSurface,
    rawFrame: layers.rawFrame,
    colorByPass: layers.colorByPass,
  };
}

function localPlaybackOptions() {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  return {
    minHeadingSpeedMps: parseFloat($('minBearingSpeed')?.value ?? 2),
    // Experimental Path-1 graph fitting; disabled unless ?fit=1 is set.
    fitEnabled: params?.get('fit') === '1',
    // Section 13 unconfirmed candidate layer; disabled unless ?candidates=1 is set.
    candidatesEnabled: params?.get('candidates') === '1',
  };
}

function localPlaybackUrlFlags() {
  if (typeof window === 'undefined') return { laneRelativeArrow: false, laneTransformDebug: false };
  const params = new URLSearchParams(window.location.search);
  return {
    laneRelativeArrow: params.get('laneRelativeArrow') === '1',
    laneTransformDebug: params.get('laneTransformDebug') === '1',
  };
}

function getLocalGeometryMode() {
  const sel = $('localGeometryMode');
  const v = normalizeLocalGeometrySelection(sel?.value);
  if (sel && sel.value !== v) sel.value = v;
  const SLM = window.SegmentLocalMap;
  if (SLM?.normalizeGeometrySource) return SLM.normalizeGeometrySource(v);
  return v;
}

function stationaryMapCacheKey(chunkId, passId, geometrySource) {
  const fit = localPlaybackOptions().fitEnabled ? ':fit1' : ':fit0';
  const CBAO = window.CombinedBoundaryAnchoredOrientation;
  const candidate = CBAO?.parseCombinedOrientationCandidate?.(window.location.search) ?? null;
  const cand = candidate ? `:cand:${candidate}` : '';
  return `${chunkId}:${passId}:${geometrySource}${fit}${cand}`;
}

function applyOrientationCandidateIfNeeded(map, processPayload, { cacheSource = null } = {}) {
  if (!map || !processPayload) return map;
  const CBAO = window.CombinedBoundaryAnchoredOrientation;
  const candidate = CBAO?.parseCombinedOrientationCandidate?.(window.location.search) ?? null;
  if (candidate !== 'boundaryAnchored' || !CBAO?.applyBoundaryAnchoredOrientation) {
    return map;
  }
  if (map.boundaryAnchoredOrientationActive && map.combinedCoordinateFrame === 'combinedPlaced') {
    return map;
  }
  const oriented = CBAO.applyBoundaryAnchoredOrientation(map, processPayload, {
    mirrorChecked: renderer?.getMirrorRoadLateralDisplay?.() ?? true,
  });
  oriented._orientationAppliedOnCacheHit = true;
  oriented._orientationCacheSource = cacheSource;
  return oriented;
}

function clearStationaryMapCache() {
  stationaryMapCache.clear();
  stationaryMapBuildCount = 0;
  lastMapIdentityKey = null;
  inFlightMapBuilds.clear();
}

function isCausalPointPlayback() {
  return renderer?.getPointCausalPlayback?.() === true;
}

function shouldUseGraphFitPersist(mode, fitOpts) {
  return !!fitOpts?.fitEnabled
    && mode === 'pointAccumulated'
    && !isCausalPointPlayback()
    && window.GraphFitPersistCache?.isSupported?.();
}

function isMapAcquisitionDiagEnabled() {
  return !!(window.__graphFitPersistTrace || new URLSearchParams(window.location.search).get('persistDiag') === '1');
}

function traceMapAcquisition(event, detail = {}) {
  if (!isMapAcquisitionDiagEnabled()) return;
  const row = {
    ts: Date.now(),
    event,
    origin: window.location?.origin ?? null,
    url: window.location?.href ?? null,
    generation: mapAcquisitionGeneration,
    ...detail,
  };
  if (!window.__mapAcquisitionTraceLog) window.__mapAcquisitionTraceLog = [];
  window.__mapAcquisitionTraceLog.push(row);
}

let mapAcquisitionGeneration = 0;
let lastMapIdentityKey = null;
const inFlightMapBuilds = new Map();

function mapIdentityContext(timelineIndex) {
  const SLM = window.SegmentLocalMap;
  const playbackData = getPlaybackProcessData();
  const mode = getLocalGeometryMode();
  const fitOpts = localPlaybackOptions();
  const active = SLM && playbackData
    ? SLM.resolveActiveChunkPass(playbackData, timelineIndex)
    : { chunkId: null, passId: null };
  const selection = getPlaybackSegmentSelection();
  const segmentFiles = (selection.length
    ? selection
    : (playbackData?.fileAudits || []).map((a) => a.filename || a.fileName)).sort().join('|');
  return {
    timelineIndex,
    chunkId: active.chunkId,
    passId: active.passId,
    geometrySource: mode,
    fitEnabled: !!fitOpts.fitEnabled,
    vizMode: getDisplayMode(),
    causal: isCausalPointPlayback(),
    segmentFiles,
  };
}

function mapIdentityKey(ctx) {
  return `${ctx.segmentFiles}|${ctx.chunkId}|${ctx.passId}|${ctx.geometrySource}|${ctx.fitEnabled ? 1 : 0}|${ctx.vizMode}|${ctx.causal ? 1 : 0}`;
}

function bumpMapAcquisitionIfNeeded(timelineIndex) {
  const ctx = mapIdentityContext(timelineIndex);
  const key = mapIdentityKey(ctx);
  if (key !== lastMapIdentityKey) {
    mapAcquisitionGeneration += 1;
    lastMapIdentityKey = key;
  }
  return { generation: mapAcquisitionGeneration, ...ctx };
}

function readMapAcquisitionContext(timelineIndex) {
  const ctx = mapIdentityContext(timelineIndex);
  return { generation: mapAcquisitionGeneration, ...ctx };
}

function captureMapAcquisitionContext(timelineIndex) {
  return bumpMapAcquisitionIfNeeded(timelineIndex);
}

function mapContextsCompatible(expected, actual) {
  if (!expected || !actual) return false;
  return expected.generation === actual.generation
    && expected.chunkId === actual.chunkId
    && expected.passId === actual.passId
    && expected.geometrySource === actual.geometrySource
    && expected.fitEnabled === actual.fitEnabled
    && expected.vizMode === actual.vizMode
    && expected.causal === actual.causal
    && expected.segmentFiles === actual.segmentFiles;
}

function inflightMapKey(ctx) {
  const fit = ctx.fitEnabled ? ':fit1' : ':fit0';
  return `${ctx.segmentFiles}::${ctx.chunkId}:${ctx.passId}:${ctx.geometrySource}${fit}`;
}

async function getOrBuildStationaryMapAsync(timelineIndex, { forceRebuild = false, preferFullMap = false } = {}) {
  if (!preferFullMap && hasActiveProgressiveDisplaySnapshot()) {
    return progressiveCombinedState.displayMap;
  }
  const mapBuildData = preferFullMap
    ? getProgressiveHiddenProcessData()
    : getActiveProgressiveDisplayData();
  const ctx = readMapAcquisitionContext(timelineIndex);
  const inflightKey = inflightMapKey(ctx);

  if (!forceRebuild && inFlightMapBuilds.has(inflightKey)) {
    return inFlightMapBuilds.get(inflightKey);
  }

  const buildPromise = (async () => {
    const SLM = window.SegmentLocalMap;
    if (!SLM || !mapBuildData) return null;
    const mode = getLocalGeometryMode();
    if (mode === 'diagnostic') return null;

    const { chunkId, passId } = SLM.resolveActiveChunkPass(mapBuildData, timelineIndex);
    const key = stationaryMapCacheKey(chunkId, passId, mode);
    traceMapAcquisition('acquisition-start', {
      timelineIndex,
      chunkId,
      passId,
      geometrySource: mode,
      fitState: localPlaybackOptions()?.fitEnabled ? 'fit1' : 'fit0',
      processingVersion: mapBuildData.processingVersion ?? null,
      graphFitImplVersion: window.GraphFit?.GRAPH_FIT_CACHE_IMPL_VERSION ?? null,
    });
    if (!forceRebuild && stationaryMapCache.has(key)) {
      let cached = stationaryMapCache.get(key);
      cached = applyOrientationCandidateIfNeeded(cached, mapBuildData, { cacheSource: 'memory' });
      cached.cacheState = cached._orientationAppliedOnCacheHit
        ? 'memory-hit-orientation-applied'
        : 'memory-hit';
      traceMapAcquisition('renderer-apply', { cacheState: cached.cacheState, chunkId, passId });
      return cached;
    }

    const fitOpts = localPlaybackOptions();
    const buildOptions = {
      geometrySource: mode,
      chunkId,
      passId,
      timelineIndex,
      ...fitOpts,
    };

    if (!forceRebuild && shouldUseGraphFitPersist(mode, fitOpts)) {
      try {
        const idBundle = await window.GraphFitPersistCache.computeIdentity(mapBuildData, buildOptions);
        if (idBundle?.cacheKey) {
          traceMapAcquisition('identity-complete', {
            cacheKey: idBundle.cacheKey,
            cacheKeyLength: idBundle.cacheKey.length,
            chunkId,
            passId,
          });
          const stored = await window.GraphFitPersistCache.get(idBundle);
          const lookup = window.GraphFitPersistCache.getLastLookupResult?.();
          traceMapAcquisition('idb-read-complete', {
            lookupResult: lookup?.result ?? stored?.lookupResult ?? 'unknown',
            cacheKey: idBundle.cacheKey,
          });
          if (stored?.map) {
            let frozenMap = SLM.freezeStationaryMapGeometry(stored.map);
            frozenMap = applyOrientationCandidateIfNeeded(frozenMap, mapBuildData, { cacheSource: 'persistent' });
            frozenMap.cacheKey = key;
            frozenMap.cacheState = frozenMap._orientationAppliedOnCacheHit
              ? 'persistent-hit-orientation-applied'
              : 'persistent-hit';
            frozenMap.persistCacheKey = idBundle.cacheKey;
            stationaryMapCache.set(key, frozenMap);
            traceMapAcquisition('renderer-apply', { cacheState: frozenMap.cacheState, chunkId, passId });
            return frozenMap;
          }
        }
      } catch (err) {
        console.warn('[graph-fit-persist] read failed; falling back to build', err);
      }
    }

    traceMapAcquisition('build-start', { chunkId, passId, geometrySource: mode });
    const map = SLM.buildSegmentLocalMap(mapBuildData, buildOptions);
    const CBAO = window.CombinedBoundaryAnchoredOrientation;
    const orientationCandidate = CBAO?.parseCombinedOrientationCandidate?.(window.location.search) ?? null;
    let workingMap = map;
    if (orientationCandidate === 'boundaryAnchored' && CBAO?.applyBoundaryAnchoredOrientation) {
      workingMap = CBAO.applyBoundaryAnchoredOrientation(map, mapBuildData, {
        mirrorChecked: renderer?.getMirrorRoadLateralDisplay?.() ?? true,
      });
    }
    traceMapAcquisition('build-complete', { chunkId, passId, orientationCandidate });
    const frozenMap = SLM.freezeStationaryMapGeometry(workingMap);
    stationaryMapBuildCount += 1;
    frozenMap.cacheKey = key;
    frozenMap.cacheState = window.GraphFitPersistCache?.isSupported?.() ? 'miss-build' : 'built';
    frozenMap.buildCount = stationaryMapBuildCount;
    stationaryMapCache.set(key, frozenMap);

    if (shouldUseGraphFitPersist(mode, fitOpts)) {
      try {
        const persistKey = await window.GraphFitPersistCache.put(mapBuildData, buildOptions, frozenMap);
        frozenMap.persistCacheKey = persistKey;
      } catch (err) {
        console.warn('[graph-fit-persist] write failed; viewer remains usable', err);
      }
    }
    traceMapAcquisition('renderer-apply', { cacheState: frozenMap.cacheState, chunkId, passId });
    return frozenMap;
  })();

  inFlightMapBuilds.set(inflightKey, buildPromise);
  try {
    return await buildPromise;
  } finally {
    if (inFlightMapBuilds.get(inflightKey) === buildPromise) {
      inFlightMapBuilds.delete(inflightKey);
    }
  }
}

function getOrBuildStationaryMap(timelineIndex, options = {}) {
  return getOrBuildStationaryMapAsync(timelineIndex, options);
}

function getOptions() {
  return {
    minLaneProb: parseFloat($('minLaneProb').value),
    maxAccuracyM: parseFloat($('maxGpsAcc').value),
    maxModelGpsDeltaNs: parseFloat($('maxModelGps').value) * 1e9,
    maxForwardM: parseFloat($('maxForward').value),
    fusionIntervalM: parseFloat($('fusionInterval').value),
    minSpeedForGpsBearing: parseFloat($('minBearingSpeed').value),
    maxTimeGapSec: parseFloat($('maxTimeGap').value),
    maxGpsGapM: parseFloat($('maxGpsGap').value),
    maxImpliedSpeedMps: parseFloat($('maxImpliedSpeed').value),
    maxLaneFragmentGapM: parseFloat($('maxLaneGap').value),
    maxRoadEdgeGapM: parseFloat($('maxEdgeGap').value),
    pipelineMode: 'C',
    laneTrackingEnabled: $('laneTrackingEnabled').checked,
    localSupportFilter: $('localSupportFilter').checked,
  };
}

function setStatus(msg, state = null) {
  const statusEl = $('status');
  if (statusEl) statusEl.textContent = msg;
  const inferred = state
    || (/\b(error|failed)\b/i.test(msg) ? 'error'
      : /\b(processing|loading|adding)\b/i.test(msg) ? 'processing'
      : /\bplaying\b/i.test(msg) ? 'playing'
      : /\bpaused\b/i.test(msg) ? 'paused'
      : 'ready');
  const short = msg.length > 72 ? `${msg.slice(0, 69)}…` : msg;
  setToolbarStatus(short, inferred);
}

function updateGeometryDiagnosticsPanel() {
  const GD = window.GeometryDiagnostics;
  const map = renderer?.stationaryLocalMap;
  const playbackData = getActiveProgressiveDisplayData();
  const diag = GD?.buildLaneDiagnostics
    ? GD.buildLaneDiagnostics(playbackData, map, { geometrySource: getLocalGeometryMode() })
    : null;
  const progressiveDiag = getProgressiveDisplayDiagnostics();
  if (renderer && diag) renderer.setGeometryDiagnostics(diag);

  const set = (id, val) => {
    const el = $(id);
    if (el) el.textContent = val ?? '—';
  };
  if (!processData) {
    ['diagLaneChecksum', 'diagApiLaneChecksum', 'diagProcessingVersion', 'diagGeometrySource',
      'diagFusedFragments', 'diagCleanedRuns', 'diagDisconnections', 'diagPbGaps',
      'diagStage7Flag', 'diagStage8Flag', 'diagCoordinateChecksum', 'diagInterpolatedCount',
      'diagAcceptedRepairs', 'diagContinuityVerdict', 'diagSurfaceChecksum',
      'diagMapCache', 'diagApiCacheHit'].forEach((id) => set(id, '—'));
    if ($('diagRepairTable')) $('diagRepairTable').innerHTML = '';
    return;
  }

  set('diagLaneChecksum', diag?.laneChecksum);
  set('diagApiLaneChecksum', processData.laneDiagnostics?.laneChecksum ?? '—');
  set('diagProcessingVersion', processData.processingVersion);
  set('diagGeometrySource', diag?.geometrySource ?? getLocalGeometryMode());
  set('diagFusedFragments', diag?.fusedFragmentCount ?? processData.laneDiagnostics?.fusedFragmentCount);
  set('diagCleanedRuns', diag?.cleanedRunCount);
  set('diagDisconnections', diag?.stableDisconnectionCount);
  const pb = diag?.pbGapCounts ?? processData.laneDiagnostics?.pbGapCounts;
  set('diagPbGaps', pb ? `${pb.PB0} / ${pb.PB1} / ${pb.PB2}` : '—');
  set('diagStage7Flag', diag?.stage7RepairFlag ? 'enabled (fusion-v12+)' : 'off / pre-Stage-7');
  set('diagStage8Flag', diag?.stage8ReconstructionFlag ? 'enabled (explicit flag)' : 'off (default)');
  set('diagCoordinateChecksum', diag?.coordinateChecksum ?? processData.laneDiagnostics?.coordinateChecksum ?? '—');
  set('diagInterpolatedCount', diag?.interpolatedPointCount ?? processData.laneDiagnostics?.interpolatedPointCount ?? '—');
  set('diagAcceptedRepairs', (diag?.acceptedRepairedGapIds || []).join(', ') || 'none');
  const verdictLabels = {
    A_structural_only: 'A — structural only (metadata merge, visual gap may remain)',
    B_rendered_continuity: 'B — rendered continuity (line segment spans gap)',
    mixed: 'Mixed — some structural-only, some rendered',
    none_repaired: 'none repaired',
  };
  set('diagContinuityVerdict', verdictLabels[diag?.continuityVerdict] ?? diag?.continuityVerdict);
  set('diagSurfaceChecksum', diag?.roadSurfaceChecksum);
  set('diagMapCache', map ? `${map.cacheState ?? '—'} (${map.cacheKey ?? '—'})` : 'no map');
  set('diagApiCacheHit', String(processData.cacheHit ?? '—'));
  set('diagProgressiveSnapshot', progressiveDiag.snapshotType);
  set('diagProgressiveVisible', progressiveDiag.visibleSources.join(', ') || '—');
  set('diagProgressiveHidden', progressiveDiag.hiddenPreparedSource ?? '—');
  set('diagProgressiveFrame', progressiveDiag.activeFrame
    ? `${progressiveDiag.activeFrame.sourceFile ?? '—'} / ${progressiveDiag.activeFrame.frameId ?? '—'} / ${progressiveDiag.activeFrame.logMonoTime ?? '—'}`
    : '—');

  const table = $('diagRepairTable');
  if (table && diag?.repairAnalysis?.length) {
    const rows = diag.repairAnalysis.map((r) => {
      const jump = r.coordinateJump?.jumpM?.toFixed(2) ?? '—';
      const rendered = r.coordinateJump?.renderedContinuity ? 'yes' : 'no';
      return `<tr><td>${r.id}</td><td>${r.physicallyOpen ? 'open' : 'closed'}</td><td>${r.verdict}</td><td>${jump} m</td><td>${rendered}</td></tr>`;
    }).join('');
    table.innerHTML = `<table><thead><tr><th>Gap</th><th>Physical</th><th>Verdict</th><th>Jump</th><th>Rendered</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
}

function clearProcessState() {
  processData = null;
  if (typeof window !== 'undefined') window.processData = null;
  resetProgressiveCombinedState();
  lastLocalPlaybackState = null;
  connectedAccumulatedCache = null;
  roadGuidedStaticCache = null;
  roadGuidedRankedCache = null;
  roadGuidedSequenceCache = null;
  clearStationaryMapCache();
  stopPlayback();
  $('timeline').disabled = true;
  $('timeline').value = 0;
  $('passTable').innerHTML = '';
  $('chunkTable').innerHTML = '';
  $('infoPanel').innerHTML = '';
  $('timelineInfo').innerHTML = '';
  $('hoverInfo').textContent = '—';
  $('procVersion').textContent = '—';
  $('procTime').textContent = '—';
  if (renderer) renderer.setData(null, getLayers(), 'global');
  localPlaybackVideo?.unload();
  updateGeometryDiagnosticsPanel();
}

function logGeometryDebug(data, label) {
  const g = data.geometryDebug;
  if (!g) {
    console.warn('[geometry]', label, 'no geometryDebug in response');
    return;
  }
  console.group(`[geometry] ${label}`);
  console.log('processingVersion:', data.processingVersion);
  console.log('processedAt:', data.processedAt);
  console.log('fromCache:', data.fromCache);
  console.log('passCount:', g.passCount, 'polygonCount:', g.polygonCount);
  console.log('passIds:', g.passIds);
  console.log('polygons:', g.polygons);
  console.log('splitEvents:', g.splitEvents);
  console.log('passCoverage:', g.passCoverage);
  console.log('routeChunks polygons per chunk:', (data.routeChunks || []).map((c) => ({
    chunkId: c.chunkId,
    passCount: c.passCoverage?.length ?? 0,
    polygonCount: c.roadSurfacePolygons?.length ?? 0,
    passIds: (c.passCoverage || []).map((p) => p.passId),
    polygons: (c.roadSurfacePolygons || []).map((p) => ({
      passId: p.passId,
      points: p.ring?.length ?? 0,
      fragmentIndex: p.fragmentIndex,
    })),
  })));
  console.groupEnd();
}

async function loadSegments() {
  const res = await fetch(`/api/segments?_=${Date.now()}`, { cache: 'no-store' });
  const data = await res.json();
  const sel = $('segmentSelect');
  sel.innerHTML = '';
  for (const s of data.segments) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  }
  progressiveCombinedState.availableSegments = Array.isArray(data.segments) ? [...data.segments] : [];
  $('procVersion').textContent = data.processingVersion || '—';
  updateInfoPanel({
    qlogFiles: data.segments.length,
    modelEvents: data.modelEventCount,
    gpsEvents: data.gpsEventCount,
  });
  initProgressiveCombinedPlaybackUI();
}

function selectedSegments() {
  return Array.from($('segmentSelect').selectedOptions).map((o) => o.value);
}

function hasActiveProgressiveDisplaySnapshot() {
  return isProgressiveCombinedCandidateEnabled()
    && progressiveCombinedState.displayProcessData != null
    && progressiveCombinedState.displayMap != null;
}

function getActiveProgressiveDisplayData() {
  if (hasActiveProgressiveDisplaySnapshot()) {
    return progressiveCombinedState.displayProcessData;
  }
  return processData;
}

function getActiveProgressiveDisplayMap() {
  if (hasActiveProgressiveDisplaySnapshot()) {
    return progressiveCombinedState.displayMap;
  }
  return renderer?.stationaryLocalMap ?? null;
}

function getProgressiveHiddenProcessData() {
  if (isProgressiveCombinedCandidateEnabled() && progressiveCombinedState.fullProcessData) {
    return progressiveCombinedState.fullProcessData;
  }
  return processData;
}

function getProgressiveDisplayDiagnostics(timelineIndex = null) {
  const idx = timelineIndex != null
    ? timelineIndex
    : parseInt($('timeline')?.value ?? '0', 10);
  const entry = getActiveProgressiveDisplayData()?.timeline?.[idx] ?? null;
  return {
    snapshotActive: hasActiveProgressiveDisplaySnapshot(),
    snapshotType: hasActiveProgressiveDisplaySnapshot()
      ? 'progressiveVisibleFrozen'
      : (processData ? 'ordinaryProcessData' : 'none'),
    visibleSources: hasActiveProgressiveDisplaySnapshot()
      ? [...progressiveCombinedState.visiblePrefix]
      : getPlaybackSegmentSelection(),
    hiddenPreparedSource: progressiveCombinedState.hiddenLookahead ?? null,
    activeFrame: entry ? {
      sourceFile: entry.sourceFile ?? null,
      frameId: entry.frameId ?? null,
      logMonoTime: entry.logMonoTime ?? null,
      timelineIndex: idx,
    } : null,
  };
}

function getPlaybackProcessData() {
  return getActiveProgressiveDisplayData();
}

function applyRendererPlaybackData() {
  if (!renderer) return;
  const playbackData = getActiveProgressiveDisplayData();
  if (!playbackData) return;
  const displayMode = getDisplayMode();
  renderer.setData(playbackData, getEffectiveLayers(displayMode), displayMode);
}

function applyActiveProgressiveDisplaySnapshot() {
  if (!renderer || !hasActiveProgressiveDisplaySnapshot()) return;
  const map = progressiveCombinedState.displayMap;
  renderer.setStationaryLocalMap(map, {
    buildCount: stationaryMapBuildCount,
    cacheState: map?.cacheState ?? 'progressive',
  });
  applyRendererPlaybackData();
  syncGeographicMapContext();
}

function getPlaybackTimeline() {
  return getPlaybackProcessData()?.timeline ?? null;
}

function getPlaybackFrames() {
  return getPlaybackProcessData()?.frames ?? null;
}

function getPlaybackSegmentSelection() {
  if (isProgressiveCombinedCandidateEnabled() && progressiveCombinedState.visiblePrefix?.length) {
    return progressiveCombinedState.visiblePrefix;
  }
  return lastProcessedSegmentSelection;
}

function resetProgressiveCombinedState() {
  progressiveCombinedState.prefix = [];
  progressiveCombinedState.visiblePrefix = [];
  progressiveCombinedState.processPrefix = [];
  progressiveCombinedState.hiddenLookahead = null;
  progressiveCombinedState.fullMap = null;
  progressiveCombinedState.displayMap = null;
  progressiveCombinedState.fullProcessData = null;
  progressiveCombinedState.displayProcessData = null;
  progressiveCombinedState.stateSnapshots = new Map();
}

async function process(segments, { bustCache = false, label = 'process', progressivePlayback = null } = {}) {
  clearProcessState();
  setPrimaryBusy(true, 'Processing');
  setStatus('Loading segment…');
  try {
  const PCP = window.ProgressiveCombinedPlayback;
  const progressiveActive = isProgressiveCombinedCandidateEnabled()
    && !progressivePlayback?.skipLookahead
    && segments?.length;
  let visiblePrefix = null;
  let requestSegments = segments;
  if (progressiveActive) {
    visiblePrefix = PCP.orderPrefixFiles(segments, progressiveCombinedState.availableSegments);
    requestSegments = PCP.buildLookaheadProcessList(visiblePrefix, progressiveCombinedState.availableSegments);
    progressiveCombinedState.visiblePrefix = visiblePrefix;
    progressiveCombinedState.hiddenLookahead = PCP.resolveNextAvailableSegment(
      progressiveCombinedState.availableSegments,
      visiblePrefix,
    );
    progressiveCombinedState.processPrefix = requestSegments;
  }
  const body = {
    segments: requestSegments,
    options: getOptions(),
    bustCache,
  };
  const res = await fetch('/api/process', {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Process failed');

  processData = data;
  if (typeof window !== 'undefined') window.processData = data;
  lastProcessedSegmentSelection = segments?.length
    ? [...segments]
    : (data.fileAudits || []).map((f) => f.filename || f.fileName).filter(Boolean);
  $('procVersion').textContent = data.processingVersion || '—';
  $('procTime').textContent = data.processedAt || '—';

  if (progressivePlayback && PCP) {
    const timelineIndex = PCP.resolveProgressiveTimelineIndex(data.timeline, progressivePlayback);
    lastLocalPlaybackState = {
      timelineIndex,
      geometryMode: progressivePlayback.geometryMode,
      scale: progressivePlayback.viewCapture?.scale,
      offsetX: progressivePlayback.viewCapture?.offsetX,
      offsetY: progressivePlayback.viewCapture?.offsetY,
      localViewportBounds: progressivePlayback.viewCapture?.localViewportBounds,
    };
  } else if (progressiveActive && PCP) {
    progressiveCombinedState.fullProcessData = data;
    progressiveCombinedState.prefix = visiblePrefix;
    lastProcessedSegmentSelection = [...visiblePrefix];
  }

  logGeometryDebug(data, label);
  if (progressiveActive && !progressivePlayback) {
    await bootstrapProgressiveDisplay(visiblePrefix);
    updateGeometryDiagnosticsPanel();
  } else {
    applyVisualization();
    updateGeometryDiagnosticsPanel();
  }
  const fc = data.stats?.frameCounts;
  const frameLabel = fc
    ? `${fc.rawModelV2Messages} raw modelV2 → ${fc.gpsAlignedFrames} GPS-aligned`
    : `${data.stats.validModelFrames} frames`;
  setStatus(`Done — ${data.stats.routeChunkCount} chunks, ${frameLabel}, cacheHit=${data.cacheHit}, ${data.geometryDebug?.polygonCount ?? 0} polygons`);
  await refreshLocalPlaybackVideo({ resetTimeline: !progressivePlayback });
  if (progressivePlayback?.continuePlayback) {
    schedulePlaybackStep();
  }
  return data;
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    throw err;
  } finally {
    setPrimaryBusy(false);
  }
}

async function reprocessSelected() {
  const segs = selectedSegments();
  if (!segs.length) {
    setStatus('Select at least one segment to reprocess');
    return;
  }
  await process(segs, { bustCache: true, label: `reprocess ${segs.join(',')}` });
}

function getDisplayMode() {
  if (!processData) return 'global';
  if (processData.mode === 'vehicle-relative') return 'vehicle';
  const sel = $('vizMode').value;
  if (sel === 'vehicle') return 'vehicle';
  if (sel === 'local') return 'local';
  return 'global';
}

function isVehicleMode() {
  return getDisplayMode() === 'vehicle';
}

function isLocalPlaybackMode() {
  return getDisplayMode() === 'local';
}

function parseSegmentIdFromSourceFile(sourceFile) {
  if (!sourceFile) return null;
  const match = String(sourceFile).match(/^qlog_f449c_(\d+)\.bz2$/i);
  return match ? match[1] : null;
}

function timelineCrossesSegmentBoundary(fromIdx, toIdx) {
  const timeline = getPlaybackTimeline();
  if (!timeline?.length || fromIdx == null || toIdx == null) return false;
  const from = timeline[fromIdx];
  const to = timeline[toIdx];
  if (!from?.sourceFile || !to?.sourceFile) return false;
  return from.sourceFile !== to.sourceFile;
}

function isBoundaryBridgePlaybackActive(map = renderer?.stationaryLocalMap) {
  const forced = window.__boundaryBridgePlaybackCandidate;
  if (forced === true) return true;
  if (forced === false) return false;
  const CBAO = typeof window !== 'undefined' ? window.CombinedBoundaryAnchoredOrientation : null;
  const candidate = CBAO?.parseCombinedOrientationCandidate?.(window.location.search);
  if (candidate !== 'boundaryAnchored') return false;
  if (!map?.boundaryAnchoredOrientationActive) return false;
  const sourceFiles = map?.sourceFiles || [];
  if (sourceFiles.length < 2) return false;
  const BBP = getBoundaryBridgePlaybackApi();
  if (!BBP?.isAcceptedBridge) return false;
  const bridges = (map?.boundaryBridges || []).filter((b) => BBP.isAcceptedBridge(b));
  return bridges.length > 0;
}

function getBoundaryBridgePlaybackApi() {
  return typeof window !== 'undefined' ? window.BoundaryBridgePlayback : null;
}

function isBridgeBoundaryTransitionState(state = routeTransition.state) {
  return state === 'loadingAndTraversingBridge' || state === 'waitingAtBridgeEnd';
}

function resetBridgePlaybackTransitionFields() {
  routeTransition.bridgeCenterlinePoints = null;
  routeTransition.bridgeMetadata = null;
  routeTransition.bridgeProgress = 0;
  routeTransition.bridgeStartTimestampMs = null;
  routeTransition.bridgePausedAtMs = null;
  routeTransition.bridgePausedDurationMs = 0;
  routeTransition.bridgeDurationS = null;
  routeTransition.bridgeLengthM = 0;
  routeTransition.bridgeDistanceTravelledM = 0;
  routeTransition.nextVideoReady = false;
  routeTransition.arrowHeldAtBridgeEnd = false;
  routeTransition.bridgeFromSourceFile = null;
  routeTransition.bridgeToSourceFile = null;
  routeTransition.bridgeFromTimelineIndex = null;
  routeTransition.bridgeToTimelineIndex = null;
  routeTransition.bridgeMissingVideo = false;
  routeTransition.bridgeLastError = null;
  routeTransition.bridgeTransitionLabel = null;
}

function bridgePlaybackPoseForProgress(progress) {
  const BBP = getBoundaryBridgePlaybackApi();
  const centerline = routeTransition.bridgeCenterlinePoints;
  if (!BBP || !centerline?.length) return null;
  const sampled = BBP.sampleBridgePose(centerline, progress, {
    ...routeTransition.bridgeMetadata,
    bridgeDurationS: routeTransition.bridgeDurationS,
    fromSourceFile: routeTransition.bridgeFromSourceFile,
    toSourceFile: routeTransition.bridgeToSourceFile,
  });
  if (!sampled?.ok) {
    routeTransition.bridgeLastError = sampled?.diagnostic ?? 'sampleFailed';
    return null;
  }
  routeTransition.bridgeDistanceTravelledM = sampled.distanceM ?? 0;
  return sampled.pose;
}

function maybeCommitBridgeBoundaryTransition({ videoReady = false, missing = false } = {}) {
  if (!isBridgeBoundaryTransitionState()) return;
  if (!isBridgeBoundaryTransitionState()) return;
  if (missing) routeTransition.bridgeMissingVideo = true;
  if (videoReady) routeTransition.nextVideoReady = true;
  const BBP = getBoundaryBridgePlaybackApi();
  if (!BBP) return;
  if (BBP.shouldHoldAtBridgeEnd({
    bridgeProgress: routeTransition.bridgeProgress,
    nextVideoReady: routeTransition.nextVideoReady,
  })) {
    routeTransition.state = 'waitingAtBridgeEnd';
    routeTransition.arrowHeldAtBridgeEnd = true;
    const endPose = bridgePlaybackPoseForProgress(1);
    if (endPose) {
      routeTransition.boundaryFrozenPose = endPose;
      renderer?.setPlaybackPose(endPose);
      renderer?.draw();
    }
    return;
  }
  if (!BBP.canCommitBridgeTransition({
    bridgeProgress: routeTransition.bridgeProgress,
    nextVideoReady: routeTransition.nextVideoReady,
    missingVideo: routeTransition.bridgeMissingVideo,
  })) {
    return;
  }
  routeTransition.state = 'readyToEnterNextSegment';
  commitRouteBoundaryTransition({
    videoReady: routeTransition.nextVideoReady,
    missing: routeTransition.bridgeMissingVideo,
  });
}

function tickBridgeBoundaryPlayback(timestampMs) {
  const BBP = getBoundaryBridgePlaybackApi();
  if (!BBP || !isBridgeBoundaryTransitionState()) return;
  routeTransition.frozenTickCount += 1;
  const ts = Number.isFinite(timestampMs) ? timestampMs : performance.now();
  if (!routeTransition.resumeAfterBoundary) {
    if (routeTransition.bridgePausedAtMs == null) {
      routeTransition.bridgePausedAtMs = ts;
    }
  } else if (routeTransition.bridgePausedAtMs != null) {
    routeTransition.bridgePausedDurationMs += Math.max(0, ts - routeTransition.bridgePausedAtMs);
    routeTransition.bridgePausedAtMs = null;
  }
  const progress = routeTransition.resumeAfterBoundary
    ? BBP.computeBridgeProgress({
      timestampMs: ts,
      bridgeStartTimestampMs: routeTransition.bridgeStartTimestampMs,
      bridgePausedDurationMs: routeTransition.bridgePausedDurationMs,
      bridgeDurationS: routeTransition.bridgeDurationS,
    })
    : routeTransition.bridgeProgress;
  routeTransition.bridgeProgress = progress;
  const pose = bridgePlaybackPoseForProgress(progress);
  if (pose) {
    routeTransition.boundaryFrozenPose = pose;
    if (routeTransition.boundaryFrozenEast != null) {
      const de = (pose.east ?? 0) - routeTransition.boundaryFrozenEast;
      const dn = (pose.north ?? 0) - routeTransition.boundaryFrozenNorth;
      routeTransition.arrowMovementDuringBoundaryM += Math.hypot(de, dn);
    }
    routeTransition.boundaryFrozenEast = pose.east ?? 0;
    routeTransition.boundaryFrozenNorth = pose.north ?? 0;
    renderer?.setPlaybackPose(pose);
    if (playbackAnim?.display) {
      renderer?.setMovementDisplay(playbackAnim.display, { east: pose.east, north: pose.north });
    }
    renderer?.draw();
  }
  if (progress >= 1) {
    maybeCommitBridgeBoundaryTransition();
  }
  localPlaybackVideo?.pollBoundaryFrameReady();
  playRafId = requestAnimationFrame(tickPlaybackAnimation);
}

async function beginRouteBoundaryBridgePlayback(fromIdx, toIdx) {
  const playbackData = getPlaybackProcessData();
  const timeline = playbackData?.timeline;
  if (!timeline?.[fromIdx] || !timeline?.[toIdx] || !localPlaybackVideo) return;

  if (isRouteBoundaryLoading()) {
    localPlaybackVideo.cancelBoundaryLoad();
    routeTransition.staleCallbackCount += 1;
  }
  if (playStepTimer) {
    clearTimeout(playStepTimer);
    playStepTimer = null;
  }
  resetRouteTransitionMetrics();
  resetBridgePlaybackTransitionFields();

  const fromEntry = timeline[fromIdx];
  const toEntry = timeline[toIdx];
  const map = renderer?.stationaryLocalMap;
  const BBP = getBoundaryBridgePlaybackApi();
  const bridgePack = BBP?.findAcceptedBridge?.(map, fromEntry.sourceFile, toEntry.sourceFile);
  if (!bridgePack?.ok) {
    routeTransition.bridgeLastError = bridgePack?.diagnostic ?? 'bridgeLookupFailed';
    return beginRouteBoundaryTransitionLegacy(fromIdx, toIdx);
  }
  const arc = BBP.buildBridgeArcLengthTable(bridgePack.centerlinePoints);
  const duration = BBP.resolveBridgeDuration(bridgePack.bridge, arc.totalLengthM);
  if (!duration?.ok) {
    routeTransition.bridgeLastError = duration?.diagnostic ?? 'invalidBridgeDuration';
    return beginRouteBoundaryTransitionLegacy(fromIdx, toIdx);
  }

  const MVT = window.MultisegmentVideoTimeline;
  const provenance = MVT?.resolvePlaybackProvenance(
    timeline,
    toIdx,
    lastProcessedSegmentSelection,
    toEntry.logMonoTime,
  );
  if (!provenance) return;

  routeTransition.state = 'loadingAndTraversingBridge';
  routeTransition.pendingBoundaryIndex = toIdx;
  routeTransition.pendingBoundarySegmentId = provenance.sourceSegmentId;
  routeTransition.pendingBoundaryLocalTimeS = provenance.sourceLocalTimeS ?? 0;
  routeTransition.frozenBoundaryIndex = fromIdx;
  routeTransition.resumeAfterBoundary = true;
  routeTransition.boundaryLoadingStartedAt = performance.now();
  routeTransition.boundarySwitchToken += 1;
  const token = routeTransition.boundarySwitchToken;
  routeTransition.bridgeCenterlinePoints = bridgePack.centerlinePoints;
  routeTransition.bridgeMetadata = bridgePack.bridge;
  routeTransition.bridgeFromSourceFile = fromEntry.sourceFile;
  routeTransition.bridgeToSourceFile = toEntry.sourceFile;
  routeTransition.bridgeFromTimelineIndex = fromIdx;
  routeTransition.bridgeToTimelineIndex = toIdx;
  routeTransition.bridgeDurationS = duration.bridgeDurationS;
  routeTransition.bridgeLengthM = arc.totalLengthM;
  routeTransition.bridgeStartTimestampMs = performance.now();
  routeTransition.bridgeProgress = 0;
  routeTransition.nextVideoReady = false;
  routeTransition.bridgeTransitionLabel = `Transitioning Segment ${parseSegmentIdFromSourceFile(fromEntry.sourceFile) ?? '?'} → ${parseSegmentIdFromSourceFile(toEntry.sourceFile) ?? '?'}`;

  routeTransition.frozenTimelineValue = fromIdx;
  routeTransition.frozenLogMonoTime = fromEntry.logMonoTime ?? null;

  const startPose = bridgePlaybackPoseForProgress(0) ?? resolveLocalPlaybackPose(fromIdx);
  routeTransition.boundaryFrozenPose = startPose;
  routeTransition.boundaryFrozenEast = startPose?.east ?? 0;
  routeTransition.boundaryFrozenNorth = startPose?.north ?? 0;

  const VMD = window.VehicleMovementDisplay;
  const vehiclePathPoint = VMD?.findVehiclePathPoint(playbackData.vehiclePath, fromEntry?.logMonoTime);
  playbackAnim = {
    active: true,
    frozenBoundary: true,
    fromIdx,
    toIdx: fromIdx,
    fromPose: startPose,
    toPose: startPose,
    context: null,
    lastHeadingDeg: startPose?.headingDeg,
    display: VMD?.resolveMovementDisplay({
      timelineEntry: fromEntry,
      vehiclePathPoint,
      framePose: playbackData.frames?.[fromIdx]?.pose,
    }),
    startWallMs: performance.now(),
    durationMs: 1,
  };
  renderer.setPlaybackPose(startPose);
  if (playbackAnim.display) {
    renderer.setMovementDisplay(playbackAnim.display, {
      east: startPose.east,
      north: startPose.north,
    });
  }
  renderer.draw();
  if (!playRafId) playRafId = requestAnimationFrame(tickPlaybackAnimation);

  await localPlaybackVideo.beginBoundaryLoad(provenance, {
    token,
    onReady: () => {
      if (token !== routeTransition.boundarySwitchToken) {
        routeTransition.staleCallbackCount += 1;
        return;
      }
      maybeCommitBridgeBoundaryTransition({ videoReady: true });
    },
    onMissing: () => {
      if (token !== routeTransition.boundarySwitchToken) {
        routeTransition.staleCallbackCount += 1;
        return;
      }
      maybeCommitBridgeBoundaryTransition({ missing: true });
    },
    onStale: () => { routeTransition.staleCallbackCount += 1; },
  });
}

function isRouteBoundaryLoading() {
  if (isBoundaryBridgePlaybackActive()) {
    return isBridgeBoundaryTransitionState();
  }
  return routeTransition.state === 'loadingNextSegmentVideo';
}

function resetRouteTransitionMetrics() {
  routeTransition.frozenTickCount = 0;
  routeTransition.arrowMovementDuringBoundaryM = 0;
  routeTransition.timelineMovementDuringBoundaryS = 0;
}

function getSingleVideoBoundaryDiagnostics() {
  const provenance = resolveActivePlaybackProvenance();
  const videoDiag = localPlaybackVideo?.getDiagnostics?.() ?? {};
  const loadingDurationMs = routeTransition.boundaryLoadingStartedAt != null
    ? performance.now() - routeTransition.boundaryLoadingStartedAt
    : null;
  return {
    state: routeTransition.state,
    currentArrowSegmentId: provenance?.sourceSegmentId ?? null,
    pendingSegmentId: routeTransition.pendingBoundarySegmentId,
    videoSegmentId: videoDiag.activeVideoSegmentId ?? null,
    videoReadyState: videoDiag.videoReadyState ?? null,
    currentPlaybackIndex: getActiveTimelineIndex(),
    pendingBoundaryIndex: routeTransition.pendingBoundaryIndex,
    resumeAfterBoundary: routeTransition.resumeAfterBoundary,
    boundaryLoadingDurationMs: loadingDurationMs,
    staleCallbackCount: routeTransition.staleCallbackCount + (videoDiag.staleSwitchIgnoredCount ?? 0),
    frozenTickCount: routeTransition.frozenTickCount,
    arrowMovementDuringBoundaryM: routeTransition.arrowMovementDuringBoundaryM,
    timelineMovementDuringBoundaryS: routeTransition.timelineMovementDuringBoundaryS,
    boundarySrcChangeCount: videoDiag.boundarySrcChangeCount ?? 0,
  };
}

function cancelRouteBoundaryTransition() {
  if (routeTransition.state === 'idle') return;
  routeTransition.boundarySwitchToken += 1;
  routeTransition.staleCallbackCount += 1;
  localPlaybackVideo?.cancelBoundaryLoad();
  routeTransition.state = 'idle';
  routeTransition.pendingBoundaryIndex = null;
  routeTransition.pendingBoundarySegmentId = null;
  routeTransition.pendingBoundaryLocalTimeS = 0;
  routeTransition.boundaryFrozenPose = null;
  routeTransition.boundaryFrozenEast = null;
  routeTransition.boundaryFrozenNorth = null;
  routeTransition.frozenBoundaryIndex = null;
  routeTransition.frozenTimelineValue = null;
  routeTransition.frozenLogMonoTime = null;
  routeTransition.boundaryLoadingStartedAt = null;
  resetBridgePlaybackTransitionFields();
  if (playRafId) {
    cancelAnimationFrame(playRafId);
    playRafId = null;
  }
  playbackAnim = null;
  syncVideoToActivePose({ isPlaying: false, forceSeek: true, allowRateCorrection: false });
}

function commitRouteBoundaryTransition({ videoReady = true, missing = false } = {}) {
  const commitStates = isBoundaryBridgePlaybackActive()
    ? ['loadingNextSegmentVideo', 'loadingAndTraversingBridge', 'waitingAtBridgeEnd', 'readyToEnterNextSegment']
    : ['loadingNextSegmentVideo'];
  if (!commitStates.includes(routeTransition.state)) return;
  const toIdx = routeTransition.pendingBoundaryIndex;
  const resume = routeTransition.resumeAfterBoundary;
  const token = routeTransition.boundarySwitchToken;

  routeTransition.state = 'readyToEnterNextSegment';

  if (playRafId) {
    cancelAnimationFrame(playRafId);
    playRafId = null;
  }
  playbackAnim = null;

  const tl = $('timeline');
  tl.value = toIdx;
  updateTimelineInfo(toIdx);

  routeTransition.state = 'idle';
  routeTransition.pendingBoundaryIndex = null;
  routeTransition.pendingBoundarySegmentId = null;
  routeTransition.pendingBoundaryLocalTimeS = 0;
  routeTransition.boundaryFrozenPose = null;
  routeTransition.boundaryFrozenEast = null;
  routeTransition.boundaryFrozenNorth = null;
  routeTransition.frozenBoundaryIndex = null;
  routeTransition.frozenTimelineValue = null;
  routeTransition.frozenLogMonoTime = null;
  routeTransition.boundaryLoadingStartedAt = null;
  resetBridgePlaybackTransitionFields();

  if (missing || !videoReady) {
    // Arrow already committed via updateTimelineInfo; continue if playing.
  } else if (resume) {
    localPlaybackVideo.isPlayingMaster = true;
    localPlaybackVideo.setState('playing');
    localPlaybackVideo.videoEl.play().catch(() => {
      localPlaybackVideo.isPlayingMaster = false;
      localPlaybackVideo.setState('paused');
    });
  } else {
    localPlaybackVideo?.syncToActivePose(resolveActivePlaybackProvenance(), {
      isPlaying: false,
      forceSeek: true,
      allowRateCorrection: false,
    });
  }

  if (resume) {
    setPlaybackButtonLabels(true);
    schedulePlaybackStep();
  } else {
    setPlaybackButtonLabels(false);
  }
  syncPlaybackControlStates(toIdx);
  void token;
}

async function beginRouteBoundaryTransition(fromIdx, toIdx) {
  if (isBoundaryBridgePlaybackActive()) {
    return beginRouteBoundaryBridgePlayback(fromIdx, toIdx);
  }
  return beginRouteBoundaryTransitionLegacy(fromIdx, toIdx);
}

async function beginRouteBoundaryTransitionLegacy(fromIdx, toIdx) {
  const playbackData = getPlaybackProcessData();
  const timeline = playbackData?.timeline;
  if (!timeline?.[fromIdx] || !timeline?.[toIdx] || !localPlaybackVideo) return;

  if (isRouteBoundaryLoading()) {
    localPlaybackVideo.cancelBoundaryLoad();
    routeTransition.staleCallbackCount += 1;
  }
  if (playStepTimer) {
    clearTimeout(playStepTimer);
    playStepTimer = null;
  }
  resetRouteTransitionMetrics();

  const MVT = window.MultisegmentVideoTimeline;
  const nextEntry = timeline[toIdx];
  const provenance = MVT?.resolvePlaybackProvenance(
    timeline,
    toIdx,
    lastProcessedSegmentSelection,
    nextEntry.logMonoTime,
  );
  if (!provenance) return;

  routeTransition.state = 'loadingNextSegmentVideo';
  routeTransition.pendingBoundaryIndex = toIdx;
  routeTransition.pendingBoundarySegmentId = provenance.sourceSegmentId;
  routeTransition.pendingBoundaryLocalTimeS = provenance.sourceLocalTimeS ?? 0;
  routeTransition.frozenBoundaryIndex = fromIdx;
  routeTransition.resumeAfterBoundary = true;
  routeTransition.boundaryLoadingStartedAt = performance.now();
  routeTransition.boundarySwitchToken += 1;
  const token = routeTransition.boundarySwitchToken;

  const frozenPose = resolveLocalPlaybackPose(fromIdx);
  routeTransition.boundaryFrozenPose = frozenPose;
  routeTransition.boundaryFrozenEast = frozenPose?.east ?? 0;
  routeTransition.boundaryFrozenNorth = frozenPose?.north ?? 0;
  routeTransition.frozenTimelineValue = fromIdx;
  routeTransition.frozenLogMonoTime = timeline[fromIdx]?.logMonoTime ?? null;

  const VMD = window.VehicleMovementDisplay;
  const t = timeline[fromIdx];
  const vehiclePathPoint = VMD?.findVehiclePathPoint(playbackData.vehiclePath, t?.logMonoTime);
  playbackAnim = {
    active: true,
    frozenBoundary: true,
    fromIdx,
    toIdx: fromIdx,
    fromPose: frozenPose,
    toPose: frozenPose,
    context: null,
    lastHeadingDeg: frozenPose?.headingDeg,
    display: VMD?.resolveMovementDisplay({
      timelineEntry: t,
      vehiclePathPoint,
      framePose: playbackData.frames?.[fromIdx]?.pose,
    }),
    startWallMs: performance.now(),
    durationMs: 1,
  };
  renderer.setPlaybackPose(frozenPose);
  if (playbackAnim.display) {
    renderer.setMovementDisplay(playbackAnim.display, {
      east: frozenPose.east,
      north: frozenPose.north,
    });
  }
  renderer.draw();
  if (!playRafId) playRafId = requestAnimationFrame(tickPlaybackAnimation);

  await localPlaybackVideo.beginBoundaryLoad(provenance, {
    token,
    onReady: () => commitRouteBoundaryTransition({ videoReady: true }),
    onMissing: () => commitRouteBoundaryTransition({ videoReady: false, missing: true }),
    onStale: () => { routeTransition.staleCallbackCount += 1; },
  });
}

function getTimelineStartLogMonoTime() {
  return getPlaybackTimeline()?.[0]?.logMonoTime ?? null;
}

function getActiveTimelineIndex() {
  if (isRouteBoundaryLoading() && routeTransition.frozenBoundaryIndex != null) {
    return routeTransition.frozenBoundaryIndex;
  }
  if (playbackAnim?.active) {
    const elapsed = performance.now() - playbackAnim.startWallMs;
    const alpha = Math.min(1, elapsed / playbackAnim.durationMs);
    return alpha >= 1 ? playbackAnim.toIdx : playbackAnim.fromIdx;
  }
  return parseInt($('timeline')?.value ?? '0', 10);
}

function resolveActivePlaybackProvenance() {
  const MVT = window.MultisegmentVideoTimeline;
  const timeline = getPlaybackTimeline();
  if (!MVT || !timeline?.length) return null;
  const idx = getActiveTimelineIndex();
  const logMono = getCurrentPlaybackLogMonoTime();
  return MVT.resolvePlaybackProvenance(
    timeline,
    idx,
    getPlaybackSegmentSelection(),
    logMono,
  );
}

function isCombinedPlaybackPlaying() {
  return !!(playStepTimer || playbackAnim?.active);
}

async function syncVideoToActivePose(options = {}) {
  if (!localPlaybackVideo || !isLocalPlaybackMode() || !getActiveProgressiveDisplayData()) return;
  const provenance = resolveActivePlaybackProvenance();
  if (!provenance) return;
  await localPlaybackVideo.syncToActivePose(provenance, {
    isPlaying: options.isPlaying ?? isCombinedPlaybackPlaying(),
    forceSeek: options.forceSeek ?? false,
    allowRateCorrection: options.allowRateCorrection ?? isCombinedPlaybackPlaying(),
  });
}

function getActiveVideoSegmentId() {
  const playbackData = getPlaybackProcessData();
  if (!playbackData?.timeline?.length) return null;
  const idx = parseInt($('timeline')?.value ?? '0', 10);
  const sourceFile = playbackData.frames?.[idx]?.sourceFile
    || playbackData.timeline[idx]?.sourceFile
    || playbackData.timeline[0]?.sourceFile;
  if (!sourceFile) return null;
  const match = String(sourceFile).match(/^qlog_f449c_(\d+)\.bz2$/i);
  return match ? match[1] : null;
}

function getCurrentPlaybackLogMonoTime() {
  if (isRouteBoundaryLoading() && routeTransition.frozenLogMonoTime != null) {
    return routeTransition.frozenLogMonoTime;
  }
  if (playbackAnim?.active) {
    const elapsed = performance.now() - playbackAnim.startWallMs;
    const alpha = Math.min(1, elapsed / playbackAnim.durationMs);
    return interpolatedLogMonoTime(playbackAnim.fromIdx, playbackAnim.toIdx, alpha);
  }
  const idx = parseInt($('timeline')?.value ?? '0', 10);
  return getPlaybackProcessData()?.timeline?.[idx]?.logMonoTime ?? null;
}

function updateLocalVideoVisibility() {
  if (!localPlaybackVideo) return;
  const visible = isLocalPlaybackMode() && !!getActiveProgressiveDisplayData();
  localPlaybackVideo.setVisible(visible);
  if (!visible) localPlaybackVideo.pause();
}

async function refreshLocalPlaybackVideo({ resetTimeline = false } = {}) {
  if (!localPlaybackVideo) return;
  updateLocalVideoVisibility();
  const playbackData = getPlaybackProcessData();
  if (!isLocalPlaybackMode() || !playbackData) {
    localPlaybackVideo.unload();
    return;
  }

  const MVT = window.MultisegmentVideoTimeline;
  const entries = MVT?.buildSegmentVideoTimeline(
    playbackData.timeline,
    getPlaybackSegmentSelection(),
  ) ?? [];
  localPlaybackVideo.setSegmentTimeline(entries);
  localPlaybackVideo.setTimelineStart(getTimelineStartLogMonoTime());
  await syncVideoToActivePose({
    forceSeek: resetTimeline,
    allowRateCorrection: false,
    isPlaying: false,
  });
}

function resolveLocalPlaybackPose(idx, extraOptions = {}) {
  const LP = window.LocalPlayback;
  const SLM = window.SegmentLocalMap;
  const playbackData = getPlaybackProcessData();
  if (!LP || !playbackData) return null;

  const mode = getLocalGeometryMode();
  if (mode === 'diagnostic') {
    let pose = LP.resolveArrowForCurrentFrame({
      frames: playbackData.frames,
      timeline: playbackData.timeline,
      vehiclePath: playbackData.vehiclePath,
      frameIndex: idx,
      options: { ...localPlaybackOptions(), ...extraOptions },
    });
    const flags = localPlaybackUrlFlags();
    if (flags.laneRelativeArrow) {
      const frame = playbackData.frames?.[idx];
      pose = LP.applyLaneRelativeArrowOffset(pose, frame);
    }
    return pose;
  }

  const map = getActiveProgressiveDisplayMap() ?? renderer?.stationaryLocalMap;
  if (!map?.valid) {
    return {
      east: 0, north: 0, headingDeg: 0, frozen: false, pathIndex: 0,
      headingSource: 'none', timelineIndex: idx,
    };
  }
  return SLM.resolveArrowOnSegmentMap(
    map,
    playbackData.timeline,
    idx,
    { ...localPlaybackOptions(), ...extraOptions },
  );
}

function resolveLocalGeometryDisplay(idx) {
  const LP = window.LocalPlayback;
  const playbackData = getPlaybackProcessData();
  if (!LP || !playbackData) return null;
  return LP.resolveLocalGeometryFrame(
    playbackData.frames,
    playbackData.timeline,
    idx,
    renderer?._lastValidLocalGeometry ?? null,
  );
}

function getLocalPlaybackContext(frameIndex) {
  const LP = window.LocalPlayback;
  const playbackData = getPlaybackProcessData();
  if (!LP || !playbackData) return null;
  const idx = Number.isInteger(frameIndex) ? frameIndex : parseInt($('timeline')?.value ?? '0', 10);
  const frame = playbackData.frames?.[idx];
  return LP.buildPlaybackContextForFrame({
    frame,
    timeline: playbackData.timeline,
    vehiclePath: playbackData.vehiclePath,
    options: localPlaybackOptions(),
  });
}

function interpolatedLogMonoTime(fromIdx, toIdx, alpha) {
  const timeline = getPlaybackTimeline();
  const from = timeline?.[fromIdx];
  const to = timeline?.[toIdx];
  if (!from?.logMonoTime) return null;
  const t0 = BigInt(String(from.logMonoTime));
  if (!to?.logMonoTime || alpha <= 0) return String(t0);
  if (alpha >= 1) return String(to.logMonoTime);
  const t1 = BigInt(String(to.logMonoTime));
  return String(t0 + BigInt(Math.round(Number(t1 - t0) * alpha)));
}

async function updateLocalPlayback(idx, { forceRefit = false, forceMapRebuild = false, preserveViewport = false } = {}) {
  const LP = window.LocalPlayback;
  const playbackData = getActiveProgressiveDisplayData();
  if (!LP || !playbackData || !renderer) return;
  const ctxAtStart = captureMapAcquisitionContext(idx);
  const flags = localPlaybackUrlFlags();
  const mode = getLocalGeometryMode();
  renderer.setLocalElapsedIdx(idx);
  renderer.setLocalGeometryMode(mode);
  renderer.setLaneRelativeArrow(flags.laneRelativeArrow);

  const prevKey = renderer.stationaryLocalMap?.cacheKey;
  const map = hasActiveProgressiveDisplaySnapshot()
    ? progressiveCombinedState.displayMap
    : await getOrBuildStationaryMapAsync(idx, { forceRebuild: forceMapRebuild });
  if (!map || !mapContextsCompatible(ctxAtStart, readMapAcquisitionContext(idx))) {
    traceMapAcquisition('stale-result-reject', {
      timelineIndex: idx,
      expectedGeneration: ctxAtStart?.generation,
      actualGeneration: readMapAcquisitionContext(idx).generation,
    });
    return;
  }
  const keyChanged = map?.cacheKey && map.cacheKey !== prevKey;
  renderer.setLocalGeometryDisplay(null);
  renderer.setStationaryLocalMap(map, {
    buildCount: stationaryMapBuildCount,
    cacheState: map?.cacheState ?? 'empty',
  });
  const pose = resolveLocalPlaybackPose(idx);
  renderer.setPlaybackPose(pose);
  if (!preserveViewport && (forceRefit || keyChanged || forceMapRebuild)) {
    renderer.clearLocalViewportBounds();
    renderer.fitToLocalView();
  }
  updateGeometryDiagnosticsPanel();
  refreshCandidatePolylines(map);
  refreshConnectedAccumulatedPolylines(map, { timelineIndex: idx });
  updateRepresentativeLaneLinesDiag();
  syncGeographicMapContext();
  updateReviewCompactStatus();
  updateEvidenceCompactCounts();
  renderer.draw();
}

function getConnectedAccumulatedMode() {
  const v = $('connectedAccumulatedMode')?.value;
  if (v === 'perFrame') return 'perFrame';
  if (v === 'roadGuidedDotConnection' || v === 'roadGuidedStatic') return 'roadGuidedDotConnection';
  if (v === 'roadGuidedRankedConnection') return 'roadGuidedRankedConnection';
  if (v === 'roadGuidedSequenceConnection') return 'roadGuidedSequenceConnection';
  return 'currentFrame';
}

function getConnectedAccumulatedActiveFrame(timelineIndex) {
  const idx = Number.isInteger(timelineIndex)
    ? timelineIndex
    : parseInt($('timeline')?.value ?? '0', 10);
  const t = getPlaybackTimeline()?.[idx];
  if (!t) return null;
  return {
    timelineIndex: idx,
    frameId: t.frameId ?? null,
    frameIndex: t.frameIndex ?? idx,
    logMonoTime: t.logMonoTime ?? null,
  };
}

function ensurePerFramePolylinesBuilt(map) {
  const CAD = window.ConnectedAccumulatedDisplay;
  const checksum = map?.checksum ?? null;
  if (!CAD?.buildPerFrameConnectedPolylines || !map?.pointAccumulated?.points) {
    connectedAccumulatedCache = null;
    roadGuidedStaticCache = null;
    roadGuidedRankedCache = null;
    roadGuidedSequenceCache = null;
    return null;
  }
  if (connectedAccumulatedCache?.checksum === checksum && connectedAccumulatedCache?.perFrameBuilt) {
    return connectedAccumulatedCache;
  }
  const built = CAD.buildPerFrameConnectedPolylines(map.pointAccumulated.points);
  connectedAccumulatedCache = {
    checksum,
    perFrameBuilt: built,
    buildCount: (connectedAccumulatedCache?.checksum === checksum
      ? (connectedAccumulatedCache.buildCount || 0) + 1
      : 1),
    frameIndex: CAD.buildPerFramePolylineIndex(built.polylines),
  };
  return connectedAccumulatedCache;
}

function ensureRoadGuidedStaticBuilt(map) {
  const CAD = window.ConnectedAccumulatedDisplay;
  const checksum = map?.checksum ?? null;
  if (!CAD?.buildRoadGuidedDotConnectionDisplay || !map?.pointAccumulated?.points || !map?.trajectory?.length) {
    roadGuidedStaticCache = null;
    return null;
  }
  if (roadGuidedStaticCache?.checksum === checksum && roadGuidedStaticCache?.built) {
    return roadGuidedStaticCache;
  }
  const built = CAD.buildRoadGuidedDotConnectionDisplay(
    map.pointAccumulated.points,
    map.trajectory,
    { chunkId: map.chunkId, passId: map.passId },
  );
  roadGuidedStaticCache = {
    checksum,
    built,
    roadGuidedBuildCount: 1,
    playbackRefreshCount: 0,
    staticChecksum: built.stats?.staticChecksum ?? null,
  };
  return roadGuidedStaticCache;
}

function ensureRoadGuidedRankedBuilt(map) {
  const CAD = window.ConnectedAccumulatedDisplay;
  const checksum = map?.checksum ?? null;
  if (!CAD?.buildRoadGuidedRankedConnectionDisplay || !map?.pointAccumulated?.points || !map?.trajectory?.length) {
    roadGuidedRankedCache = null;
    roadGuidedSequenceCache = null;
    return null;
  }
  if (roadGuidedRankedCache?.checksum === checksum && roadGuidedRankedCache?.built) {
    return roadGuidedRankedCache;
  }
  const cache = ensurePerFramePolylinesBuilt(map);
  const built = CAD.buildRoadGuidedRankedConnectionDisplay(
    map.pointAccumulated.points,
    map.trajectory,
    {
      chunkId: map.chunkId,
      passId: map.passId,
      perFramePolylines: cache?.perFrameBuilt?.polylines,
    },
  );
  roadGuidedRankedCache = {
    checksum,
    built,
    roadGuidedBuildCount: 1,
    playbackRefreshCount: 0,
    staticChecksum: built.stats?.staticChecksum ?? null,
  };
  return roadGuidedRankedCache;
}

function ensureRoadGuidedSequenceBuilt(map) {
  const CAD = window.ConnectedAccumulatedDisplay;
  const checksum = map?.checksum ?? null;
  if (!CAD?.buildRoadGuidedSequenceConnectionDisplay || !map?.pointAccumulated?.points || !map?.trajectory?.length) {
    roadGuidedSequenceCache = null;
    return null;
  }
  if (roadGuidedSequenceCache?.checksum === checksum && roadGuidedSequenceCache?.built) {
    return roadGuidedSequenceCache;
  }
  const cache = ensurePerFramePolylinesBuilt(map);
  const built = CAD.buildRoadGuidedSequenceConnectionDisplay(
    map.pointAccumulated.points,
    map.trajectory,
    {
      chunkId: map.chunkId,
      passId: map.passId,
      perFramePolylines: cache?.perFrameBuilt?.polylines,
    },
  );
  roadGuidedSequenceCache = {
    checksum,
    built,
    roadGuidedBuildCount: 1,
    playbackRefreshCount: 0,
    staticChecksum: built.stats?.staticChecksum ?? null,
  };
  return roadGuidedSequenceCache;
}

function refreshConnectedAccumulatedPolylines(map, { timelineIndex } = {}) {
  const CAD = window.ConnectedAccumulatedDisplay;
  const mode = getConnectedAccumulatedMode();
  if (!CAD?.buildPerFrameConnectedPolylines || !map?.pointAccumulated?.points) {
    renderer?.setConnectedAccumulatedPolylines?.(null, null, mode);
    return;
  }
  const cache = ensurePerFramePolylinesBuilt(map);
  if (!cache) {
    renderer?.setConnectedAccumulatedPolylines?.(null, null, mode);
    return;
  }
  if (mode === 'roadGuidedDotConnection' || mode === 'roadGuidedStatic') {
    const rgCache = ensureRoadGuidedStaticBuilt(map);
    if (!rgCache) {
      renderer?.setConnectedAccumulatedPolylines?.(null, null, mode);
      return;
    }
    rgCache.playbackRefreshCount = (rgCache.playbackRefreshCount || 0) + 1;
    const stats = {
      ...rgCache.built.stats,
      roadGuidedBuildCount: rgCache.roadGuidedBuildCount,
      playbackRefreshCount: rgCache.playbackRefreshCount,
      staticChecksum: rgCache.staticChecksum,
    };
    renderer?.setConnectedAccumulatedPolylines?.(rgCache.built.boundaries, stats, mode);
    return;
  }
  if (mode === 'roadGuidedRankedConnection') {
    const rgCache = ensureRoadGuidedRankedBuilt(map);
    if (!rgCache) {
      renderer?.setConnectedAccumulatedPolylines?.(null, null, mode);
      return;
    }
    rgCache.playbackRefreshCount = (rgCache.playbackRefreshCount || 0) + 1;
    const stats = {
      ...rgCache.built.stats,
      roadGuidedBuildCount: rgCache.roadGuidedBuildCount,
      playbackRefreshCount: rgCache.playbackRefreshCount,
      staticChecksum: rgCache.staticChecksum,
    };
    renderer?.setConnectedAccumulatedPolylines?.(rgCache.built.boundaries, stats, mode);
    return;
  }
  if (mode === 'roadGuidedSequenceConnection') {
    const rgCache = ensureRoadGuidedSequenceBuilt(map);
    if (!rgCache) {
      renderer?.setConnectedAccumulatedPolylines?.(null, null, mode);
      return;
    }
    rgCache.playbackRefreshCount = (rgCache.playbackRefreshCount || 0) + 1;
    const stats = {
      ...rgCache.built.stats,
      roadGuidedBuildCount: rgCache.roadGuidedBuildCount,
      playbackRefreshCount: rgCache.playbackRefreshCount,
      staticChecksum: rgCache.staticChecksum,
    };
    renderer?.setConnectedAccumulatedPolylines?.(rgCache.built.boundaries, stats, mode);
    return;
  }
  if (mode === 'perFrame') {
    const built = cache.perFrameBuilt;
    renderer?.setConnectedAccumulatedPolylines?.(built.polylines, built.stats, mode);
    return;
  }
  const activeFrame = getConnectedAccumulatedActiveFrame(timelineIndex);
  const display = CAD.buildCurrentFrameDisplay(cache.perFrameBuilt.polylines, activeFrame, cache.perFrameBuilt.stats);
  renderer?.setConnectedAccumulatedPolylines?.(display.polylines, display.stats, mode);
}

function refreshCandidatePolylines(map) {
  const CLD = window.CandidateLayerDisplay;
  const playbackData = getActiveProgressiveDisplayData();
  if (!CLD?.isCandidatesFeatureEnabled?.() || !localPlaybackOptions().candidatesEnabled || !playbackData || !map?.referencePose) {
    renderer?.setCandidatePolylines?.(null);
    return;
  }
  const built = CLD.buildGatedCandidatePolylines(playbackData, {
    referencePose: map.referencePose,
    chunkId: map.chunkId,
    passId: map.passId,
    bounds: map.bounds,
  });
  renderer.setCandidatePolylines(built.candidates, built);
}

function switchLocalGeometryLayer() {
  if (!isLocalPlaybackMode() || !getActiveProgressiveDisplayData() || !renderer) return;
  const mode = getLocalGeometryMode();
  persistLocalGeometryMode(mode);
  updatePointOnlyControlVisibility(mode);
  const idx = parseInt($('timeline').value, 10);
  void updateLocalPlayback(idx, { preserveViewport: true }).then(() => renderer.draw());
}

function updatePointOnlyControlVisibility(mode) {
  const isPoint = mode === 'pointAccumulated';
  document.querySelectorAll('.local-point-only-control').forEach((el) => {
    el.classList.toggle('visible', isPoint);
  });
  const candidatesOn = !!localPlaybackOptions().candidatesEnabled;
  document.querySelectorAll('.candidate-layer-control').forEach((el) => {
    el.classList.toggle('visible', isPoint && candidatesOn);
  });
  const obsDebugOn = (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('obsDebug') === '1');
  const obsControls = document.querySelector('.obs-debug-control');
  if (obsControls) obsControls.classList.toggle('visible', obsDebugOn);
}





function initEvidenceLayerToggles() {
  const dots = $('evidenceToggleDots');
  const curves = $('evidenceToggleCurves');
  const lines = $('evidenceToggleDetectedLines');
  const fused = $('layerFusedLanes');
  const conn = $('layerConnectedAccumulated');
  const rep = $('layerRepresentativeLaneLines');
  if (!dots || !curves || !lines) return;

  const syncFromTargets = () => {
    if (uiPresetApplying) return;
    dots.checked = fused?.checked === true;
    curves.checked = conn?.checked === true;
    lines.checked = rep?.checked === true;
  };

  const bind = (toggle, target) => {
    if (!toggle || !target) return;
    toggle.addEventListener('change', () => {
      if (toggle.checked === target.checked) return;
      target.checked = toggle.checked;
      target.dispatchEvent(new Event('change', { bubbles: true }));
    });
    target.addEventListener('change', syncFromTargets);
  };
  bind(dots, fused);
  bind(curves, conn);
  bind(lines, rep);
  syncFromTargets();
}

function initConnectedAccumulatedControls() {
  const modeSel = $('connectedAccumulatedMode');
  const layerCb = $('layerConnectedAccumulated');
  const repCb = $('layerRepresentativeLaneLines');
  const ui = localGeometryUI();

  // Initial defaults: enabled + All per-frame (URL → session → HTML).
  if (layerCb) {
    let sessionEnabled = null;
    try { sessionEnabled = sessionStorage.getItem(ui.CONNECTED_ACCUMULATED_SESSION_ENABLED_KEY); } catch (_) {}
    layerCb.checked = !!(ui.resolveInitialConnectedAccumulatedEnabled
      ? ui.resolveInitialConnectedAccumulatedEnabled(
        typeof window !== 'undefined' ? window.location.search : '',
        sessionEnabled,
        layerCb.checked,
      )
      : layerCb.checked);
  }
  if (modeSel) {
    let sessionMode = null;
    try { sessionMode = sessionStorage.getItem(ui.CONNECTED_ACCUMULATED_SESSION_MODE_KEY); } catch (_) {}
    modeSel.value = (ui.resolveInitialConnectedAccumulatedMode
      ? ui.resolveInitialConnectedAccumulatedMode(
        typeof window !== 'undefined' ? window.location.search : '',
        sessionMode,
        modeSel.value,
      )
      : modeSel.value);
  }
  // Candidate flag: URL representativeLaneLinesCandidate=1 checks the box once.
  if (repCb) {
    const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
    if (params.get('representativeLaneLinesCandidate') === '1') repCb.checked = true;
  }

  const persist = () => {
    try {
      if (layerCb) {
        sessionStorage.setItem(
          ui.CONNECTED_ACCUMULATED_SESSION_ENABLED_KEY || 'qlogConnectedAccumulatedEnabledSession',
          layerCb.checked ? '1' : '0',
        );
      }
      if (modeSel) {
        sessionStorage.setItem(
          ui.CONNECTED_ACCUMULATED_SESSION_MODE_KEY || 'qlogConnectedAccumulatedModeSession',
          modeSel.value,
        );
      }
    } catch (_) {}
  };

  const refresh = () => {
    persist();
    const map = renderer?.stationaryLocalMap;
    if (map) refreshConnectedAccumulatedPolylines(map);
    if (getActiveProgressiveDisplayData() && renderer) {
      applyRendererPlaybackData();
    } else {
      renderer?.draw?.();
    }
    syncGeographicMapScene();
    updateRepresentativeLaneLinesDiag();
  };
  modeSel?.addEventListener('change', refresh);
  layerCb?.addEventListener('change', refresh);
  repCb?.addEventListener('change', refresh);
}

function updateRepresentativeLaneLinesDiag() {
  const el = $('representativeLaneLinesDiag');
  if (!el) return;
  const repOn = $('layerRepresentativeLaneLines')?.checked === true
    || $('evidenceToggleDetectedLines')?.checked === true;
  const d = renderer?.getRepresentativeLaneLinesDiagnostics?.();
  const geo = geographicMap?.getDiagnostics?.();
  if (!d?.candidateActive) {
    if (repOn && (geo?.laneLines > 0)) {
      el.textContent = `Detected lane lines: on (${geo.laneLines} map features)`;
      return;
    }
    if (repOn) {
      el.textContent = 'Detected lane overlay unavailable';
      return;
    }
    el.textContent = 'Representative lines: off';
    return;
  }
  const splits = d.splitReasonCounts || {};
  const method = (d.reusedStage && /legacy|robust/i.test(d.reusedStage)) ? 'legacy' : 'association';
  el.textContent = [
    `Representative lines (${method}): ${d.representativeLineCount ?? 0}`,
    `logicalLanes ${d.logicalLaneCount ?? '—'}`,
    `clusters ${d.physicalClusterCount ?? '—'}`,
    `reduction ${d.reductionRatio != null ? d.reductionRatio.toFixed(2) + 'x' : '—'}`,
    `srcFrames ${d.sourceFrameCount ?? 0}`,
    `srcCurves ${d.sourceCurveCount ?? 0}`,
    `rejected ${d.rejectedCurveCount ?? 0}`,
    `splits gap=${splits.alongTrackGap ?? 0}/step=${splits.spatialStep ?? 0}/lat=${splits.lateralStep ?? 0}/hdg=${splits.incompatibleHeading ?? 0}`,
    `support [${d.supportRange?.min ?? '—'}–${d.supportRange?.max ?? '—'}]`,
    `medSup ${d.medianSupportFrames ?? '—'}`,
    `coverage ${d.totalSupportedCoverageM ?? '—'}m`,
    `spread [${d.lateralSpreadRange?.min != null ? Number(d.lateralSpreadRange.min).toFixed(2) : '—'}–${d.lateralSpreadRange?.max != null ? Number(d.lateralSpreadRange.max).toFixed(2) : '—'}]`,
  ].join(' · ');
  if (d.stationSupportCandidate) {
    const sr = d.stationSupportReasons || {};
    el.textContent += ` · Station robust mode: retained ${d.stationSupportAccepted ?? 0} stations · discarded ${d.stationSupportDiscarded ?? 0} isolated observations · genuine bimodal ${sr.competingExtendedMode ?? 0} · unstable ${sr.temporalRevisitRisk ?? 0}`;
  }
  updateEvidenceCompactCounts();
  // Temporary alignment diagnostics are no longer shown in the normal UI. They
  // remain available (internal counters) via getRepresentativeLaneLinesDiagnostics().
}


function updatePointDisplayModeLabel() {
  const label = $('pointDisplayModeLabel');
  if (!label) return;
  const causal = renderer?.getPointCausalPlayback?.() === true;
  label.textContent = causal ? 'Causal playback' : 'Full route';
}

function initPointCausalToggle() {
  const cb = $('pointCausalPlayback');
  if (!cb) return;
  cb.checked = renderer?.getPointCausalPlayback?.() === true;
  cb.addEventListener('change', () => {
    renderer.setPointCausalPlayback(cb.checked);
    updatePointDisplayModeLabel();
  });
}

function initPointReliabilityTint() {
  const cb = $('pointReliabilityTint');
  if (!cb) return;
  cb.checked = renderer?.getPointReliabilityTint?.() === true;
  cb.addEventListener('change', () => {
    renderer.setPointReliabilityTint(cb.checked);
  });
}

function initExperimentalBoundariesMode() {
  const sel = $('expBoundariesMode');
  if (!sel) return;
  sel.value = renderer?.getExperimentalBoundariesMode?.() || 'off';
  sel.addEventListener('change', () => {
    renderer.setExperimentalBoundariesMode(sel.value);
  });
}

function initMirrorRoadLateralDisplay() {
  const cb = $('mirrorRoadLateral');
  if (!cb) return;
  cb.checked = renderer?.getMirrorRoadLateralDisplay?.() === true;
  cb.addEventListener('change', () => {
    renderer.setMirrorRoadLateralDisplay(cb.checked);
  });
}

function applyVisualization() {
  const playbackData = getActiveProgressiveDisplayData();
  if (!playbackData) return;
  const displayMode = getDisplayMode();
  const wasLocal = renderer?.displayMode === 'local';
  if (wasLocal && displayMode !== 'local') {
    saveLocalPlaybackViewState();
  }

  $('vehicleRelBanner').classList.toggle('hidden', displayMode !== 'vehicle');
  $('localPlaybackBanner').classList.toggle('hidden', displayMode !== 'local');

  const modeText = displayMode === 'vehicle'
    ? 'Vehicle-relative model view — not a global road map.'
    : displayMode === 'local'
      ? 'Local playback — stationary segment map with moving arrow'
      : `Global map — ${processData.stats.routeChunkCount} route chunks, ${processData.stats.recordingSessionCount} sessions`;
  $('modeLabel').textContent = modeText;

  const tl = $('timeline');
  tl.disabled = false;
  tl.min = 0;
  tl.max = Math.max(0, (playbackData.timeline?.length || 1) - 1);

  let timelineIdx = 0;
  let preserveViewport = false;
  if (displayMode === 'local') {
    initLocalGeometryModeSelect();
    updatePointOnlyControlVisibility(getLocalGeometryMode());
    initPointCausalToggle();
    initPointReliabilityTint();
    initExperimentalBoundariesMode();
    initMirrorRoadLateralDisplay();
    updatePointDisplayModeLabel();
    if (lastLocalPlaybackState) {
      timelineIdx = Math.min(
        Math.max(0, lastLocalPlaybackState.timelineIndex),
        parseInt(tl.max, 10),
      );
      if (lastLocalPlaybackState.geometryMode) {
        const sel = $('localGeometryMode');
        if (sel) sel.value = normalizeLocalGeometrySelection(lastLocalPlaybackState.geometryMode);
      }
      preserveViewport = restoreLocalPlaybackViewState();
    }
  }
  tl.value = timelineIdx;

  applyRendererPlaybackData();
  if (hasActiveProgressiveDisplaySnapshot()) {
    const map = progressiveCombinedState.displayMap;
    renderer.setStationaryLocalMap(map, {
      buildCount: stationaryMapBuildCount,
      cacheState: map?.cacheState ?? 'progressive',
    });
  }
  syncGeographicMapContext();
  if (geographicMap?.isActive?.() && isLocalPlaybackMode()) {
    requestAnimationFrame(() => {
      geographicMap.resize?.();
      renderer.fitToLocalView?.();
    });
  }
  renderer.setFrameIndex(timelineIdx);
  if (displayMode === 'local') {
    void updateLocalPlayback(timelineIdx, {
      forceRefit: !preserveViewport,
      forceMapRebuild: false,
      preserveViewport,
    });
  } else {
    renderer.setPlaybackPose(null);
    renderer.fitToView();
  }
  updateInfoPanel(processData?.stats ?? playbackData.stats);
  updateFileAuditTable(processData);
  updateFrameCountPanel(processData);
  updateChunkTable(processData.chunkDiagnostics, processData.stats);
  updatePassTable(processData.chunkDiagnostics, processData.geometryDebug);
  updateTrackDiagnostics(processData);
  updateTimelineInfo(timelineIdx);
  refreshLocalPlaybackVideo({ resetTimeline: displayMode === 'local' && !lastLocalPlaybackState });
}

function updateInfoPanel(stats) {
  const dl = $('infoPanel');
  const fc = stats?.frameCounts;
  const entries = stats ? [
    ['Processing version', processData?.processingVersion ?? '—'],
    ['Processed at', processData?.processedAt ?? '—'],
    ['Cache hit', processData?.cacheHit ? 'yes' : 'no'],
    ['Pose source', stats.poseSource?.pipelinePoseSource ?? stats.poseSource?.[0]?.pipelinePoseSource ?? '—'],
    ['Source files', stats.sourceFileCount ?? processData?.fileAudits?.length ?? '—'],
    ['Recording sessions', stats.recordingSessionCount ?? '—'],
    ['Route chunks', stats.routeChunkCount ?? '—'],
    ['Raw modelV2 messages', fc?.rawModelV2Messages ?? stats.modelEventCount ?? '—'],
    ['Parsed model frames', fc?.parsedModelFrames ?? '—'],
    ['GPS-aligned frames', fc?.gpsAlignedFrames ?? stats.validModelFrames ?? '—'],
    ['Valid lane frames', fc?.validLaneFrames ?? '—'],
    ['Valid road-edge frames', fc?.validRoadEdgeFrames ?? '—'],
    ['Interpolated pose frames', fc?.interpolatedPoseFrames ?? '—'],
    ['Vehicle-relative frames', fc?.vehicleRelativeFrames ?? '—'],
    ['GPS events', stats.gpsEventCount ?? '—'],
    ['Valid GPS samples', stats.validGpsCount ?? '—'],
    ['Road polygons', stats.roadPolygonCount ?? '—'],
    ['Rejected polygons', stats.rejectedPolygonCount ?? '—'],
    ['Passes (debug)', processData?.geometryDebug?.passCount ?? '—'],
    ['Polygons (debug)', processData?.geometryDebug?.polygonCount ?? '—'],
    ['Largest polygon area', stats.largestPolygonArea?.toFixed?.(1) ?? '—'],
    ['Max internal GPS gap', stats.maxInternalGpsGapPerChunkM?.toFixed?.(1) ?? '—'],
    ['Mode', processData?.mode ?? '—'],
  ] : [];
  if (stats?.fileOverlaps?.length) entries.push(['Timestamp overlaps', stats.fileOverlaps.length]);
  if (stats?.orderingUncertain?.length) entries.push(['Ordering uncertain', stats.orderingUncertain.length]);
  dl.innerHTML = entries.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

function updateFileAuditTable(data) {
  const el = $('fileAuditTable');
  const audits = data?.fileAudits || [];
  const quals = data?.segmentQualifications || [];
  const qualByFile = new Map(quals.map((q) => [q.filename, q]));
  if (!audits.length) {
    el.innerHTML = '<p>No file audit data — reprocess to refresh</p>';
    return;
  }
  const rows = audits.map((a) => {
    const q = qualByFile.get(a.filename);
    return `<tr>
      <td>${a.filename}</td>
      <td>${a.fileSizeBytes}</td>
      <td title="${a.sha256}">${a.sha256.slice(0, 12)}…</td>
      <td>${a.modelV2Count}</td>
      <td>${a.gpsCount}</td>
      <td>${a.liveLocationKalmanCount}</td>
      <td>${a.durationSec?.modelV2?.toFixed?.(1) ?? '—'}s</td>
      <td>${(q?.flags || []).join(', ') || 'ok'}</td>
    </tr>`;
  }).join('');
  const warnings = (data.staleCacheWarnings || []).map((w) =>
    `<p class="warn">⚠ ${w.filename}: ${w.message}</p>`
  ).join('');
  el.innerHTML = `${warnings}<table>
    <thead><tr><th>File</th><th>Size</th><th>SHA-256</th><th>modelV2</th><th>GPS</th><th>Kalman</th><th>Duration</th><th>Flags</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function updateFrameCountPanel(data) {
  const el = $('frameCountPanel');
  const perFile = data?.stats?.frameCountsPerFile;
  if (!perFile || !Object.keys(perFile).length) {
    el.innerHTML = '<p>No frame count breakdown</p>';
    return;
  }
  const rows = Object.entries(perFile).map(([f, c]) => `<tr>
    <td>${f}</td>
    <td>${c.rawModelV2Messages}</td>
    <td>${c.parsedModelFrames}</td>
    <td>${c.validLaneFrames}</td>
    <td>${c.validRoadEdgeFrames}</td>
    <td>${c.gpsAlignedFrames}</td>
    <td>${c.interpolatedPoseFrames}</td>
    <td>${c.vehicleRelativeFrames}</td>
  </tr>`).join('');
  el.innerHTML = `<table>
    <thead><tr><th>File</th><th>Raw modelV2</th><th>Parsed</th><th>Lane</th><th>Edge</th><th>GPS-aligned</th><th>Interpolated</th><th>Veh-rel</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="meta-line">Timeline frames = GPS-aligned or vehicle-relative; not raw modelV2 count.</p>`;
}

function updatePassTable(diagnostics, geometryDebug) {
  const el = $('passTable');
  const rows = [];
  const coverage = geometryDebug?.passCoverage?.length
    ? geometryDebug.passCoverage
    : (diagnostics || []).flatMap((c) => (c.passCoverage || []).map((p) => ({ ...p, chunkId: p.chunkId ?? c.chunkId })));

  for (const p of coverage) {
    rows.push(`
      <tr>
        <td>${p.chunkId}</td>
        <td>${p.passId}</td>
        <td>${p.frameCount}</td>
        <td>${p.pathLengthM?.toFixed?.(1)}</td>
        <td>${p.leftCoverageM?.toFixed?.(1)}</td>
        <td>${p.rightCoverageM?.toFixed?.(1)}</td>
        <td>${p.pairedCoverageM?.toFixed?.(1)}</td>
        <td>${p.acceptedPolygonCount}</td>
        <td>${p.rejectedPolygonCount}</td>
        <td>${(p.rejectionReasons || []).join(', ') || '—'}</td>
        <td>${p.coveragePercent?.toFixed?.(1)}%</td>
        <td>${p.suspiciousGps ? 'yes' : 'no'}</td>
      </tr>
    `);
  }

  el.innerHTML = rows.length ? `
    <table>
      <thead><tr>
        <th>Chunk</th><th>Pass</th><th>Frames</th><th>Dist(m)</th>
        <th>Left(m)</th><th>Right(m)</th><th>Paired(m)</th>
        <th>Polygons</th><th>Rejected</th><th>Reasons</th><th>Coverage</th><th>Suspicious</th>
      </tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>` : '<p>No passes detected — reprocess to refresh API data</p>';
}

function updateTrackDiagnostics(data) {
  const el = $('trackDiagnostics');
  const summary = data?.stats?.laneTrackingSummary || data?.geometryDebug?.laneTracking;
  if (!summary?.length) {
    el.innerHTML = '<p>No lane-tracking diagnostics</p>';
    return;
  }
  const rows = summary.map((s) => `
    <tr>
      <td>${s.passId}</td>
      <td>${s.trackCount ?? '—'}</td>
      <td>${s.createdTracks ?? '—'}</td>
      <td>${s.continuedTracks ?? '—'}</td>
      <td>${s.terminatedTracks ?? '—'}</td>
      <td>${s.rejectedMatches ?? '—'}</td>
      <td>${s.ambiguousMatches ?? '—'}</td>
      <td>${s.meanMatchCost?.toFixed?.(2) ?? '—'}</td>
    </tr>
  `).join('');
  el.innerHTML = `<table>
    <thead><tr><th>Pass</th><th>Tracks</th><th>Created</th><th>Continued</th><th>Terminated</th><th>Rejected</th><th>Ambiguous</th><th>Mean cost</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function updateChunkTable(diagnostics, stats) {
  const el = $('chunkTable');
  if (!diagnostics?.length) { el.innerHTML = '<p>No chunks</p>'; return; }

  const rows = diagnostics.map((c) => `
    <tr>
      <td>${c.chunkId}</td>
      <td>${c.sessionId}</td>
      <td>${c.files?.join(', ')}</td>
      <td>${c.frameCount}</td>
      <td>${c.passCount ?? c.passCoverage?.length ?? 0}</td>
      <td>${c.roadSurfacePolygonCount}</td>
      <td>${c.geometryRejectionCount}</td>
    </tr>
  `).join('');

  el.innerHTML = `
    <p><strong>${stats?.routeChunkCount ?? 0}</strong> chunks, <strong>${processData?.geometryDebug?.passCount ?? 0}</strong> passes, <strong>${processData?.geometryDebug?.polygonCount ?? 0}</strong> polygons</p>
    <table>
      <thead><tr>
        <th>Chunk</th><th>Session</th><th>Files</th><th>Frames</th><th>Passes</th><th>Polygons</th><th>Rejected</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function updateMovementIndicator(idx) {
  const displayMode = getDisplayMode();
  const VMD = window.VehicleMovementDisplay;
  const playbackData = getActiveProgressiveDisplayData();
  if (!VMD || !playbackData || displayMode === 'global') {
    renderer.setMovementDisplay(null);
    return;
  }

  const t = playbackData.timeline?.[idx];
  const frame = playbackData.frames?.[idx];
  const vehiclePathPoint = VMD.findVehiclePathPoint(playbackData.vehiclePath, t?.logMonoTime);
  const display = VMD.resolveMovementDisplay({
    timelineEntry: t,
    vehiclePathPoint,
    framePose: frame?.pose,
  });

  if (displayMode === 'vehicle') {
    renderer.setMovementDisplay(display, { east: 0, north: 0 });
    return;
  }

  if (displayMode === 'local') {
    if (!playbackAnim?.active) updateLocalPlayback(idx);
    const pose = renderer.playbackPose;
    if (pose) {
      renderer.setMovementDisplay(display, { east: pose.east, north: pose.north });
    } else {
      renderer.setMovementDisplay(null);
    }
    return;
  }
}

function updateTimelineInfo(idx) {
  const playbackData = getPlaybackProcessData();
  const t = playbackData?.timeline?.[idx];
  const dl = $('timelineInfo');
  if (!t) { dl.innerHTML = ''; renderer.setMovementDisplay(null); return; }
  const frame = playbackData?.frames?.[idx];
  const trackIds = (frame?.lanes || []).map((l) => l.laneTrackId).filter((x) => x != null);
  const vehiclePathPoint = window.VehicleMovementDisplay?.findVehiclePathPoint(
    playbackData?.vehiclePath,
    t?.logMonoTime,
  );
  const movementState = t.movementState ?? vehiclePathPoint?.movementState ?? '—';
  const speedKmh = Number.isFinite(t.speed) ? (t.speed * 3.6).toFixed(1) : '—';
  const fields = [
    ['Elapsed idx', idx],
    ...(isBridgeBoundaryTransitionState() && routeTransition.bridgeTransitionLabel
      ? [['Boundary', routeTransition.bridgeTransitionLabel], ['Bridge progress', routeTransition.bridgeProgress?.toFixed?.(3) ?? '—']]
      : []),
    ['Chunk ID', t.chunkId ?? '—'],
    ['Pass ID', frame?.passId ?? '—'],
    ['logMonoTime', t.logMonoTime],
    ['Source file', t.sourceFile],
    ['frameId', t.frameId],
    ['Lane tracks', trackIds.join(', ') || '—'],
    ['Speed (m/s)', t.speed?.toFixed?.(2)],
    ['Speed (km/h)', speedKmh],
    ['Movement state', movementState],
    ['Lane lines', t.laneCount],
  ];
  dl.innerHTML = fields.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  renderer.setFrameIndex(idx, { redraw: false });
  if (isLocalPlaybackMode()) {
    updateLocalPlayback(idx);
    const pose = renderer.playbackPose;
    renderer.draw();
    localPlaybackVideo?.onTimelineScrub(resolveActivePlaybackProvenance());
  } else {
    renderer.draw();
  }
  updateMovementIndicator(idx);
  applyFollowArrowIfNeeded();
  syncPlaybackControlStates(idx);
  updateReviewCompactStatus();
}

function logMonoDeltaMs(timeline, fromIdx, toIdx, speed) {
  if (!timeline?.[fromIdx]?.logMonoTime || !timeline?.[toIdx]?.logMonoTime) return 800 / speed;
  const t0 = BigInt(String(timeline[fromIdx].logMonoTime));
  const t1 = BigInt(String(timeline[toIdx].logMonoTime));
  const deltaNs = t1 > t0 ? t1 - t0 : 0n;
  return Math.max(1, Number(deltaNs) / 1e6 / speed);
}

function tickPlaybackAnimation(timestampMs) {
  if (!playbackAnim?.active || !renderer) return;

  if (isRouteBoundaryLoading()) {
    if (isBoundaryBridgePlaybackActive() && isBridgeBoundaryTransitionState()) {
      tickBridgeBoundaryPlayback(timestampMs);
      return;
    }
    routeTransition.frozenTickCount += 1;
    const pose = routeTransition.boundaryFrozenPose;
    if (pose) {
      renderer.setPlaybackPose(pose);
      if (playbackAnim.display) {
        renderer.setMovementDisplay(playbackAnim.display, { east: pose.east, north: pose.north });
      }
      renderer.draw();
      const currentPose = renderer.playbackPose;
      if (currentPose && routeTransition.boundaryFrozenEast != null) {
        const de = (currentPose.east ?? 0) - routeTransition.boundaryFrozenEast;
        const dn = (currentPose.north ?? 0) - routeTransition.boundaryFrozenNorth;
        routeTransition.arrowMovementDuringBoundaryM += Math.hypot(de, dn);
      }
    }
    const tlVal = parseInt($('timeline')?.value ?? '0', 10);
    if (routeTransition.frozenTimelineValue != null && tlVal !== routeTransition.frozenTimelineValue) {
      const timing = window.SegmentVideoTiming;
      const fromMono = routeTransition.frozenLogMonoTime;
      const curMono = getPlaybackProcessData()?.timeline?.[tlVal]?.logMonoTime;
      if (timing && fromMono && curMono) {
        const delta = timing.computeLocalElapsedSeconds(curMono, fromMono) ?? 0;
        routeTransition.timelineMovementDuringBoundaryS += Math.abs(delta);
      }
    }
    localPlaybackVideo?.pollBoundaryFrameReady();
    playRafId = requestAnimationFrame(tickPlaybackAnimation);
    return;
  }

  const elapsed = performance.now() - playbackAnim.startWallMs;
  const alpha = Math.min(1, elapsed / playbackAnim.durationMs);
  const LP = window.LocalPlayback;
  const pose = LP?.lerpPose(playbackAnim.fromPose, playbackAnim.toPose, alpha);
  if (pose) {
    if (getLocalGeometryMode() === 'diagnostic' && playbackAnim.context) {
      const playbackData = getPlaybackProcessData();
      const timeStr = interpolatedLogMonoTime(playbackAnim.fromIdx, playbackAnim.toIdx, alpha);
      if (timeStr && playbackData) {
        const currentIdx = alpha >= 1 ? playbackAnim.toIdx : playbackAnim.fromIdx;
        const currentFrame = playbackData.frames?.[currentIdx];
        const poseHeading = currentFrame?.pose?.headingDeg
          ?? playbackData.timeline[currentIdx]?.bearingDeg;
        if (Number.isFinite(poseHeading)) {
          pose.headingDeg = poseHeading;
          pose.headingSource = currentFrame?.pose?.headingSource ?? 'framePose';
        } else {
          const headingPose = LP.resolveArrowAtLogMonoTime(
            playbackAnim.context,
            timeStr,
            playbackData.timeline[playbackAnim.fromIdx],
            {
              ...localPlaybackOptions(),
              vehiclePath: playbackData.vehiclePath,
              smoothHeading: false,
            },
          );
          pose.headingDeg = headingPose.headingDeg;
          pose.headingSource = 'currentPathTangent';
        }
        playbackAnim.lastHeadingDeg = pose.headingDeg;
      }
    } else if (getLocalGeometryMode() !== 'diagnostic') {
      const SLM = window.SegmentLocalMap;
      const timeStr = interpolatedLogMonoTime(playbackAnim.fromIdx, playbackAnim.toIdx, alpha);
      if (SLM && timeStr && renderer.stationaryLocalMap?.trajectory?.length) {
        const interp = LP.interpolateTimedPath(
          renderer.stationaryLocalMap.trajectory,
          timeStr,
          playbackAnim.lastHeadingDeg ?? null,
          { ...localPlaybackOptions(), smoothHeading: false },
        );
        pose.east = interp.east;
        pose.north = interp.north;
        pose.headingDeg = interp.headingDeg;
        pose.headingSource = 'segmentTrajectory';
        playbackAnim.lastHeadingDeg = pose.headingDeg;
      }
    }
    renderer.setPlaybackPose(pose);
    if (playbackAnim.display) {
      renderer.setMovementDisplay(playbackAnim.display, { east: pose.east, north: pose.north });
    }
    renderer.draw();
    localPlaybackVideo?.tickSync(resolveActivePlaybackProvenance(), {
      isPlaying: isCombinedPlaybackPlaying(),
    });
  }
  playRafId = requestAnimationFrame(tickPlaybackAnimation);
}

function schedulePlaybackStep() {
  const timeline = getPlaybackTimeline();
  if (!timeline?.length) {
    stopPlayback();
    return;
  }
  const tl = $('timeline');
  const idx = parseInt(tl.value, 10);
  const max = parseInt(tl.max, 10);
  if (idx >= max) {
    stopPlayback();
    return;
  }

  playSpeed = parseFloat($('playSpeed')?.value ?? 1);
  const nextIdx = idx + 1;

  if (isLocalPlaybackMode() && timelineCrossesSegmentBoundary(idx, nextIdx)) {
    beginRouteBoundaryTransition(idx, nextIdx);
    return;
  }

  const durationMs = logMonoDeltaMs(timeline, idx, nextIdx, playSpeed);

  if (isLocalPlaybackMode()) {
    const VMD = window.VehicleMovementDisplay;
    const playbackData = getPlaybackProcessData();
    const t = timeline[idx];
    const vehiclePathPoint = VMD?.findVehiclePathPoint(playbackData?.vehiclePath, t?.logMonoTime);
    const diagnostic = getLocalGeometryMode() === 'diagnostic';
    playbackAnim = {
      active: true,
      fromIdx: idx,
      toIdx: nextIdx,
      fromPose: resolveLocalPlaybackPose(idx),
      toPose: resolveLocalPlaybackPose(nextIdx),
      context: diagnostic ? getLocalPlaybackContext(idx) : null,
      lastHeadingDeg: resolveLocalPlaybackPose(idx)?.headingDeg,
      display: VMD?.resolveMovementDisplay({
        timelineEntry: t,
        vehiclePathPoint,
        framePose: playbackData?.frames?.[idx]?.pose,
      }),
      startWallMs: performance.now(),
      durationMs,
    };
    if (!playRafId) playRafId = requestAnimationFrame(tickPlaybackAnimation);
    localPlaybackVideo?.playFromLogMonoTime(resolveActivePlaybackProvenance(), true);
  }

  playStepTimer = setTimeout(() => {
    playbackAnim = null;
    tl.value = nextIdx;
    updateTimelineInfo(nextIdx);
    schedulePlaybackStep();
  }, durationMs);
}

function isPlaybackUiPlaying() {
  if (isRouteBoundaryLoading()) return routeTransition.resumeAfterBoundary;
  return !!(playStepTimer || playbackAnim?.active);
}

function setPlaybackButtonLabels(playing) {
  const label = playing ? '⏸ Pause' : '▶ Play';
  for (const id of ['btnPlay', 'btnProgressivePlay']) {
    const el = $(id);
    if (el) el.textContent = label;
  }
}

function getVisibleTimelineMaxIndex() {
  const tl = $('timeline');
  if (tl && !tl.disabled) return parseInt(tl.max, 10);
  const len = getPlaybackProcessData()?.timeline?.length ?? 0;
  return Math.max(0, len - 1);
}

function updateProgressiveViewportPlaybackInfo(idx) {
  if (!isProgressiveViewportCandidateEnabled()) return;
  const el = $('progressiveViewportPlaybackInfo');
  if (!el) return;
  const t = getPlaybackProcessData()?.timeline?.[idx];
  if (!t) {
    el.textContent = '—';
    return;
  }
  const time = t.logMonoTime != null ? String(t.logMonoTime) : '—';
  el.textContent = `Frame ${idx} · ${t.sourceFile ?? '—'} · ${time}`;
}

function syncPlaybackControlStates(idx = parseInt($('timeline')?.value ?? '0', 10)) {
  const atStart = idx <= 0;
  const atEnd = idx >= getVisibleTimelineMaxIndex();
  for (const id of ['btnPrevFrame', 'btnProgressivePrevFrame']) {
    const el = $(id);
    if (el) el.disabled = atStart;
  }
  for (const id of ['btnNextFrame', 'btnProgressiveNextFrame']) {
    const el = $(id);
    if (el) el.disabled = atEnd;
  }
  setPlaybackButtonLabels(isPlaybackUiPlaying());
  updateProgressiveViewportPlaybackInfo(idx);
}

function stepTimelinePrev() {
  const tl = $('timeline');
  if (!tl || tl.disabled) return;
  const idx = parseInt(tl.value, 10);
  if (idx <= 0) return;
  if (playStepTimer || playbackAnim?.active) stopPlayback();
  tl.value = idx - 1;
  updateTimelineInfo(idx - 1);
}

function stepTimelineNext() {
  const tl = $('timeline');
  if (!tl || tl.disabled) return;
  const idx = parseInt(tl.value, 10);
  const max = getVisibleTimelineMaxIndex();
  if (idx >= max) return;
  if (playStepTimer || playbackAnim?.active) stopPlayback();
  tl.value = idx + 1;
  updateTimelineInfo(idx + 1);
}

function stopPlayback() {
  if (isRouteBoundaryLoading()) {
    routeTransition.resumeAfterBoundary = false;
    if (playStepTimer) {
      clearTimeout(playStepTimer);
      playStepTimer = null;
    }
    setPlaybackButtonLabels(false);
    playSpeed = parseFloat($('playSpeed')?.value ?? 1);
    syncPlaybackControlStates();
    return;
  }
  if (playStepTimer) {
    clearTimeout(playStepTimer);
    playStepTimer = null;
  }
  if (playRafId) {
    cancelAnimationFrame(playRafId);
    playRafId = null;
  }
  playbackAnim = null;
  localPlaybackVideo?.onMasterPaused(resolveActivePlaybackProvenance());
  setPlaybackButtonLabels(false);
  playSpeed = parseFloat($('playSpeed')?.value ?? 1);
  syncPlaybackControlStates();
}

function togglePlayback() {
  if (isRouteBoundaryLoading()) {
    if (routeTransition.resumeAfterBoundary) {
      routeTransition.resumeAfterBoundary = false;
      if (isBoundaryBridgePlaybackActive() && isBridgeBoundaryTransitionState()) {
        routeTransition.bridgePausedAtMs = performance.now();
      }
      setPlaybackButtonLabels(false);
    } else {
      routeTransition.resumeAfterBoundary = true;
      if (isBoundaryBridgePlaybackActive() && isBridgeBoundaryTransitionState()
        && routeTransition.bridgePausedAtMs != null) {
        routeTransition.bridgePausedDurationMs += Math.max(
          0,
          performance.now() - routeTransition.bridgePausedAtMs,
        );
        routeTransition.bridgePausedAtMs = null;
      }
      setPlaybackButtonLabels(true);
    }
    syncPlaybackControlStates();
    return;
  }
  if (playStepTimer || playbackAnim?.active) {
    stopPlayback();
    updateTimelineInfo(parseInt($('timeline').value, 10));
    return;
  }
  setPlaybackButtonLabels(true);
  syncPlaybackControlStates();
  schedulePlaybackStep();
}

function setupCanvasInteraction() {
  const canvas = $('canvas');
  let dragging = false;
  let lastX = 0; let lastY = 0;

  canvas.addEventListener('wheel', (e) => {
    if (geographicMap?.isActive?.()) return;
    e.preventDefault();
    if (isProgressiveViewportCandidateEnabled() && !e.ctrlKey) {
      const hint = $('progressiveViewportHint');
      if (hint) hint.textContent = 'Ctrl + wheel to zoom (ordinary wheel pan/zoom disabled)';
      return;
    }
    renderer.scale *= e.deltaY < 0 ? 1.1 : 0.9;
    renderer.draw();
  }, { passive: false });

  canvas.addEventListener('mousedown', (e) => {
    if (geographicMap?.isActive?.()) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('mousemove', (e) => {
    if (dragging) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      if (dx !== 0 || dy !== 0) disableProgressiveFollowArrowFromPan();
      renderer.offsetX += dx;
      renderer.offsetY += dy;
      lastX = e.clientX;
      lastY = e.clientY;
      renderer.draw();
    }
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const pt = renderer.findNearestPoint(mx, my);
    renderer.hoverPoint = pt;
    renderer.draw();
    const tl = parseInt($('timeline')?.value || '0', 10);
    const joinHover = renderer._joinCandidateHover?.(mx, my, tl);
    const hybridHover = renderer._hybridFittedHover?.(mx, my);
    if (hybridHover?.length) {
      $('hoverInfo').textContent = hybridHover.join('\n');
      return;
    }
    if (joinHover?.length) {
      $('hoverInfo').textContent = joinHover.join('\n');
      return;
    }
    if (pt) {
      const relHover = renderer._reliabilityHoverText?.(mx, my, tl);
      const bndHover = renderer._experimentalBoundaryHover?.(mx, my, tl);
      const lines = [
        `east: ${pt.east?.toFixed(2)} m`,
        `north: ${pt.north?.toFixed(2)} m`,
        `chunk: ${pt.chunkId ?? '—'}`,
        `pass: ${pt.passId ?? '—'}`,
        `track: ${pt.laneTrackId ?? '—'}`,
        `lane: ${pt.laneIndex ?? '—'}`,
        `frameId: ${pt.frameId ?? '—'}`,
      ];
      if (bndHover?.length) lines.push(...bndHover);
      else if (relHover?.length) lines.push(...relHover);
      $('hoverInfo').textContent = lines.join('\n');
    } else {
      $('hoverInfo').textContent = '—';
    }
  });
}

function isProgressiveCombinedCandidateEnabled() {
  const PCP = window.ProgressiveCombinedPlayback;
  return PCP?.isCandidateEnabled?.(window.location.search) === true;
}

function isProgressiveViewportCandidateEnabled() {
  const PVP = window.ProgressiveViewportCandidate;
  return PVP?.isCandidateEnabled?.(window.location.search, isProgressiveCombinedCandidateEnabled()) === true;
}

function syncProgressiveViewportRendererFlags() {
  if (!renderer) return;
  renderer.setProgressiveDrawLod?.(isProgressiveViewportCandidateEnabled());
}

function fitProgressiveVisibleRoute() {
  const PVP = window.ProgressiveViewportCandidate;
  const map = getActiveProgressiveDisplayMap();
  if (!PVP || !map || !renderer || !hasActiveProgressiveDisplaySnapshot()) return;
  const bounds = PVP.computeVisibleRouteBounds(map, progressiveCombinedState.visiblePrefix);
  if (bounds?.finite) {
    renderer._localViewportBounds = bounds;
    renderer.fitToView(bounds);
  }
}

function fitProgressiveActiveSegment() {
  const PVP = window.ProgressiveViewportCandidate;
  const map = getActiveProgressiveDisplayMap();
  const playbackData = getActiveProgressiveDisplayData();
  if (!PVP || !map || !renderer || !playbackData || !hasActiveProgressiveDisplaySnapshot()) return;
  const idx = parseInt($('timeline')?.value ?? '0', 10);
  const source = playbackData.timeline?.[idx]?.sourceFile ?? null;
  const resolved = PVP.resolveFitBounds(map, progressiveCombinedState.visiblePrefix, source);
  if (resolved.bounds?.finite) {
    renderer._localViewportBounds = resolved.bounds;
    renderer.fitToView(resolved.bounds);
  }
}

function applyFollowArrowIfNeeded() {
  if (!isProgressiveViewportCandidateEnabled() || !progressiveViewportFollowArrow
    || progressiveViewportFollowSuspended || !renderer?.playbackPose) return;
  const pose = renderer.playbackPose;
  if (geographicMap?.isActive?.()) {
    const diag = geographicMap.getDiagnostics?.();
    const ll = diag?.vehiclePosition;
    if (ll?.longitude != null && ll?.latitude != null) {
      geographicMap.followLngLat(ll.longitude, ll.latitude);
      return;
    }
  }
  renderer.centerOnWorldPoint(pose.east, pose.north);
  renderer.draw();
}

function disableProgressiveFollowArrowFromPan() {
  if (!isProgressiveViewportCandidateEnabled() || !progressiveViewportFollowArrow) return;
  progressiveViewportFollowArrow = false;
  progressiveViewportFollowSuspended = true;
  const cb = $('progressiveViewportFollowArrow');
  if (cb) cb.checked = false;
}

function initProgressiveViewportPlaybackUI() {
  const panel = $('progressiveViewportPlaybackPanel');
  const enabled = isProgressiveViewportCandidateEnabled();
  if (panel) panel.classList.toggle('hidden', !enabled);
  if (!enabled) return;
  const bindOnce = (id, handler) => {
    const el = $(id);
    if (el && !el.dataset.bound) {
      el.dataset.bound = '1';
      el.addEventListener('click', handler);
    }
  };
  bindOnce('btnProgressivePlay', () => togglePlayback());
  bindOnce('btnProgressivePrevFrame', () => stepTimelinePrev());
  bindOnce('btnProgressiveNextFrame', () => stepTimelineNext());
  syncPlaybackControlStates();
}

function initProgressiveViewportUI() {
  const panel = $('progressiveViewportPanel');
  const enabled = isProgressiveViewportCandidateEnabled();
  if (panel) panel.classList.toggle('hidden', !enabled);
  initProgressiveViewportPlaybackUI();
  syncProgressiveViewportRendererFlags();
  syncProgressiveViewportBodyClass();
  if (!enabled) return;
  const fitVisibleBtn = $('btnProgressiveFitVisibleRoute');
  if (fitVisibleBtn && !fitVisibleBtn.dataset.bound) {
    fitVisibleBtn.dataset.bound = '1';
    fitVisibleBtn.addEventListener('click', () => fitProgressiveVisibleRoute());
  }
  const fitActiveBtn = $('btnProgressiveFitActiveSegment');
  if (fitActiveBtn && !fitActiveBtn.dataset.bound) {
    fitActiveBtn.dataset.bound = '1';
    fitActiveBtn.addEventListener('click', () => fitProgressiveActiveSegment());
  }
  const followCb = $('progressiveViewportFollowArrow');
  if (followCb && !followCb.dataset.bound) {
    followCb.dataset.bound = '1';
    followCb.addEventListener('change', () => {
      progressiveViewportFollowArrow = followCb.checked;
      progressiveViewportFollowSuspended = false;
      if (progressiveViewportFollowArrow) applyFollowArrowIfNeeded();
    });
  }
}

function initProgressiveCombinedPlaybackUI() {
  const panel = $('progressiveCombinedPanel');
  const enabled = isProgressiveCombinedCandidateEnabled();
  if (panel) panel.classList.toggle('hidden', !enabled);
  if (!enabled) return;
  updateProgressiveCombinedStatusLabel();
  initProgressiveViewportUI();
}

function updateProgressiveCombinedStatusLabel() {
  const PCP = window.ProgressiveCombinedPlayback;
  const el = $('progressiveCombinedStatus');
  if (!el || !PCP) return;
  const prefix = getEffectiveProgressivePrefix();
  const following = PCP.resolveNextAvailableSegment(progressiveCombinedState.availableSegments, prefix);
  const terminal = !following && !progressiveCombinedState.hiddenLookahead;
  el.textContent = PCP.formatAppendStatusLabel(prefix, {
    hiddenLookahead: progressiveCombinedState.hiddenLookahead,
    terminal,
  });
  for (const id of ['btnProgressiveAppend', 'btnProgressiveAppendContinue']) {
    const b = $(id);
    if (b) b.disabled = terminal;
  }
}

function storeProgressiveStateSnapshot() {
  const PCP = window.ProgressiveCombinedPlayback;
  if (!PCP?.isCandidateEnabled(window.location.search)) return;
  const key = PCP.prefixSnapshotKey(progressiveCombinedState.visiblePrefix);
  progressiveCombinedState.stateSnapshots.set(key, {
    visiblePrefix: [...progressiveCombinedState.visiblePrefix],
    processPrefix: [...progressiveCombinedState.processPrefix],
    hiddenLookahead: progressiveCombinedState.hiddenLookahead,
    fullMap: PCP.snapshotFrozenMap(progressiveCombinedState.fullMap),
    displayMap: PCP.snapshotFrozenMap(progressiveCombinedState.displayMap),
    fullProcessData: progressiveCombinedState.fullProcessData,
    displayProcessData: progressiveCombinedState.displayProcessData,
    prefix: [...progressiveCombinedState.prefix],
    timelineIndex: parseInt($('timeline')?.value ?? '0', 10),
  });
}

function applyProgressiveRendererPlaybackData() {
  applyRendererPlaybackData();
}

function applyProgressiveTimelineFilter(visiblePrefix, { timelineIndex = undefined } = {}) {
  const PCP = window.ProgressiveCombinedPlayback;
  const full = progressiveCombinedState.fullProcessData || processData;
  progressiveCombinedState.displayProcessData = PCP.filterProcessDataToVisibleSources(full, visiblePrefix);
  const tl = $('timeline');
  const timeline = progressiveCombinedState.displayProcessData?.timeline;
  if (!tl || !timeline?.length) return;
  tl.disabled = false;
  tl.min = 0;
  tl.max = Math.max(0, timeline.length - 1);
  const resolvedIndex = timelineIndex != null
    ? PCP.clampTimelineIndex(timeline, timelineIndex)
    : PCP.initialVisibleTimelineIndex(timeline, visiblePrefix);
  tl.value = resolvedIndex;
  syncPlaybackControlStates(resolvedIndex);
}

function resolveProgressivePlaybackTimelineIndex({
  displayTimeline,
  priorTimeline = null,
  priorIndex = 0,
  continuePlayback = false,
  revealedSource = null,
} = {}) {
  const PCP = window.ProgressiveCombinedPlayback;
  if (!displayTimeline?.length || !PCP) return 0;
  if (continuePlayback && revealedSource) {
    return PCP.findFirstTimelineIndexForSource(displayTimeline, revealedSource);
  }
  if (priorTimeline?.length) {
    return PCP.mapPreservedTimelineIndex(displayTimeline, priorTimeline, priorIndex);
  }
  return PCP.initialVisibleTimelineIndex(displayTimeline, progressiveCombinedState.visiblePrefix);
}

async function applyProgressiveDisplayFromFullMap(fullMap, visiblePrefix) {
  const PCP = window.ProgressiveCombinedPlayback;
  const SLM = window.SegmentLocalMap;
  if (!PCP || !SLM || !renderer || !visiblePrefix?.length || !fullMap) return;
  const lookaheadState = PCP.buildInitialLookaheadDisplay(
    fullMap,
    progressiveCombinedState.fullProcessData || processData,
    visiblePrefix,
    progressiveCombinedState.hiddenLookahead,
  );
  if (lookaheadState.hiddenLeaks?.length) {
    throw new Error(`Hidden geometry leaked into visible display: ${lookaheadState.hiddenLeaks.map((l) => l.layer).join(', ')}`);
  }
  progressiveCombinedState.fullMap = lookaheadState.fullMap;
  progressiveCombinedState.displayMap = SLM.freezeStationaryMapGeometry
    ? SLM.freezeStationaryMapGeometry(lookaheadState.displayMap)
    : lookaheadState.displayMap;
  progressiveCombinedState.displayProcessData = lookaheadState.displayProcessData;
  applyProgressiveTimelineFilter(visiblePrefix, {
    timelineIndex: PCP.initialVisibleTimelineIndex(
      progressiveCombinedState.displayProcessData.timeline,
      visiblePrefix,
    ),
  });
  applyActiveProgressiveDisplaySnapshot();
  syncProgressiveViewportRendererFlags();
}

async function bootstrapProgressiveDisplay(visiblePrefix) {
  const displayMode = getDisplayMode();
  $('vehicleRelBanner').classList.toggle('hidden', displayMode !== 'vehicle');
  $('localPlaybackBanner').classList.toggle('hidden', displayMode !== 'local');
  $('modeLabel').textContent = displayMode === 'local'
    ? 'Local playback — stationary segment map with moving arrow'
    : `Global map — ${processData.stats.routeChunkCount} route chunks`;
  if (displayMode === 'local') {
    initLocalGeometryModeSelect();
    updatePointOnlyControlVisibility(getLocalGeometryMode());
    initPointCausalToggle();
    initPointReliabilityTint();
    initExperimentalBoundariesMode();
    initMirrorRoadLateralDisplay();
    updatePointDisplayModeLabel();
  }
  const fullMap = await getOrBuildStationaryMapAsync(0, { forceRebuild: true, preferFullMap: true });
  await applyProgressiveDisplayFromFullMap(fullMap, visiblePrefix);
  const timelineIndex = parseInt($('timeline')?.value ?? '0', 10);
  renderer.setFrameIndex(timelineIndex);
  await updateLocalPlayback(timelineIndex, { preserveViewport: false, forceRefit: true, forceMapRebuild: false });
  updateInfoPanel(processData.stats);
  updateFileAuditTable(processData);
  updateFrameCountPanel(processData);
  updateChunkTable(processData.chunkDiagnostics, processData.stats);
  updatePassTable(processData.chunkDiagnostics, processData.geometryDebug);
  updateTrackDiagnostics(processData);
  updateTimelineInfo(timelineIndex);
  storeProgressiveStateSnapshot();
  updateProgressiveCombinedStatusLabel();
  renderer.draw();
}

async function fetchProcessDataForSegments(segments, { bustCache = false, label = 'progressive lookahead prepare' } = {}) {
  const res = await fetch('/api/process', {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
    body: JSON.stringify({
      segments,
      options: getOptions(),
      bustCache,
      label,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Process failed');
  return data;
}

async function prepareHiddenLookaheadSource(hiddenSource) {
  const PCP = window.ProgressiveCombinedPlayback;
  const SLM = window.SegmentLocalMap;
  const visible = progressiveCombinedState.visiblePrefix;
  const processList = [...visible, hiddenSource];
  const data = await fetchProcessDataForSegments(processList);
  const freshBase = SLM.buildSegmentLocalMap(data, {
    geometrySource: normalizeLocalGeometrySelection($('localGeometryMode')?.value),
    timelineIndex: 0,
    fitEnabled: localPlaybackOptions().fitEnabled,
  });
  const currentState = {
    visiblePrefix: progressiveCombinedState.visiblePrefix,
    hiddenLookahead: progressiveCombinedState.hiddenLookahead,
    fullMap: progressiveCombinedState.fullMap,
    displayMap: progressiveCombinedState.displayMap,
    fullProcessData: progressiveCombinedState.fullProcessData,
    displayProcessData: progressiveCombinedState.displayProcessData,
  };
  const prepared = PCP.prepareNextHiddenLookahead(
    currentState,
    hiddenSource,
    freshBase,
    data,
    { mirrorChecked: renderer?.getMirrorRoadLateralDisplay?.() ?? true },
  );
  if (!prepared.ok) {
    throw new Error(prepared.reason || 'lookaheadPrepareFailed');
  }
  if (prepared.hiddenLeaks?.length) {
    throw new Error(`Hidden geometry leaked into visible display: ${prepared.hiddenLeaks.map((l) => l.layer).join(', ')}`);
  }
  progressiveCombinedState.fullMap = prepared.fullMap;
  progressiveCombinedState.fullProcessData = prepared.fullProcessData;
  progressiveCombinedState.processPrefix = prepared.processPrefix;
  progressiveCombinedState.hiddenLookahead = prepared.hiddenLookahead;
  storeProgressiveStateSnapshot();
  updateProgressiveCombinedStatusLabel();
}

async function progressiveRevealPrepared({ continuePlayback = false } = {}) {
  const PCP = window.ProgressiveCombinedPlayback;
  const SLM = window.SegmentLocalMap;
  const prepared = progressiveCombinedState.hiddenLookahead;
  if (!prepared) {
    setStatus('No next segment available');
    return;
  }
  const viewCapture = captureProgressiveViewCapture();
  const priorTimeline = getPlaybackTimeline();
  const priorIndex = parseInt($('timeline')?.value ?? '0', 10);
  stopPlayback();
  const reveal = PCP.revealPreparedLookahead({
    visiblePrefix: progressiveCombinedState.visiblePrefix,
    hiddenLookahead: prepared,
    fullMap: progressiveCombinedState.fullMap,
    fullProcessData: progressiveCombinedState.fullProcessData,
    displayMap: progressiveCombinedState.displayMap,
    displayProcessData: progressiveCombinedState.displayProcessData,
  }, { continuePlayback });
  if (!reveal.ok) {
    throw new Error(reveal.reason || 'revealFailed');
  }
  progressiveCombinedState.visiblePrefix = reveal.visiblePrefix;
  progressiveCombinedState.prefix = reveal.visiblePrefix;
  progressiveCombinedState.hiddenLookahead = null;
  progressiveCombinedState.displayMap = SLM.freezeStationaryMapGeometry
    ? SLM.freezeStationaryMapGeometry(reveal.displayMap)
    : reveal.displayMap;
  progressiveCombinedState.displayProcessData = reveal.displayProcessData;
  const timelineIndex = resolveProgressivePlaybackTimelineIndex({
    displayTimeline: reveal.displayProcessData.timeline,
    priorTimeline,
    priorIndex,
    continuePlayback,
    revealedSource: prepared,
  });
  applyProgressiveTimelineFilter(reveal.visiblePrefix, { timelineIndex });
  applyActiveProgressiveDisplaySnapshot();
  connectedAccumulatedCache = null;
  syncProgressiveViewportRendererFlags();
  lastLocalPlaybackState = {
    timelineIndex,
    geometryMode: normalizeLocalGeometrySelection($('localGeometryMode')?.value),
    scale: viewCapture.scale,
    offsetX: viewCapture.offsetX,
    offsetY: viewCapture.offsetY,
    localViewportBounds: viewCapture.localViewportBounds,
  };
  renderer.setFrameIndex(timelineIndex);
  await updateLocalPlayback(timelineIndex, { preserveViewport: true, forceRefit: false });
  updateTimelineInfo(timelineIndex);
  await refreshLocalPlaybackVideo({ resetTimeline: continuePlayback });
  if (continuePlayback) schedulePlaybackStep();
  // Required stage (reveal + commit) has completed. Resolve the next available
  // source and attempt the OPTIONAL later-lookahead preparation. A failure of
  // the optional stage must NOT roll back the source that was just committed.
  const following = PCP.resolveNextAvailableSegment(
    progressiveCombinedState.availableSegments,
    reveal.visiblePrefix,
  );
  let lookaheadFailed = null;
  let lookaheadPreparedOk = null;
  if (following) {
    try {
      await prepareHiddenLookaheadSource(following);
      lookaheadPreparedOk = true;
    } catch (lookaheadErr) {
      lookaheadPreparedOk = false;
      lookaheadFailed = following;
      progressiveCombinedState.hiddenLookahead = null;
      console.error('[progressive lookahead]', lookaheadErr);
    }
  }
  const decision = PCP.resolveAppendTransaction({
    revealOk: true,
    followingSource: following,
    lookaheadPreparedOk,
  });
  storeProgressiveStateSnapshot();
  updateProgressiveCombinedStatusLabel();
  setStatus(PCP.formatAppendStatusLabel(reveal.visiblePrefix, {
    hiddenLookahead: progressiveCombinedState.hiddenLookahead,
    terminal: decision.terminal,
    failedSource: lookaheadFailed,
  }));
}

function getEffectiveProgressivePrefix() {
  const PCP = window.ProgressiveCombinedPlayback;
  if (!PCP) return [];
  if (progressiveCombinedState.visiblePrefix.length) {
    return PCP.orderPrefixFiles(progressiveCombinedState.visiblePrefix, progressiveCombinedState.availableSegments);
  }
  if (progressiveCombinedState.prefix.length) {
    return PCP.orderPrefixFiles(progressiveCombinedState.prefix, progressiveCombinedState.availableSegments);
  }
  const selected = selectedSegments();
  if (selected.length) {
    return PCP.orderPrefixFiles(selected, progressiveCombinedState.availableSegments);
  }
  if (lastProcessedSegmentSelection.length) {
    return PCP.orderPrefixFiles(lastProcessedSegmentSelection, progressiveCombinedState.availableSegments);
  }
  return [];
}

function syncSegmentSelectToPrefix(prefix) {
  const sel = $('segmentSelect');
  if (!sel) return;
  const set = new Set(prefix);
  for (const opt of sel.options) {
    opt.selected = set.has(opt.value);
  }
}

function captureProgressiveViewCapture() {
  return {
    scale: renderer?.scale,
    offsetX: renderer?.offsetX,
    offsetY: renderer?.offsetY,
    localViewportBounds: renderer?.getLocalViewportBounds?.() ?? null,
  };
}

async function restoreProgressiveStateSnapshot(snapshotKey) {
  const PCP = window.ProgressiveCombinedPlayback;
  const SLM = window.SegmentLocalMap;
  const snap = progressiveCombinedState.stateSnapshots.get(snapshotKey);
  if (!snap) throw new Error('Missing progressive snapshot');
  progressiveCombinedState.visiblePrefix = [...snap.visiblePrefix];
  progressiveCombinedState.prefix = [...snap.prefix];
  progressiveCombinedState.processPrefix = [...snap.processPrefix];
  progressiveCombinedState.hiddenLookahead = snap.hiddenLookahead;
  progressiveCombinedState.fullMap = snap.fullMap;
  progressiveCombinedState.displayMap = SLM.freezeStationaryMapGeometry
    ? SLM.freezeStationaryMapGeometry(snap.displayMap)
    : snap.displayMap;
  progressiveCombinedState.fullProcessData = snap.fullProcessData;
  progressiveCombinedState.displayProcessData = snap.displayProcessData;
  syncSegmentSelectToPrefix(snap.visiblePrefix);
  applyProgressiveTimelineFilter(snap.visiblePrefix, {
    timelineIndex: snap.timelineIndex ?? 0,
  });
  applyActiveProgressiveDisplaySnapshot();
  syncProgressiveViewportRendererFlags();
  const timelineIndex = parseInt($('timeline')?.value ?? '0', 10);
  renderer.setFrameIndex(timelineIndex);
  await updateLocalPlayback(timelineIndex, { preserveViewport: true, forceRefit: false });
  updateTimelineInfo(timelineIndex);
  await refreshLocalPlaybackVideo({ resetTimeline: false });
  updateProgressiveCombinedStatusLabel();
}

async function progressiveAppendNext({ continuePlayback = false } = {}) {
  const PCP = window.ProgressiveCombinedPlayback;
  if (!PCP?.isCandidateEnabled(window.location.search)) return;

  const visible = getEffectiveProgressivePrefix();
  if (!visible.length) {
    setStatus('Select at least one segment and click Process selected first');
    return;
  }
  if (!progressiveCombinedState.fullMap) {
    setStatus('Process the current prefix before appending the next segment');
    return;
  }
  if (!progressiveCombinedState.hiddenLookahead) {
    // Retry path: a previous later-lookahead preparation may have failed while
    // the visible prefix stayed committed. Re-attempt preparation of the next
    // available source before reporting no-next.
    const following = PCP.resolveNextAvailableSegment(
      progressiveCombinedState.availableSegments,
      visible,
    );
    if (!following) {
      setStatus('End of available segments');
      updateProgressiveCombinedStatusLabel();
      return;
    }
    try {
      await prepareHiddenLookaheadSource(following);
    } catch (retryErr) {
      console.error('[progressive lookahead]', retryErr);
      setStatus(`Next ${PCP.segmentDisplayLabel(following)} preparation failed: ${retryErr.message}. Retry Append next segment.`);
      return;
    }
  }

  const rollbackKey = PCP.prefixSnapshotKey(visible);
  try {
    await progressiveRevealPrepared({ continuePlayback });
  } catch (err) {
    console.error('[progressive]', err);
    setStatus(`Progressive reveal failed: ${err.message}. Restoring previous prefix.`);
    try {
      await restoreProgressiveStateSnapshot(rollbackKey);
    } catch (rollbackErr) {
      console.error('[progressive rollback]', rollbackErr);
      setStatus(`Rollback failed: ${rollbackErr.message}`);
    }
  }
}

async function progressiveRemoveLast() {
  const PCP = window.ProgressiveCombinedPlayback;
  if (!PCP?.isCandidateEnabled(window.location.search)) return;

  const visible = getEffectiveProgressivePrefix();
  if (!PCP.canRemoveLastSegment(visible)) {
    setStatus('Cannot remove the initial source from the progressive prefix');
    return;
  }
  const newVisible = visible.slice(0, -1);
  const snapshotKey = PCP.prefixSnapshotKey(newVisible);
  try {
    await restoreProgressiveStateSnapshot(snapshotKey);
    setStatus(PCP.formatProgressiveStatusLabel(newVisible, progressiveCombinedState.hiddenLookahead));
  } catch (err) {
    setStatus(`Remove last failed: ${err.message}`);
  }
}

function bindEvents() {
  $('btnProcess').onclick = () => process(selectedSegments(), { label: 'process selected' });
  $('btnProcessAll').onclick = () => process(null, { label: 'process all' });
  $('btnReprocess').onclick = () => reprocessSelected();
  if (isProgressiveCombinedCandidateEnabled()) {
    $('btnProgressiveAppend')?.addEventListener('click', () => { void progressiveAppendNext({ continuePlayback: false }); });
    $('btnProgressiveAppendContinue')?.addEventListener('click', () => { void progressiveAppendNext({ continuePlayback: true }); });
    $('btnProgressiveRemoveLast')?.addEventListener('click', () => { void progressiveRemoveLast(); });
  }
  $('btnReset').onclick = () => {
    renderer.resetView();
    if (isLocalPlaybackMode()) renderer.fitToLocalView();
  };
  $('btnFit').onclick = () => {
    if (isLocalPlaybackMode()) renderer.fitToLocalView();
    else renderer.fitToView();
  };
  $('btnFitRouteReview')?.addEventListener('click', () => {
    if (isLocalPlaybackMode()) renderer.fitToLocalView();
  });
  $('vizMode').onchange = () => {
    persistVizMode($('vizMode').value);
    applyVisualization();
  };
  $('localGeometryMode')?.addEventListener('change', () => {
    persistLocalGeometryMode(normalizeLocalGeometrySelection($('localGeometryMode')?.value));
    switchLocalGeometryLayer();
  });

  const obsDebugFrame = $('obsDebugFrame');
  const obsDebugLane = $('obsDebugLane');
  if (obsDebugFrame && obsDebugLane) {
    $('btnObsDebugShow').onclick = () => {
      const frameIndex = parseInt(obsDebugFrame.value, 10);
      const laneIndex = parseInt(obsDebugLane.value, 10);
      renderer.setObsDebugSelection({
        frameIndex: Number.isFinite(frameIndex) ? frameIndex : 0,
        laneIndex: Number.isFinite(laneIndex) ? laneIndex : null,
      });
    };
    $('btnObsDebugClear').onclick = () => {
      renderer.setObsDebugSelection(null);
    };
  }

  $('btnPlay').onclick = () => togglePlayback();
  $('playSpeed').onchange = () => {
    playSpeed = parseFloat($('playSpeed').value);
    if (playStepTimer || playbackAnim?.active) {
      stopPlayback();
      togglePlayback();
    }
  };

  document.querySelectorAll('.panel input[type=checkbox]').forEach((el) => {
    el.onchange = () => {
      if (getActiveProgressiveDisplayData()) {
        applyRendererPlaybackData();
        if (hasActiveProgressiveDisplaySnapshot()) {
          renderer.stationaryLocalMap = progressiveCombinedState.displayMap;
        }
        const displayMode = getDisplayMode();
        if (displayMode === 'vehicle' || displayMode === 'local') {
          updateMovementIndicator(parseInt($('timeline').value, 10));
        }
      }
    };
  });

  $('segmentSelect').onchange = () => {
    updatePendingSegmentSelectionStatus();
    updateReviewCompactStatus();
  };

  $('timeline').oninput = (e) => {
    const wasBoundaryLoading = isRouteBoundaryLoading();
    if (playStepTimer || playbackAnim?.active) stopPlayback();
    if (wasBoundaryLoading) {
      cancelRouteBoundaryTransition();
    }
    updateTimelineInfo(parseInt(e.target.value, 10));
  };
  $('btnPrevFrame').onclick = () => stepTimelinePrev();
  $('btnNextFrame').onclick = () => stepTimelineNext();

  $('btnPng').onclick = () => renderer.exportPng();
  $('btnCsv').onclick = () => { window.open('/api/export/csv', '_blank'); };
  $('btnGeoJson').onclick = () => { window.open('/api/export/geojson', '_blank'); };
  initConnectedAccumulatedControls();
  initEvidenceLayerToggles();

  document.addEventListener('keydown', (e) => {
    if (!isProgressiveViewportCandidateEnabled()) return;
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
    if (e.key === 'Home' && e.shiftKey) {
      e.preventDefault();
      fitProgressiveVisibleRoute();
    } else if (e.key === 'Home') {
      e.preventDefault();
      fitProgressiveActiveSegment();
    }
  });
}

function renderStage19Summary(data) {
  $('stage19Version').textContent = data.stage19ProcessingVersion || '—';
  $('stage19Status').textContent = data.available ? (data.stage19Status || '—') : 'not generated';
  const el = $('stage19Panel');
  if (!data.available) {
    el.innerHTML = `<p>${data.note || 'Stage 19 audit not available'}${data.malformed ? ' (malformed audit JSON)' : ''}</p>`;
    return;
  }
  const conflictLine = data.genuineCrossPassCandidateCount === 0
    ? `${data.crossPassConflictCount} (0 candidates — unavailable evidence, not agreement)`
    : String(data.crossPassConflictCount);
  const promotionLine = data.promotionDecisionSummary
    || (data.promotionDecisions?.hold != null ? `hold × ${data.promotionDecisions.hold}` : '—');
  const rows = [
    ['Checkpoint', data.implementationCheckpoint],
    ['Preservation v0', data.checkpointPreservation?.v0 ? `${data.checkpointPreservation.v0.preservation} (not approved)` : '—'],
    ['Preservation v1', data.checkpointPreservation?.v1 ? `${data.checkpointPreservation.v1.preservation} (not approved)` : '—'],
    ['Preservation v2', data.checkpointPreservation?.v2 ? `${data.checkpointPreservation.v2.preservation} (not approved)` : '—'],
    ['Preservation v3', data.checkpointPreservation?.v3 ? `${data.checkpointPreservation.v3.preservation} (not approved)` : '—'],
    ['Run ID', data.runId],
    ['Current pointer', data.currentRunId],
    ['Observations', data.observationCount],
    ['Genuine cross-pass candidates', data.genuineCrossPassCandidateCount],
    ['Measured conflicts', conflictLine],
    ['Insufficient evidence', data.insufficientEvidenceIntervalCount ?? data.intervalDecisions?.insufficient_evidence ?? '—'],
    ['Promotion decisions', promotionLine],
    ['Singleton chains', data.singletonChainCount],
    ['Non-trivial partitions', data.nonTrivialPartitionCount],
    ['P3 eligible / executed / selected', data.p3Stats ? `${data.p3Stats.eligible} / ${data.p3Stats.executed} / ${data.p3Stats.selected}` : '—'],
    ['Partition failures', data.partitionFailureCount],
    ['Intervals assessed', data.acceptedIntervalCount],
    ['Interval decisions', JSON.stringify(data.intervalDecisions || data.assessmentStatusCounts || {})],
    ['BEV PNG images', data.bevImageCount],
    ['BEV validation', data.bevValidationOk ? 'PASS' : 'FAIL/MISSING'],
    ['Sensitivity rows', data.sensitivitySummary?.rowCount ?? '—'],
    ['Sensitivity limitation', data.sensitivitySummary?.empiricalLimitation ? 'limited empirical variation on this dataset' : '—'],
    ['Normative bindings', data.normativeVerificationOk ? 'PASS' : 'FAIL'],
    ['Schema validation', data.schemaValidationOk ? 'PASS' : 'FAIL'],
    ['Semantic validation', data.semanticValidationOk ? 'PASS' : 'FAIL'],
    ['Production quality gates', data.productionQualityGatesOk ? 'PASS' : 'FAIL'],
    ['Publication state', data.publicationState],
    ['Production lane counting', data.productionLaneCountImplemented ? 'enabled' : 'disabled'],
    ['HD-map complete', data.hdMapSystemComplete ? 'claimed' : 'no'],
  ];
  el.innerHTML = rows.map(([k, v]) => `<div><strong>${k}:</strong> ${v ?? '—'}</div>`).join('');
}

async function loadStage19Summary() {
  try {
    const res = await fetch('/api/stage19/summary');
    renderStage19Summary(await res.json());
  } catch (e) {
    $('stage19Panel').innerHTML = `<p>Failed to load Stage 19 summary: ${e.message}</p>`;
  }
}

async function init() {
  const initParams = new URLSearchParams(window.location.search);
  if (initParams.has('boundaryBridgePlaybackCandidate')) {
    window.__boundaryBridgePlaybackCandidate = initParams.get('boundaryBridgePlaybackCandidate') === '1';
  }
  initUiModeControls();
  renderer = new RoadRenderer($('canvas'));
  window.renderer = renderer;
  await initGeographicMap();
  initMapDebugLayerIsolation();
  initMapBackgroundControls();
  window.updateLocalPlayback = updateLocalPlayback;
  window.switchLocalGeometryLayer = switchLocalGeometryLayer;
  window.__mapAcquisitionDebug = {
    get generation() { return mapAcquisitionGeneration; },
    captureMapAcquisitionContext,
    readMapAcquisitionContext,
    mapContextsCompatible,
    get inFlightCount() { return inFlightMapBuilds.size; },
    clearStationaryMapCache,
  };
  initVizModeSelect();
  initLocalGeometryModeSelect();
  updatePointOnlyControlVisibility(getLocalGeometryMode());
  const panelEl = $('localVideoPanel');
  if (panelEl && window.LocalPlaybackVideoPanel) {
    localPlaybackVideo = new window.LocalPlaybackVideoPanel(panelEl);
    localPlaybackVideo.setVisible(false);
  }
  setupCanvasInteraction();
  bindEvents();
  initProgressiveCombinedPlaybackUI();
  await loadSegments();
  await loadStage19Summary();
  syncProgressiveViewportBodyClass();
  applyUiMode(uiMode);
  setStatus('Ready — select a segment and click Load segment');
}

window.getPlaybackVideoDebugState = () => {
  const provenance = resolveActivePlaybackProvenance();
  const videoDiag = localPlaybackVideo?.getDiagnostics?.() ?? null;
  const globalStart = getPlaybackProcessData()?.timeline?.[0]?.logMonoTime ?? null;
  const logMono = getCurrentPlaybackLogMonoTime();
  const timing = window.SegmentVideoTiming;
  const globalPlaybackTimeS = timing?.computeLocalElapsedSeconds(logMono, globalStart);
  const expectedVideoTimeS = provenance && localPlaybackVideo
    ? timing?.computeExpectedVideoTime(provenance.sourceLocalTimeS, localPlaybackVideo.videoStartOffsetSeconds)
    : null;
  const videoLocalTimeS = videoDiag?.videoLocalTimeS ?? null;
  const timelineEntries = window.MultisegmentVideoTimeline?.buildSegmentVideoTimeline(
    getPlaybackProcessData()?.timeline ?? [],
    getPlaybackSegmentSelection(),
  ) ?? [];
  return {
    selectedSegments: [...lastProcessedSegmentSelection],
    timelineIndex: getActiveTimelineIndex(),
    arrowSegmentId: provenance?.sourceSegmentId ?? null,
    videoSegmentId: videoDiag?.activeVideoSegmentId ?? null,
    globalPlaybackTimeS,
    videoLocalTimeS,
    expectedVideoTimeS,
    syncErrorS: (videoLocalTimeS != null && expectedVideoTimeS != null)
      ? videoLocalTimeS - expectedVideoTimeS
      : null,
    sourceSwitchCount: videoDiag?.sourceSwitchCount ?? 0,
    staleSwitchIgnoredCount: videoDiag?.staleSwitchIgnoredCount ?? 0,
    provenance,
    timelineEntries,
    segmentLabel: document.querySelector('[data-video-segment]')?.textContent ?? null,
    boundary: getSingleVideoBoundaryDiagnostics(),
    videoReadyState: videoDiag?.videoReadyState ?? null,
    videoNetworkState: videoDiag?.videoNetworkState ?? null,
  };
};

window.getSingleVideoBoundaryDiagnostics = getSingleVideoBoundaryDiagnostics;

function getBoundaryBridgePlaybackDiagnostics() {
  const videoDiag = localPlaybackVideo?.getDiagnostics?.() ?? {};
  return {
    bridgePlaybackActive: isBoundaryBridgePlaybackActive(),
    diagnosticOverride: window.__boundaryBridgePlaybackCandidate ?? null,
    state: routeTransition.state,
    fromSourceFile: routeTransition.bridgeFromSourceFile,
    toSourceFile: routeTransition.bridgeToSourceFile,
    bridgeAccepted: routeTransition.bridgeMetadata?.supportStatus === 'accepted',
    bridgeProgress: routeTransition.bridgeProgress,
    bridgeDurationS: routeTransition.bridgeDurationS,
    bridgeLengthM: routeTransition.bridgeLengthM,
    arrowDistanceTravelledM: routeTransition.bridgeDistanceTravelledM,
    nextVideoReady: routeTransition.nextVideoReady,
    arrowHeldAtBridgeEnd: routeTransition.arrowHeldAtBridgeEnd,
    transitionToken: routeTransition.boundarySwitchToken,
    sourceAssignmentCount: videoDiag.sourceSwitchCount ?? 0,
    staleCallbacksIgnored: routeTransition.staleCallbackCount + (videoDiag.staleSwitchIgnoredCount ?? 0),
    lastError: routeTransition.bridgeLastError,
    transitionLabel: routeTransition.bridgeTransitionLabel,
    bridgePausedDurationMs: routeTransition.bridgePausedDurationMs,
  };
}

window.getBoundaryBridgePlaybackDiagnostics = getBoundaryBridgePlaybackDiagnostics;

init();
