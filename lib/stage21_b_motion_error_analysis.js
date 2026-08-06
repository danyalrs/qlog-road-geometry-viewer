'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { config } = require('./stage19_spec/config');
const { parseObservationEndpoint, finitePoints } = require('./stage20_b_motion_review_playback');
const {
  joinAutomaticAndManual,
} = require('./stage20_b_motion_baseline_compare');

function sha256File(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const EXPECTED_FP_INDICES = Object.freeze([22, 25, 46, 56, 75, 92, 98, 131, 132, 170, 174]);
const EXPECTED_FN_INDICES = Object.freeze([
  0, 1, 2, 3, 57, 101, 121, 123, 124, 125, 126, 128, 129, 139, 140, 142, 145, 186, 187, 206, 207, 210,
]);

const FP_CATEGORIES = Object.freeze([
  'divider_rank_swap',
  'divider_side_swap',
  'divider_crossing',
  'lane_target_association_error',
  'road_edge_association_change',
  'residual_accepts_identity_switch',
  'manual_label_suspect',
  'insufficient_structured_evidence',
  'other',
]);

const FN_CATEGORIES = Object.freeze([
  'valid_high_residual_continuation',
  'vehicle_motion_not_compensated',
  'pose_transform_error',
  'coordinate_frame_mismatch',
  'stable_rank_despite_high_residual',
  'curvature_or_shape_change',
  'residual_cap_rejection',
  'manual_label_suspect',
  'insufficient_structured_evidence',
  'other',
]);

const DEFAULT_INPUTS = Object.freeze({
  manualReviewsPath: 'deliverables/stage20-b-motion-manual-reviews-qc-v1.json',
  automaticManifestPath: 'deliverables/stage20-b-motion-evidence-review-manifest.json',
  baselineComparisonPath: 'deliverables/stage20-b-motion-baseline-comparison.json',
  baselineDisagreementsPath: 'deliverables/stage20-b-motion-baseline-disagreements.json',
});

const RANK_ANCHOR_MODEL_X_M = 15;

function noteMatches(note, patterns) {
  const text = (note || '').toLowerCase();
  return patterns.some((re) => re.test(text));
}

function noteMentionsRankSwap(note) {
  return noteMatches(note, [
    /changes lane order|lane order swap|order swap|swaps rank|changes order|rank swap|uppermost|lowest detected|above another divider|below another divider|neighbouring divider|neighboring divider|swaps sides/,
  ]);
}

function noteMentionsSideSwap(note) {
  return noteMatches(note, [/left in frame a.*right in frame b|right in frame a.*left in frame b|swaps sides|crossed over/]);
}

function noteMentionsCrossing(note) {
  return noteMatches(note, [/crossing|crossed|cross the lane/]);
}

function noteMentionsRoadEdge(note) {
  return noteMatches(note, [/road edge|orange edge|road-edge/]);
}

function noteMentionsStableContinuation(note) {
  return noteMatches(note, [/same relative position|consistent shape|smooth shift|no jump|no crossing|preserves/]);
}

function lateralAtAnchor(lane, anchorX = RANK_ANCHOR_MODEL_X_M) {
  const points = finitePoints(lane.points);
  if (!points.length) return null;
  let best = points[0];
  let bestDist = Math.abs(points[0].x - anchorX);
  for (const p of points) {
    const d = Math.abs(p.x - anchorX);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best.y;
}

function deriveDividerRankFromFrame(frame, sourceSlotIndex) {
  const lanes = frame?.laneLines || [];
  if (!lanes.length) {
    return { available: false, reason: 'no_lane_lines_in_frame' };
  }

  const laterals = [];
  for (const lane of lanes) {
    const lat = lateralAtAnchor(lane);
    if (lat != null) laterals.push({ laneIndex: lane.laneIndex, lateral: lat });
  }
  if (!laterals.length) {
    return { available: false, reason: 'no_finite_lane_geometry_at_anchor' };
  }

  laterals.sort((a, b) => b.lateral - a.lateral);
  const targetIdx = laterals.findIndex((l) => l.laneIndex === sourceSlotIndex);
  if (targetIdx < 0) {
    return {
      available: false,
      reason: 'target_sourceSlotIndex_not_present_in_frame_lane_lines',
      laneCount: laterals.length,
      presentLaneIndices: laterals.map((l) => l.laneIndex),
    };
  }

  return {
    available: true,
    rankFromTop: targetIdx,
    dividerCount: laterals.length,
    dividersAbove: targetIdx,
    dividersBelow: laterals.length - targetIdx - 1,
    lateralAtAnchorM: +laterals[targetIdx].lateral.toFixed(4),
    rankOrderLaneIndices: laterals.map((l) => l.laneIndex),
    method: `sort_lane_dividers_by_lateral_north_at_anchor_modelX_${RANK_ANCHOR_MODEL_X_M}m`,
    disclaimer: 'sourceSlotIndex (laneIndex) is not rank; rank is derived from sorted lateral position at anchor',
  };
}

function findNearestFrameIndex(timeline, logMonoTime) {
  if (!timeline?.length || logMonoTime == null) return null;
  const target = BigInt(logMonoTime);
  let best = 0;
  let bestDiff = null;
  for (let i = 0; i < timeline.length; i++) {
    const t = BigInt(timeline[i].logMonoTime);
    const diff = t > target ? t - target : target - t;
    if (bestDiff == null || diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

function tryLoadQlogPayload(root, qlogReference) {
  if (!qlogReference) return { ok: false, reason: 'no_qlog_reference' };
  const filePath = path.join(root, qlogReference);
  if (!fs.existsSync(filePath)) return { ok: false, reason: 'qlog_not_in_workspace', qlogReference };

  try {
    const { processRoute, buildTimeline } = require('./process_route');
    const { extractFromFile: extractModel } = require('../extract_modelv2');
    const { extractFromFile: extractGps } = require('../extract_gps');
    const { serializePlaybackFrame } = require('./stage20_b_motion_review_playback');

    const modelEvents = extractModel(filePath).map((e) => ({ ...e, sourceFile: qlogReference }));
    const gpsEvents = extractGps(filePath).map((e) => ({ ...e, sourceFile: qlogReference }));
    const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
    const timeline = buildTimeline(result.frames);
    return {
      ok: true,
      frames: (result.frames || []).map((f, i) => serializePlaybackFrame(f, i)),
      timeline: (timeline || []).map((f, i) => ({ index: i, logMonoTime: String(f.logMonoTime) })),
    };
  } catch (err) {
    return { ok: false, reason: 'qlog_processing_failed', error: err.message };
  }
}

function analyzeDividerRank(pair, root, options = {}) {
  const parsedA = parseObservationEndpoint(pair.observationIdA);
  const parsedB = parseObservationEndpoint(pair.observationIdB);
  const qlog = tryLoadQlogPayload(root, pair.qlogReference);

  const result = {
    rankDerivationMethod: `lateral_sort_at_anchor_modelX_${RANK_ANCHOR_MODEL_X_M}m`,
    rankDerivationNote: 'Array index / sourceSlotIndex alone does not define physical divider rank',
    endpointA: { sourceSlotIndex: parsedA?.sourceSlotIndex ?? null },
    endpointB: { sourceSlotIndex: parsedB?.sourceSlotIndex ?? null },
    sourceSlotIndexStable: parsedA?.sourceSlotIndex != null
      && parsedA.sourceSlotIndex === parsedB?.sourceSlotIndex,
    frameA: null,
    frameB: null,
    rankStable: null,
    rankDelta: null,
    rankEvidenceStrength: 'unavailable',
  };

  if (!qlog.ok) {
    result.qlogStatus = qlog.reason;
    return result;
  }

  const idxA = findNearestFrameIndex(qlog.timeline, pair.logMonoTimeA);
  const idxB = findNearestFrameIndex(qlog.timeline, pair.logMonoTimeB);
  if (idxA == null || idxB == null) {
    result.qlogStatus = 'frame_index_not_found';
    return result;
  }

  const frameA = qlog.frames[idxA];
  const frameB = qlog.frames[idxB];
  result.frameA = deriveDividerRankFromFrame(frameA, parsedA.sourceSlotIndex);
  result.frameB = deriveDividerRankFromFrame(frameB, parsedB.sourceSlotIndex);
  result.qlogStatus = 'loaded';

  if (result.frameA.available && result.frameB.available) {
    result.rankDelta = result.frameB.rankFromTop - result.frameA.rankFromTop;
    result.rankStable = result.rankDelta === 0;
    result.rankEvidenceStrength = 'strong';
  } else {
    result.rankEvidenceStrength = 'weak';
  }

  return result;
}

function buildAutomaticDecisionPath(pair) {
  const reasons = pair.applicableRejectionConditions || [];
  const steps = [];
  if (reasons.includes('session_boundary')) steps.push('reject: session_boundary');
  else if (reasons.includes('chunk_boundary')) steps.push('reject: chunk_boundary');
  else if (reasons.includes('pose_section_boundary')) steps.push('reject: pose_section_boundary');
  else if (reasons.includes('pass_boundary')) steps.push('reject: pass_boundary');
  else if (reasons.includes('stage17_gap')) steps.push('reject: stage17_gap');
  else if (reasons.includes('timestamp_discontinuity')) steps.push('reject: timestamp_discontinuity');
  else if (pair.rev37StaticEdgePass) steps.push('accept: rev37StaticEdgePass');
  else if (pair.residualAfterPoseM != null && pair.residualAfterPoseM <= config.maxSpatialJumpM) {
    steps.push(`accept: residualAfterPoseM ${pair.residualAfterPoseM} <= ${config.maxSpatialJumpM}`);
  } else steps.push(`reject: residualAfterPoseM ${pair.residualAfterPoseM} > ${config.maxSpatialJumpM}`);

  return {
    ruleDerivedClassification: pair.ruleDerivedClassification,
    applicableRejectionConditions: reasons,
    rev37StaticEdgePass: pair.rev37StaticEdgePass,
    residualThresholdM: config.maxSpatialJumpM,
    steps,
  };
}

function buildStructuredEvidence(row, root, options = {}) {
  const pair = row.automatic;
  const manual = row.manual;
  const note = manual.reviewerNotes || '';
  const parsedA = parseObservationEndpoint(pair.observationIdA);
  const parsedB = parseObservationEndpoint(pair.observationIdB);
  const segA = parsedA?.segmentId;
  const segB = parsedB?.segmentId;
  const rankAnalysis = options.includeQlogRank === false
    ? { rankEvidenceStrength: 'skipped' }
    : analyzeDividerRank(pair, root);

  const poseDisplacementM = pair.poseDisplacementM;
  const spatialM = pair.spatialM;
  const residualAfterPoseM = pair.residualAfterPoseM;
  const residualBeforePoseM = spatialM;

  const motionGap = (poseDisplacementM != null && spatialM != null)
    ? Math.abs(poseDisplacementM - spatialM)
    : null;

  return {
    recordIndex: row.manualRecordIndex,
    reviewPairId: row.reviewPairId,
    disagreementType: row.manualBinaryLabel === 'negative' && row.automaticContinuationDecision === 'positive'
      ? 'false_positive'
      : 'false_negative',
    manualLabel: manual.reviewerLabel,
    manualNote: note,
    evidenceMode: manual.evidenceMode,
    ruleDerivedClassification: pair.ruleDerivedClassification,
    applicableRejectionConditions: pair.applicableRejectionConditions || [],
    residualBeforePoseM,
    residualAfterPoseM,
    poseDisplacementM,
    spatialM,
    headingDiffDeg: pair.headingDiffDeg,
    lateralDeltaM: pair.lateralDeltaM,
    deltaTimeS: pair.deltaTimeS,
    speedMps: pair.speedMps,
    routeSGapM: pair.routeSGapM,
    expectedMotionM: pair.expectedMotionM,
    residualRouteSAfterSpeedM: pair.residualRouteSAfterSpeedM,
    logMonoTimeA: pair.logMonoTimeA,
    logMonoTimeB: pair.logMonoTimeB,
    segmentId: pair.segmentId,
    sessionIdentity: {
      segmentIdA: segA,
      segmentIdB: segB,
      sameSegment: segA != null && segA === segB,
    },
    sourceSlotIndexA: parsedA?.sourceSlotIndex ?? null,
    sourceSlotIndexB: parsedB?.sourceSlotIndex ?? null,
    sourceSlotIndexStable: parsedA?.sourceSlotIndex != null
      && parsedA.sourceSlotIndex === parsedB?.sourceSlotIndex,
    rankAnalysis,
    roadEdgeOverlapNoteMention: noteMentionsRoadEdge(note),
    automaticDecisionPath: buildAutomaticDecisionPath(pair),
    evidenceAvailable: manual.evidenceMode !== 'insufficient' && pair.qlogReference != null,
    concepts: {
      temporalContinuation: {
        manualPositiveClaim: manual.reviewerLabel === 'positive_continuation',
        noteClaimsStable: noteMentionsStableContinuation(note),
        inferenceOnly: true,
      },
      identitySwap: {
        noteClaimsSwap: noteMentionsRankSwap(note) || noteMentionsSideSwap(note) || noteMentionsCrossing(note),
        structuredRankSwap: rankAnalysis.rankStable === false,
        structuredRankUnavailable: rankAnalysis.rankEvidenceStrength !== 'strong',
        inferenceOnly: rankAnalysis.rankEvidenceStrength !== 'strong',
      },
      roadEdgeOverlap: {
        noteMention: noteMentionsRoadEdge(note),
        inferenceOnly: true,
        notEquivalentToIdentitySwap: true,
      },
      evidenceAvailable: manual.evidenceMode !== 'insufficient',
      geometryIssue: noteMentionsRoadEdge(note) || rankAnalysis.rankStable === false,
    },
    motionInterpretation: {
      poseDisplacementNearResidual: motionGap != null && residualAfterPoseM != null
        && Math.abs(residualAfterPoseM - motionGap) < 0.5,
      spatialMuchLessThanPose: spatialM != null && poseDisplacementM != null && spatialM < poseDisplacementM * 0.2,
      evidence: motionGap != null
        ? `|poseDisplacementM - spatialM| = ${motionGap.toFixed(3)} m; residualAfterPoseM = ${residualAfterPoseM}`
        : 'insufficient pose/spatial fields',
    },
  };
}

function categorizeFalsePositive(evidence) {
  const note = evidence.manualNote;
  const reasons = [];

  if (evidence.rankAnalysis.rankStable === false) reasons.push('divider_rank_swap');
  else if (noteMentionsRankSwap(note)) reasons.push('divider_rank_swap');
  if (noteMentionsSideSwap(note)) reasons.push('divider_side_swap');
  if (noteMentionsCrossing(note)) reasons.push('divider_crossing');
  if (noteMentionsRoadEdge(note)) reasons.push('road_edge_association_change');
  if (!evidence.sourceSlotIndexStable) reasons.push('lane_target_association_error');
  if (evidence.automaticDecisionPath.ruleDerivedClassification === 'ambiguous_motion_residual_candidate'
    && (reasons.includes('divider_rank_swap') || reasons.includes('divider_side_swap') || reasons.includes('divider_crossing'))) {
    reasons.push('residual_accepts_identity_switch');
  }
  if (evidence.rankAnalysis.rankStable === true && noteMentionsRankSwap(note)) {
    reasons.push('manual_label_suspect');
  }
  if (noteMentionsStableContinuation(note) && evidence.manualLabel === 'negative_non_continuation') {
    reasons.push('manual_label_suspect');
  }

  let primary;
  if (reasons.includes('manual_label_suspect') && evidence.rankAnalysis.rankStable === true) {
    primary = 'manual_label_suspect';
  } else if (reasons.includes('divider_side_swap')) primary = 'divider_side_swap';
  else if (reasons.includes('divider_crossing')) primary = 'divider_crossing';
  else if (reasons.includes('divider_rank_swap')) primary = 'divider_rank_swap';
  else if (reasons.includes('road_edge_association_change')) primary = 'road_edge_association_change';
  else if (reasons.includes('residual_accepts_identity_switch')) primary = 'residual_accepts_identity_switch';
  else if (reasons.includes('lane_target_association_error')) primary = 'lane_target_association_error';
  else if (!evidence.evidenceAvailable) primary = 'insufficient_structured_evidence';
  else primary = 'other';

  const structuredCues = [];
  if (evidence.rankAnalysis.rankStable === false) structuredCues.push('divider_rank_instability_from_qlog_geometry');
  if (noteMentionsRankSwap(note)) structuredCues.push('reviewer_note_describes_rank_change');
  if (noteMentionsRoadEdge(note)) structuredCues.push('reviewer_note_describes_road_edge_association');
  if (!structuredCues.length) structuredCues.push('no_existing_structured_cue_can_reject_without_visual_evidence');

  return {
    primaryCategory: primary,
    secondaryCategories: [...new Set(reasons.filter((r) => r !== primary))],
    structuredCuesThatCouldReject: structuredCues,
    acceptanceReason: evidence.automaticDecisionPath.steps.join(' -> '),
    evidenceStrength: evidence.rankAnalysis.rankEvidenceStrength === 'strong' ? 'strong' : (
      noteMentionsRankSwap(note) || noteMentionsSideSwap(note) ? 'moderate' : 'weak'
    ),
  };
}

function categorizeFalseNegative(evidence) {
  const note = evidence.manualNote;
  const reasons = [];
  const residual = evidence.residualAfterPoseM;
  const threshold = config.maxSpatialJumpM;

  if (evidence.automaticDecisionPath.ruleDerivedClassification === 'ambiguous_spatial_cap_failure') {
    reasons.push('residual_cap_rejection');
  }
  if (residual != null && residual > threshold && noteMentionsStableContinuation(note)) {
    reasons.push('valid_high_residual_continuation');
  }
  if (evidence.motionInterpretation.spatialMuchLessThanPose) {
    reasons.push('vehicle_motion_not_compensated');
  }
  if (evidence.rankAnalysis.rankStable === true && residual != null && residual > threshold) {
    reasons.push('stable_rank_despite_high_residual');
  }
  if (!evidence.sessionIdentity.sameSegment) {
    reasons.push('coordinate_frame_mismatch');
  }
  if (evidence.headingDiffDeg > config.maxLocalHeadingDeltaDeg
    || evidence.lateralDeltaM > config.maxLateralOffsetDeltaM) {
    reasons.push('pose_transform_error');
  }
  if (noteMatches(note, [/shape|curv|bend/])) reasons.push('curvature_or_shape_change');
  if (evidence.rankAnalysis.rankStable === false && noteMentionsStableContinuation(note)) {
    reasons.push('manual_label_suspect');
  }

  let primary;
  if (reasons.includes('manual_label_suspect')) primary = 'manual_label_suspect';
  else if (reasons.includes('stable_rank_despite_high_residual')) primary = 'stable_rank_despite_high_residual';
  else if (reasons.includes('valid_high_residual_continuation')) primary = 'valid_high_residual_continuation';
  else if (reasons.includes('vehicle_motion_not_compensated')) primary = 'vehicle_motion_not_compensated';
  else if (reasons.includes('residual_cap_rejection')) primary = 'residual_cap_rejection';
  else if (reasons.includes('coordinate_frame_mismatch')) primary = 'coordinate_frame_mismatch';
  else if (reasons.includes('pose_transform_error')) primary = 'pose_transform_error';
  else if (reasons.includes('curvature_or_shape_change')) primary = 'curvature_or_shape_change';
  else if (!evidence.evidenceAvailable) primary = 'insufficient_structured_evidence';
  else primary = 'other';

  return {
    primaryCategory: primary,
    secondaryCategories: [...new Set(reasons.filter((r) => r !== primary))],
    rejectionReason: evidence.automaticDecisionPath.steps.join(' -> '),
    evidenceStrength: evidence.rankAnalysis.rankEvidenceStrength === 'strong' ? 'strong' : (
      evidence.motionInterpretation.spatialMuchLessThanPose ? 'strong' : 'moderate'
    ),
  };
}

function verifyInputIntegrity(inputs = {}, root) {
  const mergedInputs = { ...DEFAULT_INPUTS, ...inputs };
  const paths = {
    manualReviews: path.resolve(root, mergedInputs.manualReviewsPath),
    automaticManifest: path.resolve(root, mergedInputs.automaticManifestPath),
    baselineComparison: path.resolve(root, mergedInputs.baselineComparisonPath),
    baselineDisagreements: path.resolve(root, mergedInputs.baselineDisagreementsPath),
  };

  const hashes = Object.fromEntries(
    Object.entries(paths).map(([k, p]) => [k, sha256File(p)]),
  );

  const manualArtifact = loadJson(paths.manualReviews);
  const automaticArtifact = loadJson(paths.automaticManifest);
  const baseline = loadJson(paths.baselineComparison);
  const disagreements = loadJson(paths.baselineDisagreements);

  const join = joinAutomaticAndManual({
    automaticPairs: automaticArtifact.reviewPairs || [],
    manualReviews: manualArtifact.reviews || [],
  });

  const fpFromBaseline = disagreements.falsePositives.map((r) => r.recordIndex).sort((a, b) => a - b);
  const fnFromBaseline = disagreements.falseNegatives.map((r) => r.recordIndex).sort((a, b) => a - b);

  const expectedFp = [...EXPECTED_FP_INDICES].sort((a, b) => a - b);
  const expectedFn = [...EXPECTED_FN_INDICES].sort((a, b) => a - b);

  const issues = [];
  if (JSON.stringify(fpFromBaseline) !== JSON.stringify(expectedFp)) {
    issues.push({ code: 'fp_index_mismatch', expected: expectedFp, actual: fpFromBaseline });
  }
  if (JSON.stringify(fnFromBaseline) !== JSON.stringify(expectedFn)) {
    issues.push({ code: 'fn_index_mismatch', expected: expectedFn, actual: fnFromBaseline });
  }
  if (fpFromBaseline.length + fnFromBaseline.length !== 33) {
    issues.push({ code: 'disagreement_count_not_33', count: fpFromBaseline.length + fnFromBaseline.length });
  }

  return {
    ok: issues.length === 0
      && join.unmatchedManual.length === 0
      && join.duplicateManualPairIds.length === 0
      && join.duplicateAutomaticPairIds.length === 0,
    hashes,
    paths: Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, path.relative(root, p)])),
    joinSummary: {
      joinedCount: join.joined.length,
      unmatchedManual: join.unmatchedManual,
      unmatchedAutomatic: join.unmatchedAutomatic,
      duplicateManualPairIds: join.duplicateManualPairIds,
      duplicateAutomaticPairIds: join.duplicateAutomaticPairIds,
    },
    baselineConfusion: baseline.confusionMatrix,
    issues,
    manualFilePreserved: true,
  };
}

function selectDisagreementRows(joinedRows) {
  const byIndex = new Map(joinedRows.map((r) => [r.manualRecordIndex, r]));
  const selected = [];
  const missing = [];

  for (const idx of [...EXPECTED_FP_INDICES, ...EXPECTED_FN_INDICES]) {
    const row = byIndex.get(idx);
    if (!row) missing.push(idx);
    else selected.push(row);
  }

  return { selected, missing };
}

function buildObservationPairClusters(records) {
  const clusters = new Map();
  for (const rec of records) {
    if (rec.disagreementType !== 'false_negative') continue;
    const key = `${rec.logMonoTimeA}|${rec.logMonoTimeB}|seg${rec.segmentId}`;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(rec.recordIndex);
  }
  return [...clusters.entries()]
    .filter(([, indices]) => indices.length > 1)
    .map(([key, recordIndices]) => ({ key, recordIndices, count: recordIndices.length }))
    .sort((a, b) => b.count - a.count);
}

function buildResidualClusters(records) {
  const byResidual = new Map();
  for (const rec of records) {
    if (rec.disagreementType !== 'false_negative') continue;
    const key = rec.residualAfterPoseM != null ? rec.residualAfterPoseM.toFixed(3) : 'null';
    if (!byResidual.has(key)) byResidual.set(key, []);
    byResidual.get(key).push(rec.recordIndex);
  }
  return [...byResidual.entries()]
    .map(([residual, recordIndices]) => ({ residual: Number(residual), recordIndices, count: recordIndices.length }))
    .sort((a, b) => b.count - a.count);
}

function buildMetricConventionReport(baseline) {
  const m = baseline.metrics;
  const positiveF1 = m.positiveF1.rate;
  const macroF1ZeroConvention = positiveF1 != null ? +((positiveF1 + 0) / 2).toFixed(4) : null;

  return {
    baselineValuesUnchanged: true,
    note: 'Reporting clarification only; not an algorithm improvement',
    negativeF1NullConvention: {
      value: m.negativeF1.rate,
      reason: 'TN=0 under current rule; negative precision/recall denominators leave F1 undefined (null)',
    },
    zeroDivisionEqualsZeroConvention: {
      negativeF1: 0,
      macroF1: macroF1ZeroConvention,
      explanation: 'If undefined rates are reported as 0, macroF1 = (positiveF1 + 0) / 2',
    },
    confusionMatrix: baseline.confusionMatrix,
  };
}

function buildCandidateSignalTable(records) {
  const fpIndices = records.filter((r) => r.disagreementType === 'false_positive').map((r) => r.recordIndex);
  const fnIndices = records.filter((r) => r.disagreementType === 'false_negative').map((r) => r.recordIndex);

  const signals = [
    {
      signal: 'divider_rank_stability',
      mayCorrect: fpIndices.filter((idx) => {
        const r = records.find((x) => x.recordIndex === idx);
        return r?.rankAnalysis?.rankStable === false || noteMentionsRankSwap(r?.manualNote);
      }),
      mayDamage: fnIndices.filter((idx) => {
        const r = records.find((x) => x.recordIndex === idx);
        return r?.rankAnalysis?.rankStable === true;
      }),
      requiredFields: ['qlog laneLines at Frame A/B', 'sourceSlotIndex', 'lateral sort at anchor'],
      fieldsExist: true,
      limitation: 'Rank derivation needs visible lane geometry; sourceSlotIndex alone is insufficient',
    },
    {
      signal: 'divider_side_stability',
      mayCorrect: fpIndices.filter((idx) => noteMentionsSideSwap(records.find((x) => x.recordIndex === idx)?.manualNote)),
      mayDamage: [],
      requiredFields: ['relative lateral ordering of target vs neighbours at anchor'],
      fieldsExist: 'partial',
      limitation: 'Side relation not stored structurally; requires geometry or visual review',
    },
    {
      signal: 'crossing_detection',
      mayCorrect: fpIndices.filter((idx) => noteMentionsCrossing(records.find((x) => x.recordIndex === idx)?.manualNote)),
      mayDamage: [],
      requiredFields: ['ordered divider trajectories across frames'],
      fieldsExist: false,
      limitation: 'No crossing detector in current manifest',
    },
    {
      signal: 'road_edge_association',
      mayCorrect: fpIndices.filter((idx) => noteMentionsRoadEdge(records.find((x) => x.recordIndex === idx)?.manualNote)),
      mayDamage: fnIndices.filter((idx) => noteMentionsRoadEdge(records.find((x) => x.recordIndex === idx)?.manualNote)),
      requiredFields: ['roadEdges geometry', 'target divider proximity'],
      fieldsExist: 'partial_in_qlog_only',
      limitation: 'Overlap alone does not prove identity switch',
    },
    {
      signal: 'motion_normalised_residual',
      mayCorrect: fnIndices,
      mayDamage: fpIndices,
      requiredFields: ['spatialM', 'poseDisplacementM', 'residualAfterPoseM'],
      fieldsExist: true,
      limitation: 'Current 12 m cap accepts all low-residual identity swaps',
    },
    {
      signal: 'pose_compensated_anchor_displacement',
      mayCorrect: fnIndices.filter((idx) => {
        const r = records.find((x) => x.recordIndex === idx);
        return r?.motionInterpretation?.spatialMuchLessThanPose;
      }),
      mayDamage: [],
      requiredFields: ['poseDisplacementM', 'target anchor coordinates at A/B'],
      fieldsExist: 'partial',
      limitation: 'Pose displacement is pair-level, not divider-anchor-specific',
    },
    {
      signal: 'evidence_availability_gating',
      mayCorrect: [],
      mayDamage: [],
      requiredFields: ['evidenceMode', 'qlogReference availability'],
      fieldsExist: true,
      limitation: 'Does not resolve disagreements where evidence was available',
    },
  ];

  return signals
    .map((s) => ({
      ...s,
      likelyBenefitRank: s.mayCorrect.length - s.mayDamage.length,
    }))
    .sort((a, b) => b.likelyBenefitRank - a.likelyBenefitRank);
}

function buildErrorCategorySummary(records) {
  const summary = new Map();

  const add = (type, category, recordIndex, rule, signal, strength) => {
    const key = `${type}::${category}`;
    if (!summary.has(key)) {
      summary.set(key, {
        category,
        disagreementType: type,
        fpCount: 0,
        fnCount: 0,
        recordIndices: [],
        commonAutomaticRules: new Map(),
        candidateSignals: new Set(),
        evidenceStrength: strength,
      });
    }
    const entry = summary.get(key);
    if (type === 'false_positive') entry.fpCount += 1;
    else entry.fnCount += 1;
    entry.recordIndices.push(recordIndex);
    entry.commonAutomaticRules.set(rule, (entry.commonAutomaticRules.get(rule) || 0) + 1);
    entry.candidateSignals.add(signal);
    if (strength === 'strong') entry.evidenceStrength = 'strong';
    else if (strength === 'moderate' && entry.evidenceStrength !== 'strong') entry.evidenceStrength = 'moderate';
  };

  for (const rec of records) {
    const cat = rec.category.primaryCategory;
    const signal = rec.category.structuredCuesThatCouldReject?.[0]
      || rec.category.rejectionReason
      || rec.category.acceptanceReason
      || 'n/a';
    add(
      rec.disagreementType,
      cat,
      rec.recordIndex,
      rec.ruleDerivedClassification,
      signal,
      rec.category.evidenceStrength,
    );
  }

  return [...summary.values()].map((entry) => ({
    category: entry.category,
    fpCount: entry.fpCount,
    fnCount: entry.fnCount,
    recordIndices: entry.recordIndices.sort((a, b) => a - b),
    commonAutomaticRule: [...entry.commonAutomaticRules.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    candidateSignal: [...entry.candidateSignals][0] || null,
    evidenceStrength: entry.evidenceStrength,
  })).sort((a, b) => (b.fpCount + b.fnCount) - (a.fpCount + a.fnCount));
}

function buildManualRecheckList(records) {
  return records
    .filter((r) => r.category.primaryCategory === 'manual_label_suspect'
      || r.category.secondaryCategories?.includes('manual_label_suspect'))
    .map((r) => ({
      recordIndex: r.recordIndex,
      reviewPairId: r.reviewPairId,
      disagreementType: r.disagreementType,
      manualLabel: r.manualLabel,
      reason: r.category.primaryCategory === 'manual_label_suspect'
        ? 'structured evidence conflicts with reviewer note or label'
        : 'secondary manual_label_suspect flag',
      note: r.manualNote,
      rankStable: r.rankAnalysis?.rankStable,
      doNotAutoRevise: true,
    }));
}

function runErrorAnalysis(options = {}) {
  const root = options.root || process.cwd();
  const inputs = { ...DEFAULT_INPUTS, ...options.inputs };
  const integrity = verifyInputIntegrity(inputs, root);

  const manualArtifact = loadJson(path.resolve(root, inputs.manualReviewsPath));
  const automaticArtifact = loadJson(path.resolve(root, inputs.automaticManifestPath));
  const baseline = loadJson(path.resolve(root, inputs.baselineComparisonPath));

  const join = joinAutomaticAndManual({
    automaticPairs: automaticArtifact.reviewPairs || [],
    manualReviews: manualArtifact.reviews || [],
  });

  const disagreementRows = join.joined.filter((row) => {
    if (row.manualBinaryLabel == null) return false;
    const auto = row.automaticContinuationDecision;
    const manual = row.manualBinaryLabel;
    return (manual === 'negative' && auto === 'positive')
      || (manual === 'positive' && auto === 'negative');
  });

  const { selected, missing } = selectDisagreementRows(disagreementRows);
  if (missing.length) {
    integrity.issues.push({ code: 'missing_disagreement_records', indices: missing });
    integrity.ok = false;
  }

  const includeQlogRank = options.includeQlogRank !== false;
  const analyzed = selected.map((row) => {
    const evidence = buildStructuredEvidence(row, root, { includeQlogRank });
    const category = evidence.disagreementType === 'false_positive'
      ? categorizeFalsePositive(evidence)
      : categorizeFalseNegative(evidence);
    return { ...evidence, category };
  });

  const fpRecords = analyzed.filter((r) => r.disagreementType === 'false_positive');
  const fnRecords = analyzed.filter((r) => r.disagreementType === 'false_negative');

  const fpCategoryCounts = Object.fromEntries(FP_CATEGORIES.map((c) => [c, 0]));
  const fnCategoryCounts = Object.fromEntries(FN_CATEGORIES.map((c) => [c, 0]));
  for (const rec of fpRecords) fpCategoryCounts[rec.category.primaryCategory] += 1;
  for (const rec of fnRecords) fnCategoryCounts[rec.category.primaryCategory] += 1;

  const rankAvailableCount = analyzed.filter((r) => r.rankAnalysis?.rankEvidenceStrength === 'strong').length;

  return {
    generatedAt: new Date().toISOString(),
    stage: 'stage21-b-motion-error-analysis',
    terminology: 'QC-reviewed manual reference labels are not perfect ground truth; findings distinguish direct evidence from inference',
    inputIntegrity: integrity,
    matchedDisagreementCount: analyzed.length,
    falsePositiveCount: fpRecords.length,
    falseNegativeCount: fnRecords.length,
    records: analyzed,
    falsePositiveAnalysis: {
      count: fpRecords.length,
      allAcceptedVia: 'ambiguous_motion_residual_candidate or valid_same_track_continuation with residualAfterPoseM <= 12',
      categoryCounts: fpCategoryCounts,
      records: fpRecords,
    },
    falseNegativeAnalysis: {
      count: fnRecords.length,
      categoryCounts: fnCategoryCounts,
      observationPairClusters: buildObservationPairClusters(analyzed),
      residualClusters: buildResidualClusters(analyzed),
      clusterNotes: [
        'Indices 0-3 share logMonoTimeA/B 73700718671|75701987372 with slots 0-3; poseDisplacementM identical (40.184 m), spatialM ~2.6 m, residualAfterPoseM ~37.6 m',
        'Indices 123-126 share logMonoTime pair on segment 19 with residual ~26.3-26.6 m',
        'High residual with low spatialM indicates |spatialM - poseDisplacementM| dominated by vehicle motion, not divider mismatch',
      ],
      records: fnRecords,
    },
    errorCategorySummary: buildErrorCategorySummary(analyzed),
    candidateSignals: buildCandidateSignalTable(analyzed),
    metricConventionReport: buildMetricConventionReport(baseline),
    manualRecheckList: buildManualRecheckList(analyzed),
    rankEvidenceSummary: {
      strongRankEvidenceCount: rankAvailableCount,
      totalDisagreements: analyzed.length,
      rankDerivationMethod: `lateral_sort_at_anchor_modelX_${RANK_ANCHOR_MODEL_X_M}m`,
      disclaimer: 'sourceSlotIndex is laneIndex from observation ID, not physical divider rank',
    },
  };
}

module.exports = {
  EXPECTED_FP_INDICES,
  EXPECTED_FN_INDICES,
  FP_CATEGORIES,
  FN_CATEGORIES,
  deriveDividerRankFromFrame,
  analyzeDividerRank,
  buildStructuredEvidence,
  categorizeFalsePositive,
  categorizeFalseNegative,
  verifyInputIntegrity,
  selectDisagreementRows,
  buildMetricConventionReport,
  buildCandidateSignalTable,
  runErrorAnalysis,
  noteMentionsRoadEdge,
  RANK_ANCHOR_MODEL_X_M,
};
