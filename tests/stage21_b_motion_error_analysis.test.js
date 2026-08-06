'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  EXPECTED_FP_INDICES,
  EXPECTED_FN_INDICES,
  FP_CATEGORIES,
  FN_CATEGORIES,
  deriveDividerRankFromFrame,
  verifyInputIntegrity,
  selectDisagreementRows,
  buildMetricConventionReport,
  runErrorAnalysis,
  noteMentionsRoadEdge,
  categorizeFalsePositive,
  categorizeFalseNegative,
  buildStructuredEvidence,
} = require('../lib/stage21_b_motion_error_analysis');
const { joinAutomaticAndManual, manualLabelToBinary } = require('../lib/stage20_b_motion_baseline_compare');

const ROOT = path.join(__dirname, '..');

describe('Stage 21 disagreement record selection', () => {
  it('selects exactly 33 disagreement records by index', () => {
    const manual = JSON.parse(fs.readFileSync(path.join(ROOT, 'deliverables/stage20-b-motion-manual-reviews-qc-v1.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'deliverables/stage20-b-motion-evidence-review-manifest.json'), 'utf8'));
    const join = joinAutomaticAndManual({
      automaticPairs: manifest.reviewPairs,
      manualReviews: manual.reviews,
    });
    const disagreements = join.joined.filter((row) => {
      if (manualLabelToBinary(row.manual.reviewerLabel) == null) return false;
      return (row.manualBinaryLabel === 'negative' && row.automaticContinuationDecision === 'positive')
        || (row.manualBinaryLabel === 'positive' && row.automaticContinuationDecision === 'negative');
    });
    const { selected, missing } = selectDisagreementRows(disagreements);
    assert.equal(selected.length, 33);
    assert.deepEqual(missing, []);
    assert.equal(EXPECTED_FP_INDICES.length, 11);
    assert.equal(EXPECTED_FN_INDICES.length, 22);
  });
});

describe('Stage 21 category accounting', () => {
  it('FP and FN primary categories sum to 33', () => {
    const report = runErrorAnalysis({ root: ROOT });
    const fpSum = Object.values(report.falsePositiveAnalysis.categoryCounts).reduce((a, b) => a + b, 0);
    const fnSum = Object.values(report.falseNegativeAnalysis.categoryCounts).reduce((a, b) => a + b, 0);
    assert.equal(fpSum, 11);
    assert.equal(fnSum, 22);
    assert.equal(fpSum + fnSum, 33);

    for (const key of Object.keys(report.falsePositiveAnalysis.categoryCounts)) {
      assert.ok(FP_CATEGORIES.includes(key));
    }
    for (const key of Object.keys(report.falseNegativeAnalysis.categoryCounts)) {
      assert.ok(FN_CATEGORIES.includes(key));
    }
  });
});

describe('Stage 21 input integrity', () => {
  it('joins by exact reviewPairId with no duplicates', () => {
    const integrity = verifyInputIntegrity({}, ROOT);
    assert.equal(integrity.joinSummary.unmatchedManual.length, 0);
    assert.equal(integrity.joinSummary.duplicateManualPairIds.length, 0);
    assert.equal(integrity.joinSummary.duplicateAutomaticPairIds.length, 0);
    assert.equal(integrity.manualFilePreserved, true);
    assert.ok(integrity.hashes.manualReviews);
  });

  it('does not modify the QC manual reviews file', () => {
    const manualPath = path.join(ROOT, 'deliverables/stage20-b-motion-manual-reviews-qc-v1.json');
    const before = fs.readFileSync(manualPath, 'utf8');
    runErrorAnalysis({ root: ROOT });
    const after = fs.readFileSync(manualPath, 'utf8');
    assert.equal(before, after);
  });
});

describe('Stage 21 rank and concept separation', () => {
  it('marks rank unavailable when frame has no lane lines', () => {
    const rank = deriveDividerRankFromFrame({ laneLines: [] }, 0);
    assert.equal(rank.available, false);
    assert.equal(rank.reason, 'no_lane_lines_in_frame');
  });

  it('keeps road-edge overlap separate from identity swap', () => {
    const note = 'divider overlaps orange road edge but same lane ordering';
    assert.equal(noteMentionsRoadEdge(note), true);
    const evidence = {
      manualNote: note,
      manualLabel: 'negative_non_continuation',
      evidenceAvailable: true,
      sourceSlotIndexStable: true,
      rankAnalysis: { rankStable: true, rankEvidenceStrength: 'strong' },
      automaticDecisionPath: { ruleDerivedClassification: 'ambiguous_motion_residual_candidate', steps: [] },
      concepts: {},
    };
    const cat = categorizeFalsePositive(evidence);
    assert.equal(cat.primaryCategory, 'road_edge_association_change');
    assert.notEqual(cat.primaryCategory, 'divider_rank_swap');
  });
});

describe('Stage 21 metric conventions', () => {
  it('reports null and zero-division F1 conventions without changing baseline', () => {
    const baseline = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'deliverables/stage20-b-motion-baseline-comparison.json'),
      'utf8',
    ));
    const report = buildMetricConventionReport(baseline);
    assert.equal(report.baselineValuesUnchanged, true);
    assert.equal(report.negativeF1NullConvention.value, null);
    assert.equal(report.zeroDivisionEqualsZeroConvention.negativeF1, 0);
    assert.equal(report.zeroDivisionEqualsZeroConvention.macroF1, 0.448);
    assert.equal(baseline.metrics.negativeF1.rate, null);
  });
});

describe('Stage 21 structured evidence', () => {
  it('distinguishes inference from direct evidence in concepts block', () => {
    const report = runErrorAnalysis({ root: ROOT });
    const fp = report.records.find((r) => r.recordIndex === 46);
    assert.ok(fp);
    assert.equal(fp.concepts.roadEdgeOverlap.notEquivalentToIdentitySwap, true);
    assert.equal(fp.concepts.roadEdgeOverlap.inferenceOnly, true);
  });

  it('categorizes FN cluster around 37.6 m residual as vehicle motion pattern', () => {
    const report = runErrorAnalysis({ root: ROOT });
    const cluster = report.falseNegativeAnalysis.observationPairClusters.find((c) => c.count === 4 && c.recordIndices.includes(0));
    assert.ok(cluster);
    const rec0 = report.records.find((r) => r.recordIndex === 0);
    assert.ok(rec0.motionInterpretation.spatialMuchLessThanPose);
    assert.ok(['valid_high_residual_continuation', 'vehicle_motion_not_compensated', 'stable_rank_despite_high_residual', 'residual_cap_rejection']
      .includes(rec0.category.primaryCategory));
  });
});
