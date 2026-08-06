'use strict';

const fs = require('fs');
const path = require('path');
const { THRESHOLD_APPROVAL_GATES } = require('./stage20_b_motion_review_constants');
const { validateReviewCollection } = require('./stage20_b_motion_review_validate');
const { buildReviewIndex } = require('./stage20_b_motion_review_store');
const { isQlogInWorkspace } = require('./stage20_b_motion_manifest_validate');

function resolvePrimaryReview(reviewsForPair) {
  if (!reviewsForPair?.length) return null;
  return [...reviewsForPair].sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt))[0];
}

function buildProgressReport(manifest, reviewsArtifact, options = {}) {
  const root = options.root || process.cwd();
  const pairs = manifest.reviewPairs || [];
  const reviewIndex = buildReviewIndex(reviewsArtifact);
  const validation = validateReviewCollection(reviewsArtifact, manifest);

  let completed = 0;
  let pending = 0;
  let positive = 0;
  let negative = 0;
  let unresolved = 0;
  let videoReviewed = 0;
  let qlogOnlyReviewed = 0;
  let ruleDerivedPositive = 0;

  const completedPairIds = new Set();

  for (const pair of pairs) {
    if (pair.ruleDerivedClassification === 'valid_same_track_continuation') {
      ruleDerivedPositive += 1;
    }

    const reviews = reviewIndex.get(pair.reviewPairId) || [];
    const primary = resolvePrimaryReview(reviews);
    if (!primary) {
      pending += 1;
      continue;
    }

    completed += 1;
    completedPairIds.add(pair.reviewPairId);

    if (primary.reviewerLabel === 'positive_continuation') positive += 1;
    else if (primary.reviewerLabel === 'negative_non_continuation') negative += 1;
    else if (primary.reviewerLabel === 'unresolved') unresolved += 1;

    if (primary.evidenceMode === 'video' || primary.evidenceMode === 'combined') {
      videoReviewed += 1;
    } else if (primary.evidenceMode === 'qlog_playback') {
      qlogOnlyReviewed += 1;
    }
  }

  const gates = THRESHOLD_APPROVAL_GATES;
  const remaining = {
    reviewedPairs: Math.max(0, gates.minReviewedPairs - completed),
    positive: Math.max(0, gates.minPositive - positive),
    negative: Math.max(0, gates.minNegative - negative),
  };

  const unresolvedFraction = completed > 0 ? unresolved / completed : 0;
  const thresholdCalibrationBlocked = !(
    completed >= gates.minReviewedPairs
    && positive >= gates.minPositive
    && negative >= gates.minNegative
    && unresolvedFraction <= gates.maxUnresolvedFraction
  );

  const qlogFilesInWorkspace = fs.readdirSync(root).filter((f) => /^qlog_f449c.*\.bz2$/i.test(f)).length;
  const pairsWithQlog = pairs.filter((p) => p.qlogReference && isQlogInWorkspace(root, p.qlogReference)).length;

  return {
    generatedAt: new Date().toISOString(),
    manifestSchemaVersion: manifest.schemaVersion,
    reviewsSchemaVersion: reviewsArtifact.schemaVersion,
    totalPairs: pairs.length,
    completed,
    pending,
    positive,
    negative,
    unresolved,
    videoReviewed,
    qlogOnlyReviewed,
    invalidReviewRecords: validation.issueCount,
    invalidReviewIssues: validation.issues,
    ruleDerivedPositiveContinuations: ruleDerivedPositive,
    note: 'ruleDerivedPositiveContinuations are not manual positives',
    approvalGates: {
      minReviewedPairs: gates.minReviewedPairs,
      minPositive: gates.minPositive,
      minNegative: gates.minNegative,
      maxUnresolvedFraction: gates.maxUnresolvedFraction,
    },
    remaining,
    unresolvedFraction: +unresolvedFraction.toFixed(4),
    thresholdCalibrationBlocked,
    thresholdCalibrationBlockedReason: thresholdCalibrationBlocked
      ? 'threshold_approval_minimums_not_met'
      : null,
    qlogCoverage: {
      qlogFilesInWorkspace,
      pairsWithQlogAvailable: pairsWithQlog,
    },
    completedPairIds: [...completedPairIds].sort(),
  };
}

module.exports = {
  buildProgressReport,
  resolvePrimaryReview,
};
