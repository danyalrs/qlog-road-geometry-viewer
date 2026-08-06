'use strict';

const fs = require('fs');
const path = require('path');
const { validateReviewRecord } = require('./stage20_b_motion_review_validate');

const QC_RECORD_INDICES = Object.freeze([
  22, 25, 41, 42, 43, 44, 45, 46, 47, 56, 60, 65, 75, 92, 98, 104,
  130, 131, 132, 147, 170, 174, 184, 203, 212, 219,
]);

const DEFAULT_SOURCE_REVIEWS_PATH = 'deliverables/stage20-b-motion-manual-reviews-v1.json';
const DEFAULT_QC_BACKUP_PATH = 'deliverables/stage20-b-motion-manual-reviews-before-qc.json';
const DEFAULT_QC_REVIEWS_PATH = 'deliverables/stage20-b-motion-manual-reviews-qc-v1.json';
const EXPECTED_REVIEW_COUNT = 220;

function isQcRecordIndex(recordIndex) {
  return QC_RECORD_INDICES.includes(recordIndex);
}

function getReviewAtRecordIndex(artifact, recordIndex) {
  const reviews = artifact?.reviews || [];
  if (recordIndex < 0 || recordIndex >= reviews.length) return null;
  return reviews[recordIndex];
}

function copyReviewsFile(sourcePath, destPath) {
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(sourcePath, destPath);
}

function ensureQcBackup(sourcePath, backupPath) {
  if (fs.existsSync(backupPath)) {
    return { created: false, backupPath };
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`source reviews file not found: ${sourcePath}`);
  }
  copyReviewsFile(sourcePath, backupPath);
  return { created: true, backupPath };
}

function initializeQcArtifact(sourceArtifact) {
  return JSON.parse(JSON.stringify(sourceArtifact));
}

function loadOrInitializeQcArtifact(sourcePath, qcPath, manifest, manifestPath) {
  const { loadReviewsArtifact } = require('./stage20_b_motion_review_store');
  if (fs.existsSync(qcPath)) {
    return loadReviewsArtifact(qcPath, manifest, manifestPath);
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`source reviews file not found: ${sourcePath}`);
  }
  const sourceArtifact = loadReviewsArtifact(sourcePath, manifest, manifestPath);
  return initializeQcArtifact(sourceArtifact);
}

function buildQcProgressReport(artifact) {
  let qcReviewed = 0;
  let qcRemaining = 0;
  const pendingIndices = [];
  const reviewedIndices = [];

  for (const recordIndex of QC_RECORD_INDICES) {
    const review = getReviewAtRecordIndex(artifact, recordIndex);
    if (!review) {
      pendingIndices.push(recordIndex);
      qcRemaining += 1;
      continue;
    }
    if (review.qcReviewed === true) {
      qcReviewed += 1;
      reviewedIndices.push(recordIndex);
    } else {
      qcRemaining += 1;
      pendingIndices.push(recordIndex);
    }
  }

  return {
    qcTargetCount: QC_RECORD_INDICES.length,
    qcReviewed,
    qcRemaining,
    qcRecordIndices: [...QC_RECORD_INDICES],
    reviewedIndices,
    pendingIndices,
  };
}

function findNextQcRecordIndex(artifact) {
  for (const recordIndex of QC_RECORD_INDICES) {
    const review = getReviewAtRecordIndex(artifact, recordIndex);
    if (!review || review.qcReviewed !== true) return recordIndex;
  }
  return null;
}

function countLabels(artifact) {
  const counts = {
    positive_continuation: 0,
    negative_non_continuation: 0,
    unresolved: 0,
    other: 0,
  };
  for (const review of artifact.reviews || []) {
    if (counts[review.reviewerLabel] != null) counts[review.reviewerLabel] += 1;
    else counts.other += 1;
  }
  return counts;
}

function verifyQcArtifact(artifact) {
  const issues = [];
  const reviews = artifact?.reviews || [];

  if (reviews.length !== EXPECTED_REVIEW_COUNT) {
    issues.push({
      code: 'QC-001',
      message: `expected ${EXPECTED_REVIEW_COUNT} reviews, found ${reviews.length}`,
    });
  }

  const pairIds = new Set();
  for (const review of reviews) {
    if (!review.reviewPairId) {
      issues.push({ code: 'QC-002', message: 'review missing reviewPairId' });
      continue;
    }
    if (pairIds.has(review.reviewPairId)) {
      issues.push({
        code: 'QC-003',
        message: `duplicate reviewPairId: ${review.reviewPairId}`,
        reviewPairId: review.reviewPairId,
      });
    }
    pairIds.add(review.reviewPairId);
  }

  return {
    ok: issues.length === 0,
    reviewCount: reviews.length,
    uniquePairIds: pairIds.size,
    issues,
    labelCounts: countLabels(artifact),
  };
}

function buildQcChangeReport(qcArtifact, baselineArtifact) {
  const changes = [];
  for (const recordIndex of QC_RECORD_INDICES) {
    const current = getReviewAtRecordIndex(qcArtifact, recordIndex);
    const baseline = getReviewAtRecordIndex(baselineArtifact, recordIndex);
    if (!current || !baseline) continue;

    const labelChanged = current.reviewerLabel !== baseline.reviewerLabel;
    const noteChanged = (current.reviewerNotes || '') !== (baseline.reviewerNotes || '');
    const evidenceChanged = current.evidenceMode !== baseline.evidenceMode;
    const qcApplied = current.qcReviewed === true;

    if (labelChanged || noteChanged || evidenceChanged || qcApplied) {
      changes.push({
        recordIndex,
        reviewPairId: current.reviewPairId,
        sourcePairIndex: current.sourcePairIndex,
        previousReviewerLabel: current.previousReviewerLabel ?? baseline.reviewerLabel,
        reviewerLabel: current.reviewerLabel,
        labelChanged,
        noteChanged,
        evidenceChanged,
        qcReviewed: current.qcReviewed === true,
        qcReviewer: current.qcReviewer ?? null,
        qcReviewedAt: current.qcReviewedAt ?? null,
      });
    }
  }

  return {
    changedRecordCount: changes.filter((c) => c.labelChanged || c.noteChanged || c.evidenceChanged).length,
    qcReviewedCount: changes.filter((c) => c.qcReviewed).length,
    changes,
    finalLabelCounts: countLabels(qcArtifact),
    baselineLabelCounts: countLabels(baselineArtifact),
  };
}

function applyQcUpdate(artifact, manifest, submission) {
  const { recordIndex } = submission;
  if (!isQcRecordIndex(recordIndex)) {
    return {
      ok: false,
      error: 'not_qc_record',
      issues: [{ code: 'QC-004', message: `record index ${recordIndex} is not in QC scope` }],
    };
  }

  const review = getReviewAtRecordIndex(artifact, recordIndex);
  if (!review) {
    return {
      ok: false,
      error: 'record_not_found',
      issues: [{ code: 'QC-005', message: `no review at record index ${recordIndex}` }],
    };
  }

  const pairById = new Map((manifest.reviewPairs || []).map((p) => [p.reviewPairId, p]));
  const manifestPair = pairById.get(review.reviewPairId);
  if (!manifestPair) {
    return {
      ok: false,
      error: 'unknown_pair',
      issues: [{ code: 'QC-006', message: `unknown reviewPairId: ${review.reviewPairId}` }],
    };
  }

  const updated = { ...review };
  if (updated.qcReviewed !== true) {
    updated.previousReviewerLabel = review.reviewerLabel;
    updated.previousReviewerNote = review.reviewerNotes ?? '';
  }

  updated.reviewerLabel = submission.reviewerLabel;
  updated.reviewerNotes = submission.reviewerNotes ?? '';
  if (submission.evidenceMode) updated.evidenceMode = submission.evidenceMode;
  updated.qcReviewed = true;
  updated.qcReviewedAt = submission.qcReviewedAt || new Date().toISOString();
  updated.qcReviewer = submission.qcReviewer;
  updated.reviewedAt = updated.qcReviewedAt;

  const issues = validateReviewRecord(updated, pairById);
  if (issues.length > 0) {
    return { ok: false, error: 'validation_failed', issues };
  }

  artifact.reviews[recordIndex] = updated;
  return { ok: true, record: updated, recordIndex };
}

module.exports = {
  QC_RECORD_INDICES,
  DEFAULT_SOURCE_REVIEWS_PATH,
  DEFAULT_QC_BACKUP_PATH,
  DEFAULT_QC_REVIEWS_PATH,
  EXPECTED_REVIEW_COUNT,
  isQcRecordIndex,
  getReviewAtRecordIndex,
  ensureQcBackup,
  initializeQcArtifact,
  loadOrInitializeQcArtifact,
  buildQcProgressReport,
  findNextQcRecordIndex,
  countLabels,
  verifyQcArtifact,
  buildQcChangeReport,
  applyQcUpdate,
};
