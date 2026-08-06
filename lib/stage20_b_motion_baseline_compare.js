'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { config } = require('./stage19_spec/config');

const DEFAULT_MANUAL_REVIEWS_PATH = 'deliverables/stage20-b-motion-manual-reviews-qc-v1.json';
const DEFAULT_AUTOMATIC_MANIFEST_PATH = 'deliverables/stage20-b-motion-evidence-review-manifest.json';

const MANUAL_POSITIVE = 'positive_continuation';
const MANUAL_NEGATIVE = 'negative_non_continuation';
const MANUAL_UNRESOLVED = 'unresolved';

const AUTOMATIC_POSITIVE_CLASSIFICATIONS = Object.freeze([
  'valid_same_track_continuation',
  'ambiguous_motion_residual_candidate',
]);

const AUTOMATIC_NEGATIVE_CLASSIFICATIONS = Object.freeze([
  'invalid_across_session_boundary',
  'invalid_across_chunk_boundary',
  'invalid_across_pose_section_boundary',
  'invalid_across_stage17_gap',
  'invalid_timestamp_discontinuity',
  'possible_cross_pass_match',
  'ambiguous_spatial_cap_failure',
]);

const CONFIDENCE_FIELD = 'residualAfterPoseM';
const CONFIDENCE_DIRECTION = 'lower_is_stronger_continuation';
const THRESHOLD_PARAMETER = 'residualAfterPoseM';
const THRESHOLD_CAP_M = config.maxSpatialJumpM;
const THRESHOLD_OPERATOR = '<=';

const UNRESOLVED_CATEGORIES = Object.freeze([
  'missing_playback_or_frame_evidence',
  'cross_session_boundary',
  'timestamp_unavailable',
  'lane_target_mapping_failure',
  'visual_ambiguity_or_overlap',
  'other',
]);

function sha256File(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const weight = idx - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

function summarizeNumeric(values) {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!finite.length) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      median: null,
      p10: null,
      p25: null,
      p75: null,
      p90: null,
    };
  }
  const sum = finite.reduce((acc, v) => acc + v, 0);
  return {
    count: finite.length,
    min: finite[0],
    max: finite[finite.length - 1],
    mean: +(sum / finite.length).toFixed(4),
    median: +percentile(finite, 0.5).toFixed(4),
    p10: +percentile(finite, 0.1).toFixed(4),
    p25: +percentile(finite, 0.25).toFixed(4),
    p75: +percentile(finite, 0.75).toFixed(4),
    p90: +percentile(finite, 0.9).toFixed(4),
  };
}

function rateWithSupport(numerator, denominator) {
  return {
    rate: denominator > 0 ? +(numerator / denominator).toFixed(4) : null,
    numerator,
    denominator,
  };
}

function deriveAutomaticContinuationDecision(pair) {
  const classification = pair.ruleDerivedClassification;
  if (AUTOMATIC_POSITIVE_CLASSIFICATIONS.includes(classification)) {
    return {
      automaticContinuationDecision: 'positive',
      automaticDecisionSource: classification,
      automaticRejected: false,
    };
  }
  if (AUTOMATIC_NEGATIVE_CLASSIFICATIONS.includes(classification)) {
    return {
      automaticContinuationDecision: 'negative',
      automaticDecisionSource: classification,
      automaticRejected: true,
    };
  }
  return {
    automaticContinuationDecision: 'unknown',
    automaticDecisionSource: classification ?? null,
    automaticRejected: null,
  };
}

function deriveAutomaticConfidenceScore(pair) {
  const value = pair[CONFIDENCE_FIELD];
  if (value == null || !Number.isFinite(value)) {
    return {
      automaticConfidenceScore: null,
      automaticConfidenceScoreFinite: false,
      automaticConfidenceScoreMissing: true,
    };
  }
  return {
    automaticConfidenceScore: value,
    automaticConfidenceScoreFinite: true,
    automaticConfidenceScoreMissing: false,
  };
}

function manualLabelToBinary(label) {
  if (label === MANUAL_POSITIVE) return 'positive';
  if (label === MANUAL_NEGATIVE) return 'negative';
  if (label === MANUAL_UNRESOLVED) return null;
  return null;
}

function indexByPairId(records, pairIdField = 'reviewPairId') {
  const byId = new Map();
  const duplicates = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const pairId = record[pairIdField];
    if (!pairId) continue;
    if (byId.has(pairId)) {
      duplicates.push({
        reviewPairId: pairId,
        indices: [byId.get(pairId).index, i],
      });
      continue;
    }
    byId.set(pairId, { record, index: i });
  }
  return { byId, duplicates };
}

function joinAutomaticAndManual({ automaticPairs, manualReviews }) {
  const automaticIndex = indexByPairId(automaticPairs, 'reviewPairId');
  const manualIndex = indexByPairId(manualReviews, 'reviewPairId');

  const unmatchedManual = [];
  const unmatchedAutomatic = [];
  const joined = [];

  for (const [pairId, { record: manual, index: manualRecordIndex }] of manualIndex.byId) {
    const automaticEntry = automaticIndex.byId.get(pairId);
    if (!automaticEntry) {
      unmatchedManual.push({ reviewPairId: pairId, manualRecordIndex });
      continue;
    }
    const automatic = automaticEntry.record;
    const decision = deriveAutomaticContinuationDecision(automatic);
    const confidence = deriveAutomaticConfidenceScore(automatic);
    joined.push({
      reviewPairId: pairId,
      manualRecordIndex,
      automaticRecordIndex: automaticEntry.index,
      manual,
      automatic,
      manualBinaryLabel: manualLabelToBinary(manual.reviewerLabel),
      ...decision,
      ...confidence,
      automaticRuleReason: automatic.ruleDerivedClassification,
      automaticRejectionConditions: automatic.applicableRejectionConditions || [],
      rev37StaticEdgePass: automatic.rev37StaticEdgePass,
      stage17GapIntersection: automatic.stage17GapIntersection,
      segmentId: automatic.segmentId,
      logMonoTimeA: automatic.logMonoTimeA,
      logMonoTimeB: automatic.logMonoTimeB,
      qlogReference: automatic.qlogReference,
      stratificationBucket: automatic.stratificationBucket,
    });
  }

  for (const [pairId, { index: automaticRecordIndex }] of automaticIndex.byId) {
    if (!manualIndex.byId.has(pairId)) {
      unmatchedAutomatic.push({ reviewPairId: pairId, automaticRecordIndex });
    }
  }

  return {
    joined,
    unmatchedManual,
    unmatchedAutomatic,
    duplicateAutomaticPairIds: automaticIndex.duplicates,
    duplicateManualPairIds: manualIndex.duplicates,
  };
}

function buildConfusionMatrix(resolvedRows) {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;

  for (const row of resolvedRows) {
    const manual = row.manualBinaryLabel;
    const automatic = row.automaticContinuationDecision;
    if (manual === 'positive' && automatic === 'positive') tp += 1;
    else if (manual === 'negative' && automatic === 'negative') tn += 1;
    else if (manual === 'negative' && automatic === 'positive') fp += 1;
    else if (manual === 'positive' && automatic === 'negative') fn += 1;
  }

  return { tp, tn, fp, fn };
}

function calculateMetrics(confusion) {
  const { tp, tn, fp, fn } = confusion;
  const total = tp + tn + fp + fn;
  const supportPositive = tp + fn;
  const supportNegative = tn + fp;

  const accuracy = rateWithSupport(tp + tn, total);
  const positivePrecision = rateWithSupport(tp, tp + fp);
  const positiveRecall = rateWithSupport(tp, supportPositive);
  const negativePrecision = rateWithSupport(tn, tn + fn);
  const negativeRecall = rateWithSupport(tn, supportNegative);

  const f1 = (precision, recall) => {
    const p = precision.rate;
    const r = recall.rate;
    if (p == null || r == null || p + r === 0) return { rate: null, numerator: null, denominator: null };
    return { rate: +((2 * p * r) / (p + r)).toFixed(4), numerator: null, denominator: null };
  };

  const positiveF1 = f1(positivePrecision, positiveRecall);
  const negativeF1 = f1(negativePrecision, negativeRecall);
  const balancedAccuracy = {
    rate: (positiveRecall.rate != null && negativeRecall.rate != null)
      ? +((positiveRecall.rate + negativeRecall.rate) / 2).toFixed(4)
      : null,
    numerator: null,
    denominator: null,
  };
  const macroF1 = {
    rate: (positiveF1.rate != null && negativeF1.rate != null)
      ? +((positiveF1.rate + negativeF1.rate) / 2).toFixed(4)
      : null,
    numerator: null,
    denominator: null,
  };

  return {
    accuracy,
    positivePrecision,
    positiveRecall,
    positiveF1,
    negativePrecision,
    negativeRecall,
    negativeF1,
    balancedAccuracy,
    macroF1,
    classSupport: {
      manualPositive: supportPositive,
      manualNegative: supportNegative,
      totalResolved: total,
    },
  };
}

function noteMentionsRoadEdgeOverlap(note) {
  if (!note) return false;
  const text = note.toLowerCase();
  return /road[- ]?edge|orange edge|edge overlap|overlaps the orange/.test(text);
}

function noteMentionsMappingFailure(note) {
  if (!note) return false;
  const text = note.toLowerCase();
  return /target mapping|laneindex|slot .* not found|divider not found|mapping fail/.test(text);
}

function noteMentionsAmbiguity(note) {
  if (!note) return false;
  const text = note.toLowerCase();
  return /ambiguous|unclear|cannot determine|hard to tell|overlap|occluded|not enough context/.test(text);
}

function inferSuggestedErrorCategory(row) {
  const manual = row.manualBinaryLabel;
  const automatic = row.automaticContinuationDecision;
  if (manual === 'negative' && automatic === 'positive') {
    if (row.automaticRuleReason === 'invalid_across_session_boundary') return 'boundary_not_rejected';
    if (row.automaticRuleReason === 'ambiguous_motion_residual_candidate') return 'residual_cap_false_accept';
    if (row.automaticRuleReason === 'valid_same_track_continuation') return 'rev37_false_accept';
    return 'false_positive_other';
  }
  if (manual === 'positive' && automatic === 'negative') {
    if (row.automaticRuleReason === 'invalid_across_session_boundary') return 'boundary_false_reject';
    if (row.automaticRuleReason === 'ambiguous_spatial_cap_failure') return 'residual_cap_false_reject';
    return 'false_negative_other';
  }
  return null;
}

function assessTemporalContinuityCorrect(row) {
  const manual = row.manualBinaryLabel;
  const automatic = row.automaticContinuationDecision;
  const boundaryReasons = new Set([
    'invalid_across_session_boundary',
    'invalid_across_chunk_boundary',
    'invalid_across_pose_section_boundary',
    'invalid_across_stage17_gap',
    'invalid_timestamp_discontinuity',
    'possible_cross_pass_match',
  ]);
  const autoBoundary = boundaryReasons.has(row.automaticRuleReason);
  if (manual === 'negative' && autoBoundary) return true;
  if (manual === 'positive' && !autoBoundary && automatic === 'positive') return true;
  if (manual === 'positive' && autoBoundary) return false;
  if (manual === 'negative' && automatic === 'positive' && !autoBoundary) return false;
  if (manual === 'negative' && automatic === 'negative' && !autoBoundary) return true;
  if (manual === 'positive' && automatic === 'negative' && !autoBoundary) return false;
  return null;
}

function buildDisagreementRow(row) {
  const note = row.manual.reviewerNotes || '';
  const roadEdgeOverlap = noteMentionsRoadEdgeOverlap(note);
  const geometryIssue = roadEdgeOverlap || noteMentionsMappingFailure(note);
  return {
    recordIndex: row.manualRecordIndex,
    reviewPairId: row.reviewPairId,
    manualLabel: row.manual.reviewerLabel,
    manualNote: note,
    automaticDecision: row.automaticContinuationDecision,
    automaticRuleReason: row.automaticRuleReason,
    automaticRejectionConditions: row.automaticRejectionConditions,
    confidenceScore: row.automaticConfidenceScore,
    confidenceScoreFinite: row.automaticConfidenceScoreFinite,
    segmentId: row.segmentId,
    logMonoTimeA: row.logMonoTimeA,
    logMonoTimeB: row.logMonoTimeB,
    qlogReference: row.qlogReference,
    rev37StaticEdgePass: row.rev37StaticEdgePass,
    stage17GapIntersection: row.stage17GapIntersection,
    temporalContinuityCorrect: assessTemporalContinuityCorrect(row),
    roadEdgeOverlap,
    geometryIssue,
    suggestedErrorCategory: inferSuggestedErrorCategory(row),
    note: 'roadEdgeOverlap is note-derived only; overlap alone is not proof of temporal identity switch',
  };
}

function categorizeUnresolvedRecord(row) {
  const manual = row.manual;
  const automatic = row.automatic;
  const note = (manual.reviewerNotes || '').toLowerCase();

  if (manual.evidenceMode === 'insufficient') {
    return 'missing_playback_or_frame_evidence';
  }
  if (automatic.ruleDerivedClassification === 'invalid_across_session_boundary'
    || (automatic.applicableRejectionConditions || []).includes('session_boundary')
    || /session boundary|cross[- ]session|different segment/.test(note)) {
    return 'cross_session_boundary';
  }
  if (automatic.ruleDerivedClassification === 'invalid_timestamp_discontinuity'
    || automatic.logMonoTimeA == null
    || automatic.logMonoTimeB == null
    || /timestamp/.test(note)) {
    return 'timestamp_unavailable';
  }
  if (noteMentionsMappingFailure(note) || /target divider|lane\/slot|highlighted target/.test(note) && /not found|missing|unavailable/.test(note)) {
    return 'lane_target_mapping_failure';
  }
  if (noteMentionsAmbiguity(note) || noteMentionsRoadEdgeOverlap(note)) {
    return 'visual_ambiguity_or_overlap';
  }
  return 'other';
}

function buildUnresolvedAnalysis(unresolvedRows) {
  const categoryCounts = Object.fromEntries(UNRESOLVED_CATEGORIES.map((c) => [c, 0]));
  const records = unresolvedRows.map((row) => {
    const category = categorizeUnresolvedRecord(row);
    categoryCounts[category] += 1;
    return {
      recordIndex: row.manualRecordIndex,
      reviewPairId: row.reviewPairId,
      manualLabel: row.manual.reviewerLabel,
      manualNote: row.manual.reviewerNotes || '',
      evidenceMode: row.manual.evidenceMode,
      automaticRuleReason: row.automaticRuleReason,
      unresolvedCategory: category,
      note: 'Unresolved manual labels are excluded from classification metrics and not counted as automatic errors',
    };
  });
  return { categoryCounts, records };
}

function buildConfidenceAnalysis(resolvedRows) {
  const positiveScores = [];
  const negativeScores = [];
  const missing = [];
  const nonFinite = [];

  for (const row of resolvedRows) {
    if (!row.automaticConfidenceScoreFinite) {
      if (row.automaticConfidenceScoreMissing) missing.push(row.reviewPairId);
      else nonFinite.push(row.reviewPairId);
      continue;
    }
    if (row.manualBinaryLabel === 'positive') positiveScores.push(row.automaticConfidenceScore);
    else if (row.manualBinaryLabel === 'negative') negativeScores.push(row.automaticConfidenceScore);
  }

  const confusion = buildConfusionMatrix(resolvedRows);
  const falsePositiveRows = resolvedRows.filter((r) => r.manualBinaryLabel === 'negative' && r.automaticContinuationDecision === 'positive');
  const falseNegativeRows = resolvedRows.filter((r) => r.manualBinaryLabel === 'positive' && r.automaticContinuationDecision === 'negative');

  return {
    confidenceField: CONFIDENCE_FIELD,
    confidenceDirection: CONFIDENCE_DIRECTION,
    confidenceDirectionNote: 'Lower residualAfterPoseM means stronger continuation confidence (smaller pose-compensated residual).',
    threshold: {
      parameter: THRESHOLD_PARAMETER,
      capM: THRESHOLD_CAP_M,
      operator: THRESHOLD_OPERATOR,
      configField: 'maxSpatialJumpM',
      approved: false,
      note: 'Candidate RESIDUAL_CAP_M is not approved; existing comparison uses current config only.',
    },
    missingConfidenceCount: missing.length,
    nonFiniteConfidenceCount: nonFinite.length,
    missingConfidencePairIds: missing,
    nonFiniteConfidencePairIds: nonFinite,
    distributionManualPositive: summarizeNumeric(positiveScores),
    distributionManualNegative: summarizeNumeric(negativeScores),
    falsePositives: falsePositiveRows.map(buildDisagreementRow),
    falseNegatives: falseNegativeRows.map(buildDisagreementRow),
    confusionMatrix: confusion,
  };
}

function inspectAutomaticFields(pair) {
  return {
    automaticContinuationDecisionField: 'derived from ruleDerivedClassification using B-MOTION predicate',
    automaticConfidenceScoreField: CONFIDENCE_FIELD,
    pairIdField: 'reviewPairId',
    ruleReasonField: 'ruleDerivedClassification',
    rejectionReasonField: 'applicableRejectionConditions',
    ambiguityFlags: {
      rev37StaticEdgePass: 'Rev37 static-branch pass without motion residual gate',
      stage17GapIntersection: 'Stage 17 gap intersects route-s interval',
      stratificationBucket: 'Review queue bucket / ambiguity stratification',
      ruleDerivedClassification: 'Rule-derived pseudo-label (not ground truth)',
    },
    threshold: {
      parameter: THRESHOLD_PARAMETER,
      capM: THRESHOLD_CAP_M,
      operator: THRESHOLD_OPERATOR,
      approved: false,
    },
    sample: pair ? {
      reviewPairId: pair.reviewPairId,
      ruleDerivedClassification: pair.ruleDerivedClassification,
      residualAfterPoseM: pair.residualAfterPoseM,
      rev37StaticEdgePass: pair.rev37StaticEdgePass,
      applicableRejectionConditions: pair.applicableRejectionConditions,
      ...deriveAutomaticContinuationDecision(pair),
      ...deriveAutomaticConfidenceScore(pair),
    } : null,
  };
}

function compareBaseline(options = {}) {
  const root = options.root || process.cwd();
  const manualPath = path.resolve(root, options.manualReviewsPath || DEFAULT_MANUAL_REVIEWS_PATH);
  const automaticPath = path.resolve(root, options.automaticManifestPath || DEFAULT_AUTOMATIC_MANIFEST_PATH);

  const manualArtifact = loadJson(manualPath);
  const automaticArtifact = loadJson(automaticPath);
  const manualReviews = manualArtifact.reviews || [];
  const automaticPairs = automaticArtifact.reviewPairs || [];

  const join = joinAutomaticAndManual({ automaticPairs, manualReviews });
  const resolvedRows = join.joined.filter((row) => row.manualBinaryLabel != null);
  const unresolvedRows = join.joined.filter((row) => row.manualBinaryLabel == null);

  const missingAutomaticForResolved = resolvedRows.filter((row) => row.automaticContinuationDecision === 'unknown');
  const blockingIssues = [];
  if (join.duplicateAutomaticPairIds.length) {
    blockingIssues.push({ code: 'duplicate_automatic_pair_ids', items: join.duplicateAutomaticPairIds });
  }
  if (join.duplicateManualPairIds.length) {
    blockingIssues.push({ code: 'duplicate_manual_pair_ids', items: join.duplicateManualPairIds });
  }
  if (join.unmatchedManual.length) {
    blockingIssues.push({ code: 'unmatched_manual_pair_ids', items: join.unmatchedManual });
  }
  if (missingAutomaticForResolved.length) {
    blockingIssues.push({
      code: 'missing_automatic_results_for_resolved_manual',
      items: missingAutomaticForResolved.map((r) => ({
        reviewPairId: r.reviewPairId,
        manualRecordIndex: r.manualRecordIndex,
      })),
    });
  }

  const metricsBlocked = blockingIssues.some((issue) => (
    issue.code === 'missing_automatic_results_for_resolved_manual'
    || issue.code === 'unmatched_manual_pair_ids'
  ));

  const confusion = metricsBlocked ? null : buildConfusionMatrix(resolvedRows);
  const metrics = metricsBlocked ? null : calculateMetrics(confusion);
  const confidence = metricsBlocked ? null : buildConfidenceAnalysis(resolvedRows);
  const unresolvedAnalysis = buildUnresolvedAnalysis(unresolvedRows);

  const manualLabelCounts = {
    positive_continuation: manualReviews.filter((r) => r.reviewerLabel === MANUAL_POSITIVE).length,
    negative_non_continuation: manualReviews.filter((r) => r.reviewerLabel === MANUAL_NEGATIVE).length,
    unresolved: manualReviews.filter((r) => r.reviewerLabel === MANUAL_UNRESOLVED).length,
  };

  return {
    generatedAt: new Date().toISOString(),
    terminology: 'QC-reviewed manual reference labels are not treated as perfect ground truth',
    inputs: {
      automaticManifestPath: path.relative(root, automaticPath),
      manualReviewsPath: path.relative(root, manualPath),
      automaticManifestSha256: sha256File(automaticPath),
      manualReviewsSha256: sha256File(manualPath),
      automaticPairCount: automaticPairs.length,
      manualReviewCount: manualReviews.length,
    },
    automaticFieldInspection: inspectAutomaticFields(automaticPairs[0] || null),
    joinSummary: {
      joinedCount: join.joined.length,
      resolvedManualCount: resolvedRows.length,
      unresolvedManualCount: unresolvedRows.length,
      unmatchedManualPairIds: join.unmatchedManual,
      unmatchedAutomaticPairIds: join.unmatchedAutomatic,
      duplicateAutomaticPairIds: join.duplicateAutomaticPairIds,
      duplicateManualPairIds: join.duplicateManualPairIds,
      joinMethod: 'reviewPairId exact match only (no array-position join)',
    },
    manualLabelCounts,
    metricsBlocked,
    blockingIssues,
    confusionMatrix: confusion,
    metrics,
    confidence,
    unresolvedAnalysis,
    falsePositiveRecordIndices: confidence ? confidence.falsePositives.map((r) => r.recordIndex) : [],
    falseNegativeRecordIndices: confidence ? confidence.falseNegatives.map((r) => r.recordIndex) : [],
  };
}

function buildDeliverables(report) {
  const disagreements = {
    generatedAt: report.generatedAt,
    terminology: report.terminology,
    falsePositives: report.confidence?.falsePositives || [],
    falseNegatives: report.confidence?.falseNegatives || [],
    falsePositiveRecordIndices: report.falsePositiveRecordIndices,
    falseNegativeRecordIndices: report.falseNegativeRecordIndices,
  };

  const summaryLines = [
    '# Stage 20 B-MOTION Baseline Comparison Summary',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Inputs',
    `- Automatic manifest: \`${report.inputs.automaticManifestPath}\``,
    `- Manual reviews: \`${report.inputs.manualReviewsPath}\``,
    `- Automatic SHA-256: \`${report.inputs.automaticManifestSha256}\``,
    `- Manual SHA-256: \`${report.inputs.manualReviewsSha256}\``,
    '',
    '## Automatic decision fields',
    `- Pair ID: \`reviewPairId\``,
    `- Rule/reason: \`ruleDerivedClassification\` with \`applicableRejectionConditions\``,
    `- Automatic continuation decision: derived positive for \`${AUTOMATIC_POSITIVE_CLASSIFICATIONS.join('`, `')}\``,
    `- Confidence score: \`${CONFIDENCE_FIELD}\` (${CONFIDENCE_DIRECTION})`,
    `- Threshold: \`${THRESHOLD_PARAMETER} ${THRESHOLD_OPERATOR} ${THRESHOLD_CAP_M}\` via \`maxSpatialJumpM\` (candidate RESIDUAL_CAP_M, not approved)`,
    '',
    '## Join',
    `- Matched resolved manual labels: **${report.joinSummary.resolvedManualCount}**`,
    `- Unresolved manual labels (excluded from metrics): **${report.joinSummary.unresolvedManualCount}**`,
    `- Unmatched manual pair IDs: **${report.joinSummary.unmatchedManualPairIds.length}**`,
    `- Duplicate automatic pair IDs: **${report.joinSummary.duplicateAutomaticPairIds.length}**`,
    `- Duplicate manual pair IDs: **${report.joinSummary.duplicateManualPairIds.length}**`,
    '',
    '## Manual label counts (QC-reviewed reference)',
    `- positive_continuation: ${report.manualLabelCounts.positive_continuation}`,
    `- negative_non_continuation: ${report.manualLabelCounts.negative_non_continuation}`,
    `- unresolved: ${report.manualLabelCounts.unresolved}`,
    '',
  ];

  if (report.metricsBlocked) {
    summaryLines.push('## Metrics', 'Metric generation blocked due to join integrity issues.', '');
    for (const issue of report.blockingIssues) {
      summaryLines.push(`- ${issue.code}: ${issue.items.length} item(s)`);
    }
  } else {
    const c = report.confusionMatrix;
    const m = report.metrics;
    summaryLines.push(
      '## Confusion matrix (resolved manual labels only)',
      `- True positive: ${c.tp}`,
      `- True negative: ${c.tn}`,
      `- False positive: ${c.fp}`,
      `- False negative: ${c.fn}`,
      '',
      '## Metrics (raw counts shown with every rate)',
      `- Accuracy: ${m.accuracy.rate} (${m.accuracy.numerator}/${m.accuracy.denominator})`,
      `- Positive precision: ${m.positivePrecision.rate} (${m.positivePrecision.numerator}/${m.positivePrecision.denominator})`,
      `- Positive recall: ${m.positiveRecall.rate} (${m.positiveRecall.numerator}/${m.positiveRecall.denominator})`,
      `- Positive F1: ${m.positiveF1.rate}`,
      `- Negative precision: ${m.negativePrecision.rate} (${m.negativePrecision.numerator}/${m.negativePrecision.denominator})`,
      `- Negative recall: ${m.negativeRecall.rate} (${m.negativeRecall.numerator}/${m.negativeRecall.denominator})`,
      `- Negative F1: ${m.negativeF1.rate}`,
      `- Balanced accuracy: ${m.balancedAccuracy.rate}`,
      `- Macro F1: ${m.macroF1.rate}`,
      `- Class support: manual positive ${m.classSupport.manualPositive}, manual negative ${m.classSupport.manualNegative}`,
      '',
      '## Confidence separation (`residualAfterPoseM`, lower = stronger continuation)',
      `- Missing scores: ${report.confidence.missingConfidenceCount}`,
      `- Non-finite scores: ${report.confidence.nonFiniteConfidenceCount}`,
      `- Manual positive distribution: ${JSON.stringify(report.confidence.distributionManualPositive)}`,
      `- Manual negative distribution: ${JSON.stringify(report.confidence.distributionManualNegative)}`,
      '',
      '## Disagreement record indices',
      `- False positives: ${report.falsePositiveRecordIndices.join(', ') || '(none)'}`,
      `- False negatives: ${report.falseNegativeRecordIndices.join(', ') || '(none)'}`,
      '',
      '## Unresolved category counts (not automatic errors)',
    );
    for (const [category, count] of Object.entries(report.unresolvedAnalysis.categoryCounts)) {
      summaryLines.push(`- ${category}: ${count}`);
    }
  }

  summaryLines.push('', `*${report.terminology}*`);

  return {
    comparisonJson: report,
    disagreementsJson: disagreements,
    summaryMarkdown: `${summaryLines.join('\n')}\n`,
  };
}

module.exports = {
  DEFAULT_MANUAL_REVIEWS_PATH,
  DEFAULT_AUTOMATIC_MANIFEST_PATH,
  AUTOMATIC_POSITIVE_CLASSIFICATIONS,
  AUTOMATIC_NEGATIVE_CLASSIFICATIONS,
  CONFIDENCE_FIELD,
  CONFIDENCE_DIRECTION,
  THRESHOLD_CAP_M,
  THRESHOLD_OPERATOR,
  joinAutomaticAndManual,
  deriveAutomaticContinuationDecision,
  deriveAutomaticConfidenceScore,
  manualLabelToBinary,
  buildConfusionMatrix,
  calculateMetrics,
  buildConfidenceAnalysis,
  categorizeUnresolvedRecord,
  compareBaseline,
  buildDeliverables,
  summarizeNumeric,
};
