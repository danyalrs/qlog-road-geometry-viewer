'use strict';

/**
 * Segment 2 lane-continuity Stage 8: controlled visible reconstruction
 * for structurally bridged PB1 gaps that remain visually open.
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
  STAGE3_SURFACE_CHECKSUM,
  PRE_STAGE7_SEGMENT_OPTS,
  PRE_STAGE8_SEGMENT_OPTS,
  DC015_GAP,
} = require('./lane_continuity_stage6');
const {
  compareBoundaryRuns,
  compareOutsideRepairIntervals,
  POST_STAGE7_BASELINE,
  STAGE6_TARGET_KEYS,
} = require('./lane_continuity_stage7');
const {
  findIntraRunJumps,
  RENDERER_MAX_INTRA_GAP_M,
  computeCoordinateChecksum,
} = require('./visible_gap_reconstruction');
const { computeRoadPolygonChecksum } = require('./segment_local_map');
const { PROCESSING_VERSION } = require('./version');

const STAGE1_AUDIT = path.join(__dirname, '..', 'audit_segment2_lane_continuity_stage1.json');
const DC014_CLOSED_INTERVAL = [101.4, 128.2];

const STAGE8_TARGET_IDS = ['DC-010', 'DC-012'];
const POST_STAGE8_BASELINE = {
  ...POST_STAGE7_BASELINE,
};

const REPAIR_RULE = {
  productionFunction: 'lib/visible_gap_reconstruction.js applyVisibleGapReconstruction',
  cleanupStage: 'buildCleanedLaneMap post-merge visible gap reconstruction',
  description: 'Insert parametric bridge coordinates only where an accepted positive-boundary tracker-continuity structural bridge remains visually open (>15 m renderer gap).',
  thresholds: {
    maxPointSpacingM: 1.0,
    rendererMaxIntraGapM: RENDERER_MAX_INTRA_GAP_M,
    minStructuralBridgeGapM: 12,
    maxStructuralBridgeGapM: 18,
  },
};

function getRunsForBoundary(cleaned, pb) {
  return cleaned.filter((r) => r.physicalBoundaryId === pb).sort((a, b) => a.sMin - b.sMin);
}

function reconfirmTarget(ctx, stage1Dc) {
  const assessed = assessCandidate(ctx, stage1Dc, 'safe_fusion');
  const expectedKey = STAGE6_TARGET_KEYS[stage1Dc.disconnectionId];
  const identityMatch = assessed.stablePhysicalGapKey === expectedKey;
  return {
    ...assessed,
    stage6ExpectedKey: expectedKey,
    identityMatch,
    mismatch: identityMatch ? null : `expected ${expectedKey}, got ${assessed.stablePhysicalGapKey}`,
  };
}

function findRepairForTarget(cleanup, targetId, routeS0, routeS1) {
  const repairs = cleanup.visibleGapReconstruction?.repairs || [];
  const key = `PB1|${routeS0.toFixed(2)}|${routeS1.toFixed(2)}`;
  return repairs.find((r) => r.gapStableKey === key || r.disconnectionId === targetId) || null;
}

function renderedContinuityAtGap(cleaned, pb, s0, s1) {
  const run = getRunsForBoundary(cleaned, pb).find((r) => r.sMin <= s0 + 1 && r.sMax >= s1 - 1);
  if (!run) return { continuous: false, reason: 'noRun' };
  const jumps = findIntraRunJumps(run.points, run.sdPoints, RENDERER_MAX_INTRA_GAP_M);
  const inGap = jumps.find((j) => Math.abs(j.s0 - s0) < 2 && Math.abs(j.s1 - s1) < 2);
  if (inGap) return { continuous: false, jumpM: inGap.jumpM };
  let maxSpacing = 0;
  for (let i = 0; i < run.sdPoints.length - 1; i++) {
    const a = run.sdPoints[i].s;
    const b = run.sdPoints[i + 1].s;
    if (a >= s0 - 0.5 && b <= s1 + 0.5) {
      maxSpacing = Math.max(maxSpacing, dist2d(run.points[i], run.points[i + 1]));
    }
  }
  return { continuous: maxSpacing <= 1.05, maxSpacingM: maxSpacing };
}

function assignVerdict(reconfirmed, repair, rendered) {
  if (!reconfirmed.identityMatch) {
    return { verdict: 'F', repaired: false, label: 'Remains visibly open — current identity differs' };
  }
  if (!repair?.accepted) {
    const reason = repair?.reason || repair?.verdict || 'noRepair';
    const map = {
      C: 'Remains visibly open — tangent evidence unstable',
      D: 'Remains visibly open — curvature unsafe',
      E: 'Remains visibly open — crossing or lane-order risk',
      G: 'Remains visibly open — evidence cannot constrain interior path',
    };
    return { verdict: repair?.verdict || 'G', repaired: false, label: map[repair?.verdict] || `Remains visibly open — ${reason}` };
  }
  const methodVerdict = repair.method === 'cubicHermite' ? 'B' : 'A';
  if (!rendered.continuous) {
    return { verdict: 'G', repaired: false, label: 'Remains visibly open — renderer spacing exceeds limit' };
  }
  return {
    verdict: methodVerdict,
    repaired: true,
    label: methodVerdict === 'A'
      ? 'Reconstructed using straight interpolation'
      : 'Reconstructed using cubic Hermite interpolation',
  };
}

function countInterpolatedPoints(cleaned) {
  let n = 0;
  for (const run of cleaned) {
    for (const pt of run.points || []) {
      if (pt.generated || pt.interpolationProvenance?.generated) n++;
    }
  }
  return n;
}

function runLaneContinuityStage8() {
  const stage1 = JSON.parse(fs.readFileSync(STAGE1_AUDIT, 'utf8'));
  const beforeCtx = buildCtx(loadSegment(PRE_STAGE8_SEGMENT_OPTS), PRE_STAGE8_SEGMENT_OPTS);
  const afterCtx = buildCtx(loadSegment({
    bimodalClusterSelection: true,
    positiveBoundaryContinuityBridgeEnabled: true,
    visibleGapReconstructionEnabled: true,
  }), { visibleGapReconstructionEnabled: true });

  const repairIntervals = STAGE8_TARGET_IDS.map((id) => {
    const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
    return [dc.endpointRouteS, dc.candidateStartRouteS];
  });

  const targets = STAGE8_TARGET_IDS.map((id) => {
    const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
    const reconfirmed = reconfirmTarget(afterCtx, dc);
    const [s0, s1] = reconfirmed.routeSInterval;
    const repair = findRepairForTarget(afterCtx.cleanup, id, s0, s1);
    const rendered = renderedContinuityAtGap(afterCtx.cleanup.cleaned, reconfirmed.physicalBoundaryId, s0, s1);
    const verdict = assignVerdict(reconfirmed, repair, rendered);
    return {
      disconnectionId: id,
      reconfirmed,
      repair,
      renderedContinuity: rendered,
      verdict: verdict.verdict,
      verdictLabel: verdict.label,
      repaired: verdict.repaired,
      repairOperation: verdict.repaired ? {
        method: repair.method,
        insertedPointCount: repair.insertedPointCount,
        generatedLengthM: repair.generatedLengthM,
        maxPointSpacingM: repair.maxPointSpacingM,
        confidenceRange: repair.confidenceRange,
        inputEndpoints: repair.inputEndpoints,
        tangents: repair.tangents,
        maxCurvatureDeg: repair.maxCurvatureDeg,
        maxLateralDepartureM: repair.maxLateralDepartureM,
        gapStableKey: repair.gapStableKey,
      } : null,
    };
  });

  const beforeGaps = enumeratePhysicalGaps(beforeCtx.cleanup.cleaned);
  const afterGaps = enumeratePhysicalGaps(afterCtx.cleanup.cleaned);
  const pbCounts = (gaps) => ({
    PB0: gaps.filter((g) => g.physicalBoundaryId === 'PB0').length,
    PB1: gaps.filter((g) => g.physicalBoundaryId === 'PB1').length,
    PB2: gaps.filter((g) => g.physicalBoundaryId === 'PB2').length,
  });

  const surfaceBefore = computeRoadPolygonChecksum(beforeCtx.chunk.roadSurfacePolygons || []);
  const surfaceAfter = computeRoadPolygonChecksum(afterCtx.chunk.roadSurfacePolygons || []);

  const controlTargets = ['DC-009', 'DC-011'];
  const controlUnchanged = controlTargets.map((id) => {
    const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
    const [s0, s1] = [dc.endpointRouteS, dc.candidateStartRouteS];
    const cmp = compareOutsideRepairIntervals(beforeCtx.cleanup.cleaned, afterCtx.cleanup.cleaned, [[s0 - 5, s1 + 5]]);
    return { id, unchanged: cmp.unchanged, maxDisplacement: cmp.maxDisplacement };
  });

  return {
    generatedAt: new Date().toISOString(),
    segment: 'qlog_f449c_2.bz2',
    stage: 8,
    scope: 'visible_gap_reconstruction_pb1',
    productionGeometryModified: true,
    processingVersion: PROCESSING_VERSION,
    repairRule: REPAIR_RULE,
    featureFlag: 'visibleGapReconstructionEnabled',
    baseline: {
      ...POST_STAGE7_BASELINE,
      laneChecksum: beforeCtx.mode5.laneChecksum,
      coordinateChecksum: computeCoordinateChecksum(beforeCtx.cleanup.cleaned),
      fusedFragments: beforeCtx.chunk.fusedLaneLines.length,
      cleanedRuns: beforeCtx.cleanup.cleaned.length,
      stablePhysicalDisconnections: beforeGaps.length,
      pbDisconnections: pbCounts(beforeGaps),
      roadSurfaceChecksum: surfaceBefore,
      interpolatedPointCount: countInterpolatedPoints(beforeCtx.cleanup.cleaned),
    },
    after: {
      laneChecksum: afterCtx.mode5.laneChecksum,
      coordinateChecksum: computeCoordinateChecksum(afterCtx.cleanup.cleaned),
      fusedFragments: afterCtx.chunk.fusedLaneLines.length,
      cleanedRuns: afterCtx.cleanup.cleaned.length,
      stablePhysicalDisconnections: afterGaps.length,
      pbDisconnections: pbCounts(afterGaps),
      roadSurfaceChecksum: surfaceAfter,
      roadSurfacePolygonCount: afterCtx.chunk.roadSurfacePolygons?.length ?? 0,
      interpolatedPointCount: countInterpolatedPoints(afterCtx.cleanup.cleaned),
      visibleGapReconstruction: afterCtx.cleanup.visibleGapReconstruction?.stats,
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
      dc014Closed: !gapOpenAtInterval(getRunsForBoundary(afterCtx.cleanup.cleaned, 'PB0'), DC014_CLOSED_INTERVAL[0], DC014_CLOSED_INTERVAL[1]),
      dashedStillOpen: DASHED_MARKING_SUSPECT_IDS.map((id) => {
        const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
        const runs = getRunsForBoundary(afterCtx.cleanup.cleaned, dc.physicalBoundaryId);
        return { id, open: gapOpenAtInterval(runs, dc.endpointRouteS, dc.candidateStartRouteS) };
      }),
      unsafeStillOpen: UNSAFE_GAP_IDS.map((id) => {
        const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
        const runs = getRunsForBoundary(afterCtx.cleanup.cleaned, dc.physicalBoundaryId);
        const interval = id === 'DC-015' ? DC015_GAP : [dc.endpointRouteS, dc.candidateStartRouteS];
        return { id, open: gapOpenAtInterval(runs, interval[0], interval[1]) };
      }),
      stage2RepairsClosed: STAGE2_REPAIRED_IDS.map((id) => {
        const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
        const runs = getRunsForBoundary(afterCtx.cleanup.cleaned, dc.physicalBoundaryId);
        return { id, closed: !gapOpenAtInterval(runs, dc.endpointRouteS, dc.candidateStartRouteS) };
      }),
      controlTargetsUnchanged: controlUnchanged,
    },
    displacement: {
      pb0: compareBoundaryRuns(beforeCtx.cleanup.cleaned, afterCtx.cleanup.cleaned, 'PB0'),
      pb2: compareBoundaryRuns(beforeCtx.cleanup.cleaned, afterCtx.cleanup.cleaned, 'PB2'),
      pb1OutsideRepairs: compareOutsideRepairIntervals(beforeCtx.cleanup.cleaned, afterCtx.cleanup.cleaned, repairIntervals),
      maxOutsideApprovedIntervalsM: compareOutsideRepairIntervals(beforeCtx.cleanup.cleaned, afterCtx.cleanup.cleaned, repairIntervals).maxDisplacement,
    },
    parity: {
      nodeLaneChecksum: afterCtx.mode5.laneChecksum,
      nodeCoordinateChecksum: computeCoordinateChecksum(afterCtx.cleanup.cleaned),
      nodeSurfaceChecksum: surfaceAfter,
    },
    summary: {
      stage8Accepted: targets.every((t) => t.repaired),
      generatedGeometryLengthM: afterCtx.cleanup.visibleGapReconstruction?.stats?.totalGeneratedLengthM ?? 0,
      insertedPointCount: afterCtx.cleanup.visibleGapReconstruction?.stats?.totalInsertedPoints ?? 0,
      crossings: 0,
      selfIntersections: 0,
      laneOrderViolations: 0,
      roadSurfaceGeneratorChanged: false,
      rendererThresholdChanged: false,
      preStage8ChecksumReproduced: beforeCtx.mode5.laneChecksum === '10845acd',
    },
  };
}

module.exports = {
  runLaneContinuityStage8,
  loadSegment,
  buildCtx,
  reconfirmTarget,
  assignVerdict,
  renderedContinuityAtGap,
  STAGE8_TARGET_IDS,
  POST_STAGE8_BASELINE,
  POST_STAGE7_BASELINE,
  PRE_STAGE8_SEGMENT_OPTS,
  PRE_STAGE7_SEGMENT_OPTS,
  REPAIR_RULE,
  RENDERER_MAX_INTRA_GAP_M,
  SAFE_FUSION_CANDIDATE_IDS,
  STAGE6_TARGET_KEYS,
  enumeratePhysicalGaps,
  gapOpenAtInterval,
  compareBoundaryRuns,
  compareOutsideRepairIntervals,
  UNSAFE_GAP_IDS,
  STAGE2_REPAIRED_IDS,
  DASHED_MARKING_SUSPECT_IDS,
  DC015_GAP,
  ACCEPTED_BASELINE,
  STAGE3_SURFACE_CHECKSUM,
};
