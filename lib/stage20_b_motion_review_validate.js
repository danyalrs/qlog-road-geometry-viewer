'use strict';

const {
  APPROVED_REVIEWER_LABELS,
  APPROVED_EVIDENCE_MODES,
  REVIEW_VALIDATION_CODES: C,
  MANIFEST_SCHEMA_VERSION,
} = require('./stage20_b_motion_review_constants');
const { buildMeasurementFingerprint } = require('./stage20_b_motion_review_fingerprint');

const BLINDED_PAIR_FIELDS = Object.freeze([
  'reviewPairId',
  'observationIdA',
  'observationIdB',
  'segmentId',
  'parentTrackId',
  'temporalPassIdA',
  'temporalPassIdB',
  'chunkIdA',
  'chunkIdB',
  'poseSectionIdA',
  'poseSectionIdB',
  'logMonoTimeA',
  'logMonoTimeB',
  'deltaTimeS',
  'spatialM',
  'routeSGapM',
  'headingDiffDeg',
  'lateralDeltaM',
  'speedMps',
  'expectedMotionM',
  'poseDisplacementM',
  'residualAfterPoseM',
  'residualRouteSAfterSpeedM',
  'stage17GapIntersection',
  'rev37StaticEdgePass',
  'qlogReference',
  'videoReference',
  'videoAvailableInWorkspace',
  'evidenceProvenance',
  'reviewStatus',
]);

function blindPairForReview(pair, options = {}) {
  const blinded = {};
  for (const key of BLINDED_PAIR_FIELDS) {
    if (pair[key] !== undefined) blinded[key] = pair[key];
  }
  if (options.root) {
    const fs = require('fs');
    const path = require('path');
    blinded.videoAvailableInWorkspace = pair.qlogReference
      ? fs.existsSync(path.join(options.root, pair.qlogReference))
      : false;
  }
  return blinded;
}

function revealRuleDerivedAfterReview(pair) {
  return {
    ruleDerivedClassification: pair.ruleDerivedClassification ?? null,
    stratificationBucket: pair.stratificationBucket ?? null,
    applicableRejectionConditions: pair.applicableRejectionConditions ?? [],
  };
}

function validateReviewRecord(review, manifestPairById, options = {}) {
  const issues = [];
  const add = (code, message, field = null) => {
    issues.push({ code, message, field, reviewPairId: review.reviewPairId ?? null });
  };

  if (!review.reviewPairId) {
    add(C.B_MR_R006, 'missing reviewPairId');
    return issues;
  }

  const manifestPair = manifestPairById.get(review.reviewPairId);
  if (!manifestPair) {
    add(C.B_MR_R006, `unknown reviewPairId: ${review.reviewPairId}`);
    return issues;
  }

  if (!review.reviewerLabel || !APPROVED_REVIEWER_LABELS.includes(review.reviewerLabel)) {
    add(C.B_MR_R001, `invalid reviewerLabel: ${review.reviewerLabel}`, 'reviewerLabel');
  }

  if (!review.reviewerId || typeof review.reviewerId !== 'string' || !review.reviewerId.trim()) {
    add(C.B_MR_R002, 'missing reviewerId', 'reviewerId');
  }

  if (!review.reviewedAt || Number.isNaN(Date.parse(review.reviewedAt))) {
    add(C.B_MR_R003, 'missing or invalid reviewedAt', 'reviewedAt');
  }

  if (!review.evidenceMode || !APPROVED_EVIDENCE_MODES.includes(review.evidenceMode)) {
    add(C.B_MR_R001, `invalid evidenceMode: ${review.evidenceMode}`, 'evidenceMode');
  }

  if (
    (review.reviewerLabel === 'positive_continuation' || review.reviewerLabel === 'negative_non_continuation')
    && review.evidenceMode === 'insufficient'
  ) {
    add(C.B_MR_R007, 'positive/negative label not allowed with evidenceMode insufficient');
  }

  for (const field of ['observationIdA', 'observationIdB']) {
    if (review[field] !== manifestPair[field]) {
      add(C.B_MR_R004, `${field} changed from manifest`, field);
    }
  }

  const expectedFp = buildMeasurementFingerprint(manifestPair);
  if (!review.measurementFingerprint) {
    add(C.B_MR_R008, 'missing measurementFingerprint', 'measurementFingerprint');
  } else if (review.measurementFingerprint !== expectedFp) {
    add(C.B_MR_R008, 'measurementFingerprint does not match manifest pair', 'measurementFingerprint');
  }

  if (review.manifestVersion && review.manifestVersion !== MANIFEST_SCHEMA_VERSION) {
    add(C.B_MR_R010, `manifestVersion mismatch: ${review.manifestVersion}`, 'manifestVersion');
  }

  if (
    manifestPair.ruleDerivedClassification
    && review.reviewerLabel === manifestPair.ruleDerivedClassification
  ) {
    add(C.B_MR_R009, 'reviewerLabel matches ruleDerivedClassification — auto-copy rejected', 'reviewerLabel');
  }

  const ruleToLabel = {
    valid_same_track_continuation: 'positive_continuation',
    invalid_across_session_boundary: 'negative_non_continuation',
    invalid_across_chunk_boundary: 'negative_non_continuation',
    invalid_across_pose_section_boundary: 'negative_non_continuation',
    invalid_across_stage17_gap: 'negative_non_continuation',
  };
  const mapped = ruleToLabel[manifestPair.ruleDerivedClassification];
  if (
    mapped
    && review.reviewerLabel === mapped
    && options.strictRuleBlindCheck
    && !review.reviewerNotes?.trim()
  ) {
    add(C.B_MR_R009, 'reviewerLabel appears copied from rule-derived classification without independent notes', 'reviewerLabel');
  }

  return issues;
}

function validateReviewCollection(reviewsArtifact, manifest) {
  const issues = [];
  const pairById = new Map((manifest.reviewPairs || []).map((p) => [p.reviewPairId, p]));
  const seen = new Map();

  for (const review of reviewsArtifact.reviews || []) {
    issues.push(...validateReviewRecord(review, pairById));

    const key = `${review.reviewPairId}::${review.reviewerId}`;
    if (seen.has(key)) {
      issues.push({
        code: C.B_MR_R005,
        message: `duplicate review by reviewer ${review.reviewerId} for pair ${review.reviewPairId}`,
        reviewPairId: review.reviewPairId,
      });
    }
    seen.set(key, true);
  }

  return { ok: issues.length === 0, issueCount: issues.length, issues };
}

function buildReviewRecord(manifestPair, submission) {
  return {
    reviewPairId: manifestPair.reviewPairId,
    reviewerLabel: submission.reviewerLabel,
    reviewerId: submission.reviewerId,
    reviewedAt: submission.reviewedAt || new Date().toISOString(),
    evidenceMode: submission.evidenceMode,
    reviewerNotes: submission.reviewerNotes ?? '',
    observationIdA: manifestPair.observationIdA,
    observationIdB: manifestPair.observationIdB,
    measurementFingerprint: buildMeasurementFingerprint(manifestPair),
    manifestVersion: MANIFEST_SCHEMA_VERSION,
    sourcePairIndex: submission.sourcePairIndex ?? null,
  };
}

module.exports = {
  blindPairForReview,
  revealRuleDerivedAfterReview,
  validateReviewRecord,
  validateReviewCollection,
  buildReviewRecord,
  BLINDED_PAIR_FIELDS,
};
