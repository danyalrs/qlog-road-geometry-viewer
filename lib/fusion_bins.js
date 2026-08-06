/**
 * Fusion-bin coverage audit, gap classification, and safe surface bridging.
 */

const SURFACE_TYPES = {
  EGO_LANE: 'egoLaneCorridor',
  MULTI_LANE: 'multiLaneCorridor',
  FULL_ROAD: 'fullRoadSurface',
};

const GAP_CLASSES = {
  NO_SOURCE: 'A',
  TRACK_REJECTED: 'B',
  FUSION_REMOVED: 'C',
  POLYGON_SPLIT: 'D',
  CHUNK_PASS: 'E',
};

function collectBinGaps(sortedPts) {
  const gaps = [];
  for (let i = 1; i < sortedPts.length; i++) gaps.push(sortedPts[i].s - sortedPts[i - 1].s);
  return gaps;
}

/**
 * Derive maximum safe surface-only bridge gap from measured intra-section bin spacing.
 * Uses P90 of gaps below dropout scale, capped at 12 m.
 */
function deriveSafeSurfaceBridgeGapM(leftPts, rightPts, options = {}) {
  const fusionInterval = options.fusionIntervalM ?? 2.0;
  const dropoutScaleM = options.dropoutScaleGapM ?? 30;
  const allGaps = [...collectBinGaps(leftPts), ...collectBinGaps(rightPts)]
    .filter((g) => g > fusionInterval * 0.4 && g < dropoutScaleM);
  if (!allGaps.length) {
    const fallback = fusionInterval * 4;
    return { safeBridgeGapM: fallback, p90IntraGapM: null, sampleCount: 0 };
  }
  const sorted = [...allGaps].sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const derived = Math.min(Math.max(p90 + fusionInterval * 0.5, fusionInterval * 3), 12);
  return { safeBridgeGapM: derived, p90IntraGapM: p90, sampleCount: allGaps.length };
}

function interpolateBridgeSamples(endInterval, startInterval, options = {}) {
  const step = options.polygonSampleStepM ?? 2.0;
  const endS = endInterval[endInterval.length - 1].s;
  const startS = startInterval[0].s;
  const gapM = startS - endS;
  if (gapM <= step * 0.5) return { valid: true, samples: [], gapM: 0, provenance: null };

  const endL = endInterval[endInterval.length - 1];
  const endR = endInterval[endInterval.length - 1];
  const startL = startInterval[0];
  const startR = startInterval[0];

  const widthBefore = endL.width ?? Math.abs(endL.dL - endL.dR);
  const widthAfter = startL.width ?? Math.abs(startL.dL - startL.dR);
  const widthDelta = Math.abs(widthAfter - widthBefore);
  const maxWidthDelta = options.maxBridgeWidthDeltaM ?? 1.5;
  if (widthDelta > maxWidthDelta) return { valid: false, reason: 'incompatibleWidth' };

  const samples = [];
  for (let s = endS + step; s < startS - 1e-6; s += step) {
    const t = (s - endS) / (gapM || 1);
    const dL = endL.dL + t * (startL.dL - endL.dL);
    const dR = endR.dR + t * (startR.dR - endR.dR);
    const width = Math.abs(dL - dR);
    if (dL < dR || width < (options.minRoadWidthM ?? 2) || width > (options.maxRoadWidthM ?? 30)) {
      return { valid: false, reason: 'bridgeCrossingOrWidth' };
    }
    samples.push({
      s, dL, dR, width, valid: true,
      syntheticForSurface: true,
      interpolationT: t,
    });
  }

  return {
    valid: true,
    samples,
    gapM,
    provenance: {
      syntheticForSurface: true,
      interpolationStartS: endS,
      interpolationEndS: startS,
      gapLengthM: gapM,
      supportingTrackIds: options.leftTrackId != null ? [options.leftTrackId, options.rightTrackId] : [],
      widthBeforeM: widthBefore,
      widthAfterM: widthAfter,
    },
  };
}

function mergeAdjacentIntervals(intervals, options = {}) {
  if (!intervals?.length) return { intervals: [], bridges: [], safeBridgeGapM: 0 };
  const safeGap = options.safeBridgeGapM ?? 8;
  const sorted = [...intervals].sort((a, b) => a[0].s - b[0].s);
  const merged = [];
  const bridges = [];
  let current = [...sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const gapM = next[0].s - current[current.length - 1].s;
    if (gapM > 0 && gapM <= safeGap) {
      const bridge = interpolateBridgeSamples(current, next, options);
      if (bridge.valid) {
        if (bridge.samples.length) bridges.push(bridge.provenance);
        current = [...current, ...bridge.samples, ...next];
        continue;
      }
    }
    merged.push(current);
    current = [...next];
  }
  merged.push(current);
  return { intervals: merged, bridges, safeBridgeGapM: safeGap };
}

function classifySurfaceType({ leftTrackId, rightTrackId, leftIsRoadEdge, rightIsRoadEdge, laneTrackCount }) {
  if (leftIsRoadEdge && rightIsRoadEdge) return SURFACE_TYPES.FULL_ROAD;
  if (laneTrackCount >= 3) return SURFACE_TYPES.MULTI_LANE;
  return SURFACE_TYPES.EGO_LANE;
}

function auditTrackBins(laneObs, trackId, frames, trajectory, options = {}) {
  const { fuseLaneTrackSdFragments } = require('./sd_fusion');
  const interval = options.fusionIntervalM ?? 2.0;
  const minObsPerBin = options.minObsPerBin ?? 2;
  const minFramesPerBin = options.minFramesPerBin ?? 2;
  const trackObs = laneObs.filter((o) => o.laneTrackId === trackId);
  const acceptedFrags = fuseLaneTrackSdFragments(laneObs, trackId, options);
  const acceptedKeys = new Set(acceptedFrags.flat().map((p) => p.binKey).filter((k) => k != null));

  const frameById = new Map(frames.map((f, i) => [f.frameId, { ...f, elapsedIdx: i }]));
  const allKeys = new Set();
  for (const obs of trackObs) allKeys.add(Math.round(obs.s / interval));

  const bins = [];
  for (const key of [...allKeys].sort((a, b) => a - b)) {
    const obs = trackObs.filter((o) => Math.round(o.s / interval) === key);
    const sCentre = key * interval;
    const frameIds = [...new Set(obs.map((o) => o.frameId))];
    const elapsedIdx = frameIds.map((id) => frameById.get(id)?.elapsedIdx).filter((x) => x != null);
    const accepted = acceptedKeys.has(key);
    let rejectionReason = null;
    if (!obs.length) rejectionReason = 'no raw support';
    else if (obs.length < minObsPerBin) rejectionReason = 'insufficient support';
    else if (frameIds.length < minFramesPerBin) rejectionReason = 'insufficientFrameSupport';
    else if (!accepted) rejectionReason = 'lateral inconsistency';

    const acceptedPt = acceptedFrags.flat().find((p) => p.binKey === key);
    bins.push({
      trackId,
      chunkId: obs[0]?.chunkId ?? 0,
      passId: obs[0]?.passId ?? 0,
      binIndex: key,
      binStartS: sCentre - interval / 2,
      binEndS: sCentre + interval / 2,
      binCentreS: acceptedPt?.s ?? sCentre,
      supportCount: obs.length,
      sourceFrameIds: frameIds,
      sourceElapsedIdx: elapsedIdx,
      contributingRawPoints: obs.length,
      confidenceValues: obs.map((o) => o.prob ?? 1),
      fusedLateralD: acceptedPt?.d ?? null,
      accepted,
      rejectionReason: accepted ? null : rejectionReason,
    });
  }

  const acceptedBins = bins.filter((b) => b.accepted);
  const expectedBins = bins.length;
  const coverage = expectedBins > 0 ? acceptedBins.length / expectedBins : 0;
  let largestGap = 0;
  for (let i = 1; i < acceptedBins.length; i++) {
    const g = acceptedBins[i].binCentreS - acceptedBins[i - 1].binCentreS;
    if (g > largestGap) largestGap = g;
  }

  return {
    trackId,
    bins,
    summary: {
      startS: acceptedBins[0]?.binCentreS ?? null,
      endS: acceptedBins[acceptedBins.length - 1]?.binCentreS ?? null,
      expectedBins,
      acceptedBins: acceptedBins.length,
      coverage,
      largestGapM: largestGap,
    },
  };
}

function classifyGapBetweenBins(prevBin, nextBin, dropoutScaleM = 30) {
  const gapM = nextBin.binCentreS - prevBin.binCentreS;
  if (gapM >= dropoutScaleM) {
    return { classification: GAP_CLASSES.NO_SOURCE, safeToBridge: false, cause: 'dropout-scale gap without observations' };
  }
  if (!prevBin.accepted || !nextBin.accepted) {
    if (prevBin.rejectionReason === 'no raw support' || nextBin.rejectionReason === 'no raw support') {
      return { classification: GAP_CLASSES.NO_SOURCE, safeToBridge: false, cause: 'no source observation' };
    }
    return { classification: GAP_CLASSES.FUSION_REMOVED, safeToBridge: gapM <= 12, cause: prevBin.rejectionReason || nextBin.rejectionReason };
  }
  if (gapM > 8) {
    return { classification: GAP_CLASSES.POLYGON_SPLIT, safeToBridge: gapM <= 12, cause: 'sparse bin spacing splits polygon assembly' };
  }
  return { classification: GAP_CLASSES.POLYGON_SPLIT, safeToBridge: true, cause: 'short processing gap between accepted bins' };
}

function auditRoadEdges(frames, trajectory, options = {}) {
  const { collectEdgeObservations, fuseSideBoundary } = require('./sd_fusion');
  const { observations, rejected } = collectEdgeObservations(frames, trajectory, options);
  const left = fuseSideBoundary(observations, 'left', options);
  const right = fuseSideBoundary(observations, 'right', options);
  return {
    rawObservationCount: observations.length,
    rejectedObservationCount: rejected.length,
    leftFusedBinCount: left.fusedPoints.length,
    rightFusedBinCount: right.fusedPoints.length,
    leftFragmentCount: left.fragments.length,
    rightFragmentCount: right.fragments.length,
    leftCoverageM: left.fusedPoints.length > 1
      ? left.fusedPoints[left.fusedPoints.length - 1].s - left.fusedPoints[0].s : 0,
    rightCoverageM: right.fusedPoints.length > 1
      ? right.fusedPoints[right.fusedPoints.length - 1].s - right.fusedPoints[0].s : 0,
    rejectionReasons: [...left.rejected, ...right.rejected].reduce((acc, r) => {
      acc[r.reason] = (acc[r.reason] || 0) + 1;
      return acc;
    }, {}),
  };
}

function buildFusionBinDebugLayer(audit) {
  const markers = [];
  for (const track of audit.trackAudits || []) {
    for (const bin of track.bins) {
      markers.push({
        trackId: bin.trackId,
        s: bin.binCentreS,
        accepted: bin.accepted,
        supportCount: bin.supportCount,
        rejectionReason: bin.rejectionReason,
        elapsedIdx: bin.sourceElapsedIdx,
      });
    }
  }
  return { markers, gaps: audit.gapClassifications || [] };
}

module.exports = {
  SURFACE_TYPES,
  GAP_CLASSES,
  deriveSafeSurfaceBridgeGapM,
  interpolateBridgeSamples,
  mergeAdjacentIntervals,
  classifySurfaceType,
  auditTrackBins,
  classifyGapBetweenBins,
  auditRoadEdges,
  buildFusionBinDebugLayer,
  collectBinGaps,
};
