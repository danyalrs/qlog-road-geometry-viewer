'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { generateEvidencePackage, clearSegmentCache } = require('./stage26_b_motion_evidence_generation');

const DEFAULT_INPUTS = Object.freeze({
  stage25AuditPath: 'deliverables/stage25-b-motion-runtime-disagreement-audit.json',
  stage25ResidualPath: 'deliverables/stage25-b-motion-residual-distribution-audit.json',
  stage25ManifestPath: 'deliverables/stage25-b-motion-manual-review-manifest.json',
  stage25SummaryPath: 'deliverables/stage25-b-motion-runtime-disagreement-summary.md',
  stage24DiagnosticsPath: 'deliverables/stage24-b-motion-runtime-comparison-diagnostics.json',
  stage20ManualPath: 'deliverables/stage20-b-motion-manual-reviews-qc-v1.json',
  reviewsOutputPath: 'deliverables/stage26-b-motion-runtime-manual-reviews.json',
  progressOutputPath: 'deliverables/stage26-b-motion-runtime-review-progress.json',
  stratifiedOutputPath: 'deliverables/stage26-b-motion-runtime-stratified-results.json',
});

const VALID_LABELS = Object.freeze({
  temporalContinuation: ['positive_continuation', 'negative_continuation', 'unresolved'],
  identitySwap: ['true', 'false', 'unresolved'],
  geometryIssue: ['true', 'false', 'unresolved'],
  evidenceAvailable: [true, false],
  confidence: ['high', 'medium', 'low'],
});

const REVIEW_STATUS = Object.freeze({
  PENDING_HUMAN: 'pending_human_review',
  AUTO_UNRESOLVED: 'auto_unresolved_evidence_failure',
  COMPLETED: 'completed',
});

const PRIORITY_ORDER = Object.freeze([
  { key: 'priority1', group: 'legacy_positive_vector_negative', label: 'Priority 1: legacy+/vector−' },
  { key: 'priority2', group: 'fallback', label: 'Priority 2: fallback/unavailable' },
  { key: 'priority3', group: 'legacy_negative_vector_positive_sample', label: 'Priority 3: legacy−/vector+ sample' },
  { key: 'priority4', group: 'known_damaged_development', label: 'Priority 4: damaged development indices' },
]);

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function physicalPairKey(row) {
  return `${row.segmentId}|${row.logMonoTimeA}|${row.logMonoTimeB}`;
}

function isResolvedReview(review) {
  return review.temporalContinuation === 'positive_continuation'
    || review.temporalContinuation === 'negative_continuation';
}

function isCompletedReview(review) {
  return review.reviewStatus === REVIEW_STATUS.COMPLETED
    || review.reviewStatus === REVIEW_STATUS.AUTO_UNRESOLVED;
}

function validateReviewLabels(review) {
  const errors = [];
  if (!VALID_LABELS.temporalContinuation.includes(review.temporalContinuation)) {
    errors.push('invalid temporalContinuation');
  }
  if (!VALID_LABELS.identitySwap.includes(review.identitySwap)) {
    errors.push('invalid identitySwap');
  }
  if (!VALID_LABELS.geometryIssue.includes(review.geometryIssue)) {
    errors.push('invalid geometryIssue');
  }
  if (typeof review.evidenceAvailable !== 'boolean') {
    errors.push('invalid evidenceAvailable');
  }
  if (review.confidence && !VALID_LABELS.confidence.includes(review.confidence)) {
    errors.push('invalid confidence');
  }
  if (review.evidenceAvailable === false && review.temporalContinuation !== 'unresolved') {
    errors.push('unresolved required when evidenceAvailable is false');
  }
  return errors;
}

function indexDiagnosticsByPairId(diagnosticsArtifact) {
  const map = new Map();
  for (const row of diagnosticsArtifact.diagnostics || []) {
    map.set(row.reviewPairId, row);
  }
  return map;
}

function verifyStage25Inputs(root, inputs = {}) {
  const merged = { ...DEFAULT_INPUTS, ...inputs };
  const inputKeys = [
    'stage25AuditPath',
    'stage25ResidualPath',
    'stage25ManifestPath',
    'stage25SummaryPath',
    'stage24DiagnosticsPath',
    'stage20ManualPath',
  ];
  const paths = Object.fromEntries(
    inputKeys.map((k) => [k, path.resolve(root, merged[k])]),
  );
  const hashes = Object.fromEntries(
    Object.entries(paths).map(([k, p]) => [k, fs.existsSync(p) ? sha256File(p) : null]),
  );
  const manifest = loadJson(paths.stage25ManifestPath);
  const audit = loadJson(paths.stage25AuditPath);

  const duplicateIds = [];
  const seen = new Set();
  for (const rec of manifest.records || []) {
    if (seen.has(rec.reviewPairId)) duplicateIds.push(rec.reviewPairId);
    seen.add(rec.reviewPairId);
  }

  const missingEvidence = (manifest.records || []).filter((r) => !r.visualEvidence?.frameA?.qlogReference && r.segmentId == null);

  return {
    ok: (manifest.records || []).length === 134 && duplicateIds.length === 0,
    hashes,
    paths: Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, path.relative(root, p)])),
    manifestCount: (manifest.records || []).length,
    developmentRecords: (manifest.records || []).filter((r) => r.developmentRecord).length,
    runtimeOnlyRecords: (manifest.records || []).filter((r) => r.runtimeOnly).length,
    priorityBreakdown: manifest.breakdown,
    duplicateReviewPairIds: duplicateIds,
    missingEvidenceReferences: missingEvidence.map((r) => r.reviewPairId),
    changedDecisionAudit: audit.changedDecisionAudit,
  };
}

function assignPriorityGroup(record) {
  if (record.reviewGroup === 'legacy_positive_vector_negative') return 'priority1';
  if (record.reviewGroup === 'fallback') return 'priority2';
  if (record.reviewGroup === 'legacy_negative_vector_positive_sample') return 'priority3';
  if (record.reviewGroup === 'known_damaged_development') return 'priority4';
  if (record.selectionReason === 'known_damaged_development_index') return 'priority4';
  if ([111, 112, 120, 191].includes(record.developmentRecordIndex)) return 'priority4';
  return 'priority3';
}

function createAutoUnresolvedReview(manifestRecord, evidence, reason) {
  return {
    reviewPairId: manifestRecord.reviewPairId,
    reviewStatus: REVIEW_STATUS.AUTO_UNRESOLVED,
    priority: manifestRecord.priority,
    reviewGroup: manifestRecord.reviewGroup,
    developmentRecord: manifestRecord.developmentRecord === true,
    runtimeOnly: manifestRecord.runtimeOnly === true,
    developmentRecordIndex: manifestRecord.developmentRecordIndex ?? null,
    temporalContinuation: 'unresolved',
    identitySwap: 'unresolved',
    geometryIssue: evidence?.issues?.length ? 'true' : 'unresolved',
    evidenceAvailable: false,
    confidence: 'low',
    reviewerNote: `Evidence unavailable or frame correspondence failed: ${reason}`,
    legacyDecision: manifestRecord.legacyDecision,
    vectorShadowDecision: manifestRecord.vectorShadowDecision,
    evidenceGeneration: {
      ok: false,
      issues: evidence?.issues || [reason],
    },
    reviewedAt: new Date().toISOString(),
    reviewerId: 'stage26_auto_evidence_check',
    roadEdgeOverlapImpliesIdentitySwap: false,
  };
}

function createPendingHumanReview(manifestRecord, evidence) {
  return {
    reviewPairId: manifestRecord.reviewPairId,
    reviewStatus: REVIEW_STATUS.PENDING_HUMAN,
    priority: manifestRecord.priority,
    reviewGroup: manifestRecord.reviewGroup,
    developmentRecord: manifestRecord.developmentRecord === true,
    runtimeOnly: manifestRecord.runtimeOnly === true,
    developmentRecordIndex: manifestRecord.developmentRecordIndex ?? null,
    temporalContinuation: null,
    identitySwap: null,
    geometryIssue: null,
    evidenceAvailable: null,
    confidence: null,
    reviewerNote: null,
    legacyDecision: manifestRecord.legacyDecision,
    vectorShadowDecision: manifestRecord.vectorShadowDecision,
    evidenceGeneration: {
      ok: evidence.ok,
      evidenceAvailable: evidence.evidenceAvailable,
      issues: evidence.issues,
      frameCorrespondence: evidence.frameCorrespondence,
      visualization: {
        frameA: {
          hasDrawable: evidence.visualization?.frameA?.drawPlan?.hasDrawable ?? false,
          targetFound: evidence.visualization?.frameA?.drawPlan?.targetFound ?? false,
          anchor: evidence.visualization?.frameA?.anchor,
        },
        frameB: {
          hasDrawable: evidence.visualization?.frameB?.drawPlan?.hasDrawable ?? false,
          targetFound: evidence.visualization?.frameB?.drawPlan?.targetFound ?? false,
          anchor: evidence.visualization?.frameB?.anchor,
        },
        vectors: evidence.vectors,
      },
    },
    reviewedAt: null,
    reviewerId: null,
    roadEdgeOverlapImpliesIdentitySwap: false,
    physicalPairKey: physicalPairKey({
      segmentId: manifestRecord.segmentId,
      logMonoTimeA: evidence.frameCorrespondence?.logMonoTimeA,
      logMonoTimeB: evidence.frameCorrespondence?.logMonoTimeB,
    }),
  };
}

function mergeExistingReview(base, existing) {
  if (!existing || existing.reviewStatus === REVIEW_STATUS.PENDING_HUMAN) return base;
  if (existing.reviewStatus === REVIEW_STATUS.COMPLETED) {
    return { ...base, ...existing, evidenceGeneration: base.evidenceGeneration };
  }
  return base;
}

function summarizeGroup(reviews, groupKey) {
  const groupReviews = reviews.filter((r) => assignPriorityGroup({ reviewGroup: r.reviewGroup, selectionReason: r.selectionReason, developmentRecordIndex: r.developmentRecordIndex }) === groupKey
    || (groupKey === 'priority1' && r.reviewGroup === 'legacy_positive_vector_negative')
    || (groupKey === 'priority2' && r.reviewGroup === 'fallback')
    || (groupKey === 'priority3' && r.reviewGroup === 'legacy_negative_vector_positive_sample')
    || (groupKey === 'priority4' && (r.reviewGroup === 'known_damaged_development' || [111, 112, 120, 191].includes(r.developmentRecordIndex))));

  const completed = groupReviews.filter((r) => isCompletedReview(r));
  const resolved = completed.filter((r) => isResolvedReview(r));
  const unresolved = completed.filter((r) => r.temporalContinuation === 'unresolved');
  const evidenceUnavailable = completed.filter((r) => r.evidenceAvailable === false);
  const confidence = { high: 0, medium: 0, low: 0 };
  const continuation = { positive_continuation: 0, negative_continuation: 0, unresolved: 0 };
  const identitySwap = { true: 0, false: 0, unresolved: 0 };
  const geometryIssue = { true: 0, false: 0, unresolved: 0 };

  for (const r of completed) {
    if (r.confidence) confidence[r.confidence] = (confidence[r.confidence] || 0) + 1;
    if (r.temporalContinuation) continuation[r.temporalContinuation] = (continuation[r.temporalContinuation] || 0) + 1;
    if (r.identitySwap) identitySwap[r.identitySwap] = (identitySwap[r.identitySwap] || 0) + 1;
    if (r.geometryIssue) geometryIssue[r.geometryIssue] = (geometryIssue[r.geometryIssue] || 0) + 1;
  }

  return {
    attempted: groupReviews.length,
    completed: completed.length,
    pendingHuman: groupReviews.filter((r) => r.reviewStatus === REVIEW_STATUS.PENDING_HUMAN).length,
    resolved: resolved.length,
    unresolved: unresolved.length,
    evidenceUnavailable: evidenceUnavailable.length,
    confidence,
    continuation,
    identitySwap,
    geometryIssue,
    remaining: groupReviews.filter((r) => r.reviewStatus === REVIEW_STATUS.PENDING_HUMAN).length,
  };
}

function calculateStratumMetrics(reviews, stratumId, filterFn) {
  const stratum = reviews.filter(filterFn);
  const runtimeOnly = stratum.filter((r) => r.runtimeOnly && !r.developmentRecord);
  const completed = stratum.filter((r) => isCompletedReview(r));
  const resolved = completed.filter((r) => isResolvedReview(r));
  const legacyAgree = completed.filter((r) => {
    const manualPos = r.temporalContinuation === 'positive_continuation';
    const manualNeg = r.temporalContinuation === 'negative_continuation';
    const legacyPos = r.legacyDecision === 'positive';
    return (manualPos && legacyPos) || (manualNeg && r.legacyDecision === 'negative');
  });
  const vectorAgree = completed.filter((r) => {
    const manualPos = r.temporalContinuation === 'positive_continuation';
    const manualNeg = r.temporalContinuation === 'negative_continuation';
    const vectorPos = r.vectorShadowDecision === 'positive';
    return (manualPos && vectorPos) || (manualNeg && r.vectorShadowDecision === 'negative');
  });

  return {
    stratumId,
    label: 'targeted-stratum results — not general runtime performance',
    reviewedCount: completed.length,
    resolvedCount: resolved.length,
    unresolvedCount: completed.filter((r) => r.temporalContinuation === 'unresolved').length,
    evidenceAvailableRate: completed.length
      ? +(completed.filter((r) => r.evidenceAvailable).length / completed.length).toFixed(4)
      : null,
    manualPositiveSupport: completed.filter((r) => r.temporalContinuation === 'positive_continuation').length,
    manualNegativeSupport: completed.filter((r) => r.temporalContinuation === 'negative_continuation').length,
    legacyAgreementCount: legacyAgree.length,
    legacyAgreementRate: completed.length ? +(legacyAgree.length / completed.length).toFixed(4) : null,
    vectorAgreementCount: vectorAgree.length,
    vectorAgreementRate: completed.length ? +(vectorAgree.length / completed.length).toFixed(4) : null,
    confidenceDistribution: {
      high: completed.filter((r) => r.confidence === 'high').length,
      medium: completed.filter((r) => r.confidence === 'medium').length,
      low: completed.filter((r) => r.confidence === 'low').length,
    },
    identitySwapCount: completed.filter((r) => r.identitySwap === 'true').length,
    geometryIssueCount: completed.filter((r) => r.geometryIssue === 'true').length,
    segmentCoverage: [...new Set(stratum.map((r) => r.evidenceGeneration?.frameCorrespondence?.segmentId ?? r.segmentId))].length,
    runtimeOnlyResolvedCount: runtimeOnly.filter((r) => isResolvedReview(r)).length,
    independentRuntimeValidation: stratumId.startsWith('D') || stratumId.startsWith('E') ? false : true,
  };
}

function assessRegressionRisk(reviews) {
  const group = reviews.filter((r) => r.reviewGroup === 'legacy_positive_vector_negative');
  const completed = group.filter((r) => r.reviewStatus !== REVIEW_STATUS.PENDING_HUMAN);
  const supportLegacy = completed.filter((r) => r.temporalContinuation === 'positive_continuation');
  const supportVector = completed.filter((r) => r.temporalContinuation === 'negative_continuation');
  const unresolved = completed.filter((r) => r.temporalContinuation === 'unresolved');
  const geometryIssues = completed.filter((r) => r.geometryIssue === 'true');
  const identitySwaps = completed.filter((r) => r.identitySwap === 'true');
  const highConf = completed.filter((r) => r.confidence === 'high');
  const excludingLow = completed.filter((r) => r.confidence !== 'low');

  return {
    label: '82 regression-risk cases (legacy+/vector−) — targeted stratum',
    total: group.length,
    completed: completed.length,
    pendingHuman: group.filter((r) => r.reviewStatus === REVIEW_STATUS.PENDING_HUMAN).length,
    supportLegacyAcceptance: supportLegacy.length,
    supportVectorRejection: supportVector.length,
    unresolved: unresolved.length,
    geometryIssues: geometryIssues.length,
    identitySwaps: identitySwaps.length,
    byConfidence: {
      high: completed.filter((r) => r.confidence === 'high').length,
      medium: completed.filter((r) => r.confidence === 'medium').length,
      low: completed.filter((r) => r.confidence === 'low').length,
    },
    afterExcludingLowConfidence: {
      completed: excludingLow.length,
      supportLegacyAcceptance: excludingLow.filter((r) => r.temporalContinuation === 'positive_continuation').length,
      supportVectorRejection: excludingLow.filter((r) => r.temporalContinuation === 'negative_continuation').length,
      unresolved: excludingLow.filter((r) => r.temporalContinuation === 'unresolved').length,
    },
    blockerNote: 'Main blocker for vector_limited activation until human visual review completes',
  };
}

function determineRecommendation(progress, evidenceStats, stratified) {
  const runtimeResolved = stratified.A?.runtimeOnlyResolvedCount ?? 0;
  const evidenceFailRate = evidenceStats.failureCount / Math.max(1, evidenceStats.attempted);
  const pendingHuman = progress.totals.pendingHuman;

  if (evidenceFailRate > 0.15) {
    return {
      decision: 'repair_evidence_generation',
      rationale: 'Evidence generation failure rate exceeds 15% — visual review cannot proceed reliably',
    };
  }
  if (pendingHuman > 0 && runtimeResolved < 50) {
    return {
      decision: 'continue_manual_review',
      rationale: `${pendingHuman} cases await human visual review; ${runtimeResolved} independent runtime-only resolved labels (target: 50)`,
    };
  }
  if (runtimeResolved >= 50 && progress.regressionRisk.completed >= 82) {
    return {
      decision: 'vector_limited_canary_candidate',
      rationale: 'Minimum runtime review targets met — canary evaluation may be considered (not automatic approval)',
    };
  }
  return {
    decision: 'continue_manual_review',
    rationale: 'Evidence generation succeeded; human visual judgments required before validation sufficiency assessment',
  };
}

function runRuntimeManualReviewExecution(options = {}) {
  const root = options.root ?? process.cwd();
  const inputs = { ...DEFAULT_INPUTS, ...options.inputs };
  clearSegmentCache();

  const inputIntegrity = verifyStage25Inputs(root, inputs);
  const manifest = loadJson(path.resolve(root, inputs.stage25ManifestPath));
  const diagnostics = loadJson(path.resolve(root, inputs.stage24DiagnosticsPath));
  const diagById = indexDiagnosticsByPairId(diagnostics);

  const manualPath = path.resolve(root, inputs.stage20ManualPath);
  const manualHashBefore = fs.existsSync(manualPath) ? sha256File(manualPath) : null;

  const reviewsPath = path.resolve(root, inputs.reviewsOutputPath);
  let existingReviews = { reviews: [] };
  if (fs.existsSync(reviewsPath) && options.resume !== false) {
    existingReviews = loadJson(reviewsPath);
  }
  const existingById = new Map((existingReviews.reviews || []).map((r) => [r.reviewPairId, r]));

  const records = [...(manifest.records || [])].sort((a, b) => a.priority - b.priority || a.reviewPairId.localeCompare(b.reviewPairId));
  const reviews = [];
  const evidenceStats = { attempted: 0, success: 0, failure: 0, failures: [] };
  const physicalPairClusters = new Map();

  for (const manifestRecord of records) {
    const runtimeDiag = diagById.get(manifestRecord.reviewPairId) || null;
    evidenceStats.attempted += 1;
    const evidence = generateEvidencePackage(root, manifestRecord, runtimeDiag);

    const physKey = physicalPairKey({
      segmentId: manifestRecord.segmentId,
      logMonoTimeA: manifestRecord.visualEvidence?.frameA?.logMonoTime,
      logMonoTimeB: manifestRecord.visualEvidence?.frameB?.logMonoTime,
    });
    if (!physicalPairClusters.has(physKey)) physicalPairClusters.set(physKey, []);
    physicalPairClusters.get(physKey).push(manifestRecord.reviewPairId);

    let review;
    if (!evidence.ok || !evidence.evidenceAvailable) {
      evidenceStats.failure += 1;
      evidenceStats.failures.push({
        reviewPairId: manifestRecord.reviewPairId,
        issues: evidence.issues,
      });
      review = createAutoUnresolvedReview(manifestRecord, evidence, evidence.issues.join('; ') || 'evidence_unavailable');
    } else {
      evidenceStats.success += 1;
      review = createPendingHumanReview(manifestRecord, evidence);
    }

    review = mergeExistingReview(review, existingById.get(manifestRecord.reviewPairId));
    reviews.push(review);
  }

  const manualHashAfter = fs.existsSync(manualPath) ? sha256File(manualPath) : null;

  const checkpoints = {};
  for (const p of PRIORITY_ORDER) {
    checkpoints[p.key] = summarizeGroup(reviews, p.key);
  }

  const totals = {
    attempted: reviews.length,
    completed: reviews.filter((r) => r.reviewStatus !== REVIEW_STATUS.PENDING_HUMAN).length,
    pendingHuman: reviews.filter((r) => r.reviewStatus === REVIEW_STATUS.PENDING_HUMAN).length,
    autoUnresolved: reviews.filter((r) => r.reviewStatus === REVIEW_STATUS.AUTO_UNRESOLVED).length,
    humanCompleted: reviews.filter((r) => r.reviewStatus === REVIEW_STATUS.COMPLETED).length,
  };

  const repeatedPhysicalPairs = [...physicalPairClusters.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, reviewPairIds]) => ({ physicalPairKey: key, reviewPairIds, slotVariantCount: reviewPairIds.length }));

  const stratified = {
    A: calculateStratumMetrics(reviews, 'A_runtime_only_legacy_positive_vector_negative', (r) => r.runtimeOnly && r.reviewGroup === 'legacy_positive_vector_negative'),
    B: calculateStratumMetrics(reviews, 'B_runtime_only_legacy_negative_vector_positive_sample', (r) => r.runtimeOnly && r.reviewGroup === 'legacy_negative_vector_positive_sample'),
    C: calculateStratumMetrics(reviews, 'C_runtime_only_fallback_unavailable', (r) => r.runtimeOnly && r.reviewGroup === 'fallback'),
    D: calculateStratumMetrics(reviews, 'D_development_consistency_checks', (r) => r.developmentRecord === true),
    E: calculateStratumMetrics(reviews, 'E_known_damaged_development_indices', (r) => [111, 112, 120, 191].includes(r.developmentRecordIndex)),
  };

  const progress = {
    generatedAt: new Date().toISOString(),
    checkpoints,
    totals,
    regressionRisk: assessRegressionRisk(reviews),
    vectorRecoverySample: {
      label: 'legacy−/vector+ representative sample — targeted stratum',
      total: reviews.filter((r) => r.reviewGroup === 'legacy_negative_vector_positive_sample').length,
      completed: reviews.filter((r) => r.reviewGroup === 'legacy_negative_vector_positive_sample' && r.reviewStatus !== REVIEW_STATUS.PENDING_HUMAN).length,
      pendingHuman: reviews.filter((r) => r.reviewGroup === 'legacy_negative_vector_positive_sample' && r.reviewStatus === REVIEW_STATUS.PENDING_HUMAN).length,
      note: 'Displacement/heading/segment breakdown available after human review completion',
    },
    noCombinedHeadlineAccuracy: true,
  };

  const validationSufficiency = {
    minimumRuntimeResolvedTarget: 50,
    currentRuntimeOnlyResolved: stratified.A.runtimeOnlyResolvedCount + stratified.B.runtimeOnlyResolvedCount,
    regressionRiskReviewed: progress.regressionRisk.completed,
    regressionRiskTarget: 82,
    evidenceIntegrityOk: evidenceStats.failure / evidenceStats.attempted <= 0.15,
    note: 'Meeting numerical minimum does not automatically approve a canary',
  };

  const recommendation = determineRecommendation(progress, evidenceStats, stratified);

  return {
    generatedAt: new Date().toISOString(),
    stage: 'stage26-b-motion-runtime-manual-review',
    terminology: 'Targeted manual evidence review — not general runtime performance',
    inputIntegrity,
    manualLabelPreservation: {
      stage20ManualSha256Before: manualHashBefore,
      stage20ManualSha256After: manualHashAfter,
      unchanged: manualHashBefore === manualHashAfter,
    },
    evidenceGeneration: evidenceStats,
    reviews,
    progress,
    stratifiedResults: stratified,
    repeatedPhysicalPairClusters: repeatedPhysicalPairs,
    validationSufficiency,
    recommendation,
    reviewExecutionNote: 'Visual/manual judgments require human reviewer via stage26 review UI. Automatic labels are not inferred from residuals or automatic decisions.',
  };
}

function applyHumanReview(reviewsArtifact, submission) {
  const errors = validateReviewLabels(submission);
  if (errors.length) return { ok: false, errors };
  const idx = (reviewsArtifact.reviews || []).findIndex((r) => r.reviewPairId === submission.reviewPairId);
  if (idx < 0) return { ok: false, errors: ['reviewPairId not found'] };
  if (submission.roadEdgeOverlap === true && submission.identitySwap === 'true' && !submission.reviewerNote) {
    return { ok: false, errors: ['identitySwap=true with road-edge overlap requires explicit reviewerNote — overlap alone must not imply identitySwap'] };
  }
  const updated = {
    ...reviewsArtifact.reviews[idx],
    ...submission,
    reviewStatus: REVIEW_STATUS.COMPLETED,
    reviewedAt: new Date().toISOString(),
    roadEdgeOverlapImpliesIdentitySwap: false,
  };
  reviewsArtifact.reviews[idx] = updated;
  return { ok: true, review: updated };
}

function buildDeliverables(report) {
  const hashLines = Object.entries(report.inputIntegrity.hashes)
    .map(([k, v]) => `- ${k}: \`${v}\``)
    .join('\n');

  const checkpointLines = Object.entries(report.progress.checkpoints)
    .map(([key, cp]) => [
      `### ${key}`,
      `- attempted: ${cp.attempted}, completed: ${cp.completed}, pending human: ${cp.pendingHuman}`,
      `- resolved: ${cp.resolved}, unresolved: ${cp.unresolved}, evidence unavailable: ${cp.evidenceUnavailable}`,
      `- continuation (+/−/unresolved): ${cp.continuation.positive_continuation}/${cp.continuation.negative_continuation}/${cp.continuation.unresolved}`,
      `- identity swap (true/false/unresolved): ${cp.identitySwap.true}/${cp.identitySwap.false}/${cp.identitySwap.unresolved}`,
      `- geometry issue (true/false/unresolved): ${cp.geometryIssue.true}/${cp.geometryIssue.false}/${cp.geometryIssue.unresolved}`,
      `- confidence (high/medium/low): ${cp.confidence.high}/${cp.confidence.medium}/${cp.confidence.low}`,
      `- remaining: ${cp.remaining}`,
    ].join('\n'))
    .join('\n\n');

  const strataLines = Object.entries(report.stratifiedResults)
    .map(([key, s]) => `- **${key}** (${s.stratumId}): reviewed=${s.reviewedCount}, resolved=${s.resolvedCount}, runtime-only resolved=${s.runtimeOnlyResolvedCount}, independent validation=${s.independentRuntimeValidation}`)
    .join('\n');

  const summaryLines = [
    '# Stage 26 B-MOTION Runtime Manual Review Summary',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Input integrity',
    `- Manifest records: ${report.inputIntegrity.manifestCount}`,
    `- Development / runtime-only: ${report.inputIntegrity.developmentRecords} / ${report.inputIntegrity.runtimeOnlyRecords}`,
    `- Duplicate reviewPairIds: ${report.inputIntegrity.duplicateReviewPairIds.length}`,
    `- Missing evidence references: ${report.inputIntegrity.missingEvidenceReferences.length}`,
    `- Manual labels preserved: **${report.manualLabelPreservation.unchanged}**`,
    '',
    '### Input SHA-256 hashes',
    hashLines,
    '',
    '## Evidence generation',
    `- Attempted: ${report.evidenceGeneration.attempted}`,
    `- Success (renderable frames): ${report.evidenceGeneration.success}`,
    `- Auto-unresolved (evidence failure): ${report.evidenceGeneration.failure}`,
    `- Evidence success rate: ${(report.evidenceGeneration.success / report.evidenceGeneration.attempted * 100).toFixed(1)}%`,
    '',
    '## Review progress',
    `- Pending human visual review: **${report.progress.totals.pendingHuman}**`,
    `- Auto-unresolved: ${report.progress.totals.autoUnresolved}`,
    `- Human completed: ${report.progress.totals.humanCompleted}`,
    `- Runtime-only resolved labels (independent validation): **${report.validationSufficiency.currentRuntimeOnlyResolved}** / ${report.validationSufficiency.minimumRuntimeResolvedTarget} target`,
    '',
    '## Priority checkpoints',
    checkpointLines,
    '',
    '## Repeated physical-pair clusters',
    `- Clusters with multiple source-slot pairings: ${report.repeatedPhysicalPairClusters.length}`,
    `- Note: each source-slot pairing retains a separate review record; labels are not copied across pairings`,
    '',
    '## Regression-risk group (legacy+/vector−)',
    `- Total: ${report.progress.regressionRisk.total}`,
    `- Pending human: ${report.progress.regressionRisk.pendingHuman}`,
    `- Completed: ${report.progress.regressionRisk.completed}`,
    `- Support legacy acceptance: ${report.progress.regressionRisk.supportLegacyAcceptance}`,
    `- Support vector rejection: ${report.progress.regressionRisk.supportVectorRejection}`,
    `- Unresolved: ${report.progress.regressionRisk.unresolved}`,
    `- Geometry issues: ${report.progress.regressionRisk.geometryIssues}`,
    `- Identity swaps: ${report.progress.regressionRisk.identitySwaps}`,
    '',
    '## Fallback / unavailable stratum (runtime-only)',
    `- Reviewed (auto): ${report.stratifiedResults.C.reviewedCount}`,
    `- Evidence available rate: ${report.stratifiedResults.C.evidenceAvailableRate}`,
    `- Geometry issues: ${report.stratifiedResults.C.geometryIssueCount}`,
    '',
    '## Vector recovery sample (legacy−/vector+)',
    `- Total in manifest: ${report.progress.vectorRecoverySample.total}`,
    `- Pending human: ${report.progress.vectorRecoverySample.pendingHuman}`,
    `- ${report.progress.vectorRecoverySample.note}`,
    '',
    '## Stratified results (targeted — not combined headline accuracy)',
    strataLines,
    '',
    '## Validation sufficiency',
    `- Runtime-only resolved: ${report.validationSufficiency.currentRuntimeOnlyResolved} / ${report.validationSufficiency.minimumRuntimeResolvedTarget}`,
    `- Regression-risk reviewed: ${report.validationSufficiency.regressionRiskReviewed} / ${report.validationSufficiency.regressionRiskTarget}`,
    `- Evidence integrity OK: ${report.validationSufficiency.evidenceIntegrityOk}`,
    `- ${report.validationSufficiency.note}`,
    '',
    '## Recommendation',
    `- **${report.recommendation.decision}**`,
    `- ${report.recommendation.rationale}`,
    '',
    '## Review UI',
    '- Start server: `node scripts/stage26_b_motion_runtime_review_server.js`',
    '- Open: `http://localhost:3850/b-motion-review/stage26-runtime.html`',
    '',
    report.reviewExecutionNote,
    '',
    `*${report.terminology}*`,
  ];

  return {
    reviewsJson: {
      generatedAt: report.generatedAt,
      schemaVersion: 'stage26-b-motion-runtime-manual-reviews-v1',
      terminology: report.terminology,
      validLabels: VALID_LABELS,
      reviewQuestions: {
        temporalContinuation: 'positive_continuation | negative_continuation | unresolved',
        identitySwap: 'true | false | unresolved (road-edge overlap alone must not imply identitySwap)',
        geometryIssue: 'true | false | unresolved',
        evidenceAvailable: 'true | false',
        confidence: 'high | medium | low',
        reviewerNote: 'concise visible-evidence explanation',
      },
      reviews: report.reviews,
    },
    progressJson: report.progress,
    stratifiedJson: {
      generatedAt: report.generatedAt,
      terminology: report.terminology,
      noCombinedHeadlineAccuracy: true,
      strata: report.stratifiedResults,
      validationSufficiency: report.validationSufficiency,
      recommendation: report.recommendation,
    },
    summaryMarkdown: `${summaryLines.join('\n')}\n`,
    fullReport: report,
  };
}

module.exports = {
  VALID_LABELS,
  REVIEW_STATUS,
  DEFAULT_INPUTS,
  verifyStage25Inputs,
  validateReviewLabels,
  physicalPairKey,
  generateEvidencePackage,
  runRuntimeManualReviewExecution,
  applyHumanReview,
  buildDeliverables,
  calculateStratumMetrics,
  assessRegressionRisk,
};
