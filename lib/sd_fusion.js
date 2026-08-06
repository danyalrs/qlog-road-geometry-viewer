/**
 * Along-track (s/d) fusion — project observations, bin by s, robust lateral estimate.
 * Does NOT concatenate per-frame polylines.
 */

const { buildReferenceTrajectory, sToMap } = require('./trajectory');
const { projectPointTemporal, vehicleSAtTimeTemporal, compareProjectionMethods } = require('./temporal_projection');
const { dist2d } = require('./chunking');
const { validateRoadPolygon, countSelfIntersections, polygonArea } = require('./geometry_sanity');
const {
  deriveSafeSurfaceBridgeGapM,
  mergeAdjacentIntervals,
  classifySurfaceType,
  SURFACE_TYPES,
} = require('./fusion_bins');
const { endpointCompatibility } = require('./lane_run_audit');

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

module.exports = {
  collectEdgeObservations,
  collectLaneObservations,
  fuseSideBoundary,
  fuseLaneByTrack,
  DEFAULT_TRACKER_CONTINUITY_BRIDGE,
  canBridgeTrackerContinuousFusionGap,
  isOuterBoundaryTrack,
  isPositiveBoundaryTrack,
  trackerContinuityBridgeEligibility,
  clusterObservationsByLateral,
  selectBimodalCluster,
  aggregateFusedBin,
  fuseLaneTrackSdFragments,
  selectOuterLaneTrackBoundaries,
  buildPolygonsFromLaneTrackPairs,
  trackSdSpan,
  trackSdRange,
  sRangeOverlapM,
  polygonCoverageLength,
  fuseLaneByIndex,
  resolveMaxInterpolationSpanM,
  sourceBinSpacing,
  splitSupportedRuns,
  pairSupportedRuns,
  interpolateDWithinRun,
  resamplePairedRun,
  resampleBoundaries,
  buildPolygonsFromIntervals,
  processPassSdFusion,
  processChunkSdFusion,
  exportChunkGeometryDiagnostic,
  weightedMedian,
  percentile,
};
