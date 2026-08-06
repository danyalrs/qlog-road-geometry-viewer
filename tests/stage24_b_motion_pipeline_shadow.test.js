'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  PIPELINE_INTEGRATION,
  evaluatePairAtPipeline,
  aggregateShadowStats,
  buildManualReviewSample,
  revalidateDevelopmentSet,
  runPipelineShadowEvaluation,
} = require('../lib/stage24_b_motion_pipeline_shadow');
const {
  DECISION_MODES,
  DEFAULT_VECTOR_CONFIG,
} = require('../lib/stage23_b_motion_vector_residual');
const { classifyPair } = require('../lib/stage20_b_motion_pair_pipeline');
const { EXPECTED_CONFIG_B } = require('../lib/stage23_b_motion_limited_evaluation');

const ROOT = path.join(__dirname, '..');

function makePair(overrides = {}) {
  return {
    reviewPairId: '0:0:1:0|0:0:2:0',
    observationIdA: '0:0:1:0',
    observationIdB: '0:0:2:0',
    segmentId: 0,
    residualAfterPoseM: 5,
    ruleDerivedClassification: 'ambiguous_motion_residual_candidate',
    applicableRejectionConditions: [],
    rev37StaticEdgePass: false,
    logMonoTimeA: '1000',
    logMonoTimeB: '2000',
    ...overrides,
  };
}

describe('Stage 24 pipeline integration defaults', () => {
  it('documents runtime integration point', () => {
    assert.equal(PIPELINE_INTEGRATION.entryFunction, 'evaluatePairAtPipeline');
    assert.ok(PIPELINE_INTEGRATION.shadowHook.includes('vector_shadow'));
  });

  it('keeps feature flag disabled and default mode legacy_scalar', () => {
    assert.equal(DEFAULT_VECTOR_CONFIG.featureEnabled, false);
    assert.equal(DEFAULT_VECTOR_CONFIG.decisionMode, DECISION_MODES.LEGACY_SCALAR);
  });
});

describe('Stage 24 shadow mode behaviour', () => {
  it('shadow mode keeps legacy authoritative when vector differs', () => {
    const pair = makePair({ residualAfterPoseM: 37, ruleDerivedClassification: 'ambiguous_spatial_cap_failure' });
    const geometryContext = {
      boundary: { reject: false },
      roadEdgeOverlap: true,
      vectorResidual: {
        geometryAvailable: true,
        vectorResidualM: 0.5,
        targetDisplacementEastM: 0.5,
        targetDisplacementNorthM: 0,
        poseDisplacementEastM: 0,
        poseDisplacementNorthM: 0,
        compensatedEastM: 0.5,
        compensatedNorthM: 0,
        longitudinalResidualM: 0.5,
        lateralResidualM: 0,
        headingCompensatedResidualM: null,
        headingCompensatedUnavailableReason: 'heading_timestamps_not_aligned',
        unavailableReason: null,
        coordinateFrame: 'east/north metres',
        anchorModelXM: 15,
      },
    };
    const legacy = evaluatePairAtPipeline(pair, {
      decisionMode: DECISION_MODES.LEGACY_SCALAR,
      geometryContext,
      measurements: { boundary: { reject: false }, identity: { evidenceAvailable: true }, vectors: { vectorAvailable: false } },
    });
    const shadow = evaluatePairAtPipeline(pair, {
      decisionMode: DECISION_MODES.VECTOR_SHADOW,
      geometryContext,
      measurements: { boundary: { reject: false }, identity: { evidenceAvailable: true, roadEdgeOverlap: true }, vectors: { vectorAvailable: true } },
    });
    assert.equal(shadow.authoritativeDecision, 'negative');
    assert.equal(shadow.vectorShadowDecision, 'positive');
    assert.equal(shadow.authoritativeDecision, legacy.authoritativeLegacyDecision);
    assert.equal(shadow.roadEdgeOverlap, true);
    assert.equal(shadow.identitySwap, false);
  });

  it('falls back to legacy when geometry unavailable without auto-reject', () => {
    const pair = makePair({ ruleDerivedClassification: 'ambiguous_motion_residual_candidate' });
    const result = evaluatePairAtPipeline(pair, {
      decisionMode: DECISION_MODES.VECTOR_SHADOW,
      geometryContext: { boundary: { reject: false } },
      measurements: {
        boundary: { reject: false },
        identity: { evidenceAvailable: false },
        vectors: { vectorAvailable: false },
        unavailableFields: ['anchor_geometry'],
      },
    });
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.authoritativeDecision, 'positive');
    assert.equal(result.geometryAvailable, false);
  });
});

describe('Stage 24 aggregate and sampling', () => {
  it('calculates aggregate shadow statistics', () => {
    const rows = [
      { authoritativeLegacyDecision: 'positive', vectorShadowDecision: 'positive', geometryAvailable: true, fallbackUsed: false, segmentId: 1, vectorResidualM: 2 },
      { authoritativeLegacyDecision: 'negative', vectorShadowDecision: 'positive', geometryAvailable: true, fallbackUsed: false, segmentId: 2, vectorResidualM: 3, decisionChanged: true },
      { authoritativeLegacyDecision: 'positive', vectorShadowDecision: 'negative', geometryAvailable: false, fallbackUsed: true, unavailableReason: 'anchor_geometry_unavailable', segmentId: 2, decisionChanged: true },
    ];
    const stats = aggregateShadowStats(rows);
    assert.equal(stats.totalDecisions, 3);
    assert.equal(stats.legacyPositiveVectorNegative, 1);
    assert.equal(stats.legacyNegativeVectorPositive, 1);
    assert.equal(stats.totalChangedDecisions, 2);
    assert.equal(stats.fallbackCount, 1);
  });

  it('builds deterministic manual-review sample', () => {
    const devIds = new Set(['pair-a']);
    const rows = [
      {
        reviewPairId: 'pair-a',
        segmentId: 1,
        developmentRecordIndex: 111,
        authoritativeLegacyDecision: 'positive',
        vectorShadowDecision: 'negative',
        vectorResidualM: 11.9,
        legacyScalarResidualM: 5,
        logMonoTimeA: '1',
        logMonoTimeB: '2',
        observationIdA: 'a',
        observationIdB: 'b',
        fallbackUsed: false,
        geometryAvailable: true,
        decisionChanged: true,
      },
      {
        reviewPairId: 'pair-b',
        segmentId: 2,
        authoritativeLegacyDecision: 'negative',
        vectorShadowDecision: 'positive',
        vectorResidualM: 2,
        legacyScalarResidualM: 30,
        logMonoTimeA: '3',
        logMonoTimeB: '4',
        observationIdA: 'c',
        observationIdB: 'd',
        fallbackUsed: false,
        geometryAvailable: true,
        decisionChanged: true,
      },
    ];
    const sample1 = buildManualReviewSample(rows, devIds);
    const sample2 = buildManualReviewSample(rows, devIds);
    assert.deepEqual(sample1.records.map((r) => r.reviewPairId), sample2.records.map((r) => r.reviewPairId));
    assert.ok(sample1.selectionRules.length >= 5);
  });
});

describe('Stage 24 development set revalidation', () => {
  it('reproduces Config B through integrated vector_limited path', () => {
    const result = revalidateDevelopmentSet(ROOT);
    assert.equal(result.reproductionPassed, true, result.errors.join('; '));
    assert.equal(result.metrics.confusionMatrix.tp, EXPECTED_CONFIG_B.tp);
    assert.equal(result.metrics.netCorrectImprovement, 17);
    assert.deepEqual(result.metrics.correctedRecordIndices, [...EXPECTED_CONFIG_B.correctedIndices]);
    assert.deepEqual(result.metrics.newlyDamagedRecordIndices, [...EXPECTED_CONFIG_B.damagedIndices]);
  });
});

describe('Stage 24 full pipeline shadow run', () => {
  it('keeps authoritative outputs equivalent between legacy_scalar and vector_shadow', { timeout: 600000 }, () => {
    const report = runPipelineShadowEvaluation({ root: ROOT });
    assert.equal(report.downstreamEquivalence.legacyAuthoritativeMismatches, 0);
    assert.equal(report.developmentSetRevalidation.reproductionPassed, true);
    assert.ok(report.segmentDiscovery.discoveredCount > 0);
    assert.ok(report.pairEnumeration.totalConsecutivePairs > 0);
    assert.equal(report.featureFlag.defaultMode, DECISION_MODES.LEGACY_SCALAR);
    assert.equal(report.aggregateShadowStats.totalDecisions, report.pairEnumeration.totalConsecutivePairs);
    if (report.segmentQualificationSummary.failed > 0) {
      assert.ok(report.segmentQualificationSummary.failures.length > 0);
    }
  });
});
