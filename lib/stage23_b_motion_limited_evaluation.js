'use strict';

const fs = require('fs');
const path = require('path');
const {
  joinAutomaticAndManual,
  manualLabelToBinary,
  buildConfusionMatrix,
  THRESHOLD_CAP_M,
} = require('./stage20_b_motion_baseline_compare');
const {
  buildShadowMeasurements,
  decideVector,
  calculateMetricsZeroDiv,
  MANUAL_RECHECK_INDEX,
  verifyInputIntegrity,
} = require('./stage22_b_motion_shadow_evaluation');
const {
  DECISION_MODES,
  DEFAULT_VECTOR_CONFIG,
  evaluateBMotionDecision,
  buildGeometryContextFromShadowMeas,
} = require('./stage23_b_motion_vector_residual');

const EXPECTED_CONFIG_B = Object.freeze({
  tp: 158,
  tn: 1,
  fp: 10,
  fn: 6,
  accuracy: 0.9086,
  positiveF1: 0.9518,
  negativeF1: 0.1111,
  macroF1: 0.5315,
  balancedAccuracy: 0.5272,
  baselineTpRetained: 138,
  baselineTpTotal: 142,
  allManualPositiveRetained: 158,
  allManualPositiveTotal: 164,
  correctedIndices: Object.freeze([
    0, 1, 2, 3, 121, 123, 124, 125, 126, 128, 129, 131,
    139, 140, 142, 145, 186, 187, 206, 207, 210,
  ]),
  damagedIndices: Object.freeze([111, 112, 120, 191]),
  netCorrectImprovement: 17,
  baselineCorrect: 142,
  configBCorrect: 159,
});

const DEFAULT_INPUTS = Object.freeze({
  manualReviewsPath: 'deliverables/stage20-b-motion-manual-reviews-qc-v1.json',
  automaticManifestPath: 'deliverables/stage20-b-motion-evidence-review-manifest.json',
  stage22EvaluationPath: 'deliverables/stage22-b-motion-shadow-evaluation.json',
});

function evaluateRecordAccounting(records, getDecision) {
  const corrected = [];
  const damaged = [];
  for (const r of records) {
    const baseCorrect = r.baselineDecision === r.manualBinaryLabel;
    const candCorrect = getDecision(r) === r.manualBinaryLabel;
    if (!baseCorrect && candCorrect) corrected.push(r.recordIndex);
    if (baseCorrect && !candCorrect) damaged.push(r.recordIndex);
  }
  return {
    correctedRecordIndices: corrected.sort((a, b) => a - b),
    newlyDamagedRecordIndices: damaged.sort((a, b) => a - b),
    netCorrectImprovement: corrected.length - damaged.length,
  };
}

function evaluateConfigMetrics(records, getDecision) {
  const rows = records.map((r) => ({
    manualBinaryLabel: r.manualBinaryLabel,
    automaticContinuationDecision: getDecision(r),
  }));
  const confusion = buildConfusionMatrix(rows);
  const metrics = calculateMetricsZeroDiv(confusion);
  const baselineRows = records.map((r) => ({
    manualBinaryLabel: r.manualBinaryLabel,
    automaticContinuationDecision: r.baselineDecision,
  }));
  const baselineConfusion = buildConfusionMatrix(baselineRows);
  const accounting = evaluateRecordAccounting(records, getDecision);

  const truePositiveProtection = {
    baselineTpRetained: records.filter((r) => r.manualBinaryLabel === 'positive'
      && r.baselineDecision === 'positive'
      && getDecision(r) === 'positive').length,
    baselineTpTotal: records.filter((r) => r.manualBinaryLabel === 'positive' && r.baselineDecision === 'positive').length,
    allManualPositiveRetained: records.filter((r) => r.manualBinaryLabel === 'positive' && getDecision(r) === 'positive').length,
    allManualPositiveTotal: records.filter((r) => r.manualBinaryLabel === 'positive').length,
  };

  return {
    confusionMatrix: confusion,
    ...metrics,
    deltaFromBaseline: {
      tp: confusion.tp - baselineConfusion.tp,
      tn: confusion.tn - baselineConfusion.tn,
      fp: confusion.fp - baselineConfusion.fp,
      fn: confusion.fn - baselineConfusion.fn,
    },
    ...accounting,
    truePositiveProtection,
    baselineCorrect: baselineConfusion.tp + baselineConfusion.tn,
    candidateCorrect: confusion.tp + confusion.tn,
  };
}

function assertConfigBReproduction(metrics, label = 'primary') {
  const errors = [];
  const c = metrics.confusionMatrix;
  if (c.tp !== EXPECTED_CONFIG_B.tp) errors.push(`${label}: tp ${c.tp} !== ${EXPECTED_CONFIG_B.tp}`);
  if (c.tn !== EXPECTED_CONFIG_B.tn) errors.push(`${label}: tn ${c.tn} !== ${EXPECTED_CONFIG_B.tn}`);
  if (c.fp !== EXPECTED_CONFIG_B.fp) errors.push(`${label}: fp ${c.fp} !== ${EXPECTED_CONFIG_B.fp}`);
  if (c.fn !== EXPECTED_CONFIG_B.fn) errors.push(`${label}: fn ${c.fn} !== ${EXPECTED_CONFIG_B.fn}`);
  if (metrics.accuracy.rate !== EXPECTED_CONFIG_B.accuracy) errors.push(`${label}: accuracy ${metrics.accuracy.rate}`);
  if (metrics.positiveF1.rate !== EXPECTED_CONFIG_B.positiveF1) errors.push(`${label}: positiveF1 ${metrics.positiveF1.rate}`);
  if (metrics.negativeF1.rate !== EXPECTED_CONFIG_B.negativeF1) errors.push(`${label}: negativeF1 ${metrics.negativeF1.rate}`);
  if (metrics.macroF1.rate !== EXPECTED_CONFIG_B.macroF1) errors.push(`${label}: macroF1 ${metrics.macroF1.rate}`);
  if (metrics.balancedAccuracy.rate !== EXPECTED_CONFIG_B.balancedAccuracy) errors.push(`${label}: balancedAccuracy ${metrics.balancedAccuracy.rate}`);
  if (metrics.truePositiveProtection.baselineTpRetained !== EXPECTED_CONFIG_B.baselineTpRetained) {
    errors.push(`${label}: baselineTpRetained ${metrics.truePositiveProtection.baselineTpRetained}`);
  }
  if (metrics.truePositiveProtection.allManualPositiveRetained !== EXPECTED_CONFIG_B.allManualPositiveRetained) {
    errors.push(`${label}: allManualPositiveRetained ${metrics.truePositiveProtection.allManualPositiveRetained}`);
  }
  if (metrics.netCorrectImprovement !== EXPECTED_CONFIG_B.netCorrectImprovement) {
    errors.push(`${label}: netCorrectImprovement ${metrics.netCorrectImprovement}`);
  }
  const correctedMatch = JSON.stringify(metrics.correctedRecordIndices) === JSON.stringify([...EXPECTED_CONFIG_B.correctedIndices]);
  if (!correctedMatch) errors.push(`${label}: corrected indices mismatch`);
  const damagedMatch = JSON.stringify(metrics.newlyDamagedRecordIndices) === JSON.stringify([...EXPECTED_CONFIG_B.damagedIndices]);
  if (!damagedMatch) errors.push(`${label}: damaged indices mismatch`);
  return errors;
}

function runLimitedEvaluation(options = {}) {
  const root = options.root || process.cwd();
  const inputs = { ...DEFAULT_INPUTS, ...options.inputs };
  const integrity = verifyInputIntegrity(root, inputs);

  const manual = JSON.parse(fs.readFileSync(path.resolve(root, inputs.manualReviewsPath), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.resolve(root, inputs.automaticManifestPath), 'utf8'));
  const join = joinAutomaticAndManual({
    automaticPairs: manifest.reviewPairs,
    manualReviews: manual.reviews,
  });

  const resolvedRows = join.joined.filter((r) => manualLabelToBinary(r.manual.reviewerLabel) != null);
  const qlogCache = new Map();
  const records = [];
  const comparisonDiagnostics = [];
  let fallbackCount = 0;

  for (const row of resolvedRows) {
    const meas = buildShadowMeasurements(row.automatic, row.manual, root, qlogCache);
    meas.recordIndex = row.manualRecordIndex;
    const manualBinaryLabel = manualLabelToBinary(row.manual.reviewerLabel);
    const baselineDecision = meas.baselineDecision === 'positive' ? 'positive' : 'negative';
    const stage22VectorDecision = decideVector(meas);
    const geometryContext = buildGeometryContextFromShadowMeas(meas, row.automatic);

    const legacyEval = evaluateBMotionDecision(row.automatic, geometryContext, {
      decisionMode: DECISION_MODES.LEGACY_SCALAR,
      featureEnabled: false,
    });
    const shadowEval = evaluateBMotionDecision(row.automatic, geometryContext, {
      decisionMode: DECISION_MODES.VECTOR_SHADOW,
      featureEnabled: true,
    });
    const limitedEval = evaluateBMotionDecision(row.automatic, geometryContext, {
      decisionMode: DECISION_MODES.VECTOR_LIMITED,
      featureEnabled: true,
    });

    if (limitedEval.authoritativeDecision !== stage22VectorDecision) {
      throw new Error(`Record ${row.manualRecordIndex}: vector_limited ${limitedEval.authoritativeDecision} !== stage22 Config B ${stage22VectorDecision}`);
    }

    if (limitedEval.fallbackUsed) fallbackCount += 1;

    const record = {
      recordIndex: row.manualRecordIndex,
      reviewPairId: row.reviewPairId,
      manualBinaryLabel,
      manualReferenceLabel: row.manual.reviewerLabel,
      baselineDecision,
      stage22ConfigBDecision: stage22VectorDecision,
      legacyEval,
      shadowEval,
      limitedEval,
      meas,
    };
    records.push(record);

    const baseCorrect = baselineDecision === manualBinaryLabel;
    const limitedCorrect = limitedEval.authoritativeDecision === manualBinaryLabel;
    comparisonDiagnostics.push({
      recordIndex: row.manualRecordIndex,
      reviewPairId: row.reviewPairId,
      manualReferenceLabel: row.manual.reviewerLabel,
      ...limitedEval.comparisonDiagnostics,
      legacyDecision: legacyEval.authoritativeDecision,
      authoritativeDecision: limitedEval.authoritativeDecision,
      shadowVectorDecision: shadowEval.vectorCandidate.decision,
      limitedDecision: limitedEval.authoritativeDecision,
      correctedOrDamaged: !baseCorrect && limitedCorrect
        ? 'corrected'
        : baseCorrect && !limitedCorrect
          ? 'damaged'
          : 'unchanged',
      concepts: limitedEval.concepts,
    });
  }

  const legacyMetrics = evaluateConfigMetrics(records, (r) => r.legacyEval.authoritativeDecision);
  const limitedMetrics = evaluateConfigMetrics(records, (r) => r.limitedEval.authoritativeDecision);
  const limitedExcluding207 = evaluateConfigMetrics(
    records.filter((r) => r.recordIndex !== MANUAL_RECHECK_INDEX),
    (r) => r.limitedEval.authoritativeDecision,
  );

  const reproductionErrors = [
    ...assertConfigBReproduction(limitedMetrics, 'primary'),
  ];

  const record207 = records.find((r) => r.recordIndex === MANUAL_RECHECK_INDEX);
  const sensitivity207 = {
    recordIndex: MANUAL_RECHECK_INDEX,
    labelUnchanged: true,
    primaryIncluded: true,
    limitedDecision: record207?.limitedEval.authoritativeDecision ?? null,
    legacyDecision: record207?.legacyEval.authoritativeDecision ?? null,
    metricDelta: {
      accuracyDelta: +(limitedExcluding207.accuracy.rate - limitedMetrics.accuracy.rate).toFixed(4),
      macroF1Delta: +(limitedExcluding207.macroF1.rate - limitedMetrics.macroF1.rate).toFixed(4),
      correctedCountDelta: limitedExcluding207.correctedRecordIndices.length - limitedMetrics.correctedRecordIndices.length,
      damagedCountDelta: limitedExcluding207.newlyDamagedRecordIndices.length - limitedMetrics.newlyDamagedRecordIndices.length,
      netCorrectImprovementDelta: limitedExcluding207.netCorrectImprovement - limitedMetrics.netCorrectImprovement,
    },
  };

  return {
    generatedAt: new Date().toISOString(),
    stage: 'stage23-b-motion-limited-implementation',
    terminology: 'Development-set limited implementation evaluation — not final model performance',
    inputIntegrity: integrity,
    featureFlag: {
      defaultEnabled: DEFAULT_VECTOR_CONFIG.featureEnabled,
      defaultMode: DEFAULT_VECTOR_CONFIG.decisionMode,
      envVars: ['B_MOTION_VECTOR_ENABLED', 'B_MOTION_VECTOR_MODE'],
      note: 'Vector candidate is disabled by default; production authoritative path remains legacy_scalar unless explicitly set to vector_limited',
    },
    vectorFormula: 'poseCompensatedTarget = targetAnchorB - targetAnchorA - (poseB - poseA); vectorResidualM = |poseCompensatedTarget|',
    coordinateFrame: 'east/north metres',
    anchorModelXM: 15,
    thresholdM: THRESHOLD_CAP_M,
    legacyRegression: legacyMetrics,
    configBReproduction: limitedMetrics,
    configBReproductionExcludingRecord207: limitedExcluding207,
    fallbackCount,
    record207Sensitivity: sensitivity207,
    reproductionErrors,
    reproductionPassed: reproductionErrors.length === 0,
    comparisonDiagnostics,
    expectedConfigB: EXPECTED_CONFIG_B,
  };
}

function buildDeliverables(report) {
  const summaryLines = [
    '# Stage 23 B-MOTION Limited Implementation Summary',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Feature flag',
    `- Default enabled: **${report.featureFlag.defaultEnabled}**`,
    `- Default mode: **${report.featureFlag.defaultMode}**`,
    `- Env vars: \`${report.featureFlag.envVars.join('`, `')}\``,
    '',
    '## Vector formula',
    `- ${report.vectorFormula}`,
    `- Coordinate frame: ${report.coordinateFrame}`,
    `- Anchor modelX: ${report.anchorModelXM} m`,
    `- Threshold: <= ${report.thresholdM} m (unchanged)`,
    '',
    '## Legacy regression (175 resolved)',
    `- TP=${report.legacyRegression.confusionMatrix.tp} TN=${report.legacyRegression.confusionMatrix.tn} FP=${report.legacyRegression.confusionMatrix.fp} FN=${report.legacyRegression.confusionMatrix.fn}`,
    `- Accuracy: ${report.legacyRegression.accuracy.rate}`,
    '',
    '## Config B reproduction via vector_limited (175 resolved)',
    `- TP=${report.configBReproduction.confusionMatrix.tp} TN=${report.configBReproduction.confusionMatrix.tn} FP=${report.configBReproduction.confusionMatrix.fp} FN=${report.configBReproduction.confusionMatrix.fn}`,
    `- Accuracy: ${report.configBReproduction.accuracy.rate}`,
    `- Positive F1: ${report.configBReproduction.positiveF1.rate}`,
    `- Negative F1: ${report.configBReproduction.negativeF1.rate}`,
    `- Macro F1: ${report.configBReproduction.macroF1.rate}`,
    `- Balanced accuracy: ${report.configBReproduction.balancedAccuracy.rate}`,
    `- Baseline correct: ${report.configBReproduction.baselineCorrect}/175`,
    `- Config B correct: ${report.configBReproduction.candidateCorrect}/175`,
    `- Corrected: ${report.configBReproduction.correctedRecordIndices.length}`,
    `- Damaged: ${report.configBReproduction.newlyDamagedRecordIndices.length}`,
    `- Net correct improvement: **+${report.configBReproduction.netCorrectImprovement}**`,
    `- Baseline TPs retained: ${report.configBReproduction.truePositiveProtection.baselineTpRetained}/${report.configBReproduction.truePositiveProtection.baselineTpTotal}`,
    `- All manual positives retained: ${report.configBReproduction.truePositiveProtection.allManualPositiveRetained}/${report.configBReproduction.truePositiveProtection.allManualPositiveTotal}`,
    `- Reproduction passed: **${report.reproductionPassed}**`,
    `- Fallback count: ${report.fallbackCount}`,
    '',
    '## Record 207 sensitivity',
    `- Label unchanged`,
    `- Metric delta when excluded: ${JSON.stringify(report.record207Sensitivity.metricDelta)}`,
    '',
    '## Corrected indices',
    report.configBReproduction.correctedRecordIndices.join(', '),
    '',
    '## Damaged indices',
    report.configBReproduction.newlyDamagedRecordIndices.join(', '),
    '',
    `*${report.terminology}*`,
  ];

  const reportJson = { ...report };
  delete reportJson.comparisonDiagnostics;

  return {
    reportJson,
    comparisonDiagnosticsJson: {
      generatedAt: report.generatedAt,
      recordCount: report.comparisonDiagnostics.length,
      diagnostics: report.comparisonDiagnostics,
    },
    summaryMarkdown: `${summaryLines.join('\n')}\n`,
  };
}

module.exports = {
  EXPECTED_CONFIG_B,
  DECISION_MODES,
  evaluateConfigMetrics,
  assertConfigBReproduction,
  runLimitedEvaluation,
  buildDeliverables,
};
