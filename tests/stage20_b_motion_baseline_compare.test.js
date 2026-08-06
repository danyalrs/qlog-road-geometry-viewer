'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  joinAutomaticAndManual,
  deriveAutomaticContinuationDecision,
  deriveAutomaticConfidenceScore,
  manualLabelToBinary,
  buildConfusionMatrix,
  calculateMetrics,
  buildConfidenceAnalysis,
  categorizeUnresolvedRecord,
  compareBaseline,
  summarizeNumeric,
  THRESHOLD_CAP_M,
  THRESHOLD_OPERATOR,
  CONFIDENCE_FIELD,
} = require('../lib/stage20_b_motion_baseline_compare');

function makeAutomatic(overrides = {}) {
  return {
    reviewPairId: '0:0:100:0|0:0:200:0',
    ruleDerivedClassification: 'ambiguous_motion_residual_candidate',
    applicableRejectionConditions: [],
    residualAfterPoseM: 5.5,
    rev37StaticEdgePass: false,
    stage17GapIntersection: false,
    segmentId: 0,
    logMonoTimeA: '100',
    logMonoTimeB: '200',
    ...overrides,
  };
}

function makeManual(overrides = {}) {
  return {
    reviewPairId: '0:0:100:0|0:0:200:0',
    reviewerLabel: 'positive_continuation',
    reviewerNotes: 'same divider',
    evidenceMode: 'qlog_playback',
    ...overrides,
  };
}

describe('B-MOTION baseline compare join', () => {
  it('joins by exact reviewPairId and ignores array position', () => {
    const automaticPairs = [
      makeAutomatic({ reviewPairId: 'b|a' }),
      makeAutomatic({ reviewPairId: '0:0:100:0|0:0:200:0' }),
    ];
    const manualReviews = [
      makeManual({ reviewPairId: '0:0:100:0|0:0:200:0' }),
      makeManual({ reviewPairId: 'b|a', reviewerLabel: 'negative_non_continuation' }),
    ];
    const join = joinAutomaticAndManual({ automaticPairs, manualReviews });
    assert.equal(join.joined.length, 2);
    assert.equal(join.unmatchedManual.length, 0);
    assert.equal(join.unmatchedAutomatic.length, 0);
    assert.equal(join.joined[0].reviewPairId, '0:0:100:0|0:0:200:0');
    assert.equal(join.joined[1].reviewPairId, 'b|a');
  });

  it('reports duplicate and unmatched pair IDs', () => {
    const automaticPairs = [
      makeAutomatic(),
      makeAutomatic({ reviewPairId: 'dup|pair' }),
      makeAutomatic({ reviewPairId: 'dup|pair' }),
    ];
    const manualReviews = [
      makeManual(),
      makeManual({ reviewPairId: 'missing-auto|pair' }),
    ];
    const join = joinAutomaticAndManual({ automaticPairs, manualReviews });
    assert.equal(join.unmatchedManual.length, 1);
    assert.equal(join.unmatchedManual[0].reviewPairId, 'missing-auto|pair');
    assert.equal(join.duplicateAutomaticPairIds.length, 1);
  });
});

describe('B-MOTION baseline label mapping', () => {
  it('excludes unresolved labels from binary mapping', () => {
    assert.equal(manualLabelToBinary('positive_continuation'), 'positive');
    assert.equal(manualLabelToBinary('negative_non_continuation'), 'negative');
    assert.equal(manualLabelToBinary('unresolved'), null);
  });

  it('derives automatic positive and negative decisions from rule classifications', () => {
    assert.equal(
      deriveAutomaticContinuationDecision(makeAutomatic({ ruleDerivedClassification: 'valid_same_track_continuation' })).automaticContinuationDecision,
      'positive',
    );
    assert.equal(
      deriveAutomaticContinuationDecision(makeAutomatic({ ruleDerivedClassification: 'ambiguous_motion_residual_candidate' })).automaticContinuationDecision,
      'positive',
    );
    assert.equal(
      deriveAutomaticContinuationDecision(makeAutomatic({ ruleDerivedClassification: 'invalid_across_session_boundary' })).automaticContinuationDecision,
      'negative',
    );
    assert.equal(
      deriveAutomaticContinuationDecision(makeAutomatic({ ruleDerivedClassification: 'ambiguous_spatial_cap_failure' })).automaticContinuationDecision,
      'negative',
    );
  });
});

describe('B-MOTION baseline metrics', () => {
  it('builds confusion matrix and metrics with raw support counts', () => {
    const rows = [
      { manualBinaryLabel: 'positive', automaticContinuationDecision: 'positive' },
      { manualBinaryLabel: 'positive', automaticContinuationDecision: 'negative' },
      { manualBinaryLabel: 'negative', automaticContinuationDecision: 'negative' },
      { manualBinaryLabel: 'negative', automaticContinuationDecision: 'positive' },
    ];
    const confusion = buildConfusionMatrix(rows);
    assert.deepEqual(confusion, { tp: 1, tn: 1, fp: 1, fn: 1 });

    const metrics = calculateMetrics(confusion);
    assert.equal(metrics.accuracy.numerator, 2);
    assert.equal(metrics.accuracy.denominator, 4);
    assert.equal(metrics.positivePrecision.numerator, 1);
    assert.equal(metrics.positivePrecision.denominator, 2);
    assert.equal(metrics.classSupport.manualPositive, 2);
    assert.equal(metrics.classSupport.manualNegative, 2);
    assert.equal(metrics.balancedAccuracy.rate, 0.5);
    assert.equal(metrics.macroF1.rate, 0.5);
  });

  it('blocks metrics when resolved manual rows lack automatic results', () => {
    const report = compareBaseline({
      root: process.cwd(),
      manualReviewsPath: 'deliverables/stage20-b-motion-manual-reviews-qc-v1.json',
      automaticManifestPath: 'deliverables/stage20-b-motion-evidence-review-manifest.json',
    });
    if (report.joinSummary.unmatchedManualPairIds.length === 0
      && !report.blockingIssues.some((i) => i.code === 'missing_automatic_results_for_resolved_manual')) {
      assert.equal(report.metricsBlocked, false);
      assert.equal(report.joinSummary.resolvedManualCount, 175);
      assert.ok(report.confusionMatrix);
    }
  });
});

describe('B-MOTION baseline confidence handling', () => {
  it('uses residualAfterPoseM with lower-is-stronger direction and documents threshold', () => {
    const score = deriveAutomaticConfidenceScore(makeAutomatic({ residualAfterPoseM: 3.2 }));
    assert.equal(score.automaticConfidenceScore, 3.2);
    assert.equal(score.automaticConfidenceScoreFinite, true);

    const missing = deriveAutomaticConfidenceScore(makeAutomatic({ residualAfterPoseM: null }));
    assert.equal(missing.automaticConfidenceScoreMissing, true);
    assert.equal(missing.automaticConfidenceScoreFinite, false);

    const analysis = buildConfidenceAnalysis([
      {
        reviewPairId: 'a',
        manualBinaryLabel: 'positive',
        automaticContinuationDecision: 'positive',
        automaticConfidenceScore: 2,
        automaticConfidenceScoreFinite: true,
        automaticConfidenceScoreMissing: false,
        manual: { reviewerNotes: '' },
        automaticRuleReason: 'ambiguous_motion_residual_candidate',
        automaticRejectionConditions: [],
        manualRecordIndex: 0,
      },
      {
        reviewPairId: 'b',
        manualBinaryLabel: 'negative',
        automaticContinuationDecision: 'positive',
        automaticConfidenceScore: null,
        automaticConfidenceScoreFinite: false,
        automaticConfidenceScoreMissing: true,
        manual: { reviewerNotes: 'overlaps the orange road edge' },
        automaticRuleReason: 'ambiguous_motion_residual_candidate',
        automaticRejectionConditions: [],
        manualRecordIndex: 1,
      },
    ]);

    assert.equal(analysis.confidenceField, CONFIDENCE_FIELD);
    assert.equal(analysis.threshold.capM, THRESHOLD_CAP_M);
    assert.equal(analysis.threshold.operator, THRESHOLD_OPERATOR);
    assert.equal(analysis.missingConfidenceCount, 1);
    assert.equal(analysis.falsePositives.length, 1);
    assert.equal(analysis.falsePositives[0].roadEdgeOverlap, true);
    assert.equal(analysis.falsePositives[0].geometryIssue, true);
    assert.equal(summarizeNumeric([1, 2, 3]).median, 2);
  });
});

describe('B-MOTION unresolved analysis', () => {
  it('categorizes unresolved records without counting them as automatic errors', () => {
    const row = {
      manual: {
        reviewerLabel: 'unresolved',
        evidenceMode: 'insufficient',
        reviewerNotes: 'missing qlog',
      },
      automatic: makeAutomatic({ ruleDerivedClassification: 'invalid_across_session_boundary' }),
    };
    assert.equal(categorizeUnresolvedRecord(row), 'missing_playback_or_frame_evidence');

    const overlap = {
      manual: {
        reviewerLabel: 'unresolved',
        evidenceMode: 'qlog_playback',
        reviewerNotes: 'visual ambiguity near road edge overlap',
      },
      automatic: makeAutomatic(),
    };
    assert.equal(categorizeUnresolvedRecord(overlap), 'visual_ambiguity_or_overlap');
  });

  it('treats road-edge overlap as separate geometry issue in disagreements', () => {
    const analysis = buildConfidenceAnalysis([
      {
        reviewPairId: 'fp1',
        manualBinaryLabel: 'negative',
        automaticContinuationDecision: 'positive',
        automaticConfidenceScore: 4,
        automaticConfidenceScoreFinite: true,
        automaticConfidenceScoreMissing: false,
        manual: { reviewerNotes: 'divider overlaps orange road edge but same lane ordering' },
        automaticRuleReason: 'ambiguous_motion_residual_candidate',
        automaticRejectionConditions: [],
        manualRecordIndex: 7,
        rev37StaticEdgePass: false,
        stage17GapIntersection: false,
        segmentId: 1,
        logMonoTimeA: '1',
        logMonoTimeB: '2',
        qlogReference: 'qlog_f449c_1.bz2',
      },
    ]);
    const fp = analysis.falsePositives[0];
    assert.equal(fp.roadEdgeOverlap, true);
    assert.equal(fp.geometryIssue, true);
    assert.equal(fp.temporalContinuityCorrect, false);
    assert.match(fp.note, /not proof of temporal identity switch/);
  });
});
