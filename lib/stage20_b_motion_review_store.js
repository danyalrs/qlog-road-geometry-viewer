'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  REVIEWS_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION,
} = require('./stage20_b_motion_review_constants');
const { validateReviewRecord } = require('./stage20_b_motion_review_validate');
const { buildReviewRecord } = require('./stage20_b_motion_review_validate');

const DEFAULT_REVIEWS_PATH = 'deliverables/stage20-b-motion-manual-reviews-v1.json';

function manifestContentHash(manifest) {
  return crypto.createHash('sha256').update(JSON.stringify(manifest.reviewPairs)).digest('hex');
}

function emptyReviewsArtifact(manifest, manifestPath) {
  const now = new Date().toISOString();
  return {
    schemaVersion: REVIEWS_SCHEMA_VERSION,
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    manifestPath,
    manifestContentHash: manifestContentHash(manifest),
    createdAt: now,
    updatedAt: now,
    reviews: [],
  };
}

function loadReviewsArtifact(reviewsPath, manifest, manifestPath) {
  if (!fs.existsSync(reviewsPath)) {
    return emptyReviewsArtifact(manifest, manifestPath);
  }
  const data = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
  if (!Array.isArray(data.reviews)) data.reviews = [];
  return data;
}

function saveReviewsArtifact(reviewsPath, artifact) {
  const dir = path.dirname(reviewsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  artifact.updatedAt = new Date().toISOString();
  const tmp = `${reviewsPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.renameSync(tmp, reviewsPath);
  return artifact;
}

function getReviewByPairAndReviewer(artifact, reviewPairId, reviewerId) {
  return (artifact.reviews || []).find(
    (r) => r.reviewPairId === reviewPairId && r.reviewerId === reviewerId,
  );
}

function upsertReview(artifact, manifest, submission) {
  const pairById = new Map((manifest.reviewPairs || []).map((p) => [p.reviewPairId, p]));
  const manifestPair = pairById.get(submission.reviewPairId);
  if (!manifestPair) {
    return { ok: false, error: 'unknown_pair', issues: [{ code: 'B-MR-R006', message: 'unknown pair' }] };
  }

  const existing = getReviewByPairAndReviewer(artifact, submission.reviewPairId, submission.reviewerId);
  if (existing) {
    return { ok: false, error: 'duplicate_review', issues: [{ code: 'B-MR-R005', message: 'duplicate review' }] };
  }

  const record = buildReviewRecord(manifestPair, submission);
  const issues = validateReviewRecord(record, pairById);
  if (issues.length > 0) {
    return { ok: false, error: 'validation_failed', issues };
  }

  artifact.reviews.push(record);
  artifact.manifestContentHash = manifestContentHash(manifest);
  return { ok: true, record };
}

function buildReviewIndex(artifact) {
  const byPair = new Map();
  for (const review of artifact.reviews || []) {
    if (!byPair.has(review.reviewPairId)) byPair.set(review.reviewPairId, []);
    byPair.get(review.reviewPairId).push(review);
  }
  return byPair;
}

module.exports = {
  DEFAULT_REVIEWS_PATH,
  manifestContentHash,
  emptyReviewsArtifact,
  loadReviewsArtifact,
  saveReviewsArtifact,
  getReviewByPairAndReviewer,
  upsertReview,
  buildReviewIndex,
};
