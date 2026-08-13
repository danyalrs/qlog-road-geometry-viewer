/** Main application controller. */

let processData = null;
let renderer = null;
let playStepTimer = null;
let playRafId = null;
let playbackAnim = null;
let playSpeed = 1;
let localPlaybackVideo = null;
let stationaryMapCache = new Map();
let stationaryMapBuildCount = 0;
let lastLocalPlaybackState = null;

const $ = (id) => document.getElementById(id);

function localGeometryUI() {
  return window.LocalGeometryUI || {
    LOCAL_GEOMETRY_DEFAULT_MODE: 'fused',
    LOCAL_GEOMETRY_STORAGE_KEY: 'qlogLocalGeometryMode',
    normalizeLocalGeometrySelection: (v) => (v === 'observations' || v === 'fused' || v === 'pointAccumulated' ? v : 'fused'),
  };
}

function normalizeLocalGeometrySelection(value) {
  return localGeometryUI().normalizeLocalGeometrySelection(value);
}

function persistLocalGeometryMode(mode) {
  try {
    localStorage.setItem(localGeometryUI().LOCAL_GEOMETRY_STORAGE_KEY, mode);
  } catch (_) { /* ignore quota / private mode */ }
}

function initLocalGeometryModeSelect() {
  const sel = $('localGeometryMode');
  if (!sel) return localGeometryUI().LOCAL_GEOMETRY_DEFAULT_MODE;
  let stored = null;
  try {
    stored = localStorage.getItem(localGeometryUI().LOCAL_GEOMETRY_STORAGE_KEY);
  } catch (_) { /* ignore */ }
  const mode = normalizeLocalGeometrySelection(stored ?? sel.value);
  sel.value = mode;
  persistLocalGeometryMode(mode);
  return mode;
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
  return { minHeadingSpeedMps: parseFloat($('minBearingSpeed')?.value ?? 2) };
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
  return v === 'fused' ? 'fused' : 'observations';
}

function stationaryMapCacheKey(chunkId, passId, geometrySource) {
  return `${chunkId}:${passId}:${geometrySource}`;
}

function clearStationaryMapCache() {
  stationaryMapCache.clear();
  stationaryMapBuildCount = 0;
}

function getOrBuildStationaryMap(timelineIndex, { forceRebuild = false } = {}) {
  const SLM = window.SegmentLocalMap;
  if (!SLM || !processData) return null;
  const mode = getLocalGeometryMode();
  if (mode === 'diagnostic') return null;

  const { chunkId, passId } = SLM.resolveActiveChunkPass(processData, timelineIndex);
  const key = stationaryMapCacheKey(chunkId, passId, mode);
  if (!forceRebuild && stationaryMapCache.has(key)) {
    const cached = stationaryMapCache.get(key);
    cached.cacheState = 'hit';
    return cached;
  }

  const map = SLM.buildSegmentLocalMap(processData, {
    geometrySource: mode,
    chunkId,
    passId,
    timelineIndex,
    ...localPlaybackOptions(),
  });
  const frozenMap = SLM.freezeStationaryMapGeometry(map);
  stationaryMapBuildCount += 1;
  frozenMap.cacheKey = key;
  frozenMap.cacheState = 'built';
  frozenMap.buildCount = stationaryMapBuildCount;
  stationaryMapCache.set(key, frozenMap);
  return frozenMap;
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

function setStatus(msg) { $('status').textContent = msg; }

function updateGeometryDiagnosticsPanel() {
  const GD = window.GeometryDiagnostics;
  const map = renderer?.stationaryLocalMap;
  const diag = GD?.buildLaneDiagnostics
    ? GD.buildLaneDiagnostics(processData, map, { geometrySource: getLocalGeometryMode() })
    : null;
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
  lastLocalPlaybackState = null;
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
  $('procVersion').textContent = data.processingVersion || '—';
  updateInfoPanel({
    qlogFiles: data.segments.length,
    modelEvents: data.modelEventCount,
    gpsEvents: data.gpsEventCount,
  });
}

function selectedSegments() {
  return Array.from($('segmentSelect').selectedOptions).map((o) => o.value);
}

async function process(segments, { bustCache = false, label = 'process' } = {}) {
  clearProcessState();
  setStatus('Processing…');
  const body = {
    segments,
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
  $('procVersion').textContent = data.processingVersion || '—';
  $('procTime').textContent = data.processedAt || '—';

  logGeometryDebug(data, label);
  applyVisualization();
  updateGeometryDiagnosticsPanel();
  const fc = data.stats?.frameCounts;
  const frameLabel = fc
    ? `${fc.rawModelV2Messages} raw modelV2 → ${fc.gpsAlignedFrames} GPS-aligned`
    : `${data.stats.validModelFrames} frames`;
  setStatus(`Done — ${data.stats.routeChunkCount} chunks, ${frameLabel}, cacheHit=${data.cacheHit}, ${data.geometryDebug?.polygonCount ?? 0} polygons`);
  await refreshLocalPlaybackVideo({ resetTimeline: true });
  return data;
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

function getTimelineStartLogMonoTime() {
  return processData?.timeline?.[0]?.logMonoTime ?? null;
}

function getActiveVideoSegmentId() {
  if (!processData?.timeline?.length) return null;
  const idx = parseInt($('timeline')?.value ?? '0', 10);
  const sourceFile = processData.frames?.[idx]?.sourceFile
    || processData.timeline[idx]?.sourceFile
    || processData.timeline[0]?.sourceFile;
  if (!sourceFile) return null;
  const match = String(sourceFile).match(/^qlog_f449c_(\d+)\.bz2$/i);
  return match ? match[1] : null;
}

function getCurrentPlaybackLogMonoTime() {
  if (playbackAnim?.active) {
    const elapsed = performance.now() - playbackAnim.startWallMs;
    const alpha = Math.min(1, elapsed / playbackAnim.durationMs);
    return interpolatedLogMonoTime(playbackAnim.fromIdx, playbackAnim.toIdx, alpha);
  }
  const idx = parseInt($('timeline')?.value ?? '0', 10);
  return processData?.timeline?.[idx]?.logMonoTime ?? null;
}

function updateLocalVideoVisibility() {
  if (!localPlaybackVideo) return;
  const visible = isLocalPlaybackMode() && !!processData;
  localPlaybackVideo.setVisible(visible);
  if (!visible) localPlaybackVideo.pause();
}

async function refreshLocalPlaybackVideo({ resetTimeline = false } = {}) {
  if (!localPlaybackVideo) return;
  updateLocalVideoVisibility();
  if (!isLocalPlaybackMode() || !processData) {
    localPlaybackVideo.unload();
    return;
  }

  const segmentId = getActiveVideoSegmentId();
  const timelineStart = getTimelineStartLogMonoTime();
  localPlaybackVideo.setTimelineStart(timelineStart);
  await localPlaybackVideo.onSegmentProcessed(segmentId, timelineStart);
  if (resetTimeline) {
    localPlaybackVideo.onTimelineScrub(getCurrentPlaybackLogMonoTime());
  }
}

function resolveLocalPlaybackPose(idx, extraOptions = {}) {
  const LP = window.LocalPlayback;
  const SLM = window.SegmentLocalMap;
  if (!LP || !processData) return null;

  const mode = getLocalGeometryMode();
  if (mode === 'diagnostic') {
    let pose = LP.resolveArrowForCurrentFrame({
      frames: processData.frames,
      timeline: processData.timeline,
      vehiclePath: processData.vehiclePath,
      frameIndex: idx,
      options: { ...localPlaybackOptions(), ...extraOptions },
    });
    const flags = localPlaybackUrlFlags();
    if (flags.laneRelativeArrow) {
      const frame = processData.frames?.[idx];
      pose = LP.applyLaneRelativeArrowOffset(pose, frame);
    }
    return pose;
  }

  const map = renderer?.stationaryLocalMap;
  if (!map?.valid) {
    return {
      east: 0, north: 0, headingDeg: 0, frozen: false, pathIndex: 0,
      headingSource: 'none', timelineIndex: idx,
    };
  }
  return SLM.resolveArrowOnSegmentMap(
    map,
    processData.timeline,
    idx,
    { ...localPlaybackOptions(), ...extraOptions },
  );
}

function resolveLocalGeometryDisplay(idx) {
  const LP = window.LocalPlayback;
  if (!LP || !processData) return null;
  return LP.resolveLocalGeometryFrame(
    processData.frames,
    processData.timeline,
    idx,
    renderer?._lastValidLocalGeometry ?? null,
  );
}

function getLocalPlaybackContext(frameIndex) {
  const LP = window.LocalPlayback;
  if (!LP || !processData) return null;
  const idx = Number.isInteger(frameIndex) ? frameIndex : parseInt($('timeline')?.value ?? '0', 10);
  const frame = processData.frames?.[idx];
  return LP.buildPlaybackContextForFrame({
    frame,
    timeline: processData.timeline,
    vehiclePath: processData.vehiclePath,
    options: localPlaybackOptions(),
  });
}

function interpolatedLogMonoTime(fromIdx, toIdx, alpha) {
  const from = processData?.timeline?.[fromIdx];
  const to = processData?.timeline?.[toIdx];
  if (!from?.logMonoTime) return null;
  const t0 = BigInt(String(from.logMonoTime));
  if (!to?.logMonoTime || alpha <= 0) return String(t0);
  if (alpha >= 1) return String(to.logMonoTime);
  const t1 = BigInt(String(to.logMonoTime));
  return String(t0 + BigInt(Math.round(Number(t1 - t0) * alpha)));
}

function updateLocalPlayback(idx, { forceRefit = false, forceMapRebuild = false, preserveViewport = false } = {}) {
  const LP = window.LocalPlayback;
  if (!LP || !processData || !renderer) return;
  const flags = localPlaybackUrlFlags();
  const mode = getLocalGeometryMode();
  renderer.setLocalElapsedIdx(idx);
  renderer.setLocalGeometryMode(mode);
  renderer.setLaneRelativeArrow(flags.laneRelativeArrow);

  const prevKey = renderer.stationaryLocalMap?.cacheKey;
  const map = getOrBuildStationaryMap(idx, { forceRebuild: forceMapRebuild });
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
}

function switchLocalGeometryLayer() {
  if (!isLocalPlaybackMode() || !processData || !renderer) return;
  const mode = getLocalGeometryMode();
  persistLocalGeometryMode(mode);
  updatePointOnlyControlVisibility(mode);
  const idx = parseInt($('timeline').value, 10);
  updateLocalPlayback(idx, { preserveViewport: true });
  renderer.draw();
}

function updatePointOnlyControlVisibility(mode) {
  const isPoint = mode === 'pointAccumulated';
  document.querySelectorAll('.local-point-only-control').forEach((el) => {
    el.classList.toggle('visible', isPoint);
  });
  const obsDebugOn = (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('obsDebug') === '1');
  const obsControls = document.querySelector('.obs-debug-control');
  if (obsControls) obsControls.classList.toggle('visible', obsDebugOn);
}

function updatePointDisplayModeLabel() {
  const label = $('pointDisplayModeLabel');
  if (!label) return;
  const causal = renderer?.getPointCausalPlayback?.() === true;
  label.textContent = causal ? 'Causal playback' : 'Complete map';
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
  if (!processData) return;
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
  tl.max = Math.max(0, (processData.timeline?.length || 1) - 1);

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

  renderer.setData(processData, getEffectiveLayers(displayMode), displayMode);
  renderer.setFrameIndex(timelineIdx);
  if (displayMode === 'local') {
    updateLocalPlayback(timelineIdx, {
      forceRefit: !preserveViewport,
      forceMapRebuild: false,
      preserveViewport,
    });
  } else {
    renderer.setPlaybackPose(null);
    renderer.fitToView();
  }
  updateInfoPanel(processData.stats);
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
  if (!VMD || !processData || displayMode === 'global') {
    renderer.setMovementDisplay(null);
    return;
  }

  const t = processData.timeline?.[idx];
  const frame = processData.frames?.[idx];
  const vehiclePathPoint = VMD.findVehiclePathPoint(processData.vehiclePath, t?.logMonoTime);
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
  const t = processData?.timeline?.[idx];
  const dl = $('timelineInfo');
  if (!t) { dl.innerHTML = ''; renderer.setMovementDisplay(null); return; }
  const frame = processData?.frames?.[idx];
  const trackIds = (frame?.lanes || []).map((l) => l.laneTrackId).filter((x) => x != null);
  const vehiclePathPoint = window.VehicleMovementDisplay?.findVehiclePathPoint(
    processData?.vehiclePath,
    t?.logMonoTime,
  );
  const movementState = t.movementState ?? vehiclePathPoint?.movementState ?? '—';
  const speedKmh = Number.isFinite(t.speed) ? (t.speed * 3.6).toFixed(1) : '—';
  const fields = [
    ['Elapsed idx', idx],
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
    localPlaybackVideo?.onTimelineScrub(getCurrentPlaybackLogMonoTime());
  } else {
    renderer.draw();
  }
  updateMovementIndicator(idx);
}

function logMonoDeltaMs(timeline, fromIdx, toIdx, speed) {
  if (!timeline?.[fromIdx]?.logMonoTime || !timeline?.[toIdx]?.logMonoTime) return 800 / speed;
  const t0 = BigInt(String(timeline[fromIdx].logMonoTime));
  const t1 = BigInt(String(timeline[toIdx].logMonoTime));
  const deltaNs = t1 > t0 ? t1 - t0 : 0n;
  return Math.max(1, Number(deltaNs) / 1e6 / speed);
}

function tickPlaybackAnimation() {
  if (!playbackAnim?.active || !renderer) return;
  const elapsed = performance.now() - playbackAnim.startWallMs;
  const alpha = Math.min(1, elapsed / playbackAnim.durationMs);
  const LP = window.LocalPlayback;
  const pose = LP?.lerpPose(playbackAnim.fromPose, playbackAnim.toPose, alpha);
  if (pose) {
    if (getLocalGeometryMode() === 'diagnostic' && playbackAnim.context) {
      const timeStr = interpolatedLogMonoTime(playbackAnim.fromIdx, playbackAnim.toIdx, alpha);
      if (timeStr) {
        const currentIdx = alpha >= 1 ? playbackAnim.toIdx : playbackAnim.fromIdx;
        const currentFrame = processData.frames?.[currentIdx];
        const poseHeading = currentFrame?.pose?.headingDeg
          ?? processData.timeline[currentIdx]?.bearingDeg;
        if (Number.isFinite(poseHeading)) {
          pose.headingDeg = poseHeading;
          pose.headingSource = currentFrame?.pose?.headingSource ?? 'framePose';
        } else {
          const headingPose = LP.resolveArrowAtLogMonoTime(
            playbackAnim.context,
            timeStr,
            processData.timeline[playbackAnim.fromIdx],
            {
              ...localPlaybackOptions(),
              vehiclePath: processData.vehiclePath,
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
    localPlaybackVideo?.tickSync(getCurrentPlaybackLogMonoTime());
  }
  playRafId = requestAnimationFrame(tickPlaybackAnimation);
}

function schedulePlaybackStep() {
  if (!processData?.timeline?.length) {
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
  const durationMs = logMonoDeltaMs(processData.timeline, idx, nextIdx, playSpeed);

  if (isLocalPlaybackMode()) {
    const VMD = window.VehicleMovementDisplay;
    const t = processData.timeline[idx];
    const vehiclePathPoint = VMD?.findVehiclePathPoint(processData.vehiclePath, t?.logMonoTime);
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
        framePose: processData.frames?.[idx]?.pose,
      }),
      startWallMs: performance.now(),
      durationMs,
    };
    if (!playRafId) playRafId = requestAnimationFrame(tickPlaybackAnimation);
    localPlaybackVideo?.playFromLogMonoTime(getCurrentPlaybackLogMonoTime());
  }

  playStepTimer = setTimeout(() => {
    playbackAnim = null;
    tl.value = nextIdx;
    updateTimelineInfo(nextIdx);
    schedulePlaybackStep();
  }, durationMs);
}

function stopPlayback() {
  if (playStepTimer) {
    clearTimeout(playStepTimer);
    playStepTimer = null;
  }
  if (playRafId) {
    cancelAnimationFrame(playRafId);
    playRafId = null;
  }
  playbackAnim = null;
  localPlaybackVideo?.onMasterPaused(getCurrentPlaybackLogMonoTime());
  $('btnPlay').textContent = '▶ Play';
  playSpeed = parseFloat($('playSpeed')?.value ?? 1);
}

function togglePlayback() {
  if (playStepTimer || playbackAnim?.active) {
    stopPlayback();
    updateTimelineInfo(parseInt($('timeline').value, 10));
    return;
  }
  $('btnPlay').textContent = '⏸ Pause';
  schedulePlaybackStep();
}

function setupCanvasInteraction() {
  const canvas = $('canvas');
  let dragging = false;
  let lastX = 0; let lastY = 0;

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    renderer.scale *= e.deltaY < 0 ? 1.1 : 0.9;
    renderer.draw();
  }, { passive: false });

  canvas.addEventListener('mousedown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('mousemove', (e) => {
    if (dragging) {
      renderer.offsetX += e.clientX - lastX;
      renderer.offsetY += e.clientY - lastY;
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

function bindEvents() {
  $('btnProcess').onclick = () => process(selectedSegments(), { label: 'process selected' });
  $('btnProcessAll').onclick = () => process(null, { label: 'process all' });
  $('btnReprocess').onclick = () => reprocessSelected();
  $('btnReset').onclick = () => {
    renderer.resetView();
    if (isLocalPlaybackMode()) renderer.fitToLocalView();
  };
  $('btnFit').onclick = () => {
    if (isLocalPlaybackMode()) renderer.fitToLocalView();
    else renderer.fitToView();
  };
  $('vizMode').onchange = () => applyVisualization();
  $('localGeometryMode')?.addEventListener('change', () => {
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
      if (processData) {
        const displayMode = getDisplayMode();
        renderer.setData(processData, getEffectiveLayers(displayMode), displayMode);
        if (displayMode === 'vehicle' || displayMode === 'local') {
          updateMovementIndicator(parseInt($('timeline').value, 10));
        }
      }
    };
  });

  $('segmentSelect').onchange = () => {
    if (processData) clearProcessState();
    setStatus('Segment selection changed — click Process or Reprocess');
  };

  $('timeline').oninput = (e) => {
    if (playStepTimer || playbackAnim?.active) stopPlayback();
    updateTimelineInfo(parseInt(e.target.value, 10));
  };
  $('btnPrevFrame').onclick = () => {
    const tl = $('timeline');
    tl.value = Math.max(0, parseInt(tl.value, 10) - 1);
    updateTimelineInfo(parseInt(tl.value, 10));
  };
  $('btnNextFrame').onclick = () => {
    const tl = $('timeline');
    tl.value = Math.min(parseInt(tl.max, 10), parseInt(tl.value, 10) + 1);
    updateTimelineInfo(parseInt(tl.value, 10));
  };

  $('btnPng').onclick = () => renderer.exportPng();
  $('btnCsv').onclick = () => { window.open('/api/export/csv', '_blank'); };
  $('btnGeoJson').onclick = () => { window.open('/api/export/geojson', '_blank'); };
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
  renderer = new RoadRenderer($('canvas'));
  window.renderer = renderer;
  window.updateLocalPlayback = updateLocalPlayback;
  window.switchLocalGeometryLayer = switchLocalGeometryLayer;
  initLocalGeometryModeSelect();
  const panelEl = $('localVideoPanel');
  if (panelEl && window.LocalPlaybackVideoPanel) {
    localPlaybackVideo = new window.LocalPlaybackVideoPanel(panelEl);
    localPlaybackVideo.setVisible(false);
  }
  setupCanvasInteraction();
  bindEvents();
  await loadSegments();
  await loadStage19Summary();
  setStatus('Select segments and click Process or Reprocess');
}

init();
