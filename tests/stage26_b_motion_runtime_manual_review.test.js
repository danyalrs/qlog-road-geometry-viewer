'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  VALID_LABELS,
  REVIEW_STATUS,
  verifyStage25Inputs,
  validateReviewLabels,
  physicalPairKey,
  runRuntimeManualReviewExecution,
  applyHumanReview,
  buildDeliverables,
  calculateStratumMetrics,
  assessRegressionRisk,
} = require('../lib/stage26_b_motion_runtime_manual_review');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'deliverables/stage25-b-motion-manual-review-manifest.json');
const MANUAL_PATH = path.join(ROOT, 'deliverables/stage20-b-motion-manual-reviews-qc-v1.json');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

describe('Stage 26 Stage 25 manifest integrity', () => {
  it('verifies 134-case manifest with expected breakdown', () => {
    const integrity = verifyStage25Inputs(ROOT);
    assert.equal(integrity.manifestCount, 134);
    assert.equal(integrity.developmentRecords, 11);
    assert.equal(integrity.runtimeOnlyRecords, 123);
    assert.equal(integrity.duplicateReviewPairIds.length, 0);
    assert.equal(integrity.priorityBreakdown.priority1_legacyPositiveVectorNegative, 82);
    assert.equal(integrity.priorityBreakdown.priority2_fallback, 12);
    assert.equal(integrity.priorityBreakdown.developmentRecords, 11);
    assert.equal(integrity.priorityBreakdown.runtimeOnly, 123);
    assert.ok(integrity.hashes.stage25ManifestPath);
  });

  it('has no missing evidence references in manifest', () => {
    const integrity = verifyStage25Inputs(ROOT);
    assert.equal(integrity.missingEvidenceReferences.length, 0);
  });
});

describe('Stage 26 manual file hash preservation', () => {
  it('does not modify stage20 manual labels during execution', () => {
    const before = sha256File(MANUAL_PATH);
    const report = runRuntimeManualReviewExecution({ root: ROOT });
    const after = sha256File(MANUAL_PATH);
    assert.equal(before, after);
    assert.equal(report.manualLabelPreservation.unchanged, true);
  });
});

describe('Stage 26 reviewPairId joining', () => {
  it('joins every manifest record to diagnostics by exact reviewPairId', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const diag = JSON.parse(fs.readFileSync(path.join(ROOT, 'deliverables/stage24-b-motion-runtime-comparison-diagnostics.json'), 'utf8'));
    const diagIds = new Set(diag.diagnostics.map((r) => r.reviewPairId));
    for (const rec of manifest.records) {
      assert.ok(diagIds.has(rec.reviewPairId), `missing diag for ${rec.reviewPairId}`);
    }
  });
});

describe('Stage 26 development/runtime-only separation', () => {
  it('tracks development records separately from runtime-only', () => {
    const report = runRuntimeManualReviewExecution({ root: ROOT });
    const dev = report.reviews.filter((r) => r.developmentRecord);
    const runtime = report.reviews.filter((r) => r.runtimeOnly && !r.developmentRecord);
    assert.equal(dev.length, 11);
    assert.equal(runtime.length, 123);
  });
});

describe('Stage 26 label vocabulary', () => {
  it('accepts valid label combinations', () => {
    const errors = validateReviewLabels({
      temporalContinuation: 'positive_continuation',
      identitySwap: 'false',
      geometryIssue: 'false',
      evidenceAvailable: true,
      confidence: 'high',
    });
    assert.equal(errors.length, 0);
    assert.deepEqual(VALID_LABELS.temporalContinuation, ['positive_continuation', 'negative_continuation', 'unresolved']);
  });

  it('requires unresolved when evidence is unavailable', () => {
    const errors = validateReviewLabels({
      temporalContinuation: 'positive_continuation',
      identitySwap: 'false',
      geometryIssue: 'false',
      evidenceAvailable: false,
      confidence: 'low',
    });
    assert.ok(errors.some((e) => e.includes('unresolved')));
  });
});

describe('Stage 26 source-slot pairs remain separate', () => {
  it('preserves distinct reviewPairIds for repeated physical-pair clusters', () => {
    const report = runRuntimeManualReviewExecution({ root: ROOT });
    const clusters = report.repeatedPhysicalPairClusters.filter((c) => c.slotVariantCount > 1);
    for (const cluster of clusters) {
      assert.ok(cluster.reviewPairIds.length > 1);
      assert.equal(new Set(cluster.reviewPairIds).size, cluster.reviewPairIds.length);
    }
  });
});

describe('Stage 26 repeated physical-pair clusters', () => {
  it('reports clusters with multiple source-slot pairings', () => {
    const report = runRuntimeManualReviewExecution({ root: ROOT });
    assert.ok(Array.isArray(report.repeatedPhysicalPairClusters));
    for (const c of report.repeatedPhysicalPairClusters) {
      assert.ok(c.physicalPairKey);
      assert.ok(c.reviewPairIds.length >= 2);
    }
  });
});

describe('Stage 26 road-edge overlap does not imply identitySwap', () => {
  it('rejects identitySwap=true without reviewerNote when roadEdgeOverlap flagged', () => {
    const artifact = {
      reviews: [{
        reviewPairId: 'test|pair',
        reviewStatus: REVIEW_STATUS.PENDING_HUMAN,
      }],
    };
    const result = applyHumanReview(artifact, {
      reviewPairId: 'test|pair',
      temporalContinuation: 'negative_continuation',
      identitySwap: 'true',
      geometryIssue: 'false',
      evidenceAvailable: true,
      confidence: 'high',
      roadEdgeOverlap: true,
    });
    assert.equal(result.ok, false);
  });
});

describe('Stage 26 incremental review saving and resume', () => {
  it('merges completed human reviews on resume', () => {
    const outPath = path.join(ROOT, 'deliverables/stage26-b-motion-runtime-manual-reviews.json');
    const backup = fs.existsSync(outPath) ? fs.readFileSync(outPath) : null;
    try {
      const report1 = runRuntimeManualReviewExecution({ root: ROOT });
      const { reviewsJson } = buildDeliverables(report1);
      const completed = {
        ...reviewsJson.reviews[0],
        reviewStatus: REVIEW_STATUS.COMPLETED,
        temporalContinuation: 'positive_continuation',
        identitySwap: 'false',
        geometryIssue: 'false',
        evidenceAvailable: true,
        confidence: 'high',
        reviewerNote: 'test resume',
        reviewerId: 'test',
      };
      reviewsJson.reviews[0] = completed;
      fs.writeFileSync(outPath, `${JSON.stringify(reviewsJson, null, 2)}\n`);
      const report2 = runRuntimeManualReviewExecution({ root: ROOT, resume: true });
      const restored = report2.reviews.find((r) => r.reviewPairId === completed.reviewPairId);
      assert.equal(restored.reviewStatus, REVIEW_STATUS.COMPLETED);
      assert.equal(restored.temporalContinuation, 'positive_continuation');
    } finally {
      if (backup) fs.writeFileSync(outPath, backup);
      else if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    }
  });
});

describe('Stage 26 stratified metric calculations', () => {
  it('labels strata as targeted-stratum results', () => {
    const report = runRuntimeManualReviewExecution({ root: ROOT });
    for (const stratum of Object.values(report.stratifiedResults)) {
      assert.match(stratum.label, /targeted-stratum/);
      assert.notEqual(stratum.independentRuntimeValidation, undefined);
    }
  });

  it('excludes development labels from independent runtime totals', () => {
    const report = runRuntimeManualReviewExecution({ root: ROOT });
    assert.equal(report.stratifiedResults.D.independentRuntimeValidation, false);
    assert.equal(report.stratifiedResults.E.independentRuntimeValidation, false);
    assert.equal(report.stratifiedResults.A.independentRuntimeValidation, true);
  });
});

describe('Stage 26 no unqualified combined targeted accuracy', () => {
  it('sets noCombinedHeadlineAccuracy in progress and stratified output', () => {
    const report = runRuntimeManualReviewExecution({ root: ROOT });
    assert.equal(report.progress.noCombinedHeadlineAccuracy, true);
    const { stratifiedJson } = buildDeliverables(report);
    assert.equal(stratifiedJson.noCombinedHeadlineAccuracy, true);
  });
});

describe('Stage 26 deterministic progress accounting', () => {
  it('accounts attempted/completed/pending consistently', () => {
    const report = runRuntimeManualReviewExecution({ root: ROOT });
    const { totals } = report.progress;
    assert.equal(totals.attempted, 134);
    assert.equal(totals.completed + totals.pendingHuman, totals.attempted);
    assert.equal(totals.autoUnresolved + totals.humanCompleted + totals.pendingHuman, totals.attempted);
  });
});

describe('Stage 26 regression-risk assessment structure', () => {
  it('tracks 82 legacy+/vector− cases', () => {
    const report = runRuntimeManualReviewExecution({ root: ROOT });
    assert.equal(report.progress.regressionRisk.total, 82);
    assert.ok(report.progress.regressionRisk.blockerNote);
  });
});

describe('Stage 26 evidence generation', () => {
  it('attempts evidence for all manifest cases', () => {
    const report = runRuntimeManualReviewExecution({ root: ROOT });
    assert.equal(report.evidenceGeneration.attempted, 134);
    assert.ok(report.evidenceGeneration.success >= 0);
    assert.equal(report.evidenceGeneration.success + report.evidenceGeneration.failure, 134);
  });
});
