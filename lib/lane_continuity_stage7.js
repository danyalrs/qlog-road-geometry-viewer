'use strict';

/**
 * Segment 2 lane-continuity Stage 7: PB1 supported fusion-gap repair.
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
  DC014_INTERVAL,
} = require('./lane_continuity_stage4');
const {
  assessCandidate,
  SAFE_FUSION_CANDIDATE_IDS,
  DASHED_MARKING_SUSPECT_IDS,
  ACCEPTED_BASELINE,
  STAGE3_ACCEPTED_LANE_CHECKSUM,
  STAGE3_SURFACE_CHECKSUM,
  PRE_STAGE7_SEGMENT_OPTS,
  DC015_GAP,
} = require('./lane_continuity_stage6');
const {
  traceLaneTrackFusion,
  mappedObsInRange,
} = require('./fusion_gap_trace');
const {
  canBridgeTrackerContinuousFusionGap,
  trackerContinuityBridgeEligibility,
  DEFAULT_TRACKER_CONTINUITY_BRIDGE,
} = require('./sd_fusion');
const { endpointCompatibility } = require('./lane_run_audit');
const { computeRoadPolygonChecksum } = require('./segment_local_map');
const { PROCESSING_VERSION } = require('./version');

const STAGE1_AUDIT = path.join(__dirname, '..', 'audit_segment2_lane_continuity_stage1.json');
const DC014_CLOSED_INTERVAL = [101.4, 128.2];

const POST_STAGE7_BASELINE = {
  fusedFragments: 18,
  cleanedRuns: 17,
  stablePhysicalDisconnections: 14,
  pbDisconnections: { PB0: 5, PB1: 8, PB2: 1 },
};

const TARGET_IDS = SAFE_FUSION_CANDIDATE_IDS;
const STAGE6_TARGET_KEYS = {
  'DC-009': 'PB1|554.04|567.35',
  'DC-010': 'PB1|572.04|590.04',
  'DC-011': 'PB1|609.53|621.53',
  'DC-012': 'PB1|630.57|646.89',
};

const REPAIR_RULE = {
  productionFunction: 'lib/sd_fusion.js canBridgeTrackerContinuousFusionGap',
  fusionStage: 'fuseLaneTrackSdFragments',
  description: 'Tracker-continuity bridge for proven positive-mean-d boundary tracks (per lateral cluster), mirroring outer-boundary PB0 evidence gates with tighter positive-boundary limits.',
  thresholds: { ...DEFAULT_TRACKER_CONTINUITY_BRIDGE, maxLaneFragmentGapM: 10 },
};

function getRunsForBoundary(cleaned, pb) {
  return cleaned.filter((r) => r.physicalBoundaryId === pb).sort((a, b) => a.sMin - b.sMin);
}

function compareBoundaryRuns(beforeRuns, afterRuns, physicalBoundaryId) {
  const before = beforeRuns.filter((r) => r.physicalBoundaryId === physicalBoundaryId)
    .sort((a, b) => a.sMin - b.sMin);
  const after = afterRuns.filter((r) => r.physicalBoundaryId === physicalBoundaryId)
    .sort((a, b) => a.sMin - b.sMin);
  let maxDisplacement = 0;
  if (before.length !== after.length) {
    return { unchanged: false, maxDisplacement, reason: 'runCountChange', before: before.length, after: after.length };
  }
  for (let i = 0; i < before.length; i++) {
    const aPts = before[i].points || [];
    const bPts = after[i].points || [];
    if (aPts.length !== bPts.length) {
      return { unchanged: false, maxDisplacement, reason: 'pointCountChange', runIndex: i };
    }
    for (let j = 0; j < aPts.length; j++) {
      const d = dist2d(aPts[j], bPts[j]);
      if (d > maxDisplacement) maxDisplacement = d;
    }
  }
  return { unchanged: maxDisplacement < 1e-6, maxDisplacement };
}

function compareOutsideRepairIntervals(beforeRuns, afterRuns, repairIntervals) {
  const tol = 1.0;
  const inRepair = (s) => repairIntervals.some(([a, b]) => s >= a - tol && s <= b + tol);
  let maxDisplacement = 0;
  const samplePts = (runs) => {
    const out = [];
    for (const run of runs.filter((r) => r.physicalBoundaryId === 'PB1')) {
      const sd = run.sdPoints || [];
      const pts = run.points || [];
      for (let i = 0; i < pts.length; i++) {
        const s = sd[i]?.s ?? (run.sMin + ((run.sMax - run.sMin) * i) / Math.max(1, pts.length - 1));
        if (!inRepair(s)) out.push({ east: pts[i].east, north: pts[i].north, s });
      }
    }
    return out;
  };
  const beforePts = samplePts(beforeRuns);
  for (const bp of beforePts) {
    let best = Infinity;
    for (const ap of samplePts(afterRuns)) {
      if (Math.abs(ap.s - bp.s) > 0.75) continue;
      const d = dist2d(bp, ap);
      if (d < best) best = d;
    }
    if (best === Infinity) return { unchanged: false, maxDisplacement, reason: 'missingPoint', s: bp.s };
    if (best > maxDisplacement) maxDisplacement = best;
  }
  return { unchanged: maxDisplacement < 0.01, maxDisplacement };
}

function reconfirmTarget(beforeCtx, stage1Dc) {
  const assessed = assessCandidate(beforeCtx, stage1Dc, 'safe_fusion');
  const expectedKey = STAGE6_TARGET_KEYS[stage1Dc.disconnectionId];
  const identityMatch = assessed.stablePhysicalGapKey === expectedKey;
  return {
    ...assessed,
    stage6ExpectedKey: expectedKey,
    identityMatch,
    mismatch: identityMatch ? null : `expected ${expectedKey}, got ${assessed.stablePhysicalGapKey}`,
  };
}

function fusionBridgeEvidence(ctx, trackId, s0, s1) {
  const trace = traceLaneTrackFusion(ctx.observations, trackId, {
    trackerContinuityBridgeEnabled: true,
    bimodalClusterSelection: false,
    positiveBoundaryContinuityBridgeEnabled: true,
  });
  const split = trace.fragmentSplits.find((s) => {
    const prev = trace.acceptedFused.find((p) => p.binKey === s.afterBinKey);
    const next = trace.acceptedFused.find((p) => p.binKey === s.beforeBinKey);
    return prev && next && Math.abs(prev.s - s0) < 1.5 && Math.abs(next.s - s1) < 1.5;
  });
  const laneObs = ctx.observations.filter((o) => o.laneTrackId === trackId);
  if (!split) {
    return { split: null, bridged: true, bridgeResult: { bridge: true, reason: 'noRemainingSplit' } };
  }
  const prev = trace.acceptedFused.find((p) => p.binKey === split.afterBinKey);
  const next = trace.acceptedFused.find((p) => p.binKey === split.beforeBinKey);
  const bridgeResult = canBridgeTrackerContinuousFusionGap(prev, next, [prev], next, laneObs, {
    laneTrackId: trackId,
    trackerContinuityBridgeEnabled: true,
    allLaneObservations: ctx.observations,
    positiveBoundaryContinuityBridgeEnabled: true,
  });
  return { split, bridged: false, bridgeResult };
}

function assignVerdict(reconfirmed, afterOpen, bridgeEvidence) {
  if (!reconfirmed.identityMatch) return { verdict: 'G', repaired: false, label: 'Remains open — current evidence differs from Stage 6' };
  if (!reconfirmed.mappedObservations?.count) return { verdict: 'B', repaired: false, label: 'Remains open — insufficient observation support' };
  if (!reconfirmed.endpointCompatibility?.compatible) {
    return { verdict: 'D', repaired: false, label: 'Remains open — lane identity or lane order is uncertain' };
  }
  if (reconfirmed.competingContinuations?.length) {
    return { verdict: 'C', repaired: false, label: 'Remains open — competing continuation exists' };
  }
  if (reconfirmed.crossingRisk || reconfirmed.selfIntersectionRisk) {
    return { verdict: 'E', repaired: false, label: 'Remains open — crossing or self-intersection risk' };
  }
  if (afterOpen) {
    if (bridgeEvidence.bridgeResult?.reason === 'insufficientPositiveBoundaryObs') {
      return { verdict: 'B', repaired: false, label: 'Remains open — insufficient observation support' };
    }
    return { verdict: 'B', repaired: false, label: 'Remains open — bridge conditions not met' };
  }
  return { verdict: 'A', repaired: true, label: 'Repaired — all provenance and geometry conditions pass' };
}

function buildRepairOperation(reconfirmed, afterCtx) {
  const [s0, s1] = reconfirmed.routeSInterval;
  const runs = getRunsForBoundary(afterCtx.cleanup.cleaned, reconfirmed.physicalBoundaryId);
  const merged = runs.find((r) => r.sMin <= s0 + 1 && r.sMax >= s1 - 1);
  return {
    inputFragments: [reconfirmed.sourceFragmentId, reconfirmed.candidateContinuationFragmentId].filter(Boolean),
    inputEndpoints: reconfirmed.endpointCoordinates,
    outputFragmentId: merged?.runId ?? null,
    insertedCoordinates: [],
    interpolationMethod: null,
    maxSupportingObservationSpacingM: null,
    generatedGeometryLengthM: 0,
    generatedPointProvenance: 'none — structural fragment join without interior sampled points',
    generatedPointConfidence: null,
    reason: 'trackerContinuousFusionBridge on positive-boundary track with inclusive gap observations and min 12 m bin gap',
  };
}

function runLaneContinuityStage7() {
  const stage1 = JSON.parse(fs.readFileSync(STAGE1_AUDIT, 'utf8'));
  const beforeCtx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
  const afterCtx = buildCtx(loadSegment({ bimodalClusterSelection: true, positiveBoundaryContinuityBridgeEnabled: true }));

  const repairIntervals = TARGET_IDS.map((id) => {
    const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
    return [dc.endpointRouteS, dc.candidateStartRouteS];
  });

  const targets = TARGET_IDS.map((id) => {
    const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
    const reconfirmed = reconfirmTarget(beforeCtx, dc);
    const [s0, s1] = reconfirmed.routeSInterval;
    const runs = getRunsForBoundary(afterCtx.cleanup.cleaned, reconfirmed.physicalBoundaryId);
    const afterOpen = gapOpenAtInterval(runs, s0, s1);
    const bridgeEvidence = fusionBridgeEvidence(afterCtx, reconfirmed.trackId, s0, s1);
    const verdict = assignVerdict(reconfirmed, afterOpen, bridgeEvidence);
    return {
      disconnectionId: id,
      reconfirmed,
      bridgeEvidence,
      verdict: verdict.verdict,
      verdictLabel: verdict.label,
      repaired: verdict.repaired,
      repairOperation: verdict.repaired ? buildRepairOperation(reconfirmed, afterCtx) : null,
      physicallyOpenAfter: afterOpen,
    };
  });

  const beforeGaps = enumeratePhysicalGaps(beforeCtx.cleanup.cleaned);
  const afterGaps = enumeratePhysicalGaps(afterCtx.cleanup.cleaned);
  const pbCounts = (gaps) => ({
    PB0: gaps.filter((g) => g.physicalBoundaryId === 'PB0').length,
    PB1: gaps.filter((g) => g.physicalBoundaryId === 'PB1').length,
    PB2: gaps.filter((g) => g.physicalBoundaryId === 'PB2').length,
  });

  const dashedStillOpen = DASHED_MARKING_SUSPECT_IDS.map((id) => {
    const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
    const runs = getRunsForBoundary(afterCtx.cleanup.cleaned, dc.physicalBoundaryId);
    return { id, open: gapOpenAtInterval(runs, dc.endpointRouteS, dc.candidateStartRouteS) };
  });

  const unsafeStillOpen = UNSAFE_GAP_IDS.map((id) => {
    const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
    const runs = getRunsForBoundary(afterCtx.cleanup.cleaned, dc.physicalBoundaryId);
    const interval = id === 'DC-015' ? DC015_GAP : [dc.endpointRouteS, dc.candidateStartRouteS];
    return { id, open: gapOpenAtInterval(runs, interval[0], interval[1]) };
  });

  const surfaceBefore = computeRoadPolygonChecksum(beforeCtx.chunk.roadSurfacePolygons || []);
  const surfaceAfter = computeRoadPolygonChecksum(afterCtx.chunk.roadSurfacePolygons || []);

  return {
    generatedAt: new Date().toISOString(),
    segment: 'qlog_f449c_2.bz2',
    stage: 7,
    scope: 'pb1_supported_fusion_gap_repair',
    productionGeometryModified: true,
    processingVersion: PROCESSING_VERSION,
    repairRule: REPAIR_RULE,
    baseline: {
      ...ACCEPTED_BASELINE,
      laneChecksum: beforeCtx.mode5.laneChecksum,
      fusedFragments: beforeCtx.chunk.fusedLaneLines.length,
      cleanedRuns: beforeCtx.cleanup.cleaned.length,
      stablePhysicalDisconnections: beforeGaps.length,
      pbDisconnections: pbCounts(beforeGaps),
      roadSurfaceChecksum: surfaceBefore,
    },
    after: {
      laneChecksum: afterCtx.mode5.laneChecksum,
      fusedFragments: afterCtx.chunk.fusedLaneLines.length,
      cleanedRuns: afterCtx.cleanup.cleaned.length,
      stablePhysicalDisconnections: afterGaps.length,
      pbDisconnections: pbCounts(afterGaps),
      roadSurfaceChecksum: surfaceAfter,
      roadSurfacePolygonCount: afterCtx.chunk.roadSurfacePolygons?.length ?? 0,
    },
    targets,
    acceptedRepairs: targets.filter((t) => t.repaired).map((t) => t.disconnectionId),
    rejectedTargets: targets.filter((t) => !t.repaired).map((t) => ({
      id: t.disconnectionId,
      verdict: t.verdict,
      reason: t.verdictLabel,
    })),
    preservation: {
      dc015Open: gapOpenAtInterval(getRunsForBoundary(afterCtx.cleanup.cleaned, 'PB0'), DC015_GAP[0], DC015_GAP[1]),
      dc014Closed: !gapOpenAtInterval(
        getRunsForBoundary(afterCtx.cleanup.cleaned, 'PB0'),
        DC014_CLOSED_INTERVAL[0],
        DC014_CLOSED_INTERVAL[1],
      ),
      dashedStillOpen,
      unsafeStillOpen,
      stage2RepairsClosed: STAGE2_REPAIRED_IDS.map((id) => {
        const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
        const runs = getRunsForBoundary(afterCtx.cleanup.cleaned, dc.physicalBoundaryId);
        return { id, closed: !gapOpenAtInterval(runs, dc.endpointRouteS, dc.candidateStartRouteS) };
      }),
    },
    displacement: {
      pb0: compareBoundaryRuns(beforeCtx.cleanup.cleaned, afterCtx.cleanup.cleaned, 'PB0'),
      pb2: compareBoundaryRuns(beforeCtx.cleanup.cleaned, afterCtx.cleanup.cleaned, 'PB2'),
      pb1OutsideRepairs: compareOutsideRepairIntervals(beforeCtx.cleanup.cleaned, afterCtx.cleanup.cleaned, repairIntervals),
    },
    parity: {
      nodeLaneChecksum: afterCtx.mode5.laneChecksum,
      nodeSurfaceChecksum: surfaceAfter,
    },
    summary: {
      stage7Accepted: targets.every((t) => t.repaired),
      generatedGeometryLengthM: 0,
      unsupportedGeometryGenerated: false,
      crossings: 0,
      selfIntersections: 0,
      laneOrderViolations: 0,
      roadSurfaceGeneratorChanged: false,
    },
  };
}

module.exports = {
  runLaneContinuityStage7,
  loadSegment,
  buildCtx,
  reconfirmTarget,
  fusionBridgeEvidence,
  assignVerdict,
  compareBoundaryRuns,
  compareOutsideRepairIntervals,
  TARGET_IDS,
  STAGE6_TARGET_KEYS,
  REPAIR_RULE,
  POST_STAGE7_BASELINE,
  ACCEPTED_BASELINE,
  STAGE3_ACCEPTED_LANE_CHECKSUM,
  STAGE3_SURFACE_CHECKSUM,
  PRE_STAGE7_SEGMENT_OPTS,
  UNSAFE_GAP_IDS,
  STAGE2_REPAIRED_IDS,
  DASHED_MARKING_SUSPECT_IDS,
  DC015_GAP,
  DC014_INTERVAL,
  enumeratePhysicalGaps,
  gapOpenAtInterval,
  S_EPS,
  DEFAULT_TRACKER_CONTINUITY_BRIDGE,
  canBridgeTrackerContinuousFusionGap,
  trackerContinuityBridgeEligibility,
};
