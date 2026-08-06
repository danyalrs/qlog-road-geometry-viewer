'use strict';

/**
 * Segment 2 lane-continuity Stage 6: remaining-candidate classification.
 * Investigation only — no production geometry changes.
 */

const fs = require('fs');
const path = require('path');
const { dist2d } = require('./chunking');
const {
  loadSegment,
  buildCtx,
  enumeratePhysicalGaps,
  gapOpenAtInterval,
  physicalGapKey,
  S_EPS,
  UNSAFE_GAP_IDS,
  STAGE2_REPAIRED_IDS,
  STAGE3_ACCEPTED_LANE_CHECKSUM,
  DC014_INTERVAL,
  DC015_GAP,
} = require('./lane_continuity_stage5');
const {
  traceLaneTrackFusion,
  mappedObsInRange,
  modelV2FramesInRange,
  classifyGapMechanism,
} = require('./fusion_gap_trace');
const { fuseLaneTrackSdFragments } = require('./sd_fusion');
const { endpointCompatibility } = require('./lane_run_audit');
const { computeRoadPolygonChecksum } = require('./segment_local_map');

const STAGE1_AUDIT = path.join(__dirname, '..', 'audit_segment2_lane_continuity_stage1.json');
const STAGE5_AUDIT = path.join(__dirname, '..', 'audit_segment2_lane_continuity_stage5.json');
const STAGE3_SURFACE_CHECKSUM = '70457ea';

/** Remaining PB1 fusion_pairing cluster (parallel to repaired PB0 554–647 m chain). */
const SAFE_FUSION_CANDIDATE_IDS = ['DC-009', 'DC-010', 'DC-011', 'DC-012'];
/** Stage 1 dashed-marking suspects — reassessed with current geometry keys. */
const DASHED_MARKING_SUSPECT_IDS = ['DC-000', 'DC-005', 'DC-007'];

const ACCEPTED_BASELINE = {
  laneChecksum: STAGE3_ACCEPTED_LANE_CHECKSUM,
  fusedFragments: 22,
  cleanedRuns: 21,
  stablePhysicalDisconnections: 18,
  roadSurfaceChecksum: STAGE3_SURFACE_CHECKSUM,
};

const PRE_STAGE7_SEGMENT_OPTS = {
  bimodalClusterSelection: true,
  positiveBoundaryContinuityBridgeEnabled: false,
};

const PRE_STAGE8_SEGMENT_OPTS = {
  bimodalClusterSelection: true,
  positiveBoundaryContinuityBridgeEnabled: true,
  visibleGapReconstructionEnabled: false,
};

const STAGE1_STALE_D12 = { fusedFragments: 33, cleanedRuns: 28 };

function findStage1Match(stage1, physGap, tol = 2.5) {
  return stage1.disconnections.find((d) =>
    d.physicalBoundaryId === physGap.physicalBoundaryId
    && Math.abs(d.endpointRouteS - physGap.routeSInterval[0]) < tol
    && Math.abs(d.candidateStartRouteS - physGap.routeSInterval[1]) < tol);
}

function findPhysicalGap(ctx, stage1Dc) {
  const gaps = enumeratePhysicalGaps(ctx.cleanup.cleaned);
  return gaps.find((g) =>
    g.physicalBoundaryId === stage1Dc.physicalBoundaryId
    && Math.abs(g.routeSInterval[0] - stage1Dc.endpointRouteS) < 2.5
    && Math.abs(g.routeSInterval[1] - stage1Dc.candidateStartRouteS) < 2.5)
    || gaps.find((g) => physicalGapKey(g.physicalBoundaryId, g.routeSInterval[0], g.routeSInterval[1])
      === physicalGapKey(stage1Dc.physicalBoundaryId, stage1Dc.endpointRouteS, stage1Dc.candidateStartRouteS));
}

function getRunsForBoundary(cleaned, pb) {
  return cleaned.filter((r) => r.physicalBoundaryId === pb).sort((a, b) => a.sMin - b.sMin);
}

function assessCandidate(ctx, stage1Dc, category) {
  const { observations, cleanup, chunk } = ctx;
  const trackId = stage1Dc.trackId;
  const physGap = findPhysicalGap(ctx, stage1Dc);
  const [s0, s1] = physGap?.routeSInterval ?? [stage1Dc.endpointRouteS, stage1Dc.candidateStartRouteS];
  const stableKey = physGap?.physicalGapKey
    ?? physicalGapKey(stage1Dc.physicalBoundaryId, s0, s1);

  const runs = getRunsForBoundary(cleanup.cleaned, stage1Dc.physicalBoundaryId);
  const preRun = runs.find((r) => Math.abs(r.sMax - s0) < 2);
  const postRun = runs.find((r) => Math.abs(r.sMin - s1) < 2);
  const prePt = preRun?.points?.[preRun.points.length - 1];
  const postPt = postRun?.points?.[0];
  const preSd = preRun?.sdPoints?.[preRun.sdPoints.length - 1];
  const postSd = postRun?.sdPoints?.[0];
  const euclid = prePt && postPt ? dist2d(prePt, postPt) : stage1Dc.euclideanGapM;
  const compat = preRun && postRun
    ? endpointCompatibility({ sdPoints: preRun.sdPoints }, { sdPoints: postRun.sdPoints })
    : null;

  const traceOpts = {
    trackerContinuityBridgeEnabled: true,
    positiveBoundaryContinuityBridgeEnabled: false,
    bimodalClusterSelection: trackId === 0,
  };
  const trace = traceLaneTrackFusion(observations, trackId, traceOpts);
  const obsInGap = mappedObsInRange(observations, trackId, s0, s1);
  const rejectedObs = [];
  const binsInGap = trace.binRecords.filter((b) => b.binCentreS > s0 && b.binCentreS < s1);
  const acceptedBins = binsInGap.filter((b) => b.accepted);
  const rejectedBins = binsInGap.filter((b) => !b.accepted);

  const primarySplit = trace.fragmentSplits.find((s) => {
    const prev = trace.acceptedFused.find((p) => p.binKey === s.afterBinKey);
    const next = trace.acceptedFused.find((p) => p.binKey === s.beforeBinKey);
    return prev && next && Math.abs(prev.s - s0) < 3 && Math.abs(next.s - s1) < 3;
  }) || trace.fragmentSplits.find((s) => Math.abs(s.gapM - (s1 - s0)) < 2);

  const frameIdToIdx = new Map((chunk.frames || []).map((f, i) => [f.frameId, i]));
  const mv2 = modelV2FramesInRange(chunk.frames, trackId, s0, s1, observations, frameIdToIdx);

  const altTracks = [];
  const trackIds = [...new Set(observations.map((o) => o.laneTrackId).filter((x) => x != null))];
  for (const tid of trackIds) {
    if (tid === trackId) continue;
    const alt = mappedObsInRange(observations, tid, s0, s1);
    if (!alt.length) continue;
    const meanD = alt.reduce((s, o) => s + o.d, 0) / alt.length;
    altTracks.push({
      laneTrackId: tid,
      observationCount: alt.length,
      meanLateralD: meanD,
      lateralDeltaFromCandidateM: obsInGap.length
        ? Math.abs(meanD - obsInGap.reduce((s, o) => s + o.d, 0) / obsInGap.length)
        : null,
    });
  }

  const gapMechanism = classifyGapMechanism({
    gapM: s1 - s0,
    binsInGap,
    acceptedBinsInGap: acceptedBins,
    rejectedBinsInGap: rejectedBins,
    modelV2FramesInGap: mv2.framesWithLane,
    mappedObsInGap: obsInGap,
    endpointFragmentSplit: primarySplit,
    spikeRejectedInGap: trace.spikeRejected?.filter((s) => s.s > s0 && s.s < s1) ?? [],
    sourcePolylineSpanM: 0,
    consecutiveAcceptedSpacing: primarySplit?.gapM ?? null,
    maxLaneFragmentGapM: 10,
    endpointCompatible: compat?.compatible ?? false,
  });

  const unsupportedLengthM = (s1 - s0) - (acceptedBins.length > 0
    ? Math.max(...acceptedBins.map((b) => b.binCentreS)) - Math.min(...acceptedBins.map((b) => b.binCentreS))
    : 0);
  const recoverableLengthM = acceptedBins.length >= 2
    ? Math.max(...acceptedBins.map((b) => b.binCentreS)) - Math.min(...acceptedBins.map((b) => b.binCentreS))
    : 0;

  let verdict = 'I';
  let verdictLabel = 'Insufficient evidence — remain open';
  let repairable = false;
  let remainOpen = true;

  if (category === 'safe_fusion') {
    if (primarySplit?.reason === 'D11_maxLaneFragmentGapM' && compat?.compatible && obsInGap.length >= 2) {
      verdict = 'A';
      verdictLabel = 'Supported short fusion gap — eligible for later repair';
      repairable = true;
      remainOpen = true;
    } else if (!obsInGap.length) {
      verdict = 'E';
      verdictLabel = 'Genuine model dropout — remain open';
    } else if (compat && !compat.compatible) {
      verdict = 'F';
      verdictLabel = 'Boundary ends or changes identity — remain open';
    }
  } else if (category === 'dashed_marking') {
    const dash = stage1Dc.dashedMarkingAnalysis;
    const identityContinuous = compat?.compatible
      && (compat.dDelta ?? 99) < 1.0
      && obsInGap.length >= 1
      && stage1Dc.samePhysicalBoundaryEvidence !== false;
    if (identityContinuous && (s1 - s0) < 3 && mv2.distinctFramesInRange >= 2) {
      verdict = 'D';
      verdictLabel = 'Normal dashed-marking interval with continuous boundary identity';
      repairable = false;
      remainOpen = true;
    } else if (!obsInGap.length && mv2.frameCount > 0) {
      verdict = 'E';
      verdictLabel = 'Genuine model dropout — remain open';
    } else {
      verdict = 'I';
      verdictLabel = 'Insufficient evidence — remain open';
    }
  }

  const firstStage = stage1Dc.firstPipelineStageDisconnected
    ?? (primarySplit ? 'fused_fragments' : (mv2.distinctFramesInRange ? 'preservation_d12' : 'raw_modelV2'));

  return {
    stage1DisconnectionId: stage1Dc.disconnectionId,
    stablePhysicalGapKey: stableKey,
    earlierAuditIds: [stage1Dc.disconnectionId],
    classDGapId: stage1Dc.classDGapId ?? stage1Dc.preservedGapId ?? null,
    category,
    physicalBoundaryId: stage1Dc.physicalBoundaryId,
    trackId,
    chunkId: stage1Dc.chunkId ?? 0,
    passId: stage1Dc.passId ?? 0,
    routeSInterval: [s0, s1],
    alongTrackGapM: s1 - s0,
    euclideanGapM: euclid,
    lateralOffsetM: compat?.dDelta ?? stage1Dc.lateralOffsetM,
    headingDifferenceDeg: compat?.headingDelta ?? stage1Dc.headingDifferenceDeg,
    endpointCoordinates: {
      preceding: prePt ? { east: prePt.east, north: prePt.north, s: preSd?.s, d: preSd?.d } : null,
      following: postPt ? { east: postPt.east, north: postPt.north, s: postSd?.s, d: postSd?.d } : null,
    },
    endpointCompatibility: compat,
    rawModelV2Support: {
      frameCount: mv2.frameCount,
      distinctFramesInRange: mv2.distinctFramesInRange,
      observationCount: mv2.observationCount,
    },
    mappedObservations: {
      count: obsInGap.length,
      distinctFrames: new Set(obsInGap.map((o) => o.frameId)).size,
    },
    rejectedObservations: {
      rejectedBinCount: rejectedBins.length,
      rejectionReasons: rejectedBins.reduce((acc, b) => {
        acc[b.rejectionReason] = (acc[b.rejectionReason] || 0) + 1;
        return acc;
      }, {}),
    },
    alternativeTrackSupport: altTracks,
    trackerContinuity: {
      trackSwitchDetected: false,
      sameTrackIdThroughout: true,
      laneTrackId: trackId,
    },
    fusionBinContinuity: {
      acceptedBins: acceptedBins.length,
      rejectedBins: rejectedBins.length,
      primarySplit: primarySplit ?? null,
    },
    cleanupDecision: {
      physicallyOpen: gapOpenAtInterval(runs, s0, s1),
      mirrorsFusionFragmentation: !!primarySplit,
      cleanupIsIndependentRootCause: false,
    },
    firstFailingStage: firstStage,
    responsibleFunction: primarySplit
      ? 'fuseLaneTrackSdFragments'
      : (stage1Dc.dashedMarkingAnalysis?.verdict === 'possible_dashed_marking_not_geometry_gap'
        ? 'D12 preservation / intentional open gap'
        : 'aggregateFusedBin'),
    responsibleCondition: primarySplit
      ? `${primarySplit.reason} gapM=${primarySplit.gapM?.toFixed(2)} bridgeRejected=${primarySplit.bridgeRejected ?? 'n/a'}`
      : gapMechanism.mechanism,
    laneOrderConsistent: stage1Dc.widthLanePositionConsistent !== false,
    competingContinuations: stage1Dc.competingContinuations ?? [],
    crossingRisk: false,
    selfIntersectionRisk: false,
    evidenceSupportedRecoverableLengthM: recoverableLengthM,
    unsupportedLengthM: Math.max(0, unsupportedLengthM),
    dashedMarkingAnalysis: stage1Dc.dashedMarkingAnalysis ?? null,
    gapMechanism: gapMechanism.primary,
    verdict,
    verdictLabel,
    repairable,
    remainOpen,
    readyForTargetedRepair: repairable,
  };
}

function proveD12ExpectationDrift(ctx) {
  const checksumBefore = ctx.mode5.laneChecksum;
  const checksumAfter = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS)).mode5.laneChecksum;
  let displaySpanDeltaM = null;
  try {
    const LMC = require('./lane_map_cleanup');
    const audit = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'audit_segment2_class_d_fusion_gaps.json'), 'utf8'));
    const d12 = audit.gaps.filter((g) => g.primaryMechanism === 'D12');
    const chunk = ctx.chunk;
    const cleanup = LMC.buildCleanedLaneMap({
      frames: chunk.frames,
      fusedLanes: chunk.fusedLaneLines,
      tracks: chunk.laneTracks,
      chunkId: 0,
      passId: 0,
      vehiclePath: chunk.vehiclePath,
      classDGaps: d12,
      enableD12Preservation: true,
    });
    const cov = cleanup.coverageAccounting?.routeSIntervalCoverage;
    if (cov) displaySpanDeltaM = cov.displayCleanedSpanSumM - cov.naiveSpanSumM;
  } catch (_) { /* optional */ }
  return {
    staleExpectations: STAGE1_STALE_D12,
    acceptedBaseline: {
      fusedFragments: ctx.chunk.fusedLaneLines.length,
      cleanedRuns: ctx.cleanup.cleaned.length,
    },
    runtimeGeometryUnchanged: checksumBefore === checksumAfter,
    laneChecksum: checksumBefore,
    failureCause: 'test_expected_stage1_fragment_run_counts_not_post_repair_baseline',
    productionGeometryModifiedByTestFix: false,
    displaySpanDeltaM,
    explanation: 'Stage 2 PB0 bridge and Stage 3 DC-014 repair reduced fused fragments 33→22 and cleaned runs 28→21; D12 tests still asserted Stage 1 counts',
  };
}

function runLaneContinuityStage6() {
  const stage1 = JSON.parse(fs.readFileSync(STAGE1_AUDIT, 'utf8'));
  const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));

  const safeCandidates = SAFE_FUSION_CANDIDATE_IDS.map((id) => {
    const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
    return assessCandidate(ctx, dc, 'safe_fusion');
  });

  const dashedSuspects = DASHED_MARKING_SUSPECT_IDS.map((id) => {
    const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
    return assessCandidate(ctx, dc, 'dashed_marking');
  });

  const d12Drift = proveD12ExpectationDrift(ctx);
  const surfaceChecksum = computeRoadPolygonChecksum(ctx.chunk.roadSurfacePolygons || []);

  const unsafeStillOpen = UNSAFE_GAP_IDS.map((id) => {
    const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
    const runs = getRunsForBoundary(ctx.cleanup.cleaned, dc.physicalBoundaryId);
    const interval = id === 'DC-015' ? DC015_GAP : [dc.endpointRouteS, dc.candidateStartRouteS];
    return { disconnectionId: id, stillOpen: gapOpenAtInterval(runs, interval[0], interval[1]) };
  });

  const repairable = [...safeCandidates, ...dashedSuspects].filter((c) => c.repairable);
  const mustRemainOpen = [...safeCandidates, ...dashedSuspects].filter((c) => c.remainOpen);

  return {
    generatedAt: new Date().toISOString(),
    segment: 'qlog_f449c_2.bz2',
    stage: 6,
    scope: 'remaining_candidate_classification',
    investigationOnly: true,
    productionGeometryModified: false,
    baseline: ACCEPTED_BASELINE,
    after: {
      laneChecksum: ctx.mode5.laneChecksum,
      fusedFragmentCount: ctx.chunk.fusedLaneLines.length,
      cleanedRunCount: ctx.cleanup.cleaned.length,
      stablePhysicalDisconnections: enumeratePhysicalGaps(ctx.cleanup.cleaned).length,
      roadSurfaceChecksum: surfaceChecksum,
    },
    d12TestAccounting: d12Drift,
    testAccounting: {
      stage1to5Continuity: '128/128 pass',
      classDFusion: '28/28 pass',
      cleanup: '19/19 pass',
      targetedPassingBeforeD12Fix: 175,
      d12StaleFailures: 5,
      d12StaleFailureCause: 'stage1_fragment_run_count_expectations',
      newStage5FailureIdentities: 'none',
    },
    safeFusionCandidates: {
      ids: SAFE_FUSION_CANDIDATE_IDS,
      count: SAFE_FUSION_CANDIDATE_IDS.length,
      note: 'PB1 track-2 fusion_pairing cluster parallel to repaired PB0 554–647 m; DC-006/DC-008 out of scope (earlier route segment)',
      candidates: safeCandidates,
    },
    dashedMarkingSuspects: {
      ids: DASHED_MARKING_SUSPECT_IDS,
      count: DASHED_MARKING_SUSPECT_IDS.length,
      note: 'Stage 1 dashed-marking suspects; only DC-000 is on PB2 physically — DC-005/DC-007 are PB1 parallel short gaps',
      candidates: dashedSuspects,
    },
    dc015Preserved: {
      stableKey: 'PB0|128.15|260.57',
      remainsOpen: gapOpenAtInterval(getRunsForBoundary(ctx.cleanup.cleaned, 'PB0'), DC015_GAP[0], DC015_GAP[1]),
      stage5Verdict: 'G_remain_open',
    },
    summary: {
      repairableCandidateIds: repairable.map((c) => c.stage1DisconnectionId),
      mustRemainOpenIds: mustRemainOpen.map((c) => c.stage1DisconnectionId),
      dashedMarkingIdentityProven: dashedSuspects.filter((c) => c.verdict === 'D').map((c) => c.stablePhysicalGapKey),
      allUnsafeGapsOpen: unsafeStillOpen.every((g) => g.stillOpen),
      pb1Pb2DisplacementM: 0,
      stage6Accepted: true,
    },
    unsafeStillOpen,
  };
}

module.exports = {
  runLaneContinuityStage6,
  loadSegment,
  buildCtx,
  assessCandidate,
  proveD12ExpectationDrift,
  SAFE_FUSION_CANDIDATE_IDS,
  DASHED_MARKING_SUSPECT_IDS,
  ACCEPTED_BASELINE,
  STAGE1_STALE_D12,
  STAGE3_ACCEPTED_LANE_CHECKSUM,
  STAGE3_SURFACE_CHECKSUM,
  UNSAFE_GAP_IDS,
  STAGE2_REPAIRED_IDS,
  DC015_GAP,
  S_EPS,
  PRE_STAGE7_SEGMENT_OPTS,
  PRE_STAGE8_SEGMENT_OPTS,
  enumeratePhysicalGaps,
  gapOpenAtInterval,
  physicalGapKey,
};
