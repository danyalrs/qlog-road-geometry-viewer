'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  compareCategory,
  residualStats,
  inferVectorDecisionReason,
  auditResidualDistributions,
  verifyChangedRecords,
  separateDevelopmentAndRuntime,
  buildVisualEvidencePackage,
  selectReviewManifest,
  runRuntimeDisagreementAudit,
  REVIEW_QUESTIONS,
  THRESHOLD_CAP_M,
} = require('../lib/stage25_b_motion_runtime_disagreement_audit');

const ROOT = path.join(__dirname, '..');
const DIAG_PATH = path.join(ROOT, 'deliverables/stage24-b-motion-runtime-comparison-diagnostics.json');
const MANUAL_PATH = path.join(ROOT, 'deliverables/stage20-b-motion-manual-reviews-qc-v1.json');

function loadDiagnostics() {
  const artifact = JSON.parse(fs.readFileSync(DIAG_PATH, 'utf8'));
  return artifact.diagnostics.map((r, i) => ({ ...r, _index: i }));
}

describe('Stage 25 diagnostic loading', () => {
  it('loads exactly 5010 runtime diagnostic records', () => {
    const rows = loadDiagnostics();
    assert.equal(rows.length, 5010);
  });
});

describe('Stage 25 comparison categories', () => {
  it('matches exact changed-decision totals', () => {
    const rows = loadDiagnostics();
    const audit = verifyChangedRecords(rows);
    assert.equal(audit.actualChangedTotal, 267);
    assert.equal(audit.legacyPositiveVectorNegative, 82);
    assert.equal(audit.legacyNegativeVectorPositive, 185);
    assert.equal(audit.countsMatch, true);
  });

  it('calculates residual distribution from vectorResidualM', () => {
    const rows = loadDiagnostics();
    const audit = auditResidualDistributions(rows, null);
    const lpvp = audit.recalculatedFromRawRecords.legacy_negative_vector_positive;
    assert.equal(lpvp.fieldUsed, 'vectorResidualM');
    assert.ok(lpvp.median != null);
    assert.ok(lpvp.countLe12M > 0);
    assert.equal(lpvp.count, lpvp.countLe12M + lpvp.countGt12M);
  });

  it('verifies vector-positive available cases satisfy residual <= 12 m', () => {
    const rows = loadDiagnostics();
    const positives = rows.filter((r) => r.geometryAvailable && r.vectorShadowDecision === 'positive' && !r.fallbackUsed);
    const violations = positives.filter((r) => r.vectorResidualM != null && r.vectorResidualM > THRESHOLD_CAP_M);
    assert.equal(violations.length, 0);
  });

  it('verifies vector-negative available non-boundary cases satisfy residual > 12 m', () => {
    const rows = loadDiagnostics();
    const negatives = rows.filter((r) => r.geometryAvailable && r.vectorShadowDecision === 'negative' && !r.fallbackUsed && !r.geometryIssue);
    const violations = negatives.filter((r) => r.vectorResidualM != null && r.vectorResidualM <= THRESHOLD_CAP_M);
    assert.equal(violations.length, 0);
  });
});

describe('Stage 25 fallback and unavailable handling', () => {
  it('handles fallback records separately from threshold residuals', () => {
    const rows = loadDiagnostics();
    const fallback = rows.filter((r) => r.fallbackUsed);
    assert.equal(fallback.length, 12);
    for (const row of fallback) {
      const reason = inferVectorDecisionReason(row);
      assert.equal(reason.reason, 'fallback_to_legacy');
    }
  });

  it('explains same-negative median without field confusion', () => {
    const rows = loadDiagnostics();
    const audit = auditResidualDistributions(rows, null);
    assert.equal(audit.sameNegativeMedianExplanation.reportingFixRequired, false);
    assert.equal(audit.sameNegativeMedianExplanation.fieldsChecked.vectorResidualM, 'Euclidean pose-compensated anchor residual (correct field)');
    assert.ok(audit.sameNegativeMedianExplanation.sameNegativeResidualLe12M > 0);
  });
});

describe('Stage 25 development vs runtime separation', () => {
  it('separates development and runtime-only changed decisions', () => {
    const report = runRuntimeDisagreementAudit({ root: ROOT });
    assert.equal(report.changedDecisionAudit.countsMatch, true);
    assert.equal(
      report.developmentVsRuntime.changedInDevelopmentSet + report.developmentVsRuntime.changedRuntimeOnly,
      267,
    );
    assert.ok(report.developmentVsRuntime.changedRuntimeOnly > report.developmentVsRuntime.changedInDevelopmentSet);
  });

  it('reports duplicate physical pairs from multiple source slots', () => {
    const rows = loadDiagnostics();
    const audit = verifyChangedRecords(rows);
    assert.ok(Array.isArray(audit.duplicatePhysicalPairs));
    assert.ok(audit.repeatedObservationPairClusters.length > 0);
  });
});

describe('Stage 25 manual review manifest', () => {
  it('never modifies manual labels', () => {
    const before = fs.readFileSync(MANUAL_PATH, 'utf8');
    runRuntimeDisagreementAudit({ root: ROOT });
    assert.equal(fs.readFileSync(MANUAL_PATH, 'utf8'), before);
  });

  it('keeps road-edge overlap separate from identitySwap in evidence package', () => {
    const rows = loadDiagnostics();
    const row = rows.find((r) => r.roadEdgeOverlap === true) || rows[0];
    const pkg = buildVisualEvidencePackage(row);
    assert.equal(pkg.roadEdgeOverlapImpliesIdentitySwap, false);
    assert.ok(REVIEW_QUESTIONS.note.includes('roadEdgeOverlap'));
  });

  it('produces deterministic review selection', () => {
    const rows = loadDiagnostics();
    const devIds = new Set(rows.filter((r) => r.developmentRecord).map((r) => r.reviewPairId));
    const a = selectReviewManifest(rows, devIds);
    const b = selectReviewManifest(rows, devIds);
    assert.deepEqual(a.records.map((r) => r.reviewPairId), b.records.map((r) => r.reviewPairId));
    assert.equal(a.breakdown.priority1_legacyPositiveVectorNegative, 82);
  });

  it('does not combine targeted strata into one accuracy metric', () => {
    const report = runRuntimeDisagreementAudit({ root: ROOT });
    assert.equal(report.validationPlan.noCombinedHeadlineAccuracy, true);
    assert.ok(report.validationPlan.strataReporting.legacyPositiveVectorNegative.labelsPending);
  });
});

describe('Stage 25 residual stats helper', () => {
  it('computes percentiles and threshold counts', () => {
    const stats = residualStats([1, 2, 3, 4, 13, 20]);
    assert.equal(stats.count, 6);
    assert.equal(stats.countLe12M, 4);
    assert.equal(stats.countGt12M, 2);
    assert.equal(stats.median, 3.5);
  });
});

describe('Stage 25 category helper', () => {
  it('assigns comparison categories correctly', () => {
    assert.equal(compareCategory('positive', 'positive'), 'same_positive');
    assert.equal(compareCategory('negative', 'negative'), 'same_negative');
    assert.equal(compareCategory('positive', 'negative'), 'legacy_positive_vector_negative');
    assert.equal(compareCategory('negative', 'positive'), 'legacy_negative_vector_positive');
  });
});
