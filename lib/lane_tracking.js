/**
 * Temporal lane tracker v2 — anchors, Hungarian assignment, motion-adaptive thresholds.
 */

const { dist2d } = require('./chunking');
const { hungarianAssign } = require('./hungarian');
const { sampleLaneAnchors, sharedAnchorPairs, anchorLateralStats } = require('./lane_anchors');

const DEFAULT_OPTS = {
  anchorDistancesM: [5, 10, 20, 30],
  maxMatchCost: 15,
  ambiguousRatio: 1.2,
  maxTrackGapFrames: 4,
  maxTimeSec: 4.5,
  maxExpectedFrameIntervalSec: 2.5,
  baseLateralM: 1.2,
  lateralPerMeter: 0.04,
  baseAnchorLatM: 1.5,
  anchorLatPerMeter: 0.05,
  maxHeadingDeg: 30,
  coastingHeadingDegPerMissedFrame: 20,
  minSharedAnchors: 1,
  minOrderDiff: 2,
};

function timeGapSec(a, b) {
  return Math.abs(Number(BigInt(b) - BigInt(a))) / 1e9;
}

function lateralOffsetFromPoints(points, headingDeg) {
  if (!points?.length) return 0;
  let e = 0; let n = 0;
  for (const p of points) { e += p.east; n += p.north; }
  e /= points.length; n /= points.length;
  const rad = (headingDeg ?? 0) * Math.PI / 180;
  return e * Math.cos(rad) - n * Math.sin(rad);
}

function rankLanesByLateral(lanes, headingDeg) {
  return [...lanes]
    .map((lane, idx) => ({
      lane,
      idx,
      lateral: lateralOffsetFromPoints(lane.points, headingDeg),
    }))
    .sort((a, b) => b.lateral - a.lateral)
    .map((r, order) => ({ ...r, order }));
}

function buildLaneFeature(lane, frame, sourceIndex, lateralOrder, options) {
  const heading = frame.pose?.headingDeg ?? 0;
  const anchors = sampleLaneAnchors(lane, frame, options);
  const fwdXs = (lane.points || []).map((p) => p.modelX).filter(Number.isFinite);
  const forwardRange = fwdXs.length
    ? { min: Math.min(...fwdXs), max: Math.max(...fwdXs) }
    : { min: 0, max: 0 };

  return {
    laneIndex: lane.laneIndex,
    sourceIndex,
    lateralOrder,
    meanLateral: lateralOffsetFromPoints(lane.points, heading),
    headingDeg: heading,
    prob: lane.prob ?? 1,
    points: lane.points || [],
    anchors,
    forwardRange,
    logMonoTime: frame.logMonoTime,
    frameId: frame.frameId,
    passId: frame.passId ?? 0,
    chunkId: frame.chunkId ?? 0,
    sessionId: frame.sessionId ?? 0,
    pose: frame.pose,
    gpsAccuracy: frame.pose?.horizontalAccuracy ?? 0,
    laneTrackId: null,
  };
}

function adaptiveThresholds(prevFeature, nextFeature, options) {
  const dt = timeGapSec(prevFeature.logMonoTime, nextFeature.logMonoTime);
  const displacement = prevFeature.pose && nextFeature.pose
    ? dist2d(prevFeature.pose, nextFeature.pose)
    : 0;
  const speed = dt > 0 ? displacement / dt : (nextFeature.pose?.speed ?? 0);
  const poseUncertainty = Math.max(prevFeature.gpsAccuracy ?? 0, nextFeature.gpsAccuracy ?? 0, 0);

  return {
    dt,
    displacement,
    speed,
    poseUncertainty,
    maxLateral: options.baseLateralM + speed * dt * options.lateralPerMeter + poseUncertainty * 0.1,
    maxAnchorLat: options.baseAnchorLatM + displacement * options.anchorLatPerMeter + poseUncertainty * 0.15,
    maxTimeSec: options.maxTimeSec,
  };
}

function computeMatchDetail(prevFeature, nextFeature, trackState, options) {
  const opts = { ...DEFAULT_OPTS, ...options };
  const thr = adaptiveThresholds(prevFeature, nextFeature, opts);
  const detail = {
    prevFrameId: prevFeature.frameId,
    nextFrameId: nextFeature.frameId,
    prevTimestamp: prevFeature.logMonoTime,
    nextTimestamp: nextFeature.logMonoTime,
    timeDiffSec: thr.dt,
    vehicleDisplacementM: thr.displacement,
    vehicleSpeedMps: thr.speed,
    prevLaneCount: null,
    nextLaneCount: null,
    prevLaneIndex: prevFeature.laneIndex,
    nextLaneIndex: nextFeature.laneIndex,
    prevTrackId: trackState?.trackId ?? prevFeature.laneTrackId,
    prevLaneOrder: prevFeature.lateralOrder,
    nextLaneOrder: nextFeature.lateralOrder,
    laneOrderDiff: Math.abs((prevFeature.lateralOrder ?? 0) - (nextFeature.lateralOrder ?? 0)),
    headingDiff: Math.abs(prevFeature.headingDeg - nextFeature.headingDeg),
    poseUncertainty: thr.poseUncertainty,
    sharedAnchorPairs: [],
    sharedAnchorCount: 0,
    curveOverlapLengthM: 0,
    anchorLatMean: null,
    anchorLatMax: null,
    curveRmse: null,
    rejection: null,
    valid: false,
    cost: Infinity,
    threshold: opts.maxMatchCost,
    ambiguityMargin: null,
  };

  if (prevFeature.passId !== nextFeature.passId) {
    detail.rejection = 'differentPass';
    return detail;
  }
  const coastingAllowance = (trackState?.missedFrames ?? 0) * (opts.maxExpectedFrameIntervalSec ?? 2.5);
  const allowedTimeSec = thr.maxTimeSec + coastingAllowance;
  if (thr.dt > allowedTimeSec) {
    detail.rejection = 'excessiveTimeGap';
    detail.allowedTimeSec = allowedTimeSec;
    return detail;
  }

  const hd = detail.headingDiff > 180 ? 360 - detail.headingDiff : detail.headingDiff;
  detail.headingDiff = hd;
  const coastingHeadingAllowance = (trackState?.missedFrames ?? 0) * (opts.coastingHeadingDegPerMissedFrame ?? 20);
  const allowedHeadingDeg = opts.maxHeadingDeg + coastingHeadingAllowance;
  const coastingReacquire = (trackState?.missedFrames ?? 0) > 0;
  if (!coastingReacquire && hd > allowedHeadingDeg) {
    detail.rejection = 'excessiveHeading';
    detail.allowedHeadingDeg = allowedHeadingDeg;
    return detail;
  }

  if (detail.laneOrderDiff >= opts.minOrderDiff) {
    detail.rejection = 'laneOrderReversal';
    return detail;
  }

  const prevAnchors = trackState?.anchors?.length ? trackState.anchors : prevFeature.anchors;
  const pairs = sharedAnchorPairs(prevAnchors, nextFeature.anchors, 5);
  detail.sharedAnchorPairs = pairs.map((p) => ({
    forwardM: p.forwardM,
    prevModelY: p.prev.modelY,
    nextModelY: p.next.modelY,
  }));
  detail.sharedAnchorCount = pairs.length;

  const overlapMin = Math.max(prevFeature.forwardRange.min, nextFeature.forwardRange.min);
  const overlapMax = Math.min(prevFeature.forwardRange.max, nextFeature.forwardRange.max);
  detail.curveOverlapLengthM = Math.max(0, overlapMax - overlapMin);

  if (pairs.length < opts.minSharedAnchors) {
    detail.rejection = 'insufficientAnchorOverlap';
    return detail;
  }

  const latStats = anchorLateralStats(pairs, prevFeature.headingDeg, nextFeature.headingDeg);
  detail.anchorLatMean = latStats.meanLatDiff;
  detail.anchorLatMax = latStats.maxLatDiff;

  if (latStats.maxLatDiff > thr.maxAnchorLat) {
    detail.rejection = 'excessiveLateralDisplacement';
    return detail;
  }

  const orderPenalty = detail.laneOrderDiff * 2;
  const confPenalty = (2 - (prevFeature.prob ?? 1) - (nextFeature.prob ?? 1)) * 1.5;
  const uncertaintyPenalty = thr.poseUncertainty * 0.05;
  const cost = latStats.meanLatDiff * 2 + latStats.maxLatDiff * 0.5
    + orderPenalty + thr.dt * 0.1 + confPenalty + uncertaintyPenalty;

  detail.cost = cost;
  detail.valid = cost < opts.maxMatchCost;
  if (!detail.valid) detail.rejection = 'costAboveThreshold';
  return detail;
}

function predictTrackState(track, nextFrame, options) {
  const dt = timeGapSec(track.lastLogMonoTime, nextFrame.logMonoTime);
  const displacement = track.lastPose && nextFrame.pose
    ? dist2d(track.lastPose, nextFrame.pose) : 0;
  return {
    ...track,
    predictedDisplacementM: displacement,
    predictedDtSec: dt,
    uncertainty: track.uncertainty + displacement * 0.02 + dt * 0.1,
    anchors: track.anchors,
    lateralOrder: track.laneOrder,
    headingDeg: track.headingDeg,
    nextHeadingDeg: nextFrame.pose?.headingDeg ?? track.headingDeg,
    meanLateral: track.meanLateral,
    forwardRange: track.forwardRange,
    logMonoTime: track.lastLogMonoTime,
    frameId: track.lastFrameId,
    laneIndex: track.lastLaneIndex,
    prob: track.confidence,
    passId: track.passId,
  };
}

function summarizeTracks(tracks, frames) {
  const list = [...tracks.values()];
  const frameCounts = list.map((t) => t.frameIds.length);
  const oneFrame = frameCounts.filter((n) => n === 1).length;
  const twoFrame = frameCounts.filter((n) => n === 2).length;
  const threePlus = frameCounts.filter((n) => n >= 3).length;
  const durations = list.map((t) => {
    if (t.frameIds.length < 2) return 0;
    const f0 = frames.find((f) => f.frameId === t.frameIds[0]);
    const f1 = frames.find((f) => f.frameId === t.frameIds[t.frameIds.length - 1]);
    return f0 && f1 ? timeGapSec(f0.logMonoTime, f1.logMonoTime) : 0;
  }).filter((d) => d > 0);

  const sorted = [...frameCounts].sort((a, b) => a - b);
  const medianFrames = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

  const totalObs = frames.reduce((n, f) => n + (f.lanes?.length ?? 0), 0);
  const continuedObs = list.reduce((n, t) => n + Math.max(0, t.frameIds.length - 1), 0);

  return {
    trackCount: list.length,
    createdTracks: list.length,
    oneFrameTracks: oneFrame,
    twoFrameTracks: twoFrame,
    threePlusFrameTracks: threePlus,
    medianTrackDurationFrames: medianFrames,
    maxTrackDurationFrames: frameCounts.length ? Math.max(...frameCounts) : 0,
    medianTrackDurationSec: durations.length
      ? durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)] : 0,
    maxTrackDurationSec: durations.length ? Math.max(...durations) : 0,
    medianCoveredDistanceM: list.length
      ? list.map((t) => t.coveredDistanceM ?? 0).sort((a, b) => a - b)[Math.floor(list.length / 2)] : 0,
    maxCoveredDistanceM: list.length ? Math.max(...list.map((t) => t.coveredDistanceM ?? 0)) : 0,
    fragmentationRate: list.length > 0 ? oneFrame / list.length : 0,
    observationAssociationPct: totalObs > 0 ? (continuedObs / totalObs) * 100 : 0,
    tracks: list.map((t) => ({
      trackId: t.trackId,
      frameIds: t.frameIds,
      frameCount: t.frameIds.length,
      laneOrder: t.laneOrder,
      coveredDistanceM: t.coveredDistanceM,
      confidence: t.confidence,
      missedFrames: t.missedFrames,
    })),
  };
}

function trackLanesInPass(frames, options = {}) {
  const opts = { ...DEFAULT_OPTS, ...options };
  const tracks = new Map();
  let nextTrackId = 0;
  const activeTracks = new Map();
  const framePairAudits = [];
  const matchDecisions = [];
  let continuedMatches = 0;
  let rejectedMatches = 0;
  let ambiguousMatches = 0;
  let terminatedTracks = 0;
  const matchCosts = [];
  let greedyDiffCount = 0;

  if (!frames.length) {
    return {
      frames,
      tracks: [],
      diagnostics: { framesProcessed: 0 },
      framePairAudits: [],
      matchDecisions: [],
    };
  }

  const annotateFrame = (frame, featureMap) => {
    const lanes = (frame.lanes || []).map((lane, idx) => {
      const feat = featureMap.get(idx);
      return feat ? { ...lane, laneTrackId: feat.laneTrackId, anchors: feat.anchors } : lane;
    });
    return { ...frame, lanes };
  };

  let annotatedFrames = [];
  let prevFeatures = null;

  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi];
    const heading = frame.pose?.headingDeg ?? 0;
    const ranked = rankLanesByLateral(frame.lanes || [], heading);
    const nextFeatures = ranked.map((r) => buildLaneFeature(r.lane, frame, r.idx, r.order, opts));
    const featureByIdx = new Map(nextFeatures.map((f) => [f.sourceIndex, f]));

    if (!prevFeatures?.length && !nextFeatures.length) {
      for (const track of activeTracks.values()) {
        track.missedFrames = (track.missedFrames ?? 0) + 1;
        if (track.missedFrames > opts.maxTrackGapFrames) {
          activeTracks.delete(track.trackId);
          terminatedTracks++;
        }
      }
      annotatedFrames.push(annotateFrame(frame, featureByIdx));
      continue;
    }

    if (!prevFeatures?.length && nextFeatures.length && activeTracks.size === 0) {
      for (const feat of nextFeatures) {
        const tid = nextTrackId++;
        feat.laneTrackId = tid;
        const tr = {
          trackId: tid,
          passId: feat.passId,
          laneOrder: feat.lateralOrder,
          lastFrameId: feat.frameId,
          lastLogMonoTime: feat.logMonoTime,
          lastLaneIndex: feat.laneIndex,
          lastPose: feat.pose,
          anchors: feat.anchors,
          forwardRange: feat.forwardRange,
          meanLateral: feat.meanLateral,
          headingDeg: feat.headingDeg,
          confidence: feat.prob,
          frameIds: [feat.frameId],
          missedFrames: 0,
          uncertainty: feat.gpsAccuracy ?? 0,
          coveredDistanceM: 0,
        };
        tracks.set(tid, tr);
        activeTracks.set(tid, tr);
      }
      annotatedFrames.push(annotateFrame(frame, featureByIdx));
      prevFeatures = nextFeatures;
      continue;
    }

    const activeList = [...activeTracks.values()];
    const nNext = nextFeatures.length;
    const nActive = activeList.length;
    const costMatrix = [];
    const detailMatrix = [];

    for (let i = 0; i < nNext; i++) {
      const row = [];
      const drow = [];
      for (let j = 0; j < nActive; j++) {
        const predicted = predictTrackState(activeList[j], frame, opts);
        const d = computeMatchDetail(predicted, nextFeatures[i], activeList[j], opts);
        row.push(d.valid ? d.cost : Infinity);
        drow.push(d);
      }
      costMatrix.push(row);
      detailMatrix.push(drow);
    }

    const { assignments } = hungarianAssign(costMatrix, opts.maxMatchCost);

    const pairAudit = {
      prevFrameId: prevFeatures[0]?.frameId,
      nextFrameId: frame.frameId,
      prevTimestamp: prevFeatures[0]?.logMonoTime,
      nextTimestamp: frame.logMonoTime,
      prevLaneCount: prevFeatures.length,
      nextLaneCount: nextFeatures.length,
      costMatrix: costMatrix.map((r) => r.map((c) => (Number.isFinite(c) ? Math.round(c * 1000) / 1000 : null))),
      candidates: [],
      assignments: [],
      rejections: [],
      threshold: opts.maxMatchCost,
    };

    for (let i = 0; i < nNext; i++) {
      for (let j = 0; j < nActive; j++) {
        const d = detailMatrix[i][j];
        pairAudit.candidates.push({
          nextIdx: i,
          trackIdx: j,
          trackId: activeList[j].trackId,
          valid: d.valid,
          cost: Number.isFinite(d.cost) ? d.cost : null,
          rejection: d.rejection,
          sharedAnchors: d.sharedAnchorCount,
          anchorLatMean: d.anchorLatMean,
        });
        if (!d.valid && d.rejection) pairAudit.rejections.push({ nextIdx: i, trackId: activeList[j].trackId, reason: d.rejection });
      }
    }

    const assignedTracks = new Set();
    const ambiguous = new Set();

    for (let i = 0; i < nNext; i++) {
      const validCosts = costMatrix[i].filter((c) => c < opts.maxMatchCost).sort((a, b) => a - b);
      if (validCosts.length >= 2 && validCosts[1] / validCosts[0] < opts.ambiguousRatio) {
        ambiguous.add(i);
      }
    }

    for (let i = 0; i < nNext; i++) {
      const match = assignments.get(i);
      const feat = nextFeatures[i];

      if (match && !ambiguous.has(i)) {
        const track = activeList[match.colIdx];
        const d = detailMatrix[i][match.colIdx];
        feat.laneTrackId = track.trackId;
        continuedMatches++;
        matchCosts.push(d.cost);

        const stepDist = track.lastPose && feat.pose ? dist2d(track.lastPose, feat.pose) : 0;
        track.lastFrameId = feat.frameId;
        track.lastLogMonoTime = feat.logMonoTime;
        track.lastLaneIndex = feat.laneIndex;
        track.lastPose = feat.pose;
        track.anchors = feat.anchors;
        track.forwardRange = feat.forwardRange;
        track.meanLateral = feat.meanLateral;
        track.headingDeg = feat.headingDeg;
        track.confidence = (track.confidence + feat.prob) / 2;
        track.frameIds.push(feat.frameId);
        track.missedFrames = 0;
        track.coveredDistanceM = (track.coveredDistanceM ?? 0) + stepDist;
        track.uncertainty = Math.max(0, (track.uncertainty ?? 0) * 0.8 + (feat.gpsAccuracy ?? 0) * 0.2);

        pairAudit.assignments.push({
          nextIdx: i,
          trackId: track.trackId,
          cost: d.cost,
          prevTrackId: track.trackId,
          resultingTrackId: track.trackId,
          sharedAnchors: d.sharedAnchorCount,
          laneOrderDiff: d.laneOrderDiff,
        });
        matchDecisions.push({ ...d, assigned: true, resultingTrackId: track.trackId });
        assignedTracks.add(track.trackId);
      } else {
        if (match && ambiguous.has(i)) {
          ambiguousMatches++;
          rejectedMatches++;
          matchDecisions.push({ ...detailMatrix[i][match.colIdx], assigned: false, rejection: 'ambiguous' });
        }
        const tid = nextTrackId++;
        feat.laneTrackId = tid;
        const tr = {
          trackId: tid,
          passId: feat.passId,
          laneOrder: feat.lateralOrder,
          lastFrameId: feat.frameId,
          lastLogMonoTime: feat.logMonoTime,
          lastLaneIndex: feat.laneIndex,
          lastPose: feat.pose,
          anchors: feat.anchors,
          forwardRange: feat.forwardRange,
          meanLateral: feat.meanLateral,
          headingDeg: feat.headingDeg,
          confidence: feat.prob,
          frameIds: [feat.frameId],
          missedFrames: 0,
          uncertainty: feat.gpsAccuracy ?? 0,
          coveredDistanceM: 0,
        };
        tracks.set(tid, tr);
        activeTracks.set(tid, tr);
        pairAudit.assignments.push({
          nextIdx: i,
          trackId: tid,
          cost: null,
          prevTrackId: null,
          resultingTrackId: tid,
          newTrack: true,
        });
      }
    }

    for (const track of activeList) {
      if (!assignedTracks.has(track.trackId)) {
        track.missedFrames = (track.missedFrames ?? 0) + 1;
        if (track.missedFrames > opts.maxTrackGapFrames) {
          activeTracks.delete(track.trackId);
          terminatedTracks++;
        }
      }
    }

    framePairAudits.push(pairAudit);
    annotatedFrames.push(annotateFrame(frame, featureByIdx));
    prevFeatures = nextFeatures;
  }

  const summary = summarizeTracks(tracks, frames);
  const diagnostics = {
    framesProcessed: frames.length,
    totalObservations: frames.reduce((n, f) => n + (f.lanes?.length ?? 0), 0),
    createdTracks: tracks.size,
    continuedTracks: continuedMatches,
    terminatedTracks,
    rejectedMatches,
    ambiguousMatches,
    meanMatchCost: matchCosts.length ? matchCosts.reduce((a, b) => a + b, 0) / matchCosts.length : 0,
    maxMatchCost: matchCosts.length ? Math.max(...matchCosts) : 0,
    greedyDiffCount,
    crossLaneWarnings: matchDecisions.filter((d) => d.laneOrderDiff >= 2).length,
    ...summary,
  };

  return {
    frames: annotatedFrames,
    tracks: [...tracks.values()],
    diagnostics,
    framePairAudits,
    matchDecisions,
  };
}

function trackLanesAndEdgesInPass(frames, options = {}) {
  if (options.laneTrackingEnabled === false) {
    return {
      frames,
      tracks: [],
      laneDiagnostics: { disabled: true },
      edgeDiagnostics: { disabled: true },
      summary: { disabled: true },
      framePairAudits: [],
    };
  }
  const laneResult = trackLanesInPass(frames, options);
  return {
    frames: laneResult.frames,
    tracks: laneResult.tracks,
    laneDiagnostics: laneResult.diagnostics,
    edgeDiagnostics: { skipped: true },
    summary: {
      ...laneResult.diagnostics,
      trackCount: laneResult.diagnostics.trackCount,
    },
    framePairAudits: laneResult.framePairAudits,
    matchDecisions: laneResult.matchDecisions,
  };
}

module.exports = {
  trackLanesInPass,
  trackLanesAndEdgesInPass,
  trackFeaturesInPass: trackLanesInPass,
  computeMatchDetail,
  buildLaneFeature,
  adaptiveThresholds,
  DEFAULT_OPTS,
  summarizeTracks,
};
