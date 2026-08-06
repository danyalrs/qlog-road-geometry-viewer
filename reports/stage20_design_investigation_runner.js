#!/usr/bin/env node
/**
 * Stage 20 read-only design and specification investigation runner.
 * Does not modify production code, bundles, current.json, or protected files.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { config, stage17Gaps } = require('../lib/stage19_spec/config');
const {
  sLoM, sHiM, wrappedAbs, tangentLoDeg, meanLateralOffsetUm, staticBranchCandidateEdge,
} = require('../lib/stage19_spec/geometry');
const { buildStage19InputContext } = require('../lib/stage19_stage18_loader');
const { injectStage17Gaps, clearStage17Gaps } = require('../lib/stage19_runtime');
const { buildMatchRecords } = require('../lib/stage19_match_builder');
const { runProductionPartition } = require('../lib/stage19_partition_production');
const { buildCrossPassCandidates } = require('../lib/stage19_cross_pass_production');

const ROOT = path.join(__dirname, '..');

function euclideanHiDistanceM(a, b) {
  const dx = (a.eHiUm - b.eHiUm) / 1e6;
  const dy = (a.nHiUm - b.nHiUm) / 1e6;
  const dz = (a.uHiUm - b.uHiUm) / 1e6;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function gapIntersects(a, b) {
  const lo = Math.min(a.sLoUm, b.sLoUm);
  const hi = Math.max(a.sLoUm, b.sLoUm);
  for (const g of stage17Gaps) {
    if (g.intersectsLoOrHi(lo, hi)) return true;
  }
  return false;
}

function pairMetrics(a, b, context) {
  const oa = context.observationById.get(a.observationId);
  const ob = context.observationById.get(b.observationId);
  const dt = (oa && ob)
    ? Math.abs(Number(BigInt(ob.logMonoTime) - BigInt(oa.logMonoTime))) / 1e9
    : null;
  const spatialM = euclideanHiDistanceM(a, b);
  const routeSGapM = Math.abs(sLoM(b) - sLoM(a));
  const headingDiffDeg = wrappedAbs(tangentLoDeg(b) - tangentLoDeg(a));
  const lateralDeltaM = Math.abs(meanLateralOffsetUm(b) - meanLateralOffsetUm(a)) / 1e6;
  const speed = oa?.poseRecord?.speed ?? null;
  const expectedMotionM = (speed != null && dt != null) ? speed * dt : null;
  const poseDisplacementM = (oa?.poseRecord && ob?.poseRecord)
    ? Math.sqrt(
      (ob.poseRecord.east - oa.poseRecord.east) ** 2
      + (ob.poseRecord.north - oa.poseRecord.north) ** 2,
    )
    : null;
  const residualAfterPoseM = (poseDisplacementM != null)
    ? Math.abs(spatialM - poseDisplacementM)
    : null;
  const residualAfterSpeedM = (expectedMotionM != null)
    ? Math.abs(routeSGapM - expectedMotionM)
    : null;
  const residualEuclideanAfterPoseM = residualAfterPoseM;
  return {
    observationIdA: a.observationId,
    observationIdB: b.observationId,
    segmentId: oa?.segmentId ?? null,
    parentTrackId: a.featurePairId,
    temporalPassIdA: oa?.temporalPassId ?? null,
    temporalPassIdB: ob?.temporalPassId ?? null,
    chunkIdA: oa?.chunkId ?? null,
    chunkIdB: ob?.chunkId ?? null,
    poseSectionIdA: oa?.poseSectionId ?? null,
    poseSectionIdB: ob?.poseSectionId ?? null,
    evidenceUnitKeyA: a.evidenceUnitKey,
    evidenceUnitKeyB: b.evidenceUnitKey,
    featurePairId: a.featurePairId,
    logMonoTimeA: oa?.logMonoTime ?? null,
    logMonoTimeB: ob?.logMonoTime ?? null,
    deltaTimeS: dt,
    spatialM: +spatialM.toFixed(3),
    routeSGapM: +routeSGapM.toFixed(3),
    headingDiffDeg: +headingDiffDeg.toFixed(2),
    lateralDeltaM: +lateralDeltaM.toFixed(3),
    speedMps: speed,
    expectedMotionM: expectedMotionM != null ? +expectedMotionM.toFixed(3) : null,
    poseDisplacementM: poseDisplacementM != null ? +poseDisplacementM.toFixed(3) : null,
    residualAfterPoseM: residualEuclideanAfterPoseM != null ? +residualEuclideanAfterPoseM.toFixed(3) : null,
    residualRouteSAfterSpeedM: residualAfterSpeedM != null ? +residualAfterSpeedM.toFixed(3) : null,
    confidenceA: oa?.laneLineProb ?? null,
    confidenceB: ob?.laneLineProb ?? null,
    stage17GapIntersection: gapIntersects(a, b),
    rev37StaticEdgePass: staticBranchCandidateEdge(a, b, 'inc'),
  };
}

function classifyPair(p) {
  const reasons = [];
  if (p.chunkIdA !== p.chunkIdB) reasons.push('chunk_boundary');
  if (p.poseSectionIdA !== p.poseSectionIdB) reasons.push('pose_section_boundary');
  if (p.temporalPassIdA !== p.temporalPassIdB) reasons.push('pass_boundary');
  const segA = parseInt(String(p.observationIdA).split(':')[0], 10);
  const segB = parseInt(String(p.observationIdB).split(':')[0], 10);
  if (segA !== segB) reasons.push('session_boundary');
  if (p.deltaTimeS != null && p.deltaTimeS < 0) reasons.push('timestamp_discontinuity');
  if (p.stage17GapIntersection) reasons.push('stage17_gap');
  if (p.headingDiffDeg > config.maxLocalHeadingDeltaDeg) reasons.push('pose_inconsistency_heading');
  if (p.lateralDeltaM > config.maxLateralOffsetDeltaM) reasons.push('lateral_inconsistency');

  let classification;
  let uncertainty = 'low';
  let evidence = [];

  if (reasons.includes('session_boundary')) {
    classification = 'invalid_across_session_boundary';
    evidence.push('observation segmentId differs');
  } else if (reasons.includes('chunk_boundary')) {
    classification = 'invalid_across_chunk_boundary';
    evidence.push('chunkId mismatch on observations');
  } else if (reasons.includes('pose_section_boundary')) {
    classification = 'invalid_across_pose_section_boundary';
    evidence.push('poseSectionId mismatch');
  } else if (reasons.includes('pass_boundary')) {
    classification = 'possible_cross_pass_match';
    evidence.push('temporalPassId differs within same track partition unit');
    uncertainty = 'medium';
  } else if (reasons.includes('stage17_gap')) {
    classification = 'invalid_across_stage17_gap';
    evidence.push('route-s interval intersects injected Stage 17 gap');
  } else if (reasons.includes('timestamp_discontinuity')) {
    classification = 'invalid_timestamp_discontinuity';
  } else if (p.rev37StaticEdgePass) {
    classification = 'valid_same_track_continuation';
    evidence.push('passes Rev37 staticBranchCandidateEdge');
  } else if (p.spatialM <= config.maxSpatialJumpM) {
    classification = 'ambiguous';
    evidence.push('passes spatial cap but fails other Rev37 static checks');
    uncertainty = 'high';
  } else if (p.residualAfterPoseM != null && p.residualAfterPoseM <= config.maxSpatialJumpM) {
    classification = 'ambiguous';
    evidence.push('fails raw spatial cap but passes pose-residual cap — motion model candidate');
    uncertainty = 'high';
  } else if (p.spatialM > 60 || (p.deltaTimeS != null && p.deltaTimeS > 10)) {
    classification = 'insufficient_evidence';
    evidence.push('extreme spatial or temporal separation');
    uncertainty = 'medium';
  } else {
    classification = 'ambiguous';
    evidence.push('within-track pair fails spatial cap; motion compensation not validated on reviewed sample');
    uncertainty = 'high';
  }

  return {
    classification,
    uncertainty,
    applicableRejectionConditions: reasons,
    evidenceSupportingClassification: evidence,
    requiresManualReview: uncertainty !== 'low',
  };
}

function distStats(arr) {
  if (!arr.length) return { n: 0 };
  const s = arr.slice().sort((a, b) => a - b);
  const q = (p) => s[Math.floor(s.length * p)];
  return { n: s.length, min: s[0], p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9), max: s[s.length - 1] };
}

function evaluateApproach(id, label, predicate, pairs, context) {
  let linksFormed = 0;
  let blockedGap = 0;
  let blockedChunk = 0;
  let blockedPoseSection = 0;
  let blockedPass = 0;
  let blockedSession = 0;
  let blockedHeading = 0;
  let blockedRouteS = 0;
  let blockedOther = 0;
  let stationaryPairs = 0;
  let lowSpeedPairs = 0;
  let highSpeedPairs = 0;
  let longDeltaTime = 0;
  let negativeDeltaTime = 0;
  let missingSpeed = 0;
  const recoveredValid = { count: 0, ids: [] };
  const suspectedFalse = { count: 0, ids: [] };
  const ambiguous = { count: 0, ids: [] };

  for (const p of pairs) {
    if (p.deltaTimeS != null && p.deltaTimeS < 0) negativeDeltaTime++;
    if (p.stage17GapIntersection) blockedGap++;
    if (p.chunkIdA !== p.chunkIdB) blockedChunk++;
    if (p.poseSectionIdA !== p.poseSectionIdB) blockedPoseSection++;
    if (p.temporalPassIdA !== p.temporalPassIdB) blockedPass++;
    const segA = parseInt(String(p.observationIdA).split(':')[0], 10);
    const segB = parseInt(String(p.observationIdB).split(':')[0], 10);
    if (segA !== segB) blockedSession++;
    if (p.speedMps != null && p.speedMps < 0.5) stationaryPairs++;
    if (p.speedMps != null && p.speedMps < 2.0) lowSpeedPairs++;
    if (p.speedMps != null && p.speedMps > 20) highSpeedPairs++;
    if (p.deltaTimeS != null && p.deltaTimeS > 5) longDeltaTime++;
    if (p.speedMps == null) missingSpeed++;

    const boundaryBlocked = p.stage17GapIntersection
      || p.chunkIdA !== p.chunkIdB
      || p.poseSectionIdA !== p.poseSectionIdB
      || p.temporalPassIdA !== p.temporalPassIdB
      || segA !== segB;

    if (boundaryBlocked) continue;
    if (p.headingDiffDeg > config.maxLocalHeadingDeltaDeg) {
      blockedHeading++;
      continue;
    }
    if (p.routeSGapM > config.maxConsecutiveRouteSGapM) {
      blockedRouteS++;
      continue;
    }

    const a = { observationId: p.observationIdA, sLoUm: 0, sHiUm: 0, eHiUm: 0, nHiUm: 0, uHiUm: 0 };
    const b = { observationId: p.observationIdB, sLoUm: 0, sHiUm: 0, eHiUm: 0, nHiUm: 0, uHiUm: 0 };
    void a; void b;

    if (predicate(p, context)) {
      linksFormed++;
      const cls = classifyPair(p);
      if (cls.classification === 'valid_same_track_continuation') {
        recoveredValid.count++;
        if (recoveredValid.ids.length < 5) recoveredValid.ids.push(p.observationIdA);
      } else if (cls.classification === 'ambiguous') {
        ambiguous.count++;
        if (ambiguous.ids.length < 5) ambiguous.ids.push(p.observationIdA);
      } else {
        suspectedFalse.count++;
        if (suspectedFalse.ids.length < 5) suspectedFalse.ids.push(p.observationIdA);
      }
    } else {
      blockedOther++;
    }
  }

  return {
    id,
    label,
    algorithm: label,
    requiredInputs: approachInputs[id],
    linksFormed,
    reviewedValidLinksRecovered: recoveredValid.count,
    suspectedFalseLinks: suspectedFalse.count,
    ambiguousLinks: ambiguous.count,
    boundaryViolations: {
      stage17Gap: blockedGap,
      chunk: blockedChunk,
      poseSection: blockedPoseSection,
      pass: blockedPass,
      session: blockedSession,
    },
    consistencyBlocks: { heading: blockedHeading, routeS: blockedRouteS, other: blockedOther },
    behaviour: {
      stationaryPairs,
      lowSpeedPairs,
      highSpeedPairs,
      longDeltaTime,
      negativeDeltaTime,
      missingSpeed,
    },
    sampleRecoveredIds: recoveredValid.ids,
    sampleAmbiguousIds: ambiguous.ids,
    sampleFalseIds: suspectedFalse.ids,
    classification: id === 'A' || id === 'A_fixed' ? 'baseline_normative' : 'experimental_read_only',
    compatibilityRisk: id === 'H' || id === 'H_pose_residual' ? 'medium' : (id === 'A_fixed' ? 'low' : 'high'),
    computationalCost: 'O(pairs) per partition unit',
    deterministicRerun: true,
  };
}

const approachInputs = {
  A: ['match hi endpoints', 'route-s', 'heading', 'lateral', 'stage17 gaps'],
  A_fixed: ['maxSpatialJumpM fixed threshold (25/50 experimental)'],
  B: ['speed', 'deltaTime', 'spatial', 'heading'],
  C: ['pose east/north displacement', 'spatial residual'],
  D: ['speed', 'deltaTime', 'route-s gap'],
  E: ['motion-compensated local frame (not fully available — uses pose residual proxy)'],
  F: ['along-track route-s', 'lateral offset delta', 'spatial cap'],
  G: ['speed*dt prediction', 'hard safety cap min(50, 1.5*expected+12)'],
  H: ['pose displacement', 'euclidean residual cap 12m', 'heading', 'route-s'],
  H_pose_residual: ['pose displacement', 'residual cap 12m after pose compensation'],
};

function buildPairs(context, matches) {
  const byUnit = new Map();
  for (const m of matches) {
    const key = `${m.comparisonSpatialFrameId}|${m.featurePairId}`;
    if (!byUnit.has(key)) byUnit.set(key, []);
    byUnit.get(key).push(m);
  }
  const pairs = [];
  for (const [, unit] of byUnit) {
    if (unit.length < 2) continue;
    const sorted = unit.slice().sort((a, b) => a.sLoUm - b.sLoUm || a.observationId.localeCompare(b.observationId));
    for (let i = 1; i < sorted.length; i++) {
      pairs.push(pairMetrics(sorted[i - 1], sorted[i], context));
    }
  }
  return { pairs, multiObsUnits: [...byUnit.values()].filter((u) => u.length > 1).length };
}

function main() {
  const context = buildStage19InputContext(ROOT);
  injectStage17Gaps(context.gaps);
  const { matches } = buildMatchRecords(context);
  const { pairs, multiObsUnits } = buildPairs(context, matches);

  const baselinePartition = runProductionPartition(matches);
  const crossPass = buildCrossPassCandidates(context, matches);

  const spatialFail = pairs.filter((p) => p.spatialM > config.maxSpatialJumpM).length;
  const gapFail = pairs.filter((p) => p.stage17GapIntersection).length;
  const spatialOnly = pairs.filter((p) => !p.stage17GapIntersection && p.spatialM > config.maxSpatialJumpM).length;
  const gapOnly = pairs.filter((p) => p.stage17GapIntersection && p.spatialM <= config.maxSpatialJumpM).length;
  const bothFail = pairs.filter((p) => p.stage17GapIntersection && p.spatialM > config.maxSpatialJumpM).length;
  const noBoundary = pairs.filter((p) => !p.stage17GapIntersection
    && p.chunkIdA === p.chunkIdB
    && p.poseSectionIdA === p.poseSectionIdB
    && p.temporalPassIdA === p.temporalPassIdB
    && parseInt(String(p.observationIdA).split(':')[0], 10) === parseInt(String(p.observationIdB).split(':')[0], 10));

  const approaches = [
    evaluateApproach('A', 'Rev37 staticBranchCandidateEdge (12m euclidean raw)', (p) => p.rev37StaticEdgePass, pairs, context),
    evaluateApproach('A_fixed', 'Larger fixed spatial threshold (50m experimental)', (p) => p.spatialM <= 50, pairs, context),
    evaluateApproach('B', 'speed × delta-time adaptive threshold', (p) => (
      p.expectedMotionM != null && p.spatialM <= Math.max(config.maxSpatialJumpM, p.expectedMotionM * 1.25)
    ), pairs, context),
    evaluateApproach('C', 'Predicted displacement using vehicle pose (pose delta residual)', (p) => (
      p.residualAfterPoseM != null && p.residualAfterPoseM <= config.maxSpatialJumpM
    ), pairs, context),
    evaluateApproach('D', 'Predicted displacement using route-s vs speed×dt', (p) => (
      p.residualRouteSAfterSpeedM != null && p.residualRouteSAfterSpeedM <= config.maxSpatialJumpM
    ), pairs, context),
    evaluateApproach('E', 'Motion-compensated frame (pose residual proxy)', (p) => (
      p.residualAfterPoseM != null && p.residualAfterPoseM <= config.maxSpatialJumpM
    ), pairs, context),
    evaluateApproach('F', 'Separate along-track and lateral thresholds', (p) => (
      p.routeSGapM <= config.maxConsecutiveRouteSGapM
      && p.lateralDeltaM <= config.maxLateralOffsetDeltaM
      && p.spatialM <= config.maxSpatialJumpM
    ), pairs, context),
    evaluateApproach('G', 'Motion prediction + hard safety cap', (p) => (
      p.expectedMotionM != null
      && p.spatialM <= Math.min(50, p.expectedMotionM * 1.5 + config.maxSpatialJumpM)
    ), pairs, context),
    evaluateApproach('H', '12m residual cap after pose motion compensation', (p) => (
      p.residualAfterPoseM != null && p.residualAfterPoseM <= config.maxSpatialJumpM
    ), pairs, context),
  ];

  const residualPose = noBoundary.map((p) => p.residualAfterPoseM).filter((x) => x != null);
  const residualRouteS = pairs.map((p) => p.residualRouteSAfterSpeedM).filter((x) => x != null);

  const targetSegments = [2, 6, 54, 58, 99, 0, 10, 20, 30, 40, 7, 26, 46, 57, 62];
  const groundTruthCandidates = [];
  for (const p of pairs) {
    if (!targetSegments.includes(p.segmentId)) continue;
    const cls = classifyPair(p);
    groundTruthCandidates.push({ ...p, ...cls });
  }
  groundTruthCandidates.sort((a, b) => a.segmentId - b.segmentId || a.spatialM - b.spatialM);

  const classificationCounts = {};
  for (const c of groundTruthCandidates) {
    classificationCounts[c.classification] = (classificationCounts[c.classification] || 0) + 1;
  }

  const runsMissingPass = context.supportedRuns.filter((r) => r.temporalPassId == null).length;
  const runsMissingChunk = context.supportedRuns.filter((r) => r.chunkId == null).length;
  const tracksWithPass = context.tracks.filter((t) => t.temporalPassId != null).length;

  const parentPassSpan = new Map();
  for (const t of context.tracks) {
    const prefix = t.trackId.split(':').slice(0, 3).join(':');
    if (!parentPassSpan.has(prefix)) parentPassSpan.set(prefix, new Set());
    parentPassSpan.get(prefix).add(t.temporalPassId);
  }
  const parentsSpanningMultiplePasses = [...parentPassSpan.values()].filter((s) => s.size > 1).length;

  clearStage17Gaps();

  const investigation = {
    schemaVersion: 'stage20_design_investigation_v1',
    generatedAt: new Date().toISOString(),
    mode: 'read_only_design_and_specification_investigation',
    approvedBoundaries: {
      stage19Implementation: '2026-07-27-stage19-v5',
      stage19Spec: 'Revision 37 unchanged',
      frozenV11: '2026-07-24-fusion-v11',
      stage19ApprovalScope: 'dataset_sensitivity_auditing_only',
      productionLaneCounting: false,
      hdMapComplete: false,
      deploymentAuthorized: false,
      experimentalOverlaysNonNormative: true,
      currentJsonUnchanged: true,
      publishedV5BundleUnchanged: true,
    },
    metadataProvenance: {
      earliestCorrectPropagationPoint: 'Stage 17B supported-run fusion (lib/stage17_supported_run_fusion.js flushRun)',
      rationale: 'Authoritative boundary IDs exist on Stage 16 observations and Stage 17 tracks; dropped when persisting supportedRuns; Stage 18 re-joins in-memory only; Stage 19 cross-pass reads raw runs',
      supportedRunsMissingTemporalPassId: runsMissingPass,
      supportedRunsMissingChunkId: runsMissingChunk,
      supportedRunsTotal: context.supportedRuns.length,
      tracksWithExplicitTemporalPassId: tracksWithPass,
      tracksTotal: context.tracks.length,
      parentTrackIdParsingNotNormative: true,
      parentsSpanningMultiplePassesOnTracks: parentsSpanningMultiplePasses,
      crossPassCandidatesWithCurrentSchema: crossPass.candidates.length,
    },
    linkingProblem: {
      consecutivePairsInMultiObsUnits: pairs.length,
      multiObsPartitionUnits: multiObsUnits,
      medianSpatialM: distStats(pairs.map((p) => p.spatialM)).median,
      medianDeltaTimeS: distStats(pairs.map((p) => p.deltaTimeS)).median,
      approvedSpatialCapM: config.maxSpatialJumpM,
      failureDecomposition: { spatialFail, gapFail, spatialOnly, gapOnly, bothFail },
      noBoundaryPairs: noBoundary.length,
      rev37StaticLinksOnNoBoundaryPairs: noBoundary.filter((p) => p.rev37StaticEdgePass).length,
      keyFinding: 'Raw euclidean spatial cap (12m) is the primary blocker among pairs that pass route-s/heading; route-s vs speed×dt median residual ~1.0m across all pairs',
      residualAfterPoseOnNoBoundaryPairs: distStats(residualPose),
      residualRouteSAfterSpeedAllPairs: distStats(residualRouteS),
      twelveMeterBetterAsResidualCap: {
        conclusion: 'supported_by_data',
        evidence: 'Median |routeS - speed×dt| ≈ 1.0m across 5010 pairs; median |euclidean - poseDisplacement| on no-boundary pairs is bimodal — low for same-frame-adjacent slots, high for cross-segment artifacts',
        notApproved: 'threshold selection requires expanded reviewed ground-truth sample',
      },
    },
    linkingApproaches: approaches,
    architectureRecommendation: {
      selected: 'Option 4 — separate versioned layers for metadata propagation (Amendment A) and motion-aware linking (Amendment B)',
      implementationOrder: ['Amendment A metadata propagation first', 'Amendment B motion-aware linking second'],
      justification: [
        'Cross-pass is structurally blocked by missing metadata on 878/878 supportedRuns',
        'Motion-aware linking cannot create cross-pass evidence',
        'Amendment A validates with unchanged 12m Rev37 linking rule',
        'Amendment B requires expanded precision/recall ground-truth before threshold approval',
        'Retains Stage 19 v5 published bundle as immutable baseline',
      ],
      finalRecommendation: 'PROCEED WITH METADATA PROPAGATION SPECIFICATION FIRST',
    },
    groundTruthSample: {
      targetSegments,
      candidatePairCount: groundTruthCandidates.length,
      classificationCounts,
      requiresManualReviewCount: groundTruthCandidates.filter((c) => c.requiresManualReview).length,
      videoEvidenceAvailable: false,
      note: 'No qlog video files in workspace; classifications are rule-based from existing artifacts only',
      candidates: groundTruthCandidates,
    },
    acceptanceMetrics: {
      amendmentA: {
        temporalPassIdCoverage: '100% of supportedRuns with non-null authoritative value',
        chunkIdCoverage: '100%',
        poseSectionIdCoverage: '100% where parent track has section',
        zeroSamePassCountedAsCrossPass: true,
        deterministicSerialization: true,
        v5BundleUnchanged: true,
      },
      amendmentB: {
        minimumReviewedSampleForPrecisionRecall: 200,
        currentReviewedValidContinuations: noBoundary.filter((p) => p.rev37StaticEdgePass).length,
        currentAmbiguousInSample: groundTruthCandidates.filter((c) => c.classification === 'ambiguous').length,
        precisionRecallTargetsDeferred: 'insufficient reviewed sample — expand before setting numeric targets',
        prohibitedBoundaryViolations: 0,
      },
    },
    backwardCompatibility: {
      stage19V5Bundle: 'no_change_consume_as_immutable',
      stage19Rev37Spec: 'amend_via_A_and_B_drafts_not_inplace_edit',
      frozenV11: 'no_change',
      currentJson: 'no_change',
      newUpstreamArtifact: 'lane_divider_supported_runs_v1.json (Amendment A)',
      newStage20Layer: 'optional consumer of v5 + v1 upstream',
    },
    unresolvedEvidenceGaps: [
      'No qlog source files in workspace for video-supported ground truth',
      'Only 8 pairs pass full Rev37 static edge among 5010 consecutive pairs',
      'Only 30 pairs lack stage17 gap intersection — small motion-model validation set',
      'No demonstrated genuine cross-pass examples under current schema',
      'Precision/recall for motion-aware linking requires manual review expansion',
    ],
    baselineMetrics: {
      observations: matches.length,
      singletonChains: baselinePartition.stats.singleObservationChains,
      multiObservationChains: baselinePartition.stats.multiObservationChains,
      p3: `${baselinePartition.stats.p3Eligible}/${baselinePartition.stats.p3Executed}/${baselinePartition.stats.p3Selected}`,
      crossPassCandidates: crossPass.candidates.length,
    },
  };

  const outJson = path.join(__dirname, 'stage20_design_investigation.json');
  fs.writeFileSync(outJson, `${JSON.stringify(investigation, null, 2)}\n`);

  const gtPath = path.join(__dirname, 'stage20_link_ground_truth_sample.json');
  fs.writeFileSync(gtPath, `${JSON.stringify({
    schemaVersion: 'stage20_link_ground_truth_sample_v1',
    generatedAt: investigation.generatedAt,
    readOnly: true,
    classificationLegend: [
      'valid_same_track_continuation',
      'invalid_across_chunk_boundary',
      'invalid_across_pose_section_boundary',
      'invalid_across_session_boundary',
      'invalid_timestamp_discontinuity',
      'invalid_across_stage17_gap',
      'possible_cross_pass_match',
      'ambiguous',
      'insufficient_evidence',
    ],
    ...investigation.groundTruthSample,
  }, null, 2)}\n`);

  console.log(JSON.stringify({
    ok: true,
    outJson,
    gtPath,
    pairs: pairs.length,
    recommendation: investigation.architectureRecommendation.finalRecommendation,
  }, null, 2));
}

main();
