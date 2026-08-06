'use strict';
(function initLaneMapCleanup(global) {
function dist2d(a, b) {
  return Math.hypot((a.east ?? 0) - (b.east ?? 0), (a.north ?? 0) - (b.north ?? 0));
}
function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < (points?.length || 0); i++) {
    len += Math.hypot(points[i].east - points[i - 1].east, points[i].north - points[i - 1].north);
  }
  return len;
}
function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < (points?.length || 0); i++) {
    len += Math.hypot(points[i].east - points[i - 1].east, points[i].north - points[i - 1].north);
  }
  return len;
}

/** Smoothed vehicle reference trajectory and s/d projection. */


function buildReferenceTrajectory(vehiclePath) {
  const points = (vehiclePath || []).map((p) => ({
    east: p.east,
    north: p.north,
    logMonoTime: p.logMonoTime,
    frameId: p.frameId,
    sourceFile: p.sourceFile,
    headingDeg: p.headingDeg,
  }));

  const segments = [];
  let totalLength = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const len = dist2d(points[i], points[i + 1]);
    segments.push({
      index: i,
      a: points[i],
      b: points[i + 1],
      s0: totalLength,
      s1: totalLength + len,
      length: len,
    });
    totalLength += len;
  }

  return { points, segments, totalLength };
}

function projectOnSegment(a, b, p) {
  const de = b.east - a.east;
  const dn = b.north - a.north;
  const len2 = de * de + dn * dn;
  if (len2 < 1e-12) {
    return { t: 0, dist: dist2d(a, p), east: a.east, north: a.north };
  }
  let t = ((p.east - a.east) * de + (p.north - a.north) * dn) / len2;
  t = Math.max(0, Math.min(1, t));
  const pe = a.east + t * de;
  const pn = a.north + t * dn;
  return { t, dist: Math.hypot(p.east - pe, p.north - pn), east: pe, north: pn };
}

function signedLateral(a, b, p) {
  const de = b.east - a.east;
  const dn = b.north - a.north;
  const len = Math.hypot(de, dn) || 1;
  const nx = -dn / len;
  const ny = de / len;
  return (p.east - a.east) * nx + (p.north - a.north) * ny;
}

function projectPoint(trajectory, east, north) {
  if (!trajectory?.segments?.length) {
    return { valid: false, reason: 'emptyTrajectory' };
  }

  let best = null;
  for (const seg of trajectory.segments) {
    const proj = projectOnSegment(seg.a, seg.b, { east, north });
    const s = seg.s0 + proj.t * seg.length;
    const d = signedLateral(seg.a, seg.b, { east, north });
    if (!best || proj.dist < best.perpDist) {
      best = { s, d, perpDist: proj.dist, segIndex: seg.index, east: proj.east, north: proj.north };
    }
  }

  return { valid: true, ...best };
}

function sToMap(trajectory, s, d) {
  if (!trajectory?.segments?.length) return null;
  for (const seg of trajectory.segments) {
    if (s >= seg.s0 - 1e-6 && s <= seg.s1 + 1e-6) {
      const t = seg.length > 1e-9 ? (s - seg.s0) / seg.length : 0;
      const de = seg.b.east - seg.a.east;
      const dn = seg.b.north - seg.a.north;
      const len = Math.hypot(de, dn) || 1;
      const nx = -dn / len;
      const ny = de / len;
      const baseE = seg.a.east + t * de;
      const baseN = seg.a.north + t * dn;
      return { east: baseE + d * nx, north: baseN + d * ny };
    }
  }
  const last = trajectory.segments[trajectory.segments.length - 1];
  return { east: last.b.east, north: last.b.north };
}

function vehicleSAtTime(trajectory, logMonoTime) {
  if (!trajectory?.points?.length) return 0;
  const target = BigInt(logMonoTime);
  let best = trajectory.points[0];
  let bestDt = absBigInt(BigInt(best.logMonoTime) - target);
  for (const p of trajectory.points) {
    const dt = absBigInt(BigInt(p.logMonoTime) - target);
    if (dt < bestDt) { bestDt = dt; best = p; }
  }
  const proj = projectPoint(trajectory, best.east, best.north);
  return proj.valid ? proj.s : 0;
}

function absBigInt(v) { return v < 0n ? -v : v; }



global.Trajectory = { buildReferenceTrajectory };

/**
 * Temporal projection — project onto trajectory segments near observation time only.
 */


function absBigInt(v) { return v < 0n ? -v : v; }

function findNearestPathIndex(trajectory, logMonoTime) {
  if (!trajectory?.points?.length) return 0;
  const target = BigInt(logMonoTime);
  let bestIdx = 0;
  let bestDt = absBigInt(BigInt(trajectory.points[0].logMonoTime) - target);
  for (let i = 0; i < trajectory.points.length; i++) {
    const dt = absBigInt(BigInt(trajectory.points[i].logMonoTime) - target);
    if (dt < bestDt) { bestDt = dt; bestIdx = i; }
  }
  return bestIdx;
}

function projectPointTemporal(trajectory, east, north, logMonoTime, options = {}) {
  if (!trajectory?.segments?.length) {
    return { valid: false, reason: 'emptyTrajectory' };
  }

  const temporalWindow = options.temporalWindowSegments ?? 4;
  const maxTimeDeltaNs = options.maxProjectionTimeDeltaNs ?? 4e9;
  const centerIdx = findNearestPathIndex(trajectory, logMonoTime);
  const obsTime = BigInt(logMonoTime);

  const segStart = Math.max(0, centerIdx - temporalWindow);
  const segEnd = Math.min(trajectory.segments.length - 1, centerIdx + temporalWindow - 1);

  let best = null;
  let ambiguous = false;
  const candidates = [];

  for (let si = segStart; si <= segEnd; si++) {
    const seg = trajectory.segments[si];
    const proj = projectOnSegment(seg.a, seg.b, { east, north });
    const s = seg.s0 + proj.t * seg.length;
    const d = signedLateral(seg.a, seg.b, { east, north });
    const midTime = BigInt(seg.a.logMonoTime) + (BigInt(seg.b.logMonoTime) - BigInt(seg.a.logMonoTime)) / 2n;
    const timeDeltaNs = Number(absBigInt(obsTime - midTime));
    candidates.push({ s, d, perpDist: proj.dist, segIndex: si, timeDeltaNs });

    if (timeDeltaNs > maxTimeDeltaNs) continue;
    if (!best || proj.dist < best.perpDist) {
      if (best && Math.abs(proj.dist - best.perpDist) < 1.0 && Math.abs(s - best.s) > 10) {
        ambiguous = true;
      }
      best = { s, d, perpDist: proj.dist, segIndex: si, timeDeltaNs };
    }
  }

  if (!best) {
    return { valid: false, reason: 'outsideTemporalWindow', candidates: candidates.length };
  }

  return {
    valid: true,
    ...best,
    ambiguous,
    projectionMethod: 'temporal',
  };
}

function projectPointGlobal(trajectory, east, north) {
  if (!trajectory?.segments?.length) return { valid: false, reason: 'emptyTrajectory' };
  let best = null;
  for (const seg of trajectory.segments) {
    const proj = projectOnSegment(seg.a, seg.b, { east, north });
    const s = seg.s0 + proj.t * seg.length;
    const d = signedLateral(seg.a, seg.b, { east, north });
    if (!best || proj.dist < best.perpDist) {
      best = { s, d, perpDist: proj.dist, segIndex: seg.index };
    }
  }
  return { valid: true, ...best, projectionMethod: 'global' };
}

function compareProjectionMethods(trajectory, observations, options = {}) {
  let changed = 0;
  const diffs = [];
  for (const obs of observations) {
    const global = projectPointGlobal(trajectory, obs.east, obs.north);
    const temporal = projectPointTemporal(trajectory, obs.east, obs.north, obs.logMonoTime, options);
    if (!global.valid || !temporal.valid) continue;
    const ds = Math.abs(global.s - temporal.s);
    if (ds > 5) {
      changed++;
      diffs.push({ frameId: obs.frameId, globalS: global.s, temporalS: temporal.s, deltaS: ds, ambiguous: temporal.ambiguous });
    }
  }
  return { changedCount: changed, total: observations.length, diffs };
}

function vehicleSAtTimeTemporal(trajectory, logMonoTime) {
  const idx = findNearestPathIndex(trajectory, logMonoTime);
  if (!trajectory.points[idx]) return 0;
  const p = trajectory.points[idx];
  const proj = projectPointTemporal(trajectory, p.east, p.north, logMonoTime, {});
  return proj.valid ? proj.s : 0;
}



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




/**
 * Segment 2 cleaned-run audit, separation classification, and join diagnostics.
 */


const DEFAULT_AUDIT_OPTS = {
  maxFragmentSdGapM: 12,
  maxAdaptiveJoinGapM: 18,
  dropoutScaleGapM: 30,
  duplicateMeanDM: 0.8,
  duplicateMinOverlapM: 15,
  complementaryMaxGapM: 250,
  maxComplementaryLateralDriftM: 1.5,
  minSeparationForNeighbourM: 1.2,
  maxJoinLateralDeltaM: 0.8,
  maxJoinHeadingDeltaDeg: 25,
  fusionIntervalM: 2,
};

const SEP_CLASSES = {
  NO_DETECTION: 'A',
  TRACK_REJECTED: 'B',
  TRACK_ID_CHANGE: 'C',
  FUSION_INSUFFICIENT_OBS: 'D',
  FUSION_INSUFFICIENT_FRAMES: 'E',
  FUSION_SPIKE_OUTLIER: 'F',
  WITHIN_MERGE_LIMIT_NOT_MERGED: 'G',
  ABOVE_LIMIT_STRONG_EVIDENCE: 'H',
  DIFFERENT_BOUNDARY: 'I',
  CHUNK_BOUNDARY: 'J',
  PASS_BOUNDARY: 'K',
  RENDERING_SPLIT: 'L',
  SINGLE_LANE_END: 'M',
  OTHER: 'N',
};

function headingDegFromPoints(points) {
  if (!points || points.length < 2) return null;
  const a = points[0];
  const b = points[points.length - 1];
  return (Math.atan2(b.north - a.north, b.east - a.east) * 180) / Math.PI;
}

function headingFromSd(sdPoints) {
  if (!sdPoints || sdPoints.length < 2) return null;
  const ds = sdPoints[sdPoints.length - 1].s - sdPoints[0].s;
  const dd = sdPoints[sdPoints.length - 1].d - sdPoints[0].d;
  if (Math.abs(ds) < 0.01) return null;
  return (Math.atan2(dd, ds) * 180) / Math.PI;
}

function curvatureSummary(sdPoints) {
  if (!sdPoints || sdPoints.length < 3) return { maxHeadingDeltaDeg: 0, meanAbsCurvature: 0 };
  let maxDelta = 0;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < sdPoints.length - 1; i++) {
    const v1s = sdPoints[i].s - sdPoints[i - 1].s;
    const v1d = sdPoints[i].d - sdPoints[i - 1].d;
    const v2s = sdPoints[i + 1].s - sdPoints[i].s;
    const v2d = sdPoints[i + 1].d - sdPoints[i].d;
    const h1 = Math.atan2(v1d, v1s);
    const h2 = Math.atan2(v2d, v2s);
    let delta = ((h2 - h1) * 180) / Math.PI;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    maxDelta = Math.max(maxDelta, Math.abs(delta));
    sum += Math.abs(delta);
    n++;
  }
  return { maxHeadingDeltaDeg: maxDelta, meanAbsCurvature: n ? sum / n : 0 };
}

function frameIndexForFrameId(frames, frameId) {
  const idx = frames.findIndex((f) => f.frameId === frameId);
  return idx >= 0 ? idx : null;
}

function assignPhysicalBoundaryGroups(trackStats, tracks, opts = {}) {
  const groups = [];
  const trackToGroup = new Map();
  const trackIds = [...trackStats.keys()].sort((a, b) => a - b);

  for (const tid of trackIds) {
    if (trackToGroup.has(tid)) continue;
    const stats = trackStats.get(tid);
    const group = {
      physicalBoundaryId: `PB${groups.length}`,
      trackIds: [tid],
      meanD: stats?.meanD ?? 0,
      side: (stats?.meanD ?? 0) >= 0 ? 'left' : 'right',
      complementary: false,
    };

    for (const other of trackIds) {
      if (other === tid || trackToGroup.has(other)) continue;
      const statsB = trackStats.get(other);
      if (!stats || !statsB) continue;
      const sameSide = Math.sign(stats.meanD) === Math.sign(statsB.meanD);
      const overlap = Math.max(0, Math.min(stats.maxS, statsB.maxS) - Math.max(stats.minS, statsB.minS));
      const gap = Math.max(stats.minS, statsB.minS) - Math.min(stats.maxS, statsB.maxS);
      const dSep = Math.abs(stats.meanD - statsB.meanD);

      if (sameSide && dSep <= (opts.duplicateMeanDM ?? 0.8) && overlap >= (opts.duplicateMinOverlapM ?? 15)) {
        group.trackIds.push(other);
        trackToGroup.set(other, group.physicalBoundaryId);
      } else if (
        sameSide
        && dSep <= (opts.maxComplementaryLateralDriftM ?? 1.5)
        && gap > 0
        && overlap <= (opts.duplicateMinOverlapM ?? 15)
        && gap <= (opts.complementaryMaxGapM ?? 250)
      ) {
        group.trackIds.push(other);
        group.complementary = true;
        trackToGroup.set(other, group.physicalBoundaryId);
      }
    }
    trackToGroup.set(tid, group.physicalBoundaryId);
    groups.push(group);
  }
  return { groups, trackToGroup };
}

function deriveAdaptiveJoinGapM(fragments, opts = {}) {
  const allSd = fragments.flatMap((f) => f.sdPoints || []);
  const { safeBridgeGapM, p90IntraGapM, sampleCount } = deriveSafeSurfaceBridgeGapM(allSd, allSd, {
    fusionIntervalM: opts.fusionIntervalM ?? 2,
    dropoutScaleGapM: opts.dropoutScaleGapM ?? 30,
  });
  const hardCap = opts.maxAdaptiveJoinGapM ?? 18;
  return {
    adaptiveJoinGapM: Math.min(safeBridgeGapM, hardCap),
    p90IntraGapM,
    sampleCount,
    hardCap,
    defaultMergeGapM: opts.maxFragmentSdGapM ?? 12,
  };
}

function endpointCompatibility(fragA, fragB, opts = {}) {
  const sdA = fragA.sdPoints || [];
  const sdB = fragB.sdPoints || [];
  if (!sdA.length || !sdB.length) return { compatible: false, reason: 'missingSd' };
  const endA = sdA[sdA.length - 1];
  const startB = sdB[0];
  const gapM = startB.s - endA.s;
  const dDelta = Math.abs(startB.d - endA.d);
  const hA = headingFromSd(sdA.slice(-2).length >= 2 ? sdA.slice(-2) : sdA);
  const hB = headingFromSd(sdB.slice(0, 2).length >= 2 ? sdB.slice(0, 2) : sdB);
  let headingDelta = null;
  if (hA != null && hB != null) {
    headingDelta = Math.abs(((hB - hA + 540) % 360) - 180);
  }
  const maxD = opts.maxJoinLateralDeltaM ?? 0.8;
  const maxH = opts.maxJoinHeadingDeltaDeg ?? 25;
  if (dDelta > maxD) return { compatible: false, gapM, dDelta, headingDelta, reason: 'lateralMismatch' };
  if (headingDelta != null && headingDelta > maxH) {
    return { compatible: false, gapM, dDelta, headingDelta, reason: 'headingMismatch' };
  }
  return { compatible: true, gapM, dDelta, headingDelta, reason: null };
}

function hasCompetingBoundaryInGap(gapStartS, gapEndS, allFrags, excludeTrackIds, opts = {}) {
  const minSep = opts.minSeparationForNeighbourM ?? 1.2;
  for (const frag of allFrags) {
    if (excludeTrackIds.has(frag.laneTrackId)) continue;
    const sd = frag.sdPoints || [];
    if (!sd.length) continue;
    const minS = Math.min(...sd.map((p) => p.s));
    const maxS = Math.max(...sd.map((p) => p.s));
    if (maxS < gapStartS || minS > gapEndS) continue;
    const meanD = sd.reduce((s, p) => s + p.d, 0) / sd.length;
    const refD = (frag.sdPoints?.[0]?.d ?? 0);
    if (Math.abs(meanD - refD) < minSep) continue;
    return { competing: true, laneTrackId: frag.laneTrackId, meanD };
  }
  return { competing: false };
}

function evaluateJoinEligibility(prevFrag, nextFrag, context) {
  const opts = { ...DEFAULT_AUDIT_OPTS, ...context.options };
  const compat = endpointCompatibility(prevFrag, nextFrag, opts);
  const gapM = compat.gapM ?? Infinity;
  const dropoutScale = opts.dropoutScaleGapM ?? 30;
  const adaptive = context.adaptiveJoinGapM ?? opts.maxFragmentSdGapM ?? 12;

  if (prevFrag.chunkId != null && nextFrag.chunkId != null && prevFrag.chunkId !== nextFrag.chunkId) {
    return { safeToJoin: false, classification: SEP_CLASSES.CHUNK_BOUNDARY, gapM, reason: 'differentChunk' };
  }
  if (prevFrag.passId != null && nextFrag.passId != null && prevFrag.passId !== nextFrag.passId) {
    return { safeToJoin: false, classification: SEP_CLASSES.PASS_BOUNDARY, gapM, reason: 'differentPass' };
  }
  if (context.physicalBoundaryId && context.physicalBoundaryId !== context.nextPhysicalBoundaryId) {
    return { safeToJoin: false, classification: SEP_CLASSES.DIFFERENT_BOUNDARY, gapM, reason: 'differentPhysicalBoundary' };
  }
  if (gapM >= dropoutScale) {
    return { safeToJoin: false, classification: SEP_CLASSES.NO_DETECTION, gapM, reason: 'dropoutScaleGap' };
  }
  if (!compat.compatible) {
    return {
      safeToJoin: false,
      classification: compat.reason === 'headingMismatch' ? SEP_CLASSES.FUSION_SPIKE_OUTLIER : SEP_CLASSES.FUSION_SPIKE_OUTLIER,
      gapM,
      dDelta: compat.dDelta,
      headingDelta: compat.headingDelta,
      reason: compat.reason,
    };
  }
  const competitor = hasCompetingBoundaryInGap(
    (prevFrag.sdPoints?.slice(-1)[0]?.s ?? 0),
    (nextFrag.sdPoints?.[0]?.s ?? 0),
    context.allFragments || [],
    new Set(context.trackIds || []),
    opts,
  );
  if (competitor.competing) {
    return { safeToJoin: false, classification: SEP_CLASSES.DIFFERENT_BOUNDARY, gapM, reason: 'competingBoundaryInGap', competitor };
  }

  if (gapM <= opts.maxFragmentSdGapM) {
    return { safeToJoin: true, classification: SEP_CLASSES.WITHIN_MERGE_LIMIT_NOT_MERGED, gapM, reason: 'withinDefaultMergeLimit' };
  }
  if (gapM <= adaptive) {
    return { safeToJoin: true, classification: SEP_CLASSES.ABOVE_LIMIT_STRONG_EVIDENCE, gapM, reason: 'adaptiveEvidenceJoin' };
  }
  if (gapM > adaptive && gapM < dropoutScale) {
    return { safeToJoin: false, classification: SEP_CLASSES.FUSION_INSUFFICIENT_OBS, gapM, reason: 'sparseFusionGap' };
  }
  return { safeToJoin: false, classification: SEP_CLASSES.OTHER, gapM, reason: 'unclassified' };
}

function sourceFusedLength(runFrags) {
  let len = 0;
  for (const frag of runFrags) {
    len += polylineLength(frag.points || []);
  }
  return len;
}

function buildRunAuditRecord({
  run,
  runId,
  physicalBoundaryId,
  frames,
  frameById,
  prevRun,
  nextRun,
  joinToPrev,
  joinToNext,
}) {
  const sd = run.sdPoints || [];
  const ds = sd.map((p) => p.d);
  const frameIds = new Set();
  for (const frag of run.sourceFragments || []) {
    if (frag.supportingFrameCount) frameIds.add(frag.supportingFrameCount);
  }
  const elapsedIdx = (run.sourceFragments || [])
    .flatMap((f) => f.sourceElapsedIdx || [])
    .filter((x) => x != null);
  const startCoord = run.points?.[0] ? { east: run.points[0].east, north: run.points[0].north } : null;
  const endCoord = run.points?.length ? { east: run.points[run.points.length - 1].east, north: run.points[run.points.length - 1].north } : null;

  return {
    runId,
    physicalBoundaryId,
    sourceTrackIds: run.logicalGroupTrackIds || [run.laneTrackId],
    primaryTrackId: run.laneTrackId,
    chunkId: run.chunkId ?? 0,
    passId: run.passId ?? 0,
    laneSide: (run.meanD ?? 0) >= 0 ? 'left' : 'right',
    lateralOrder: run.lateralOrder,
    startElapsedIdx: elapsedIdx.length ? Math.min(...elapsedIdx) : null,
    endElapsedIdx: elapsedIdx.length ? Math.max(...elapsedIdx) : null,
    startFrameId: run.sourceFragments?.[0]?.sourceFrameIds?.[0] ?? null,
    endFrameId: run.sourceFragments?.slice(-1)[0]?.sourceFrameIds?.slice(-1)[0] ?? null,
    startS: run.sMin,
    endS: run.sMax,
    lengthM: run.lengthM,
    fusedBinCount: run.sourceFragmentCount,
    contributingObservationCount: run.contributingObservationCount ?? null,
    distinctSupportingFrameCount: run.distinctSupportingFrameCount ?? frameIds.size,
    meanConfidence: run.meanConfidence ?? null,
    minConfidence: run.minConfidence ?? null,
    meanD: run.meanD,
    lateralRangeD: ds.length ? { min: Math.min(...ds), max: Math.max(...ds) } : null,
    meanHeadingDeg: headingDegFromPoints(run.points),
    curvature: curvatureSummary(sd),
    startCoord,
    endCoord,
    gapToPrecedingCompatibleRunM: prevRun && run.sMin != null && prevRun.sMax != null ? run.sMin - prevRun.sMax : null,
    gapToNextCompatibleRunM: nextRun && run.sMax != null && nextRun.sMin != null ? nextRun.sMin - run.sMax : null,
    lateralDeltaAtPrecedingEndpoint: prevRun ? Math.abs((run.sdPoints?.[0]?.d ?? 0) - (prevRun.sdPoints?.slice(-1)[0]?.d ?? 0)) : null,
    headingDeltaAtPrecedingEndpoint: joinToPrev?.headingDelta ?? null,
    joinToPreceding: joinToPrev ? {
      safeToJoin: joinToPrev.safeToJoin,
      classification: joinToPrev.classification,
      reason: joinToPrev.reason,
      joined: joinToPrev.wasJoined ?? false,
    } : null,
    joinToNext: joinToNext ? {
      safeToJoin: joinToNext.safeToJoin,
      classification: joinToNext.classification,
      reason: joinToNext.reason,
      joined: joinToNext.wasJoined ?? false,
    } : null,
    sourceFusedLengthM: run.sourceFusedLengthM,
    cleanedLengthM: run.lengthM,
    renderedLengthM: run.lengthM,
    sourcePointCount: run.sourcePointCount,
    cleanedPointCount: run.points?.length ?? 0,
    renderedPointCount: run.points?.length ?? 0,
    supportStatus: run.supportStatus,
  };
}

function auditCleanedRuns({
  frames = [],
  fusedLanes = [],
  tracks = [],
  cleaned = [],
  mergeDecisions = [],
  physicalBoundaryGroups = [],
  chunkId = 0,
  passId = 0,
}) {
  const byPb = new Map();
  for (const run of cleaned) {
    const pb = run.physicalBoundaryId || `PB-${run.laneTrackId}`;
    if (!byPb.has(pb)) byPb.set(pb, []);
    byPb.get(pb).push(run);
  }
  for (const runs of byPb.values()) {
    runs.sort((a, b) => (a.sMin ?? 0) - (b.sMin ?? 0));
  }

  const runs = [];
  let runId = 0;
  const sortedPb = [...byPb.entries()].sort((a, b) => {
    const ma = a[1][0]?.meanD ?? 0;
    const mb = b[1][0]?.meanD ?? 0;
    return mb - ma;
  });

  for (const [pbId, pbRuns] of sortedPb) {
    for (let i = 0; i < pbRuns.length; i++) {
      const run = pbRuns[i];
      const prev = i > 0 ? pbRuns[i - 1] : null;
      const next = i < pbRuns.length - 1 ? pbRuns[i + 1] : null;
      const joinPrev = mergeDecisions.find((d) => d.runB === run && d.runA === prev) || null;
      const joinNext = mergeDecisions.find((d) => d.runA === run && d.runB === next) || null;
      runs.push(buildRunAuditRecord({
        run,
        runId: runId++,
        physicalBoundaryId: pbId,
        frames,
        prevRun: prev,
        nextRun: next,
        joinToPrev: joinPrev,
        joinToNext: joinNext,
      }));
    }
  }

  const separations = mergeDecisions.filter((d) => !d.wasJoined).map((d) => ({
    classification: d.classification,
    gapM: d.gapM,
    physicalBoundaryId: d.physicalBoundaryId,
    sourceTrackIds: d.trackIds,
    sourceEvidenceInGap: d.sourceEvidenceInGap ?? null,
    compatibleEndpoints: d.compatible,
    competingLaneEvidence: d.competitor ?? null,
    currentRejectionCondition: d.reason,
    safeToJoin: d.safeToJoin,
    reason: d.reason,
    prevRunS: d.endS,
    nextRunS: d.startS,
  }));

  const classSummary = {};
  for (const sep of separations) {
    const c = sep.classification || 'N';
    if (!classSummary[c]) classSummary[c] = { count: 0, totalGapM: 0 };
    classSummary[c].count++;
    classSummary[c].totalGapM += sep.gapM ?? 0;
  }

  return {
    generatedAt: new Date().toISOString(),
    segment: 'qlog_f449c_2.bz2',
    chunkId,
    passId,
    physicalBoundaryGroups,
    runCount: runs.length,
    separationCount: separations.length,
    runs,
    separations,
    classificationSummary: classSummary,
  };
}




/**
 * Route-s interval and polyline arc-length coverage accounting.
 * Keeps fused, preserved, overlap, and union metrics separate.
 */


const DEFAULT_TOLERANCE_M = 0.05;

function intervalsFromRuns(runs) {
  return (runs || [])
    .map((r) => {
      const sd = r.sdPoints || [];
      if (sd.length < 2) return null;
      return {
        startS: Math.min(...sd.map((p) => p.s)),
        endS: Math.max(...sd.map((p) => p.s)),
        runId: r.runId,
        physicalBoundaryId: r.physicalBoundaryId,
        laneTrackId: r.laneTrackId,
        layer: r.layer || 'acceptedFused',
      };
    })
    .filter(Boolean);
}

function intervalsFromPreserved(preservedIntervals) {
  return (preservedIntervals || []).map((p) => ({
    startS: p.startS,
    endS: p.endS,
    gapId: p.gapId,
    physicalBoundaryGroup: p.physicalBoundaryGroup,
    trackId: p.trackId,
    layer: p.isTailExtension ? 'd12TailExtension' : 'd12Preserved',
  }));
}

function mergeIntervals(intervals) {
  if (!intervals?.length) return [];
  const sorted = [...intervals].sort((a, b) => a.startS - b.startS);
  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = merged[merged.length - 1];
    if (cur.startS <= last.endS + DEFAULT_TOLERANCE_M) {
      last.endS = Math.max(last.endS, cur.endS);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

function intervalUnionLength(intervals) {
  return mergeIntervals(intervals).reduce((s, iv) => s + (iv.endS - iv.startS), 0);
}

function intervalOverlapLength(a, b) {
  const mergedA = mergeIntervals(a);
  const mergedB = mergeIntervals(b);
  let overlap = 0;
  for (const ivA of mergedA) {
    for (const ivB of mergedB) {
      const start = Math.max(ivA.startS, ivB.startS);
      const end = Math.min(ivA.endS, ivB.endS);
      if (end > start) overlap += end - start;
    }
  }
  return overlap;
}

function intervalSpanSum(intervals) {
  return (intervals || []).reduce((s, iv) => s + (iv.endS - iv.startS), 0);
}

function polylineArcLengthFromRuns(runs) {
  return (runs || []).reduce((s, r) => s + polylineLength(r.points || []), 0);
}

function polylineArcLengthFromPreserved(preservedIntervals) {
  return (preservedIntervals || []).reduce((s, p) => {
    const pts = (p.points || []).map((pt) => ({ east: pt.east, north: pt.north }));
    return s + polylineLength(pts);
  }, 0);
}

/**
 * Full coverage breakdown for cleaned lane map layers.
 */
function computeCoverageAccounting({
  cleanedFusedOnly = [],
  cleanedWithPreserved = [],
  preservedIntervals = [],
  toleranceM = DEFAULT_TOLERANCE_M,
}) {
  const acceptedIntervals = intervalsFromRuns(cleanedFusedOnly.map((r) => ({ ...r, layer: 'acceptedFused' })));
  const displayIntervals = intervalsFromRuns(cleanedWithPreserved.map((r) => ({ ...r, layer: 'display' })));
  const preservedOnlyIntervals = intervalsFromPreserved(preservedIntervals);

  const acceptedUnionM = intervalUnionLength(acceptedIntervals);
  const preservedUnionM = intervalUnionLength(preservedOnlyIntervals);
  const overlapM = intervalOverlapLength(acceptedIntervals, preservedOnlyIntervals);
  const combinedUnionM = intervalUnionLength([...acceptedIntervals, ...preservedOnlyIntervals]);

  const acceptedSpanSumM = intervalSpanSum(acceptedIntervals);
  const preservedSpanSumM = intervalSpanSum(preservedOnlyIntervals);
  const displaySpanSumM = intervalSpanSum(displayIntervals);

  const acceptedArcM = polylineArcLengthFromRuns(cleanedFusedOnly);
  const preservedArcM = polylineArcLengthFromPreserved(preservedIntervals);
  const displayArcM = polylineArcLengthFromRuns(cleanedWithPreserved);

  const naiveSpanSumM = acceptedSpanSumM + preservedSpanSumM;
  const displayMinusAcceptedM = displaySpanSumM - acceptedSpanSumM;

  return {
    toleranceM,
    routeSIntervalCoverage: {
      acceptedFusedUnionM: acceptedUnionM,
      d12PreservedUnionM: preservedUnionM,
      overlapAcceptedAndPreservedM: overlapM,
      combinedSupportedUnionM: combinedUnionM,
      acceptedSpanSumM,
      preservedSpanSumM,
      displayCleanedSpanSumM: displaySpanSumM,
      naiveSpanSumM,
      naiveAcceptedPlusPreservedM: naiveSpanSumM,
      displayMinusNaiveSpanSumM: displaySpanSumM - naiveSpanSumM,
      combinedMinusNaiveSumM: combinedUnionM - naiveSpanSumM,
      displaySpanMinusAcceptedSpanM: displayMinusAcceptedM,
    },
    polylineArcLength: {
      acceptedFusedArcM: acceptedArcM,
      d12PreservedArcM: preservedArcM,
      displayCleanedArcM: displayArcM,
    },
    reconciliation: {
      combinedEqualsUnionWithinTolerance: Math.abs(combinedUnionM - (acceptedUnionM + preservedUnionM - overlapM)) <= toleranceM + 0.01,
      spanSumReconcilesWithinTolerance: Math.abs((displaySpanSumM - naiveSpanSumM)) < 1.0,
      explanation: overlapM > toleranceM
        ? 'combined union differs from span-sum naive total when preserved intervals overlap accepted fused spans inside merged display runs'
        : (Math.abs(displaySpanSumM - naiveSpanSumM) > toleranceM
          ? 'display span sum exceeds naive span sum when merged runs extend s-range across gap boundaries without adding unique union length'
          : 'metrics reconcile within tolerance'),
    },
  };
}

function d12OpenLength(preservedIntervals, gapIntervals) {
  let totalOpen = 0;
  for (const gap of gapIntervals || []) {
    const preserved = (preservedIntervals || []).filter((p) => p.gapId === gap.gapId || p.parentGapId === gap.gapId);
    const covered = mergeIntervals(preserved.map((p) => ({ startS: p.startS, endS: p.endS })));
    let coveredLen = intervalUnionLength(covered);
    const gapLen = gap.endS - gap.startS;
    totalOpen += Math.max(0, gapLen - Math.min(coveredLen, gapLen));
  }
  return totalOpen;
}




/**
 * Drawable path analysis for cleaned lane runs.
 * Detects unsupported intervals that must not receive canvas line segments.
 */


const UNSUPPORTED_S_GAP_M = 0.15;
const RENDERER_MAX_GAP_M = 15;

function euclideanM(a, b) {
  return Math.hypot(b.east - a.east, b.north - a.north);
}

/**
 * Split one cleaned run into drawable components at internal unsupported breaks.
 */
function splitRunIntoDrawableComponents(run, openIntervals = []) {
  const pts = run.points || [];
  const sd = run.sdPoints || [];
  const prov = run.pointProvenance || [];
  if (pts.length < 2) {
    return [{
      drawableComponentId: `${run.runId}:0`,
      runId: run.runId,
      physicalBoundaryId: run.physicalBoundaryId,
      laneTrackId: run.laneTrackId,
      componentIndex: 0,
      points: pts,
      sdPoints: sd,
      pointProvenance: prov,
      sMin: sd[0]?.s ?? run.sMin,
      sMax: sd[sd.length - 1]?.s ?? run.sMax,
      breakBefore: false,
    }];
  }

  const components = [];
  let current = {
    points: [pts[0]],
    sdPoints: [sd[0]],
    pointProvenance: [prov[0]],
    startIndex: 0,
  };

  const isUnsupportedInternal = (i) => {
    const sPrev = sd[i - 1]?.s;
    const sCur = sd[i]?.s;
    if (sPrev == null || sCur == null) return false;
    const ds = sCur - sPrev;
    if (ds <= UNSUPPORTED_S_GAP_M) return false;
    const openHit = openIntervals.some((iv) => sPrev < iv.endS - 0.01 && sCur > iv.startS + 0.01
      && sCur - sPrev > UNSUPPORTED_S_GAP_M);
    if (openHit) return true;
    const pidPrev = prov[i - 1];
    const pidCur = prov[i];
    if (pidPrev === PROVENANCE_TYPE && pidCur === PROVENANCE_TYPE) {
      const metaPrev = run.displayPointMeta?.[i - 1];
      const metaCur = run.displayPointMeta?.[i];
      if (metaPrev?.sourcePolylineId && metaCur?.sourcePolylineId
        && metaPrev.sourcePolylineId !== metaCur.sourcePolylineId) {
        return true;
      }
    }
    return false;
  };

  for (let i = 1; i < pts.length; i++) {
    if (isUnsupportedInternal(i)) {
      components.push(current);
      current = {
        points: [pts[i]],
        sdPoints: [sd[i]],
        pointProvenance: [prov[i]],
        startIndex: i,
        breakBefore: true,
        breakReason: 'unsupportedSourcePolylineGap',
        openIntervalStartS: sd[i - 1]?.s,
        openIntervalEndS: sd[i]?.s,
        openLengthM: (sd[i]?.s ?? 0) - (sd[i - 1]?.s ?? 0),
      };
    } else {
      current.points.push(pts[i]);
      current.sdPoints.push(sd[i]);
      current.pointProvenance.push(prov[i]);
    }
  }
  components.push(current);

  return components.map((c, ci) => ({
    drawableComponentId: `${run.runId}:${ci}`,
    runId: run.runId,
    physicalBoundaryId: run.physicalBoundaryId,
    laneTrackId: run.laneTrackId,
    componentIndex: ci,
    points: c.points,
    sdPoints: c.sdPoints,
    pointProvenance: c.pointProvenance,
    sMin: c.sdPoints[0]?.s,
    sMax: c.sdPoints[c.sdPoints.length - 1]?.s,
    breakBefore: c.breakBefore ?? false,
    breakReason: c.breakReason ?? null,
    openIntervalStartS: c.openIntervalStartS ?? null,
    openIntervalEndS: c.openIntervalEndS ?? null,
    openLengthM: c.openLengthM ?? null,
  }));
}

/**
 * Detect unsupported breaks between consecutive cleaned runs on the same PB/track.
 */
function detectInterRunBreaks(runs, preservedIntervals = []) {
  const breaks = [];
  const partialGaps = preservedIntervals.filter((p) => !p.fullCoverage && !p.isTailExtension);

  for (const gap of partialGaps) {
    const pb = gap.physicalBoundaryGroup;
    const trackId = gap.trackId;
    const tail = preservedIntervals.find((p) => p.parentGapId === gap.gapId && p.isTailExtension);
    const openStart = gap.endS;
    const openEnd = gap.gapEndS;
    if (openEnd - openStart < 0.05 && !tail) continue;

    const pbRuns = runs
      .filter((r) => r.physicalBoundaryId === pb && r.laneTrackId === trackId)
      .sort((a, b) => (a.sMin ?? 0) - (b.sMin ?? 0));

    for (let i = 0; i < pbRuns.length - 1; i++) {
      const a = pbRuns[i];
      const b = pbRuns[i + 1];
      const aEnd = a.sMax ?? a.sdPoints?.[a.sdPoints.length - 1]?.s;
      const bStart = b.sMin ?? b.sdPoints?.[0]?.s;
      if (aEnd == null || bStart == null) continue;
      const openLen = bStart - aEnd;
      if (openLen < UNSUPPORTED_S_GAP_M) continue;
      const overlapsOpen = aEnd <= openEnd + 0.01 && bStart >= openStart - 0.01
        && openLen > UNSUPPORTED_S_GAP_M;
      if (!overlapsOpen) continue;

      const aLast = a.points?.[a.points.length - 1];
      const bFirst = b.points?.[0];
      const labelEast = aLast && bFirst ? (aLast.east + bFirst.east) / 2 : null;
      const labelNorth = aLast && bFirst ? (aLast.north + bFirst.north) / 2 : null;
      breaks.push({
        gapId: gap.gapId,
        physicalBoundaryId: pb,
        laneTrackId: trackId,
        precedingRunId: a.runId,
        followingRunId: b.runId,
        precedingComponentId: `${a.runId}:last`,
        followingComponentId: `${b.runId}:0`,
        openIntervalStartS: aEnd,
        openIntervalEndS: bStart,
        openLengthM: openLen,
        routeSDistanceM: openLen,
        euclideanDistanceM: aLast && bFirst ? euclideanM(aLast, bFirst) : null,
        labelEast,
        labelNorth,
        shareOneCanvasPath: false,
        rendererWouldBridge: false,
        breakReason: 'unsupportedSourcePolylineGap',
        breakBefore: true,
      });
    }
  }

  return breaks;
}

/**
 * Full drawable-path audit for cleaned lane map output.
 */
function analyzeDrawablePaths(cleaned, preservedIntervals = []) {
  const openIntervals = [];
  for (const gap of preservedIntervals.filter((p) => !p.isTailExtension)) {
    const tail = preservedIntervals.find((t) => t.parentGapId === gap.gapId && t.isTailExtension);
    if (!gap.fullCoverage) {
      if (gap.openAfterM > 0.05) {
        if (tail) {
          openIntervals.push({ gapId: gap.gapId, startS: gap.endS, endS: tail.startS, kind: 'primaryToTail' });
          if (tail.openAfterM > 0.05) {
            openIntervals.push({ gapId: gap.gapId, startS: tail.endS, endS: gap.gapEndS, kind: 'tailToFused' });
          }
        } else {
          openIntervals.push({ gapId: gap.gapId, startS: gap.endS, endS: gap.gapEndS, kind: 'preservedToFused' });
        }
      }
    }
  }

  const drawableComponents = [];
  for (const run of cleaned) {
    drawableComponents.push(...splitRunIntoDrawableComponents(run, openIntervals));
  }

  const interRunBreaks = detectInterRunBreaks(cleaned, preservedIntervals);

  return {
    logicalCleanedRunCount: cleaned.length,
    drawableSubpathCount: drawableComponents.length,
    drawableComponents,
    interRunBreaks,
    openIntervals,
    falseVisualBridgeDetected: interRunBreaks.some((b) => b.shareOneCanvasPath),
    falseVisualBridges: interRunBreaks.filter((b) => b.shareOneCanvasPath),
    rendererNote: 'Mode 5 draws one canvas path per cleaned run fragment; inter-run unsupported gaps are separate draw calls and do not receive line segments unless points share one coordinate array.',
  };
}

/**
 * Simulate canvas line segments for one polyline points array.
 */
function simulateRendererSegments(points, maxGapM = RENDERER_MAX_GAP_M) {
  const segments = [];
  if (!points?.length) return segments;
  let run = [0];
  for (let i = 1; i < points.length; i++) {
    const jump = euclideanM(points[i - 1], points[i]);
    if (jump > maxGapM) {
      if (run.length >= 2) {
        for (let j = 1; j < run.length; j++) {
          segments.push({ from: run[j - 1], to: run[j], euclideanM: euclideanM(points[run[j - 1]], points[run[j]]) });
        }
      }
      run = [i];
    } else {
      run.push(i);
    }
  }
  if (run.length >= 2) {
    for (let j = 1; j < run.length; j++) {
      segments.push({ from: run[j - 1], to: run[j], euclideanM: euclideanM(points[run[j - 1]], points[run[j]]) });
    }
  }
  return segments;
}

/**
 * Check whether any renderer segment within a single run crosses a recorded open interval.
 */
function segmentCrossesOpenInterval(seg, points, interval) {
  const s0 = points[seg.from]?.s;
  const s1 = points[seg.to]?.s;
  if (s0 == null || s1 == null) return false;
  const lo = Math.min(s0, s1);
  const hi = Math.max(s0, s1);
  return lo < interval.startS - 0.01 && hi > interval.endS + 0.01;
}

function verifyNoRendererBridgeAcrossGaps(cleaned, preservedIntervals, gapIds) {
  const analysis = analyzeDrawablePaths(cleaned, preservedIntervals);
  const violations = [];

  for (const gapId of gapIds) {
    const brk = analysis.interRunBreaks.find((b) => b.gapId === gapId);
    if (!brk) {
      violations.push({ gapId, reason: 'noInterRunBreakRecorded' });
      continue;
    }
    if (brk.shareOneCanvasPath) {
      violations.push({ gapId, reason: 'shareOneCanvasPath', brk });
    }

    const interval = {
      startS: brk.openIntervalStartS,
      endS: brk.openIntervalEndS,
    };

    for (const runId of [brk.precedingRunId, brk.followingRunId]) {
      const run = cleaned.find((r) => r.runId === runId);
      if (!run?.points?.length) continue;
      const pts = (run.sdPoints || []).map((sd, i) => ({
        s: sd.s,
        d: sd.d,
        east: run.points[i].east,
        north: run.points[i].north,
      }));
      const segs = simulateRendererSegments(pts);
      for (const seg of segs) {
        if (segmentCrossesOpenInterval(seg, pts, interval)) {
          violations.push({ gapId, runId, seg, reason: 'intraRunCrossesOpenInterval' });
        }
      }
    }
  }

  return { violations, analysis };
}




/**
 * D12 source-polyline preservation — provenance-preserving reconstruction only.
 * Does not alter fusion acceptance, interpolate, or fabricate coordinates.
 */


const PROVENANCE_TYPE = 'sourcePolylinePreserved';
const DEDUP_S_TOLERANCE_M = 0.05;
const DEDUP_XY_TOLERANCE_M = 0.02;
const MAX_LATERAL_JUMP_M = 2.5;
const MAX_HEADING_DELTA_DEG = 25;
const MAX_CURVATURE_DELTA_DEG = 35;
const MIN_COVERAGE_FRAC = 0.85;

/** Segment 2 D12 candidates — fallback when audit JSON unavailable (browser bundle). */
const SEGMENT2_D12_GAPS = [
  { gapId: 'CD-00', physicalBoundaryGroup: 'PB0', sourceTrackId: 0, startS: 42.29187659366445, endS: 65.78727043441252, primaryMechanism: 'D12', rejectedBinsInGap: 7 },
  { gapId: 'CD-02', physicalBoundaryGroup: 'PB0', sourceTrackId: 0, startS: 412.4419997969666, endS: 434.9420161044949, primaryMechanism: 'D12', rejectedBinsInGap: 7 },
  { gapId: 'CD-10', physicalBoundaryGroup: 'PB1', sourceTrackId: 2, startS: 412.22180615396644, endS: 434.5339771485253, primaryMechanism: 'D12', rejectedBinsInGap: 7 },
  { gapId: 'CD-12', physicalBoundaryGroup: 'PB1', sourceTrackId: 2, startS: 478.79387292483455, endS: 500.1206905235975, primaryMechanism: 'D12', rejectedBinsInGap: 6 },
  { gapId: 'CD-18', physicalBoundaryGroup: 'PB2', sourceTrackId: 3, startS: 412.2329184179182, endS: 434.5449151711091, primaryMechanism: 'D12', rejectedBinsInGap: 7 },
];

function headingFromSdPts(sdPoints) {
  if (!sdPoints || sdPoints.length < 2) return null;
  const ds = sdPoints[sdPoints.length - 1].s - sdPoints[0].s;
  const dd = sdPoints[sdPoints.length - 1].d - sdPoints[0].d;
  if (Math.abs(ds) < 0.01) return null;
  return (Math.atan2(dd, ds) * 180) / Math.PI;
}

function maxLateralJump(sdPoints) {
  let max = 0;
  for (let i = 1; i < sdPoints.length; i++) {
    max = Math.max(max, Math.abs(sdPoints[i].d - sdPoints[i - 1].d));
  }
  return max;
}

function maxCurvatureDeltaDeg(sdPoints) {
  if (sdPoints.length < 3) return 0;
  let max = 0;
  for (let i = 1; i < sdPoints.length - 1; i++) {
    const h1 = headingFromSdPts([sdPoints[i - 1], sdPoints[i]]);
    const h2 = headingFromSdPts([sdPoints[i], sdPoints[i + 1]]);
    if (h1 == null || h2 == null) continue;
    max = Math.max(max, Math.abs(((h2 - h1 + 540) % 360) - 180));
  }
  return max;
}

function extractMappedPolylinePoints(frame, lane, trajectory, sMin, sMax, options = {}) {
  const maxPerpDist = options.maxProjectionDistM ?? 25;
  const points = [];
  for (let i = 0; i < (lane.points || []).length; i++) {
    const pt = lane.points[i];
    const proj = projectPointTemporal(trajectory, pt.east, pt.north, frame.logMonoTime, options);
    if (!proj.valid || proj.ambiguous || proj.perpDist > maxPerpDist) continue;
    if (proj.s < sMin - 0.5 || proj.s > sMax + 0.5) continue;
    if (!Number.isFinite(proj.s) || !Number.isFinite(proj.d)) continue;
    const map = sToMap(trajectory, proj.s, proj.d);
    points.push({
      east: map.east,
      north: map.north,
      s: proj.s,
      d: proj.d,
      originalPointIndex: i,
      sourceConfidence: lane.prob ?? 1,
    });
  }
  points.sort((a, b) => a.s - b.s);
  return points;
}

function polylineId(frameId, laneIndex, laneTrackId) {
  return `${frameId}:L${laneIndex}:T${laneTrackId}`;
}

function findBestSpanningPolyline(frames, trajectory, gap, trackId, chunkId, passId, options = {}) {
  const { startS, endS } = gap;
  const gapM = endS - startS;
  const excludePolylineId = options.excludePolylineId;
  const minInteriorS = options.minInteriorS;
  let best = null;

  for (const frame of frames) {
    if (frame.chunkId != null && frame.chunkId !== chunkId) continue;
    if (frame.passId != null && frame.passId !== passId) continue;
    for (const lane of frame.lanes || []) {
      if (lane.laneTrackId !== trackId) continue;
      const pid = polylineId(frame.frameId, lane.laneIndex, trackId);
      if (excludePolylineId && pid === excludePolylineId) continue;
      const mapped = extractMappedPolylinePoints(frame, lane, trajectory, startS, endS);
      if (mapped.length < 2) continue;
      const interior = minInteriorS != null
        ? mapped.filter((p) => p.s > minInteriorS + 0.01)
        : mapped;
      if (interior.length < 2) continue;
      const spanStart = mapped[0].s;
      const spanEnd = mapped[mapped.length - 1].s;
      const spanM = spanEnd - spanStart;
      const coversStart = spanStart <= startS + 0.5;
      const coversEnd = spanEnd >= endS - 0.5;
      const entersOpenTail = minInteriorS != null
        ? interior.some((p) => p.s > minInteriorS + 0.05)
        : true;
      if (minInteriorS != null && !entersOpenTail) continue;
      const score = (coversStart ? 1000 : 0) + (coversEnd ? 1000 : 0) + spanM;
      if (!best || score > best.score) {
        best = {
          score,
          frameId: frame.frameId,
          logMonoTime: frame.logMonoTime,
          laneIndex: lane.laneIndex,
          sourcePolylineId: pid,
          mappedPoints: mapped,
          interiorPoints: interior,
          spanStart,
          spanEnd,
          spanM,
          coversStart,
          coversEnd,
          coverageFrac: spanM / gapM,
          originalPointCount: lane.points?.length ?? 0,
          sourceConfidence: lane.prob ?? 1,
        };
      }
    }
  }
  return best;
}

function listCandidatePolylinesInRange(frames, trajectory, range, trackId, chunkId, passId) {
  const { startS, endS } = range;
  const candidates = [];
  for (const frame of frames) {
    if (frame.chunkId != null && frame.chunkId !== chunkId) continue;
    if (frame.passId != null && frame.passId !== passId) continue;
    for (const lane of frame.lanes || []) {
      if (lane.laneTrackId !== trackId) continue;
      const mapped = extractMappedPolylinePoints(frame, lane, trajectory, startS, endS);
      if (!mapped.length) continue;
      const inOpen = mapped.filter((p) => p.s >= startS && p.s <= endS);
      candidates.push({
        sourceFrameId: frame.frameId,
        logMonoTime: frame.logMonoTime,
        sourceLaneIndex: lane.laneIndex,
        sourcePolylineId: polylineId(frame.frameId, lane.laneIndex, trackId),
        mappedSRange: [mapped[0].s, mapped[mapped.length - 1].s],
        mappedPointCount: mapped.length,
        pointsInOpenInterval: inOpen.length,
        pointsInOpenSRange: inOpen.length >= 2
          ? [inOpen[0].s, inOpen[inOpen.length - 1].s]
          : inOpen.length === 1 ? [inOpen[0].s, inOpen[0].s] : null,
        sourceConfidence: lane.prob ?? 1,
        meanD: inOpen.reduce((s, p) => s + p.d, 0) / (inOpen.length || 1),
      });
    }
  }
  return candidates;
}

function preservationCompetingBoundaryInGap(gap, allCleaned, physicalBoundaryId, trackId) {
  const { startS, endS } = gap;
  const target = allCleaned.find((r) => r.physicalBoundaryId === physicalBoundaryId);
  const targetD = target?.meanD ?? 0;
  for (const run of allCleaned || []) {
    if (run.physicalBoundaryId === physicalBoundaryId) continue;
    if (run.laneTrackId === trackId) continue;
    const sMin = run.sMin ?? run.sdPoints?.[0]?.s;
    const sMax = run.sMax ?? run.sdPoints?.[run.sdPoints.length - 1]?.s;
    if (sMin == null || sMax == null) continue;
    if (sMax <= startS || sMin >= endS) continue;
    const runD = run.meanD ?? 0;
    if (Math.sign(runD) === Math.sign(targetD) && Math.abs(runD - targetD) < 1.2) {
      return true;
    }
  }
  return false;
}

function checkPolylineContinuity(sdPoints) {
  if (sdPoints.length < 2) return { ok: false, reason: 'tooFewPoints' };
  if (maxLateralJump(sdPoints) > MAX_LATERAL_JUMP_M) {
    return { ok: false, reason: 'lateralDiscontinuity' };
  }
  if (maxCurvatureDeltaDeg(sdPoints) > MAX_CURVATURE_DELTA_DEG) {
    return { ok: false, reason: 'curvatureDiscontinuity' };
  }
  return { ok: true };
}

function checkEndpointCompatibility(prevSd, nextSd, preservedSd) {
  if (!prevSd?.length || !nextSd?.length || !preservedSd?.length) {
    return { ok: true, skipped: true };
  }
  const prevFrag = { sdPoints: [prevSd[prevSd.length - 1], preservedSd[0]] };
  const nextFrag = { sdPoints: [preservedSd[preservedSd.length - 1], nextSd[0]] };
  const toPrev = endpointCompatibility(
    { sdPoints: prevSd.slice(-2) },
    { sdPoints: [preservedSd[0], preservedSd[Math.min(1, preservedSd.length - 1)]] },
    { maxJoinLateralDeltaM: 0.8, maxJoinHeadingDeltaDeg: MAX_HEADING_DELTA_DEG },
  );
  const toNext = endpointCompatibility(
    { sdPoints: [preservedSd[Math.max(0, preservedSd.length - 2)], preservedSd[preservedSd.length - 1]] },
    { sdPoints: nextSd.slice(0, 2) },
    { maxJoinLateralDeltaM: 0.8, maxJoinHeadingDeltaDeg: MAX_HEADING_DELTA_DEG },
  );
  if (!toPrev.compatible) return { ok: false, reason: 'lateralOrHeadingMismatchAtStart', detail: toPrev };
  if (!toNext.compatible) return { ok: false, reason: 'lateralOrHeadingMismatchAtEnd', detail: toNext };
  return { ok: true };
}

function dedupePointsByS(points) {
  const out = [];
  for (const p of points) {
    if (out.length && Math.abs(p.s - out[out.length - 1].s) < DEDUP_S_TOLERANCE_M) continue;
    if (out.length) {
      const prev = out[out.length - 1];
      if (Math.hypot(p.east - prev.east, p.north - prev.north) < DEDUP_XY_TOLERANCE_M) continue;
    }
    out.push(p);
  }
  return out;
}

function attachProvenance(points, meta) {
  return points.map((p) => ({
    ...p,
    provenanceType: PROVENANCE_TYPE,
    provenance: {
      provenanceType: PROVENANCE_TYPE,
      gapId: meta.gapId,
      sourceFrameId: meta.sourceFrameId,
      logMonoTime: meta.logMonoTime,
      sourceLaneIndex: meta.sourceLaneIndex,
      sourcePolylineId: meta.sourcePolylineId,
      physicalBoundaryGroup: meta.physicalBoundaryGroup,
      trackId: meta.trackId,
      chunkId: meta.chunkId,
      passId: meta.passId,
      originalPointIndex: p.originalPointIndex,
      sourceConfidence: p.sourceConfidence ?? meta.sourceConfidence,
      mappedS: p.s,
      mappedD: p.d,
      preservationReason: meta.preservationReason,
    },
  }));
}

/**
 * Evaluate and preserve D12 source polylines for class-D gaps.
 */
function preserveSourcePolylinesForGaps({
  gaps = [],
  frames = [],
  trajectory,
  physicalBoundaryGroups = [],
  cleaned = [],
  chunkId = 0,
  passId = 0,
  options = {},
}) {
  const results = [];
  const preservedIntervals = [];
  const trackToPb = new Map();
  for (const g of physicalBoundaryGroups) {
    for (const tid of g.trackIds || []) trackToPb.set(tid, g.physicalBoundaryId);
  }

  for (const gap of gaps) {
    const trackId = gap.sourceTrackId ?? gap.trackId;
    const pbId = gap.physicalBoundaryGroup ?? gap.physicalBoundaryId ?? trackToPb.get(trackId);
    const startS = gap.startS ?? gap.prevRunS;
    const endS = gap.endS ?? gap.nextRunS;
    const gapM = endS - startS;
    const gapId = gap.gapId;

    const baseResult = {
      gapId,
      physicalBoundaryGroup: pbId,
      trackId,
      chunkId,
      passId,
      startS,
      endS,
      measuredGapLengthM: gapM,
      d6RejectedBinsInGap: gap.rejectedBinsInGap ?? gap.rejectedBinsInGap ?? 0,
      eligibility: { passed: false, reason: null },
      resolution: 'unchanged',
      preservedLengthM: 0,
      remainingOpenLengthM: gapM,
      preservedPointCount: 0,
      sourceFrameId: null,
      sourcePolylineId: null,
    };

    if (gap.primaryMechanism && gap.primaryMechanism !== 'D12') {
      baseResult.eligibility.reason = `not D12 candidate (${gap.primaryMechanism})`;
      results.push(baseResult);
      continue;
    }

    if (preservationCompetingBoundaryInGap({ startS, endS }, cleaned, pbId, trackId)) {
      baseResult.eligibility.reason = 'competingBoundaryInGap';
      results.push(baseResult);
      continue;
    }

    const candidate = findBestSpanningPolyline(frames, trajectory, { startS, endS }, trackId, chunkId, passId);
    if (!candidate) {
      baseResult.eligibility.reason = 'noMappedSourcePolyline';
      results.push(baseResult);
      continue;
    }

    const continuity = checkPolylineContinuity(candidate.mappedPoints);
    if (!continuity.ok) {
      baseResult.eligibility.reason = continuity.reason;
      baseResult.candidate = { sourceFrameId: candidate.frameId, sourcePolylineId: candidate.sourcePolylineId };
      results.push(baseResult);
      continue;
    }

    const prevRun = cleaned.find((r) => r.physicalBoundaryId === pbId
      && Math.abs((r.sMax ?? 0) - startS) < 2.5);
    const nextRun = cleaned.find((r) => r.physicalBoundaryId === pbId
      && Math.abs((r.sMin ?? 0) - endS) < 2.5);
    const endpointCheck = checkEndpointCompatibility(
      prevRun?.sdPoints,
      nextRun?.sdPoints,
      candidate.mappedPoints,
    );
    if (!endpointCheck.ok) {
      baseResult.eligibility.reason = endpointCheck.reason;
      baseResult.candidate = { sourceFrameId: candidate.frameId, sourcePolylineId: candidate.sourcePolylineId };
      results.push(baseResult);
      continue;
    }

    const clipped = candidate.mappedPoints.filter((p) => p.s >= startS - 0.01 && p.s <= endS + 0.01);
    const preservedSd = dedupePointsByS(clipped);
    if (preservedSd.length < 2) {
      baseResult.eligibility.reason = 'insufficientPreservedPoints';
      results.push(baseResult);
      continue;
    }

    const preservedStart = preservedSd[0].s;
    const preservedEnd = preservedSd[preservedSd.length - 1].s;
    const preservedLengthM = preservedEnd - preservedStart;
    const openBefore = Math.max(0, preservedStart - startS);
    const openAfter = Math.max(0, endS - preservedEnd);
    const remainingOpenLengthM = openBefore + openAfter;
    const fullCoverage = candidate.coversStart && candidate.coversEnd
      && remainingOpenLengthM < 0.5;

    const meta = {
      gapId,
      sourceFrameId: candidate.frameId,
      logMonoTime: candidate.logMonoTime,
      sourceLaneIndex: candidate.laneIndex,
      sourcePolylineId: candidate.sourcePolylineId,
      physicalBoundaryGroup: pbId,
      trackId,
      chunkId,
      passId,
      sourceConfidence: candidate.sourceConfidence,
      preservationReason: fullCoverage ? 'D12_fullSpan' : 'D12_partialSpan',
    };

    const preservedPoints = attachProvenance(preservedSd, meta);
    const interval = {
      ...meta,
      provenanceType: PROVENANCE_TYPE,
      startS: preservedStart,
      endS: preservedEnd,
      gapStartS: startS,
      gapEndS: endS,
      measuredGapLengthM: gapM,
      preservedLengthM,
      remainingOpenLengthM,
      openBeforeM: openBefore,
      openAfterM: openAfter,
      preservedPointCount: preservedPoints.length,
      originalPointCount: candidate.originalPointCount,
      mappedPointCount: candidate.mappedPoints.length,
      sourcePolylineSRange: [candidate.spanStart, candidate.spanEnd],
      fullCoverage,
      resolution: fullCoverage ? 'fullyResolved' : (preservedLengthM > 0 ? 'partiallyResolved' : 'unchanged'),
      points: preservedPoints,
      sdPoints: preservedPoints.map((p) => ({ s: p.s, d: p.d })),
      d6RejectedBinsInGap: gap.rejectedBinsInGap ?? 0,
      compoundD12D6: (gap.rejectedBinsInGap ?? 0) > 0,
    };

    preservedIntervals.push(interval);
    results.push({
      ...baseResult,
      eligibility: { passed: true, reason: null },
      resolution: interval.resolution,
      preservedLengthM,
      remainingOpenLengthM,
      preservedPointCount: preservedPoints.length,
      sourceFrameId: candidate.frameId,
      logMonoTime: candidate.logMonoTime,
      sourceLaneIndex: candidate.laneIndex,
      sourcePolylineId: candidate.sourcePolylineId,
      sourcePolylineSRange: [candidate.spanStart, candidate.spanEnd],
      mappedPolylineSRange: [preservedStart, preservedEnd],
      originalPointCount: candidate.originalPointCount,
      mappedPointCount: candidate.mappedPoints.length,
      pointsInsideGap: preservedPoints.length,
      sourceConfidence: candidate.sourceConfidence,
      fullCoverage,
      compoundD12D6: interval.compoundD12D6,
      endpointLateralDelta: endpointCheck.detail?.dDelta ?? null,
      endpointHeadingDelta: endpointCheck.detail?.headingDelta ?? null,
    });
  }

  return { preservedIntervals, results };
}

/**
 * Audit open D12 partial tails and list every candidate source polyline.
 */
function auditPartialTails({
  preservedIntervals = [],
  frames = [],
  trajectory,
  cleaned = [],
  chunkId = 0,
  passId = 0,
}) {
  const audits = [];
  const partialGaps = ['CD-10', 'CD-12', 'CD-18'];

  for (const gapId of partialGaps) {
    const primary = preservedIntervals.find((p) => p.gapId === gapId && !p.isTailExtension);
    if (!primary) {
      audits.push({ gapId, error: 'noPrimaryPreservation' });
      continue;
    }

    const openStartS = primary.endS;
    const openEndS = primary.gapEndS;
    const openLengthM = openEndS - openStartS;
    const trackId = primary.trackId;
    const pbId = primary.physicalBoundaryGroup;

    const prevRun = cleaned.find((r) => r.physicalBoundaryId === pbId
      && Math.abs((r.sMax ?? 0) - primary.gapStartS) < 2.5);
    const nextRun = cleaned.find((r) => r.physicalBoundaryId === pbId
      && Math.abs((r.sMin ?? 0) - primary.gapEndS) < 2.5);

    const candidates = listCandidatePolylinesInRange(
      frames, trajectory, { startS: openStartS, endS: openEndS }, trackId, chunkId, passId,
    );

    const candidateAudits = candidates.map((c) => {
      const interiorCount = c.pointsInOpenInterval;
      const entersInterior = c.pointsInOpenSRange
        && c.pointsInOpenSRange[0] > openStartS + DEDUP_S_TOLERANCE_M
        && interiorCount >= 2
        && (c.pointsInOpenSRange[1] - c.pointsInOpenSRange[0]) > DEDUP_S_TOLERANCE_M;
      const distToTail = c.mappedSRange[0] > openStartS
        ? c.mappedSRange[0] - openStartS
        : 0;
      let rejectionReason = null;
      if (c.sourcePolylineId === primary.sourcePolylineId) {
        rejectionReason = 'alreadyUsedPrimaryPreservation';
      } else if (interiorCount < 2) {
        rejectionReason = 'insufficientPointsInOpenInterval';
      } else if (!entersInterior) {
        rejectionReason = c.pointsInOpenSRange?.[0] <= openStartS + DEDUP_S_TOLERANCE_M
          ? 'doesNotEnterOpenTailInterior'
          : 'collapsedSpanInOpenInterval';
      }
      return {
        ...c,
        entersOpenTailInterior: entersInterior,
        distanceFromMappedEndpointToOpenStartM: distToTail,
        rejectionReason,
      };
    });

    const tailExtension = preservedIntervals.find((p) => p.parentGapId === gapId && p.isTailExtension);

    audits.push({
      gapId,
      physicalBoundaryGroup: pbId,
      trackId,
      chunkId,
      passId,
      openInterval: { startS: openStartS, endS: openEndS, lengthM: openLengthM },
      primaryPreservation: {
        sourceFrameId: primary.sourceFrameId,
        sourcePolylineId: primary.sourcePolylineId,
        preservedEndS: primary.endS,
        finalMappedPoint: primary.points[primary.points.length - 1],
      },
      surroundingFusedFragments: {
        prevRunId: prevRun?.runId ?? null,
        prevRunSMax: prevRun?.sMax ?? null,
        nextRunId: nextRun?.runId ?? null,
        nextRunSMin: nextRun?.sMin ?? null,
        nextAcceptedFusedPoint: nextRun?.sdPoints?.[0] ?? null,
      },
      inspectedSourceFrames: [...new Set(frames
        .filter((f) => {
          if (f.chunkId != null && f.chunkId !== chunkId) return false;
          if (f.passId != null && f.passId !== passId) return false;
          return (f.lanes || []).some((l) => l.laneTrackId === trackId);
        })
        .map((f) => f.frameId))].sort((a, b) => a - b),
      candidateSourcePolylines: candidateAudits,
      tailExtension: tailExtension ? {
        gapId: tailExtension.gapId,
        sourceFrameId: tailExtension.sourceFrameId,
        preservedLengthM: tailExtension.preservedLengthM,
        remainingOpenAfterExtensionM: tailExtension.remainingOpenLengthM,
      } : null,
    });
  }

  return audits;
}

/**
 * Extend partially resolved D12 gaps using additional original mapped points in open tails only.
 */
function extendPartialTailPreservation({
  preservedIntervals = [],
  frames = [],
  trajectory,
  cleaned = [],
  chunkId = 0,
  passId = 0,
}) {
  const extensions = [];
  const results = [];

  for (const primary of preservedIntervals) {
    if (primary.isTailExtension) continue;
    const openAfterM = primary.openAfterM ?? 0;
    if (primary.fullCoverage || openAfterM < 0.05) continue;

    const tailStart = primary.endS;
    const tailEnd = primary.gapEndS;
    const tailGapM = tailEnd - tailStart;
    const trackId = primary.trackId;
    const pbId = primary.physicalBoundaryGroup;
    const parentGapId = primary.gapId;

    const baseResult = {
      gapId: `${parentGapId}-TAIL`,
      parentGapId,
      physicalBoundaryGroup: pbId,
      trackId,
      chunkId,
      passId,
      startS: tailStart,
      endS: tailEnd,
      measuredGapLengthM: tailGapM,
      eligibility: { passed: false, reason: null },
      classification: 'T7',
      resolution: 'unchanged',
      preservedLengthM: 0,
      remainingOpenLengthM: tailGapM,
      preservedPointCount: 0,
      isTailExtension: true,
    };

    if (preservationCompetingBoundaryInGap({ startS: tailStart, endS: tailEnd }, cleaned, pbId, trackId)) {
      baseResult.eligibility.reason = 'competingBoundaryInGap';
      baseResult.classification = 'T6';
      results.push(baseResult);
      continue;
    }

    const candidate = findBestSpanningPolyline(
      frames, trajectory, { startS: tailStart, endS: tailEnd },
      trackId, chunkId, passId,
      { excludePolylineId: primary.sourcePolylineId, minInteriorS: tailStart },
    );

    if (!candidate) {
      baseResult.eligibility.reason = 'noMappedSourcePolylineInOpenTail';
      baseResult.classification = 'T7';
      results.push(baseResult);
      continue;
    }

    const openPoints = candidate.mappedPoints.filter(
      (p) => p.s > tailStart + DEDUP_S_TOLERANCE_M && p.s <= tailEnd + 0.01,
    );
    const preservedSd = dedupePointsByS(openPoints);

    if (preservedSd.length < 2) {
      const nearOnly = candidate.mappedPoints.filter((p) => p.s >= tailStart && p.s <= tailEnd);
      baseResult.eligibility.reason = preservedSd.length === 0 && nearOnly.length > 0
        ? 'candidateApproachesButDoesNotEnterOpenTailInterior'
        : 'insufficientPreservedPointsInOpenTail';
      baseResult.classification = nearOnly.length > 0 ? 'T3' : 'T7';
      baseResult.candidate = {
        sourceFrameId: candidate.frameId,
        sourcePolylineId: candidate.sourcePolylineId,
        mappedPointCount: nearOnly.length,
      };
      results.push(baseResult);
      continue;
    }

    const continuity = checkPolylineContinuity(preservedSd);
    if (!continuity.ok) {
      baseResult.eligibility.reason = continuity.reason;
      baseResult.classification = 'T5';
      baseResult.candidate = { sourceFrameId: candidate.frameId, sourcePolylineId: candidate.sourcePolylineId };
      results.push(baseResult);
      continue;
    }

    const nextRun = cleaned.find((r) => r.physicalBoundaryId === pbId
      && Math.abs((r.sMin ?? 0) - tailEnd) < 2.5);
    let endpointOk = true;
    let endpointReason = null;
    if (nextRun?.sdPoints?.length >= 2) {
      const toNext = endpointCompatibility(
        { sdPoints: [preservedSd[Math.max(0, preservedSd.length - 2)], preservedSd[preservedSd.length - 1]] },
        { sdPoints: nextRun.sdPoints.slice(0, 2) },
        { maxJoinLateralDeltaM: 0.8, maxJoinHeadingDeltaDeg: MAX_HEADING_DELTA_DEG },
      );
      if (!toNext.compatible) {
        endpointOk = false;
        endpointReason = 'lateralOrHeadingMismatchAtEnd';
      }
    }
    if (!endpointOk) {
      baseResult.eligibility.reason = endpointReason;
      baseResult.classification = 'T5';
      results.push(baseResult);
      continue;
    }

    const preservedStart = preservedSd[0].s;
    const preservedEnd = preservedSd[preservedSd.length - 1].s;
    const preservedLengthM = preservedEnd - preservedStart;
    const gapBeforeExtension = preservedStart - tailStart;
    const gapAfterExtension = tailEnd - preservedEnd;
    const remainingOpenLengthM = gapBeforeExtension + gapAfterExtension;

    const meta = {
      gapId: `${parentGapId}-TAIL`,
      parentGapId,
      sourceFrameId: candidate.frameId,
      logMonoTime: candidate.logMonoTime,
      sourceLaneIndex: candidate.laneIndex,
      sourcePolylineId: candidate.sourcePolylineId,
      physicalBoundaryGroup: pbId,
      trackId,
      chunkId,
      passId,
      sourceConfidence: candidate.sourceConfidence,
      preservationReason: remainingOpenLengthM < 0.5 ? 'D12_tailFullSpan' : 'D12_tailPartialSpan',
    };

    const preservedPoints = attachProvenance(preservedSd, meta);
    const interval = {
      ...meta,
      provenanceType: PROVENANCE_TYPE,
      isTailExtension: true,
      startS: preservedStart,
      endS: preservedEnd,
      gapStartS: primary.gapStartS,
      gapEndS: primary.gapEndS,
      tailOpenStartS: tailStart,
      tailOpenEndS: tailEnd,
      measuredGapLengthM: tailGapM,
      preservedLengthM,
      remainingOpenLengthM,
      openBeforeM: gapBeforeExtension,
      openAfterM: gapAfterExtension,
      preservedPointCount: preservedPoints.length,
      originalPointCount: candidate.originalPointCount,
      mappedPointCount: candidate.mappedPoints.length,
      sourcePolylineSRange: [candidate.spanStart, candidate.spanEnd],
      fullCoverage: remainingOpenLengthM < 0.5,
      resolution: remainingOpenLengthM < 0.5 ? 'fullyResolved' : 'partiallyResolved',
      points: preservedPoints,
      sdPoints: preservedPoints.map((p) => ({ s: p.s, d: p.d })),
      compoundD12D6: primary.compoundD12D6,
    };

    extensions.push(interval);
    const classification = remainingOpenLengthM < 0.5 ? 'T1' : 'T2';
    results.push({
      ...baseResult,
      eligibility: { passed: true, reason: null },
      classification,
      resolution: interval.resolution,
      preservedLengthM,
      remainingOpenLengthM,
      preservedPointCount: preservedPoints.length,
      sourceFrameId: candidate.frameId,
      sourcePolylineId: candidate.sourcePolylineId,
      gapBeforeExtensionM: gapBeforeExtension,
      gapAfterExtensionM: gapAfterExtension,
    });
  }

  return { extensions, results, tailAudit: results };
}

function mergePointsWithPreserved(fusedPoints, fusedSd, preservedPoints) {
  const combined = [];
  for (let i = 0; i < fusedPoints.length; i++) {
    combined.push({
      east: fusedPoints[i].east,
      north: fusedPoints[i].north,
      s: fusedSd[i]?.s,
      d: fusedSd[i]?.d,
      provenanceType: 'fusedAccepted',
    });
  }
  for (const p of preservedPoints) {
    combined.push({
      east: p.east,
      north: p.north,
      s: p.s,
      d: p.d,
      provenanceType: PROVENANCE_TYPE,
      provenance: p.provenance,
    });
  }
  combined.sort((a, b) => (a.s ?? 0) - (b.s ?? 0));
  return dedupePointsByS(combined);
}

/**
 * Apply preserved intervals to cleaned runs — merge display geometry only.
 */
function applyPreservedGeometryToCleaned(cleaned, preservedIntervals) {
  const byPbGap = new Map();
  for (const interval of preservedIntervals) {
    byPbGap.set(interval.gapId, interval);
  }

  const augmented = cleaned.map((run) => ({
    ...run,
    displayPoints: [...(run.points || [])],
    displaySdPoints: [...(run.sdPoints || [])],
    preservedSegments: [],
    pointProvenance: (run.points || []).map(() => 'fusedAccepted'),
  }));

  const runByKey = new Map();
  for (const run of augmented) {
    runByKey.set(`${run.physicalBoundaryId}:${run.sMin?.toFixed(1)}`, run);
  }

  for (const interval of preservedIntervals) {
    const pbId = interval.physicalBoundaryGroup;
    const gapStartS = interval.gapStartS;
    const gapEndS = interval.gapEndS;
    const prevRun = augmented.find((r) => r.physicalBoundaryId === pbId
      && Math.abs((r.sMax ?? 0) - gapStartS) < 2.5);
    const nextRun = augmented.find((r) => r.physicalBoundaryId === pbId
      && Math.abs((r.sMin ?? 0) - gapEndS) < 2.5);

    if (interval.fullCoverage && !interval.isTailExtension && prevRun && nextRun && prevRun !== nextRun) {
      const merged = mergePointsWithPreserved(
        [...prevRun.displayPoints, ...nextRun.displayPoints],
        [...prevRun.displaySdPoints, ...nextRun.displaySdPoints],
        interval.points,
      );
      prevRun.displayPoints = merged.map((p) => ({ east: p.east, north: p.north }));
      prevRun.displaySdPoints = merged.map((p) => ({ s: p.s, d: p.d }));
      prevRun.pointProvenance = merged.map((p) => p.provenanceType);
      prevRun.preservedSegments.push(interval);
      prevRun.mergedWithRunId = nextRun.runId;
      prevRun.sMax = Math.max(prevRun.sMax ?? 0, nextRun.sMax ?? 0, interval.endS);
      prevRun.sourceFragments = [
        ...(prevRun.sourceFragments || []),
        ...(nextRun.sourceFragments || []),
      ];
      nextRun._superseded = true;
      prevRun._absorbedNext = nextRun;
    } else if (prevRun) {
      const clipMin = interval.isTailExtension
        ? (interval.tailOpenStartS ?? interval.startS)
        : gapStartS;
      const merged = mergePointsWithPreserved(
        prevRun.displayPoints,
        prevRun.displaySdPoints,
        interval.points.filter((p) => p.s >= clipMin - 0.01),
      );
      prevRun.displayPoints = merged.map((p) => ({ east: p.east, north: p.north }));
      prevRun.displaySdPoints = merged.map((p) => ({ s: p.s, d: p.d }));
      prevRun.pointProvenance = merged.map((p) => p.provenanceType);
      prevRun.preservedSegments.push(interval);
      prevRun.sMax = Math.max(prevRun.sMax ?? 0, interval.endS);
    } else if (nextRun) {
      const merged = mergePointsWithPreserved(
        nextRun.displayPoints,
        nextRun.displaySdPoints,
        interval.points.filter((p) => p.s <= interval.gapEndS),
      );
      nextRun.displayPoints = merged.map((p) => ({ east: p.east, north: p.north }));
      nextRun.displaySdPoints = merged.map((p) => ({ s: p.s, d: p.d }));
      nextRun.pointProvenance = merged.map((p) => p.provenanceType);
      nextRun.preservedSegments.push(interval);
      nextRun.sMin = Math.min(nextRun.sMin ?? Infinity, interval.startS);
    }
  }

  const displayCleaned = augmented.filter((r) => !r._superseded).map((run) => ({
    ...run,
    points: run.displayPoints,
    sdPoints: run.displaySdPoints,
    lengthM: run.displaySdPoints.length >= 2
      ? Math.abs(run.displaySdPoints[run.displaySdPoints.length - 1].s - run.displaySdPoints[0].s)
      : run.lengthM,
  }));

  return { displayCleaned, augmented };
}



/**
 * Along-track (s/d) fusion — project observations, bin by s, robust lateral estimate.
 * Does NOT concatenate per-frame polylines.
 */


const DEFAULT_TRACKER_CONTINUITY_BRIDGE = {
  dropoutScaleGapM: 30,
  maxTrackerContinuityBridgeGapM: 28,
  maxPositiveBoundaryBridgeGapM: 18,
  minPositiveBoundaryBridgeGapM: 12,
  minPositiveBoundaryObsInGap: 6,
  positiveBoundaryClusterGapM: 2.0,
  maxJoinLateralDeltaM: 0.8,
  maxJoinHeadingDeltaDeg: 25,
};

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

function mad(values) {
  if (!values.length) return 0;
  const med = median(values);
  return median(values.map((v) => Math.abs(v - med)));
}

function clusterObservationsByLateral(obs, gapM = 2.5) {
  if (!obs?.length) return [];
  const sorted = [...obs].sort((a, b) => a.d - b.d);
  const clusters = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (Math.abs(cur.d - prev.d) > gapM) clusters.push([cur]);
    else clusters[clusters.length - 1].push(cur);
  }
  return clusters;
}

function interpolateExpectedD(prevPt, nextPt, sCentre) {
  if (prevPt && nextPt && nextPt.s !== prevPt.s) {
    const t = (sCentre - prevPt.s) / (nextPt.s - prevPt.s);
    return prevPt.d + t * (nextPt.d - prevPt.d);
  }
  if (prevPt) return prevPt.d;
  if (nextPt) return nextPt.d;
  return null;
}

/**
 * When a fusion bin contains bimodal lateral observations, select the cluster
 * whose mean lateral position best matches neighbour-bin trajectory context.
 */
function selectBimodalCluster(obs, prevPt, nextPt, options = {}) {
  const gapM = options.maxLateralJumpM ?? 2.5;
  const maxSelectDistM = options.maxBimodalClusterSelectM ?? 4;
  const clusters = clusterObservationsByLateral(obs, gapM);
  if (clusters.length < 2) return { obs, selected: false, reason: 'unimodal' };
  const sCentre = median(obs.map((o) => o.s));
  const expectedD = interpolateExpectedD(prevPt, nextPt, sCentre);
  if (expectedD == null) return { obs, selected: false, reason: 'noNeighbourContext' };
  const unimodalMed = weightedMedian(obs.map((o) => o.d), obs.map((o) => o.prob ?? 1));
  const spread = mad(obs.map((o) => o.d));
  const contaminationEvidence = clusters.length >= 2
    || Math.abs(unimodalMed - expectedD) > gapM * 0.5
    || spread > 2.0;
  if (!contaminationEvidence) return { obs, selected: false, reason: 'noContaminationEvidence' };
  const ranked = clusters.map((cluster) => {
    const meanD = median(cluster.map((o) => o.d));
    return { cluster, meanD, dist: Math.abs(meanD - expectedD) };
  }).sort((a, b) => a.dist - b.dist);
  const best = ranked[0];
  if (!best || best.dist > maxSelectDistM) {
    return { obs, selected: false, reason: 'noClusterMatchesNeighbours', expectedD, ranked };
  }
  if (best.cluster.length < (options.minObsPerBin ?? 2) && best.cluster.length < 1) {
    return { obs, selected: false, reason: 'bestClusterTooSmall' };
  }
  return {
    obs: best.cluster,
    selected: true,
    reason: 'bimodalNeighbourCluster',
    expectedD,
    selectedMeanD: best.meanD,
    rejectedMeanD: ranked[1]?.meanD ?? null,
    clusterCount: clusters.length,
  };
}

function aggregateFusedBin(obs, prevPt, nextPt, options = {}) {
  const minObsPerBin = options.minObsPerBin ?? 2;
  const minFramesPerBin = options.minFramesPerBin ?? 2;
  const madMultiplier = options.madMultiplier ?? 3.0;
  const interval = options.fusionIntervalM ?? 2.0;
  const key = Math.round(median(obs.map((o) => o.s)) / interval);

  const initialFrameIds = new Set(obs.map((o) => o.frameId));
  if (obs.length < minObsPerBin || initialFrameIds.size < minFramesPerBin) return null;

  const clusterPick = options.bimodalClusterSelection !== false
    ? selectBimodalCluster(obs, prevPt, nextPt, options)
    : { obs, selected: false };
  const workingObs = clusterPick.obs;

  const ds = workingObs.map((o) => o.d);
  const med = median(ds);
  const spread = mad(ds);
  const inliers = workingObs.filter((o) => Math.abs(o.d - med) <= madMultiplier * Math.max(spread, 0.3));
  const inlierSpread = mad(inliers.map((o) => o.d));
  const minObs = clusterPick.selected ? 1 : minObsPerBin;
  const madOutlierRemoved = clusterPick.selected || inliers.length < obs.length;
  const minFrames = (clusterPick.selected || madOutlierRemoved) && inlierSpread <= 0.5 ? 1 : minFramesPerBin;
  const frameIds = new Set(inliers.map((o) => o.frameId));
  if (inliers.length < minObs || frameIds.size < minFrames) return null;

  const dFused = weightedMedian(inliers.map((o) => o.d), inliers.map((o) => o.prob ?? 1));
  const sFused = weightedMedian(inliers.map((o) => o.s), inliers.map((o) => o.prob ?? 1));
  return {
    s: sFused,
    d: dFused,
    frameCount: new Set(inliers.map((o) => o.frameId)).size,
    binKey: key,
    bimodalClusterSelection: clusterPick.selected ? clusterPick : null,
  };
}

function weightedMedian(values, weights) {
  const pairs = values.map((v, i) => ({ v, w: weights[i] ?? 1 })).sort((a, b) => a.v - b.v);
  const total = pairs.reduce((s, p) => s + p.w, 0);
  let cum = 0;
  for (const p of pairs) {
    cum += p.w;
    if (cum >= total / 2) return p.v;
  }
  return pairs[pairs.length - 1]?.v ?? 0;
}

function filterByDominantTrack(inliers, enabled = true) {
  if (!enabled) return inliers;
  const withTrack = inliers.filter((o) => o.laneTrackId != null);
  if (!withTrack.length) return inliers;
  const counts = new Map();
  for (const o of withTrack) counts.set(o.laneTrackId, (counts.get(o.laneTrackId) || 0) + 1);
  let bestId = null;
  let bestN = 0;
  for (const [id, n] of counts) if (n > bestN) { bestN = n; bestId = id; }
  const filtered = inliers.filter((o) => o.laneTrackId == null || o.laneTrackId === bestId);
  return filtered.length >= 1 ? filtered : inliers;
}

function collectEdgeObservations(frames, trajectory, options = {}) {
  const maxPerpDist = options.maxProjectionDistM ?? 25;
  const maxForwardM = options.maxForwardM ?? 120;
  const backwardToleranceM = options.backwardToleranceM ?? 5;
  const observations = [];
  const rejected = [];

  for (const frame of frames) {
    const vehicleS = vehicleSAtTimeTemporal(trajectory, frame.logMonoTime);
    for (const edge of frame.edges || []) {
      for (const pt of edge.points || []) {
        const proj = projectPointTemporal(trajectory, pt.east, pt.north, frame.logMonoTime, options);
        if (!proj.valid) {
          rejected.push({ ...pt, reason: proj.reason || 'projectionFailed', frameId: frame.frameId, logMonoTime: frame.logMonoTime, sourceFile: frame.sourceFile });
          continue;
        }
        if (proj.ambiguous) {
          rejected.push({ ...pt, reason: 'projectionAmbiguous', frameId: frame.frameId, logMonoTime: frame.logMonoTime, sourceFile: frame.sourceFile, edgeIndex: edge.edgeIndex });
          continue;
        }
        if (proj.perpDist > maxPerpDist) {
          rejected.push({ ...pt, reason: 'tooFarFromTrajectory', perpDist: proj.perpDist, frameId: frame.frameId, logMonoTime: frame.logMonoTime, sourceFile: frame.sourceFile, edgeIndex: edge.edgeIndex });
          continue;
        }
        if (proj.s < vehicleS - backwardToleranceM || proj.s > vehicleS + maxForwardM) {
          rejected.push({ ...pt, reason: 'outsideForwardWindow', s: proj.s, vehicleS, frameId: frame.frameId, logMonoTime: frame.logMonoTime, sourceFile: frame.sourceFile, edgeIndex: edge.edgeIndex });
          continue;
        }
        const side = proj.d >= 0 ? 'left' : 'right';
        observations.push({
          east: pt.east,
          north: pt.north,
          s: proj.s,
          d: proj.d,
          side,
          edgeIndex: edge.edgeIndex,
          prob: edge.prob ?? 1,
          frameId: frame.frameId,
          logMonoTime: frame.logMonoTime,
          sourceFile: frame.sourceFile,
          vehicleS,
          perpDist: proj.perpDist,
          passId: frame.passId ?? 0,
          temporalIndex: frame.temporalIndex ?? 0,
          laneTrackId: edge.laneTrackId ?? null,
        });
      }
    }
  }
  return { observations, rejected };
}

function collectLaneObservations(frames, trajectory, options = {}) {
  const maxPerpDist = options.maxProjectionDistM ?? 25;
  const maxForwardM = options.maxForwardM ?? 120;
  const backwardToleranceM = options.backwardToleranceM ?? 5;
  const observations = [];

  for (const frame of frames) {
    const vehicleS = vehicleSAtTimeTemporal(trajectory, frame.logMonoTime);
    for (const lane of frame.lanes || []) {
      for (const pt of lane.points || []) {
        const proj = projectPointTemporal(trajectory, pt.east, pt.north, frame.logMonoTime, options);
        if (!proj.valid || proj.ambiguous || proj.perpDist > maxPerpDist) continue;
        if (proj.s < vehicleS - backwardToleranceM || proj.s > vehicleS + maxForwardM) continue;
        observations.push({
          east: pt.east,
          north: pt.north,
          s: proj.s,
          d: proj.d,
          laneIndex: lane.laneIndex,
          prob: lane.prob ?? 1,
          frameId: frame.frameId,
          logMonoTime: frame.logMonoTime,
          sourceFile: frame.sourceFile,
          passId: frame.passId ?? 0,
          laneTrackId: lane.laneTrackId ?? null,
        });
      }
    }
  }
  return observations;
}

function fuseSideBoundary(observations, side, options = {}) {
  const interval = options.fusionIntervalM ?? 2.0;
  const minObsPerBin = options.minObsPerBin ?? 2;
  const minFramesPerBin = options.minFramesPerBin ?? 2;
  const madMultiplier = options.madMultiplier ?? 3.0;
  const maxLateralJump = options.maxLateralJumpM ?? 2.5;
  const maxSGap = options.maxLaneFragmentGapM ?? 10;

  const sideObs = observations.filter((o) => o.side === side);
  const bins = new Map();

  for (const obs of sideObs) {
    const key = Math.round(obs.s / interval);
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push(obs);
  }

  const fused = [];
  const rejected = [];
  const sortedKeys = [...bins.keys()].sort((a, b) => a - b);

  for (const key of sortedKeys) {
    const obs = bins.get(key);
    if (obs.length < minObsPerBin) {
      rejected.push({ bin: key, reason: 'insufficientObservations', count: obs.length });
      continue;
    }

    const ds = obs.map((o) => o.d);
    const ws = obs.map((o) => o.prob ?? 1);
    const med = median(ds);
    const spread = mad(ds);
    const threshold = madMultiplier * Math.max(spread, 0.3);
    const inliers = obs.filter((o) => Math.abs(o.d - med) <= threshold);
    if (inliers.length < minObsPerBin) {
      rejected.push({ bin: key, reason: 'lateralOutliers', count: obs.length, inliers: inliers.length });
      continue;
    }

    const trackFiltered = filterByDominantTrack(inliers, false);
    if (trackFiltered.length < minObsPerBin) {
      rejected.push({ bin: key, reason: 'incompatibleTracks', count: inliers.length });
      continue;
    }

    const frameIds = new Set(trackFiltered.map((o) => o.frameId));
    if (frameIds.size < minFramesPerBin) {
      rejected.push({ bin: key, reason: 'insufficientFrameSupport', frames: frameIds.size });
      continue;
    }

    const dFused = weightedMedian(trackFiltered.map((o) => o.d), trackFiltered.map((o) => o.prob ?? 1));
    const sFused = weightedMedian(trackFiltered.map((o) => o.s), trackFiltered.map((o) => o.prob ?? 1));
    fused.push({
      s: sFused,
      d: dFused,
      side,
      obsCount: trackFiltered.length,
      frameCount: frameIds.size,
      dSpread: spread,
      binKey: key,
    });
  }

  fused.sort((a, b) => a.s - b.s);

  const fragments = [];
  let current = [];
  for (let i = 0; i < fused.length; i++) {
    const pt = fused[i];
    if (current.length) {
      const ds = pt.s - current[current.length - 1].s;
      const dd = Math.abs(pt.d - current[current.length - 1].d);
      if (ds > maxSGap || dd > maxLateralJump * 3) {
        if (current.length >= 2) fragments.push(current);
        current = [pt];
        continue;
      }
      if (dd > maxLateralJump) {
        rejected.push({ s: pt.s, reason: 'lateralSpike', deltaD: dd });
        continue;
      }
    }
    current.push(pt);
  }
  if (current.length >= 2) fragments.push(current);

  return { fragments, rejected, fusedPoints: fused };
}

function sdToMapPoints(trajectory, sdPoints) {
  return sdPoints.map((p) => {
    const map = sToMap(trajectory, p.s, p.d);
    return { ...p, east: map.east, north: map.north };
  });
}

function trackBoundaryStats(laneObs, options = {}) {
  const minSpanM = options.boundaryMinSpanM ?? options.outerBoundaryMinSpanM ?? 50;
  const trackIds = [...new Set(laneObs.map((o) => o.laneTrackId).filter((x) => x != null))];
  return trackIds.map((tid) => {
    const obs = laneObs.filter((o) => o.laneTrackId === tid);
    const ss = obs.map((o) => o.s);
    const span = ss.length ? Math.max(...ss) - Math.min(...ss) : 0;
    const meanD = obs.length ? obs.reduce((s, o) => s + o.d, 0) / obs.length : 0;
    return { tid, meanD, span };
  }).filter((s) => s.span >= minSpanM);
}

/**
 * Bridge a would-be D11 maxLaneFragmentGapM split when tracker observations
 * span the gap with compatible fused-bin endpoints (same track, chunk, pass).
 */
function isOuterBoundaryTrack(laneTrackId, laneObs, options = {}) {
  const stats = trackBoundaryStats(laneObs, options);
  const negatives = stats.filter((s) => s.meanD < 0);
  if (negatives.some((s) => s.tid === laneTrackId)) {
    const rightmost = negatives.reduce((best, s) => (!best || s.meanD < best.meanD ? s : best), null);
    return rightmost?.tid === laneTrackId;
  }
  return false;
}

/**
 * Positive-mean-d (left-side) proven lane-boundary track eligible for continuity bridging.
 * Mirrors outer-boundary evidence: dominant lateral position + minimum along-track span.
 */
function isPositiveBoundaryTrack(laneTrackId, laneObs, options = {}) {
  const stats = trackBoundaryStats(laneObs, options);
  const positives = stats.filter((s) => s.meanD >= 0);
  if (!positives.some((s) => s.tid === laneTrackId)) return false;
  const clusterGapM = options.positiveBoundaryClusterGapM
    ?? DEFAULT_TRACKER_CONTINUITY_BRIDGE.positiveBoundaryClusterGapM;
  const sorted = [...positives].sort((a, b) => a.meanD - b.meanD);
  const clusters = [];
  for (const s of sorted) {
    const last = clusters[clusters.length - 1];
    if (!last || s.meanD - last[last.length - 1].meanD > clusterGapM) {
      clusters.push([s]);
    } else {
      last.push(s);
    }
  }
  for (const cluster of clusters) {
    const leftmost = cluster.reduce((best, s) => (!best || s.meanD > best.meanD ? s : best), null);
    if (leftmost?.tid === laneTrackId) return true;
  }
  return false;
}

function trackerContinuityBridgeEligibility(laneTrackId, laneObs, options = {}) {
  const allLaneObs = options.allLaneObservations ?? laneObs;
  if (isOuterBoundaryTrack(laneTrackId, allLaneObs, options)) {
    return { eligible: true, boundarySide: 'outer' };
  }
  if (options.positiveBoundaryContinuityBridgeEnabled !== false
    && isPositiveBoundaryTrack(laneTrackId, allLaneObs, options)) {
    return { eligible: true, boundarySide: 'positive' };
  }
  return { eligible: false, boundarySide: null };
}

function canBridgeTrackerContinuousFusionGap(prev, pt, current, nextPt, laneObs, options = {}) {
  const bridgeOpts = { ...DEFAULT_TRACKER_CONTINUITY_BRIDGE, ...options };
  const maxSGap = options.maxLaneFragmentGapM ?? 10;
  const maxLateralJump = options.maxLateralJumpM ?? 2.5;
  const minObsPerBin = options.minObsPerBin ?? 2;
  const minFramesPerBin = options.minFramesPerBin ?? 2;
  const laneTrackId = options.laneTrackId ?? laneObs[0]?.laneTrackId;
  if (laneTrackId == null) return { bridge: false, reason: 'missingTrackId' };
  if (options.trackerContinuityBridgeEnabled === false) return { bridge: false, reason: 'bridgeDisabled' };
  const allLaneObs = options.allLaneObservations ?? laneObs;
  const eligibility = trackerContinuityBridgeEligibility(laneTrackId, allLaneObs, options);
  if (!eligibility.eligible) return { bridge: false, reason: 'notProvenBoundaryTrack' };
  const maxBridgeGapM = eligibility.boundarySide === 'positive'
    ? (bridgeOpts.maxPositiveBoundaryBridgeGapM ?? 18)
    : bridgeOpts.maxTrackerContinuityBridgeGapM;
  const minBridgeGapM = eligibility.boundarySide === 'positive'
    ? (bridgeOpts.minPositiveBoundaryBridgeGapM ?? 12)
    : maxSGap;
  const ds = pt.s - prev.s;
  const dd = Math.abs(pt.d - prev.d);

  if (ds <= maxSGap) return { bridge: false, reason: 'withinMaxGap' };
  if (eligibility.boundarySide === 'positive' && ds < minBridgeGapM) {
    return { bridge: false, reason: 'belowMinPositiveBoundaryBridgeGap' };
  }
  if (ds >= bridgeOpts.dropoutScaleGapM) return { bridge: false, reason: 'dropoutScaleGap' };
  if (ds > maxBridgeGapM) return { bridge: false, reason: 'exceedsMaxBridgeGap' };
  if (dd > maxLateralJump * 3) return { bridge: false, reason: 'lateralJumpSplit' };

  const obsInGap = eligibility.boundarySide === 'positive'
    ? laneObs.filter((o) => o.s >= prev.s && o.s <= pt.s)
    : laneObs.filter((o) => o.s > prev.s && o.s < pt.s);
  if (obsInGap.length < minObsPerBin) return { bridge: false, reason: 'insufficientObsInGap' };
  const frameIds = new Set(obsInGap.map((o) => o.frameId));
  if (frameIds.size < minFramesPerBin) return { bridge: false, reason: 'insufficientFramesInGap' };
  if (eligibility.boundarySide === 'positive') {
    const minPosObs = bridgeOpts.minPositiveBoundaryObsInGap ?? 6;
    if (obsInGap.length < minPosObs) {
      return { bridge: false, reason: 'insufficientPositiveBoundaryObs' };
    }
  }

  const followingPts = nextPt ? [pt, nextPt] : [pt];
  const unimodalD = pt.preliminaryD ?? pt.d;
  const spikeBlockedJoin = Math.abs(unimodalD - prev.d) > maxLateralJump * 2;
  const rejectionDelta = pt.bimodalClusterSelection?.selected
    ? Math.abs((pt.bimodalClusterSelection.rejectedMeanD ?? unimodalD) - (pt.bimodalClusterSelection.selectedMeanD ?? pt.d))
    : 0;
  const bimodalJoinEvidence = eligibility.boundarySide === 'outer'
    && !!(pt.bimodalClusterSelection?.selected
      && spikeBlockedJoin
      && rejectionDelta >= (bridgeOpts.minBimodalBridgeRejectionDeltaM ?? 4));
  const joinLateralMax = bimodalJoinEvidence ? maxLateralJump : bridgeOpts.maxJoinLateralDeltaM;
  const compat = endpointCompatibility(
    { sdPoints: current },
    { sdPoints: followingPts },
    {
      maxJoinLateralDeltaM: joinLateralMax,
      maxJoinHeadingDeltaDeg: bridgeOpts.maxJoinHeadingDeltaDeg,
    },
  );
  if (!compat.compatible) {
    return { bridge: false, reason: compat.reason || 'endpointIncompatible', compat };
  }

  return {
    bridge: true,
    reason: 'trackerContinuousFusionBridge',
    boundarySide: eligibility.boundarySide,
    gapM: ds,
    obsInGap: obsInGap.length,
    frameCount: frameIds.size,
  };
}

function fuseLaneTrackSdFragments(observations, laneTrackId, options = {}) {
  const interval = options.fusionIntervalM ?? 2.0;
  const minObsPerBin = options.minObsPerBin ?? 2;
  const minFramesPerBin = options.minFramesPerBin ?? 2;
  const maxSGap = options.maxLaneFragmentGapM ?? 10;
  const maxLateralJump = options.maxLateralJumpM ?? 2.5;
  const madMultiplier = options.madMultiplier ?? 3.0;
  const laneObs = observations.filter((o) => o.laneTrackId === laneTrackId);
  const allowBimodal = options.bimodalClusterSelection !== false
    && isOuterBoundaryTrack(laneTrackId, laneObs, options);
  const bins = new Map();

  for (const obs of laneObs) {
    const key = Math.round(obs.s / interval);
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push(obs);
  }

  const fused = [];
  const binKeys = [...bins.keys()].sort((a, b) => a - b);
  const preliminary = [];
  for (const key of binKeys) {
    const obs = bins.get(key);
    const pt = aggregateFusedBin(obs, null, null, { ...options, bimodalClusterSelection: false });
    if (pt) preliminary.push(pt);
  }
  preliminary.sort((a, b) => a.s - b.s);

  for (const key of binKeys) {
    const obs = bins.get(key);
    const prevPt = [...fused].reverse().find((p) => p.binKey < key)
      ?? [...preliminary].reverse().find((p) => p.binKey < key)
      ?? null;
    const nextPt = preliminary.find((p) => p.binKey > key) ?? null;
    const prelimPt = preliminary.find((p) => p.binKey === key) ?? null;
    const pt = aggregateFusedBin(obs, prevPt, nextPt, { ...options, bimodalClusterSelection: allowBimodal });
    if (pt) {
      if (prelimPt) pt.preliminaryD = prelimPt.d;
      fused.push(pt);
    }
  }
  fused.sort((a, b) => a.s - b.s);

  const fragments = [];
  let current = [];
  for (let i = 0; i < fused.length; i++) {
    const pt = fused[i];
    const nextPt = fused[i + 1] ?? null;
    if (current.length) {
      const prev = current[current.length - 1];
      const ds = pt.s - prev.s;
      const dd = Math.abs(pt.d - prev.d);
      if (ds > maxSGap || dd > maxLateralJump * 3) {
        const bridge = ds > maxSGap && dd <= maxLateralJump * 3
          ? canBridgeTrackerContinuousFusionGap(prev, pt, current, nextPt, laneObs, {
            ...options,
            laneTrackId,
            allLaneObservations: observations,
            trackerContinuityBridgeEnabled: options.trackerContinuityBridgeEnabled !== false,
          })
          : { bridge: false };
        if (bridge.bridge) {
          if (dd > maxLateralJump) continue;
          current.push(pt);
          continue;
        }
        if (current.length >= 2) fragments.push(current);
        current = [pt];
        continue;
      }
      if (dd > maxLateralJump) continue;
    }
    current.push(pt);
  }
  if (current.length >= 2) fragments.push(current);
  return fragments;
}

function fuseLaneByTrack(observations, laneTrackId, options = {}) {
  const fragments = fuseLaneTrackSdFragments(observations, laneTrackId, options);
  return fragments.map((frag, fragmentIndex) => ({
    laneTrackId,
    fragmentIndex,
    sdPoints: frag,
    points: sdToMapPoints(options.trajectory, frag),
    supportingFrameCount: Math.max(...frag.map((p) => p.frameCount ?? 1)),
  }));
}

function trackSdSpan(fragments) {
  const pts = fragments.flat();
  if (!pts.length) return 0;
  return Math.max(...pts.map((p) => p.s)) - Math.min(...pts.map((p) => p.s));
}

function trackSdRange(fragments) {
  const pts = fragments.flat();
  if (!pts.length) return [0, 0];
  return [Math.min(...pts.map((p) => p.s)), Math.max(...pts.map((p) => p.s))];
}

function sRangeOverlapM(a, b) {
  const start = Math.max(a[0], b[0]);
  const end = Math.min(a[1], b[1]);
  return Math.max(0, end - start);
}

function selectOuterLaneTrackBoundaries(laneObs, options = {}) {
  const trackIds = [...new Set(laneObs.map((o) => o.laneTrackId).filter((x) => x != null))];
  if (trackIds.length < 2) return null;

  const ranked = [];
  for (const tid of trackIds) {
    const frags = fuseLaneTrackSdFragments(laneObs, tid, options);
    if (!frags.length) continue;
    const allPts = frags.flat();
    const meanD = allPts.reduce((sum, p) => sum + p.d, 0) / allPts.length;
    const span = trackSdSpan(frags);
    if (span < (options.minLaneBoundarySpanM ?? 12)) continue;
    ranked.push({ trackId: tid, fragments: frags, meanD, span, sRange: trackSdRange(frags) });
  }
  if (ranked.length < 2) return null;

  const minOverlapM = options.minLaneBoundaryOverlapM ?? 20;
  const pairs = [];
  for (let i = 0; i < ranked.length; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      const a = ranked[i];
      const b = ranked[j];
      const overlapM = sRangeOverlapM(a.sRange, b.sRange);
      if (overlapM < minOverlapM) continue;
      const separation = Math.abs(a.meanD - b.meanD);
      if (separation < (options.minRoadWidthM ?? 2)) continue;
      const left = a.meanD >= b.meanD ? a : b;
      const right = a.meanD >= b.meanD ? b : a;
      pairs.push({
        leftFragments: left.fragments,
        rightFragments: right.fragments,
        leftTrackId: left.trackId,
        rightTrackId: right.trackId,
        meanSeparationM: separation,
        overlapM,
        sRange: [
          Math.max(left.sRange[0], right.sRange[0]),
          Math.min(left.sRange[1], right.sRange[1]),
        ],
      });
    }
  }
  if (!pairs.length) return null;

  pairs.sort((a, b) => b.overlapM - a.overlapM);
  const selected = [];
  for (const pair of pairs) {
    const overlapsSelected = selected.some((s) =>
      sRangeOverlapM(pair.sRange, s.sRange) > minOverlapM * 0.5
      && (pair.leftTrackId === s.leftTrackId || pair.rightTrackId === s.rightTrackId));
    if (!overlapsSelected) selected.push(pair);
  }
  return selected.length === 1 ? selected[0] : { pairs: selected };
}

function buildPolygonsFromLaneTrackPairs(lanePairs, trajectory, options = {}) {
  const pairList = lanePairs.pairs ?? [lanePairs];
  let polygons = [];
  let rejectionLog = [];
  let nextFragmentIndex = 0;
  let totalBridgeLengthM = 0;
  for (const pair of pairList) {
    const leftPts = pair.leftFragments.flat().sort((a, b) => a.s - b.s);
    const rightPts = pair.rightFragments.flat().sort((a, b) => a.s - b.s);
    const bridgeDerivation = deriveSafeSurfaceBridgeGapM(leftPts, rightPts, options);
    const laneSpanOpts = {
      ...options,
      maxInterpolationSpanM: options.laneTrackMaxInterpolationSpanM
        ?? (options.fusionIntervalM ?? 2) * 4,
    };
    const intervalResult = resampleBoundaries(
      pair.leftFragments,
      pair.rightFragments,
      trajectory,
      laneSpanOpts,
    );
    const merged = mergeAdjacentIntervals(intervalResult.intervals, {
      ...options,
      safeBridgeGapM: bridgeDerivation.safeBridgeGapM,
      leftTrackId: pair.leftTrackId,
      rightTrackId: pair.rightTrackId,
    });
    totalBridgeLengthM += merged.bridges.reduce((s, b) => s + (b.gapLengthM ?? 0), 0);
    const surfaceType = classifySurfaceType({
      leftTrackId: pair.leftTrackId,
      rightTrackId: pair.rightTrackId,
      laneTrackCount: 2,
    });
    const built = buildPolygonsFromIntervals(merged.intervals, trajectory, {
      ...options,
      polygonSource: 'laneTracks',
      sourceLeftTrackId: pair.leftTrackId,
      sourceRightTrackId: pair.rightTrackId,
      surfaceType,
      bridgeProvenance: merged.bridges,
      safeBridgeGapM: bridgeDerivation.safeBridgeGapM,
    });
    for (const poly of built.polygons) {
      polygons.push({ ...poly, fragmentIndex: nextFragmentIndex++ });
    }
    rejectionLog = rejectionLog.concat(built.rejectionLog);
  }
  return { polygons, rejectionLog, totalBridgeLengthM };
}

function polygonCoverageLength(polygons) {
  return polygons.reduce((sum, p) => {
    const sRange = p.stats?.sRange;
    return sum + (sRange ? sRange[1] - sRange[0] : 0);
  }, 0);
}

function fuseLaneByIndex(observations, laneIndex, options = {}) {
  const interval = options.fusionIntervalM ?? 2.0;
  const minObsPerBin = options.minObsPerBin ?? 2;
  const maxSGap = options.maxLaneFragmentGapM ?? 10;
  const maxLateralJump = options.maxLateralJumpM ?? 2.5;
  const madMultiplier = options.madMultiplier ?? 3.0;
  const laneObs = observations.filter((o) => o.laneIndex === laneIndex);
  const bins = new Map();

  for (const obs of laneObs) {
    const key = Math.round(obs.s / interval);
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push(obs);
  }

  const fused = [];
  for (const key of [...bins.keys()].sort((a, b) => a - b)) {
    const obs = bins.get(key);
    if (obs.length < minObsPerBin) continue;
    const ds = obs.map((o) => o.d);
    const med = median(ds);
    const spread = mad(ds);
    const inliers = obs.filter((o) => Math.abs(o.d - med) <= madMultiplier * Math.max(spread, 0.3));
    if (inliers.length < minObsPerBin) continue;
    const trackFiltered = filterByDominantTrack(inliers, options.laneTrackingEnabled !== false);
    if (trackFiltered.length < minObsPerBin) continue;
    const dFused = weightedMedian(trackFiltered.map((o) => o.d), trackFiltered.map((o) => o.prob ?? 1));
    const sFused = weightedMedian(trackFiltered.map((o) => o.s), trackFiltered.map((o) => o.prob ?? 1));
    fused.push({ s: sFused, d: dFused });
  }
  fused.sort((a, b) => a.s - b.s);

  const fragments = [];
  let current = [];
  for (const pt of fused) {
    if (current.length) {
      const ds = pt.s - current[current.length - 1].s;
      const dd = Math.abs(pt.d - current[current.length - 1].d);
      if (ds > maxSGap || dd > maxLateralJump * 3) {
        if (current.length >= 2) fragments.push(current);
        current = [pt];
        continue;
      }
      if (dd > maxLateralJump) continue;
    }
    current.push(pt);
  }
  if (current.length >= 2) fragments.push(current);

  return fragments.map((frag, fragmentIndex) => ({
    laneIndex,
    fragmentIndex,
    points: sdToMapPoints(options.trajectory, frag),
  }));
}

function resolveMaxInterpolationSpanM(options = {}) {
  const fusionIntervalM = options.fusionIntervalM ?? 2.0;
  return options.maxInterpolationSpanM ?? fusionIntervalM * 2;
}

/**
 * Longitudinal spacing between consecutive fused source bins (grid keys when present).
 */
function sourceBinSpacing(prev, pt, fusionIntervalM = 2.0) {
  if (prev?.binKey != null && pt?.binKey != null) {
    return Math.max(0, (pt.binKey - prev.binKey) * fusionIntervalM);
  }
  return pt.s - prev.s;
}

/**
 * Split fused boundary points into runs where consecutive source-bin spacing
 * does not exceed maxInterpolationSpanM.
 */
function splitSupportedRuns(pts, maxInterpolationSpanM, fusionIntervalM = 2.0) {
  if (!pts?.length) return [];
  const sorted = [...pts].sort((a, b) => a.s - b.s);
  const runs = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const ds = sourceBinSpacing(sorted[i - 1], sorted[i], fusionIntervalM);
    if (ds > maxInterpolationSpanM) {
      if (current.length >= 2) runs.push(current);
      current = [sorted[i]];
    } else {
      current.push(sorted[i]);
    }
  }
  if (current.length >= 2) runs.push(current);
  return runs;
}

/**
 * Pair left/right supported runs only where longitudinal support overlaps.
 */
function pairSupportedRuns(leftRuns, rightRuns, minOverlapM = 0) {
  const pairs = [];
  for (let li = 0; li < leftRuns.length; li++) {
    const lRun = leftRuns[li];
    const l0 = lRun[0].s;
    const l1 = lRun[lRun.length - 1].s;
    for (let ri = 0; ri < rightRuns.length; ri++) {
      const rRun = rightRuns[ri];
      const r0 = rRun[0].s;
      const r1 = rRun[rRun.length - 1].s;
      const overlapStart = Math.max(l0, r0);
      const overlapEnd = Math.min(l1, r1);
      const overlapM = overlapEnd - overlapStart;
      if (overlapM >= minOverlapM) {
        pairs.push({
          leftRunIndex: li,
          rightRunIndex: ri,
          leftRun: lRun,
          rightRun: rRun,
          overlapStart,
          overlapEnd,
          overlapM,
        });
      }
    }
  }
  return pairs;
}

function interpolateDWithinRun(pts, s, maxInterpolationSpanM, fusionIntervalM = 2.0) {
  if (!pts?.length) return null;
  const sorted = [...pts].sort((a, b) => a.s - b.s);

  for (const pt of sorted) {
    if (Math.abs(pt.s - s) < 1e-6) return { d: pt.d, spanM: 0 };
  }

  for (let i = 1; i < sorted.length; i++) {
    if (s > sorted[i].s + 1e-6) continue;
    if (s < sorted[i - 1].s - 1e-6) return null;

    const span = sourceBinSpacing(sorted[i - 1], sorted[i], fusionIntervalM);
    if (span > maxInterpolationSpanM) return null;

    if (Math.abs(s - sorted[i - 1].s) < 1e-6) return { d: sorted[i - 1].d, spanM: 0 };
    if (Math.abs(s - sorted[i].s) < 1e-6) return { d: sorted[i].d, spanM: 0 };

    const ds = sorted[i].s - sorted[i - 1].s;
    const t = (s - sorted[i - 1].s) / (ds || 1);
    return { d: sorted[i - 1].d + t * (sorted[i].d - sorted[i - 1].d), spanM: span };
  }
  return null;
}

function resamplePairedRun(leftRun, rightRun, overlapStart, overlapEnd, options = {}) {
  const sampleStep = options.polygonSampleStepM ?? 2.0;
  const maxWidth = options.maxRoadWidthM ?? 30;
  const minWidth = options.minRoadWidthM ?? 2;
  const maxPairGap = options.maxVertexJumpM ?? 15;
  const fusionIntervalM = options.fusionIntervalM ?? 2.0;
  const maxInterpolationSpanM = resolveMaxInterpolationSpanM(options);

  if (overlapEnd - overlapStart < sampleStep) return [];

  const samples = [];
  for (let s = overlapStart; s <= overlapEnd + 1e-9; s += sampleStep) {
    const lR = interpolateDWithinRun(leftRun, s, maxInterpolationSpanM, fusionIntervalM);
    const rR = interpolateDWithinRun(rightRun, s, maxInterpolationSpanM, fusionIntervalM);
    if (!lR || !rR) continue;
    if (lR.spanM > maxInterpolationSpanM || rR.spanM > maxInterpolationSpanM) continue;

    const dL = lR.d;
    const dR = rR.d;
    const width = Math.abs(dL - dR);
    if (width < minWidth || width > maxWidth) {
      samples.push({ s, dL, dR, width, valid: false, reason: width < minWidth ? 'tooNarrow' : 'tooWide' });
      continue;
    }
    if (dL < dR) {
      samples.push({ s, dL, dR, width, valid: false, reason: 'boundaryCrossing' });
      continue;
    }
    samples.push({ s, dL, dR, width, valid: true, maxInterpSpanM: Math.max(lR.spanM, rR.spanM) });
  }

  const intervals = [];
  let current = [];
  for (const smp of samples) {
    if (!smp.valid) {
      if (current.length >= 3) intervals.push(current);
      current = [];
      continue;
    }
    if (current.length && smp.s - current[current.length - 1].s > maxPairGap) {
      if (current.length >= 3) intervals.push(current);
      current = [smp];
      continue;
    }
    current.push(smp);
  }
  if (current.length >= 3) intervals.push(current);
  return intervals;
}

function resampleBoundaries(leftFrags, rightFrags, trajectory, options = {}) {
  const sampleStep = options.polygonSampleStepM ?? 2.0;
  const fusionIntervalM = options.fusionIntervalM ?? 2.0;
  const maxInterpolationSpanM = resolveMaxInterpolationSpanM(options);

  const leftPts = leftFrags.flat().sort((a, b) => a.s - b.s);
  const rightPts = rightFrags.flat().sort((a, b) => a.s - b.s);
  if (!leftPts.length || !rightPts.length) {
    return {
      intervals: [],
      rejected: ['missingBoundary'],
      supportedRuns: { left: [], right: [] },
      pairedRuns: [],
      maxInterpolationSpanM,
    };
  }

  const leftRuns = splitSupportedRuns(leftPts, maxInterpolationSpanM, fusionIntervalM);
  const rightRuns = splitSupportedRuns(rightPts, maxInterpolationSpanM, fusionIntervalM);
  const minOverlapM = sampleStep * 2;
  const pairedRuns = pairSupportedRuns(leftRuns, rightRuns, minOverlapM);

  const intervals = [];
  for (const pair of pairedRuns) {
    intervals.push(...resamplePairedRun(
      pair.leftRun,
      pair.rightRun,
      pair.overlapStart,
      pair.overlapEnd,
      options
    ));
  }

  return {
    intervals,
    rejected: intervals.length ? [] : ['insufficientPairedCoverage'],
    supportedRuns: { left: leftRuns, right: rightRuns },
    pairedRuns,
    maxInterpolationSpanM,
  };
}

function buildPolygonsFromIntervals(intervals, trajectory, options = {}) {
  const polygons = [];
  const rejectionLog = [];

  intervals.forEach((interval, fragmentIndex) => {
    const left = interval.map((smp) => sToMap(trajectory, smp.s, smp.dL));
    const right = interval.map((smp) => sToMap(trajectory, smp.s, smp.dR));
    const widths = interval.map((s) => s.width);
    const crossedSamples = interval.filter((s) => s.dL < s.dR).length;
    const check = validateRoadPolygon(left, right, options);
    const widthStats = {
      minWidth: Math.min(...widths),
      p5Width: percentile(widths, 0.05),
      medianWidth: median(widths),
      p95Width: percentile(widths, 0.95),
      maxWidth: Math.max(...widths),
      maxWidthAt: interval[widths.indexOf(Math.max(...widths))]?.s,
      widthChangePerM: interval.length > 1
        ? Math.max(...interval.slice(1).map((s, i) => Math.abs(s.width - interval[i].width) / (s.s - interval[i].s || 1)))
        : 0,
      wideFlag: Math.max(...widths) > 15,
      wideSamples: interval.filter((s) => s.width > 15).map((s) => ({
        s: s.s,
        width: s.width,
        left: sToMap(trajectory, s.s, s.dL),
        right: sToMap(trajectory, s.s, s.dR),
      })),
    };

    if (crossedSamples > 0) {
      check.valid = false;
      check.rejections = [...(check.rejections || []), 'boundaryCrossing'];
    }

    const syntheticCount = interval.filter((s) => s.syntheticForSurface).length;
    const interpolatedLengthM = syntheticCount * (options.polygonSampleStepM ?? 2);

    if (check.valid) {
      const sRange = [interval[0].s, interval[interval.length - 1].s];
      polygons.push({
        fragmentIndex,
        ring: [...left, ...[...right].reverse()],
        left,
        right,
        stats: {
          ...check.stats,
          ...widthStats,
          sRange,
          crossedSamples,
          syntheticSampleCount: syntheticCount,
          interpolatedLengthM,
        },
        source: options.polygonSource || 'edges',
        sourceLeftTrackId: options.sourceLeftTrackId ?? null,
        sourceRightTrackId: options.sourceRightTrackId ?? null,
        surfaceType: options.surfaceType ?? SURFACE_TYPES.EGO_LANE,
        bridgeProvenance: options.bridgeProvenance ?? [],
        safeBridgeGapM: options.safeBridgeGapM ?? null,
      });
    } else {
      rejectionLog.push({
        fragmentIndex,
        reasons: check.rejections,
        stats: { ...check.stats, ...widthStats, crossedSamples },
      });
    }
  });

  return { polygons, rejectionLog };
}

function countPolygonOverlaps(polygons) {
  let overlaps = 0;
  for (let i = 0; i < polygons.length; i++) {
    for (let j = i + 1; j < polygons.length; j++) {
      const a = polygons[i];
      const b = polygons[j];
      const aS = a.stats?.sRange || [0, 0];
      const bS = b.stats?.sRange || [0, 0];
      if (aS[1] > bS[0] && bS[1] > aS[0]) overlaps++;
    }
  }
  return overlaps;
}

function processPassSdFusion(frames, vehiclePath, options = {}) {
  const trajectory = buildReferenceTrajectory(vehiclePath);
  const { observations: edgeObs, rejected: rejectedEdgeObs } = collectEdgeObservations(frames, trajectory, options);
  const laneObs = collectLaneObservations(frames, trajectory, options);
  const projectionComparison = compareProjectionMethods(trajectory, edgeObs, options);

  const leftResult = fuseSideBoundary(edgeObs, 'left', options);
  const rightResult = fuseSideBoundary(edgeObs, 'right', options);

  const leftCoverageM = coverageLength(leftResult.fusedPoints);
  const rightCoverageM = coverageLength(rightResult.fusedPoints);
  const pairedCoverageM = Math.min(leftCoverageM, rightCoverageM);

  const leftMapFrags = leftResult.fragments.map((frag, i) => ({
    side: 'left',
    fragmentIndex: i,
    points: sdToMapPoints(trajectory, frag),
    sdPoints: frag,
  }));
  const rightMapFrags = rightResult.fragments.map((frag, i) => ({
    side: 'right',
    fragmentIndex: i,
    points: sdToMapPoints(trajectory, frag),
    sdPoints: frag,
  }));

  const { intervals: edgeIntervals, rejected: intervalRejected } = resampleBoundaries(
    leftResult.fragments,
    rightResult.fragments,
    trajectory,
    options
  );
  const edgePolygonResult = buildPolygonsFromIntervals(edgeIntervals, trajectory, {
    ...options,
    polygonSource: 'edges',
  });

  const fusedLanes = [];
  if (options.laneTrackingEnabled !== false) {
    const trackIds = [...new Set(laneObs.map((o) => o.laneTrackId).filter((x) => x != null))];
    for (const laneTrackId of trackIds) {
      fusedLanes.push(...fuseLaneByTrack(laneObs, laneTrackId, { ...options, trajectory }));
    }
  } else {
    const laneIndices = [...new Set(laneObs.map((o) => o.laneIndex))];
    for (const laneIndex of laneIndices) {
      fusedLanes.push(...fuseLaneByIndex(laneObs, laneIndex, { ...options, trajectory }));
    }
  }

  const pathLengthM = trajectory.totalLength || 0;
  let polygons = edgePolygonResult.polygons;
  let rejectionLog = edgePolygonResult.rejectionLog;
  let polygonSource = 'edges';
  let laneBoundaryPairing = null;
  let interpolatedSurfaceLengthM = 0;

  const edgePolygonCoverageM = polygonCoverageLength(edgePolygonResult.polygons);
  const laneBounds = selectOuterLaneTrackBoundaries(laneObs, { ...options, trajectory });
  const minAbsolutePolygonCoverageM = options.minAbsolutePolygonCoverageM ?? 50;
  const minEdgeCoverageFrac = options.minEdgePolygonCoverageFrac ?? 0.1;
  const edgeCoverageInsufficient = edgePolygonResult.polygons.length === 0
    || edgePolygonCoverageM < minAbsolutePolygonCoverageM
    || edgePolygonCoverageM < pathLengthM * minEdgeCoverageFrac;
  if (laneBounds && edgeCoverageInsufficient) {
    const lanePolygonResult = buildPolygonsFromLaneTrackPairs(laneBounds, trajectory, options);
    if (lanePolygonResult.polygons.length > 0) {
      polygons = lanePolygonResult.polygons;
      rejectionLog = lanePolygonResult.rejectionLog;
      polygonSource = 'laneTracks';
      laneBoundaryPairing = laneBounds.pairs ?? laneBounds;
      interpolatedSurfaceLengthM = lanePolygonResult.totalBridgeLengthM ?? 0;
    }
  }

  const polygonCoverageM = polygonCoverageLength(polygons);

  return {
    trajectory,
    edgeObservations: edgeObs,
    rejectedEdgeObservations: rejectedEdgeObs,
    leftBoundary: leftMapFrags,
    rightBoundary: rightMapFrags,
    fusedRoadEdges: [...leftMapFrags, ...rightMapFrags],
    fusedLaneLines: fusedLanes,
    roadSurfacePolygons: polygons,
    polygonRejections: rejectionLog,
    coverage: {
      pathLengthM,
      leftCoverageM,
      rightCoverageM,
      pairedCoverageM,
      polygonCoverageM,
      coveragePercent: pathLengthM > 0 ? (polygonCoverageM / pathLengthM) * 100 : 0,
    },
    diagnostics: {
      inputEdgeObservationCount: edgeObs.length,
      rejectedEdgeObservationCount: rejectedEdgeObs.length,
      fusedLeftPointCount: leftResult.fusedPoints.length,
      fusedRightPointCount: rightResult.fusedPoints.length,
      lateralSpikeRejections: [...leftResult.rejected, ...rightResult.rejected].filter((r) => r.reason === 'lateralSpike').length,
      boundaryReversalCount: 0,
      polygonOverlapCount: countPolygonOverlaps(polygons),
      selfIntersectionCount: polygons.reduce((n, p) => n + countSelfIntersections(p.ring), 0),
      spikeCount: [...leftResult.rejected, ...rightResult.rejected].filter((r) => r.reason === 'lateralSpike').length,
      intervalRejected,
      polygonSource,
      edgePolygonCoverageM,
      laneBoundaryPairing,
      interpolatedSurfaceLengthM,
      projectionChangedCount: projectionComparison.changedCount,
      projectionAmbiguousRejected: rejectedEdgeObs.filter((r) => r.reason === 'projectionAmbiguous').length,
    },
  };
}

function coverageLength(fusedPoints) {
  if (!fusedPoints?.length) return 0;
  return fusedPoints[fusedPoints.length - 1].s - fusedPoints[0].s;
}

function processChunkSdFusion(frames, vehiclePath, options = {}) {
  const { detectPasses, assignFramesToPasses } = require('./passes');
  const { trackLanesAndEdgesInPass } = require('./lane_tracking');
  const {
    assignPoseSections,
    applyPoseSectionsToFrames,
    buildSectionedTrajectories,
    diagnoseFirstRejection,
  } = require('./pose_continuity');

  const { passes, diagnostics: passDiagnostics } = detectPasses(vehiclePath, options);
  const assignedFrames = assignFramesToPasses(frames, passes);

  const poseContinuityEnabled = options.poseContinuityEnabled !== false;
  const pathWithPassIds = passes.flatMap((p) => p.points.map((pt) => ({
    ...pt,
    temporalPassId: p.passId,
    passId: p.passId,
  })));

  const poseResult = poseContinuityEnabled
    ? assignPoseSections(pathWithPassIds, options)
    : {
      sections: passes.map((p) => ({
        poseSectionId: 0,
        pointCount: p.points.length,
        startFrameId: p.points[0]?.frameId,
        endFrameId: p.points[p.points.length - 1]?.frameId,
        temporalPassId: p.passId,
      })),
      transitions: [],
      rejectedTransitions: [],
      annotatedPoints: pathWithPassIds.map((pt) => ({
        ...pt,
        poseSectionId: 0,
        poseContinuityStatus: 'valid',
        poseRejectionReason: null,
      })),
      poseSectionCount: passes.length,
    };

  const sectionedTraj = poseContinuityEnabled
    ? buildSectionedTrajectories(poseResult.annotatedPoints)
    : {
      segments: passes.map((p) => p.points.map((pt) => ({
        ...pt,
        poseSectionId: 0,
        temporalPassId: p.passId,
        passId: p.passId,
      }))),
      hiddenConnectorLengthM: 0,
    };

  const framesWithPose = poseContinuityEnabled
    ? applyPoseSectionsToFrames(assignedFrames, poseResult.annotatedPoints)
    : assignedFrames.map((f) => ({ ...f, poseSectionId: 0, temporalPassId: f.passId ?? 0 }));

  const passResults = [];
  let allPolygons = [];
  let allLanes = [];
  let allEdges = [];
  let allRejections = [];
  let laneTrackingSummary = { passes: [] };

  let allAnnotatedFrames = [];

  let allTracks = [];
  let allFramePairAudits = [];
  let geometryLayers = null;

  for (const pass of passes) {
    const passFrames = framesWithPose.filter((f) => f.passId === pass.passId);
    const sectionIds = [...new Set(passFrames.map((f) => f.poseSectionId ?? 0))];

    for (const poseSectionId of sectionIds) {
      const sectionFrames = passFrames.filter((f) => (f.poseSectionId ?? 0) === poseSectionId);
      if (!sectionFrames.length) continue;

      const tracked = trackLanesAndEdgesInPass(sectionFrames, options);
      allAnnotatedFrames.push(...tracked.frames);
      if (tracked.tracks) {
        allTracks.push(...tracked.tracks.map((t) => ({
          ...t,
          passId: pass.passId,
          temporalPassId: pass.passId,
          poseSectionId,
        })));
      }
      if (tracked.framePairAudits) {
        allFramePairAudits.push(...tracked.framePairAudits.map((a) => ({
          ...a,
          passId: pass.passId,
          poseSectionId,
        })));
      }
      laneTrackingSummary.passes.push({
        passId: pass.passId,
        poseSectionId,
        ...tracked.summary,
        lane: tracked.laneDiagnostics,
        edge: tracked.edgeDiagnostics,
      });

      const sectionPath = poseResult.annotatedPoints.filter(
        (p) => p.passId === pass.passId && p.poseSectionId === poseSectionId
      );
      const passPath = sectionPath.length ? sectionPath : pass.points;
      const result = processPassSdFusion(tracked.frames, passPath, {
        ...options,
        poseSectionId,
        temporalPassId: pass.passId,
      });
      passResults.push({
        passId: pass.passId,
        poseSectionId,
        temporalPassId: pass.passId,
        trusted: pass.trusted,
        suspiciousGps: pass.suspiciousGps,
        pathLengthM: pass.pathLengthM,
        frameCount: sectionFrames.length,
        splitEvents: passDiagnostics.splitEvents.filter((e) => e.passId === pass.passId),
        ...result,
      });
      allPolygons.push(...result.roadSurfacePolygons.map((p) => ({
        ...p,
        passId: pass.passId,
        temporalPassId: pass.passId,
        poseSectionId,
      })));
      allLanes.push(...result.fusedLaneLines.map((l) => ({
        ...l,
        passId: pass.passId,
        temporalPassId: pass.passId,
        poseSectionId,
      })));
      allEdges.push(...result.fusedRoadEdges.map((e) => ({
        ...e,
        passId: pass.passId,
        temporalPassId: pass.passId,
        poseSectionId,
      })));
      allRejections.push(...result.polygonRejections.map((r) => ({
        ...r,
        passId: pass.passId,
        poseSectionId,
      })));
    }
  }

  if (options.localSupportFilter) {
    const { buildGeometryLayers } = require('./lane_support');
    geometryLayers = buildGeometryLayers(
      allAnnotatedFrames,
      allTracks,
      allLanes,
      allEdges,
      allPolygons,
      options
    );
    allLanes = geometryLayers.acceptedFusedLanes;
  }

  return {
    passes: passResults,
    passDiagnostics: {
      ...passDiagnostics,
      poseSectionCount: poseResult.poseSectionCount,
      rejectedPoseTransitions: poseResult.rejectedTransitions.length,
      firstPoseRejection: diagnoseFirstRejection(poseResult),
      hiddenConnectorLengthM: sectionedTraj.hiddenConnectorLengthM,
      poseSections: poseResult.sections,
    },
    annotatedVehiclePath: sectionedTraj.segments.flat(),
    trajectorySegments: sectionedTraj.segments,
    poseContinuity: poseResult,
    annotatedFrames: allAnnotatedFrames,
    trajectory: passResults[0]?.trajectory,
    leftBoundary: allEdges.filter((e) => e.side === 'left'),
    rightBoundary: allEdges.filter((e) => e.side === 'right'),
    fusedRoadEdges: allEdges,
    fusedLaneLines: allLanes,
    roadSurfacePolygons: allPolygons,
    polygonRejections: allRejections,
    passCoverage: passResults.map((p) => ({
      chunkId: options.chunkId,
      passId: p.passId,
      frameCount: p.frameCount,
      pathLengthM: p.pathLengthM,
      leftCoverageM: p.coverage.leftCoverageM,
      rightCoverageM: p.coverage.rightCoverageM,
      pairedCoverageM: p.coverage.pairedCoverageM,
      acceptedPolygonCount: p.roadSurfacePolygons.length,
      rejectedPolygonCount: p.polygonRejections.length,
      rejectionReasons: [...new Set(p.polygonRejections.flatMap((r) => r.reasons || []))],
      coveragePercent: p.coverage.coveragePercent,
      trusted: p.trusted,
      suspiciousGps: p.suspiciousGps,
    })),
    edgeObservations: passResults.flatMap((p) => p.edgeObservations || []),
    rejectedEdgeObservations: passResults.flatMap((p) => p.rejectedEdgeObservations || []),
    diagnostics: {
      passCount: passes.length,
      inputEdgeObservationCount: passResults.reduce((n, p) => n + p.diagnostics.inputEdgeObservationCount, 0),
      rejectedEdgeObservationCount: passResults.reduce((n, p) => n + p.diagnostics.rejectedEdgeObservationCount, 0),
      projectionChangedCount: passResults.reduce((n, p) => n + p.diagnostics.projectionChangedCount, 0),
      polygonOverlapCount: passResults.reduce((n, p) => n + p.diagnostics.polygonOverlapCount, 0),
      selfIntersectionCount: passResults.reduce((n, p) => n + p.diagnostics.selfIntersectionCount, 0),
    },
    laneTrackingSummary,
    allTracks,
    framePairAudits: allFramePairAudits,
    geometryLayers,
  };
}

function exportChunkGeometryDiagnostic(frames, vehiclePath, options = {}) {
  const result = processChunkSdFusion(frames, vehiclePath, options);
  return {
    vehicleTrajectory: vehiclePath,
    edgeObservationsPerFrame: frames.map((f) => ({
      frameId: f.frameId,
      logMonoTime: f.logMonoTime,
      sourceFile: f.sourceFile,
      edges: (f.edges || []).map((e) => ({
        edgeIndex: e.edgeIndex,
        points: e.points,
      })),
    })),
    projectedObservations: result.edgeObservations,
    rejectedObservations: result.rejectedEdgeObservations,
    fusedLeftBoundary: result.leftBoundary,
    fusedRightBoundary: result.rightBoundary,
    boundaryPairings: result.roadSurfacePolygons.map((p) => ({
      fragmentIndex: p.fragmentIndex,
      stats: p.stats,
    })),
    polygonRings: result.roadSurfacePolygons.map((p) => ({
      fragmentIndex: p.fragmentIndex,
      ring: p.ring,
      stats: p.stats,
    })),
    rejectedPolygons: result.polygonRejections,
    diagnostics: result.diagnostics,
  };
}




/**
 * Stage 8: controlled visible reconstruction for structurally bridged gaps
 * that remain visually open (> renderer intra-gap threshold).
 */


const RENDERER_MAX_INTRA_GAP_M = 15;
const DEFAULT_RECON_OPTS = {
  maxPointSpacingM: 1.0,
  minStructuralBridgeGapM: 12,
  maxStructuralBridgeGapM: 18,
  maxPositiveBoundaryBridgeGapM: 18,
  minRealSupportPoints: 3,
  tangentLookbackM: 8,
  tangentLookaheadM: 8,
  maxBridgeCurvatureDeg: 35,
  maxLateralDepartureM: 2.5,
  maxJoinHeadingDeltaDeg: 25,
  maxJoinLateralDeltaM: 0.8,
  minTangentStabilityDot: 0.7,
  repairStage: 8,
};

function isGeneratedPoint(pt) {
  return !!(pt?.generated || pt?.interpolationProvenance?.generated);
}

function isRealPoint(pt) {
  return pt && !isGeneratedPoint(pt);
}

function headingFromPoints(a, b) {
  return Math.atan2(b.north - a.north, b.east - a.east);
}

function headingDeg(a, b) {
  return (headingFromPoints(a, b) * 180) / Math.PI;
}

function normalizeVec(v) {
  const len = Math.hypot(v.east, v.north);
  if (len < 1e-9) return null;
  return { east: v.east / len, north: v.north / len };
}

function collectSupportPoints(points, sdPoints, index, direction, options = {}) {
  const opts = { ...DEFAULT_RECON_OPTS, ...options };
  const lookM = direction === 'before' ? opts.tangentLookbackM : opts.tangentLookaheadM;
  const out = [{ east: points[index].east, north: points[index].north, s: sdPoints[index]?.s, index }];
  let lastHeading = null;

  if (direction === 'before') {
    for (let i = index - 1; i >= 0; i--) {
      if (!isRealPoint(points[i])) continue;
      const prev = out[out.length - 1];
      const segHeading = headingDeg(points[i], prev);
      if (lastHeading != null) {
        let d = Math.abs(segHeading - lastHeading);
        if (d > 180) d = 360 - d;
        if (d > opts.maxJoinHeadingDeltaDeg) break;
      }
      lastHeading = segHeading;
      out.push({ east: points[i].east, north: points[i].north, s: sdPoints[i]?.s, index: i });
      const span = (sdPoints[index]?.s ?? 0) - (sdPoints[i]?.s ?? 0);
      if (out.length >= opts.minRealSupportPoints && span >= lookM) break;
    }
    out.reverse();
  } else {
    for (let i = index + 1; i < points.length; i++) {
      if (!isRealPoint(points[i])) continue;
      const prev = out[out.length - 1];
      const segHeading = headingDeg({ east: prev.east, north: prev.north }, points[i]);
      if (lastHeading != null) {
        let d = Math.abs(segHeading - lastHeading);
        if (d > 180) d = 360 - d;
        if (d > opts.maxJoinHeadingDeltaDeg) continue;
      }
      lastHeading = segHeading;
      out.push({ east: points[i].east, north: points[i].north, s: sdPoints[i]?.s, index: i });
      const span = (sdPoints[i]?.s ?? 0) - (sdPoints[index]?.s ?? 0);
      if (out.length >= opts.minRealSupportPoints && span >= lookM) break;
    }
  }
  return out;
}

function estimateEndpointTangent(points, sdPoints, index, direction, options = {}) {
  const opts = { ...DEFAULT_RECON_OPTS, ...options };
  const support = collectSupportPoints(points, sdPoints, index, direction, opts);
  if (support.length < opts.minRealSupportPoints) {
    return { stable: false, reason: 'insufficientSupportPoints', usedCount: support.length, supportPoints: support };
  }

  const segments = [];
  for (let i = 0; i < support.length - 1; i++) {
    segments.push({
      a: support[i],
      b: support[i + 1],
      ds: Math.abs((support[i + 1].s ?? 0) - (support[i].s ?? 0)),
    });
  }
  let vx = 0;
  let vy = 0;
  let wsum = 0;
  for (const seg of segments) {
    const w = Math.max(seg.ds, 0.25);
    vx += (seg.b.east - seg.a.east) * w;
    vy += (seg.b.north - seg.a.north) * w;
    wsum += w;
  }
  const tangent = normalizeVec({ east: vx / wsum, north: vy / wsum });
  if (!tangent) return { stable: false, reason: 'degenerateTangent', usedCount: support.length };

  const headings = segments.map((seg) => headingDeg(seg.a, seg.b));
  let maxDelta = 0;
  for (let i = 1; i < headings.length; i++) {
    let d = Math.abs(headings[i] - headings[i - 1]);
    if (d > 180) d = 360 - d;
    maxDelta = Math.max(maxDelta, d);
  }
  const lookDist = direction === 'before' ? opts.tangentLookbackM : opts.tangentLookaheadM;
  return {
    stable: maxDelta <= opts.maxJoinHeadingDeltaDeg,
    tangent,
    headingDeg: (Math.atan2(tangent.north, tangent.east) * 180) / Math.PI,
    usedCount: support.length,
    lookDistanceM: lookDist,
    maxSegmentHeadingDeltaDeg: maxDelta,
    supportPoints: support.map((p) => ({ east: p.east, north: p.north, s: p.s })),
  };
}

function findIntraRunJumps(points, sdPoints, thresholdM = RENDERER_MAX_INTRA_GAP_M) {
  const jumps = [];
  for (let i = 0; i < points.length - 1; i++) {
    const jumpM = dist2d(points[i], points[i + 1]);
    if (jumpM > thresholdM) {
      jumps.push({
        indexBefore: i,
        indexAfter: i + 1,
        jumpM,
        s0: sdPoints[i]?.s,
        s1: sdPoints[i + 1]?.s,
        pointBefore: points[i],
        pointAfter: points[i + 1],
        sdBefore: sdPoints[i],
        sdAfter: sdPoints[i + 1],
      });
    }
  }
  return jumps;
}

function mergeDecisionAtGap(mergeDecisions, s0, s1) {
  return (mergeDecisions || []).find((d) =>
    d.wasJoined
    && d.physicalBoundaryId
    && Math.abs((d.endS ?? -999) - s0) < 2
    && Math.abs((d.startS ?? -999) - s1) < 2);
}

function fragmentJoinAtGap(run, jump) {
  const frags = run.sourceFragments || [];
  if (frags.length < 2) return null;
  let ptCount = 0;
  for (let fi = 0; fi < frags.length - 1; fi++) {
    const frag = frags[fi];
    const next = frags[fi + 1];
    ptCount += (frag.points || []).length;
    const endS = frag.sdPoints?.slice(-1)[0]?.s;
    const startS = next.sdPoints?.[0]?.s;
    if (Math.abs(endS - jump.s0) < 2 && Math.abs(startS - jump.s1) < 2) {
      return { fragmentIndex: fi, endS, startS };
    }
  }
  return null;
}

function validateStructuralBridgeEvidence(run, jump, mergeDecisions, options = {}) {
  const opts = { ...DEFAULT_RECON_OPTS, ...DEFAULT_TRACKER_CONTINUITY_BRIDGE, ...options };
  const ds = (jump.s1 ?? 0) - (jump.s0 ?? 0);
  if (ds < opts.minStructuralBridgeGapM) {
    return { accepted: false, reason: 'belowMinStructuralBridgeGap' };
  }
  if (ds > opts.maxStructuralBridgeGapM) {
    return { accepted: false, reason: 'exceedsMaxStructuralBridgeGap' };
  }
  if (!run.physicalBoundaryId || !run.laneTrackId) {
    return { accepted: false, reason: 'missingBoundaryOrTrack' };
  }

  const compat = endpointCompatibility(
    { sdPoints: [jump.sdBefore, jump.sdBefore] },
    { sdPoints: [jump.sdAfter, jump.sdAfter] },
    {
      maxJoinLateralDeltaM: opts.maxJoinLateralDeltaM,
      maxJoinHeadingDeltaDeg: opts.maxJoinHeadingDeltaDeg,
    },
  );
  if (!compat.compatible) {
    return { accepted: false, reason: compat.reason || 'endpointIncompatible', compat };
  }

  const mergeHit = mergeDecisionAtGap(mergeDecisions, jump.s0, jump.s1);
  const fragJoin = fragmentJoinAtGap(run, jump);
  const laneObs = options.laneObservations?.filter((o) => o.laneTrackId === run.laneTrackId) || [];
  let fusionBridge = null;
  if (laneObs.length && jump.sdBefore && jump.sdAfter) {
    const prev = { s: jump.sdBefore.s, d: jump.sdBefore.d };
    const pt = { s: jump.sdAfter.s, d: jump.sdAfter.d };
    const current = [jump.sdBefore];
    const nextPt = jump.sdAfter;
    fusionBridge = canBridgeTrackerContinuousFusionGap(prev, pt, current, nextPt, laneObs, {
      ...opts,
      laneTrackId: run.laneTrackId,
      allLaneObservations: options.allLaneObservations || options.laneObservations,
      positiveBoundaryContinuityBridgeEnabled: options.positiveBoundaryContinuityBridgeEnabled !== false,
      trackerContinuityBridgeEnabled: true,
    });
  }

  const accepted = !!(mergeHit || fragJoin || fusionBridge?.bridge);
  if (fusionBridge?.bridge && fusionBridge.boundarySide !== 'positive') {
    return { accepted: false, reason: 'notPositiveBoundaryBridge', fusionBridge };
  }

  if (!accepted) {
    return {
      accepted: false,
      reason: fusionBridge?.reason || 'noStructuralBridgeEvidence',
      mergeHit: !!mergeHit,
      fragJoin: !!fragJoin,
      fusionBridge,
    };
  }

  return {
    accepted: true,
    reason: mergeHit ? 'cleanedRunMerge' : fragJoin ? 'fragmentJoin' : fusionBridge?.bridge ? 'fusionTrackerBridge' : 'geometryStructuralSignature',
    mergeHit,
    fragJoin,
    fusionBridge,
    gapRouteSM: ds,
    endpointCompatibility: compat,
  };
}

function sampleStraightBridge(p0, p1, s0, s1, maxSpacingM) {
  const chordM = dist2d(p0, p1);
  const n = Math.max(1, Math.ceil(chordM / maxSpacingM) - 1);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const s = s0 + t * (s1 - s0);
    out.push({
      east: p0.east + t * (p1.east - p0.east),
      north: p0.north + t * (p1.north - p0.north),
      s,
      d: (p0.d ?? 0) + t * ((p1.d ?? 0) - (p0.d ?? 0)),
    });
  }
  return out;
}

function hermite1d(p0, m0, p1, m1, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
}

function sampleHermiteBridge(p0, tan0, p1, tan1, sd0, sd1, maxSpacingM) {
  const chordM = dist2d(p0, p1);
  const n = Math.max(1, Math.ceil(chordM / maxSpacingM) - 1);
  const scale = chordM;
  const m0e = tan0.east * scale;
  const m0n = tan0.north * scale;
  const m1e = tan1.east * scale;
  const m1n = tan1.north * scale;
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const s = sd0.s + t * (sd1.s - sd0.s);
    out.push({
      east: hermite1d(p0.east, m0e, p1.east, m1e, t),
      north: hermite1d(p0.north, m0n, p1.north, m1n, t),
      s,
      d: hermite1d(sd0.d ?? 0, (tan0.north / Math.max(Math.hypot(tan0.east, tan0.north), 1e-9)) * 0,
        sd1.d ?? 0, (tan1.north / Math.max(Math.hypot(tan1.east, tan1.north), 1e-9)) * 0, t)
        || (sd0.d ?? 0) + t * ((sd1.d ?? 0) - (sd0.d ?? 0)),
    });
  }
  // Fix d interpolation linearly in s (more stable than hermite on d)
  for (const pt of out) {
    const t = (pt.s - sd0.s) / Math.max(sd1.s - sd0.s, 1e-9);
    pt.d = (sd0.d ?? 0) + t * ((sd1.d ?? 0) - (sd0.d ?? 0));
  }
  return out;
}

function bridgeCurvatureStats(points, sdPoints) {
  if (points.length < 3) return { maxHeadingDeltaDeg: 0 };
  const sd = sdPoints || points.map((p, i) => ({ s: p.s ?? i }));
  return curvatureSummary(sd);
}

function maxLateralDepartureFromChord(bridgePts, p0, p1) {
  const dx = p1.east - p0.east;
  const dy = p1.north - p0.north;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return 0;
  let max = 0;
  for (const p of bridgePts) {
    const t = ((p.east - p0.east) * dx + (p.north - p0.north) * dy) / len2;
    const px = p0.east + t * dx;
    const py = p0.north + t * dy;
    max = Math.max(max, Math.hypot(p.east - px, p.north - py));
  }
  return max;
}

function segmentCrossesBridge(bridgePts, otherPts) {
  if (!otherPts?.length || otherPts.length < 2 || bridgePts.length < 2) return false;
  const full = [bridgePts[0], ...bridgePts, bridgePts[bridgePts.length - 1]];
  for (let i = 0; i < full.length - 1; i++) {
    for (let j = 0; j < otherPts.length - 1; j++) {
      const cross = (o, p, q) => (p.east - o.east) * (q.north - o.north) - (p.north - o.north) * (q.east - o.east);
      const a = full[i];
      const b = full[i + 1];
      const c = otherPts[j];
      const d = otherPts[j + 1];
      const d1 = cross(a, b, c);
      const d2 = cross(a, b, d);
      const d3 = cross(c, d, a);
      const d4 = cross(c, d, b);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
        return true;
      }
    }
  }
  return false;
}

function attachProvenance(pt, meta, confidence) {
  return {
    east: pt.east,
    north: pt.north,
    generated: true,
    interpolationProvenance: {
      source: 'interpolated',
      generated: true,
      repairStage: meta.repairStage ?? DEFAULT_RECON_OPTS.repairStage,
      gapStableKey: meta.gapStableKey ?? null,
      physicalBoundaryId: meta.physicalBoundaryId,
      laneTrackId: meta.laneTrackId,
      chunkId: meta.chunkId,
      passId: meta.passId,
      interpolationMethod: meta.interpolationMethod,
      leftRealEndpoint: meta.leftRealEndpoint,
      rightRealEndpoint: meta.rightRealEndpoint,
      distanceToNearestRealObservationM: meta.distanceToNearestRealObservationM,
      confidence,
    },
  };
}

function confidenceAtT(t, baseConfidence) {
  const centre = 1 - 4 * (t - 0.5) * (t - 0.5);
  const floor = Math.max(0.05, baseConfidence * 0.35);
  const peak = Math.max(floor + 0.01, baseConfidence * 0.75);
  return floor + (peak - floor) * centre;
}

function evaluateReconstructionCandidates(run, jump, tangents, options = {}) {
  const opts = { ...DEFAULT_RECON_OPTS, ...options };
  const p0 = jump.pointBefore;
  const p1 = jump.pointAfter;
  const sd0 = jump.sdBefore;
  const sd1 = jump.sdAfter;
  const baseConf = Math.min(run.meanConfidence ?? 0.9, 0.95);

  const chord = { east: p1.east - p0.east, north: p1.north - p0.north };
  const chordLen = Math.hypot(chord.east, chord.north);
  const chordUnit = chordLen > 1e-9 ? { east: chord.east / chordLen, north: chord.north / chordLen } : null;
  if (!chordUnit) return { accepted: false, verdict: 'G', reason: 'degenerateGap' };

  const dot0 = tangents.before.tangent
    ? tangents.before.tangent.east * chordUnit.east + tangents.before.tangent.north * chordUnit.north
    : 0;
  const dot1 = tangents.after.tangent
    ? tangents.after.tangent.east * chordUnit.east + tangents.after.tangent.north * chordUnit.north
    : 0;
  if (dot0 < opts.minTangentStabilityDot || dot1 < opts.minTangentStabilityDot) {
    return { accepted: false, verdict: 'C', reason: 'unstableTangentOrDirectionReversal', dot0, dot1 };
  }

  const beforeCurv = bridgeCurvatureStats(
    tangents.before.supportPoints?.map((p) => ({ east: p.east, north: p.north })) || [],
    tangents.before.supportPoints?.map((p) => ({ s: p.s, d: 0 })) || [],
  );
  const afterCurv = bridgeCurvatureStats(
    tangents.after.supportPoints?.map((p) => ({ east: p.east, north: p.north })) || [],
    tangents.after.supportPoints?.map((p) => ({ s: p.s, d: 0 })) || [],
  );

  const candidates = [];
  const straightPts = sampleStraightBridge(p0, p1, sd0.s, sd1.s, opts.maxPointSpacingM);
  candidates.push({
    method: 'straight',
    points: straightPts,
    sdPoints: straightPts,
  });

  if (tangents.before.stable && tangents.after.stable) {
    const hermitePts = sampleHermiteBridge(
      p0, tangents.before.tangent, p1, tangents.after.tangent, sd0, sd1, opts.maxPointSpacingM,
    );
    candidates.push({
      method: 'cubicHermite',
      points: hermitePts,
      sdPoints: hermitePts,
    });
  }

  let best = null;
  for (const cand of candidates) {
    const pts = cand.points;
    if (!pts.length) continue;

    let monotonic = true;
    let prevS = sd0.s;
    for (const p of pts) {
      if (p.s <= prevS) { monotonic = false; break; }
      prevS = p.s;
    }
    if (!monotonic) continue;

    let maxSpacing = 0;
    const seq = [p0, ...pts, p1];
    for (let i = 0; i < seq.length - 1; i++) {
      maxSpacing = Math.max(maxSpacing, dist2d(seq[i], seq[i + 1]));
    }
    if (maxSpacing > opts.maxPointSpacingM + 0.05) continue;

    const latDep = maxLateralDepartureFromChord(pts, p0, p1);
    const curv = bridgeCurvatureStats(pts, pts);
    const maxCurv = Math.max(curv.maxHeadingDeltaDeg, beforeCurv.maxHeadingDeltaDeg, afterCurv.maxHeadingDeltaDeg);
    if (maxCurv > opts.maxBridgeCurvatureDeg) continue;
    if (latDep > opts.maxLateralDepartureM) continue;

  const straightCurv = bridgeCurvatureStats(straightPts, straightPts).maxHeadingDeltaDeg;
    const hermiteBetter = cand.method === 'cubicHermite'
      && Math.abs(tangents.before.headingDeg - tangents.after.headingDeg) > 8
      && curv.maxHeadingDeltaDeg + 0.5 < straightCurv;

    const score = (cand.method === 'straight' ? 10 : 0)
      + (hermiteBetter ? 5 : 0)
      - curv.maxHeadingDeltaDeg
      - latDep;

    if (!best || score > best.score) {
      best = {
        ...cand,
        score,
        maxSpacing,
        maxLateralDepartureM: latDep,
        maxCurvatureDeg: curv.maxHeadingDeltaDeg,
        hermiteBetter,
      };
    }
  }

  if (!best) {
    return { accepted: false, verdict: 'D', reason: 'noValidCandidate' };
  }

  const useHermite = best.method === 'cubicHermite' && best.hermiteBetter;
  const method = useHermite ? 'cubicHermite' : 'straight';
  const chosen = candidates.find((c) => c.method === method) || candidates[0];
  const gapKey = `${run.physicalBoundaryId}|${sd0.s.toFixed(2)}|${sd1.s.toFixed(2)}`;

  const provenancePts = chosen.points.map((pt, idx) => {
    const t = (idx + 1) / (chosen.points.length + 1);
    const conf = confidenceAtT(t, baseConf - 0.05);
    const distToReal = Math.min(t, 1 - t) * jump.jumpM;
    return attachProvenance(pt, {
      repairStage: opts.repairStage,
      gapStableKey: gapKey,
      physicalBoundaryId: run.physicalBoundaryId,
      laneTrackId: run.laneTrackId,
      chunkId: run.chunkId,
      passId: run.passId,
      interpolationMethod: method,
      leftRealEndpoint: { east: p0.east, north: p0.north, s: sd0.s },
      rightRealEndpoint: { east: p1.east, north: p1.north, s: sd1.s },
      distanceToNearestRealObservationM: distToReal,
    }, conf);
  });

  const provSd = chosen.points.map((pt, idx) => ({
    s: pt.s,
    d: pt.d,
    generated: true,
    interpolationMethod: method,
    confidence: provenancePts[idx].interpolationProvenance.confidence,
  }));

  return {
    accepted: true,
    verdict: method === 'straight' ? 'A' : 'B',
    method,
    points: provenancePts,
    sdPoints: provSd,
    insertedPointCount: provenancePts.length,
    generatedLengthM: chosen.points.reduce((sum, p, i) => {
      const prev = i === 0 ? p0 : chosen.points[i - 1];
      return sum + dist2d(prev, p);
    }, 0) + dist2d(chosen.points[chosen.points.length - 1], p1),
    maxPointSpacingM: best.maxSpacing,
    maxCurvatureDeg: best.maxCurvatureDeg,
    maxLateralDepartureM: best.maxLateralDepartureM,
    confidenceRange: [
      Math.min(...provenancePts.map((p) => p.interpolationProvenance.confidence)),
      Math.max(...provenancePts.map((p) => p.interpolationProvenance.confidence)),
    ],
    tangents: {
      before: tangents.before,
      after: tangents.after,
      headingDeltaDeg: Math.abs(tangents.before.headingDeg - tangents.after.headingDeg),
    },
    curvatureBefore: beforeCurv,
    curvatureAfter: afterCurv,
    gapStableKey: gapKey,
    inputEndpoints: [
      { east: p0.east, north: p0.north, s: sd0.s },
      { east: p1.east, north: p1.north, s: sd1.s },
    ],
  };
}

function applyVisibleGapReconstruction(cleaned, mergeDecisions, options = {}) {
  if (options.visibleGapReconstructionEnabled === false) {
    return { cleaned, repairs: [], stats: { enabled: false } };
  }

  const opts = { ...DEFAULT_RECON_OPTS, ...options };
  const repairs = [];
  const updated = cleaned.map((run) => ({ ...run, points: [...(run.points || [])], sdPoints: [...(run.sdPoints || [])] }));

  for (let ri = 0; ri < updated.length; ri++) {
    const run = updated[ri];
    const jumps = findIntraRunJumps(run.points, run.sdPoints, RENDERER_MAX_INTRA_GAP_M);
    if (!jumps.length) continue;

    const runMergeDecisions = (mergeDecisions || []).filter((d) =>
      d.physicalBoundaryId === run.physicalBoundaryId);

    let offset = 0;
    for (const jump of jumps) {
      const idxBefore = jump.indexBefore + offset;
      const idxAfter = jump.indexAfter + offset;
      const bridgeEvidence = validateStructuralBridgeEvidence(
        run,
        { ...jump, indexBefore: idxBefore, indexAfter: idxAfter },
        runMergeDecisions,
        opts,
      );
      if (!bridgeEvidence.accepted) {
        repairs.push({
          gapStableKey: `${run.physicalBoundaryId}|${jump.s0?.toFixed(2)}|${jump.s1?.toFixed(2)}`,
          accepted: false,
          verdict: 'G',
          reason: bridgeEvidence.reason,
          jumpM: jump.jumpM,
        });
        continue;
      }

      const tangents = {
        before: estimateEndpointTangent(run.points, run.sdPoints, idxBefore, 'before', opts),
        after: estimateEndpointTangent(run.points, run.sdPoints, idxAfter, 'after', opts),
      };
      if (!tangents.before.stable || !tangents.after.stable) {
        repairs.push({
          gapStableKey: `${run.physicalBoundaryId}|${jump.s0?.toFixed(2)}|${jump.s1?.toFixed(2)}`,
          accepted: false,
          verdict: 'C',
          reason: 'unstableTangent',
          tangents,
        });
        continue;
      }

      const recon = evaluateReconstructionCandidates(
        run,
        { ...jump, indexBefore: idxBefore, indexAfter: idxAfter },
        tangents,
        opts,
      );
      if (!recon.accepted) {
        repairs.push({
          gapStableKey: `${run.physicalBoundaryId}|${jump.s0?.toFixed(2)}|${jump.s1?.toFixed(2)}`,
          accepted: false,
          verdict: recon.verdict,
          reason: recon.reason,
        });
        continue;
      }

      const others = updated.filter((r, i) => i !== ri);
      let crossing = false;
      for (const other of others) {
        if (segmentCrossesBridge(recon.points, other.points)) {
          crossing = true;
          break;
        }
      }
      if (crossing) {
        repairs.push({
          gapStableKey: recon.gapStableKey,
          accepted: false,
          verdict: 'E',
          reason: 'crossingRisk',
        });
        continue;
      }

      const newPoints = [
        ...run.points.slice(0, idxAfter),
        ...recon.points,
        ...run.points.slice(idxAfter),
      ];
      const newSd = [
        ...run.sdPoints.slice(0, idxAfter),
        ...recon.sdPoints,
        ...run.sdPoints.slice(idxAfter),
      ];
      run.points = newPoints;
      run.sdPoints = newSd;
      offset += recon.insertedPointCount;
      run.visibleGapReconstruction = run.visibleGapReconstruction || [];
      run.visibleGapReconstruction.push(recon);

      repairs.push({
        gapStableKey: recon.gapStableKey,
        physicalBoundaryId: run.physicalBoundaryId,
        laneTrackId: run.laneTrackId,
        accepted: true,
        verdict: recon.verdict,
        method: recon.method,
        insertedPointCount: recon.insertedPointCount,
        generatedLengthM: recon.generatedLengthM,
        maxPointSpacingM: recon.maxPointSpacingM,
        confidenceRange: recon.confidenceRange,
        inputEndpoints: recon.inputEndpoints,
        tangents: recon.tangents,
        maxCurvatureDeg: recon.maxCurvatureDeg,
        maxLateralDepartureM: recon.maxLateralDepartureM,
        structuralEvidence: bridgeEvidence,
      });
    }
    updated[ri] = run;
  }

  const inserted = repairs.filter((r) => r.accepted);
  return {
    cleaned: updated,
    repairs,
    stats: {
      enabled: true,
      repairCount: inserted.length,
      rejectedCount: repairs.length - inserted.length,
      totalInsertedPoints: inserted.reduce((s, r) => s + r.insertedPointCount, 0),
      totalGeneratedLengthM: inserted.reduce((s, r) => s + r.generatedLengthM, 0),
    },
  };
}

function computeCoordinateChecksum(cleanedRuns) {
  let h = 2166136261;
  const mix = (n) => { h ^= n; h = Math.imul(h, 16777619); };
  for (const run of cleanedRuns || []) {
    for (const pt of run.points || []) {
      mix(Math.round((pt.east ?? 0) * 1000));
      mix(Math.round((pt.north ?? 0) * 1000));
      mix(pt.generated ? 1 : 0);
    }
  }
  return (h >>> 0).toString(16);
}




/**
 * Stationary local-playback lane map cleanup.
 * Builds evidence-based cleaned lane boundaries from fused tracks.
 */


const DEFAULT_OPTS = {
  minTrackFrames: 2,
  minFragmentPoints: 2,
  minSupportedSpanM: 3,
  maxLateralJumpM: 2.5,
  maxEndpointExtensionM: 12,
  maxFragmentSdGapM: 12,
  maxAdaptiveJoinGapM: 18,
  dropoutScaleGapM: 30,
  duplicateMeanDM: 0.8,
  duplicateMinOverlapM: 15,
  complementaryMaxGapM: 250,
  minSeparationForNeighbourM: 1.2,
  maxJoinLateralDeltaM: 0.8,
  maxJoinHeadingDeltaDeg: 25,
  fusionIntervalM: 2,
};

function trackSdStats(fusedFragments) {
  const pts = (fusedFragments || []).flatMap((f) => f.sdPoints || []);
  if (!pts.length) return null;
  const ds = pts.map((p) => p.d);
  const ss = pts.map((p) => p.s);
  return {
    meanD: ds.reduce((a, b) => a + b, 0) / ds.length,
    minS: Math.min(...ss),
    maxS: Math.max(...ss),
    spanM: Math.max(...ss) - Math.min(...ss),
    pointCount: pts.length,
    fragmentCount: fusedFragments.length,
  };
}

function trackFrameSupport(track) {
  const frameIds = track?.frameIds || [];
  return { frameCount: frameIds.length, frameIds };
}

function enrichFragmentFromFrames(frag, frames) {
  const frameIdToIdx = new Map(frames.map((f, i) => [f.frameId, i]));
  const meta = frag.supportMeta || {};
  const frameIds = meta.supportingFrameIds
    || [...new Set((frag.sdPoints || []).flatMap(() => []))];
  const sMin = frag.sdPoints?.[0]?.s;
  const sMax = frag.sdPoints?.[frag.sdPoints.length - 1]?.s;

  let matchedFrameIds = frameIds;
  if (!matchedFrameIds.length) {
    matchedFrameIds = [];
    for (const frame of frames) {
      for (const lane of frame.lanes || []) {
        if (lane.laneTrackId !== frag.laneTrackId) continue;
        matchedFrameIds.push(frame.frameId);
        break;
      }
    }
  }

  const elapsedIdx = matchedFrameIds.map((id) => frameIdToIdx.get(id)).filter((x) => x != null);
  const obsCount = (frag.sdPoints || []).reduce((n, p) => n + (p.frameCount ?? 1), 0);

  return {
    ...frag,
    sourceFrameIds: matchedFrameIds,
    sourceElapsedIdx: elapsedIdx,
    contributingObservationCount: obsCount || meta.independentFrameCount || matchedFrameIds.length,
    distinctSupportingFrameCount: meta.independentFrameCount
      || new Set(matchedFrameIds).size
      || frag.supportingFrameCount
      || 0,
    meanConfidence: meta.meanConfidence ?? null,
    minConfidence: meta.minConfidence ?? null,
    sMin,
    sMax,
  };
}

function sRangeOverlap(a, b) {
  const start = Math.max(a.minS, b.minS);
  const end = Math.min(a.maxS, b.maxS);
  return Math.max(0, end - start);
}

function sameSide(a, b, minSepM = 1.2) {
  if (!a || !b) return false;
  if (Math.sign(a.meanD) !== Math.sign(b.meanD)) return false;
  return Math.abs(a.meanD - b.meanD) < minSepM;
}

function isDuplicateTrack(statsA, statsB, opts) {
  if (!statsA || !statsB) return false;
  if (!sameSide(statsA, statsB, opts.duplicateMeanDM)) return false;
  const overlap = sRangeOverlap(statsA, statsB);
  if (overlap < opts.duplicateMinOverlapM) return false;
  return Math.abs(statsA.meanD - statsB.meanD) <= opts.duplicateMeanDM;
}

function sortFragmentsByS(fragments) {
  return [...fragments].sort((a, b) => {
    const sa = a.sdPoints?.[0]?.s ?? 0;
    const sb = b.sdPoints?.[0]?.s ?? 0;
    return sa - sb;
  });
}

function fragmentSdSpanM(frag) {
  const sd = frag.sdPoints || [];
  if (sd.length < 2) return 0;
  return Math.max(...sd.map((p) => p.s)) - Math.min(...sd.map((p) => p.s));
}

function maxSdLateralJump(sdPoints) {
  let max = 0;
  for (let i = 1; i < (sdPoints || []).length; i++) {
    max = Math.max(max, Math.abs(sdPoints[i].d - sdPoints[i - 1].d));
  }
  return max;
}

function hasSdLateralSpike(sdPoints, maxJumpM) {
  if (!sdPoints || sdPoints.length < 3) return false;
  for (let i = 1; i < sdPoints.length - 1; i++) {
    const interp = (sdPoints[i - 1].d + sdPoints[i + 1].d) / 2;
    if (Math.abs(sdPoints[i].d - interp) > maxJumpM) return true;
  }
  return false;
}

function mergeFragmentsWithEvidence(fragments, context) {
  const sorted = sortFragmentsByS(fragments);
  const opts = context.options || DEFAULT_OPTS;
  const adaptive = context.adaptiveJoinGapM ?? opts.maxFragmentSdGapM;
  const runs = [];
  const mergeDecisions = [];
  let current = [];

  for (const frag of sorted) {
    if (!frag.points?.length) continue;
    if (!current.length) {
      current.push(frag);
      continue;
    }
    const prev = current[current.length - 1];
    const decision = evaluateJoinEligibility(prev, frag, {
      ...context,
      options: opts,
      adaptiveJoinGapM: adaptive,
      trackIds: context.trackIds,
      physicalBoundaryId: context.physicalBoundaryId,
      nextPhysicalBoundaryId: context.physicalBoundaryId,
    });
    decision.wasJoined = decision.safeToJoin;
    decision.endS = prev.sdPoints?.slice(-1)[0]?.s;
    decision.startS = frag.sdPoints?.[0]?.s;
    decision.trackIds = context.trackIds;
    decision.physicalBoundaryId = context.physicalBoundaryId;
    mergeDecisions.push(decision);

    if (decision.safeToJoin) {
      current.push(frag);
    } else {
      runs.push(current);
      current = [frag];
    }
  }
  if (current.length) runs.push(current);
  return { runs, mergeDecisions };
}

function flattenRunToPoints(run) {
  const pts = [];
  for (const frag of run) {
    for (const p of frag.points || []) {
      if (!pts.length) {
        pts.push({ ...p });
        continue;
      }
      const prev = pts[pts.length - 1];
      if (dist2d(prev, p) < 0.02) continue;
      pts.push({ ...p });
    }
  }
  return pts;
}

function flattenRunSdPoints(run) {
  const sd = [];
  for (const frag of run) {
    for (const p of frag.sdPoints || []) {
      if (sd.length && Math.abs(p.s - sd[sd.length - 1].s) < 0.05) continue;
      sd.push(p);
    }
  }
  return sd;
}

function removeLateralSpikes(points, sdPoints, maxJumpM) {
  if (!points?.length || points.length < 3 || !sdPoints || sdPoints.length !== points.length) {
    return points;
  }
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (i < points.length - 1) {
      const interp = (sdPoints[i - 1].d + sdPoints[i + 1].d) / 2;
      if (Math.abs(sdPoints[i].d - interp) > maxJumpM) continue;
    }
    out.push(points[i]);
  }
  return out;
}

function trimUnsupportedEndpoints(points, sdPoints, maxExtensionM) {
  if (points.length < 3) return points;
  let start = 0;
  let end = points.length - 1;
  while (start < end - 1) {
    const span = Math.abs((sdPoints[end]?.s ?? 0) - (sdPoints[start]?.s ?? 0));
    const nextSpan = Math.abs((sdPoints[end]?.s ?? 0) - (sdPoints[start + 1]?.s ?? 0));
    if (span - nextSpan > maxExtensionM) start++;
    else break;
  }
  while (end > start + 1) {
    const span = Math.abs((sdPoints[end]?.s ?? 0) - (sdPoints[start]?.s ?? 0));
    const prevSpan = Math.abs((sdPoints[end - 1]?.s ?? 0) - (sdPoints[start]?.s ?? 0));
    if (span - prevSpan > maxExtensionM) end--;
    else break;
  }
  return points.slice(start, end + 1);
}

function segmentCrosses(a, b) {
  if (!a?.length || !b?.length || a.length < 2 || b.length < 2) return false;
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      const cross = (o, p, q) => (p.east - o.east) * (q.north - o.north) - (p.north - o.north) * (q.east - o.east);
      const d1 = cross(a[i], a[i + 1], b[j]);
      const d2 = cross(a[i], a[i + 1], b[j + 1]);
      const d3 = cross(b[j], b[j + 1], a[i]);
      const d4 = cross(b[j], b[j + 1], a[i + 1]);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
        return true;
      }
    }
  }
  return false;
}

function buildTrackedPolylines(frames, tracks, chunkId, passId, referencePose, transformFn) {
  const out = [];
  for (const track of tracks || []) {
    if (track.chunkId != null && track.chunkId !== chunkId) continue;
    if (track.passId != null && passId != null && track.passId !== passId) continue;
    const obs = [];
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      if (frame.chunkId != null && frame.chunkId !== chunkId) continue;
      if (passId != null && (frame.passId ?? frame.temporalPassId ?? 0) !== passId) continue;
      for (const lane of frame.lanes || []) {
        if (lane.laneTrackId !== track.trackId) continue;
        const mid = lane.points?.[Math.floor((lane.points.length - 1) / 2)];
        if (!mid) continue;
        const pt = transformFn ? transformFn(mid) : mid;
        obs.push({ ...pt, sourceFrameIndex: i, frameId: frame.frameId });
      }
    }
    if (obs.length < 2) continue;
    out.push({
      points: obs,
      laneTrackId: track.trackId,
      fragmentKind: 'trackedLane',
      sourceFrameCount: obs.length,
      supportStatus: 'tracked',
      colorByTrack: true,
    });
  }
  return out;
}

function evaluateFragment(frag, opts) {
  const sd = frag.sdPoints || [];
  const pts = frag.points || [];
  const spanM = Math.max(fragmentSdSpanM(frag), polylineLength(pts));
  const reasons = [];
  if (pts.length < opts.minFragmentPoints) reasons.push('tooFewPoints');
  if (spanM < opts.minSupportedSpanM) reasons.push('tooShort');
  if (maxSdLateralJump(sd) > opts.maxLateralJumpM) reasons.push('lateralJump');
  if (hasSdLateralSpike(sd, opts.maxLateralJumpM)) reasons.push('lateralSpike');
  return { spanM, reasons, accepted: reasons.length === 0 };
}

function buildCleanedLaneMap({
  frames = [],
  fusedLanes = [],
  tracks = [],
  chunkId = 0,
  passId = 0,
  trajectory = null,
  vehiclePath = null,
  classDGaps = null,
  enableD12Preservation = true,
  laneObservations = null,
  options = {},
}) {
  const opts = { ...DEFAULT_OPTS, ...options };
  const traj = trajectory || (vehiclePath?.length >= 2 ? buildReferenceTrajectory(vehiclePath) : null);
  const filtered = (fusedLanes || [])
    .filter((f) => {
      if (f.chunkId != null && f.chunkId !== chunkId) return false;
      if (f.passId != null && passId != null && f.passId !== passId) return false;
      return f.laneTrackId != null;
    })
    .map((f) => enrichFragmentFromFrames(f, frames));

  const trackSupport = new Map();
  for (const track of tracks || []) {
    if (track.chunkId != null && track.chunkId !== chunkId) continue;
    if (track.passId != null && passId != null && track.passId !== passId) continue;
    trackSupport.set(track.trackId, trackFrameSupport(track));
  }

  const byTrack = new Map();
  for (const frag of filtered) {
    const tid = frag.laneTrackId;
    if (!byTrack.has(tid)) byTrack.set(tid, []);
    byTrack.get(tid).push(frag);
  }

  const trackStats = new Map();
  for (const [tid, frags] of byTrack) {
    trackStats.set(tid, trackSdStats(frags));
  }

  const { groups: physicalBoundaryGroups, trackToGroup } = assignPhysicalBoundaryGroups(
    trackStats,
    tracks,
    opts,
  );

  const suppressed = new Set();
  const mergeGroups = [];

  for (const group of physicalBoundaryGroups) {
    const tid = group.trackIds[0];
    const support = trackSupport.get(tid);
    if (support && support.frameCount < opts.minTrackFrames) {
      for (const t of group.trackIds) suppressed.add(t);
      mergeGroups.push({
        trackIds: group.trackIds,
        physicalBoundaryId: group.physicalBoundaryId,
        suppressed: true,
        reason: 'insufficientTrackFrames',
        complementary: group.complementary,
      });
      continue;
    }
    mergeGroups.push({
      trackIds: group.trackIds,
      physicalBoundaryId: group.physicalBoundaryId,
      suppressed: false,
      complementary: group.complementary,
      meanD: group.meanD,
      side: group.side,
    });
  }

  const cleaned = [];
  const rejected = [];
  const audit = [];
  const allMergeDecisions = [];

  for (const groupInfo of mergeGroups) {
    if (groupInfo.suppressed) {
      for (const tid of groupInfo.trackIds) {
        for (const frag of byTrack.get(tid) || []) {
          rejected.push({
            points: frag.points || [],
            laneTrackId: tid,
            physicalBoundaryId: groupInfo.physicalBoundaryId,
            fragmentKind: 'rejectedLane',
            supportStatus: 'rejected',
            rejectReason: groupInfo.reason,
            sourceFragmentIndex: frag.fragmentIndex,
          });
        }
      }
      continue;
    }

    const group = groupInfo.trackIds;
    const allFrags = group.flatMap((tid) => byTrack.get(tid) || []);
    const adaptiveInfo = deriveAdaptiveJoinGapM(allFrags, opts);
    const { runs, mergeDecisions } = mergeFragmentsWithEvidence(allFrags, {
      options: opts,
      adaptiveJoinGapM: adaptiveInfo.adaptiveJoinGapM,
      trackIds: group,
      physicalBoundaryId: groupInfo.physicalBoundaryId,
      allFragments: filtered,
    });
    allMergeDecisions.push(...mergeDecisions);

    const primaryTrackId = group.reduce((best, tid) => {
      const s = trackStats.get(tid);
      return !best || (s?.spanM ?? 0) > (trackStats.get(best)?.spanM ?? 0) ? tid : best;
    }, null);

    for (let ri = 0; ri < runs.length; ri++) {
      const run = runs[ri];
      for (const frag of run) {
        const evalResult = evaluateFragment(frag, opts);
        if (!evalResult.accepted) {
          rejected.push({
            points: frag.points || [],
            laneTrackId: frag.laneTrackId ?? primaryTrackId,
            physicalBoundaryId: groupInfo.physicalBoundaryId,
            fragmentKind: 'rejectedLane',
            supportStatus: 'rejected',
            rejectReason: evalResult.reasons.join(','),
            sourceFragmentIndex: frag.fragmentIndex,
            lengthM: evalResult.spanM,
          });
        }
      }

      const srcFusedLen = sourceFusedLength(run);
      const srcPtCount = run.reduce((n, f) => n + (f.points?.length || 0), 0);
      let points = flattenRunToPoints(run);
      let sdPoints = flattenRunSdPoints(run);
      const rawLen = points.length;
      points = removeLateralSpikes(points, sdPoints, opts.maxLateralJumpM);
      sdPoints = flattenRunSdPoints(run).slice(0, points.length);
      points = trimUnsupportedEndpoints(points, sdPoints, opts.maxEndpointExtensionM);
      sdPoints = sdPoints.slice(0, points.length);

      const lenM = Math.max(polylineLength(points), sdPoints.length >= 2
        ? Math.abs(sdPoints[sdPoints.length - 1].s - sdPoints[0].s)
        : 0);
      const sMin = sdPoints.length ? Math.min(...sdPoints.map((p) => p.s)) : null;
      const sMax = sdPoints.length ? Math.max(...sdPoints.map((p) => p.s)) : null;
      const obsCount = run.reduce((n, f) => n + (f.contributingObservationCount ?? 0), 0);
      const frameCount = new Set(run.flatMap((f) => f.sourceFrameIds || [])).size;
      const confs = run.flatMap((f) => (f.meanConfidence != null ? [f.meanConfidence] : []));
      const meanD = sdPoints.length
        ? sdPoints.reduce((s, p) => s + p.d, 0) / sdPoints.length
        : groupInfo.meanD;

      const entry = {
        points,
        sdPoints,
        laneTrackId: primaryTrackId,
        physicalBoundaryId: groupInfo.physicalBoundaryId,
        logicalGroupTrackIds: group,
        complementaryBoundary: groupInfo.complementary ?? false,
        runIndex: ri,
        runId: cleaned.length,
        fragmentKind: 'cleanedLane',
        supportStatus: 'supported',
        sourceFragments: run,
        sourceFragmentCount: run.length,
        sourceFusedLengthM: srcFusedLen,
        sourcePointCount: srcPtCount,
        contributingObservationCount: obsCount,
        distinctSupportingFrameCount: frameCount,
        meanConfidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
        lengthM: lenM,
        sMin,
        sMax,
        meanD,
        colorByPhysicalBoundary: true,
        chunkId,
        passId,
      };

      if (points.length < opts.minFragmentPoints || lenM < opts.minSupportedSpanM) {
        entry.supportStatus = 'rejected';
        entry.rejectReason = 'runTooShort';
        rejected.push(entry);
        continue;
      }
      if (maxSdLateralJump(sdPoints) > opts.maxLateralJumpM * 1.2) {
        entry.supportStatus = 'rejected';
        entry.rejectReason = 'lateralSpike';
        rejected.push(entry);
        continue;
      }
      if (rawLen !== points.length) {
        audit.push({ type: 'spikeRemoved', trackIds: group, runIndex: ri, removedPoints: rawLen - points.length });
      }
      cleaned.push(entry);
    }
  }

  let crossingCount = 0;
  for (let i = 0; i < cleaned.length; i++) {
    for (let j = i + 1; j < cleaned.length; j++) {
      if (segmentCrosses(cleaned[i].points, cleaned[j].points)) crossingCount++;
    }
  }

  const reconResult = applyVisibleGapReconstruction(cleaned, allMergeDecisions, {
    ...opts,
    laneObservations,
    visibleGapReconstructionEnabled: options.visibleGapReconstructionEnabled === true
      || opts.visibleGapReconstructionEnabled === true,
    positiveBoundaryContinuityBridgeEnabled: options.positiveBoundaryContinuityBridgeEnabled
      ?? opts.positiveBoundaryContinuityBridgeEnabled,
  });
  if (reconResult.stats.enabled) {
    cleaned.length = 0;
    cleaned.push(...reconResult.cleaned);
  }

  cleaned.sort((a, b) => (b.meanD ?? 0) - (a.meanD ?? 0));
  cleaned.forEach((lane, i) => { lane.lateralOrder = i; lane.runId = i; });

  let preservedIntervals = [];
  let preservationResults = [];
  let displayCleaned = cleaned;

  if (enableD12Preservation && traj) {
    const gapSource = classDGaps?.length ? classDGaps : SEGMENT2_D12_GAPS;

    const preservation = preserveSourcePolylinesForGaps({
      gaps: gapSource,
      frames,
      trajectory: traj,
      physicalBoundaryGroups,
      cleaned,
      chunkId,
      passId,
      options: opts,
    });
    preservedIntervals = preservation.preservedIntervals;
    preservationResults = preservation.results;

    const tailExtension = extendPartialTailPreservation({
      preservedIntervals,
      frames,
      trajectory: traj,
      cleaned,
      chunkId,
      passId,
    });
    if (tailExtension.extensions.length) {
      preservedIntervals = [...preservedIntervals, ...tailExtension.extensions];
      preservationResults = [...preservationResults, ...tailExtension.results];
    }

    if (preservedIntervals.length) {
      const applied = applyPreservedGeometryToCleaned(cleaned, preservedIntervals);
      displayCleaned = applied.displayCleaned;
    }
  }

  const preservedCoverageM = preservedIntervals.reduce((s, p) => s + p.preservedLengthM, 0);
  const coverageAccounting = computeCoverageAccounting({
    cleanedFusedOnly: cleaned,
    cleanedWithPreserved: displayCleaned,
    preservedIntervals,
  });
  const drawablePathAnalysis = analyzeDrawablePaths(displayCleaned, preservedIntervals);

  return {
    cleaned: displayCleaned,
    cleanedFusedOnly: cleaned,
    rejected,
    tracked: [],
    fused: filtered.map((f, i) => ({
      points: f.points || [],
      sdPoints: f.sdPoints || [],
      laneTrackId: f.laneTrackId,
      fragmentIndex: f.fragmentIndex ?? i,
      fragmentKind: 'fusedLane',
      supportStatus: 'fused',
      colorByTrack: true,
    })),
    suppressedTrackIds: [...suppressed],
    mergeGroups,
    physicalBoundaryGroups,
    mergeDecisions: allMergeDecisions,
    preservedIntervals,
    preservedGeometry: preservedIntervals,
    preservationResults,
    preservationAudit: preservationResults,
    tailExtensionResults: preservationResults.filter((r) => r.isTailExtension),
    coverageAccounting,
    drawablePathAnalysis,
    adaptiveJoinInfo: physicalBoundaryGroups.map((g) => {
      const frags = g.trackIds.flatMap((tid) => byTrack.get(tid) || []);
      return { physicalBoundaryId: g.physicalBoundaryId, ...deriveAdaptiveJoinGapM(frags, opts) };
    }),
    audit,
    trackStats: Object.fromEntries(trackStats),
    stats: {
      fusedFragmentCount: filtered.length,
      trackCount: byTrack.size,
      physicalBoundaryGroupCount: physicalBoundaryGroups.length,
      cleanedRunCount: cleaned.length,
      rejectedCount: rejected.length,
      crossingCount,
      suppressedTrackCount: suppressed.size,
      joinsPerformed: allMergeDecisions.filter((d) => d.wasJoined).length,
      joinsRejected: allMergeDecisions.filter((d) => !d.wasJoined).length,
      preservedIntervalCount: preservedIntervals.length,
      preservedCoverageM,
      fullyResolvedD12Count: preservedIntervals.filter((p) => p.fullCoverage && !p.isTailExtension).length,
      partiallyResolvedD12Count: preservedIntervals.filter((p) => !p.fullCoverage && p.preservedLengthM > 0 && !p.isTailExtension).length,
      tailExtensionCount: preservedIntervals.filter((p) => p.isTailExtension).length,
      acceptedFusedUnionM: coverageAccounting?.routeSIntervalCoverage?.acceptedFusedUnionM,
      d12PreservedUnionM: coverageAccounting?.routeSIntervalCoverage?.d12PreservedUnionM,
      combinedSupportedUnionM: coverageAccounting?.routeSIntervalCoverage?.combinedSupportedUnionM,
      overlapAcceptedAndPreservedM: coverageAccounting?.routeSIntervalCoverage?.overlapAcceptedAndPreservedM,
      visibleGapReconstruction: reconResult.stats,
      coordinateChecksum: computeCoordinateChecksum(displayCleaned),
    },
    visibleGapReconstruction: reconResult,
  };
}

function computeLaneChecksum(laneFragments) {
  let h = 2166136261;
  const mix = (n) => { h ^= n; h = Math.imul(h, 16777619); };
  for (const frag of laneFragments || []) {
    mix(frag.physicalBoundaryId ? frag.physicalBoundaryId.charCodeAt(2) : (frag.laneTrackId ?? 0));
    mix(frag.lateralOrder ?? 0);
    const pts = frag.points || [];
    if (pts.length) {
      mix(Math.round(pts[0].east * 1000));
      mix(Math.round(pts[0].north * 1000));
      const last = pts[pts.length - 1];
      mix(Math.round(last.east * 1000));
      mix(Math.round(last.north * 1000));
    }
  }
  return (h >>> 0).toString(16);
}

function filterRoadSurfaceForCleanedLanes(polygons, cleanedLanes, physicalBoundaryGroups) {
  const trackIds = new Set();
  for (const lane of cleanedLanes || []) {
    trackIds.add(lane.laneTrackId);
    for (const tid of lane.logicalGroupTrackIds || []) trackIds.add(tid);
  }
  return (polygons || []).filter((poly) => {
    const left = poly.sourceLeftTrackId;
    const right = poly.sourceRightTrackId;
    if (left == null || right == null) return false;
    return trackIds.has(left) && trackIds.has(right);
  });
}

function physicalBoundaryColorIndex(physicalBoundaryId) {
  const n = parseInt(String(physicalBoundaryId).replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}



global.SdFusion = {
  collectLaneObservations,
  fuseLaneTrackSdFragments,
  canBridgeTrackerContinuousFusionGap,
  trackerContinuityBridgeEligibility,
  DEFAULT_TRACKER_CONTINUITY_BRIDGE,
};

global.LaneMapCleanup = {
  DEFAULT_OPTS,
  buildCleanedLaneMap,
  buildTrackedPolylines,
  computeLaneChecksum,
  computeCoordinateChecksum,
  filterRoadSurfaceForCleanedLanes,
  physicalBoundaryColorIndex,
  trackSdStats,
  removeLateralSpikes,
  trimUnsupportedEndpoints,
  segmentCrosses,
  maxSdLateralJump,
  evaluateFragment,
  enrichFragmentFromFrames,
  PROVENANCE_TYPE,
  SEGMENT2_D12_GAPS,
  preserveSourcePolylinesForGaps,
  extendPartialTailPreservation,
  auditPartialTails,
  analyzeDrawablePaths,
  computeCoverageAccounting,
};
})(typeof window !== 'undefined' ? window : global);
