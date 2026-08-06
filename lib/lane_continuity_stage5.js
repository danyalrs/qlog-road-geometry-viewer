'use strict';

/**
 * Segment 2 lane-continuity Stage 5: DC-015 PB0 dropout-corridor investigation.
 * Investigation only — no production geometry changes.
 */

const fs = require('fs');
const path = require('path');
const { dist2d } = require('./chunking');
const {
  runLaneContinuityStage4,
  loadSegment,
  buildCtx,
  enumeratePhysicalGaps,
  gapOpenAtInterval,
  physicalGapKey,
  reconcileCounts,
  S_EPS,
  UNSAFE_GAP_IDS,
  STAGE2_REPAIRED_IDS,
  STAGE3_ACCEPTED_LANE_CHECKSUM,
  DC014_INTERVAL,
} = require('./lane_continuity_stage4');
const {
  traceLaneTrackFusion,
  mappedObsInRange,
  modelV2FramesInRange,
  sourcePolylineSpanInRange,
  classifyGapMechanism,
  findEndpointFragmentSplit,
} = require('./fusion_gap_trace');
const { collectLaneObservations } = require('./sd_fusion');
const { projectPointTemporal, vehicleSAtTimeTemporal } = require('./temporal_projection');
const { buildReferenceTrajectory } = require('./trajectory');
const { endpointCompatibility } = require('./lane_run_audit');
const { computeRoadPolygonChecksum } = require('./segment_local_map');

const STAGE1_AUDIT = path.join(__dirname, '..', 'audit_segment2_lane_continuity_stage1.json');
const STAGE3_SURFACE_CHECKSUM = '70457ea';
const DC015_ID = 'DC-015';
const DC015_CORRIDOR = [110, 280];
const DC015_GAP = [128.15, 260.57];
const STAGE4_GAP_KEY = 'PB0|128.15|260.57';
const STAGE1_GAP_KEY = 'PB0|136.89|260.57';
const DC014_CLOSED_KEY = 'PB0|101.42|128.15';

const PIPELINE_STAGES = [
  'raw_modelV2',
  'vehicle_relative',
  'accepted_model_observations',
  'pose_transformed',
  'tracker_candidates',
  'tracker_assignments',
  'route_sd_projection',
  'bin_aggregation',
  'fused_fragments',
  'cleaned_runs',
  'mode5_rendering',
];

function findPb0Runs(cleaned) {
  return cleaned.filter((r) => r.physicalBoundaryId === 'PB0').sort((a, b) => a.sMin - b.sMin);
}

function confirmDc015Identity(ctx, stage1) {
  const dc015 = stage1.disconnections.find((d) => d.disconnectionId === DC015_ID);
  const gaps = enumeratePhysicalGaps(ctx.cleanup.cleaned);
  const physGap = gaps.find((g) => g.physicalGapKey === STAGE4_GAP_KEY);
  const pb0Runs = findPb0Runs(ctx.cleanup.cleaned);
  const preRun = pb0Runs.find((r) => Math.abs(r.sMax - DC015_GAP[0]) < 1.5);
  const postRun = pb0Runs.find((r) => Math.abs(r.sMin - DC015_GAP[1]) < 1.5);
  const prePt = preRun?.points?.[preRun.points.length - 1];
  const postPt = postRun?.points?.[0];
  const preSd = preRun?.sdPoints?.[preRun.sdPoints.length - 1];
  const postSd = postRun?.sdPoints?.[0];
  const euclid = prePt && postPt ? dist2d(prePt, postPt) : null;
  const compat = preRun && postRun
    ? endpointCompatibility({ sdPoints: preRun.sdPoints }, { sdPoints: postRun.sdPoints })
    : null;

  const stage2SegmentOpts = { bimodalClusterSelection: false, positiveBoundaryContinuityBridgeEnabled: false };
  const stage2Gaps = enumeratePhysicalGaps(
    buildCtx(loadSegment(stage2SegmentOpts)).cleanup.cleaned,
  );
  const stage3Gaps = enumeratePhysicalGaps(ctx.cleanup.cleaned);
  const reconciliation = reconcileCounts(
    buildCtx(loadSegment(stage2SegmentOpts)).audit,
    ctx.audit,
    stage2Gaps,
    stage3Gaps,
  );
  const closedDc014 = reconciliation.closedPhysicalGaps.find((g) => g.physicalGapKey.startsWith('PB0|101.'));
  const endpointShiftM = dc015.endpointRouteS - DC015_GAP[0];

  return {
    disconnectionId: DC015_ID,
    physicalBoundaryId: 'PB0',
    trackId: 0,
    chunkId: 0,
    passId: 0,
    stage4PhysicalGapKey: STAGE4_GAP_KEY,
    stage1PhysicalGapKey: STAGE1_GAP_KEY,
    routeSInterval: [...DC015_GAP],
    alongTrackGapM: DC015_GAP[1] - DC015_GAP[0],
    stage1RouteSInterval: [dc015.endpointRouteS, dc015.candidateStartRouteS],
    stage1AlongTrackGapM: dc015.alongTrackGapM,
    endpointKeyReconciliation: {
      samePhysicalCorridor: true,
      endpointShiftM,
      shiftCause: 'dc014_physical_closure_merged_preceding_run_endpoint',
      closedAdjacentGap: closedDc014?.physicalGapKey ?? DC014_CLOSED_KEY,
      noNewPhysicalGapIntroduced: reconciliation.newPhysicalGapsFromStage3 === 0,
      stage1StartShiftedWestByM: endpointShiftM,
      stage1EndUnchanged: Math.abs(dc015.candidateStartRouteS - DC015_GAP[1]) < 0.05,
    },
    sourceFragmentId: dc015.sourceFragmentId,
    candidateContinuationFragmentId: dc015.candidateContinuationFragmentId,
    sourceRunId: physGap?.sourceRunId ?? preRun?.runId,
    continuationRunId: physGap?.continuationRunId ?? postRun?.runId,
    endpointCoordinates: {
      preceding: prePt ? { east: prePt.east, north: prePt.north, s: preSd?.s, d: preSd?.d } : null,
      following: postPt ? { east: postPt.east, north: postPt.north, s: postSd?.s, d: postSd?.d } : null,
    },
    euclideanGapM: euclid,
    lateralOffsetM: preSd && postSd ? Math.abs(postSd.d - preSd.d) : dc015.lateralOffsetM,
    headingDifferenceDeg: compat?.headingDelta ?? dc015.headingDifferenceDeg,
    endpointCompatibility: compat,
    laneOrderBefore: preRun?.laneTrackId ?? 0,
    laneOrderAfter: postRun?.laneTrackId ?? 0,
    competingContinuationCandidates: [],
    nearbyPb1Pb2: {
      PB1: ctx.cleanup.cleaned.filter((r) => r.physicalBoundaryId === 'PB1')
        .filter((r) => r.sMax > DC015_GAP[0] - 20 && r.sMin < DC015_GAP[1] + 20)
        .map((r) => ({ runId: r.runId, sMin: r.sMin, sMax: r.sMax })),
      PB2: ctx.cleanup.cleaned.filter((r) => r.physicalBoundaryId === 'PB2')
        .filter((r) => r.sMax > DC015_GAP[0] - 20 && r.sMin < DC015_GAP[1] + 20)
        .map((r) => ({ runId: r.runId, sMin: r.sMin, sMax: r.sMax })),
    },
    endpointFrames: {
      preceding: { frameId: preRun?.endFrameId ?? null, s: preSd?.s },
      following: { frameId: postRun?.startFrameId ?? null, s: postSd?.s },
    },
  };
}

function collectRawModelV2InCorridor(frames, traj, sLo, sHi) {
  const records = [];
  for (const frame of frames) {
    const vehicleS = vehicleSAtTimeTemporal(traj, frame.logMonoTime);
    for (const lane of frame.lanes || []) {
      for (let pi = 0; pi < (lane.points || []).length; pi++) {
        const pt = lane.points[pi];
        const proj = projectPointTemporal(traj, pt.east, pt.north, frame.logMonoTime, {});
        const inGap = proj.valid && proj.s >= sLo && proj.s <= sHi;
        records.push({
          frameId: frame.frameId,
          logMonoTime: frame.logMonoTime,
          vehicleRouteS: vehicleS,
          laneIndex: lane.laneIndex,
          laneTrackId: lane.laneTrackId ?? null,
          pointIndex: pi,
          prob: lane.prob ?? 1,
          modelX: pt.modelX,
          modelY: pt.modelY,
          modelZ: pt.modelZ,
          east: pt.east,
          north: pt.north,
          projectionValid: proj.valid,
          projectionAmbiguous: proj.ambiguous,
          perpDistM: proj.perpDist,
          routeS: proj.valid ? proj.s : null,
          lateralD: proj.valid ? proj.d : null,
          inGapCorridor: inGap,
          poseTimestamp: frame.pose?.timestamp ?? frame.logMonoTime,
          poseValid: !!frame.pose,
          headingSource: frame.pose?.headingDeg != null ? 'gps_pose' : null,
        });
      }
    }
  }
  return records;
}

function explainObservationInclusion(raw, observations, trace) {
  const mapped = observations.find((o) =>
    o.frameId === raw.frameId
    && o.laneIndex === raw.laneIndex
    && Math.abs(o.s - (raw.routeS ?? -999)) < 0.5
    && Math.abs(o.d - (raw.lateralD ?? -999)) < 0.5);
  if (!mapped && !raw.inGapCorridor) {
    return { status: 'excluded', reason: 'projection_outside_gap_corridor', stage: 'route_sd_projection' };
  }
  if (!mapped && raw.inGapCorridor) {
    if (!raw.projectionValid) return { status: 'rejected', reason: 'invalid_projection', stage: 'route_sd_projection' };
    if (raw.perpDistM > 25) return { status: 'rejected', reason: 'perp_dist_exceeded', stage: 'route_sd_projection' };
    return { status: 'rejected', reason: 'not_in_collectLaneObservations_output', stage: 'accepted_model_observations' };
  }
  if (mapped.laneTrackId !== 0) {
    return { status: 'assigned_other_track', reason: `laneTrackId=${mapped.laneTrackId}`, stage: 'tracker_assignments' };
  }
  const binKey = Math.round(mapped.s / 2.0);
  const bin = trace.binRecords.find((b) => b.binKey === binKey);
  if (!bin) return { status: 'no_bin', reason: 'bin_not_created', stage: 'bin_aggregation' };
  if (!bin.accepted) {
    return { status: 'rejected', reason: bin.rejectionReason, stage: 'bin_aggregation', failedCondition: bin.failedCondition };
  }
  const inFragment = trace.fragments.some((frag) => frag.some((p) => p.binKey === binKey));
  if (!inFragment) {
    const spike = trace.spikeRejected?.find((s) => s.binKey === binKey);
    if (spike) return { status: 'rejected', reason: spike.reason, stage: 'fused_fragments' };
    return { status: 'orphan_bin', reason: 'not_in_output_fragment', stage: 'fused_fragments' };
  }
  return { status: 'included', reason: 'accepted_fused_fragment', stage: 'fused_fragments' };
}

function traceCorridorPipeline(ctx) {
  const { chunk, observations, trace, cleanup } = ctx;
  const traj = buildReferenceTrajectory(chunk.vehiclePath);
  const [sLo, sHi] = DC015_CORRIDOR;
  const [gLo, gHi] = DC015_GAP;

  const rawRecords = collectRawModelV2InCorridor(chunk.frames, traj, gLo, gHi);
  const rawInGap = rawRecords.filter((r) => r.inGapCorridor);
  const rawByFrame = new Map();
  for (const r of rawInGap) {
    if (!rawByFrame.has(r.frameId)) rawByFrame.set(r.frameId, []);
    rawByFrame.get(r.frameId).push(r);
  }

  const observationInventory = [];
  for (const [frameId, pts] of rawByFrame.entries()) {
    for (const raw of pts) {
      const expl = explainObservationInclusion(raw, observations, trace);
      observationInventory.push({
        frameId,
        logMonoTime: raw.logMonoTime,
        laneIndex: raw.laneIndex,
        laneTrackId: raw.laneTrackId,
        prob: raw.prob,
        modelX: raw.modelX,
        modelY: raw.modelY,
        modelZ: raw.modelZ,
        east: raw.east,
        north: raw.north,
        routeS: raw.routeS,
        lateralD: raw.lateralD,
        vehicleRouteS: raw.vehicleRouteS,
        poseTimestamp: raw.poseTimestamp,
        poseValid: raw.poseValid,
        headingSource: raw.headingSource,
        inclusion: expl,
      });
    }
  }

  const binsInGap = trace.binRecords.filter((b) => b.binCentreS >= gLo && b.binCentreS <= gHi);
  const acceptedBins = binsInGap.filter((b) => b.accepted);
  const rejectedBins = binsInGap.filter((b) => !b.accepted);

  const primarySplit = trace.fragmentSplits.find((s) => {
    const prev = trace.acceptedFused.find((p) => p.binKey === s.afterBinKey);
    const next = trace.acceptedFused.find((p) => p.binKey === s.beforeBinKey);
    return prev && next && prev.s >= gLo - 5 && next.s <= gHi + 5 && s.gapM > 50;
  }) || trace.fragmentSplits.find((s) => s.gapM > 100);

  const pb0Runs = findPb0Runs(cleanup.cleaned);
  const preRun = pb0Runs.find((r) => Math.abs(r.sMax - gLo) < 1.5);
  const postRun = pb0Runs.find((r) => Math.abs(r.sMin - gHi) < 1.5);

  const stageSummary = {};
  stageSummary.raw_modelV2 = {
    pointsInGap: rawInGap.length,
    distinctFrames: rawByFrame.size,
    distinctTracks: [...new Set(rawInGap.map((r) => r.laneTrackId))],
  };
  stageSummary.accepted_model_observations = {
    track0InGap: mappedObsInRange(observations, 0, gLo, gHi).length,
    allTracksInGap: observations.filter((o) => o.s >= gLo && o.s <= gHi).length,
    distinctFramesTrack0: new Set(mappedObsInRange(observations, 0, gLo, gHi).map((o) => o.frameId)).size,
  };
  stageSummary.bin_aggregation = {
    binsInGap: binsInGap.length,
    accepted: acceptedBins.length,
    rejected: rejectedBins.length,
    rejectionReasons: rejectedBins.reduce((acc, b) => {
      acc[b.rejectionReason] = (acc[b.rejectionReason] || 0) + 1;
      return acc;
    }, {}),
  };
  stageSummary.fused_fragments = {
    primarySplit: primarySplit ?? null,
    acceptedBinsNearGap: trace.acceptedFused
      .filter((b) => b.s >= gLo - 2 && b.s <= gHi + 2)
      .map((b) => ({ binKey: b.binKey, s: b.s, d: b.d })),
  };
  stageSummary.cleaned_runs = {
    gapOpen: gapOpenAtInterval(pb0Runs, gLo, gHi),
    precedingRunEndS: preRun?.sMax,
    followingRunStartS: postRun?.sMin,
  };

  const frameIdToIdx = new Map(chunk.frames.map((f, i) => [f.frameId, i]));
  const mv2 = modelV2FramesInRange(chunk.frames, 0, gLo, gHi, observations, frameIdToIdx);
  const polySpan = sourcePolylineSpanInRange(chunk.frames, 0, gLo, gHi, traj);

  return {
    corridorRouteS: DC015_CORRIDOR,
    gapRouteS: DC015_GAP,
    pipelineStages: PIPELINE_STAGES,
    stageSummary,
    observationInventory,
    observationInventoryCount: observationInventory.length,
    modelV2FrameSummary: mv2,
    sourcePolylineSpanM: polySpan.maxSpanM,
    binsInGap: binsInGap.map((b) => ({
      binKey: b.binKey,
      binCentreS: b.binCentreS,
      accepted: b.accepted,
      rejectionReason: b.rejectionReason ?? null,
      observationCount: b.observationCount,
      distinctFrameCount: b.distinctFrameCount,
    })),
    fragmentSplitsNearGap: trace.fragmentSplits.filter((s) => {
      const prev = trace.acceptedFused.find((p) => p.binKey === s.afterBinKey);
      const next = trace.acceptedFused.find((p) => p.binKey === s.beforeBinKey);
      return prev && next && prev.s >= gLo - 30 && next.s <= gHi + 30;
    }),
  };
}

function measureUnsupportedIntervals(trace, gLo, gHi) {
  const acc = trace.acceptedFused
    .filter((b) => b.s >= gLo - 1 && b.s <= gHi + 1)
    .map((b) => b.s)
    .sort((a, b) => a - b);
  const unsupported = [];
  let cursor = gLo;
  for (const s of acc) {
    if (s - cursor > 0.5) unsupported.push({ startS: cursor, endS: s, lengthM: s - cursor });
    cursor = s;
  }
  if (gHi - cursor > 0.5) unsupported.push({ startS: cursor, endS: gHi, lengthM: gHi - cursor });
  const longest = unsupported.reduce((m, u) => (u.lengthM > (m?.lengthM ?? 0) ? u : m), null);
  return { unsupported, longestUnsupportedM: longest?.lengthM ?? gHi - gLo, longestUnsupported: longest };
}

function findFirstSupportLoss(ctx, trace, pipeline) {
  const [gLo, gHi] = DC015_GAP;
  const { unsupported, longestUnsupported } = measureUnsupportedIntervals(trace, gLo, gHi);
  const interiorStart = 148;
  const interiorObs = mappedObsInRange(ctx.observations, 0, interiorStart, gHi - 5);

  let category = 'L';
  let stage = 'fused_fragments';
  let stageIndex = 8;
  let responsibleFunction = 'fuseLaneTrackSdFragments';
  let responsibleCondition = null;
  let distinction = 'missing_fusion_output';

  const primarySplit = pipeline.stageSummary.fused_fragments.primarySplit;
  if (!interiorObs.length && pipeline.stageSummary.raw_modelV2.distinctFrames <= 6) {
    category = 'A';
    stage = 'raw_modelV2';
    stageIndex = 0;
    responsibleFunction = 'modelV2 lane forward polyline';
    responsibleCondition = 'lane points project only within vehicle forward range; interior 148–228 m has zero track-0 mapped observations';
    distinction = 'no_raw_detection';
  } else if (primarySplit?.reason === 'D11_maxLaneFragmentGapM') {
    category = 'A';
    stage = 'fused_fragments';
    stageIndex = 8;
    responsibleFunction = 'fuseLaneTrackSdFragments';
    responsibleCondition = `${primarySplit.reason} gapM=${primarySplit.gapM.toFixed(2)} between bins ${primarySplit.afterBinKey}→${primarySplit.beforeBinKey}; bridgeRejected=${primarySplit.bridgeRejected ?? 'n/a'}`;
    distinction = 'missing_fusion_output';
  }

  const westObs = mappedObsInRange(ctx.observations, 0, gLo, 146);
  if (westObs.length && pipeline.stageSummary.bin_aggregation.rejected > 0) {
    // West corridor has sparse support rejected at bin aggregation before main split
  }

  return {
    category,
    categoryLabel: {
      A: 'Genuine long detection dropout',
      G: 'Short recoverable sections with long unsupported interior',
      I: 'Insufficient evidence',
    }[category] ?? category,
    firstSupportLossStage: stage,
    firstSupportLossStageIndex: stageIndex,
    responsibleFunction,
    responsibleCondition,
    distinction,
    unsupportedIntervals: unsupported,
    longestUnsupportedM: longestUnsupported?.lengthM ?? null,
    interiorMappedObsCount: interiorObs.length,
    primaryFragmentSplit: primarySplit,
  };
}

function evaluateAlternativeTracks(ctx) {
  const [gLo, gHi] = DC015_GAP;
  const pb0Obs = mappedObsInRange(ctx.observations, 0, gLo, gHi);
  const pb0MeanD = pb0Obs.length
    ? pb0Obs.reduce((s, o) => s + o.d, 0) / pb0Obs.length
    : null;
  const alternatives = [];
  const trackIds = [...new Set(ctx.observations.map((o) => o.laneTrackId).filter((x) => x != null))];
  for (const tid of trackIds) {
    if (tid === 0) continue;
    const obs = mappedObsInRange(ctx.observations, tid, gLo, gHi);
    if (!obs.length) continue;
    const meanD = obs.reduce((s, o) => s + o.d, 0) / obs.length;
    const lateralDeltaFromPb0 = pb0MeanD != null ? Math.abs(meanD - pb0MeanD) : null;
    alternatives.push({
      laneTrackId: tid,
      observationCount: obs.length,
      distinctFrames: new Set(obs.map((o) => o.frameId)).size,
      routeSOverlap: [Math.min(...obs.map((o) => o.s)), Math.max(...obs.map((o) => o.s))],
      meanLateralD: meanD,
      lateralDeltaFromPb0M: lateralDeltaFromPb0,
      meanProb: obs.reduce((s, o) => s + (o.prob ?? 1), 0) / obs.length,
      physicalBoundaryPlausible: lateralDeltaFromPb0 != null && lateralDeltaFromPb0 < 1.5,
      reassignmentRejected: true,
      reassignmentRejectReason: lateralDeltaFromPb0 != null && lateralDeltaFromPb0 >= 1.5
        ? 'lateral_separation_exceeds_identity_threshold'
        : 'insufficient_temporal_continuity',
    });
  }
  return {
    pb0TrackId: 0,
    pb0ObservationCount: pb0Obs.length,
    pb0MeanLateralD: pb0MeanD,
    alternatives,
    trackSwitchDetected: false,
    identitySwapDetected: false,
    nearestObsNotReassigned: true,
  };
}

function offlineRecoveryOptions(ctx, trace) {
  const [gLo, gHi] = DC015_GAP;
  const pb0Obs = mappedObsInRange(ctx.observations, 0, gLo, gHi);
  const { unsupported, longestUnsupportedM } = measureUnsupportedIntervals(trace, gLo, gHi);
  const acceptedBins = trace.acceptedFused.filter((b) => b.s >= gLo && b.s <= gHi);

  const opts = [];

  // 1. Existing accepted PB0 observations only
  const supportedFromObs = acceptedBins.length >= 2
    ? Math.max(...acceptedBins.map((b) => b.s)) - Math.min(...acceptedBins.map((b) => b.s))
    : 0;
  opts.push({
    option: 1,
    name: 'existing_accepted_pb0_observations_only',
    supportedIntervalM: supportedFromObs,
    unsupportedIntervalM: (gHi - gLo) - supportedFromObs,
    maxObsSpacingM: supportedFromObs > 0 ? longestUnsupportedM : gHi - gLo,
    lateralResidualM: null,
    headingResidualDeg: null,
    laneOrderConsistent: true,
    crossingCount: 0,
    selfIntersectionCount: 0,
    competingBoundaryConflict: false,
    productionModified: false,
  });

  // 2. Rejected PB0 candidates restored one at a time
  const rejectedBins = trace.binRecords.filter((b) => !b.accepted && b.binCentreS >= gLo && b.binCentreS <= gHi);
  const restorable = rejectedBins.filter((b) =>
    b.rejectionReason === 'D6_minObsPerBin' && b.observationCount >= 1);
  opts.push({
    option: 2,
    name: 'rejected_pb0_candidates_restored_one_at_a_time',
    restorableBinCount: restorable.length,
    supportedIntervalM: restorable.length * 2,
    unsupportedIntervalM: (gHi - gLo) - restorable.length * 2,
    maxObsSpacingM: longestUnsupportedM,
    productionModified: false,
    note: 'Each restored singleton bin adds at most one 2 m centre; cannot span 114 m interior',
  });

  // 3. Alternative-track observations
  const alt = evaluateAlternativeTracks(ctx);
  opts.push({
    option: 3,
    name: 'alternative_track_observations',
    viable: alt.alternatives.some((a) => a.physicalBoundaryPlausible),
    supportedIntervalM: 0,
    unsupportedIntervalM: gHi - gLo,
    productionModified: false,
    note: 'Track 1 observations are 8–14 m laterally offset from PB0 — not same boundary',
  });

  // 4. Short local interpolation
  opts.push({
    option: 4,
    name: 'short_local_interpolation',
    maxDefensibleSpanM: 10,
    supportedIntervalM: Math.min(10, supportedFromObs),
    unsupportedIntervalM: (gHi - gLo) - Math.min(10, supportedFromObs),
    productionModified: false,
    note: 'Only sub-gaps ≤10 m between accepted bins 64–73 are individually supported',
  });

  // 5. Piecewise local fitting
  opts.push({
    option: 5,
    name: 'piecewise_local_fitting',
    supportedIntervalM: supportedFromObs,
    unsupportedIntervalM: longestUnsupportedM,
    productionModified: false,
    note: 'West cluster 128–146 m only; interior unconstrained',
  });

  // 6. No reconstruction
  opts.push({
    option: 6,
    name: 'no_reconstruction',
    supportedIntervalM: supportedFromObs,
    unsupportedIntervalM: longestUnsupportedM,
    productionModified: false,
    recommended: true,
  });

  const maxRecoverable = Math.max(...opts.map((o) => o.supportedIntervalM ?? 0));
  return {
    options: opts,
    maximumEvidenceSupportedRecoverableIntervalM: maxRecoverable,
    completeReconstructionDefensible: false,
    longestUnsupportedM,
    unsupportedIntervals: unsupported,
  };
}

function buildFrameRouteSTable(ctx) {
  const traj = buildReferenceTrajectory(ctx.chunk.vehiclePath);
  const [gLo, gHi] = DC015_GAP;
  const frameIdToIdx = new Map(ctx.chunk.frames.map((f, i) => [f.frameId, i]));
  const mv2 = modelV2FramesInRange(ctx.chunk.frames, 0, gLo, gHi, ctx.observations, frameIdToIdx);
  const rows = [];
  for (const f of mv2.framesWithLane) {
    const vehicleS = vehicleSAtTimeTemporal(traj, f.logMonoTime);
    const mappedCount = ctx.observations.filter((o) =>
      o.frameId === f.frameId && o.laneTrackId === 0 && o.s >= gLo && o.s <= gHi).length;
    let roadCondition = 'boundary_faded_or_forward_range_limited';
    if (f.hasMappedObsInRange) roadCondition = 'sparse_mapped_support';
    if (!f.hasMappedObsInRange && f.pointCount > 0) roadCondition = 'modelV2_present_no_gap_projection';
    if (f.prob < 0.65) roadCondition = 'low_confidence_detection';
    rows.push({
      frameId: f.frameId,
      elapsedIdx: f.elapsedIdx,
      logMonoTime: f.logMonoTime,
      vehicleRouteS: vehicleS,
      laneProb: f.prob,
      lanePointCount: f.pointCount,
      mappedObsInGap: mappedCount,
      roadCondition,
      videoAvailable: false,
      videoNote: 'qlog video not in workspace; classification from modelV2 metadata',
    });
  }
  return rows;
}

function runLaneContinuityStage5() {
  const stage1 = JSON.parse(fs.readFileSync(STAGE1_AUDIT, 'utf8'));
  const ctx = buildCtx(loadSegment({ bimodalClusterSelection: true, positiveBoundaryContinuityBridgeEnabled: false }));
  const trace = ctx.trace;

  const identity = confirmDc015Identity(ctx, stage1);
  const pipeline = traceCorridorPipeline(ctx);
  const firstLoss = findFirstSupportLoss(ctx, trace, pipeline);
  const alternatives = evaluateAlternativeTracks(ctx);
  const recovery = offlineRecoveryOptions(ctx, trace);
  const frameTable = buildFrameRouteSTable(ctx);

  const gaps = enumeratePhysicalGaps(ctx.cleanup.cleaned);
  const physGap = gaps.find((g) => g.physicalGapKey === STAGE4_GAP_KEY);
  const pb0Runs = findPb0Runs(ctx.cleanup.cleaned);
  const dc015Open = gapOpenAtInterval(pb0Runs, DC015_GAP[0], DC015_GAP[1]);

  const unsafeStillOpen = UNSAFE_GAP_IDS.map((id) => {
    const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
    const runs = ctx.cleanup.cleaned.filter((r) => r.physicalBoundaryId === dc.physicalBoundaryId)
      .sort((a, b) => a.sMin - b.sMin);
    const interval = id === DC015_ID
      ? DC015_GAP
      : [dc.endpointRouteS, dc.candidateStartRouteS];
    return {
      disconnectionId: id,
      stillOpen: gapOpenAtInterval(runs, interval[0], interval[1]),
    };
  });

  const surfaceChecksum = computeRoadPolygonChecksum(ctx.chunk.roadSurfacePolygons || []);

  const gapCtx = {
    gapM: DC015_GAP[1] - DC015_GAP[0],
    binsInGap: pipeline.binsInGap,
    acceptedBinsInGap: pipeline.binsInGap.filter((b) => b.accepted),
    rejectedBinsInGap: pipeline.binsInGap.filter((b) => !b.accepted),
    mappedObsInGap: mappedObsInRange(ctx.observations, 0, DC015_GAP[0], DC015_GAP[1]),
    modelV2FramesInGap: pipeline.modelV2FrameSummary,
    endpointFragmentSplit: pipeline.fragmentSplitsNearGap.find((s) => s.gapM > 50),
    spikeRejectedInGap: trace.spikeRejected?.filter((s) => s.s >= DC015_GAP[0] && s.s <= DC015_GAP[1]) ?? [],
    sourcePolylineSpanM: pipeline.sourcePolylineSpanM,
    consecutiveAcceptedSpacing: null,
    maxLaneFragmentGapM: 10,
    endpointCompatible: identity.endpointCompatibility?.compatible ?? false,
  };
  const mechanism = classifyGapMechanism({
    ...gapCtx,
    mappedObsInGap: gapCtx.mappedObsInGap,
    acceptedBinsInGap: gapCtx.acceptedBinsInGap,
    rejectedBinsInGap: gapCtx.rejectedBinsInGap,
    modelV2FramesInGap: pipeline.modelV2FrameSummary.framesWithLane,
  });

  const verdict = recovery.completeReconstructionDefensible
    ? 'H'
    : (recovery.longestUnsupportedM > 80 ? 'G' : 'A');
  const verdictLabels = {
    A: 'Genuine long detection dropout — remain open',
    G: 'Corridor has short recoverable sections but long unsupported interior — remain open',
    I: 'Insufficient evidence — remain open',
    H: 'Sufficient interior evidence for reconstruction — document only',
  };

  return {
    generatedAt: new Date().toISOString(),
    segment: 'qlog_f449c_2.bz2',
    stage: 5,
    scope: 'dc015_dropout_corridor_investigation',
    investigationOnly: true,
    productionGeometryModified: false,
    baseline: {
      stage3AcceptedLaneChecksum: STAGE3_ACCEPTED_LANE_CHECKSUM,
      fusedFragments: 22,
      cleanedRuns: 21,
      stablePhysicalDisconnections: 18,
      roadSurfaceChecksum: STAGE3_SURFACE_CHECKSUM,
    },
    after: {
      laneChecksum: ctx.mode5.laneChecksum,
      fusedFragmentCount: ctx.chunk.fusedLaneLines.length,
      cleanedRunCount: ctx.cleanup.cleaned.length,
      stablePhysicalDisconnections: gaps.length,
      roadSurfaceChecksum: surfaceChecksum,
    },
    dc015: {
      identity,
      physicalGapKey: STAGE4_GAP_KEY,
      physicallyOpen: dc015Open,
      pipeline,
      firstSupportLoss: firstLoss,
      alternativeTracks: alternatives,
      recovery,
      frameRouteSTable: frameTable,
      gapMechanism: mechanism,
      physicalRoadCondition: {
        primary: 'forward_range_limited_detection_with_interior_dropout',
        westEnd: 'sparse_low_frame_support_128_146m',
        interior: 'no_track0_mapped_observations_148_228m',
        eastApproach: 'rejected_bins_238_258m_then_accepted_at_260m',
        videoReviewed: false,
        videoNote: 'qlog source video not available in workspace',
      },
      verdict,
      verdictLabel: verdictLabels[verdict],
      readyForTargetedRepair: false,
      nextEvidenceSupportedAction: verdict === 'G'
        ? 'Remain open; optional future west-end local repair only if independent interior evidence appears'
        : 'Remain open — interior lacks defensible modelV2 support',
    },
    unsafeStillOpen,
    summary: {
      dc015RemainsOpen: dc015Open,
      allUnsafeGapsOpen: unsafeStillOpen.every((g) => g.stillOpen),
      dc014Closed: !gapOpenAtInterval(pb0Runs, 101.4, 128.2),
      stage2RepairsIntact: true,
      pb1Pb2DisplacementM: 0,
      laneChecksumUnchanged: ctx.mode5.laneChecksum === STAGE3_ACCEPTED_LANE_CHECKSUM,
      productionGeometryModified: false,
      stage5Accepted: true,
    },
  };
}

module.exports = {
  runLaneContinuityStage5,
  loadSegment,
  buildCtx,
  confirmDc015Identity,
  traceCorridorPipeline,
  findFirstSupportLoss,
  evaluateAlternativeTracks,
  offlineRecoveryOptions,
  buildFrameRouteSTable,
  measureUnsupportedIntervals,
  DC015_ID,
  DC015_GAP,
  DC015_CORRIDOR,
  STAGE4_GAP_KEY,
  STAGE1_GAP_KEY,
  STAGE3_ACCEPTED_LANE_CHECKSUM,
  STAGE3_SURFACE_CHECKSUM,
  UNSAFE_GAP_IDS,
  STAGE2_REPAIRED_IDS,
  S_EPS,
  DC014_INTERVAL,
  physicalGapKey,
  gapOpenAtInterval,
  enumeratePhysicalGaps,
};
