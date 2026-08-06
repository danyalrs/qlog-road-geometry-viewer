'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const {
  joinAutomaticAndManual,
  manualLabelToBinary,
  THRESHOLD_CAP_M,
  THRESHOLD_OPERATOR,
} = require('./stage20_b_motion_baseline_compare');
const { parseObservationEndpoint } = require('./stage20_b_motion_review_playback');
const { ANCHOR_MODEL_X_M, COORDINATE_FRAME } = require('./stage23_b_motion_vector_residual');
const { EXPECTED_CONFIG_B } = require('./stage23_b_motion_limited_evaluation');

const DEFAULT_INPUTS = Object.freeze({
  runtimeDiagnosticsPath: 'deliverables/stage24-b-motion-runtime-comparison-diagnostics.json',
  stage24ReportPath: 'deliverables/stage24-b-motion-pipeline-shadow-report.json',
  manualReviewsPath: 'deliverables/stage20-b-motion-manual-reviews-qc-v1.json',
  automaticManifestPath: 'deliverables/stage20-b-motion-evidence-review-manifest.json',
});

const REVIEW_QUESTIONS = Object.freeze({
  temporalContinuation: ['positive_continuation', 'negative_non_continuation', 'unresolved'],
  identitySwap: ['true', 'false', 'unresolved'],
  geometryIssue: ['true', 'false', 'unresolved'],
  evidenceAvailable: ['true', 'false'],
  reviewConfidence: ['high', 'medium', 'low'],
  reviewerNote: 'free_text',
  note: 'roadEdgeOverlap alone must not imply identitySwap',
});

const PHYSICAL_PAIR_KEY_FIELDS = Object.freeze(['logMonoTimeA', 'logMonoTimeB', 'segmentId']);

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return +sorted[0].toFixed(4);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return +sorted[lo].toFixed(4);
  return +(sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo)).toFixed(4);
}

function compareCategory(legacy, vector) {
  if (legacy === vector) return legacy === 'positive' ? 'same_positive' : 'same_negative';
  if (legacy === 'positive' && vector === 'negative') return 'legacy_positive_vector_negative';
  return 'legacy_negative_vector_positive';
}

function inferVectorDecisionReason(row) {
  if (row.fallbackUsed) {
    return {
      reason: 'fallback_to_legacy',
      thresholdConsistent: row.vectorShadowDecision === row.authoritativeLegacyDecision,
    };
  }
  if (!row.geometryAvailable || row.vectorResidualM == null) {
    return {
      reason: 'geometry_unavailable',
      thresholdConsistent: null,
    };
  }
  if (row.geometryIssue === true && row.vectorResidualM <= THRESHOLD_CAP_M) {
    return {
      reason: 'boundary_or_geometry_gate',
      thresholdConsistent: row.vectorShadowDecision === 'negative',
    };
  }
  const thresholdPositive = row.vectorResidualM <= THRESHOLD_CAP_M;
  const expected = thresholdPositive ? 'positive' : 'negative';
  return {
    reason: thresholdPositive ? 'threshold_accept' : 'threshold_reject',
    thresholdConsistent: row.vectorShadowDecision === expected,
  };
}

function residualStats(values) {
  const finite = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const le12 = finite.filter((v) => v <= THRESHOLD_CAP_M).length;
  const gt12 = finite.filter((v) => v > THRESHOLD_CAP_M).length;
  return {
    count: finite.length,
    unavailableCount: values.length - finite.length,
    min: finite.length ? +finite[0].toFixed(4) : null,
    p05: percentile(finite, 0.05),
    p25: percentile(finite, 0.25),
    median: percentile(finite, 0.5),
    p75: percentile(finite, 0.75),
    p95: percentile(finite, 0.95),
    max: finite.length ? +finite[finite.length - 1].toFixed(4) : null,
    countLe12M: le12,
    countGt12M: gt12,
  };
}

function auditResidualDistributions(rows, stage24Report) {
  const categories = {
    same_positive: [],
    same_negative: [],
    legacy_positive_vector_negative: [],
    legacy_negative_vector_positive: [],
  };
  const fallbackByCategory = Object.fromEntries(Object.keys(categories).map((k) => [k, 0]));
  const fieldUsed = 'vectorResidualM';

  for (const row of rows) {
    const legacy = row.authoritativeLegacyDecision;
    const vector = row.vectorShadowDecision ?? legacy;
    const cat = compareCategory(legacy, vector);
    categories[cat].push(row.vectorResidualM);
    if (row.fallbackUsed) fallbackByCategory[cat] += 1;
  }

  const recalculated = Object.fromEntries(
    Object.entries(categories).map(([cat, vals]) => [cat, {
      ...residualStats(vals),
      fallbackCount: fallbackByCategory[cat],
      fieldUsed,
    }]),
  );

  const stage24Dist = stage24Report?.aggregateShadowStats?.vectorResidualDistributionByCategory ?? {};
  const stage24Field = 'vectorResidualM (all non-null values in category, regardless of decision reason)';
  const inconsistencies = [];

  for (const cat of Object.keys(categories)) {
    const s24 = stage24Dist[cat];
    const rec = recalculated[cat];
    if (s24 && rec.median != null && s24.median != null && Math.abs(s24.median - rec.median) > 0.0001) {
      inconsistencies.push({ category: cat, stage24Median: s24.median, recalculatedMedian: rec.median });
    }
    if (s24 && s24.count !== rec.count) {
      inconsistencies.push({ category: cat, issue: 'count_mismatch', stage24: s24.count, recalculated: rec.count });
    }
  }

  const sameNegativeExplanation = {
    category: 'same_negative',
    reportedMedianM: stage24Dist.same_negative?.median ?? null,
    recalculatedMedianM: recalculated.same_negative.median,
    apparentInconsistency: 'Median vectorResidualM can be <= 12 m while vectorShadowDecision is negative',
    cause: 'same_negative includes records where vector rejects due to boundary/geometry gates or legacy fallback, not only threshold_reject (residual > 12 m)',
    sameNegativeTotal: rows.filter((r) => compareCategory(r.authoritativeLegacyDecision, r.vectorShadowDecision ?? r.authoritativeLegacyDecision) === 'same_negative').length,
    sameNegativeResidualLe12M: rows.filter((r) => {
      const cat = compareCategory(r.authoritativeLegacyDecision, r.vectorShadowDecision ?? r.authoritativeLegacyDecision);
      return cat === 'same_negative' && r.vectorResidualM != null && r.vectorResidualM <= THRESHOLD_CAP_M;
    }).length,
    sameNegativeBoundaryOrFallback: rows.filter((r) => {
      const cat = compareCategory(r.authoritativeLegacyDecision, r.vectorShadowDecision ?? r.authoritativeLegacyDecision);
      return cat === 'same_negative' && (r.fallbackUsed || r.geometryIssue === true);
    }).length,
    fieldsChecked: {
      vectorResidualM: 'Euclidean pose-compensated anchor residual (correct field)',
      lateralResidualM: 'Not used in Stage 24 distribution',
      legacyScalarResidualM: 'Not used in Stage 24 distribution',
    },
    reportingFixRequired: false,
    reportingClarificationRequired: true,
  };

  const thresholdConsistency = {
    geometryAvailablePositive: rows.filter((r) => r.geometryAvailable && r.vectorShadowDecision === 'positive'),
    geometryAvailableNegative: rows.filter((r) => r.geometryAvailable && r.vectorShadowDecision === 'negative' && !r.fallbackUsed),
  };
  const posViolations = thresholdConsistency.geometryAvailablePositive
    .filter((r) => r.vectorResidualM != null && r.vectorResidualM > THRESHOLD_CAP_M);
  const negViolations = thresholdConsistency.geometryAvailableNegative
    .filter((r) => r.vectorResidualM != null && r.vectorResidualM <= THRESHOLD_CAP_M && !r.geometryIssue);

  return {
    fieldUsedForStage24Summary: stage24Field,
    recalculatedFromRawRecords: recalculated,
    stage24Reported: stage24Dist,
    numericInconsistencies: inconsistencies,
    sameNegativeMedianExplanation: sameNegativeExplanation,
    thresholdRuleVerification: {
      rule: `vectorShadowDecision positive iff geometry available, no boundary gate, and vectorResidualM ${THRESHOLD_OPERATOR} ${THRESHOLD_CAP_M} m`,
      geometryAvailablePositiveCount: thresholdConsistency.geometryAvailablePositive.length,
      geometryAvailableNegativeCount: thresholdConsistency.geometryAvailableNegative.length,
      positiveWithResidualGt12: posViolations.length,
      negativeWithResidualLe12ExcludingBoundary: negViolations.length,
      positiveViolationExamples: posViolations.slice(0, 5).map((r) => r.reviewPairId),
      negativeViolationExamples: negViolations.slice(0, 5).map((r) => r.reviewPairId),
    },
    staleDiagnosticsCheck: {
      runtimeDiagnosticsRecordCount: rows.length,
    },
  };
}

function physicalPairKey(row) {
  return `${row.segmentId}|${row.logMonoTimeA}|${row.logMonoTimeB}`;
}

function verifyChangedRecords(rows) {
  const changed = rows.filter((r) => r.authoritativeLegacyDecision !== r.vectorShadowDecision);
  const requiredFields = [
    'segmentId', 'logMonoTimeA', 'logMonoTimeB', 'observationIdA', 'observationIdB',
    'authoritativeLegacyDecision', 'legacyScalarResidualM', 'vectorShadowDecision', 'vectorResidualM',
    'geometryAvailable', 'fallbackUsed', 'coordinateFrame', 'anchorModelXM', 'thresholdM', 'comparisonOperator',
  ];

  const issues = [];
  const duplicateReviewPairIds = [];
  const seenPairIds = new Map();
  const physicalPairMap = new Map();

  for (const row of rows) {
    if (seenPairIds.has(row.reviewPairId)) {
      duplicateReviewPairIds.push({ reviewPairId: row.reviewPairId, indices: [seenPairIds.get(row.reviewPairId), row._index] });
    } else {
      seenPairIds.set(row.reviewPairId, row._index);
    }

    const phys = physicalPairKey(row);
    if (!physicalPairMap.has(phys)) physicalPairMap.set(phys, []);
    physicalPairMap.get(phys).push(row.reviewPairId);
  }

  const duplicatePhysicalPairs = [...physicalPairMap.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, reviewPairIds]) => ({ physicalPairKey: key, reviewPairIds, slotVariantCount: reviewPairIds.length }));

  for (const row of changed) {
    const missing = requiredFields.filter((f) => row[f] === undefined);
    if (missing.length) {
      issues.push({ reviewPairId: row.reviewPairId, code: 'missing_fields', fields: missing });
    }
    if (!row.observationIdA || !row.observationIdB) {
      issues.push({ reviewPairId: row.reviewPairId, code: 'missing_observation_ids' });
    }
    const qlogRef = row.qlogReference ?? (row.segmentId != null ? `qlog_f449c_${row.segmentId}.bz2` : null);
    if (!qlogRef) {
      issues.push({ reviewPairId: row.reviewPairId, code: 'missing_qlog_reference' });
    }
  }

  const legacyPosVectorNeg = changed.filter((r) => r.authoritativeLegacyDecision === 'positive' && r.vectorShadowDecision === 'negative');
  const legacyNegVectorPos = changed.filter((r) => r.authoritativeLegacyDecision === 'negative' && r.vectorShadowDecision === 'positive');

  return {
    expectedChangedTotal: 267,
    actualChangedTotal: changed.length,
    legacyPositiveVectorNegative: legacyPosVectorNeg.length,
    legacyNegativeVectorPositive: legacyNegVectorPos.length,
    countsMatch: changed.length === 267 && legacyPosVectorNeg.length === 82 && legacyNegVectorPos.length === 185,
    duplicateReviewPairIds,
    duplicatePhysicalPairs,
    repeatedObservationPairClusters: duplicatePhysicalPairs.filter((p) => p.slotVariantCount > 1),
    missingEvidenceIssues: issues,
    changedRecords: changed.map((row) => ({
      reviewPairId: row.reviewPairId,
      segmentId: row.segmentId,
      logMonoTimeA: row.logMonoTimeA,
      logMonoTimeB: row.logMonoTimeB,
      observationIdA: row.observationIdA,
      observationIdB: row.observationIdB,
      sourceSlotIndexA: row.sourceSlotIndexA,
      sourceSlotIndexB: row.sourceSlotIndexB,
      legacyScalarResidualM: row.legacyScalarResidualM,
      vectorResidualM: row.vectorResidualM,
      legacyDecision: row.authoritativeLegacyDecision,
      vectorDecision: row.vectorShadowDecision,
      geometryAvailable: row.geometryAvailable,
      fallbackUsed: row.fallbackUsed,
      coordinateFrame: row.coordinateFrame,
      anchorModelXM: row.anchorModelXM,
      thresholdM: row.thresholdM,
      comparisonOperator: row.comparisonOperator,
      qlogReference: row.qlogReference ?? (row.segmentId != null ? `qlog_f449c_${row.segmentId}.bz2` : null),
      vectorDecisionReason: inferVectorDecisionReason(row).reason,
      developmentRecord: row.developmentRecord === true,
      developmentRecordIndex: row.developmentRecordIndex ?? null,
    })),
  };
}

function separateDevelopmentAndRuntime(changedRows, developmentResolvedPairIds) {
  const inDevelopment = changedRows.filter((r) => developmentResolvedPairIds.has(r.reviewPairId));
  const runtimeOnly = changedRows.filter((r) => !developmentResolvedPairIds.has(r.reviewPairId));
  return {
    changedInDevelopmentSet: inDevelopment.length,
    changedRuntimeOnly: runtimeOnly.length,
    developmentChangedReviewPairIds: inDevelopment.map((r) => r.reviewPairId),
    runtimeOnlyChangedReviewPairIds: runtimeOnly.map((r) => r.reviewPairId),
    note: 'Development-set changed decisions are not independent runtime validation',
  };
}

function buildVisualEvidencePackage(row) {
  const parsedA = parseObservationEndpoint(row.observationIdA);
  const parsedB = parseObservationEndpoint(row.observationIdB);
  const qlogReference = row.qlogReference ?? (row.segmentId != null ? `qlog_f449c_${row.segmentId}.bz2` : null);
  return {
    frameA: {
      logMonoTime: row.logMonoTimeA,
      observationId: row.observationIdA,
      sourceSlotIndex: row.sourceSlotIndexA ?? parsedA?.sourceSlotIndex ?? null,
      qlogReference,
      highlightLaneIndex: row.sourceSlotIndexA ?? parsedA?.sourceSlotIndex ?? null,
      anchorModelXM: ANCHOR_MODEL_X_M,
      note: 'sourceSlotIndex is modelV2 lane slot, not physical divider rank',
    },
    frameB: {
      logMonoTime: row.logMonoTimeB,
      observationId: row.observationIdB,
      sourceSlotIndex: row.sourceSlotIndexB ?? parsedB?.sourceSlotIndex ?? null,
      qlogReference,
      highlightLaneIndex: row.sourceSlotIndexB ?? parsedB?.sourceSlotIndex ?? null,
      anchorModelXM: ANCHOR_MODEL_X_M,
    },
    playbackReference: {
      server: 'scripts/stage20_b_motion_review_server.js',
      apiPlayback: '/api/playback',
      segmentId: row.segmentId,
      reviewPairId: row.reviewPairId,
    },
    visualization: {
      targetDividerHighlight: 'laneIndex equals sourceSlotIndex at each frame',
      otherLaneDividersVisible: true,
      roadEdgesSeparateLayer: true,
      roadEdgeColor: '#f97316',
      targetLaneColor: '#e879f9',
      nonTargetLaneColor: '#64748b',
      identityRankDisclaimer: 'Do not infer physical divider identity from array index alone',
    },
    vectors: {
      targetDisplacementEastM: row.targetDisplacementEastM,
      targetDisplacementNorthM: row.targetDisplacementNorthM,
      poseDisplacementEastM: row.poseDisplacementEastM,
      poseDisplacementNorthM: row.poseDisplacementNorthM,
      compensatedEastM: row.compensatedEastM,
      compensatedNorthM: row.compensatedNorthM,
      coordinateFrame: row.coordinateFrame ?? COORDINATE_FRAME,
    },
    residuals: {
      legacyScalarResidualM: row.legacyScalarResidualM,
      vectorResidualM: row.vectorResidualM,
      longitudinalResidualM: row.longitudinalResidualM,
      lateralResidualM: row.lateralResidualM,
      thresholdM: row.thresholdM ?? THRESHOLD_CAP_M,
      comparisonOperator: row.comparisonOperator ?? THRESHOLD_OPERATOR,
    },
    decisions: {
      legacy: row.authoritativeLegacyDecision,
      vectorShadow: row.vectorShadowDecision,
      decisionChanged: row.authoritativeLegacyDecision !== row.vectorShadowDecision,
    },
    roadEdgeOverlap: row.roadEdgeOverlap === true,
    roadEdgeOverlapImpliesIdentitySwap: false,
  };
}

function poseDisplacementMagnitude(row) {
  if (row.poseDisplacementM != null) return row.poseDisplacementM;
  if (row.poseDisplacementEastM != null && row.poseDisplacementNorthM != null) {
    return Math.hypot(row.poseDisplacementEastM, row.poseDisplacementNorthM);
  }
  return null;
}

function selectReviewManifest(rows, developmentResolvedPairIds, options = {}) {
  const changed = rows.filter((r) => r.authoritativeLegacyDecision !== r.vectorShadowDecision);
  const selected = new Map();

  const add = (row, priority, reason, group) => {
    if (!row) return;
    const key = row.reviewPairId;
    const existing = selected.get(key);
    if (!existing || priority < existing.priority) {
      selected.set(key, {
        reviewPairId: row.reviewPairId,
        priority,
        selectionReason: reason,
        reviewGroup: group,
        developmentRecord: developmentResolvedPairIds.has(row.reviewPairId),
        developmentRecordIndex: row.developmentRecordIndex ?? null,
        runtimeOnly: !developmentResolvedPairIds.has(row.reviewPairId),
        legacyDecision: row.authoritativeLegacyDecision,
        vectorShadowDecision: row.vectorShadowDecision,
        vectorResidualM: row.vectorResidualM,
        legacyScalarResidualM: row.legacyScalarResidualM,
        segmentId: row.segmentId,
        visualEvidence: buildVisualEvidencePackage(row),
        reviewQuestions: REVIEW_QUESTIONS,
        reviewerFields: {
          temporalContinuation: null,
          identitySwap: null,
          geometryIssue: null,
          evidenceAvailable: null,
          reviewConfidence: null,
          reviewerNote: null,
        },
      });
    }
  };

  const lpvn = changed.filter((r) => r.authoritativeLegacyDecision === 'positive' && r.vectorShadowDecision === 'negative');
  for (const row of lpvn) add(row, 1, 'priority1_legacy_positive_vector_negative', 'legacy_positive_vector_negative');

  const fallback = rows.filter((r) => r.fallbackUsed || !r.geometryAvailable);
  for (const row of fallback) add(row, 2, 'priority2_fallback_or_unavailable_geometry', 'fallback');

  const lnvp = changed.filter((r) => r.authoritativeLegacyDecision === 'negative' && r.vectorShadowDecision === 'positive');
  const strata = {
    highDisplacement: lnvp.filter((r) => (poseDisplacementMagnitude(r) ?? 0) >= 30),
    headingInstability: lnvp.filter((r) => (r.headingDiffDeg ?? 0) >= 15),
    nearThreshold: lnvp.filter((r) => r.vectorResidualM != null && Math.abs(r.vectorResidualM - THRESHOLD_CAP_M) <= 1),
    repeatedPair: [],
    highChangeSegment: [],
  };
  const physCounts = new Map();
  for (const r of lnvp) {
    const k = `${r.logMonoTimeA}|${r.logMonoTimeB}`;
    physCounts.set(k, (physCounts.get(k) || 0) + 1);
  }
  strata.repeatedPair = lnvp.filter((r) => (physCounts.get(`${r.logMonoTimeA}|${r.logMonoTimeB}`) || 0) > 1);

  const segChanges = new Map();
  for (const r of changed) segChanges.set(r.segmentId, (segChanges.get(r.segmentId) || 0) + 1);
  const topSegs = [...segChanges.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s]) => s);
  strata.highChangeSegment = lnvp.filter((r) => topSegs.includes(r.segmentId));

  const lnvpSampled = new Set();
  const pickStride = (arr, limit) => {
    if (!arr.length) return;
    const stride = Math.max(1, Math.floor(arr.length / limit));
    for (let i = 0; i < arr.length && lnvpSampled.size < limit; i += stride) lnvpSampled.add(arr[i].reviewPairId);
  };
  for (const arr of Object.values(strata)) pickStride(arr, 8);
  pickStride(lnvp, options.lnvpSampleTarget ?? 40);
  for (const row of lnvp) {
    if (lnvpSampled.has(row.reviewPairId)) {
      add(row, 3, 'priority3_legacy_negative_vector_positive_representative', 'legacy_negative_vector_positive_sample');
    }
  }

  for (const idx of EXPECTED_CONFIG_B.damagedIndices) {
    const row = rows.find((r) => r.developmentRecordIndex === idx);
    add(row, 4, 'priority4_known_damaged_development_index', 'known_damaged_development');
  }

  const records = [...selected.values()].sort((a, b) => a.priority - b.priority || a.reviewPairId.localeCompare(b.reviewPairId));

  const breakdown = {
    priority1_legacyPositiveVectorNegative: records.filter((r) => r.reviewGroup === 'legacy_positive_vector_negative').length,
    priority2_fallback: records.filter((r) => r.reviewGroup === 'fallback').length,
    priority3_legacyNegativeVectorPositiveSample: records.filter((r) => r.reviewGroup === 'legacy_negative_vector_positive_sample').length,
    priority4_knownDamagedDevelopment: records.filter((r) => r.reviewGroup === 'known_damaged_development').length,
    developmentRecords: records.filter((r) => r.developmentRecord).length,
    runtimeOnly: records.filter((r) => r.runtimeOnly).length,
  };

  return {
    reviewQuestions: REVIEW_QUESTIONS,
    selectionRules: [
      'Priority 1: all legacy-positive/vector-negative (regression risk)',
      'Priority 2: all fallback/unavailable-geometry cases',
      'Priority 3: representative legacy-negative/vector-positive strata (not exhaustive)',
      'Priority 4: known damaged development indices 111, 112, 120, 191',
      'No automatic labels; targeted sample — not an unbiased test set',
      'Do not combine strata into one headline accuracy value',
    ],
    totalSelected: records.length,
    breakdown,
    records,
  };
}

function buildValidationPlan(manifest, separation, residualAudit) {
  const recommendationInputs = {
    runtimeOnlyChanged: separation.changedRuntimeOnly,
    developmentChanged: separation.changedInDevelopmentSet,
    priority1Count: manifest.breakdown.priority1_legacyPositiveVectorNegative,
    fallbackCount: manifest.breakdown.priority2_fallback,
    thresholdViolations: residualAudit.thresholdRuleVerification.positiveWithResidualGt12
      + residualAudit.thresholdRuleVerification.negativeWithResidualLe12ExcludingBoundary,
    reportingClarificationRequired: residualAudit.sameNegativeMedianExplanation.reportingClarificationRequired,
  };

  let recommendation = 'expand_manual_review';
  if (recommendationInputs.thresholdViolations > 0) {
    recommendation = 'reporting_fix_required';
  } else if (recommendationInputs.priority1Count >= 50 && recommendationInputs.runtimeOnlyChanged >= 200) {
    recommendation = 'continue_shadow_collection';
  } else if (recommendationInputs.priority1Count <= 10 && recommendationInputs.runtimeOnlyChanged < 50) {
    recommendation = 'vector_limited_canary_candidate';
  }

  return {
    reviewedCaseCount: 0,
    note: 'Labels pending manual review — plan only',
    strataReporting: {
      legacyPositiveVectorNegative: { selected: manifest.breakdown.priority1_legacyPositiveVectorNegative, labelsPending: true },
      legacyNegativeVectorPositiveSample: { selected: manifest.breakdown.priority3_legacyNegativeVectorPositiveSample, labelsPending: true },
      fallback: { selected: manifest.breakdown.priority2_fallback, labelsPending: true },
      developmentRecords: { selected: manifest.breakdown.developmentRecords, labelsPending: true },
      runtimeOnly: { selected: manifest.breakdown.runtimeOnly, labelsPending: true },
    },
    noCombinedHeadlineAccuracy: true,
    additionalCasesBeforeVectorLimited: {
      minimumRuntimeManualLabels: 50,
      minimumNegativeExamples: 30,
      rationale: '11 development negatives insufficient; runtime strata need independent labels before vector_limited activation',
    },
    recommendation,
    recommendationInputs,
  };
}

function runRuntimeDisagreementAudit(options = {}) {
  const root = options.root ?? process.cwd();
  const inputs = { ...DEFAULT_INPUTS, ...options.inputs };
  const diagPath = path.resolve(root, inputs.runtimeDiagnosticsPath);
  const stage24Path = path.resolve(root, inputs.stage24ReportPath);
  const manualPath = path.resolve(root, inputs.manualReviewsPath);
  const manifestPath = path.resolve(root, inputs.automaticManifestPath);

  const diagArtifact = loadJson(diagPath);
  const stage24Report = fs.existsSync(stage24Path) ? loadJson(stage24Path) : null;
  const rows = (diagArtifact.diagnostics || []).map((r, i) => ({ ...r, _index: i }));

  const manualBeforeHash = fs.existsSync(manualPath) ? sha256File(manualPath) : null;
  const developmentResolvedPairIds = new Set();
  if (fs.existsSync(manualPath) && fs.existsSync(manifestPath)) {
    const manual = loadJson(manualPath);
    const manifest = loadJson(manifestPath);
    const join = joinAutomaticAndManual({
      automaticPairs: manifest.reviewPairs,
      manualReviews: manual.reviews,
    });
    for (const row of join.joined) {
      if (manualLabelToBinary(row.manual.reviewerLabel) != null) {
        developmentResolvedPairIds.add(row.reviewPairId);
      }
    }
  }

  const residualAudit = auditResidualDistributions(rows, stage24Report);
  const changedAudit = verifyChangedRecords(rows);
  const separation = separateDevelopmentAndRuntime(changedAudit.changedRecords, developmentResolvedPairIds);
  const reviewManifest = selectReviewManifest(rows, developmentResolvedPairIds, options);

  const manualAfterHash = fs.existsSync(manualPath) ? sha256File(manualPath) : null;

  return {
    generatedAt: new Date().toISOString(),
    stage: 'stage25-b-motion-runtime-disagreement-audit',
    terminology: 'Targeted diagnostic verification — not final performance',
    inputIntegrity: {
      runtimeDiagnosticsPath: path.relative(root, diagPath),
      runtimeDiagnosticsSha256: sha256File(diagPath),
      recordCount: rows.length,
      expectedRecordCount: 5010,
      stage24ReportSha256: fs.existsSync(stage24Path) ? sha256File(stage24Path) : null,
      manualReviewsSha256Before: manualBeforeHash,
      manualReviewsSha256After: manualAfterHash,
      manualLabelsUnchanged: manualBeforeHash === manualAfterHash,
    },
    residualDistributionAudit: residualAudit,
    changedDecisionAudit: changedAudit,
    developmentVsRuntime: separation,
    reviewManifest,
    validationPlan: buildValidationPlan(reviewManifest, separation, residualAudit),
    missingOrInsufficientEvidence: {
      changedMissingFields: changedAudit.missingEvidenceIssues.length,
      fallbackTotal: rows.filter((r) => r.fallbackUsed).length,
      geometryUnavailable: rows.filter((r) => !r.geometryAvailable).length,
      changedWithoutQlog: changedAudit.missingEvidenceIssues.filter((i) => i.code === 'missing_qlog_reference').length,
    },
  };
}

function buildDeliverables(report) {
  const summaryLines = [
    '# Stage 25 B-MOTION Runtime Disagreement Audit Summary',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Same-negative median clarification',
    `- Reported Stage 24 median: ${report.residualDistributionAudit.sameNegativeMedianExplanation.reportedMedianM} m`,
    `- Recalculated median (vectorResidualM): ${report.residualDistributionAudit.sameNegativeMedianExplanation.recalculatedMedianM} m`,
    `- Cause: ${report.residualDistributionAudit.sameNegativeMedianExplanation.cause}`,
    `- Reporting fix required: **${report.residualDistributionAudit.sameNegativeMedianExplanation.reportingFixRequired}**`,
    '',
    '## Changed-decision integrity',
    `- Total changed: ${report.changedDecisionAudit.actualChangedTotal} (expected 267)`,
    `- Legacy+/vector−: ${report.changedDecisionAudit.legacyPositiveVectorNegative} (expected 82)`,
    `- Legacy−/vector+: ${report.changedDecisionAudit.legacyNegativeVectorPositive} (expected 185)`,
    `- Counts match: **${report.changedDecisionAudit.countsMatch}**`,
    '',
    '## Development vs runtime-only',
    `- Changed in 175 development set: ${report.developmentVsRuntime.changedInDevelopmentSet}`,
    `- Changed runtime-only: ${report.developmentVsRuntime.changedRuntimeOnly}`,
    '',
    '## Manual review manifest',
    `- Selected cases: ${report.reviewManifest.totalSelected}`,
    `- Priority 1 (legacy+/vector−): ${report.reviewManifest.breakdown.priority1_legacyPositiveVectorNegative}`,
    `- Priority 2 (fallback): ${report.reviewManifest.breakdown.priority2_fallback}`,
    `- Runtime-only in manifest: ${report.reviewManifest.breakdown.runtimeOnly}`,
    '',
    '## Recommendation',
    `- **${report.validationPlan.recommendation}**`,
    '',
    `*${report.terminology}*`,
  ];

  return {
    auditJson: report,
    residualAuditJson: {
      generatedAt: report.generatedAt,
      ...report.residualDistributionAudit,
    },
    reviewManifestJson: report.reviewManifest,
    summaryMarkdown: `${summaryLines.join('\n')}\n`,
  };
}

module.exports = {
  REVIEW_QUESTIONS,
  THRESHOLD_CAP_M,
  compareCategory,
  inferVectorDecisionReason,
  residualStats,
  auditResidualDistributions,
  verifyChangedRecords,
  separateDevelopmentAndRuntime,
  buildVisualEvidencePackage,
  selectReviewManifest,
  runRuntimeDisagreementAudit,
  buildDeliverables,
};
