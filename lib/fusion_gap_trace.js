'use strict';

/**
 * Detailed lane-track fusion trace for class-D gap investigation.
 * Mirrors fuseLaneTrackSdFragments logic with full provenance — no threshold changes.
 */

const { dist2d } = require('./chunking');
const { buildReferenceTrajectory } = require('./trajectory');
const { collectLaneObservations, canBridgeTrackerContinuousFusionGap, aggregateFusedBin, isOuterBoundaryTrack } = require('./sd_fusion');

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mad(values) {
  if (!values.length) return 0;
  const med = median(values);
  return median(values.map((v) => Math.abs(v - med)));
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

const DEFAULT_FUSION_OPTS = {
  fusionIntervalM: 2.0,
  minObsPerBin: 2,
  minFramesPerBin: 2,
  maxLaneFragmentGapM: 10,
  maxLateralJumpM: 2.5,
  madMultiplier: 3.0,
};

/**
 * Full fusion trace for one lane track — bins, accept/reject, fragment splits.
 */
function traceLaneTrackFusion(observations, laneTrackId, options = {}) {
  const opts = { ...DEFAULT_FUSION_OPTS, ...options };
  const laneObs = observations.filter((o) => o.laneTrackId === laneTrackId);
  const allowBimodal = opts.bimodalClusterSelection !== false
    && isOuterBoundaryTrack(laneTrackId, laneObs, opts);
  const bins = new Map();

  for (const obs of laneObs) {
    const key = Math.round(obs.s / opts.fusionIntervalM);
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push(obs);
  }

  const binKeys = [...bins.keys()].sort((a, b) => a - b);
  const rejectedBins = [];
  const preliminary = [];
  for (const key of binKeys) {
    const obs = bins.get(key);
    const pt = aggregateFusedBin(obs, null, null, { ...opts, bimodalClusterSelection: false });
    if (pt) preliminary.push(pt);
  }
  preliminary.sort((a, b) => a.s - b.s);

  const binRecords = [];
  const acceptedFused = [];

  for (const key of binKeys) {
    const obs = bins.get(key);
    const sCentre = key * opts.fusionIntervalM;
    const frameIds = new Set(obs.map((o) => o.frameId));
    const timestamps = new Set(obs.map((o) => o.logMonoTime));
    const pointsPerFrame = {};
    for (const o of obs) {
      pointsPerFrame[o.frameId] = (pointsPerFrame[o.frameId] || 0) + 1;
    }

    const base = {
      binKey: key,
      binStartS: sCentre - opts.fusionIntervalM / 2,
      binEndS: sCentre + opts.fusionIntervalM / 2,
      binCentreS: sCentre,
      observationCount: obs.length,
      distinctFrameCount: frameIds.size,
      distinctTimestampCount: timestamps.size,
      sourceFrameIds: [...frameIds],
      confidenceValues: obs.map((o) => o.prob ?? 1),
      lateralValues: obs.map((o) => o.d),
      sourceObservations: obs.map((o) => ({
        frameId: o.frameId,
        logMonoTime: o.logMonoTime,
        s: o.s,
        d: o.d,
        prob: o.prob ?? 1,
      })),
      pointsPerFrame,
    };

    const prevPt = [...acceptedFused].reverse().find((p) => p.binKey < key)
      ?? [...preliminary].reverse().find((p) => p.binKey < key)
      ?? null;
    const nextPt = preliminary.find((p) => p.binKey > key) ?? null;
    const prelimPt = preliminary.find((p) => p.binKey === key) ?? null;
    const pt = aggregateFusedBin(obs, prevPt, nextPt, { ...opts, bimodalClusterSelection: allowBimodal });

    if (!pt) {
      let rejectionReason = 'D6_minObsPerBin';
      let failedCondition = `obs.length ${obs.length} < ${opts.minObsPerBin}`;
      if (obs.length >= opts.minObsPerBin && frameIds.size < opts.minFramesPerBin) {
        rejectionReason = 'D7_minFramesPerBin';
        failedCondition = `distinct frames ${frameIds.size} < ${opts.minFramesPerBin}`;
      } else if (obs.length >= opts.minObsPerBin) {
        rejectionReason = 'D9_lateralSpread';
        failedCondition = 'post-cluster inlier/frame gate';
      }
      rejectedBins.push({ ...base, accepted: false, rejectionReason, failedCondition });
      binRecords.push({ ...base, accepted: false, rejectionReason });
      continue;
    }
    if (prelimPt) pt.preliminaryD = prelimPt.d;
    const fusedPt = {
      s: pt.s,
      d: pt.d,
      frameCount: pt.frameCount,
      binKey: key,
      obsCount: obs.length,
      preliminaryD: pt.preliminaryD,
      bimodalClusterSelection: pt.bimodalClusterSelection,
    };
    acceptedFused.push(fusedPt);
    binRecords.push({
      ...base,
      accepted: true,
      fusedPoint: fusedPt,
      bimodalClusterSelection: pt.bimodalClusterSelection,
      preliminaryD: pt.preliminaryD,
    });
  }

  acceptedFused.sort((a, b) => a.s - b.s);

  const fragmentSplits = [];
  const fragments = [];
  let current = [];
  const spikeRejected = [];

  for (let i = 0; i < acceptedFused.length; i++) {
    const pt = acceptedFused[i];
    const nextPt = acceptedFused[i + 1] ?? null;
    if (current.length) {
      const prev = current[current.length - 1];
      const ds = pt.s - prev.s;
      const dd = Math.abs(pt.d - prev.d);
      if (ds > opts.maxLaneFragmentGapM || dd > opts.maxLateralJumpM * 3) {
        const laneObs = observations.filter((o) => o.laneTrackId === laneTrackId);
        const bridge = ds > opts.maxLaneFragmentGapM && dd <= opts.maxLateralJumpM * 3
          ? canBridgeTrackerContinuousFusionGap(prev, pt, current, nextPt, laneObs, {
            ...opts,
            laneTrackId,
            allLaneObservations: observations,
            trackerContinuityBridgeEnabled: opts.trackerContinuityBridgeEnabled !== false,
          })
          : { bridge: false };
        if (!bridge.bridge) {
          const reason = ds > opts.maxLaneFragmentGapM ? 'D11_maxLaneFragmentGapM' : 'D10_lateralJumpSplit';
          fragmentSplits.push({
            afterBinKey: prev.binKey,
            beforeBinKey: pt.binKey,
            gapM: ds,
            lateralDeltaM: dd,
            reason,
            bridgeRejected: bridge.reason || null,
            measurement: 'consecutive accepted fused bin centres (s coordinate)',
            thresholdM: ds > opts.maxLaneFragmentGapM ? opts.maxLaneFragmentGapM : opts.maxLateralJumpM * 3,
          });
          if (current.length >= 2) fragments.push([...current]);
          current = [pt];
          continue;
        }
        if (dd > opts.maxLateralJumpM) {
          spikeRejected.push({ s: pt.s, d: pt.d, binKey: pt.binKey, deltaD: dd, reason: 'D10_lateralSpikeSkipped' });
          continue;
        }
        current.push(pt);
        continue;
      }
      if (dd > opts.maxLateralJumpM) {
        spikeRejected.push({ s: pt.s, d: pt.d, binKey: pt.binKey, deltaD: dd, reason: 'D10_lateralSpikeSkipped' });
        continue;
      }
    }
    current.push(pt);
  }
  if (current.length >= 2) fragments.push(current);

  return {
    laneTrackId,
    options: opts,
    binRecords,
    acceptedFused,
    rejectedBins,
    fragments,
    fragmentSplits,
    spikeRejected,
  };
}

function polylineLengthSd(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].s - points[i - 1].s, points[i].d - points[i - 1].d);
  }
  return len;
}

function modelV2FramesInRange(frames, laneTrackId, sMin, sMax, observations, frameIdToIdx) {
  const obsInRange = mappedObsInRange(observations, laneTrackId, sMin, sMax);
  const obsFrameIds = new Set(obsInRange.map((o) => o.frameId));
  const framesWithLane = [];
  for (const frame of frames) {
    const lane = (frame.lanes || []).find((l) => l.laneTrackId === laneTrackId);
    if (!lane) continue;
    const hasObsInRange = obsFrameIds.has(frame.frameId);
    const hasLanePoints = (lane.points || []).length > 0;
    if (!hasObsInRange && !hasLanePoints) continue;
    framesWithLane.push({
      frameId: frame.frameId,
      elapsedIdx: frameIdToIdx.get(frame.frameId),
      logMonoTime: frame.logMonoTime,
      pointCount: lane.points?.length ?? 0,
      prob: lane.prob,
      hasMappedObsInRange: hasObsInRange,
    });
  }
  return {
    frameCount: framesWithLane.length,
    framesWithLane,
    framesWithMappedObsInRange: [...obsFrameIds],
    observationCount: obsInRange.length,
    distinctFramesInRange: obsFrameIds.size,
  };
}

function sourcePolylineSpanInRange(frames, laneTrackId, sMin, sMax, trajectory) {
  const { projectPointTemporal } = require('./temporal_projection');
  let maxSpan = 0;
  const spanningFrames = [];
  for (const frame of frames) {
    const lane = (frame.lanes || []).find((l) => l.laneTrackId === laneTrackId);
    if (!lane?.points?.length) continue;
    const ss = [];
    for (const pt of lane.points) {
      const proj = projectPointTemporal(trajectory, pt.east, pt.north, frame.logMonoTime, {});
      if (proj.valid && proj.s >= sMin && proj.s <= sMax) ss.push(proj.s);
    }
    if (!ss.length) continue;
    const span = Math.max(...ss) - Math.min(...ss);
    if (span > maxSpan) maxSpan = span;
    if (span >= (sMax - sMin) * 0.5) {
      spanningFrames.push({ frameId: frame.frameId, spanM: span, pointCount: ss.length });
    }
  }
  return { maxSpanM: maxSpan, spanningFrames };
}

function findEndpointFragmentSplit(trace, prevBinKey, nextBinKey) {
  return trace.fragmentSplits.find((s) => s.afterBinKey === prevBinKey && s.beforeBinKey === nextBinKey) || null;
}

function categorizeSpacingPairs(trace, fusedLanes, trackId) {
  const stats = computeAcceptedBinSpacingStats(trace);
  const frags = fusedLanes.filter((f) => f.laneTrackId === trackId);
  const fragGaps = findFusedFragmentGaps(fusedLanes, trackId);
  const fragGapSpacings = new Set(fragGaps.map((g) => Math.round(g.gapM * 10) / 10));

  for (const p of stats.pairs) {
    if (p.retainedInSameFragment) p.category = 'retainedInOneFragment';
    else if (p.splitByMaxGap) p.category = 'splitBy10mRule';
    else if (p.splitReason === 'D10_lateralJumpSplit') p.category = 'incompatibleEndpoints';
    else p.category = 'otherSplit';
    const nearFragGap = [...fragGapSpacings].some((g) => Math.abs(g - p.spacingM) < 1.5);
    if (nearFragGap && p.splitByMaxGap) p.category = 'splitBy10mRule';
  }
  return stats;
}

function mappedObsInRange(observations, laneTrackId, sMin, sMax) {
  return observations.filter((o) => o.laneTrackId === laneTrackId && o.s >= sMin && o.s <= sMax);
}

function sourceGeometrySpanM(frames, laneTrackId, sMin, sMax, observations) {
  const obs = mappedObsInRange(observations, laneTrackId, sMin, sMax);
  if (!obs.length) return 0;
  const ss = obs.map((o) => o.s);
  return Math.max(...ss) - Math.min(...ss);
}

function classifyGapMechanism(gapCtx) {
  const {
    gapM,
    binsInGap,
    acceptedBinsInGap,
    rejectedBinsInGap,
    modelV2FramesInGap,
    mappedObsInGap,
    endpointFragmentSplit,
    spikeRejectedInGap,
    sourcePolylineSpanM,
    consecutiveAcceptedSpacing,
    maxLaneFragmentGapM,
    endpointCompatible,
  } = gapCtx;

  const rejReasons = [...new Set(rejectedBinsInGap.map((b) => b.rejectionReason).filter(Boolean))];
  const distinctFramesInGap = new Set(mappedObsInGap.map((o) => o.frameId)).size;

  if (!mappedObsInGap.length && !modelV2FramesInGap.length) {
    return {
      primary: 'D1',
      mechanism: 'No ModelV2 lane detection in interval',
      firstStage: 'ModelV2 / frame lanes',
      safeToCorrect: false,
      proposedCorrection: 'A — no correction',
      risk: 'fabricating geometry',
    };
  }

  if (mappedObsInGap.length && !binsInGap.length) {
    return {
      primary: 'D5',
      mechanism: 'Mapped observations exist but no candidate fusion bin created',
      firstStage: 'bin key assignment',
      safeToCorrect: false,
      proposedCorrection: 'none',
      risk: 'low',
    };
  }

  if (endpointFragmentSplit?.reason === 'D10_lateralJumpSplit') {
    return {
      primary: 'D10',
      mechanism: `Consecutive accepted bins split by lateral jump (${endpointFragmentSplit.lateralDeltaM?.toFixed(2)} m > threshold)`,
      firstStage: 'fuseLaneTrackSdFragments fragment construction',
      safeToCorrect: false,
      proposedCorrection: 'A — lateral incompatibility must remain open',
      risk: 'crossing or branch if forced',
    };
  }

  if (endpointFragmentSplit?.reason === 'D11_maxLaneFragmentGapM') {
    const intermediateRej = rejectedBinsInGap.length > 0;
    const hasOrphanAccepted = acceptedBinsInGap.length > 0 && spikeRejectedInGap?.length > 0;
    return {
      primary: intermediateRej && !hasOrphanAccepted ? 'D6' : 'D11',
      mechanism: intermediateRej
        ? `maxLaneFragmentGapM=${maxLaneFragmentGapM} split at ${endpointFragmentSplit.gapM?.toFixed(1)} m; intermediate bins rejected (${rejReasons.join(', ')})`
        : `maxLaneFragmentGapM=${maxLaneFragmentGapM} split consecutive accepted bins at ${endpointFragmentSplit.gapM?.toFixed(1)} m`,
      firstStage: intermediateRej && distinctFramesInGap < 2
        ? 'fusion bin acceptance (minObsPerBin)'
        : 'fuseLaneTrackSdFragments fragment construction',
      safeToCorrect: !intermediateRej && endpointCompatible && endpointFragmentSplit.gapM <= 25,
      proposedCorrection: intermediateRej ? 'A — intermediate bins lack support' : 'C — local spacing bound if endpoints compatible',
      risk: intermediateRej ? 'false continuity across rejected bins' : 'low when endpoints compatible',
    };
  }

  if (spikeRejectedInGap?.length && acceptedBinsInGap.length) {
    return {
      primary: 'D10',
      mechanism: 'Accepted bins spike-skipped due to lateral jump; orphan bins cannot form fragments',
      firstStage: 'fuseLaneTrackSdFragments lateral spike filter',
      safeToCorrect: false,
      proposedCorrection: 'A',
      risk: 'lateral incompatibility',
    };
  }

  if (rejectedBinsInGap.length && !acceptedBinsInGap.length) {
    const primary = rejReasons.includes('D7_minFramesPerBin') ? 'D7'
      : rejReasons.includes('D6_minObsPerBin') ? 'D6'
      : rejReasons.includes('D9_lateralSpread') ? 'D9'
      : 'D6';
    return {
      primary,
      mechanism: `All candidate bins in interval rejected: ${rejReasons.join(', ')}`,
      firstStage: 'fusion bin acceptance',
      safeToCorrect: false,
      proposedCorrection: 'B only if trace proves valid temporal support',
      risk: 'false continuity from sparse same-frame points',
    };
  }

  if (sourcePolylineSpanM >= gapM * 0.85 && mappedObsInGap.length > 0) {
    return {
      primary: 'D12',
      mechanism: 'Source lane polyline spans interval but bin-centre representatives are sparse',
      firstStage: 'fuseLaneTrackSdFragments bin-centre output',
      safeToCorrect: true,
      proposedCorrection: 'D — preserve mapped source points between accepted representatives',
      risk: 'low if mapped geometry verified',
    };
  }

  if (acceptedBinsInGap.length && rejectedBinsInGap.length) {
    return {
      primary: rejReasons.includes('D6_minObsPerBin') ? 'D6' : 'D11',
      mechanism: `Partial acceptance: ${acceptedBinsInGap.length} accepted, ${rejectedBinsInGap.length} rejected (${rejReasons.join(', ')})`,
      firstStage: 'fusion bin acceptance',
      safeToCorrect: false,
      proposedCorrection: 'A',
      risk: 'bridging rejected intervals',
    };
  }

  if (consecutiveAcceptedSpacing != null && consecutiveAcceptedSpacing > maxLaneFragmentGapM) {
    return {
      primary: 'D11',
      mechanism: `Accepted-bin spacing ${consecutiveAcceptedSpacing.toFixed(1)} m exceeds maxLaneFragmentGapM=${maxLaneFragmentGapM}`,
      firstStage: 'fuseLaneTrackSdFragments fragment construction',
      safeToCorrect: endpointCompatible === true,
      proposedCorrection: endpointCompatible ? 'C' : 'A',
      risk: endpointCompatible ? 'moderate' : 'high',
    };
  }

  return {
    primary: 'D15',
    mechanism: 'Unclassified — requires manual review',
    firstStage: 'unknown',
    safeToCorrect: false,
    proposedCorrection: 'none',
    risk: 'unknown',
  };
}

function computeAcceptedBinSpacingStats(trace) {
  const accepted = trace.acceptedFused;
  const pairs = [];
  for (let i = 1; i < accepted.length; i++) {
    const ds = accepted[i].s - accepted[i - 1].s;
    const split = trace.fragmentSplits.find((s) => s.beforeBinKey === accepted[i].binKey);
    pairs.push({
      fromBinKey: accepted[i - 1].binKey,
      toBinKey: accepted[i].binKey,
      spacingM: ds,
      retainedInSameFragment: !split,
      splitByMaxGap: split?.reason === 'D11_maxLaneFragmentGapM',
      splitReason: split?.reason ?? null,
    });
  }
  const spacings = pairs.map((p) => p.spacingM).sort((a, b) => a - b);
  const pct = (p) => (spacings.length ? spacings[Math.floor(spacings.length * p)] : null);
  return {
    pairCount: pairs.length,
    min: spacings[0] ?? null,
    median: pct(0.5),
    p75: pct(0.75),
    p90: pct(0.9),
    p95: pct(0.95),
    max: spacings[spacings.length - 1] ?? null,
    pairs,
    retainedCount: pairs.filter((p) => p.retainedInSameFragment).length,
    splitByMaxGapCount: pairs.filter((p) => p.splitByMaxGap).length,
  };
}

function findFusedFragmentGaps(fusedLanes, trackId) {
  const frags = fusedLanes
    .filter((f) => f.laneTrackId === trackId)
    .sort((a, b) => (a.sdPoints?.[0]?.s ?? 0) - (b.sdPoints?.[0]?.s ?? 0));
  const gaps = [];
  for (let i = 1; i < frags.length; i++) {
    const prev = frags[i - 1];
    const next = frags[i];
    const endS = prev.sdPoints?.[prev.sdPoints.length - 1]?.s;
    const startS = next.sdPoints?.[0]?.s;
    if (!Number.isFinite(endS) || !Number.isFinite(startS)) continue;
    const gapM = startS - endS;
    if (gapM > 0) {
      gaps.push({
        precedingFragmentIndex: prev.fragmentIndex,
        followingFragmentIndex: next.fragmentIndex,
        endS,
        startS,
        gapM,
        precedingFragment: prev,
        followingFragment: next,
      });
    }
  }
  return gaps;
}

module.exports = {
  DEFAULT_FUSION_OPTS,
  traceLaneTrackFusion,
  computeAcceptedBinSpacingStats,
  categorizeSpacingPairs,
  findFusedFragmentGaps,
  findEndpointFragmentSplit,
  mappedObsInRange,
  sourceGeometrySpanM,
  sourcePolylineSpanInRange,
  modelV2FramesInRange,
  classifyGapMechanism,
};
