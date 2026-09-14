'use strict';
(function (global) {

/**
 * Default-on (promoted) candidate: combinedVisibleLaneProjectionCandidate.
 * Enabled when the query param is absent; explicit `=0` disables it.
 *
 * Shared source-relative lane projection for both visible lane collections:
 *   - pointAccumulated.points
 *   - laneFragments vertices
 *
 * Applied at draw time so persist-cache / orientation early-return cannot skip it.
 * Does not mutate stored road, trajectory, arrow, or bridge geometry.
 */

const QUERY_PARAM = 'combinedVisibleLaneProjectionCandidate';
const APPROVED_LAYER_KINDS = new Set(['pointAccumulated', 'laneFragments']);

function getViewerMirrorCoords() {
  if (typeof globalThis !== 'undefined' && globalThis.ViewerMirrorCoords) {
    return globalThis.ViewerMirrorCoords;
  }
  if (typeof require !== 'undefined') {
    try { return require('./viewer_mirror_coords'); } catch (_) { return null; }
  }
  return null;
}

function parseCombinedVisibleLaneProjectionCandidate(search) {
  const raw = typeof search === 'string'
    ? new URLSearchParams(search).get(QUERY_PARAM)
    : search?.get?.(QUERY_PARAM);
  // Promoted default: absent (or any value other than explicit '0') enables the
  // accepted combined visible-lane projection. Explicit '0' is the off override.
  return raw !== '0';
}

function emptyDiagnostics() {
  return {
    candidateActive: false,
    pointAccumulatedInputCount: 0,
    pointAccumulatedCorrectedCount: 0,
    pointAccumulatedFallbackCount: 0,
    laneFragmentInputCount: 0,
    laneFragmentVertexCount: 0,
    laneFragmentCorrectedCount: 0,
    laneFragmentFallbackCount: 0,
    missingSourceCount: 0,
    missingFrameCount: 0,
    missingAnchorCount: 0,
    doubleCorrectionPreventedCount: 0,
    cacheHitApplicationCount: 0,
    drawPassCounts: {
      pointAccumulated: 0,
      laneFragments: 0,
    },
  };
}

let _drawDiagnostics = emptyDiagnostics();

function resetDrawDiagnostics() {
  _drawDiagnostics = emptyDiagnostics();
}

function getBrowserDiagnostics(map = null) {
  const d = _drawDiagnostics || emptyDiagnostics();
  const active = !!(
    d.candidateActive
    || map?.combinedVisibleLaneProjectionActive
  );
  return {
    ...d,
    candidateActive: active,
  };
}

function isCandidateEligible(map, options = {}) {
  const search = options.search ?? (typeof window !== 'undefined' ? window.location?.search : '');
  const flag = options.useVisibleLaneProjection
    ?? parseCombinedVisibleLaneProjectionCandidate(search);
  if (!flag) return false;
  if (!map?.boundaryAnchoredOrientationActive) return false;
  if (!map?.isMultiSource) return false;
  if (!map?.sourceTransformByFile) return false;
  if (options.mirrorChecked === false) return false;
  return true;
}

function resolveCanonicalCoords(point) {
  if (Number.isFinite(point?.sourceCanonicalLocalEast) && Number.isFinite(point?.sourceCanonicalLocalNorth)) {
    return { east: point.sourceCanonicalLocalEast, north: point.sourceCanonicalLocalNorth };
  }
  if (Number.isFinite(point?.canonicalLocalEast) && Number.isFinite(point?.canonicalLocalNorth)) {
    return { east: point.canonicalLocalEast, north: point.canonicalLocalNorth };
  }
  // Unplaced fused vertices keep pre-placement segment-local east/north.
  if (point?.placementDiagnostic === 'missingSourceProvenance'
    && Number.isFinite(point?.east) && Number.isFinite(point?.north)) {
    return { east: point.east, north: point.north };
  }
  if (Number.isFinite(point?.modelX) && Number.isFinite(point?.modelY)
    && point?.coordinateFrame !== 'combinedPlaced'
    && point?.placementDiagnostic === 'missingSourceProvenance') {
    return { east: point.modelX, north: point.modelY };
  }
  return null;
}

function resolveMirroredLocals(point) {
  if (Number.isFinite(point?.sourceMirroredLocalEast) && Number.isFinite(point?.sourceMirroredLocalNorth)) {
    return { east: point.sourceMirroredLocalEast, north: point.sourceMirroredLocalNorth };
  }
  return null;
}

function getViewerDisplayCorrections() {
  if (typeof globalThis !== 'undefined' && globalThis.ViewerDisplayCorrections) {
    return globalThis.ViewerDisplayCorrections;
  }
  if (typeof require !== 'undefined') {
    try { return require('./viewer_display_corrections'); } catch (_) { return null; }
  }
  return null;
}

function standaloneDisplay(canonical, mirrored, mirrorChecked, entry) {
  if (!canonical || !Number.isFinite(canonical.east) || !Number.isFinite(canonical.north)) return null;
  if (entry?.displayCorrection) {
    // Match combined_source_transform.applyCanonical: reflect in source-local
    // before the boundary-anchored fit so lane offsets share the trajectory frame.
    const VDC = getViewerDisplayCorrections();
    const corrected = VDC?.transformDisplayPoint
      ? VDC.transformDisplayPoint(canonical.east, canonical.north)
      : { east: canonical.east, north: -canonical.north };
    return { east: corrected.east, north: corrected.north, displayMethod: 'exactDisplayCorrection' };
  }
  if (!mirrorChecked) {
    return { east: canonical.east, north: canonical.north, displayMethod: 'canonical' };
  }
  if (mirrored && Number.isFinite(mirrored.east) && Number.isFinite(mirrored.north)) {
    return { east: mirrored.east, north: mirrored.north, displayMethod: 'precomputedMirror' };
  }
  const VMC = getViewerMirrorCoords();
  if (VMC?.reflectSegmentLocalLateral) {
    const reflected = VMC.reflectSegmentLocalLateral(canonical.east, canonical.north);
    return { east: reflected.east, north: reflected.north, displayMethod: 'segmentLocalLateralReflect' };
  }
  return { east: canonical.east, north: -canonical.north, displayMethod: 'northReflectFallback' };
}

function rotatePlacementOffset(entry, dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { east: dx, north: dy };
  if (!entry || entry.identity) return { east: dx, north: dy };
  const theta = entry.rotationRad ?? 0;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return {
    east: cos * dx - sin * dy,
    north: sin * dx + cos * dy,
  };
}

function buildTrajectoryArcLengths(trajectory) {
  const lengths = [0];
  for (let i = 1; i < (trajectory || []).length; i++) {
    const a = trajectory[i - 1];
    const b = trajectory[i];
    const ae = Number.isFinite(a.east) ? a.east : a.placedEast;
    const an = Number.isFinite(a.north) ? a.north : a.placedNorth;
    const be = Number.isFinite(b.east) ? b.east : b.placedEast;
    const bn = Number.isFinite(b.north) ? b.north : b.placedNorth;
    lengths.push(lengths[i - 1] + Math.hypot(be - ae, bn - an));
  }
  return lengths;
}

function findTrajectoryAnchorPair(baselineTrajectory, placedTrajectory, point) {
  const sourceFile = point?.sourceFile ?? null;
  const frameId = point?.frameId ?? point?.sourceFrameId ?? null;
  const frameIndex = point?.frameIndex ?? point?.sourceFrameIndex ?? point?.timelineIndex ?? null;
  if (!sourceFile) return null;

  const matchPoint = (row) => {
    if (row?.sourceFile !== sourceFile) return false;
    if (frameId != null && row.frameId === frameId) return true;
    if (frameIndex != null && (row.timelineIndex === frameIndex || row.frameIndex === frameIndex)) return true;
    return false;
  };

  let baseline = (baselineTrajectory || []).find(matchPoint) || null;
  let placed = (placedTrajectory || []).find(matchPoint) || null;

  // Fused vertices often lack frameId; resolve stable source+frame via along-track s.
  if ((!baseline || !placed) && Number.isFinite(point?.s)) {
    const arc = buildTrajectoryArcLengths(baselineTrajectory);
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < arc.length; i++) {
      const dist = Math.abs(arc[i] - point.s);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const byS = baselineTrajectory[bestIdx];
      if (byS?.sourceFile === sourceFile || !sourceFile) {
        baseline = byS;
        const sf = byS.sourceFile;
        const fid = byS.frameId;
        placed = (placedTrajectory || []).find((row) => row.sourceFile === sf && row.frameId === fid) || null;
      }
    }
  }

  if (!baseline || !placed) return null;
  const placedEast = Number.isFinite(placed.placedEast) ? placed.placedEast : placed.east;
  const placedNorth = Number.isFinite(placed.placedNorth) ? placed.placedNorth : placed.north;
  if (!Number.isFinite(placedEast) || !Number.isFinite(placedNorth)) return null;
  return {
    baseline,
    placed,
    placedEast,
    placedNorth,
    sourceFile: baseline.sourceFile,
    frameId: baseline.frameId ?? null,
    sourceAnchorId: `${baseline.sourceFile}:${baseline.frameId ?? baseline.timelineIndex ?? 'na'}`,
  };
}

function resolveSourceFileForPoint(point, map, fragmentHint = null) {
  if (point?.sourceFile) return point.sourceFile;
  if (fragmentHint?.sourceFile) return fragmentHint.sourceFile;
  if (Number.isFinite(point?.s) && map?.baselineTrajectory?.length) {
    const arc = buildTrajectoryArcLengths(map.baselineTrajectory);
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < arc.length; i++) {
      const dist = Math.abs(arc[i] - point.s);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) return map.baselineTrajectory[bestIdx]?.sourceFile ?? null;
  }
  return null;
}

function bumpFallback(layerKind, reason) {
  if (layerKind === 'pointAccumulated') _drawDiagnostics.pointAccumulatedFallbackCount += 1;
  if (layerKind === 'laneFragments') _drawDiagnostics.laneFragmentFallbackCount += 1;
  if (reason === 'missingSource') _drawDiagnostics.missingSourceCount += 1;
  if (reason === 'missingFrame') _drawDiagnostics.missingFrameCount += 1;
  if (reason === 'missingAnchor') _drawDiagnostics.missingAnchorCount += 1;
}

/**
 * @returns {{ east: number, north: number, corrected: boolean, reason?: string } | null}
 * null => caller should use the existing projection path (candidate inactive / not a lane pass).
 */
function projectCombinedSourceLanePoint(point, map, layerKind, options = {}) {
  const kind = layerKind || options.layerKind;
  if (!APPROVED_LAYER_KINDS.has(kind)) return null;

  const mirrorChecked = options.mirrorChecked !== false;
  if (!isCandidateEligible(map, { ...options, mirrorChecked })) return null;

  _drawDiagnostics.candidateActive = true;
  _drawDiagnostics.drawPassCounts[kind] = (_drawDiagnostics.drawPassCounts[kind] || 0) + 1;
  if (kind === 'pointAccumulated') _drawDiagnostics.pointAccumulatedInputCount += 1;
  if (kind === 'laneFragments') {
    _drawDiagnostics.laneFragmentVertexCount += 1;
  }

  if (point?.visibleLaneProjectionApplied === true) {
    _drawDiagnostics.doubleCorrectionPreventedCount += 1;
    const e = Number.isFinite(point.placedEast) ? point.placedEast : point.east;
    const n = Number.isFinite(point.placedNorth) ? point.placedNorth : point.north;
    if (Number.isFinite(e) && Number.isFinite(n)) {
      if (kind === 'pointAccumulated') _drawDiagnostics.pointAccumulatedCorrectedCount += 1;
      if (kind === 'laneFragments') _drawDiagnostics.laneFragmentCorrectedCount += 1;
      return { east: e, north: n, corrected: true, reason: 'alreadyApplied' };
    }
  }

  const sourceFile = resolveSourceFileForPoint(point, map, options.fragmentHint);
  if (!sourceFile) {
    bumpFallback(kind, 'missingSource');
    return {
      east: Number.isFinite(point?.placedEast) ? point.placedEast : point?.east,
      north: Number.isFinite(point?.placedNorth) ? point.placedNorth : point?.north,
      corrected: false,
      reason: 'missingSource',
    };
  }

  const entry = map.sourceTransformByFile?.[sourceFile];
  if (!entry) {
    bumpFallback(kind, 'missingSource');
    return {
      east: Number.isFinite(point?.placedEast) ? point.placedEast : point?.east,
      north: Number.isFinite(point?.placedNorth) ? point.placedNorth : point?.north,
      corrected: false,
      reason: 'missingTransform',
    };
  }

  // Display-correction sources are already placed through applyCanonical
  // (exact lateral reflection + boundary-anchored fit). Reusing placed coords
  // keeps lane dots in the same combined frame as trajectory/road — do not
  // re-derive offsets that can flip lateral side.
  if (
    entry.displayCorrection
    && point?.coordinateFrame === 'combinedPlaced'
    && Number.isFinite(point?.placedEast)
    && Number.isFinite(point?.placedNorth)
  ) {
    if (kind === 'pointAccumulated') _drawDiagnostics.pointAccumulatedCorrectedCount += 1;
    if (kind === 'laneFragments') _drawDiagnostics.laneFragmentCorrectedCount += 1;
    _drawDiagnostics.candidateActive = true;
    return {
      east: point.placedEast,
      north: point.placedNorth,
      corrected: true,
      reason: 'placedExactCorrection',
      sourceFile,
      layerKind: kind,
    };
  }

  const probe = {
    ...point,
    sourceFile,
    frameId: point?.frameId ?? point?.sourceFrameId ?? options.fragmentHint?.sourceFrameId ?? null,
    frameIndex: point?.frameIndex ?? point?.sourceFrameIndex ?? options.fragmentHint?.sourceFrameIndex ?? null,
  };

  if (probe.frameId == null && probe.frameIndex == null && !Number.isFinite(point?.s)) {
    bumpFallback(kind, 'missingFrame');
    return {
      east: Number.isFinite(point?.placedEast) ? point.placedEast : point?.east,
      north: Number.isFinite(point?.placedNorth) ? point.placedNorth : point?.north,
      corrected: false,
      reason: 'missingFrame',
    };
  }

  const baselineTrajectory = map.baselineTrajectory || [];
  const placedTrajectory = map.trajectory || [];
  const anchorPair = findTrajectoryAnchorPair(baselineTrajectory, placedTrajectory, probe);
  if (!anchorPair) {
    bumpFallback(kind, 'missingAnchor');
    return {
      east: Number.isFinite(point?.placedEast) ? point.placedEast : point?.east,
      north: Number.isFinite(point?.placedNorth) ? point.placedNorth : point?.north,
      corrected: false,
      reason: 'missingAnchor',
    };
  }

  const canonical = resolveCanonicalCoords({ ...point, sourceFile });
  if (!canonical) {
    bumpFallback(kind, 'missingFrame');
    return {
      east: Number.isFinite(point?.placedEast) ? point.placedEast : point?.east,
      north: Number.isFinite(point?.placedNorth) ? point.placedNorth : point?.north,
      corrected: false,
      reason: 'missingCanonical',
    };
  }

  const laneDisplay = standaloneDisplay(canonical, resolveMirroredLocals(point), mirrorChecked, entry);
  const anchorCanonical = {
    east: Number.isFinite(anchorPair.baseline.east) ? anchorPair.baseline.east : anchorPair.baseline.localEast,
    north: Number.isFinite(anchorPair.baseline.north) ? anchorPair.baseline.north : anchorPair.baseline.localNorth,
  };
  const anchorDisplay = standaloneDisplay(
    anchorCanonical,
    resolveMirroredLocals(anchorPair.baseline),
    // Anchor uses the same contract as rejected CLDC: canonical centreline for offset base
    // when displayCorrection is set; otherwise baseline trajectory coords (unmirrored).
    false,
    entry,
  );
  // For non-correction sources, CLDC used unmirrored baseline as anchorDisplay.
  const anchorForOffset = entry?.displayCorrection
    ? anchorDisplay
    : { east: anchorCanonical.east, north: anchorCanonical.north };

  if (!laneDisplay || !anchorForOffset
    || !Number.isFinite(anchorForOffset.east) || !Number.isFinite(anchorForOffset.north)) {
    bumpFallback(kind, 'missingAnchor');
    return {
      east: Number.isFinite(point?.placedEast) ? point.placedEast : point?.east,
      north: Number.isFinite(point?.placedNorth) ? point.placedNorth : point?.north,
      corrected: false,
      reason: 'missingDisplay',
    };
  }

  const offsetEast = laneDisplay.east - anchorForOffset.east;
  const offsetNorth = laneDisplay.north - anchorForOffset.north;
  const rotated = rotatePlacementOffset(entry, offsetEast, offsetNorth);
  const correctedEast = anchorPair.placedEast + rotated.east;
  const correctedNorth = anchorPair.placedNorth + rotated.north;
  if (!Number.isFinite(correctedEast) || !Number.isFinite(correctedNorth)) {
    bumpFallback(kind, 'missingAnchor');
    return {
      east: Number.isFinite(point?.placedEast) ? point.placedEast : point?.east,
      north: Number.isFinite(point?.placedNorth) ? point.placedNorth : point?.north,
      corrected: false,
      reason: 'nonFiniteResult',
    };
  }

  if (kind === 'pointAccumulated') _drawDiagnostics.pointAccumulatedCorrectedCount += 1;
  if (kind === 'laneFragments') _drawDiagnostics.laneFragmentCorrectedCount += 1;
  if (options.fromCacheHit) _drawDiagnostics.cacheHitApplicationCount += 1;

  return {
    east: correctedEast,
    north: correctedNorth,
    corrected: true,
    reason: 'projected',
    sourceFile,
    sourceAnchorId: anchorPair.sourceAnchorId,
    layerKind: kind,
  };
}

function noteLaneFragmentPass() {
  _drawDiagnostics.laneFragmentInputCount += 1;
}

function markCandidateActiveOnMap(map) {
  if (map) map.combinedVisibleLaneProjectionActive = true;
}

const CombinedVisibleLaneProjectionApi = {
  QUERY_PARAM,
  APPROVED_LAYER_KINDS,
  parseCombinedVisibleLaneProjectionCandidate,
  isCandidateEligible,
  projectCombinedSourceLanePoint,
  resetDrawDiagnostics,
  getBrowserDiagnostics,
  emptyDiagnostics,
  noteLaneFragmentPass,
  markCandidateActiveOnMap,
  resolveCanonicalCoords,
  standaloneDisplay,
  rotatePlacementOffset,
  findTrajectoryAnchorPair,
  resolveSourceFileForPoint,
};
if (typeof module !== 'undefined' && module.exports) module.exports = CombinedVisibleLaneProjectionApi;
global.CombinedVisibleLaneProjection = CombinedVisibleLaneProjectionApi;
})(typeof window !== 'undefined' ? window : global);
