/** Canvas renderer — draws each route chunk and polygon fragment independently. */

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

const LANE_COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0891b2', '#4f46e5'];
const CHUNK_COLORS = [
  '#e11d48', '#2563eb', '#16a34a', '#ca8a04', '#7c3aed', '#0891b2',
  '#ea580c', '#db2777', '#4f46e5', '#65a30d', '#0d9488', '#c026d3',
];
const PASS_COLORS = ['#3b82f688', '#f59e0b88', '#10b98188', '#ec489988', '#8b5cf688', '#06b6d488'];
const PHYSICAL_BOUNDARY_COLORS = {
  PB0: '#2563eb',
  PB1: '#16a34a',
  PB2: '#7c3aed',
  PB3: '#ca8a04',
};
const TRACK_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#ca8a04', '#7c3aed', '#0891b2',
  '#ea580c', '#db2777', '#4f46e5', '#65a30d', '#0d9488', '#c026d3',
];

/**
 * Display-only representative-method selection from the URL query.
 * Absent or unrecognised `representativeMethod` resolves to the accepted
 * default `purityRevisit`; explicit overrides are preserved. This only chooses
 * which builder runs — no source data is mutated and the purityRevisit
 * thresholds/algorithm are untouched.
 */
function resolveRepresentativeMethod(search) {
  const s = String(search || '');
  if (/(?:^|[?&])representativeMethod=legacy(?=&|$)/.test(s)) return 'legacy';
  if (/(?:^|[?&])representativeMethod=purityRevisit(?=&|$)/.test(s)) return 'purityRevisit';
  if (/(?:^|[?&])representativeMethod=purity(?=&|$)/.test(s)) return 'purity';
  if (/(?:^|[?&])representativeMethod=curveAssociation(?=&|$)/.test(s)) return 'curveAssociation';
  return 'purityRevisit';
}

class RoadRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.data = null;
    this.layers = {};
    this.frameIndex = 0;
    this.hoverPoint = null;
    this.displayMode = 'global';
    this.playbackPose = null;
    this.localAnchorFrameIndex = 0;
    this.localElapsedIdx = 0;
    this.localGeometryMode = 'pointAccumulated';
    this.localGeometryDisplay = null;
    this.stationaryLocalMap = null;
    this.geometryDiagnostics = null;
    this._localViewportBounds = null;
    this._localMapBuildCount = 0;
    this._localMapCacheState = 'empty';
    this._lastValidLocalGeometry = null;
    this.movementAnchor = null;
    this.movementDisplay = null;
    this._pulseRaf = null;
    this._pulsePhase = 0;
    const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    this._localArrowDebug = urlParams?.get('arrowDebug') === '1';
    this._laneTransformDebug = urlParams?.get('laneTransformDebug') === '1';
    this._outlierDebug = urlParams?.get('outlierDebug') === '1';
    this._polygonDebug = urlParams?.get('polygonDebug') === '1';
    this._fusionBinDebug = urlParams?.get('fusionBinDebug') === '1';
    this._laneRelativeArrow = urlParams?.get('laneRelativeArrow') === '1';
    this._obsDebug = urlParams?.get('obsDebug') === '1';
    this._lateralAxisDebug = urlParams?.get('lateralDebug') === '1';
    this._segment1LaneOrderDebug = urlParams?.get('debugSegment1LaneOrder') === '1';
    this._segment1LaneOrderExpectedMap = null;
    // Corrected lane orientation is the DEFAULT viewer orientation. The
    // precomputed vehicle-relative lateral mirror is on unless explicitly
    // disabled via ?mirrorRoadLateral=0. ?mirrorRoadLateral=1 keeps it on.
    this._mirrorRoadLateralDisplay = (urlParams?.get('mirrorRoadLateral') ?? '1') !== '0';
    this._mirrorDebug = urlParams?.get('mirrorDebug') === '1';
    this._layerAttributionEnabled = urlParams?.get('debugLayerAttribution') === '1'
      || urlParams?.get('debugLanePixelOwner') === '1';
    this._lanePixelOwnerEnabled = urlParams?.get('debugLanePixelOwner') === '1';
    this._lanePixelOwnerTrace = [];
    this._lanePixelOwnerPerturb = null;
    this._visibleLaneProjectionPass = null;
    // Promoted default: the combined visible-lane projection is enabled unless
    // explicitly disabled with combinedVisibleLaneProjectionCandidate=0.
    this._visibleLaneProjectionEnabled = urlParams?.get('combinedVisibleLaneProjectionCandidate') !== '0';
    this._visibleLaneProjectionFromCacheHit = false;
    this._pointAccumulatedLanePolylineEnabled = urlParams?.get('pointAccumulatedLanePolylineCandidate') === '1';
    this._pointAccumulatedLanePolylineDiagnostics = null;
    this._layerAttributionSolo = urlParams?.get('debugLayerSolo') || null;
    this._layerAttributionDisable = new Set(
      (urlParams?.get('debugLayerDisable') || '').split(',').map((s) => s.trim()).filter(Boolean),
    );
    this._layerAttributionPasses = [];
    this._layerAttributionDrawOrder = [];
    this._exactDisplayCorrectionActive = false;
    this._sourceQlogSha256 = null;
    this._displayCorrectionDiagnostics = null;
    this._obsDebugFrame = urlParams?.get('obsFrame') != null ? parseInt(urlParams.get('obsFrame'), 10) : null;
    this._obsDebugLane = urlParams?.get('obsLane') != null ? parseInt(urlParams.get('obsLane'), 10) : null;
    this._lastLocalArrowTangent = null;
    this._roadSurfaceDrawStats = null;
this._pointCurveOverlay = urlParams?.get('pointCurveOverlay') === '1';
this._pointCausalPlayback = urlParams?.get('pointCausalPlayback') === '1';
this._pointReliabilityTint = urlParams?.get('reliabilityTint') === '1';
    this._experimentalBoundariesMode = (urlParams?.get('expBoundaries') || 'off');
    this._constructedFragmentLabels = urlParams?.get('cfLabels') === '1';
    this._pointTrackColorCache = null;
    this._connectedAccumulatedPolylines = null;
    this._connectedAccumulatedStats = null;
    this._connectedAccumulatedMode = 'currentFrame';
    this._connectedAccumulatedDrawn = false;
    this._representativeLaneLines = null;
    this._representativeLaneLinesDiagnostics = null;
    this.localRoadSurfacePathRadiusM = 15;
    this.localRoadSurfaceRibbonFallbackHalfWidthM = 7.5;
    this.localRoadSurfaceRibbonMinHalfWidthM = 3;
    this.localRoadSurfaceRibbonMaxHalfWidthM = 15;
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
    this.draw();
  }

  setData(data, layers, displayMode = 'global') {
    this.data = data;
    this.layers = layers;
    this.displayMode = displayMode;
    this._obsTimeline = data?.timeline || null;
    this._lastLocalArrowTangent = null;
    this._pointTrackColorCache = null;
    if (!data) {
      this.setConnectedAccumulatedPolylines(null, null);
    }
    if (displayMode !== 'vehicle' && displayMode !== 'local') {
      this.setMovementDisplay(null);
      this.playbackPose = null;
    }
    this.draw();
  }

  setPlaybackPose(pose) {
    this.playbackPose = pose;
    if (this.displayMode === 'local') this.draw();
  }

  setLocalAnchorFrameIndex(index) {
    this.localAnchorFrameIndex = index;
  }

  setLocalElapsedIdx(index) {
    this.localElapsedIdx = index;
  }

  setLocalGeometryMode(mode) {
    const SLM = window.SegmentLocalMap;
    if (SLM?.normalizeGeometrySource) {
      this.localGeometryMode = SLM.normalizeGeometrySource(mode);
    } else if (mode === 'fused') {
      this.localGeometryMode = 'fused';
    } else if (mode === 'pointAccumulated') {
      this.localGeometryMode = 'pointAccumulated';
    } else if (mode === 'diagnostic') {
      this.localGeometryMode = 'diagnostic';
    } else {
      this.localGeometryMode = mode || 'pointAccumulated';
    }
  }

  setGeometryDiagnostics(diag) {
    this.geometryDiagnostics = diag;
  }

  setStationaryLocalMap(map, meta = {}) {
    this.stationaryLocalMap = map;
    if (meta.buildCount != null) this._localMapBuildCount = meta.buildCount;
    if (meta.cacheState) this._localMapCacheState = meta.cacheState;
    this._visibleLaneProjectionFromCacheHit = !!(
      meta.cacheState
      && String(meta.cacheState).includes('hit')
    );
    this._pointTrackColorCache = null;
    this._connectedAccumulatedPolylines = null;
    this._connectedAccumulatedStats = null;
    this._connectedAccumulatedMode = 'currentFrame';
    this._connectedAccumulatedDrawn = false;
    this._representativeLaneLines = null;
    this._representativeLaneLinesDiagnostics = null;
    this._refreshDisplayCorrectionState();
  }

  _refreshDisplayCorrectionState() {
    const VDC = typeof window !== 'undefined' ? window.ViewerDisplayCorrections : null;
    const map = this.stationaryLocalMap;
    const sha = map?.sourceQlogSha256 ?? null;
    this._sourceQlogSha256 = sha;
    this._exactDisplayCorrectionActive = !!(VDC?.isExactDisplayCorrectionActive?.(
      this._mirrorRoadLateralDisplay,
      sha,
    ));
    this._displayCorrectionDiagnostics = VDC?.getDiagnostics?.(
      this._mirrorRoadLateralDisplay,
      sha,
    ) ?? null;
  }

  _useExactDisplayCorrection() {
    const map = this.stationaryLocalMap;
    if (map?.suppressMapWideDisplayCorrection || map?.boundaryAnchoredOrientationActive) {
      return false;
    }
    return !!this._exactDisplayCorrectionActive;
  }

  _usesCombinedPlacedFrame(point = null) {
    const map = this.stationaryLocalMap;
    if (!map?.boundaryAnchoredOrientationActive) return false;
    if (point?.coordinateFrame === 'combinedPlaced') return true;
    return map.combinedCoordinateFrame === 'combinedPlaced';
  }

  _buildCombinedPlacedArrowContext(arrowPose) {
    if (!this._usesCombinedPlacedFrame() || !arrowPose) return null;
    const map = this.stationaryLocalMap;
    if (!map) return null;
    const traj = map.trajectory || [];
    let tp = null;
    if (Number.isFinite(arrowPose.pathIndex)) {
      const idx = Math.min(Math.max(0, Math.round(arrowPose.pathIndex)), Math.max(0, traj.length - 1));
      tp = traj[idx];
    } else if (Number.isFinite(arrowPose.timelineIndex)) {
      const idx = Math.min(Math.max(0, arrowPose.timelineIndex), Math.max(0, traj.length - 1));
      tp = traj[idx];
    }
    const coordinateFrame = tp?.coordinateFrame === 'combinedPlaced'
      ? 'combinedPlaced'
      : (map.combinedCoordinateFrame === 'combinedPlaced' ? 'combinedPlaced' : null);
    if (coordinateFrame !== 'combinedPlaced') return null;
    return {
      coordinateFrame: 'combinedPlaced',
      placedEast: arrowPose.east,
      placedNorth: arrowPose.north,
      east: arrowPose.east,
      north: arrowPose.north,
      sourceFile: tp?.sourceFile ?? null,
      sourceQlogSha256: tp?.sourceQlogSha256
        ?? (tp?.sourceFile ? map.sourceSha256ByFile?.[tp.sourceFile] : null)
        ?? null,
    };
  }

  _projectArrowPathPointToScreen(pathPoint) {
    const east = pathPoint?.east ?? 0;
    const north = pathPoint?.north ?? 0;
    if (this._usesCombinedPlacedFrame(pathPoint) && pathPoint?.coordinateFrame === 'combinedPlaced') {
      return this._segmentDisplayToScreen(
        Number.isFinite(pathPoint.placedEast) ? pathPoint.placedEast : east,
        Number.isFinite(pathPoint.placedNorth) ? pathPoint.placedNorth : north,
        pathPoint,
      );
    }
    return this._segmentDisplayToScreen(east, north);
  }

  /**
   * Shared stationary-map display contract: one world→canvas frame for road,
   * lanes, trajectory and arrow. Exact display correction (SHA manifest) applies
   * the same lateral reflection to every layer from canonical coordinates —
   * never road/lanes via mirror-select while trajectory/arrow via VDC alone.
   */
  _applyExactDisplayCorrectionWorld(east, north) {
    const VDC = typeof window !== 'undefined' ? window.ViewerDisplayCorrections : null;
    if (VDC?.transformDisplayPoint) return VDC.transformDisplayPoint(east, north);
    return { east, north: -north };
  }

  _projectRoadGeometryToScreen(east, north, mirroredEast = null, mirroredNorth = null, point = null) {
    if (this._usesCombinedPlacedFrame(point)) {
      const CVLP = typeof window !== 'undefined' ? window.CombinedVisibleLaneProjection : null;
      const pass = this._visibleLaneProjectionPass;
      if (
        this._visibleLaneProjectionEnabled
        && CVLP?.projectCombinedSourceLanePoint
        && pass
        && this._mirrorRoadLateralDisplay
      ) {
        const projected = CVLP.projectCombinedSourceLanePoint(point, this.stationaryLocalMap, pass, {
          mirrorChecked: this._mirrorRoadLateralDisplay,
          search: typeof window !== 'undefined' ? window.location.search : '',
          useVisibleLaneProjection: true,
          fromCacheHit: this._visibleLaneProjectionFromCacheHit,
          fragmentHint: this._visibleLaneProjectionFragmentHint || null,
        });
        if (projected && Number.isFinite(projected.east) && Number.isFinite(projected.north)) {
          if (projected.corrected) {
            CVLP.markCandidateActiveOnMap?.(this.stationaryLocalMap);
          }
          return this.worldToScreen(projected.east, projected.north);
        }
      }
      const e = Number.isFinite(point?.placedEast) ? point.placedEast : east;
      const n = Number.isFinite(point?.placedNorth) ? point.placedNorth : north;
      return this.worldToScreen(e, n);
    }
    // Hash-keyed exact correction: same transform as _segmentDisplayToScreen.
    // Ignore precomputed mirrors here so road ribbon vertices (no mirror fields)
    // and lane dots share one reflected frame with the dashed trajectory.
    if (this._useExactDisplayCorrection()) {
      const t = this._applyExactDisplayCorrectionWorld(east, north);
      return this.worldToScreen(t.east, t.north);
    }
    const VMC = typeof window !== 'undefined' ? window.ViewerMirrorCoords : null;
    if (VMC?.resolveRoadDisplayCoords) {
      const resolved = VMC.resolveRoadDisplayCoords(
        east,
        north,
        mirroredEast,
        mirroredNorth,
        this._mirrorRoadLateralDisplay,
        {
          trajectory: this.stationaryLocalMap?.trajectory,
          referencePose: this.stationaryLocalMap?.referencePose,
          useTrajectoryFallback: false,
        },
      );
      return this.worldToScreen(resolved.east, resolved.north);
    }
    if (!this._mirrorRoadLateralDisplay) {
      return this.worldToScreen(east, north);
    }
    const me = mirroredEast != null ? mirroredEast : east;
    const mn = mirroredNorth != null ? mirroredNorth : north;
    return this.worldToScreen(me, mn);
  }

  _segmentDisplayToScreen(east, north, point = null) {
    if (
      this._usesCombinedPlacedFrame(point)
      && point?.coordinateFrame === 'combinedPlaced'
    ) {
      const e = Number.isFinite(point.placedEast) ? point.placedEast : east;
      const n = Number.isFinite(point.placedNorth) ? point.placedNorth : north;
      return this.worldToScreen(e, n);
    }
    // Combined placed trajectory points often omit coordinateFrame on the
    // overlay call site (east/north only). Still use the shared placed frame.
    if (this._usesCombinedPlacedFrame() && this.stationaryLocalMap?.combinedCoordinateFrame === 'combinedPlaced') {
      return this.worldToScreen(east, north);
    }
    if (this._useExactDisplayCorrection()) {
      const t = this._applyExactDisplayCorrectionWorld(east, north);
      return this.worldToScreen(t.east, t.north);
    }
    return this.worldToScreen(east, north);
  }

  _mirrorAwareMapBounds(bounds) {
    if (!bounds || !this._useExactDisplayCorrection()) return bounds;
    const VDC = typeof window !== 'undefined' ? window.ViewerDisplayCorrections : null;
    return VDC?.mirrorAwareBounds ? VDC.mirrorAwareBounds(bounds) : bounds;
  }

  getDisplayCorrectionDiagnostics() {
    return this._displayCorrectionDiagnostics;
  }

  _layerAttributionShouldDraw(layerId) {
    if (!this._layerAttributionEnabled) return true;
    if (this._layerAttributionDisable.has(layerId)) return false;
    if (this._layerAttributionSolo) return this._layerAttributionSolo === layerId;
    return true;
  }

  _layerAttributionBeginPass(layerId, meta = {}) {
    if (!this._layerAttributionEnabled) return null;
    const w = this.canvas.width;
    const h = this.canvas.height;
    return {
      layerId,
      meta,
      order: this._layerAttributionPasses.length + 1,
      before: this.ctx.getImageData(0, 0, w, h),
      width: w,
      height: h,
    };
  }

  _layerAttributionEndPass(state) {
    if (!state) return;
    const CLA = typeof window !== 'undefined' ? window.CanvasLayerAttribution : null;
    if (!CLA?.diffImageDataSized) return;
    const after = this.ctx.getImageData(0, 0, state.width, state.height);
    const diff = CLA.diffImageDataSized(state.before.data, after.data, state.width, state.height);
    let passPngDataUrl = null;
    if (diff.changedPixelCount > 0 && CLA.maskToRgba) {
      const passCanvas = document.createElement('canvas');
      passCanvas.width = state.width;
      passCanvas.height = state.height;
      const pctx = passCanvas.getContext('2d');
      const rgba = CLA.maskToRgba(diff.changedMask, after.data, state.width, state.height);
      pctx.putImageData(new ImageData(rgba, state.width, state.height), 0, 0);
      passPngDataUrl = passCanvas.toDataURL('image/png');
    }
    const entry = {
      drawOrderIndex: state.order,
      layerId: state.layerId,
      drawFunction: state.meta.drawFunction ?? null,
      owningFile: state.meta.owningFile ?? 'public/render.js',
      rendererStateField: state.meta.rendererStateField ?? null,
      uiControl: state.meta.uiControl ?? null,
      enabled: state.meta.enabled ?? null,
      geometryCollection: state.meta.geometryCollection ?? null,
      geometryObjectCount: state.meta.geometryObjectCount ?? 0,
      pointCount: state.meta.pointCount ?? 0,
      sourceProvenanceCoveragePct: state.meta.sourceProvenanceCoveragePct ?? 0,
      coordinateFramePopulation: state.meta.coordinateFramePopulation ?? {},
      strokeColours: state.meta.strokeColours ?? [],
      fillColours: state.meta.fillColours ?? [],
      lineWidth: state.meta.lineWidth ?? null,
      alpha: state.meta.alpha ?? null,
      dashState: state.meta.dashState ?? null,
      changedPixelCount: diff.changedPixelCount,
      pixelBoundingBox: diff.bbox,
      dominantColours: diff.dominantColours,
      passPngDataUrl,
    };
    this._layerAttributionPasses.push(entry);
    this._layerAttributionDrawOrder.push({
      drawOrderIndex: entry.drawOrderIndex,
      layerId: entry.layerId,
      drawFunction: entry.drawFunction,
      geometryCollection: entry.geometryCollection,
      changedPixelCount: entry.changedPixelCount,
    });
  }

  _attrPass(layerId, meta, fn) {
    if (!this._layerAttributionShouldDraw(layerId)) return;
    const state = this._layerAttributionBeginPass(layerId, meta);
    fn();
    this._layerAttributionEndPass(state);
  }

  getLayerAttributionExport() {
    return {
      enabled: this._layerAttributionEnabled,
      solo: this._layerAttributionSolo,
      disabled: [...this._layerAttributionDisable],
      passes: this._layerAttributionPasses.map((p) => {
        const { passPngDataUrl, ...rest } = p;
        return rest;
      }),
      drawOrder: this._layerAttributionDrawOrder,
    };
  }

  getCombinedVisibleLaneProjectionDiagnostics() {
    const CVLP = typeof window !== 'undefined' ? window.CombinedVisibleLaneProjection : null;
    return CVLP?.getBrowserDiagnostics?.(this.stationaryLocalMap) ?? null;
  }

  setVisibleLaneProjectionEnabled(on) {
    this._visibleLaneProjectionEnabled = !!on;
  }

  setPointAccumulatedLanePolylineEnabled(on) {
    this._pointAccumulatedLanePolylineEnabled = !!on;
  }

  getPointAccumulatedLanePolylineDiagnostics() {
    return this._pointAccumulatedLanePolylineDiagnostics ?? null;
  }

  /**
   * Resolve display-world coordinates for a PA point using the same contract
   * as the visible lane dots (including combinedVisibleLaneProjectionCandidate).
   */
  _resolvePointAccumulatedDisplayWorld(pt) {
    const map = this.stationaryLocalMap;
    const CVLP = typeof window !== 'undefined' ? window.CombinedVisibleLaneProjection : null;
    if (
      this._visibleLaneProjectionEnabled
      && CVLP?.projectCombinedSourceLanePoint
      && this._mirrorRoadLateralDisplay
      && map?.boundaryAnchoredOrientationActive
    ) {
      const projected = CVLP.projectCombinedSourceLanePoint(pt, map, 'pointAccumulated', {
        mirrorChecked: this._mirrorRoadLateralDisplay,
        search: typeof window !== 'undefined' ? window.location.search : '',
        useVisibleLaneProjection: true,
        fromCacheHit: this._visibleLaneProjectionFromCacheHit,
      });
      if (projected && Number.isFinite(projected.east) && Number.isFinite(projected.north)) {
        return { east: projected.east, north: projected.north, corrected: !!projected.corrected };
      }
    }
    if (this._usesCombinedPlacedFrame(pt)) {
      const e = Number.isFinite(pt?.placedEast) ? pt.placedEast : pt.localEast;
      const n = Number.isFinite(pt?.placedNorth) ? pt.placedNorth : pt.localNorth;
      return { east: e, north: n, corrected: false };
    }
    if (this._useExactDisplayCorrection()) {
      const t = this._applyExactDisplayCorrectionWorld(pt.localEast, pt.localNorth);
      return { east: t.east, north: t.north, corrected: true };
    }
    const VMC = typeof window !== 'undefined' ? window.ViewerMirrorCoords : null;
    if (VMC?.resolveRoadDisplayCoords) {
      const resolved = VMC.resolveRoadDisplayCoords(
        pt.localEast,
        pt.localNorth,
        pt.mirroredLocalEast,
        pt.mirroredLocalNorth,
        this._mirrorRoadLateralDisplay,
        {
          trajectory: map?.trajectory,
          referencePose: map?.referencePose,
          useTrajectoryFallback: false,
        },
      );
      return { east: resolved.east, north: resolved.north, corrected: false };
    }
    if (this._mirrorRoadLateralDisplay && Number.isFinite(pt.mirroredLocalEast) && Number.isFinite(pt.mirroredLocalNorth)) {
      return { east: pt.mirroredLocalEast, north: pt.mirroredLocalNorth, corrected: false };
    }
    return { east: pt.localEast, north: pt.localNorth, corrected: false };
  }

  _drawPointAccumulatedLanePolylines(map, pts) {
    const PALP = typeof window !== 'undefined' ? window.PointAccumulatedLanePolylines : null;
    if (!PALP?.buildPointAccumulatedLanePolylines) {
      this._pointAccumulatedLanePolylineDiagnostics = { candidateActive: false, error: 'moduleMissing' };
      return;
    }
    this._visibleLaneProjectionPass = 'pointAccumulated';
    const displayPoints = [];
    for (const pt of pts || []) {
      if (!Number.isFinite(pt.localEast) || !Number.isFinite(pt.localNorth)) continue;
      const world = this._resolvePointAccumulatedDisplayWorld(pt);
      if (!Number.isFinite(world.east) || !Number.isFinite(world.north)) continue;
      displayPoints.push({
        ...pt,
        east: world.east,
        north: world.north,
        placedEast: world.east,
        placedNorth: world.north,
      });
    }
    this._visibleLaneProjectionPass = null;
    const built = PALP.buildPointAccumulatedLanePolylines(displayPoints);
    this._pointAccumulatedLanePolylineDiagnostics = built.diagnostics || PALP.emptyDiagnostics();
    const ctx = this.ctx;
    for (const poly of built.polylines || []) {
      if (!poly.points?.length) continue;
      let color = 'rgba(148,163,184,0.95)';
      if (poly.groupTrackId != null && this._pointTrackColorCache?.has?.(poly.groupTrackId)) {
        color = this._pointTrackColorCache.get(poly.groupTrackId);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, Math.min(3.5, this.scale * 0.25));
      ctx.globalAlpha = 0.92;
      ctx.setLineDash([]);
      ctx.beginPath();
      let moved = false;
      for (const p of poly.points) {
        const screen = this.worldToScreen(p.east, p.north);
        if (!moved) { ctx.moveTo(screen.x, screen.y); moved = true; }
        else ctx.lineTo(screen.x, screen.y);
      }
      if (moved) ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  getLayerAttributionPassPng(layerId) {
    const pass = this._layerAttributionPasses.find((p) => p.layerId === layerId);
    return pass?.passPngDataUrl ?? null;
  }

  resetLayerAttributionPasses() {
    this._layerAttributionPasses = [];
    this._layerAttributionDrawOrder = [];
  }

  setLanePixelOwnerPerturb(spec) {
    if (!this._lanePixelOwnerEnabled) return false;
    if (!spec) {
      this._lanePixelOwnerPerturb = null;
      return true;
    }
    this._lanePixelOwnerPerturb = {
      sourceFile: spec.sourceFile ?? null,
      frameId: spec.frameId ?? null,
      groupTrackId: spec.groupTrackId ?? null,
      laneIndex: spec.laneIndex ?? null,
      collection: spec.collection ?? null,
      dxPx: Number.isFinite(spec.dxPx) ? spec.dxPx : 10,
      dyPx: Number.isFinite(spec.dyPx) ? spec.dyPx : 0,
    };
    return true;
  }

  getLanePixelOwnerTrace() {
    return {
      enabled: !!this._lanePixelOwnerEnabled,
      perturb: this._lanePixelOwnerPerturb,
      calls: this._lanePixelOwnerTrace.slice(),
    };
  }

  resetLanePixelOwnerTrace() {
    this._lanePixelOwnerTrace = [];
  }

  _lanePixelOwnerRecord(call) {
    if (!this._lanePixelOwnerEnabled) return;
    this._lanePixelOwnerTrace.push(call);
  }

  _lanePixelOwnerMaybePerturbScreen(screen, source) {
    const p = this._lanePixelOwnerPerturb;
    if (!p || !screen || !source) return screen;
    if (p.collection != null && source._diagCollection !== p.collection) return screen;
    if (p.sourceFile != null && source.sourceFile != null && source.sourceFile !== p.sourceFile) return screen;
    if (p.frameId != null && source.frameId != null && (source.frameId ?? source.frameIndex) !== p.frameId) return screen;
    if (p.groupTrackId != null && source.groupTrackId !== p.groupTrackId && source.laneTrackId !== p.groupTrackId) {
      return screen;
    }
    if (p.laneIndex != null && source.laneIndex != null && source.laneIndex !== p.laneIndex) return screen;
    return { x: screen.x + p.dxPx, y: screen.y + p.dyPx };
  }

  /**
   * Display-only connected accumulated observations (viewer experiment).
   */
  setConnectedAccumulatedPolylines(polylines, stats = null, mode = 'currentFrame') {
    this._connectedAccumulatedPolylines = Array.isArray(polylines) ? polylines : null;
    this._connectedAccumulatedStats = stats;
    this._connectedAccumulatedMode = mode === 'perFrame' ? 'perFrame' : 'currentFrame';
    this._connectedAccumulatedDrawn = false;
  }

  setRepresentativeLaneLines(polylines, diagnostics = null) {
    this._representativeLaneLines = Array.isArray(polylines) ? polylines : null;
    this._representativeLaneLinesDiagnostics = diagnostics;
  }

  getRepresentativeLaneLinesDiagnostics() {
    return this._representativeLaneLinesDiagnostics ?? null;
  }

  /**
   * Point mode display mode.
   * causal=false (default): show all valid points (complete map).
   * causal=true: show only points observed at frameIndex <= elapsedIdx.
   * Display-only; does not rebuild the map or change point coordinates.
   */
  setPointCausalPlayback(enabled) {
    this._pointCausalPlayback = !!enabled;
    if (this.displayMode === 'local') this.draw();
  }

  getPointCausalPlayback() {
    return !!this._pointCausalPlayback;
  }

  /**
   * Experimental reliability tint (Point mode, display-only). OFF by default.
   * When ON, Point dots are tinted by the experimental reliability score
   * (green=high, red=low). Coordinates, points and lane/track colouring are
   * unchanged; when OFF Point mode renders exactly as before.
   */
  setPointReliabilityTint(enabled) {
    this._pointReliabilityTint = !!enabled;
    if (this.displayMode === 'local') this.draw();
  }

  getPointReliabilityTint() {
    return !!this._pointReliabilityTint;
  }

  /**
   * Experimental lane-boundary overlay submode (display-only). One of:
   *   'off'  (default) — Point mode renders exactly as before (dots only)
   *   'points'         — dots only (equivalent to off for dots, keeps state)
   *   'boundaries'     — experimental boundary lines only, dots hidden
   *   'combined'       — dots + experimental boundary lines
   * Never removes or modifies the underlying Point dots.
   */
  setExperimentalBoundariesMode(mode) {
    const m = mode || 'off';
    this._experimentalBoundariesMode = ['off', 'points', 'boundaries', 'combined'].includes(m) ? m : 'off';
    if (this.displayMode === 'local') this.draw();
  }

  getExperimentalBoundariesMode() {
    return this._experimentalBoundariesMode;
  }

  /**
   * Observation-level isolation for the debug overlay. When set, Raw and Point
   * geometry drawing is limited to the selected observation only. Pure
   * display filter: does not rebuild the map, change tracking, or alter any
   * stored coordinates. Set to null to disable isolation.
   */
  setObsDebugSelection(selection) {
    this._obsDebug = !!selection || this._obsDebug;
    this._obsDebugFrame = selection?.frameIndex != null ? selection.frameIndex : null;
    this._obsDebugLane = selection?.laneIndex != null ? selection.laneIndex : null;
    if (this.displayMode === 'local') this.draw();
  }

  _obsIsolationActive() {
    return this._obsDebug && this._obsDebugFrame != null;
  }

  _obsMatches(frameIndex, laneIndex) {
    if (!this._obsIsolationActive()) return true;
    if (this._obsDebugFrame != null && frameIndex !== this._obsDebugFrame) return false;
    if (this._obsDebugLane != null && laneIndex !== this._obsDebugLane) return false;
    return true;
  }

  clearLocalViewportBounds() {
    this._localViewportBounds = null;
  }

  getLocalViewportBounds() {
    return this._localViewportBounds;
  }

  setLocalGeometryDisplay(display) {
    this.localGeometryDisplay = display;
    if (display?.geometryState === 'current' && display?.frame) {
      this._lastValidLocalGeometry = display;
    }
  }

  setLaneRelativeArrow(enabled) {
    this._laneRelativeArrow = !!enabled;
  }

  setMovementAnchor(anchor) {
    this.movementAnchor = anchor;
  }

  setMovementDisplay(display, anchor = null) {
    this.movementDisplay = display;
    this.movementAnchor = anchor;
    this._syncPulseLoop();
  }

  _syncPulseLoop() {
    const anchor = this.movementAnchor || { east: 0, north: 0 };
    const shouldPulse = (this.displayMode === 'vehicle' || this.displayMode === 'local')
      && this.movementDisplay
      && (this.movementDisplay.displayState === 'MOVING' || this.movementDisplay.displayState === 'CREEPING');
    if (shouldPulse) {
      if (!this._pulseRaf) {
        const tick = () => {
          this._pulsePhase = performance.now() / 1000;
          if ((this.displayMode === 'vehicle' || this.displayMode === 'local') && this.movementDisplay
            && (this.movementDisplay.displayState === 'MOVING' || this.movementDisplay.displayState === 'CREEPING')) {
            this.draw();
            this._pulseRaf = requestAnimationFrame(tick);
          } else {
            this._pulseRaf = null;
          }
        };
        this._pulseRaf = requestAnimationFrame(tick);
      }
    } else if (this._pulseRaf) {
      cancelAnimationFrame(this._pulseRaf);
      this._pulseRaf = null;
      this.draw();
    }
  }

  setFrameIndex(i, options = {}) {
    this.frameIndex = i;
    if (options.redraw !== false) this.draw();
  }

  chunkColor(chunkId) {
    return CHUNK_COLORS[chunkId % CHUNK_COLORS.length];
  }

  passColor(passId) {
    return PASS_COLORS[passId % PASS_COLORS.length];
  }

  trackColor(trackId) {
    return TRACK_COLORS[trackId % TRACK_COLORS.length];
  }

  physicalBoundaryColor(physicalBoundaryId) {
    return PHYSICAL_BOUNDARY_COLORS[physicalBoundaryId]
      || TRACK_COLORS[(parseInt(String(physicalBoundaryId).replace(/\D/g, ''), 10) || 0) % TRACK_COLORS.length];
  }

  /**
   * Shared stable-boundary colour resolver. The same physical boundary
   * (groupTrackId) uses the same colour everywhere (dots, constructed
   * fragments, joined polylines, accepted connectors). This is the same
   * resolver the point dots use, so normal lane geometry and dots agree.
   * Missing identity produces an explicit diagnostic, never a silent fallback.
   */
  boundaryColor(groupTrackId) {
    if (groupTrackId == null || String(groupTrackId) === 'undefined' || String(groupTrackId) === '') {
      return { color: '#f97316', diagnostic: `missing identity (groupTrackId=${groupTrackId})` };
    }
    return { color: this.trackColor(groupTrackId), diagnostic: null };
  }

  /**
   * Normalize graph-fit output to an array of polylines (each an array of
   * {east,north,...} vertices). A single accepted segment stores the vertex
   * list directly; multi-segment fits store an array of vertex lists.
   */
  _normalizeFittedPolylines(fittedPolyline) {
    if (!fittedPolyline) return [];
    if (!Array.isArray(fittedPolyline)) return [];
    if (fittedPolyline.length && Array.isArray(fittedPolyline[0])) return fittedPolyline;
    return [fittedPolyline];
  }

  worldToScreen(east, north) {
    const cx = this.w / 2 + this.offsetX;
    const cy = this.h / 2 + this.offsetY;
    return { x: cx + east * this.scale, y: cy - north * this.scale };
  }

  /**
   * Road-geometry-only screen transform. Applies the optional reversible
   * lateral mirror (mirrorRoadLateralDisplay) ONLY to lane/road geometry.
   *
   * The mirror uses a FIXED, precomputed mirrored coordinate set (lateral sign
   * reversed in the vehicle-relative frame at observation time, then placed
   * into the map frame). When a road point carries its precomputed mirrored
   * segment-local coordinates (pt.mirroredLocalEast/mirroredLocalNorth, or
   * fragment mirroredEast/mirroredNorth), they are used directly — so the
   * mirrored road is stationary during playback and receives NO extra
   * 2x-vehicleNorth displacement from the current playback pose.
   *
   * Fallback (points without precomputed mirrored data): reflect about the
   * stationary map's reference axis (fixed referencePose), which is also
   * playback-independent. Never uses the current playback pose as an anchor.
   *
   * The arrow, vehiclePath, GPS trajectory and all vehicle-centric elements
   * use worldToScreen unchanged.
   */
  roadGeometryToScreen(east, north, mirroredEast = null, mirroredNorth = null, point = null) {
    return this._projectRoadGeometryToScreen(east, north, mirroredEast, mirroredNorth, point);
  }

  /**
   * Mirror a road-geometry point. Prefers the precomputed fixed mirrored
   * segment-local coordinates on the point (mirroredLocalEast/
   * mirroredLocalNorth for point dots, mirroredEast/mirroredNorth for
   * fragments). Falls back to a fixed reference-axis reflection (anchor = the
   * stationary map referencePose, constant) for points without precomputed
   * mirrored data. Never uses the playback pose as an anchor.
   */
  _mirrorRoadPoint(east, north, pt = null) {
    if (pt) {
      const me = pt.mirroredLocalEast != null ? pt.mirroredLocalEast
        : pt.mirroredEast != null ? pt.mirroredEast : null;
      const mn = pt.mirroredLocalNorth != null ? pt.mirroredLocalNorth
        : pt.mirroredNorth != null ? pt.mirroredNorth : null;
      if (me != null && mn != null) {
        return { east: me, north: mn, _mirrored: true, _precomputed: true };
      }
    }
    const VMC = typeof window !== 'undefined' ? window.ViewerMirrorCoords : null;
    if (VMC?.resolveRoadDisplayCoords) {
      const reflected = VMC.resolveRoadDisplayCoords(east, north, null, null, true, {
        trajectory: this.stationaryLocalMap?.trajectory,
        referencePose: this.stationaryLocalMap?.referencePose,
        useTrajectoryFallback: false,
        useReferencePoseFallback: true,
      });
      return {
        east: reflected.east,
        north: reflected.north,
        _mirrored: true,
        _precomputed: false,
      };
    }
    return {
      east,
      north: -north,
      _mirrored: true,
      _precomputed: false,
    };
  }

  /**
   * Mirror a raw frame lane point in the vehicle-relative frame (source
   * modelX/modelY, lateral sign reversed) and convert it to the segment-local
   * map frame using the frame's observation pose and the map reference pose.
   * Returns { localEast, localNorth } or null. Used by diagnostics/tests for
   * raw lane points; the draw path mirrors via precomputed coords instead.
   */
  _mirrorRoadPointForSource(near, framePose, referencePose) {
    if (!near || !framePose || !referencePose) return null;
    const theta = (framePose.headingDeg || 0) * Math.PI / 180;
    const s = Math.sin(theta), c = Math.cos(theta);
    const ve = framePose.east, vn = framePose.north;
    // source vehicle-relative (forward, lateral)
    const fwd = near.modelX ?? 0;
    const lat = near.modelY ?? 0;
    // mirrored: forward kept, lateral reversed, place via SAME pose
    const me = ve + fwd * s - (-lat) * c;
    const mn = vn + fwd * c + (-lat) * s;
    // convert to segment-local via reference pose
    const t = (referencePose.headingDeg || 0) * Math.PI / 180;
    const s2 = Math.sin(t), c2 = Math.cos(t);
    const u = me - referencePose.east;
    const v = mn - referencePose.north;
    return { localEast: u * s2 + v * c2, localNorth: v * s2 - u * c2 };
  }

  /** Reversible diagnostic: mirror road-relative lateral display around the
   * vehicle centreline. Set false to restore the current output exactly. */
  setMirrorRoadLateralDisplay(enabled) {
    this._mirrorRoadLateralDisplay = !!enabled;
    this._refreshDisplayCorrectionState();
    if (this.displayMode === 'local') this.draw();
  }

  getMirrorRoadLateralDisplay() {
    return !!this._mirrorRoadLateralDisplay;
  }

  /**
   * Per-frame runtime logging for the mirror diagnostic (?mirrorDebug=1).
   * Logs, for the current frame: source vehicle east/north, arrow screen x/y,
   * vehicle movement delta vs previous frame, and a sample road point's source
   * forward/lateral, mirrored forward/lateral, final map east/north and final
   * screen x/y. Helps confirm the road is mirrored in the vehicle-relative
   * frame and does not receive extra 2x-vehicleNorth displacement.
   */
  _logMirrorDebug(map) {
    const arrow = this.playbackPose;
    if (!arrow || !this._mirrorDebug) return;
    const sample = map?.laneFragments?.[0]?.points?.[0];
    const nowE = arrow.east;
    const nowN = arrow.north;
    let dE = null, dN = null;
    if (this._lastMirrorDebugPos) {
      dE = nowE - this._lastMirrorDebugPos.e;
      dN = nowN - this._lastMirrorDebugPos.n;
    }
    this._lastMirrorDebugPos = { e: nowE, n: nowN };
    const arrowScreen = this.worldToScreen(nowE, nowN);
    let laneSrc = null, laneMir = null;
    if (sample) {
      // vehicle-relative forward/lateral of the source point, using the sample
      // point's observation pose (or the first frame pose).
      const srcFrame = this.data?.frames?.[sample.sourceFrameIndex] || this.data?.frames?.[0];
      const pose = srcFrame?.pose;
      const rel = (e, n) => {
        const t = ((pose?.headingDeg) || 0) * Math.PI / 180;
        const s = Math.sin(t), c = Math.cos(t);
        const u = e - (pose?.east || 0), v = n - (pose?.north || 0);
        return { f: u * s + v * c, l: v * s - u * c };
      };
      const m = this._mirrorRoadPoint(sample.east, sample.north, sample);
      laneSrc = rel(sample.east, sample.north);
      laneMir = rel(m.east, m.north);
      const sc = this.roadGeometryToScreen(sample.east, sample.north, sample.mirroredEast, sample.mirroredNorth);
      laneMir.e = m.east;
      laneMir.n = m.north;
      laneMir.screenX = sc.x;
      laneMir.screenY = sc.y;
      laneSrc.precomputed = !!m._precomputed;
      laneMir.precomputed = !!m._precomputed;
    }
    // eslint-disable-next-line no-console
    console.log('[mirror-debug]', JSON.stringify({
      frame: this.localElapsedIdx,
      mirrorOn: this._mirrorRoadLateralDisplay,
      vehicleEast: +nowE.toFixed(2), vehicleNorth: +nowN.toFixed(2),
      arrowHeading: +arrow.headingDeg.toFixed(2),
      arrowScreen: arrowScreen ? { x: +arrowScreen.x.toFixed(1), y: +arrowScreen.y.toFixed(1) } : null,
      vehicleDelta: dE != null ? { dEast: +dE.toFixed(3), dNorth: +dN.toFixed(3) } : null,
      laneSample: laneSrc,
      laneMirrored: laneMir,
    }));
  }

  fitToView(boundsOverride = null) {
    const bounds = boundsOverride || this._computeBounds();
    if (!bounds) return;
    const pad = 40;
    const rangeE = bounds.maxE - bounds.minE || 1;
    const rangeN = bounds.maxN - bounds.minN || 1;
    const sx = (this.w - pad * 2) / rangeE;
    const sy = (this.h - pad * 2) / rangeN;
    this.scale = Math.min(sx, sy);
    const midE = (bounds.minE + bounds.maxE) / 2;
    const midN = (bounds.minN + bounds.maxN) / 2;
    this.offsetX = -midE * this.scale;
    this.offsetY = midN * this.scale;
    this.draw();
  }

  fitToLocalView() {
    const LP = window.LocalPlayback;
    if (this.localGeometryMode === 'diagnostic') {
      const display = this.localGeometryDisplay;
      const frame = display?.frame ?? this.data?.frames?.[this.localElapsedIdx];
      const bounds = LP?.computeVehicleFrameBounds(frame, this.playbackPose) || this._computeBounds();
      this._localViewportBounds = bounds;
      this.fitToView(bounds);
      return;
    }
    const mapBounds = this.stationaryLocalMap?.fitBounds
      || this.stationaryLocalMap?.bounds;
    if (mapBounds) {
      const bounds = this._mirrorAwareMapBounds(mapBounds);
      this._localViewportBounds = bounds;
      this.fitToView(bounds);
      return;
    }
    if (this._localViewportBounds) {
      this.fitToView(this._localViewportBounds);
      return;
    }
    const display = this.localGeometryDisplay;
    const frame = display?.frame ?? this.data?.frames?.[this.localElapsedIdx];
    const fallback = LP?.computeVehicleFrameBounds(frame, this.playbackPose) || this._computeBounds();
    this._localViewportBounds = fallback;
    this.fitToView(fallback);
  }

  resetView() {
    this.scale = this.displayMode === 'vehicle' ? 8 : (this.displayMode === 'local' ? 8 : 1);
    this.offsetX = 0;
    this.offsetY = 0;
    if (this.displayMode === 'local') {
      this.clearLocalViewportBounds();
      this.fitToLocalView();
    } else this.fitToView();
  }

  _computeBounds() {
    const pts = [];
    const d = this.data;
    if (!d) return null;
    const add = (e, n) => { if (Number.isFinite(e) && Number.isFinite(n)) pts.push({ e, n }); };

    if (d.routeChunks?.length) {
      for (const chunk of d.routeChunks) {
        if (this.layers.gps) chunk.gpsTrajectory?.forEach((p) => add(p.east, p.north));
        if (this.layers.fused) chunk.fusedLaneLines?.forEach((l) => l.points.forEach((p) => add(p.east, p.north)));
        if (this.layers.edges) chunk.fusedRoadEdges?.forEach((e) => e.points.forEach((p) => add(p.east, p.north)));
      }
    }
    if (this.displayMode === 'vehicle' && d.frames?.[this.frameIndex]) {
      const f = d.frames[this.frameIndex];
      (f.lanes || []).forEach((l) => (l.points || []).forEach((p) => add(p.east, p.north)));
      (f.edges || []).forEach((e) => (e.points || []).forEach((p) => add(p.east, p.north)));
    }

    if (!pts.length) return { minE: -50, maxE: 50, minN: -10, maxN: 100 };
    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const p of pts) {
      minE = Math.min(minE, p.e); maxE = Math.max(maxE, p.e);
      minN = Math.min(minN, p.n); maxN = Math.max(maxN, p.n);
    }
    return { minE, maxE, minN, maxN };
  }

  draw() {
    const ctx = this.ctx;
    if (this._layerAttributionEnabled) {
      this.resetLayerAttributionPasses();
    }
    if (this._lanePixelOwnerEnabled) {
      this.resetLanePixelOwnerTrace();
    }
    const CVLP = typeof window !== 'undefined' ? window.CombinedVisibleLaneProjection : null;
    if (CVLP?.resetDrawDiagnostics) CVLP.resetDrawDiagnostics();
    if (this._visibleLaneProjectionEnabled && CVLP?.isCandidateEligible?.(this.stationaryLocalMap, {
      mirrorChecked: this._mirrorRoadLateralDisplay,
      useVisibleLaneProjection: true,
    })) {
      CVLP.markCandidateActiveOnMap?.(this.stationaryLocalMap);
    }
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = '#f8f8f8';
    ctx.fillRect(0, 0, this.w, this.h);

    const d = this.data;
    if (!d) {
      ctx.fillStyle = '#888';
      ctx.font = '14px sans-serif';
      ctx.fillText('Process qlog segments to render road geometry', 20, 30);
      return;
    }

    if (this.displayMode === 'vehicle') {
      this._drawVehicleFrame(d.frames?.[this.frameIndex]);
    } else if (this.displayMode === 'local') {
      this._drawLocalPlayback(d);
    } else {
      this._drawGlobal(d);
    }

    this._drawScaleBar();
    if (this.displayMode === 'global') this._drawNorthArrow();
    if (this.hoverPoint) this._drawHover(this.hoverPoint);
  }

  _drawGlobal(d, options = {}) {
    const { skipRawFrame = false, skipVehicleMarker = false } = options;
    const ctx = this.ctx;
    const chunks = d.routeChunks || [];

    for (const chunk of chunks) {
      const cc = this.chunkColor(chunk.chunkId);
      const useChunkColor = this.layers.colorByChunk;

      if (this.layers.roadSurface && chunk.roadSurfacePolygons) {
        for (const poly of chunk.roadSurfacePolygons) {
          if (poly.stats?.maxVertexJump > 15 || poly.stats?.maxWidth > 30) continue;
          let fill;
          if (this.layers.colorByPass && poly.passId != null) {
            fill = this.passColor(poly.passId);
          } else if (useChunkColor) {
            fill = cc + '55';
          } else {
            fill = 'rgba(60,60,60,0.35)';
          }
          this._fillPolygon(poly.ring, fill, poly.passId);
        }
      }

      if (this.layers.laneOnly && chunk.laneOnlyCandidates?.length) {
        for (const lane of chunk.laneOnlyCandidates) {
          this._drawPolyline(lane.points, '#f97316', 2, true, 12, true);
        }
      }

      if (this.layers.fused && chunk.fusedLaneLines) {
        chunk.fusedLaneLines.forEach((lane, i) => {
          const color = useChunkColor ? cc : LANE_COLORS[i % LANE_COLORS.length];
          this._drawPolyline(lane.points, color, 2, false, 12, true);
        });
      }

      if (this.layers.fusedTracks && d.laneTracks?.length) {
        for (const track of d.laneTracks) {
          const color = this.layers.colorByTrack ? this.trackColor(track.trackId) : '#1d4ed8';
          this._drawPolyline(track.points, color, 2.5, false, 20, true);
          if (this.layers.trackIds && track.points?.length) {
            const mid = track.points[Math.floor(track.points.length / 2)];
            this._drawLabel(mid.east, mid.north, `T${track.trackId}`, '#111', true);
          }
        }
      }

      if (this.layers.trackConnections && d.laneConnections?.length) {
        const ctx = this.ctx;
        ctx.strokeStyle = 'rgba(99,102,241,0.55)';
        ctx.lineWidth = 1;
        for (const conn of d.laneConnections) {
          const a = this.roadGeometryToScreen(conn.from.east, conn.from.north);
          const b = this.roadGeometryToScreen(conn.to.east, conn.to.north);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      if (this.layers.edges && chunk.fusedRoadEdges) {
        chunk.fusedRoadEdges.forEach((edge) => {
          this._drawPolyline(edge.points, useChunkColor ? cc : '#16a34a', 3, false, 12, true);
        });
      }

      if (this.layers.centre && chunk.centreLine) {
        for (const cl of chunk.centreLine) {
          this._drawPolyline(cl.points, '#ffffff', 2, true, 12, true);
        }
      }

      if (this.layers.gps && chunk.gpsTrajectory) {
        this._drawPolyline(chunk.gpsTrajectory, useChunkColor ? cc : '#6366f1', 2, false);
      }

      if (this.layers.vehicle) {
        const segments = chunk.trajectorySegments?.length
          ? chunk.trajectorySegments
          : (chunk.vehiclePath?.length ? [chunk.vehiclePath] : []);
        for (const seg of segments) {
          if (seg?.length >= 2) this._drawPolyline(seg, '#f59e0b', 1.5, false);
        }
      }

      if (this.layers.markers && chunk.gpsTrajectory?.length) {
        const s = chunk.gpsTrajectory[0];
        const e = chunk.gpsTrajectory[chunk.gpsTrajectory.length - 1];
        this._drawMarker(s.east, s.north, '#16a34a', `S${chunk.chunkId}`);
        this._drawMarker(e.east, e.north, '#dc2626', `E${chunk.chunkId}`);
      }

      if (this.layers.passBoundaries && chunk.passDiagnostics?.splitEvents?.length) {
        for (const ev of chunk.passDiagnostics.splitEvents) {
          const pt = chunk.vehiclePath?.find((p) => p.frameId === ev.frameId)
            || (d.frames || []).find((f) => f.frameId === ev.frameId && f.chunkId === chunk.chunkId);
          if (pt?.pose) {
            this._drawMarker(pt.pose.east, pt.pose.north, '#9333ea', `P${ev.passId}`);
          } else if (pt?.east != null) {
            this._drawMarker(pt.east, pt.north, '#9333ea', `P${ev.passId}`);
          }
        }
      }

      if (this.layers.suspiciousGps && chunk.passCoverage) {
        const suspicious = new Set(
          (chunk.passCoverage || []).filter((p) => p.suspiciousGps).map((p) => p.passId)
        );
        if (suspicious.size && chunk.vehiclePath?.length) {
          let run = [];
          for (const pt of chunk.vehiclePath) {
            const passId = pt.passId ?? 0;
            if (suspicious.has(passId)) run.push(pt);
            else if (run.length) {
              this._drawPolyline(run, '#ef4444', 4, false);
              run = [];
            }
          }
          if (run.length) this._drawPolyline(run, '#ef4444', 4, false);
        }
      }

      if (this.layers.rejectedObs && d.frames) {
        const rctx = this.ctx;
        rctx.globalAlpha = 0.35;
        for (const f of d.frames) {
          if (f.chunkId !== chunk.chunkId) continue;
          for (const edge of f.edges || []) {
            for (const pt of edge.points || []) {
              const sp = this.roadGeometryToScreen(pt.east, pt.north);
              rctx.fillStyle = '#dc2626';
              rctx.fillRect(sp.x - 2, sp.y - 2, 4, 4);
            }
          }
        }
        rctx.globalAlpha = 1;
      }

      if (this.layers.colorByChunk && chunk.gpsTrajectory?.length) {
        const mid = chunk.gpsTrajectory[Math.floor(chunk.gpsTrajectory.length / 2)];
        const p = this.worldToScreen(mid.east, mid.north);
        ctx.fillStyle = cc;
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText(`chunk ${chunk.chunkId}`, p.x + 8, p.y - 8);
      }
    }

    if (this.layers.raw && d.frames) {
      ctx.globalAlpha = 0.12;
      for (const f of d.frames) {
        for (const lane of f.lanes || []) {
          this._drawPolyline(lane.points, '#94a3b8', 1, false, 15, true);
        }
      }
      ctx.globalAlpha = 1;
    }

    if (!skipRawFrame && this.layers.rawFrame && d.frames?.[this.frameIndex]) {
      const f = d.frames[this.frameIndex];
      for (const lane of f.lanes || []) {
        const color = this.layers.colorByTrack && lane.laneTrackId != null
          ? this.trackColor(lane.laneTrackId)
          : LANE_COLORS[(lane.laneIndex ?? 0) % LANE_COLORS.length];
        this._drawPolyline(lane.points, color, 2.5, false, 15, true);
        if (lane.anchors?.length) {
          for (const a of lane.anchors) {
            const sp = this.roadGeometryToScreen(a.east, a.north);
            this.ctx.fillStyle = color;
            this.ctx.beginPath();
            this.ctx.arc(sp.x, sp.y, 3, 0, Math.PI * 2);
            this.ctx.fill();
          }
        }
        if (this.layers.trackIds && lane.laneTrackId != null && lane.points?.length) {
          const mid = lane.points[Math.floor(lane.points.length / 2)];
          this._drawLabel(mid.east, mid.north, `T${lane.laneTrackId}`, '#111', true);
        }
      }
      for (const edge of f.edges || []) {
        this._drawPolyline(edge.points, '#16a34a', 2, false, 15, true);
      }
    }

    if (!skipVehicleMarker && this.layers.markers && d.timeline?.[this.frameIndex]) {
      const t = d.timeline[this.frameIndex];
      const vp = d.vehiclePath?.find((p) => p.logMonoTime === t.logMonoTime);
      if (vp) this._drawVehicleIcon(vp.east, vp.north, t.bearingDeg || 0);
    }
  }

  _drawLocalPlayback(d) {
    const LP = window.LocalPlayback;
    const elapsedIdx = this.localElapsedIdx ?? this.frameIndex ?? 0;

    if (this.localGeometryMode === 'diagnostic') {
      const display = this.localGeometryDisplay
        || (LP?.resolveLocalGeometryFrame(
          d.frames,
          d.timeline,
          elapsedIdx,
          this._lastValidLocalGeometry,
        ) ?? { frame: null, geometryState: 'unavailable' });

      if (display.geometryState === 'current' && display.frame) {
        this._lastValidLocalGeometry = display;
      }

      if (display.frame) {
        const stale = display.geometryState === 'retained';
        this._drawVehicleFrameGeometry(display.frame, {
          arrowPose: this.playbackPose,
          showMovementAtArrow: true,
          useScreenPathHeading: true,
          geometryStale: stale,
          retainedFromElapsedIdx: display.retainedFromElapsedIdx,
        });
      } else if (this.playbackPose) {
        this._drawAxes();
        this._drawLocalPlaybackArrow(null, this.playbackPose);
      }
    } else {
      this._drawStationaryLocalMap(d, elapsedIdx);
    }

    if (this._laneTransformDebug) {
      this._drawLocalPlaybackDebugOverlay(d, elapsedIdx);
    }
  }

  _selectStationaryRoadSurfaceDrawables(map) {
    const SLM = window.SegmentLocalMap;
    const polygons = map?.roadSurfacePolygons || [];
    let base;
    if (!SLM?.selectStationaryRoadSurfacePolygons) {
      base = {
        drawables: polygons.map((poly) => ({ poly, displayRing: poly.ring, clipped: false, sourceIndex: null })),
        skipped: [],
        sourceCount: polygons.length,
        drawableCount: polygons.length,
      };
    } else {
      const result = SLM.selectStationaryRoadSurfacePolygons(polygons, {
        polygonDebug: this._polygonDebug,
        fusionBinDebug: this._fusionBinDebug,
      });
      base = {
        drawables: result.selected.map((poly, idx) => ({
          poly,
          displayRing: poly.ring,
          clipped: false,
          sourceIndex: idx,
        })),
        skipped: result.skipped,
        sourceCount: polygons.length,
        drawableCount: result.selectedCount,
      };
    }

    const LRSP = typeof window !== 'undefined' ? window.LocalRoadSurfacePathFilter : null;
    const trajectory = map?.trajectory;
    if (!LRSP?.filterRoadSurfacePolygonsForTrajectory || !trajectory?.length) {
      return base;
    }

    const radiusM = this.localRoadSurfacePathRadiusM ?? LRSP.LOCAL_ROAD_SURFACE_PATH_RADIUS_M;
    const filtered = LRSP.filterRoadSurfacePolygonsForTrajectory(
      base.drawables.map((entry) => entry.poly),
      trajectory,
      { radiusM },
    );

    return {
      drawables: filtered.drawables,
      skipped: [...base.skipped, ...filtered.skipped],
      sourceCount: base.sourceCount,
      drawableCount: filtered.stats.drawableCount,
      pathFilterStats: filtered.stats,
      corridorSections: filtered.corridor.sections.length,
    };
  }

  _drawStationaryLocalMap(d, elapsedIdx) {
    const map = this.stationaryLocalMap;
    if (!map?.valid) {      this._drawStationaryUnavailable(map);
      this._drawAxes();
      this._drawLocalVehiclePathOverlay(map);
      if (this.playbackPose) {
        this._drawLocalPlaybackArrow(null, this.playbackPose);
      }
      this._roadSurfaceDrawStats = null;
      return;
    }

    this._attrPass('axes', {
      drawFunction: '_drawAxes',
      geometryCollection: 'canvasAxes',
      enabled: true,
    }, () => this._drawAxes());

    if (this.layers.roadSurface) {
      this._attrPass('roadRibbon', {
        drawFunction: '_drawStationaryLocalMap.roadRibbon',
        rendererStateField: 'layers.roadSurface',
        uiControl: 'layerRoadSurface',
        enabled: this.layers.roadSurface,
        geometryCollection: 'trajectory+edgeFragments',
        geometryObjectCount: map?.trajectory?.length ?? 0,
        pointCount: map?.trajectory?.length ?? 0,
        coordinateFramePopulation: window.CanvasLayerAttribution?.summarizeCoordinateFrames?.(map?.trajectory) ?? {},
        sourceProvenanceCoveragePct: window.CanvasLayerAttribution?.sourceProvenanceCoveragePct?.(map?.trajectory) ?? 0,
        fillColours: ['rgba(100,116,139,0.42)'],
      }, () => {
      const LRR = typeof window !== 'undefined' ? window.LocalRoadSurfaceRibbon : null;
      const trajectory = map?.trajectory;
      const edgeFragments = map?.edgeFragments;
      const ribbonOptions = {
        fallbackHalfWidthM: this.localRoadSurfaceRibbonFallbackHalfWidthM
          ?? LRR?.LOCAL_ROAD_SURFACE_RIBBON_FALLBACK_HALF_WIDTH_M ?? 7.5,
        minHalfWidthM: this.localRoadSurfaceRibbonMinHalfWidthM
          ?? LRR?.LOCAL_ROAD_SURFACE_RIBBON_MIN_HALF_WIDTH_M ?? 3,
        maxHalfWidthM: this.localRoadSurfaceRibbonMaxHalfWidthM
          ?? LRR?.LOCAL_ROAD_SURFACE_RIBBON_MAX_HALF_WIDTH_M ?? 15,
      };
      const ribbonFill = 'rgba(100,116,139,0.42)';
      let ribbonResult = null;
      if (LRR?.buildTrajectoryRoadSurfaceRibbons && trajectory?.length >= 2) {
        ribbonResult = LRR.buildTrajectoryRoadSurfaceRibbons(trajectory, edgeFragments, ribbonOptions);
        for (const ribbon of ribbonResult.ribbons) {
          LRR.drawRoadSurfaceRibbon(
            this.ctx,
            ribbon,
            (east, north) => this.roadGeometryToScreen(east, north),
            ribbonFill,
          );
        }
      }

      let storedDiagnostics = null;
      if (this._polygonDebug || this._fusionBinDebug) {
        const surfaceSelection = this._selectStationaryRoadSurfaceDrawables(map);
        storedDiagnostics = surfaceSelection;
        const polyColors = [
          'rgba(96,165,250,0.35)',
          'rgba(74,222,128,0.35)',
          'rgba(251,191,36,0.35)',
          'rgba(244,114,182,0.35)',
          'rgba(167,139,250,0.35)',
          'rgba(45,212,191,0.35)',
          'rgba(248,113,113,0.35)',
        ];
        for (let pi = 0; pi < surfaceSelection.drawables.length; pi++) {
          const entry = surfaceSelection.drawables[pi];
          const poly = entry.poly;
          const drawRing = entry.displayRing || poly.ring;
          const surfaceType = poly.surfaceType ?? 'egoLaneCorridor';
          let fill = 'rgba(120,120,120,0.38)';
          if (surfaceType === 'fullRoadSurface') fill = 'rgba(100,116,139,0.42)';
          else if (surfaceType === 'multiLaneCorridor') fill = 'rgba(134,163,120,0.38)';
          else if (surfaceType === 'egoLaneCorridor') fill = 'rgba(120,120,120,0.38)';
          if (poly.syntheticForSurface && this._fusionBinDebug) fill = 'rgba(251,191,36,0.25)';
          if (this._polygonDebug) {
            fill = polyColors[pi % polyColors.length];
          } else if (this._fusionBinDebug && this.layers.colorByPass && poly.passId != null) {
            fill = this.passColor(poly.passId);
          }
          this._fillPolygon(drawRing, fill, null, {
            outline: this._polygonDebug || this._fusionBinDebug ? '#1e293b' : 'rgba(80,80,80,0.65)',
            outlineWidth: this._polygonDebug ? 2 : 1,
            dashed: poly.syntheticForSurface && this._fusionBinDebug,
          });
          if ((this._polygonDebug || this._fusionBinDebug) && drawRing?.length) {
            const mid = drawRing[Math.floor(drawRing.length / 2)];
            const label = [
              this._polygonDebug ? `poly ${poly.fragmentIndex ?? pi}` : null,
              this._fusionBinDebug ? surfaceType.replace('Corridor', '') : null,
              poly.sourceLeftTrackId != null ? `L${poly.sourceLeftTrackId}` : null,
              poly.sourceRightTrackId != null ? `R${poly.sourceRightTrackId}` : null,
            ].filter(Boolean).join(' ');
            this._drawLabel(mid.east, mid.north, label, '#0f172a');
          }
        }
        if (this._fusionBinDebug && surfaceSelection.skipped.length) {
          for (const skip of surfaceSelection.skipped) {
            const poly = map.roadSurfacePolygons[skip.index];
            const mid = poly?.ring?.[0];
            if (mid) {
              this._drawLabel(mid.east, mid.north, `skip ${skip.reason}`, '#dc2626');
            }
          }
        }
      } else if ((map.roadSurfacePolygons || []).length && !ribbonResult?.ribbons?.length) {
        // Normal mode (no polygon/fusion debug): a stationary segment has no
        // trajectory ribbon (trajectory collapses to a single anchor point), so
        // draw the local road-surface polygons directly. Stationary local
        // polygons are built between two supported ego-lane boundaries in the
        // fixed-anchor frame and never extrapolate beyond observed points.
        for (const poly of map.roadSurfacePolygons) {
          const drawRing = poly.ring;
          if (!drawRing?.length || !this._ringHasFiniteCoords(drawRing)) continue;
          let fill = 'rgba(120,120,120,0.38)';
          const surfaceType = poly.surfaceType ?? 'egoLaneCorridor';
          if (surfaceType === 'fullRoadSurface') fill = 'rgba(100,116,139,0.42)';
          else if (surfaceType === 'multiLaneCorridor') fill = 'rgba(134,163,120,0.38)';
          this._fillPolygon(drawRing, fill, null, {
            outline: 'rgba(80,80,80,0.65)',
            outlineWidth: 1,
            dashed: false,
          });
        }
      }

      let stationaryPolygonCount = 0;
      if (this._polygonDebug || this._fusionBinDebug) {
        stationaryPolygonCount = this._selectStationaryRoadSurfaceDrawables(map).selectedCount;
      } else if ((map.roadSurfacePolygons || []).length && !ribbonResult?.ribbons?.length) {
        stationaryPolygonCount = (map.roadSurfacePolygons || []).filter((p) =>
          p.ring?.length >= 3 && this._ringHasFiniteCoords(p.ring),
        ).length;
      }
      // Ribbon remains the default display source; stationary local polygons
      // are a fallback used only when no trajectory ribbon can be built (fully
      // stationary segment) or a ribbon is present alongside polygons.
      const stationaryPolygonFallback = stationaryPolygonCount > 0 && !ribbonResult?.ribbons?.length;

      this._roadSurfaceDrawStats = {
        elapsedIdx,
        surfaceDisplaySource: stationaryPolygonFallback ? 'stationaryLocalPolygons' : 'trajectoryRibbon',
        ribbonStats: ribbonResult?.stats ?? null,
        ribbonCount: ribbonResult?.ribbons?.length ?? 0,
        sectionCount: ribbonResult?.sections?.length ?? 0,
        selfIntersecting: ribbonResult?.ribbons?.some((r) => r.selfIntersecting) ?? false,
        sourceCount: map.roadSurfacePolygonCount ?? map.roadSurfacePolygons?.length ?? 0,
        drawableCount: (ribbonResult?.ribbons?.length ?? 0) + stationaryPolygonCount,
        stationaryPolygonCount,
        storedPolygonDiagnostics: storedDiagnostics,
        roadSurfaceChecksum: map.roadSurfaceChecksum ?? null,
        drawInvocation: (this._roadSurfaceDrawStats?.drawInvocation ?? 0) + 1,
      };
      });
    } else {
      this._roadSurfaceDrawStats = {
        elapsedIdx,
        sourceCount: map.roadSurfacePolygonCount ?? 0,
        drawableCount: 0,
        skipped: [],
        layerDisabled: true,
        roadSurfaceChecksum: map.roadSurfaceChecksum ?? null,
        drawInvocation: (this._roadSurfaceDrawStats?.drawInvocation ?? 0) + 1,
      };
    }

    if (this.layers.edges) {
      this._attrPass('roadEdges', {
        drawFunction: '_drawStationaryLocalMap.edgeFragments',
        rendererStateField: 'layers.edges',
        uiControl: 'layerRoadEdges',
        enabled: this.layers.edges,
        geometryCollection: 'edgeFragments',
        geometryObjectCount: map.edgeFragments?.length ?? 0,
        pointCount: (map.edgeFragments || []).reduce((n, f) => n + (f.points?.length ?? 0), 0),
        strokeColours: ['#16a34a'],
      }, () => {
        for (const edge of map.edgeFragments || []) {
          if (edge.outlier && !this._outlierDebug) continue;
          const color = edge.outlier ? 'rgba(220,38,38,0.5)' : '#16a34a';
          this._drawPolyline(edge.points, color, edge.outlier ? 1.5 : 3, false, 15, true);
        }
      });
    }

    if (this.layers.fused && this.localGeometryMode !== 'pointAccumulated') {
      const mode = this.localGeometryMode;
      const debugMode = mode === 'cleanedDebug';
      const isolationActive = this._obsIsolationActive() && (mode === 'observations' || mode === 'pointAccumulated');
      const frags = isolationActive
        ? (map.laneFragments || []).filter((l) => this._obsMatches(l.sourceFrameIndex, l.laneIndex))
        : (map.laneFragments || []);
      this._attrPass('stationaryMapLanes', {
        drawFunction: '_drawStationaryLocalMap.laneFragments',
        rendererStateField: 'layers.fused',
        uiControl: 'layerFusedLanes',
        enabled: this.layers.fused,
        geometryCollection: 'laneFragments',
        geometryObjectCount: frags.length,
        pointCount: frags.reduce((n, f) => n + (f.points?.length ?? 0), 0),
        coordinateFramePopulation: window.CanvasLayerAttribution?.summarizeCoordinateFrames?.(
          frags.flatMap((f) => f.points || []),
        ) ?? {},
        sourceProvenanceCoveragePct: window.CanvasLayerAttribution?.sourceProvenanceCoveragePct?.(
          frags.flatMap((f) => f.points || []),
        ) ?? 0,
      }, () => {
      this._visibleLaneProjectionPass = 'laneFragments';
      const CVLP = typeof window !== 'undefined' ? window.CombinedVisibleLaneProjection : null;
      frags.forEach((lane, i) => {
        CVLP?.noteLaneFragmentPass?.();
        this._visibleLaneProjectionFragmentHint = {
          sourceFile: lane.sourceFile ?? null,
          sourceFrameId: lane.sourceFrameId ?? null,
          sourceFrameIndex: lane.sourceFrameIndex ?? null,
          laneTrackId: lane.laneTrackId ?? null,
          laneIndex: lane.laneIndex ?? null,
        };
        if (lane.outlier && !this._outlierDebug) return;
        let color;
        if (mode === 'rejected' || lane.supportStatus === 'rejected') {
          color = 'rgba(220,38,38,0.85)';
        } else if (debugMode && lane.fragmentKind === 'preservedSourcePolyline') {
          color = 'rgba(234, 179, 8, 0.95)';
        } else if (lane.physicalBoundaryId && (lane.colorByPhysicalBoundary || mode === 'cleaned' || mode === 'cleanedWithSurface' || debugMode)) {
          color = this.physicalBoundaryColor(lane.physicalBoundaryId);
        } else if (lane.laneTrackId != null && (lane.colorByTrack || mode === 'tracked' || mode === 'fused')) {
          color = this.trackColor(lane.laneTrackId);
        } else {
          color = lane.outlier
            ? 'rgba(220,38,38,0.6)'
            : LANE_COLORS[i % LANE_COLORS.length];
        }
        const width = (mode === 'cleaned' || mode === 'cleanedWithSurface' || debugMode) ? 2.5 : (lane.outlier ? 1.5 : 2);
        const dashed = debugMode && lane.fragmentKind === 'preservedSourcePolyline';
        if (this._lanePixelOwnerEnabled && lane.points?.length) {
          const mid = lane.points[Math.floor(lane.points.length / 2)];
          const screen = this._projectRoadGeometryToScreen(
            mid.east ?? mid.localEast,
            mid.north ?? mid.localNorth,
            mid.mirroredLocalEast,
            mid.mirroredLocalNorth,
            mid,
          );
          const source = {
            ...mid,
            sourceFile: mid.sourceFile ?? lane.sourceFile ?? null,
            frameId: mid.frameId ?? lane.sourceFrameId ?? lane.sourceFrameIndex ?? null,
            laneIndex: lane.laneIndex ?? mid.laneIndex ?? null,
            groupTrackId: lane.laneTrackId ?? mid.groupTrackId ?? null,
            laneTrackId: lane.laneTrackId ?? null,
            _diagCollection: 'laneFragments',
          };
          const drawn = this._lanePixelOwnerMaybePerturbScreen(screen, source);
          this._lanePixelOwnerRecord({
            drawPass: 'stationaryMapLanes',
            drawFunction: '_drawStationaryLocalMap.laneFragments',
            geometryCollection: 'laneFragments',
            sourceArrayIndex: i,
            sourceFile: source.sourceFile,
            frameId: source.frameId,
            laneIndex: source.laneIndex,
            groupTrackId: source.groupTrackId,
            selectedFields: this._usesCombinedPlacedFrame(mid)
              ? ['placedEast', 'placedNorth']
              : ['east/localEast', 'north/localNorth', 'mirroredLocal*'],
            inputCoords: {
              east: mid.east ?? mid.localEast,
              north: mid.north ?? mid.localNorth,
              placedEast: mid.placedEast ?? null,
              placedNorth: mid.placedNorth ?? null,
              mirroredLocalEast: mid.mirroredLocalEast ?? null,
              mirroredLocalNorth: mid.mirroredLocalNorth ?? null,
              coordinateFrame: mid.coordinateFrame ?? null,
            },
            projectedPixel: drawn,
            colour: color,
            lineWidth: width,
            kind: 'polyline',
          });
          if (drawn !== screen && this._lanePixelOwnerPerturb) {
            // Diagnostic-only: redraw this fragment shifted in screen space.
            const ctx = this.ctx;
            const dx = this._lanePixelOwnerPerturb.dxPx || 0;
            const dy = this._lanePixelOwnerPerturb.dyPx || 0;
            ctx.save();
            ctx.translate(dx, dy);
            this._drawPolyline(lane.points, color, width, dashed, 15, true);
            ctx.restore();
            return;
          }
        }
        this._drawPolyline(lane.points, color, width, dashed, 15, true);

        if (debugMode && lane.points?.length) {
          const start = lane.points[0];
          const end = lane.points[lane.points.length - 1];
          const mid = lane.points[Math.floor(lane.points.length / 2)];
          const label = lane.fragmentKind === 'preservedSourcePolyline'
            ? [
              `D12 ${lane.gapId}`,
              `F${lane.sourceFrameId}`,
              lane.sMin != null ? `s${Math.round(lane.sMin)}-${Math.round(lane.sMax)}` : null,
            ].filter(Boolean).join(' ')
            : [
              `R${lane.fragmentIndex ?? i}`,
              lane.physicalBoundaryId,
              `T${lane.laneTrackId}`,
              lane.sMin != null ? `s${Math.round(lane.sMin)}-${Math.round(lane.sMax)}` : null,
            ].filter(Boolean).join(' ');
          this._drawLabel(mid.east, mid.north, label, color, true);
          if (lane.fragmentKind !== 'preservedSourcePolyline') {
            this._drawLabel(start.east, start.north, '●', color, true);
            this._drawLabel(end.east, end.north, '○', color, true);
          }
        }
      });
      this._visibleLaneProjectionPass = null;
      this._visibleLaneProjectionFragmentHint = null;

      if (debugMode && map.laneCleanup?.mergeDecisions) {
        for (const d of map.laneCleanup.mergeDecisions) {
          if (d.wasJoined || !Number.isFinite(d.gapM)) continue;
          const frag = map.laneFragments.find((f) => f.sMax != null && Math.abs(f.sMax - d.endS) < 0.5);
          if (!frag?.points?.length) continue;
          const endPt = frag.points[frag.points.length - 1];
          this._drawLabel(
            endPt.east,
            endPt.north - 2,
            `gap ${d.gapM?.toFixed(1)}m ${d.classification}`,
            '#dc2626',
          );
        }
      }

      if (debugMode && map.laneCleanup?.drawablePathAnalysis?.interRunBreaks?.length) {
        for (const brk of map.laneCleanup.drawablePathAnalysis.interRunBreaks) {
          if (brk.labelEast == null) continue;
          this._drawLabel(
            brk.labelEast,
            brk.labelNorth,
            `OPEN ${brk.gapId} ${brk.openLengthM?.toFixed(2)}m`,
            '#dc2626',
          );
        }
      }
      });
    }

    if (this._outlierDebug) {
      for (const frag of map.outlierFragments || []) {
        this._drawPolyline(frag.points, '#dc2626', 3, true, 15, true);
        const mid = frag.points?.[Math.floor((frag.points.length - 1) / 2)];
        if (mid) {
          this._drawLabel(mid.east, mid.north, (frag.outlierReasons || []).join(','), '#dc2626');
        }
      }
    }

    if (this.localGeometryMode === 'pointAccumulated') {
      this._drawPointAccumulatedGeometry(map, elapsedIdx);
    }

    this._attrPass('trajectory', {
      drawFunction: '_drawLocalVehiclePathOverlay',
      geometryCollection: 'trajectory',
      geometryObjectCount: map?.trajectory?.length ?? 0,
      pointCount: map?.trajectory?.length ?? 0,
      strokeColours: ['#94a3b8'],
      dashState: [8, 6],
    }, () => this._drawLocalVehiclePathOverlay(map));

    if (this.playbackPose) {
      this._attrPass('arrow', {
        drawFunction: '_drawLocalPlaybackArrow',
        geometryCollection: 'playbackPose',
        geometryObjectCount: 1,
        pointCount: 1,
      }, () => {
      this._drawLocalPlaybackArrow(null, this.playbackPose);
      if (this.movementDisplay) {
        const pose = this.playbackPose;
        const disp = this._useExactDisplayCorrection()
          ? (() => {
            const VDC = typeof window !== 'undefined' ? window.ViewerDisplayCorrections : null;
            const t = VDC?.transformDisplayPoint
              ? VDC.transformDisplayPoint(pose.east, pose.north)
              : { east: pose.east, north: -pose.north };
            return { east: t.east, north: t.north };
          })()
          : pose;
        this._drawVehicleMovementIndicator(
          disp.east,
          disp.north,
          null,
        );
      }
      });
    }

    this._drawGeometryDiagnosticOverlays(map);

    if (this._lateralAxisDebug) {
      this._drawLateralAxisDiagnostic(d, map, elapsedIdx);
    }

    if (this._segment1LaneOrderDebug) {
      this._drawSegment1LaneOrderDiagnostic(map);
    }

    if (this._mirrorDebug) {
      this._logMirrorDebug(map);
    }

    if (this._obsDebug && (this.localGeometryMode === 'observations' || this.localGeometryMode === 'pointAccumulated')) {
      this._drawObservationDebugOverlay(d, map, elapsedIdx);
    }
  }

  /**
   * Lateral-axis diagnostic (optional, ?lateralDebug=1).
   * Draws "vehicle left"/"vehicle right" labels, the lateral positive
   * direction, the vehicle centreline, and per-lane boundary labels showing
   * track ID, source lane index, and signed lateral offset in the
   * segment-local frame (north = vehicle-left positive). Pure display
   * diagnostic; never alters stored geometry.
   */
  _drawLateralAxisDiagnostic(d, map, elapsedIdx) {
    const ctx = this.ctx;
    const ref = map?.referencePose;
    const arrow = this.playbackPose;
    const LP = typeof window !== 'undefined' ? window.LocalPlayback : null;

    ctx.save();
    ctx.font = '11px monospace';

    // --- vehicle centreline + left/right labels at the arrow ---
    if (arrow && this.worldToScreen) {
      const as = this.worldToScreen(arrow.east, arrow.north);
      const headingRad = (arrow.headingDeg ?? 0) * Math.PI / 180;
      // left direction in segment-local frame: left = (-sin? no) left in ENU
      // is (-cos h, +sin h) east/north -> in segment-local (east=forward,
      // north=left) left = (0, +1). Use local north axis for left.
      const arrowFwd = { x: Math.sin(headingRad), y: -Math.cos(headingRad) };
      const leftScreen = { x: -arrowFwd.y, y: arrowFwd.x }; // rotate -90 (left)
      const len = 55;
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(as.x, as.y);
      ctx.lineTo(as.x + leftScreen.x * len, as.y + leftScreen.y * len);
      ctx.moveTo(as.x, as.y);
      ctx.lineTo(as.x - leftScreen.x * len, as.y - leftScreen.y * len);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#16a34a';
      ctx.fillText('VEHICLE LEFT', as.x + leftScreen.x * (len + 4) - 40, as.y + leftScreen.y * (len + 4));
      ctx.fillStyle = '#dc2626';
      ctx.fillText('VEHICLE RIGHT', as.x - leftScreen.x * (len + 4) - 45, as.y - leftScreen.y * (len + 4));
      ctx.fillStyle = '#111';
      ctx.fillText('vehicle centreline (arrow)', as.x + 10, as.y + 14);
    }

    // --- per-lane boundary labels: track ID, lane index, signed lateral ---
    const frame = d?.frames?.[elapsedIdx];
    const lanes = frame?.lanes || [];
    const laneLabels = [];
    const arrowScreenForSide = arrow ? this.worldToScreen(arrow.east, arrow.north) : null;
    for (const lane of lanes) {
      const near = (lane.points || []).filter((p) => Math.abs(p.modelX) < 3)
        .sort((a, b) => Math.abs(a.modelX) - Math.abs(b.modelX))[0];
      if (!near || !ref) continue;
      const sl = this._globalToLocal(near.east, near.north, ref);
      const screen = this.roadGeometryToScreen(sl.east, sl.north);
      // Side is relative to the displayed vehicle centreline (mirror-aware).
      const side = arrowScreenForSide
        ? (screen.y < arrowScreenForSide.y ? 'LEFT' : screen.y > arrowScreenForSide.y ? 'RIGHT' : '?')
        : (sl.north < 0 ? 'RIGHT' : sl.north > 0 ? 'LEFT' : '?');
      const color = this.trackColor(lane.laneTrackId ?? 0);
      laneLabels.push({
        laneIndex: lane.laneIndex, trackId: lane.laneTrackId ?? null,
        prob: lane.prob, screenX: screen.x, screenY: screen.y,
        side, lateralM: +sl.north.toFixed(2), color,
      });
      ctx.fillStyle = color;
      ctx.fillText(
        `T${lane.laneTrackId ?? '?'} lane${lane.laneIndex} ${side} ${sl.north.toFixed(2)}m`,
        screen.x + 6, screen.y - 4,
      );
    }

    // --- summary panel ---
    const arrowNorth = arrow?.north;
    const ego = [];
    for (const l of laneLabels) {
      if (l.side === 'RIGHT' || l.side === 'LEFT') ego.push(l);
    }
    const rightEgo = ego.filter((l) => l.side === 'RIGHT').sort((a, b) => b.lateralM - a.lateralM)[0];
    const leftEgo = ego.filter((l) => l.side === 'LEFT').sort((a, b) => a.lateralM - b.lateralM)[0];
    const lines = [
      'Lateral-axis diagnostic (display only)',
      `ref heading: ${ref?.headingDeg?.toFixed(2) ?? '—'}  arrow heading: ${arrow?.headingDeg?.toFixed(2) ?? '—'}`,
      `segment-local frame: east=forward, north=vehicle-left (+)`,
      `arrow (vehicle centre) north: ${arrowNorth != null ? arrowNorth.toFixed(2) : '—'} m`,
      rightEgo ? `right ego boundary: T${rightEgo.trackId} lane${rightEgo.laneIndex} @ ${rightEgo.lateralM} m` : 'right ego boundary: none',
      leftEgo ? `left ego boundary: T${leftEgo.trackId} lane${leftEgo.laneIndex} @ ${leftEgo.lateralM} m` : 'left ego boundary: none',
      rightEgo && leftEgo
        ? `ego vehicle between boundaries: ${rightEgo.lateralM < (arrowNorth ?? 0) && (arrowNorth ?? 0) < leftEgo.lateralM}`
        : 'ego containment: not determinable (need both boundaries)',
    ];
    let boxY = 8;
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.strokeStyle = '#94a3b8';
    ctx.fillRect(10, boxY, 320, lines.length * 14 + 8);
    ctx.strokeRect(10, boxY, 320, lines.length * 14 + 8);
    ctx.fillStyle = '#111';
    lines.forEach((ln, i) => {
      ctx.fillText(ln, 16, boxY + 16 + i * 13);
    });
    ctx.restore();
  }

  _drawSegment1LaneOrderDiagnostic(map) {
    const diag = typeof window !== 'undefined' ? window.Segment1LaneOrderDiagnostic : null;
    if (!diag?.drawOverlay) return;
    const frameId = diag.PRIMARY_FRAME_ID;
    const mode = map?.boundaryAnchoredOrientationActive ? 'combined' : 'standalone';
    diag.drawOverlay(this, map, frameId, mode, this._segment1LaneOrderExpectedMap);
  }

  _drawPointAccumulatedGeometry(map, elapsedIdx) {
    const pa = map?.pointAccumulated;
    if (!pa) return;
    const ctx = this.ctx;
    const all = pa.points || [];
    // Complete map by default: show every valid point from all observations.
    // Causal playback (optional): display observations 0..elapsedIdx only.
    // Observation isolation (debug): show only the selected observation.
    // Display-only filters; coordinates are unchanged either way.
    let pts = all;
    if (this._obsIsolationActive()) {
      pts = all.filter((p) => this._obsMatches(p.frameIndex, p.laneIndex));
    } else if (this._pointCausalPlayback) {
      const elapsed = Math.max(0, Number(elapsedIdx) || 0);
      pts = all.filter((p) => p.frameIndex != null ? p.frameIndex <= elapsed : true);
    }

    if (!this._pointTrackColorCache) {
      const trackIds = [...new Set(all.map((p) => p.groupTrackId).filter((x) => x != null))];
      this._pointTrackColorCache = new Map(trackIds.map((id, i) => [id, this.trackColor(id ?? i)]));
    }

    // Small readable radius; density stays legible.
    const r = Math.max(2, Math.min(4.5, this.scale * 0.35));
    const neutral = 'rgba(148,163,184,0.9)';
    const tintOn = this._pointReliabilityTint && typeof MappingReliability !== 'undefined';
    const bMode = this._experimentalBoundariesMode;
    const showDots = bMode !== 'boundaries';

    // Default-off: form coloured lane polylines from the same accumulated dots
    // after their draw-time display projection (including combinedVisibleLaneProjection).
    if (this._pointAccumulatedLanePolylineEnabled && showDots && pts.length) {
      this._attrPass('pointAccumulatedLanePolylines', {
        drawFunction: '_drawPointAccumulatedLanePolylines',
        uiControl: 'pointAccumulatedLanePolylineCandidate',
        enabled: true,
        geometryCollection: 'pointAccumulated.points→polylines',
        geometryObjectCount: pts.length,
      }, () => this._drawPointAccumulatedLanePolylines(map, pts));
    }

    if (showDots && this.layers.fused) {
      this._attrPass('pointAccumulatedLanes', {
        drawFunction: '_drawPointAccumulatedGeometry.dots',
        rendererStateField: 'layers.fused',
        uiControl: 'layerFusedLanes',
        enabled: this.layers.fused,
        geometryCollection: 'pointAccumulated.points',
        geometryObjectCount: pts.length,
        pointCount: pts.length,
        coordinateFramePopulation: window.CanvasLayerAttribution?.summarizeCoordinateFrames?.(pts) ?? {},
        sourceProvenanceCoveragePct: window.CanvasLayerAttribution?.sourceProvenanceCoveragePct?.(pts) ?? 0,
        fillColours: ['rgba(124,58,237,0.9)', 'rgba(8,145,178,0.9)', 'rgba(148,163,184,0.9)'],
      }, () => {
      this._visibleLaneProjectionPass = 'pointAccumulated';
      for (let idx = 0; idx < pts.length; idx++) {
        const pt = pts[idx];
        if (!Number.isFinite(pt.localEast) || !Number.isFinite(pt.localNorth)) continue;
        let p = this._projectRoadGeometryToScreen(pt.localEast, pt.localNorth, pt.mirroredLocalEast, pt.mirroredLocalNorth, pt);
        let color = neutral;
        if (tintOn && pt.reliability?.combinedScore != null) {
          color = MappingReliability.tintColorForScore(pt.reliability.combinedScore, 0.9);
        } else if (pt.groupTrackId != null && this._pointTrackColorCache?.has?.(pt.groupTrackId)) {
          color = this._pointTrackColorCache.get(pt.groupTrackId);
        } else if (pt.side === 'left') {
          color = 'rgba(124,58,237,0.9)';
        } else if (pt.side === 'right') {
          color = 'rgba(8,145,178,0.9)';
        }
        if (this._lanePixelOwnerEnabled) {
          const source = { ...pt, _diagCollection: 'pointAccumulated.points' };
          p = this._lanePixelOwnerMaybePerturbScreen(p, source);
          this._lanePixelOwnerRecord({
            drawPass: 'pointAccumulatedLanes',
            drawFunction: '_drawPointAccumulatedGeometry.dots',
            geometryCollection: 'pointAccumulated.points',
            sourceArrayIndex: idx,
            sourceFile: pt.sourceFile ?? null,
            frameId: pt.frameId ?? pt.frameIndex ?? null,
            laneIndex: pt.laneIndex ?? null,
            groupTrackId: pt.groupTrackId ?? null,
            selectedFields: this._usesCombinedPlacedFrame(pt)
              ? ['placedEast', 'placedNorth']
              : ['localEast', 'localNorth', 'mirroredLocalEast', 'mirroredLocalNorth'],
            inputCoords: {
              localEast: pt.localEast,
              localNorth: pt.localNorth,
              placedEast: pt.placedEast ?? null,
              placedNorth: pt.placedNorth ?? null,
              mirroredLocalEast: pt.mirroredLocalEast ?? null,
              mirroredLocalNorth: pt.mirroredLocalNorth ?? null,
              coordinateFrame: pt.coordinateFrame ?? null,
            },
            projectedPixel: { x: p.x, y: p.y },
            colour: color,
            radius: r,
            kind: 'dot',
          });
        }
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      this._visibleLaneProjectionPass = null;
      });
    }

    if (this.layers.connectedAccumulated) {
      this._attrPass('connectedAccumulated', {
        drawFunction: '_drawConnectedAccumulatedPolylines',
        rendererStateField: 'layers.connectedAccumulated',
        uiControl: 'layerConnectedAccumulated',
        enabled: this.layers.connectedAccumulated,
        geometryCollection: 'connectedAccumulatedPolylines',
      }, () => this._drawConnectedAccumulatedPolylines(map, elapsedIdx, pts));
    }

    if (this.layers.representativeLaneLines) {
      this._attrPass('representativeLaneLines', {
        drawFunction: '_drawRepresentativeLaneLines',
        rendererStateField: 'layers.representativeLaneLines',
        uiControl: 'layerRepresentativeLaneLines',
        enabled: this.layers.representativeLaneLines,
        geometryCollection: 'representativeLaneLines',
      }, () => this._drawRepresentativeLaneLines(map, elapsedIdx, pts));
    }

    if (bMode === 'boundaries' || bMode === 'combined') {
      this._attrPass('experimentalBoundaries', {
        drawFunction: '_drawExperimentalBoundaries',
        uiControl: 'expBoundariesMode',
        enabled: bMode !== 'off',
        geometryCollection: 'experimentalBoundaries',
      }, () => this._drawExperimentalBoundaries(map, elapsedIdx, pts));
    }

    if (this.layers.constructedFragments && typeof ConstructedFragments !== 'undefined') {
      const hybridActive = this.layers.fittedPolylines
        && map?.pointAccumulated?.hybridFittedBoundaries?.boundaries?.length;
      if (!hybridActive) {
        this._attrPass('constructedFragments', {
          drawFunction: '_drawConstructedFragments',
          rendererStateField: 'layers.constructedFragments',
          uiControl: 'layerConstructedFragments',
          enabled: this.layers.constructedFragments,
          geometryCollection: 'constructedFragments',
          geometryObjectCount: map?.pointAccumulated?.constructedFragments?.fragments?.length ?? 0,
          dashState: [6, 3],
        }, () => this._drawConstructedFragments(map, elapsedIdx, pts));
      }
    }

    if (this.layers.joinCandidates && typeof LaneJoining !== 'undefined') {
      this._attrPass('joinCandidates', {
        drawFunction: '_drawJoinCandidates',
        enabled: this.layers.joinCandidates,
      }, () => this._drawJoinCandidates(map, elapsedIdx, pts));
    }

    if (this.layers.joinedPolylines && typeof LaneJoining !== 'undefined') {
      this._attrPass('joinedPolylines', {
        drawFunction: '_drawJoinedPolylines',
        rendererStateField: 'layers.joinedPolylines',
        uiControl: 'layerJoinedPolylines',
        enabled: this.layers.joinedPolylines,
        geometryCollection: 'joinedPolylines',
      }, () => this._drawJoinedPolylines(map, elapsedIdx, pts));
    }

    if (this.layers.fittedPolylines && typeof GraphFit !== 'undefined') {
      const hybrid = pa?.hybridFittedBoundaries;
      if (hybrid?.boundaries?.length) {
        this._attrPass('hybridBoundaries', {
          drawFunction: '_drawHybridFittedBoundaries',
          rendererStateField: 'layers.fittedPolylines',
          uiControl: 'layerFittedPolylines',
          enabled: this.layers.fittedPolylines,
          geometryCollection: 'hybridFittedBoundaries',
          geometryObjectCount: hybrid.boundaries.length,
          dashState: [5, 4],
        }, () => this._drawHybridFittedBoundaries(map, elapsedIdx, pts));
      } else {
        this._attrPass('fittedPolylines', {
          drawFunction: '_drawFittedPolylines',
          rendererStateField: 'layers.fittedPolylines',
          enabled: this.layers.fittedPolylines,
        }, () => this._drawFittedPolylines(map, elapsedIdx, pts));
      }
    }

    if (this.layers.fittedOutliers && typeof GraphFit !== 'undefined') {
      this._attrPass('fittedOutliers', {
        drawFunction: '_drawFittedOutliers',
        enabled: this.layers.fittedOutliers,
      }, () => this._drawFittedOutliers(map, elapsedIdx, pts));
    }

    if (this.layers.fittedUnverified && typeof GraphFit !== 'undefined') {
      this._attrPass('fittedUnverified', {
        drawFunction: '_drawFittedUnverified',
        enabled: this.layers.fittedUnverified,
      }, () => this._drawFittedUnverified(map, elapsedIdx, pts));
    }

    if (this.layers.fittedGaps && typeof GraphFit !== 'undefined') {
      this._attrPass('fittedGaps', {
        drawFunction: '_drawFittedGaps',
        enabled: this.layers.fittedGaps,
      }, () => this._drawFittedGapMarkers(map, elapsedIdx, pts));
    }

    if (tintOn) this._drawReliabilityLegend();
  }

  /**
   * Connected accumulated lane observations (viewer-only experiment).
   * Draws per-frame curves through same-identity accumulated dots.
   */
  _drawConnectedAccumulatedPolylines(map, elapsedIdx, visiblePoints) {
    const CAD = typeof window !== 'undefined' ? window.ConnectedAccumulatedDisplay : null;
    if (!CAD?.buildConnectedPolylines) return;

    const pa = map?.pointAccumulated;
    if (!pa) return;

    const displayMode = this._connectedAccumulatedMode === 'perFrame' ? 'perFrame' : 'currentFrame';
    let polylines = this._connectedAccumulatedPolylines;
    let stats = this._connectedAccumulatedStats;
    const needsRebuild = this._pointCausalPlayback || this._obsIsolationActive();
    if (needsRebuild) {
      const sourcePts = this._obsIsolationActive()
        ? (visiblePoints || [])
        : CAD.filterPointsForCausal(pa.points || [], elapsedIdx);
      const built = CAD.buildPerFrameConnectedPolylines(sourcePts);
      if (displayMode === 'currentFrame') {
        const activeFrame = {
          frameIndex: elapsedIdx,
          logMonoTime: (pa.points || []).find((p) => p.frameIndex === elapsedIdx)?.logMonoTime ?? null,
        };
        const display = CAD.buildCurrentFrameDisplay(built.polylines, activeFrame, built.stats);
        polylines = display.polylines;
        stats = display.stats;
      } else {
        polylines = built.polylines;
        stats = built.stats;
      }
    }
    if (!polylines?.length) {
      this._connectedAccumulatedDrawn = false;
      if (stats?.noFrameMessage) {
        const ctx = this.ctx;
        ctx.save();
        ctx.font = '12px sans-serif';
        ctx.fillStyle = '#b45309';
        ctx.fillText(stats.noFrameMessage, 10, 182);
        ctx.restore();
      }
      return;
    }

    const isCurrentFrame = (stats?.mode ?? displayMode) === 'currentFrame';

    if (!this._pointTrackColorCache) {
      const all = pa.points || [];
      const trackIds = [...new Set(all.map((p) => p.groupTrackId).filter((x) => x != null))];
      this._pointTrackColorCache = new Map(trackIds.map((id, i) => [id, this.trackColor(id ?? i)]));
    }

    const ctx = this.ctx;
    let stroked = 0;
    ctx.save();
    try {
      for (const poly of polylines) {
        if (!poly.points || poly.points.length < 2) continue;
        let color = '#94a3b8';
        if (poly.groupTrackId != null && this._pointTrackColorCache?.has?.(poly.groupTrackId)) {
          color = this._pointTrackColorCache.get(poly.groupTrackId);
        } else if (poly.side === 'left') {
          color = 'rgba(124,58,237,0.9)';
        } else if (poly.side === 'right') {
          color = 'rgba(8,145,178,0.9)';
        }
        ctx.strokeStyle = color;
        const repOn = !!this.layers.representativeLaneLines;
        ctx.globalAlpha = isCurrentFrame ? 0.9 : (repOn ? 0.28 : 0.62);
        ctx.lineWidth = isCurrentFrame ? 3 : (repOn ? 1.6 : 2.25);
        ctx.setLineDash([]);
        ctx.beginPath();
        let moved = false;
        for (const pt of poly.points) {
          if (!Number.isFinite(pt.localEast) || !Number.isFinite(pt.localNorth)) continue;
          const p = this._projectRoadGeometryToScreen(pt.localEast, pt.localNorth, pt.mirroredLocalEast, pt.mirroredLocalNorth, pt);
          if (!moved) { ctx.moveTo(p.x, p.y); moved = true; }
          else ctx.lineTo(p.x, p.y);
        }
        if (moved) {
          ctx.stroke();
          stroked++;
        }
      }
      ctx.globalAlpha = 1;

      const pointCount = stats?.observationCount ?? stats?.finitePointCount ?? (pa.points || []).length;
      ctx.font = '12px sans-serif';
      if (isCurrentFrame) {
        const frameLabel = stats?.selectedFrameKey ?? stats?.selectedFrameId ?? '—';
        ctx.fillStyle = '#0f766e';
        ctx.fillText('Connected accumulated observations — current frame (experimental)', 10, 182);
        ctx.fillStyle = '#64748b';
        ctx.fillText(`Frame ${frameLabel} / ${stroked} lane curves / ${pointCount} observations`, 10, 196);
        ctx.fillText('Each line contains one modelV2 frame only', 10, 210);
        ctx.fillText('Unconfirmed display only', 10, 224);
      } else {
        const frameCount = stats?.frameGroupCount
          ? new Set(polylines.map((pl) => pl.frameId ?? `fi:${pl.frameIndex}`)).size
          : new Set(polylines.map((pl) => pl.frameId ?? `fi:${pl.frameIndex}`)).size;
        ctx.fillStyle = '#0f766e';
        ctx.fillText('Connected accumulated observations — all per-frame (experimental)', 10, 182);
        ctx.fillStyle = '#64748b';
        ctx.fillText(`${stroked} frame polylines from ${frameCount} frames / ${pointCount} observations`, 10, 196);
        ctx.fillText('Each line contains one modelV2 frame only', 10, 210);
        ctx.fillText('Unconfirmed display only', 10, 224);
      }
    } finally {
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.restore();
    }

    this._connectedAccumulatedPolylines = polylines;
    this._connectedAccumulatedStats = stats;
    this._connectedAccumulatedDrawn = stroked > 0;
  }

  /**
   * Representative lane lines candidate — reuses robust bin-median stage on
   * points from accepted All per-frame curves. Thicker than source curves.
   */
  _drawRepresentativeLaneLines(map, elapsedIdx, visiblePoints) {
    const CAD = typeof window !== 'undefined' ? window.ConnectedAccumulatedDisplay : null;
    if (!CAD?.buildRepresentativeLaneLinesFromPerFrame || !CAD?.buildPerFrameConnectedPolylines) {
      this._representativeLaneLinesDiagnostics = { candidateActive: false, error: 'moduleMissing' };
      return;
    }
    const pa = map?.pointAccumulated;
    if (!pa?.points?.length) {
      this._representativeLaneLinesDiagnostics = { candidateActive: false, error: 'noPoints' };
      return;
    }

    let perFrame = this._connectedAccumulatedPolylines;
    let perFrameStats = this._connectedAccumulatedStats;
    const modeOk = (perFrameStats?.mode === 'perFrame')
      || this._connectedAccumulatedMode === 'perFrame';
    if (!perFrame?.length || !modeOk || this._pointCausalPlayback || this._obsIsolationActive()) {
      const sourcePts = this._obsIsolationActive()
        ? (visiblePoints || [])
        : (this._pointCausalPlayback
          ? CAD.filterPointsForCausal(pa.points || [], elapsedIdx)
          : (pa.points || []));
      const built = CAD.buildPerFrameConnectedPolylines(sourcePts);
      perFrame = built.polylines;
      perFrameStats = built.stats;
    }

    const search = typeof window !== 'undefined' ? window.location.search : '';
    const requested = resolveRepresentativeMethod(search);
    // Availability guard only (does not change the selected method when the
    // builder exists). Falls back to the corrected association builder.
    const hasBuilder = {
      legacy: !!CAD.buildRepresentativeLaneLinesLegacyFromPerFrame,
      purityRevisit: !!CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame,
      purity: !!CAD.buildRepresentativeLaneLinesPurityFromPerFrame,
      curveAssociation: !!CAD.buildRepresentativeLaneLinesFromPerFrame,
    };
    const method = hasBuilder[requested] ? requested : 'curveAssociation';
    const built = method === 'legacy'
      ? CAD.buildRepresentativeLaneLinesLegacyFromPerFrame(perFrame || [])
      : (method === 'purityRevisit'
        ? CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(perFrame || [])
        : (method === 'purity'
          ? CAD.buildRepresentativeLaneLinesPurityFromPerFrame(perFrame || [])
          : CAD.buildRepresentativeLaneLinesFromPerFrame(perFrame || [])));
    built.method = method;
    this._representativeLaneLines = built.polylines;
    this._representativeLaneLinesDiagnostics = built.stats || null;

    if (!this._pointTrackColorCache) {
      const trackIds = [...new Set((pa.points || []).map((p) => p.groupTrackId).filter((x) => x != null))];
      this._pointTrackColorCache = new Map(trackIds.map((id, i) => [id, this.trackColor(id ?? i)]));
    }

    const ctx = this.ctx;
    let stroked = 0;
    ctx.save();
    try {
      for (const poly of built.polylines || []) {
        if (!poly.points || poly.points.length < 2) continue;
        let color = '#0f766e';
        if (poly.groupTrackId != null && this._pointTrackColorCache?.has?.(poly.groupTrackId)) {
          color = this._pointTrackColorCache.get(poly.groupTrackId);
        }
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.95;
        ctx.lineWidth = Math.max(4, Math.min(5.5, this.scale * 0.35));
        ctx.setLineDash([]);
        ctx.beginPath();
        let moved = false;
        for (const pt of poly.points) {
          if (!Number.isFinite(pt.localEast) || !Number.isFinite(pt.localNorth)) continue;
          const p = this._projectRoadGeometryToScreen(
            pt.localEast, pt.localNorth, pt.mirroredLocalEast, pt.mirroredLocalNorth, pt,
          );
          if (!moved) { ctx.moveTo(p.x, p.y); moved = true; }
          else ctx.lineTo(p.x, p.y);
        }
        if (moved) { ctx.stroke(); stroked += 1; }
      }
      ctx.globalAlpha = 1;
      ctx.font = '12px sans-serif';
      ctx.fillStyle = '#0f766e';
      ctx.fillText('Representative lane lines (candidate — from All per-frame)', 10, 250);
      ctx.fillStyle = '#64748b';
      const d = built.stats || {};
      ctx.fillText(
        `${stroked} lines · ${d.sourceFrameCount ?? 0} frames · ${d.sourceCurveCount ?? 0} curves · rejected ${d.rejectedCurveCount ?? 0}`,
        10,
        264,
      );
    } finally {
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  /**
   * Hybrid graph-fitted lane map (EXPERIMENTAL). One boundary per fragment:
   * solid cyan for accepted fits, dashed lane-colour fallback for rejected or
   * unfitted fragments. Complete-map only; never bridges gaps or joins fragments.
   */
  _drawHybridFittedBoundaries(map, elapsedIdx, visiblePoints) {
    const pa = map?.pointAccumulated;
    const hybrid = pa?.hybridFittedBoundaries;
    if (!hybrid?.boundaries?.length) return;
    if (this._fitCompleteMapOnlyGuard()) return;
    const ctx = this.ctx;
    let fittedN = 0;
    let fallbackN = 0;
    let stroked = 0;

    for (const b of hybrid.boundaries) {
      const polylines = b.polylines || [];
      if (!polylines.length) continue;
      if (b.displaySource === 'acceptedFit') {
        ctx.strokeStyle = '#06b6d4';
        ctx.lineWidth = 4;
        ctx.setLineDash([]);
        fittedN++;
      } else {
        const bc = this.boundaryColor(b.groupTrackId);
        ctx.strokeStyle = bc.color;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        fallbackN++;
      }
      for (const poly of polylines) {
        if (this._strokeLocalPolyline(poly)) {
          stroked++;
          if (b.displaySource === 'acceptedFit' && this.layers.fittedEndpoints) {
            this._drawFittedEndpointMarkers(poly);
          }
        }
      }
      ctx.setLineDash([]);
    }

    this._hybridFittedBoundaries = hybrid.boundaries;
    this._hybridFittedStroked = stroked;
    ctx.save();
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#0e7490';
    ctx.fillText(
      `Hybrid fitted lane map — ${fittedN} fitted / ${fallbackN} fallback (${hybrid.stats?.totalFragments ?? 0} fragments)`,
      10,
      68,
    );
    if (fallbackN > 0) {
      ctx.fillStyle = '#b45309';
      ctx.fillText('Dashed = constructed-fragment fallback (hover for rejection status)', 10, 82);
    }
    ctx.restore();
  }

  /**
   * Graph-fitted lane-boundary curves (EXPERIMENTAL, Path 1). Only
   * status === 'accepted' curves enter this layer. Curves that could not be
   * validated (validationInsufficient) appear only under the separate dashed
   * diagnostic toggle; no fitted or unverified curve feeds polygons.
   *
   * Fitted curves are COMPLETE-MAP ONLY: the fit uses all observations, so it
   * must never be shown while causal playback is advancing (that would leak
   * future observations). During causal playback the fitted layers are
   * suppressed and a notice is shown; the fitter is NOT invoked.
   */
  _drawFittedPolylines(map, elapsedIdx, visiblePoints) {
    const pa = map?.pointAccumulated;
    const fp = pa?.fittedPolylines;
    if (!fp || typeof GraphFit === 'undefined') return;
    const ctx = this.ctx;
    if (this._fitCompleteMapOnlyGuard()) return;
    const results = fp.results || [];
    let stroked = 0;
    for (const r of results) {
      if (r.status !== 'accepted' || !r.fittedPolyline) continue;
      const polys = this._normalizeFittedPolylines(r.fittedPolyline);
      // Distinct experimental styling: cyan/purple solid, thicker than fragments/joined.
      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 4;
      ctx.setLineDash([]);
      for (const poly of polys) {
        if (this._strokeLocalPolyline(poly)) stroked++;
        if (this.layers.fittedEndpoints) {
          this._drawFittedEndpointMarkers(poly);
        }
      }
      ctx.setLineDash([]);
    }
    const accepted = results.filter((r) => r.status === 'accepted').length;
    ctx.save();
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#065f46';
    ctx.fillText(`Graph-fitted lane boundaries (experimental) — ${accepted} accepted`, 10, 68);
    ctx.restore();
    this._fittedPolylinesStroked = stroked;
  }

  /** Rejected-outlier evidence from the fitter, drawn as small X markers. */
  _drawFittedOutliers(map, elapsedIdx, visiblePoints) {
    if (this._fitCompleteMapOnlyGuard()) return;
    const fp = map?.pointAccumulated?.fittedPolylines;
    if (!fp) return;
    const ctx = this.ctx;
    const results = fp.results || [];
    ctx.fillStyle = 'rgba(244,63,94,0.9)';
    for (const r of results) {
      for (const seg of r.segments || []) {
        if (seg.rejectedOutliers && seg.rejectedOutliers.length) {
          for (const o of seg.rejectedOutliers) {
            if (o.east == null || o.north == null) continue;
            const p = this.roadGeometryToScreen(o.east, o.north, o.mirroredEast, o.mirroredNorth);
            const s = 3;
            ctx.beginPath();
            ctx.moveTo(p.x - s, p.y - s); ctx.lineTo(p.x + s, p.y + s);
            ctx.moveTo(p.x + s, p.y - s); ctx.lineTo(p.x - s, p.y + s);
            ctx.stroke();
          }
        }
      }
    }
  }

  /** Unverified fits (validationInsufficient) drawn dashed, diagnostic-only. */
  _drawFittedUnverified(map, elapsedIdx, visiblePoints) {
    if (this._fitCompleteMapOnlyGuard()) return;
    const fp = map?.pointAccumulated?.fittedPolylines;
    if (!fp) return;
    const ctx = this.ctx;
    const results = fp.results || [];
    for (const r of results) {
      if (r.status !== 'validationInsufficient' || !r.fittedPolyline) continue;
      const polys = this._normalizeFittedPolylines(r.fittedPolyline);
      ctx.strokeStyle = 'rgba(217,119,6,0.9)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 4]);
      for (const poly of polys) {
        this._strokeLocalPolyline(poly);
      }
    }
    ctx.setLineDash([]);
  }

  /** Gap-break markers along accepted fitted curves (diagnostic). */
  _drawFittedGapMarkers(map, elapsedIdx, visiblePoints) {
    if (this._fitCompleteMapOnlyGuard()) return;
    const fp = map?.pointAccumulated?.fittedPolylines;
    if (!fp) return;
    const ctx = this.ctx;
    const results = fp.results || [];
    for (const r of results) {
      if (r.status !== 'accepted') continue;
      for (const seg of r.segments || []) {
        const g = seg.gapMarkers || [];
        ctx.fillStyle = 'rgba(217,119,6,0.95)';
        for (const mk of g) {
          if (mk.east == null || mk.north == null) continue;
          const p = this.roadGeometryToScreen(mk.east, mk.north, mk.mirroredEast, mk.mirroredNorth);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  /**
   * Screen transform for fitted/unverified vertices. Uses the same
   * roadGeometryToScreen path as constructed fragments: segment-local
   * east/north with precomputed mirroredEast/mirroredNorth. Vertices without
   * a declared segment-local frame or required mirror fields are not drawn.
   */
  _fittedVertexScreen(v) {
    if (v.east == null || v.north == null) return null;
    if (v.coordinateFrame === 'combinedPlaced' || this._usesCombinedPlacedFrame(v)) {
      return this._projectRoadGeometryToScreen(v.east, v.north, v.mirroredEast, v.mirroredNorth, v);
    }
    if (v.coordinateFrame && v.coordinateFrame !== 'segmentLocal') return null;
    if (this._mirrorRoadLateralDisplay) {
      if (v.mirroredEast == null || v.mirroredNorth == null) return null;
    }
    return this.roadGeometryToScreen(v.east, v.north, v.mirroredEast, v.mirroredNorth, v);
  }

  _strokeLocalPolyline(poly) {
    const ctx = this.ctx;
    if (!poly || !poly.length) return false;
    ctx.beginPath();
    let moved = false;
    for (const v of poly) {
      const p = this._fittedVertexScreen(v);
      if (!p) continue;
      if (!moved) { ctx.moveTo(p.x, p.y); moved = true; }
      else ctx.lineTo(p.x, p.y);
    }
    if (moved) {
      ctx.stroke();
      return true;
    }
    return false;
  }

  /** Small endpoint markers for accepted fitted curves (display-only). */
  _drawFittedEndpointMarkers(poly) {
    if (!poly || poly.length < 2) return;
    const ctx = this.ctx;
    const endpoints = [poly[0], poly[poly.length - 1]];
    ctx.fillStyle = '#a855f7';
    for (const v of endpoints) {
      const p = this._fittedVertexScreen(v);
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Returns true when fitted layers must be suppressed because causal playback
   * is advancing (fitted curves are complete-map-only). Draws a notice once per
   * frame. The fitter is NEVER invoked from normal playback.
   */
  _fitCompleteMapOnlyGuard() {
    if (!(this._pointCausalPlayback && !this._obsIsolationActive())) return false;
    this._drawFitCausalUnavailable();
    return true;
  }

  /** Draw the "complete-map only" notice when fit toggles are on during causal. */
  _drawFitCausalUnavailable() {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#b45309';
    ctx.fillText('Fitted curves are available in complete-map view only.', 10, 68);
    ctx.restore();
  }

  /**
   * Causal-fit rebuild (test-only / internal). NOT invoked from normal playback:
   * fitted layers are complete-map-only, so playback never calls this. Retained
   * so tests can exercise the API, but no draw path references it.
   */
  _rebuildFitsCausal(map, elapsed) {
    const pa = map?.pointAccumulated;
    if (!pa) return [];
    const bucket = Math.floor((Number(elapsed) || 0) / 20);
    const cacheKey = `causal-${bucket}`;
    if (!this._causalFitCache) this._causalFitCache = new Map();
    if (this._causalFitCache.has(cacheKey)) return this._causalFitCache.get(cacheKey);
    const causalPts = (pa.points || []).filter((p) => p.frameIndex != null ? p.frameIndex <= elapsed : true);
    const cf = ConstructedFragments.buildConstructedFragments(causalPts, {});
    const fit = GraphFit.fitConstructedRuns(cf.fragments || [], cf.runs || [], { ...(pa.fittedPolylines?.stats || {}), fitEnabled: true });
    this._causalFitCache.set(cacheKey, fit.results || []);
    return this._causalFitCache.get(cacheKey);
  }

  /**
   * Experimental lane-boundary overlay (display-only). Constructed from the
   * same point observations, in segment-local s/d frame, converted to local
   * east/north. Points are never modified. Only sections supported by multiple
   * observations are drawn; breaks are explicit.
   */
  _drawExperimentalBoundaries(map, elapsedIdx, visiblePoints) {
    const pa = map?.pointAccumulated;
    const baseEb = pa?.experimentalBoundaries;
    if (!baseEb || typeof ExperimentalBoundaries === 'undefined') return;
    const ctx = this.ctx;

    // Causal playback: rebuild the overlay from only the observations visible
    // at the current elapsed index (never uses future observations).
    let eb = baseEb;
    if (this._pointCausalPlayback && !this._obsIsolationActive()) {
      const elapsed = Math.max(0, Number(elapsedIdx) || 0);
      const causalPts = (pa.points || []).filter((p) => p.frameIndex != null ? p.frameIndex <= elapsed : true);
      eb = ExperimentalBoundaries.buildExperimentalBoundaries(causalPts, {
        candidate: baseEb.candidate,
      });
    } else if (this._obsIsolationActive()) {
      // Observation isolation: show sections supported by the selected obs.
      eb = ExperimentalBoundaries.buildExperimentalBoundaries(visiblePoints || [], {
        candidate: baseEb.candidate,
      });
    }

    // Lane 1 = right ego boundary (cyan), lane 2 = left ego boundary (violet).
    const laneColors = { 1: 'rgba(8,145,178,1)', 2: 'rgba(124,58,237,1)' };

    for (const [laneIndex, lane] of Object.entries(eb.lanes)) {
      const color = laneColors[laneIndex] || 'rgba(100,116,139,1)';
      for (const sec of lane.sections) {
        if (!sec.vertices?.length) continue;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([1, 0]);
        ctx.beginPath();
        let moved = false;
        for (const v of sec.vertices) {
          if (v.east == null || v.north == null) continue;
          const p = this.roadGeometryToScreen(v.east, v.north, v.mirroredEast, v.mirroredNorth, v);
          if (!moved) { ctx.moveTo(p.x, p.y); moved = true; }
          else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Label the overlay as experimental.
    this._drawExperimentalBoundariesLabel(eb);
  }

  _drawExperimentalBoundariesLabel(eb) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#b45309';
    ctx.fillText(`Experimental lane boundaries (candidate ${eb.candidate}) — display only`, 10, 20);
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#78716c';
    ctx.fillText(`sections: ${eb.sectionCount} · supported ${eb.supportedLengthM} m · topology warnings: ${eb.topology.count}`, 10, 34);
    ctx.restore();
  }

  /**
   * Constructed lane-boundary fragments (EXPERIMENTAL, display-only).
   * Short, reliable local polylines built from the accumulated point dots
   * (grouped by physical boundary, ordered by along-track s, connected only
   * when local checks pass, split on gaps/conflicts, smoothed locally). Never
   * replaces Raw/Fused/Candidate D/tracked outputs. Causal playback and
   * observation isolation rebuild the fragments from only the visible points.
   */
  _drawConstructedFragments(map, elapsedIdx, visiblePoints) {
    const pa = map?.pointAccumulated;
    const baseCf = pa?.constructedFragments;
    if (!baseCf) return;
    const ctx = this.ctx;

    let cf = baseCf;
    if (this._pointCausalPlayback && !this._obsIsolationActive()) {
      const elapsed = Math.max(0, Number(elapsedIdx) || 0);
      const causalPts = (pa.points || []).filter((p) => p.frameIndex != null ? p.frameIndex <= elapsed : true);
      cf = ConstructedFragments.buildConstructedFragments(causalPts);
    } else if (this._obsIsolationActive()) {
      cf = ConstructedFragments.buildConstructedFragments(visiblePoints || []);
    }

    let drawn = 0;
    for (const frag of cf.fragments || []) {
      if (!frag.points?.length) continue;
      const bc = this.boundaryColor(frag.groupTrackId);
      const color = bc.color;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      let moved = false;
      for (const v of frag.points) {
        if (v.east == null || v.north == null) continue;
        const p = this.roadGeometryToScreen(v.east, v.north, v.mirroredEast, v.mirroredNorth, v);
        if (!moved) { ctx.moveTo(p.x, p.y); moved = true; }
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      drawn++;
      if (this._constructedFragmentLabels && frag.points.length) {
        // Display-only diagnostic: label each fragment with its ID and split reason.
        const mid = frag.points[Math.floor((frag.points.length - 1) / 2)];
        const mp = this.roadGeometryToScreen(mid.east, mid.north, mid.mirroredEast, mid.mirroredNorth);
        ctx.save();
        ctx.font = '10px monospace';
        ctx.fillStyle = '#1e293b';
        const label = `${frag.fragmentId}${frag.splitReason ? `|${frag.splitReason}` : ''}`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(mp.x - 2, mp.y - 10, tw + 4, 14);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(mp.x - 2, mp.y - 10, tw + 4, 14);
        ctx.fillStyle = '#0f172a';
        ctx.fillText(label, mp.x, mp.y + 2);
        ctx.restore();
      }
    }

    ctx.save();
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#b45309';
    const labelText = this._constructedFragmentLabels
      ? `Constructed fragments (experimental) — ${drawn} fragments — IDs & split reasons`
      : `Constructed fragments (experimental) — ${drawn} fragments`;
    ctx.fillText(labelText, 10, 50);
    ctx.restore();
  }

  /**
   * Joined lane-boundary polylines (EXPERIMENTAL, display-only). Draws the
   * chained polyline over its source fragments and marks accepted connectors.
   * Source fragments are never modified; only the joined line and its
   * connector segments are drawn. Causal playback rebuilds from visible points.
   */
  _drawJoinedPolylines(map, elapsedIdx, visiblePoints) {
    const pa = map?.pointAccumulated;
    const base = pa?.joinedPolylines;
    if (!base || typeof LaneJoining === 'undefined') return;
    const ctx = this.ctx;

    let jp = base;
    if (this._pointCausalPlayback && !this._obsIsolationActive()) {
      const elapsed = Math.max(0, Number(elapsedIdx) || 0);
      const causalPts = (pa.points || []).filter((p) => p.frameIndex != null ? p.frameIndex <= elapsed : true);
      const cf = ConstructedFragments.buildConstructedFragments(causalPts);
      if (cf?.fragments?.length) jp = LaneJoining.joinConstructedFragments(cf.fragments, causalPts);
    } else if (this._obsIsolationActive()) {
      const cf = ConstructedFragments.buildConstructedFragments(visiblePoints || []);
      if (cf?.fragments?.length) jp = LaneJoining.joinConstructedFragments(cf.fragments, visiblePoints || []);
    }

    const laneColors = { 0: 'rgba(8,145,178,1)', 1: 'rgba(124,58,237,1)', 2: 'rgba(5,150,105,1)' };
    let drawn = 0;
    for (const poly of jp.joinedPolylines || []) {
      if (!poly.joinedPoints?.length) continue;
      const bc = this.boundaryColor(poly.groupTrackId != null ? poly.groupTrackId : null);
      const color = bc.color;
      // joined polyline (solid, thicker)
      ctx.strokeStyle = color;
      ctx.lineWidth = 3.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      let moved = false;
      for (const v of poly.joinedPoints) {
        if (v.east == null || v.north == null) continue;
        const p = this.roadGeometryToScreen(v.east, v.north, v.mirroredEast, v.mirroredNorth, v);
        if (!moved) { ctx.moveTo(p.x, p.y); moved = true; }
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      drawn++;
      // label joined polyline id
      if (this._constructedFragmentLabels && poly.joinedPoints.length) {
        const mid = poly.joinedPoints[Math.floor(poly.joinedPoints.length / 2)];
        const mp = this.roadGeometryToScreen(mid.east, mid.north, mid.mirroredEast, mid.mirroredNorth);
        ctx.save();
        ctx.font = '11px monospace';
        const label = `${poly.joinedPolylineId} (${poly.connectorCount} conns)`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fillRect(mp.x - 2, mp.y - 11, tw + 4, 15);
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1;
        ctx.strokeRect(mp.x - 2, mp.y - 11, tw + 4, 15);
        ctx.fillStyle = '#0f172a';
        ctx.fillText(label, mp.x, mp.y + 2);
        ctx.restore();
      }
    }

    ctx.save();
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#0f172a';
    ctx.fillText(`Joined lane polylines (experimental) — ${drawn} polylines`, 10, 68);
    ctx.restore();
  }

  /**
   * Join-candidate visualization (EXPERIMENTAL debug, display-only). Draws
   * every candidate connection with a colour/style encoding its decision:
   *   accepted        green solid
   *   hard-rejected   red dashed
   *   ambiguous       amber dashed (scored but not chosen)
   *   unsupported gap brown dotted
   * Clicking/hovering a connector shows its measurements (see hover handler).
   */
  _drawJoinCandidates(map, elapsedIdx, visiblePoints) {
    const pa = map?.pointAccumulated;
    const base = pa?.joinedPolylines;
    if (!base || typeof LaneJoining === 'undefined') return;
    const ctx = this.ctx;

    let jp = base;
    if (this._pointCausalPlayback && !this._obsIsolationActive()) {
      const elapsed = Math.max(0, Number(elapsedIdx) || 0);
      const causalPts = (pa.points || []).filter((p) => p.frameIndex != null ? p.frameIndex <= elapsed : true);
      const cf = ConstructedFragments.buildConstructedFragments(causalPts);
      if (cf?.fragments?.length) jp = LaneJoining.joinConstructedFragments(cf.fragments, causalPts);
    } else if (this._obsIsolationActive()) {
      const cf = ConstructedFragments.buildConstructedFragments(visiblePoints || []);
      if (cf?.fragments?.length) jp = LaneJoining.joinConstructedFragments(cf.fragments, visiblePoints || []);
    }

    const accepted = new Set(jp.connections.map((c) => `${c.fromFragmentId}->${c.toFragmentId}`));
    const styles = {
      accepted: { color: 'rgba(22,163,74,0.9)', dash: [], width: 2.5 },
      hard_rejected: { color: 'rgba(220,38,38,0.85)', dash: [6, 3], width: 1.5 },
      ambiguous: { color: 'rgba(245,158,11,0.9)', dash: [4, 4], width: 1.5 },
      unsupported: { color: 'rgba(120,72,16,0.9)', dash: [2, 3], width: 1.5 },
    };

    let rejectedCount = 0, ambiguousCount = 0, acceptedCount = 0, unsupportedCount = 0;
    for (const cand of jp.candidates || []) {
      const from = cand.from, to = cand.to;
      if (!from || !to) continue;
      const Ae = from.points[from.points.length - 1];
      const Bs = to.points[0];
      const key = `${from.fragmentId}->${to.fragmentId}`;
      let style;
      if (accepted.has(key)) { style = styles.accepted; acceptedCount++; }
      else if (!cand.pass && cand.reason && /unsupported|insufficient_evidence/.test(cand.reason)) { style = styles.unsupported; unsupportedCount++; }
      else if (!cand.pass) { style = styles.hard_rejected; rejectedCount++; }
      else { style = styles.ambiguous; ambiguousCount++; }

      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.width;
      ctx.setLineDash(style.dash);
      ctx.beginPath();
      const pA = this.roadGeometryToScreen(Ae.east, Ae.north, Ae.mirroredEast, Ae.mirroredNorth);
      const pB = this.roadGeometryToScreen(Bs.east, Bs.north, Bs.mirroredEast, Bs.mirroredNorth);
      ctx.moveTo(pA.x, pA.y);
      ctx.lineTo(pB.x, pB.y);
      ctx.stroke();
      ctx.setLineDash([]);

      // marker at midpoint
      const mx = (pA.x + pB.x) / 2, my = (pA.y + pB.y) / 2;
      ctx.fillStyle = style.color;
      ctx.beginPath();
      ctx.arc(mx, my, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.save();
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#0f172a';
    ctx.fillText(
      `Join candidates (debug) — accepted ${acceptedCount} · rejected ${rejectedCount} · ambiguous ${ambiguousCount} · unsupported ${unsupportedCount}`,
      10, 86,
    );
    ctx.restore();
  }

  /** Hover tooltip for hybrid fitted boundary segments. */
  _hybridFittedHover(screenX, screenY) {
    const hybrid = this.stationaryLocalMap?.pointAccumulated?.hybridFittedBoundaries;
    if (!hybrid?.boundaries?.length || !this.layers.fittedPolylines) return null;
    if (this._pointCausalPlayback) return null;
    let best = null;
    let bestD = Infinity;
    for (const b of hybrid.boundaries) {
      for (const poly of b.polylines || []) {
        for (let i = 1; i < poly.length; i++) {
          const v0 = poly[i - 1];
          const v1 = poly[i];
          const pA = this._fittedVertexScreen(v0);
          const pB = this._fittedVertexScreen(v1);
          if (!pA || !pB) continue;
          const seg = pB.x - pA.x;
          const sey = pB.y - pA.y;
          const len = Math.hypot(seg, sey) || 1e-9;
          const t = Math.max(0, Math.min(1, ((screenX - pA.x) * seg + (screenY - pA.y) * sey) / (len * len)));
          const px = pA.x + t * seg;
          const py = pA.y + t * sey;
          const d = Math.hypot(px - screenX, py - screenY);
          if (d < bestD && d < 16) {
            bestD = d;
            best = b;
          }
        }
      }
    }
    if (!best) return null;
    const lines = [
      `Hybrid boundary — ${best.fragmentId}`,
      `  physicalBoundaryId: ${best.physicalBoundaryId}`,
      `  chunk ${best.chunkId} · pass ${best.passId} · lane ${best.laneIndex} · side ${best.side ?? '—'}`,
      `  display: ${best.displaySource} · fitStatus: ${best.fitStatus}`,
    ];
    if (best.displaySource === 'fragmentFallback') {
      lines.push(`  rejection: ${best.rejectionReason ?? '—'}`);
      if (best.metrics?.splitReason) lines.push(`  splitReason: ${best.metrics.splitReason}`);
    } else if (best.metrics) {
      lines.push(`  held-out median: ${best.metrics.heldOutMedian != null ? best.metrics.heldOutMedian.toFixed(3) : '—'} m`);
      lines.push(`  corridor max: ${best.metrics.sourceCorridorMaxM != null ? best.metrics.sourceCorridorMaxM.toFixed(3) : '—'} m`);
    }
    return lines;
  }

  /** Hover tooltip for a join connector (accepted/rejected/ambiguous). */
  _joinCandidateHover(screenX, screenY, elapsedIdx) {
    const pa = this.stationaryLocalMap?.pointAccumulated;
    if (!pa?.joinedPolylines || typeof LaneJoining === 'undefined') return null;
    if (!this.layers.joinCandidates) return null;
    const jp = pa.joinedPolylines;
    let best = null, bestD = Infinity;
    for (const cand of jp.candidates || []) {
      const from = cand.from, to = cand.to;
      if (!from || !to) continue;
      const Ae = from.points[from.points.length - 1];
      const Bs = to.points[0];
      const pA = this.roadGeometryToScreen(Ae.east, Ae.north, Ae.mirroredEast, Ae.mirroredNorth);
      const pB = this.roadGeometryToScreen(Bs.east, Bs.north, Bs.mirroredEast, Bs.mirroredNorth);
      // distance from pointer to the segment
      const seg = pB.x - pA.x, sey = pB.y - pA.y;
      const len = Math.hypot(seg, sey) || 1e-9;
      const t = clamp(((screenX - pA.x) * seg + (screenY - pA.y) * sey) / (len * len), 0, 1);
      const px = pA.x + t * seg, py = pA.y + t * sey;
      const d = Math.hypot(px - screenX, py - screenY);
      if (d < bestD && d < 20) { bestD = d; best = cand; }
    }
    if (!best) return null;
    const m = best.measurements || {};
    const decision = best.pass ? (best.score != null ? `accepted score ${best.score}` : 'candidate') : `rejected: ${best.reason}`;
    return [
      `Join candidate — ${best.from?.fragmentId} → ${best.to?.fragmentId}`,
      `  boundary ${m.physicalBoundaryId ?? ''} · chunk ${m.chunkId} · pass ${m.passId}`,
      `  endpoint gap: ${m.endpointGapM != null ? m.endpointGapM.toFixed(2) : '—'} m · s gap ${m.alongTrackGapM != null ? m.alongTrackGapM.toFixed(2) : '—'} m`,
      `  tangent diff: ${m.tangentDiffDeg != null ? m.tangentDiffDeg.toFixed(1) : '—'}° · lateral err: ${m.lateralErrM != null ? m.lateralErrM.toFixed(2) : '—'} m`,
      `  curvature change: ${m.curvatureChangeDegPerM != null ? m.curvatureChangeDegPerM.toFixed(3) : '—'} °/m · temporal: ${m.temporalDiffSec != null ? m.temporalDiffSec.toFixed(1) : '—'} s`,
      `  corridor: ${m.corridor ?? '—'} (supported ${m.corridorSupportedInside ?? 0})`,
      `  decision: ${decision}`,
    ];
  }

  /**
   * Hover/debug values for the experimental boundary overlay: shows lane,
   * chunk/pass, s range, support, distinct obs, median reliability/probability,
   * lateral MAD, candidate, topology warnings and break reasons for the
   * boundary section nearest the pointer.
   */
  _experimentalBoundaryHover(screenX, screenY, elapsedIdx) {
    const bMode = this._experimentalBoundariesMode;
    if (bMode !== 'boundaries' && bMode !== 'combined') return null;
    const map = this.stationaryLocalMap;
    const pa = map?.pointAccumulated;
    let eb = pa?.experimentalBoundaries;
    if (!eb) return null;
    if (this._pointCausalPlayback && !this._obsIsolationActive()) {
      const elapsed = Math.max(0, Number(elapsedIdx) || 0);
      const causalPts = (pa.points || []).filter((p) => p.frameIndex != null ? p.frameIndex <= elapsed : true);
      eb = ExperimentalBoundaries.buildExperimentalBoundaries(causalPts, { candidate: eb.candidate });
    } else if (this._obsIsolationActive()) {
      const selPts = (pa.points || []).filter((p) => this._obsMatches(p.frameIndex, p.laneIndex));
      eb = ExperimentalBoundaries.buildExperimentalBoundaries(selPts, { candidate: eb.candidate });
    }
    let best = null;
    let bestD = Infinity;
    for (const lane of Object.values(eb.lanes)) {
      for (const sec of lane.sections) {
        for (const v of sec.vertices) {
          if (v.east == null || v.north == null) continue;
          const sp = this.roadGeometryToScreen(v.east, v.north, v.mirroredEast, v.mirroredNorth);
          const d = Math.hypot(sp.x - screenX, sp.y - screenY);
          if (d < bestD) { bestD = d; best = { sec, v, laneIndex: sec.laneIndex }; }
        }
      }
    }
    if (!best) return null;
    const sec = best.sec;
    return [
      `Experimental boundary — lane ${sec.laneIndex} (candidate ${eb.candidate})`,
      `  s: ${sec.sMin}..${sec.sMax} m · chunk ${map.chunkId} · pass ${map.passId}`,
      `  support: ${best.v.supportCount} obs · ${best.v.distinctTimestamps} distinct`,
      `  medianReliability: ${best.v.medianReliability ?? '—'} · medianProb: ${best.v.medianProb ?? '—'}`,
      `  lateral MAD: ${best.v.madLateral ?? '—'} m · d: ${best.v.d} m @ s=${best.v.s}`,
      `  warnings: ${sec.directionWarning ?? 'none'}`,
    ];
  }

  /**
   * Legend for the experimental reliability tint (display-only).
   * Clearly labelled "Experimental reliability" — not calibrated confidence.
   */
  _drawReliabilityLegend() {
    const ctx = this.ctx;
    const x = 10;
    const y = this.canvas?.height ? this.canvas.height - 70 : 620;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, 220, 64);
    ctx.strokeRect(x, y, 220, 64);
    ctx.font = '11px sans-serif';
    ctx.fillStyle = '#111';
    ctx.fillText('Experimental reliability (display only)', x + 8, y + 16);
    const swatches = [
      { s: 0.85, label: 'High (0.70–1.00)' },
      { s: 0.55, label: 'Medium (0.40–0.70)' },
      { s: 0.2, label: 'Low (0.00–0.40)' },
    ];
    swatches.forEach((sw, i) => {
      const sy = y + 28 + i * 12;
      ctx.fillStyle = typeof MappingReliability !== 'undefined'
        ? MappingReliability.tintColorForScore(sw.s, 0.9)
        : '#888';
      ctx.fillRect(x + 8, sy, 10, 10);
      ctx.fillStyle = '#333';
      ctx.font = '10px sans-serif';
      ctx.fillText(sw.label, x + 24, sy + 9);
    });
    ctx.font = '9px sans-serif';
    ctx.fillStyle = '#666';
    ctx.fillText('Not calibrated confidence.', x + 8, y + 58);
    ctx.restore();
  }

  /**
   * Hover/debug values for the experimental reliability score: shows the
   * combined score and each component for the point nearest the pointer.
   */
  _reliabilityHoverText(screenX, screenY, elapsedIdx) {
    if (!this._pointReliabilityTint || this.localGeometryMode !== 'pointAccumulated') return null;
    const map = this.stationaryLocalMap;
    const pa = map?.pointAccumulated;
    if (!pa?.points?.length) return null;
    let pts = pa.points;
    if (this._obsIsolationActive()) {
      pts = pts.filter((p) => this._obsMatches(p.frameIndex, p.laneIndex));
    } else if (this._pointCausalPlayback) {
      const elapsed = Math.max(0, Number(elapsedIdx) || 0);
      pts = pts.filter((p) => p.frameIndex != null ? p.frameIndex <= elapsed : true);
    }
    let best = null;
    let bestD = Infinity;
    for (const p of pts) {
      if (!Number.isFinite(p.localEast) || !Number.isFinite(p.localNorth)) continue;
      const sp = this.roadGeometryToScreen(p.localEast, p.localNorth);
      const d = Math.hypot(sp.x - screenX, sp.y - screenY);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best?.reliability) return null;
    const rel = best.reliability;
    const c = rel.components || {};
    return [
      `Experimental reliability: ${rel.combinedScore.toFixed(3)} (band: ${rel.band})`,
      `  probability: ${c.probability?.toFixed(3) ?? '—'}  distance: ${c.distance?.toFixed(3) ?? '—'}`,
      `  turning: ${c.turning?.toFixed(3) ?? '—'}  temporalAgree: ${c.temporalAgreement?.toFixed(3) ?? '—'}`,
      `  poseQuality: ${c.poseQuality?.toFixed(3) ?? '—'}  temporalAvailable: ${rel.hasTemporalAgreement}`,
    ];
  }

  /**
   * Debug overlay for one selected observation (Raw or Point mode).
   * Draws a metadata panel and labelled markers: vehicle pose, forward
   * direction, vehicle-relative lane curve, segment-local lane curve, and the
   * grey-road reference trajectory. Off by default (?obsDebug=1).
   */
  _drawObservationDebugOverlay(d, map, elapsedIdx) {
    if (this._obsDebugFrame == null) return;
    const frameIndex = this._obsDebugFrame;
    const laneIndex = this._obsDebugLane != null ? this._obsDebugLane : 0;
    const frame = d.frames && d.frames[frameIndex];
    if (!frame) return;

    const lane = (frame.lanes || []).find((l) => l.laneIndex === laneIndex)
      || (frame.lanes || [])[0];
    if (!lane) return;

    const ctx = this.ctx;
    const pose = frame.pose;
    const isPoint = this.localGeometryMode === 'pointAccumulated';

    // --- Markers -----------------------------------------------------------
    // Vehicle pose used for this observation (segment-local).
    if (pose) {
      const ref = map?.referencePose;
      let vp = this.worldToScreen(0, 0);
      if (ref) {
        const rel = this._globalToLocal(pose.east, pose.north, ref);
        vp = this.worldToScreen(rel.east, rel.north);
      }
      this._drawMarker(vp.x, vp.y, '#dc2626', 'POSE');
      // Vehicle-forward direction
      const fwd = this._vehicleForwardScreen(pose, ref);
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(vp.x, vp.y);
      ctx.lineTo(vp.x + fwd.x * 30, vp.y + fwd.y * 30);
      ctx.stroke();
      ctx.setLineDash([]);
      this._drawLabel(vp.x + fwd.x * 34, vp.y + fwd.y * 34, 'FWD', '#dc2626');
    }

    // Grey-road reference trajectory (segment-local map trajectory).
    if (map?.trajectory?.length >= 2) {
      ctx.strokeStyle = 'rgba(100,116,139,0.9)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      const t0 = this.worldToScreen(map.trajectory[0].east, map.trajectory[0].north);
      ctx.moveTo(t0.x, t0.y);
      for (let i = 1; i < map.trajectory.length; i++) {
        const tp = this.worldToScreen(map.trajectory[i].east, map.trajectory[i].north);
        ctx.lineTo(tp.x, tp.y);
      }
      ctx.stroke();
      this._drawLabel(t0.x, t0.y - 8, 'GREY ROAD REF', 'rgba(71,85,105,1)');
    }

    // Vehicle-relative lane curve (original model x/y, drawn in segment-local
    // frame without pose heading so we can see the raw shape near the vehicle).
    if (lane.points?.length >= 2) {
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      const r0 = this.roadGeometryToScreen(lane.points[0].modelX || 0, lane.points[0].modelY || 0);
      ctx.moveTo(r0.x, r0.y);
      for (let i = 1; i < lane.points.length; i++) {
        const rp = this.roadGeometryToScreen(lane.points[i].modelX || 0, lane.points[i].modelY || 0);
        ctx.lineTo(rp.x, rp.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      this._drawLabel(r0.x, r0.y - 8, 'MODEL X/Y', '#b45309');
    }

    // Segment-local lane curve (transformed).
    const frags = (map.laneFragments || []).filter((f) =>
      this._obsMatches(f.sourceFrameIndex, f.laneIndex));
    const frag = frags[0] || (map.laneFragments || []).find((f) => f.sourceFrameIndex === frameIndex);
    if (frag?.points?.length >= 2) {
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      const f0 = this.roadGeometryToScreen(frag.points[0].east, frag.points[0].north);
      ctx.moveTo(f0.x, f0.y);
      for (let i = 1; i < frag.points.length; i++) {
        const fp = this.roadGeometryToScreen(frag.points[i].east, frag.points[i].north);
        ctx.lineTo(fp.x, fp.y);
      }
      ctx.stroke();
      this._drawLabel(f0.x, f0.y - 8, 'SEG-LOCAL LANE', '#1d4ed8');
    }

    // --- Metadata panel -----------------------------------------------------
    const lines = this._buildObservationDebugLines(frame, lane, frameIndex, map, pose, isPoint);
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1;
    ctx.font = '11px monospace';
    const pad = 8;
    const lineH = 14;
    const boxW = 320;
    const boxH = lines.length * lineH + pad * 2;
    ctx.fillRect(this.w - boxW - 12, 12, boxW, boxH);
    ctx.strokeRect(this.w - boxW - 12, 12, boxW, boxH);
    ctx.fillStyle = '#111';
    lines.forEach((line, i) => {
      ctx.fillText(line, this.w - boxW, 24 + i * lineH);
    });
    ctx.restore();
  }

  _globalToLocal(east, north, referencePose) {
    const ve = referencePose?.east ?? 0;
    const vn = referencePose?.north ?? 0;
    const theta = (referencePose?.headingDeg ?? 0) * Math.PI / 180;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    const u = east - ve;
    const v = north - vn;
    return { east: u * sinT + v * cosT, north: v * sinT - u * cosT };
  }

  _vehicleForwardScreen(pose, referencePose) {
    if (!pose) return { x: 0, y: -1 };
    // Forward unit vector in global ENU: heading CW from north -> (sin, cos).
    const theta = (pose.headingDeg ?? 0) * Math.PI / 180;
    const fe = Math.sin(theta);
    const fn = Math.cos(theta);
    // Convert to segment-local frame (east=forward of reference, north=left).
    const fwd = this._globalToLocal(fe, fn, referencePose);
    const a = this.worldToScreen(0, 0);
    const b = this.worldToScreen(fwd.east, fwd.north);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  }

  _buildObservationDebugLines(frame, lane, frameIndex, map, pose, isPoint) {
    const L = [];
    const logMono = frame.logMonoTime != null ? String(frame.logMonoTime) : '—';
    const poseTs = pose?.logMonoTime != null ? String(pose.logMonoTime) : '—';
    const gpsTs = pose?.logMonoTime != null ? String(pose.logMonoTime) : '—';
    const dtMs = (t0, t1) => {
      if (t0 == null || t1 == null) return null;
      return Number(BigInt(t1) - BigInt(t0)) / 1e6;
    };
    L.push(`obs idx: ${frameIndex}`);
    L.push(`logMonoTime: ${logMono}`);
    L.push(`lane index: ${lane.laneIndex ?? '—'}  track: ${lane.laneTrackId ?? '—'}`);
    L.push(`lane conf: ${(lane.prob ?? 1).toFixed(3)}`);
    L.push(`chunk: ${frame.chunkId ?? 0}  pass: ${frame.passId ?? 0}`);
    L.push(`model ts: ${logMono}`);
    L.push(`pose ts: ${poseTs}  gps ts: ${gpsTs}`);
    const mdlToPose = dtMs(logMono, pose?.logMonoTime);
    const mdlToGps = dtMs(logMono, pose?.logMonoTime);
    L.push(`model->pose dt: ${mdlToPose != null ? mdlToPose.toFixed(1) : '—'} ms`);
    L.push(`model->gps dt: ${mdlToGps != null ? mdlToGps.toFixed(1) : '—'} ms`);
    if (pose) {
      L.push(`vehicle pos: ${pose.east?.toFixed?.(2)} ${pose.north?.toFixed?.(2)}`);
      L.push(`heading: ${pose.headingDeg?.toFixed?.(2)}°  unit: deg`);
      L.push(`heading src: ${pose.headingSource ?? '—'}`);
      L.push(`speed: ${pose.speed?.toFixed?.(2)} m/s`);
    }
    const tl = (frame.timeline || this._obsTimeline || [])[frameIndex];
    const mv = tl?.movementState ?? '—';
    const framePose = frame?.pose || pose;
    // Stationary pose lock diagnostic: show the lock state and anchor clearly.
    const lockState = framePose?.stationaryLocked === true ? 'STATIONARY LOCKED'
      : (framePose?.movementState === 'STATIONARY' ? 'stationary'
        : (framePose?.movementState || mv || '—'));
    L.push(`movement state: ${lockState}`);
    if (framePose?.stationaryLocked === true && framePose?.stationaryAnchor) {
      const a = framePose.stationaryAnchor;
      L.push(`  anchor: east ${a.east?.toFixed?.(2)} north ${a.north?.toFixed?.(2)} heading ${a.headingDeg?.toFixed?.(2)}°`);
    }
    L.push(`mapping pose: ${framePose?.east?.toFixed?.(2)} ${framePose?.north?.toFixed?.(2)} heading ${framePose?.headingDeg?.toFixed?.(2)}°`);
    // Motion-derived bearing from timeline (already GPS/pose heading based).
    const bearing = tl?.bearingDeg;
    L.push(`motion bearing: ${bearing != null ? bearing.toFixed(1) : '—'}°`);
    if (pose && bearing != null) {
      let dh = Math.abs(pose.headingDeg - bearing);
      if (dh > 180) dh = 360 - dh;
      L.push(`heading vs motion: ${dh.toFixed(1)}°`);
    }
    // Vehicle-relative and transformed coordinates
    if (lane.points?.length) {
      const p0 = lane.points[0];
      const pn = lane.points[lane.points.length - 1];
      L.push(`veh-rel first: (${p0.modelX?.toFixed?.(1)}, ${p0.modelY?.toFixed?.(1)})`);
      L.push(`veh-rel last: (${pn.modelX?.toFixed?.(1)}, ${pn.modelY?.toFixed?.(1)})`);
    }
    if (isPoint) {
      const pts = (map?.pointAccumulated?.points || []).filter((p) => this._obsMatches(p.frameIndex, p.laneIndex));
      if (pts.length) {
        const p0 = pts[0];
        L.push(`seg-local first: (${p0.localEast.toFixed(2)}, ${p0.localNorth.toFixed(2)})`);
        const pn = pts[pts.length - 1];
        L.push(`seg-local last: (${pn.localEast.toFixed(2)}, ${pn.localNorth.toFixed(2)})`);
      }
    } else {
      const frags = (map?.laneFragments || []).filter((f) => this._obsMatches(f.sourceFrameIndex, f.laneIndex));
      if (frags.length && frags[0].points?.length) {
        const p0 = frags[0].points[0];
        const pn = frags[0].points[frags[0].points.length - 1];
        L.push(`seg-local first: (${p0.east.toFixed(2)}, ${p0.north.toFixed(2)})`);
        L.push(`seg-local last: (${pn.east.toFixed(2)}, ${pn.north.toFixed(2)})`);
      }
    }
    return L;
  }

  _drawLocalVehiclePathOverlay(map) {
    if (!map?.trajectory || map.trajectory.length < 2) return;
    const LTO = typeof window !== 'undefined' ? window.LocalTrajectoryOverlay : null;
    // Same projector as grey road ribbon — never a divergent trajectory-only frame.
    const toScreen = (east, north) => this.roadGeometryToScreen(east, north);
    if (LTO?.drawTrajectoryOverlay) {
      LTO.drawTrajectoryOverlay(
        this.ctx,
        map.trajectory,
        toScreen,
      );
      return;
    }
    const runs = [map.trajectory];
    const ctx = this.ctx;
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 6]);
    for (const run of runs) {
      if (run.length < 2) continue;
      ctx.beginPath();
      const p0 = toScreen(run[0].east, run[0].north);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < run.length; i++) {
        const p = toScreen(run[i].east, run[i].north);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  _drawGeometryDiagnosticOverlays(map) {
    const diag = this.geometryDiagnostics;
    const frags = map.laneFragments || [];

    if (this.layers.diagPhysicalBoundary) {
      for (const lane of frags) {
        if (!lane.points?.length || !lane.physicalBoundaryId) continue;
        const mid = lane.points[Math.floor(lane.points.length / 2)];
        this._drawLabel(mid.east, mid.north, lane.physicalBoundaryId, this.physicalBoundaryColor(lane.physicalBoundaryId), true);
      }
    }

    if (this.layers.diagTrackIds) {
      for (const lane of frags) {
        if (lane.laneTrackId == null || !lane.points?.length) continue;
        const mid = lane.points[Math.floor(lane.points.length / 2)];
        this._drawLabel(mid.east, mid.north + 2, `T${lane.laneTrackId}`, '#0f172a', true);
      }
    }

    if (this.layers.diagFragmentIds) {
      frags.forEach((lane, i) => {
        if (!lane.points?.length) return;
        const start = lane.points[0];
        this._drawLabel(start.east, start.north, `R${lane.fragmentIndex ?? i}`, '#334155', true);
      });
    }

    if (this.layers.diagDisconnections) {
      const breaks = map.laneCleanup?.drawablePathAnalysis?.interRunBreaks || [];
      for (const brk of breaks) {
        if (brk.labelEast == null) continue;
        this._drawLabel(brk.labelEast, brk.labelNorth, `OPEN ${brk.gapId}`, '#dc2626', true);
        if (brk.gapStartEast != null && brk.gapEndEast != null) {
          this._drawPolyline(
            [{ east: brk.gapStartEast, north: brk.gapStartNorth }, { east: brk.gapEndEast, north: brk.gapEndNorth }],
            '#dc2626',
            2,
            true,
            15,
            true,
          );
        }
      }
      if (!breaks.length && diag?.openPhysicalGaps) {
        for (const g of diag.openPhysicalGaps) {
          const near = frags.find((f) => f.physicalBoundaryId === g.physicalBoundaryId
            && Math.abs(f.sMax - g.routeS0) < 2);
          if (!near?.points?.length) continue;
          const end = near.points[near.points.length - 1];
          this._drawLabel(end.east, end.north, `GAP ${g.alongTrackGapM.toFixed(1)}m`, '#dc2626', true);
        }
      }
    }

    if (this.layers.diagRepairedGaps && diag?.repairAnalysis) {
      for (const r of diag.repairAnalysis) {
        if (!r.structurallyRepaired || !r.coordinateJump) continue;
        const { pointBefore, pointAfter } = r.coordinateJump;
        const mx = (pointBefore.east + pointAfter.east) / 2;
        const my = (pointBefore.north + pointAfter.north) / 2;
        const color = r.verdict === 'rendered_continuity' ? '#0891b2' : '#ea580c';
        this._drawLabel(mx, my, `${r.id} ${r.verdict === 'rendered_continuity' ? 'RENDERED' : 'STRUCTURAL'}`, color, true);
      }
    }

    if (this.layers.diagStructuralBridges && diag?.structuralBridgeSegments) {
      for (const seg of diag.structuralBridgeSegments) {
        if (!seg.pointBefore || !seg.pointAfter) continue;
        const color = seg.renderedContinuity ? 'rgba(8,145,178,0.9)' : 'rgba(234,88,12,0.95)';
        this._drawPolyline(
          [seg.pointBefore, seg.pointAfter],
          color,
          seg.renderedContinuity ? 2.5 : 2,
          !seg.renderedContinuity,
          15,
          true,
        );
        const mx = (seg.pointBefore.east + seg.pointAfter.east) / 2;
        const my = (seg.pointBefore.north + seg.pointAfter.north) / 2;
        this._drawLabel(mx, my - 2, `${seg.id} ${seg.jumpM?.toFixed(1)}m`, color, true);
      }
    }

    if (this.layers.diagInterpolatedBridges) {
      for (const lane of frags) {
        const pts = lane.points || [];
        const interp = [];
        for (let i = 0; i < pts.length; i++) {
          if (pts[i].generated || pts[i].interpolationProvenance?.generated) {
            interp.push(pts[i]);
          }
        }
        if (interp.length < 2) continue;
        this._drawPolyline(interp, '#c026d3', 2.5, true, 15, true);
        const mid = interp[Math.floor(interp.length / 2)];
        const method = interp[0].interpolationProvenance?.interpolationMethod || 'interp';
        this._drawLabel(mid.east, mid.north, `${method} conf=${interp[0].interpolationProvenance?.confidence?.toFixed(2)}`, '#a21caf', true);
      }
    }
  }

  _drawStationaryUnavailable(map) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 1;
    ctx.font = '13px sans-serif';
    const reason = map?.reason || 'unavailable';
    const lines = [
      'Stationary local map unavailable',
      `reason: ${reason}`,
      `mode: ${this.localGeometryMode}`,
    ];
    if (map?.chunkId != null) lines.push(`chunk: ${map.chunkId}  pass: ${map.passId ?? '—'}`);
    const boxW = 320;
    const boxH = 24 + lines.length * 18;
    ctx.fillRect(20, 20, boxW, boxH);
    ctx.strokeRect(20, 20, boxW, boxH);
    ctx.fillStyle = '#111';
    lines.forEach((line, i) => ctx.fillText(line, 32, 42 + i * 18));
    ctx.restore();
  }

  _drawLocalPlaybackDebugOverlay(d, elapsedIdx) {
    const frame = d.frames?.[elapsedIdx];
    const pose = this.playbackPose;
    const LP = window.LocalPlayback;
    const map = this.stationaryLocalMap;
    const modeLabel = {
      observations: 'Raw mapped observations',
      tracked: 'Tracked observations',
      fused: 'Fused lane lines',
      pointAccumulated: 'Point-accumulated geometry',
      rejected: 'Rejected observations',
      cleaned: 'Cleaned fused lane map',
      cleanedWithSurface: 'Cleaned lanes + road surface',
      cleanedWithStage1Surface: 'Road-surface prototype (Stage 1)',
      cleanedDebug: 'Cleaned-run debug',
      diagnostic: 'Current observation (diagnostic)',
    }[this.localGeometryMode] || this.localGeometryMode;
    const lines = [
      `geometry mode: ${modeLabel}`,
      `geometry source: ${this.localGeometryMode}`,
      `elapsedIdx: ${elapsedIdx}`,
      `frameId: ${frame?.frameId ?? '—'}`,
      `logMonoTime: ${d.timeline?.[elapsedIdx]?.logMonoTime ?? '—'}`,
      `reference frame idx: ${map?.referencePose?.frameIndex ?? '—'}`,
      `reference heading: ${map?.referencePose?.headingDeg?.toFixed?.(1) ?? '—'}°`,
      `active chunk: ${map?.chunkId ?? frame?.chunkId ?? '—'}`,
      `active pass: ${map?.passId ?? frame?.passId ?? '—'}`,
      `lane fragments: ${map?.laneFragmentCount ?? 0}`,
      `lane checksum: ${map?.laneChecksum ?? map?.checksum ?? '—'}`,
      `edge fragments: ${map?.edgeFragmentCount ?? 0}`,
      `road polygons: ${map?.roadSurfacePolygonCount ?? 0}`,
      `road poly checksum: ${map?.roadSurfaceChecksum ?? '—'}`,
      `road poly drawn: ${this._roadSurfaceDrawStats?.drawableCount ?? '—'}/${this._roadSurfaceDrawStats?.sourceCount ?? '—'}`,
      `road poly skipped: ${this._roadSurfaceDrawStats?.skipped?.length ?? 0}`,
      `outlier fragments: ${map?.outlierFragmentCount ?? 0}`,
      `trajectory points: ${map?.trajectoryPointCount ?? 0}`,
      `map checksum: ${map?.checksum ?? '—'}`,
      `map build count: ${this._localMapBuildCount}`,
      `map cache: ${this._localMapCacheState}`,
      `arrow local x/y: ${pose?.east?.toFixed?.(2) ?? '—'}, ${pose?.north?.toFixed?.(2) ?? '—'}`,
      `arrow heading: ${pose?.headingDeg?.toFixed?.(1) ?? '—'}° (${pose?.headingSource ?? '—'})`,
    ];
    if (this.localGeometryMode === 'diagnostic') {
      const display = this.localGeometryDisplay;
      lines.splice(6, 0, `geometry source idx: ${display?.geometrySourceIndex ?? '—'}`);
      lines.splice(7, 0, `geometry state: ${display?.geometryState ?? '—'}`);
      const corridor = frame ? LP?.computeCorridorOffsetFromFrame(frame) : null;
      lines.push(`lane count: ${frame?.lanes?.length ?? 0}`);
      lines.push(`corridor offset: ${corridor?.valid ? `${corridor.vehicleOffsetFromCorridorCenterM.toFixed(2)} m` : '—'}`);
    }
    if (this.localGeometryMode === 'pointAccumulated' && map?.pointAccumulated?.stats) {
      const st = map.pointAccumulated.stats;
      const all = map.pointAccumulated.points || [];
      const causal = this._pointCausalPlayback;
      const elapsed = Math.max(0, Number(elapsedIdx) || 0);
      const shown = causal
        ? all.filter((p) => p.frameIndex != null ? p.frameIndex <= elapsed : true)
        : all;
      const lowConf = shown.filter((p) => p.lowConfidence).length;
      const single = shown.filter((p) => p.singleObservation).length;
      const repeated = shown.filter((p) => !p.singleObservation).length;
      lines.push(`pt display: ${causal ? 'Causal playback' : 'Complete map'}`);
      lines.push(`pt shown: ${shown.length}  source total: ${st.totalValidSourcePoints}`);
      lines.push(`pt low-conf shown: ${lowConf}  single-obs shown: ${single}  repeated: ${repeated}`);
      lines.push(`pt invalid excluded: ${st.invalidExcluded}  dedup: ${st.dedupRemoved}`);
      lines.push(`pt coverage parity: ${(st.coverageParity * 100).toFixed(1)}%  boundaries: ${st.boundaryCount}`);
      lines.push(`pt lines/curves: NONE`);
    }
    if (this._laneRelativeArrow && pose?.laneRelativeApplied) {
      lines.push(`lane-relative offset: ${pose.laneRelativeOffsetM?.toFixed?.(2)} m`);
    }
    const vb = this._localViewportBounds;
    if (vb) {
      lines.push(`viewport E: ${vb.minE?.toFixed?.(1)}..${vb.maxE?.toFixed?.(1)}`);
      lines.push(`viewport N: ${vb.minN?.toFixed?.(1)}..${vb.maxN?.toFixed?.(1)}`);
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.font = '11px monospace';
    const pad = 8;
    const lineH = 14;
    const boxH = lines.length * lineH + pad * 2;
    const boxW = 280;
    ctx.fillRect(10, 10, boxW, boxH);
    ctx.strokeRect(10, 10, boxW, boxH);
    ctx.fillStyle = '#111';
    lines.forEach((line, i) => {
      ctx.fillText(line, 18, 24 + i * lineH);
    });
    ctx.restore();
  }

  _drawVehicleFrame(frame) {
    this._drawVehicleFrameGeometry(frame, {
      fixedOriginArrow: true,
      showMovementAtArrow: true,
    });
  }

  _drawVehicleFrameGeometry(frame, options = {}) {
    if (!frame) return;
    const {
      fixedOriginArrow = false,
      arrowPose = null,
      showMovementAtArrow = false,
      useScreenPathHeading = false,
      geometryStale = false,
      retainedFromElapsedIdx = null,
    } = options;

    this._drawAxes();

    const laneAlpha = geometryStale ? 0.35 : 1;
    const pathAlpha = geometryStale ? 0.35 : 1;

    if (this.layers.edges && frame.edges) {
      frame.edges.forEach((e) => this._drawPolyline(e.points, `rgba(22,163,74,${laneAlpha})`, 3, false, 15, true));
    }
    if (frame.lanes) {
      frame.lanes.forEach((lane, i) => {
        const base = LANE_COLORS[i % LANE_COLORS.length];
        const color = geometryStale ? `${base}59` : base;
        this._drawPolyline(lane.points, color, geometryStale ? 1.5 : 2, false, 15, true);
      });
    }
    if (frame.path) {
      this._drawPolyline(
        frame.path.points,
        `rgba(148,163,184,${pathAlpha})`,
        1.5,
        true,
      );
    }

    if (geometryStale && retainedFromElapsedIdx != null && this._laneTransformDebug) {
      this._drawLabel(0, -8, `retained obs @${retainedFromElapsedIdx}`, '#b45309');
    }

    if (fixedOriginArrow) {
      if (showMovementAtArrow && this.movementDisplay) {
        this._drawVehicleMovementIndicator(0, 0, 'Fixed vehicle origin');
      }
      this._drawVehicleIcon(0, 0, 0);
    } else if (arrowPose && Number.isFinite(arrowPose.east) && Number.isFinite(arrowPose.north)) {
      if (showMovementAtArrow && this.movementDisplay) {
        this._drawVehicleMovementIndicator(arrowPose.east, arrowPose.north, null);
      }
      if (useScreenPathHeading) {
        this._drawLocalPlaybackArrow(frame.path?.points, arrowPose);
      } else {
        this._drawVehicleIcon(arrowPose.east, arrowPose.north, arrowPose.headingDeg || 0);
      }
    }
  }

  _drawAxes() {
    const ctx = this.ctx;
    const o = this.worldToScreen(0, 0);
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(o.x - 2000, o.y);
    ctx.lineTo(o.x + 2000, o.y);
    ctx.moveTo(o.x, o.y - 2000);
    ctx.lineTo(o.x, o.y + 2000);
    ctx.stroke();
  }

  _drawPolyline(points, color, width, dashed, maxGapM = 15, road = false) {
    if (!points?.length) return;
    const ctx = this.ctx;
    const toScreen = road
      ? (p) => this._projectRoadGeometryToScreen(p.east, p.north, p.mirroredEast, p.mirroredNorth, p)
      : (p) => this.worldToScreen(p.east, p.north);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dashed ? [8, 6] : []);

    const drawRun = (run) => {
      if (run.length < 2) return;
      ctx.beginPath();
      const p0 = toScreen(run[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < run.length; i++) {
        const p = toScreen(run[i]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    };

    let run = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const jump = Math.hypot(curr.east - prev.east, curr.north - prev.north);
      if (jump > maxGapM) {
        drawRun(run);
        run = [curr];
      } else {
        run.push(curr);
      }
    }
    drawRun(run);
    ctx.setLineDash([]);
  }

  _ringHasFiniteCoords(ring) {
    return (ring || []).every((p) => Number.isFinite(p?.east) && Number.isFinite(p?.north));
  }

  _fillPolygon(ring, fillStyle, labelPassId = null, options = {}) {
    if (!ring?.length || ring.length < 3) return;
    const ctx = this.ctx;
    const toScreen = (e, n) => this.roadGeometryToScreen(e, n);
    ctx.fillStyle = fillStyle;
    ctx.beginPath();
    const p0 = toScreen(ring[0].east, ring[0].north);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < ring.length; i++) {
      const p = toScreen(ring[i].east, ring[i].north);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fill();
    if (options.outline) {
      ctx.strokeStyle = options.outline;
      ctx.lineWidth = options.outlineWidth ?? 1;
      if (options.dashed) ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const showPassLabel = labelPassId != null && this.layers.colorByPass && this._polygonDebug;
    if (showPassLabel) {
      const mid = ring[Math.floor(ring.length / 4)];
      this._drawLabel(mid.east, mid.north, `pass ${labelPassId}`, '#111');
    }
  }

  _drawLabel(east, north, text, color = '#111', road = false) {
    const p = road ? this.roadGeometryToScreen(east, north) : this.worldToScreen(east, north);
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, p.x, p.y);
    ctx.textAlign = 'left';
  }

  _drawMarker(east, north, color, label, road = false) {
    const p = road ? this.roadGeometryToScreen(east, north) : this.worldToScreen(east, north);
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 8px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, p.x, p.y + 3);
    ctx.textAlign = 'left';
  }

  _resolveLocalPlaybackScreenTangent(pathPoints, arrowPose) {
    const PAS = window.PlaybackArrowScreen;
    if (!PAS || !pathPoints?.length || !arrowPose) return null;
    if (arrowPose.frozen && this._lastLocalArrowTangent) return this._lastLocalArrowTangent;
    const screenPoints = this._usesCombinedPlacedFrame()
      ? pathPoints.map((pt) => this._projectArrowPathPointToScreen(pt))
      : PAS.projectPathPoints(pathPoints, (e, n) => this._segmentDisplayToScreen(e, n));
    const tangent = PAS.resolveScreenPathTangent(screenPoints, arrowPose.pathIndex ?? 0, {
      lastValidDirection: this._lastLocalArrowTangent,
    });
    if (!tangent) return this._lastLocalArrowTangent;
    this._lastLocalArrowTangent = tangent;
    return tangent;
  }

  _canvasLogicalTransform() {
    const dpr = window.devicePixelRatio || 1;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _drawArrowShapeAtOrigin() {
    const ctx = this.ctx;
    ctx.fillStyle = '#1d4ed8';
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fill();
  }

  _drawLocalPlaybackArrow(pathPoints, arrowPose) {
    const PAS = window.PlaybackArrowScreen;
    const LP = window.LocalPlayback;
    if (!PAS || !arrowPose) return;
    const arrowCtx = this._buildCombinedPlacedArrowContext(arrowPose);
    const screen = this._segmentDisplayToScreen(arrowPose.east, arrowPose.north, arrowCtx);
    const centerX = screen.x;
    const centerY = screen.y;

    let ux;
    let uy;
    let tangent = null;
    if (pathPoints?.length >= 2) {
      tangent = this._resolveLocalPlaybackScreenTangent(pathPoints, arrowPose);
      if (!tangent) return;
      ux = tangent.ux;
      uy = tangent.uy;
    } else if (Number.isFinite(arrowPose.headingDeg)) {
      const VDC = typeof window !== 'undefined' ? window.ViewerDisplayCorrections : null;
      const skipHeadingCorrection = arrowCtx?.coordinateFrame === 'combinedPlaced';
      const headingDeg = !skipHeadingCorrection && this._useExactDisplayCorrection() && VDC?.transformDisplayHeading
        ? VDC.transformDisplayHeading(arrowPose.headingDeg).headingDeg
        : arrowPose.headingDeg;
      const headingRad = headingDeg * Math.PI / 180;
      const dx = Math.sin(headingRad);
      const dy = Math.cos(headingRad);
      const len = Math.hypot(dx, dy) || 1;
      ux = dx / len;
      uy = -dy / len;
    } else {
      return;
    }

    const arrow = PAS.buildScreenSpaceArrow(centerX, centerY, ux, uy);
    const ctx = this.ctx;

    ctx.save();
    this._canvasLogicalTransform();

    if (this._localArrowDebug) {
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(centerX + ux * 30, centerY + uy * 30);
      ctx.stroke();
      const dot = PAS.renderedTipDot(centerX, centerY, arrow.tipX, arrow.tipY, ux, uy);
      // eslint-disable-next-line no-console
      console.debug('[local-arrow]', {
        previous: tangent.previous,
        next: tangent.next,
        centerX,
        centerY,
        tipX: arrow.tipX,
        tipY: arrow.tipY,
        ux,
        uy,
        dot,
      });
    }

    ctx.fillStyle = '#1d4ed8';
    ctx.strokeStyle = '#1e40af';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(arrow.tipX, arrow.tipY);
    ctx.lineTo(arrow.leftX, arrow.leftY);
    ctx.lineTo(arrow.rightX, arrow.rightY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  _drawVehicleIcon(east, north, bearingDeg) {
    const p = this.worldToScreen(east, north);
    const ctx = this.ctx;
    const rad = (bearingDeg || 0) * Math.PI / 180;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-rad);
    this._drawArrowShapeAtOrigin();
    ctx.restore();
  }

  _drawVehicleMovementIndicator(east = 0, north = 0, subtitle = 'Fixed vehicle origin') {
    const display = this.movementDisplay;
    if (!display) return;
    const p = this.worldToScreen(east, north);
    const ctx = this.ctx;
    const baseRadius = 22;
    const state = display.displayState || 'UNCERTAIN';
    const t = this._pulsePhase;

    ctx.save();
    ctx.translate(p.x, p.y);

    if (state === 'MOVING') {
      const pulse = 0.55 + 0.45 * Math.sin(t * 4.5);
      ctx.strokeStyle = `rgba(22, 163, 74, ${0.35 + pulse * 0.45})`;
      ctx.lineWidth = 2 + pulse * 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, baseRadius + pulse * 4, 0, Math.PI * 2);
      ctx.stroke();
    } else if (state === 'CREEPING') {
      const pulse = 0.55 + 0.45 * Math.sin(t * 2.2);
      ctx.strokeStyle = `rgba(217, 119, 6, ${0.35 + pulse * 0.45})`;
      ctx.lineWidth = 2 + pulse * 1.2;
      ctx.beginPath();
      ctx.arc(0, 0, baseRadius + pulse * 3, 0, Math.PI * 2);
      ctx.stroke();
    } else if (state === 'STOPPED') {
      ctx.strokeStyle = '#9ca3af';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, 0, baseRadius, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(0, 0, baseRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = '#111827';
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(display.labelText || state, 0, -baseRadius - 14);

    if (subtitle) {
      ctx.fillStyle = '#6b7280';
      ctx.font = '9px system-ui, sans-serif';
      ctx.fillText(subtitle, 0, baseRadius + 16);
    }
    ctx.textAlign = 'left';
    ctx.restore();
  }

  _drawScaleBar() {
    const ctx = this.ctx;
    const targetPx = 100;
    const metres = niceRound(targetPx / this.scale);
    const px = metres * this.scale;
    const x = 20, y = this.h - 24;
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + px, y);
    ctx.stroke();
    ctx.fillStyle = '#333';
    ctx.font = '11px sans-serif';
    ctx.fillText(`${metres} m`, x, y - 4);
  }

  _drawNorthArrow() {
    const ctx = this.ctx;
    const x = this.w - 36, y = 36;
    ctx.fillStyle = '#333';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', x, y - 14);
    ctx.beginPath();
    ctx.moveTo(x, y - 10);
    ctx.lineTo(x - 6, y + 4);
    ctx.lineTo(x + 6, y + 4);
    ctx.closePath();
    ctx.fill();
    ctx.textAlign = 'left';
  }

  _drawHover(pt) {
    const p = this.worldToScreen(pt.east, pt.north);
    const ctx = this.ctx;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.stroke();
  }

  exportPng() {
    const link = document.createElement('a');
    link.download = 'road_geometry.png';
    link.href = this.canvas.toDataURL('image/png');
    link.click();
  }

  findNearestPoint(sx, sy, thresholdPx = 12) {
    const d = this.data;
    if (!d) return null;
    let best = null;
    let bestDist = thresholdPx;

    const check = (points, meta) => {
      for (const pt of points || []) {
        const sp = this.worldToScreen(pt.east, pt.north);
        const dist = Math.hypot(sp.x - sx, sp.y - sy);
        if (dist < bestDist) { bestDist = dist; best = { ...pt, ...meta }; }
      }
    };

    if (this.displayMode === 'vehicle' && d.frames?.[this.frameIndex]) {
      const f = d.frames[this.frameIndex];
      for (const lane of f.lanes || []) {
        check(lane.points, { laneIndex: lane.laneIndex, prob: lane.prob, frameId: f.frameId, logMonoTime: f.logMonoTime, sourceFile: f.sourceFile });
      }
    } else if (d.routeChunks) {
      for (const chunk of d.routeChunks) {
        for (const lane of chunk.fusedLaneLines || []) {
          check(lane.points, { laneIndex: lane.laneIndex, chunkId: chunk.chunkId, fused: true });
        }
        for (const edge of chunk.fusedRoadEdges || []) {
          check(edge.points, { edgeIndex: edge.edgeIndex, chunkId: chunk.chunkId, roadEdge: true });
        }
      }
    }
    return best;
  }
}

function niceRound(m) {
  const pow = Math.pow(10, Math.floor(Math.log10(m)));
  const n = m / pow;
  const nice = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return nice * pow;
}

RoadRenderer.resolveRepresentativeMethod = resolveRepresentativeMethod;

window.RoadRenderer = RoadRenderer;
