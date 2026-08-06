'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  ANCHOR_MODEL_X_M,
  DECISION_MODES,
  DEFAULT_VECTOR_CONFIG,
  THRESHOLD_CAP_M,
  computeVectorResidual,
  anchorPointOnLane,
  rotateToVehicleFrame,
  evaluateBMotionDecision,
  deriveLegacyScalarDecision,
} = require('../lib/stage23_b_motion_vector_residual');
const {
  EXPECTED_CONFIG_B,
  assertConfigBReproduction,
  runLimitedEvaluation,
} = require('../lib/stage23_b_motion_limited_evaluation');
const { boundaryRejection } = require('../lib/stage22_b_motion_shadow_evaluation');

const ROOT = path.join(__dirname, '..');

function makePair(overrides = {}) {
  return {
    reviewPairId: 'test-pair',
    ruleDerivedClassification: 'ambiguous_motion_residual_candidate',
    residualAfterPoseM: 5,
    poseDisplacementM: 10,
    applicableRejectionConditions: [],
    ...overrides,
  };
}

describe('Stage 23 vector residual computation', () => {
  it('interpolates anchor along lane polyline at modelX', () => {
    const lane = {
      laneIndex: 0,
      points: [
        { east: 10, north: 2, modelX: 10, modelY: -2 },
        { east: 20, north: 4, modelX: 20, modelY: -4 },
      ],
    };
    const anchor = anchorPointOnLane(lane, 15);
    assert.equal(anchor.available, true);
    assert.equal(anchor.east, 15);
    assert.equal(anchor.north, 3);
  });

  it('computes east/north vector subtraction', () => {
    const result = computeVectorResidual({
      anchorA: { available: true, east: 0, north: 0 },
      anchorB: { available: true, east: 10, north: 5 },
      poseA: { east: 0, north: 0 },
      poseB: { east: 8, north: 4 },
      headingDegA: 0,
      headingDegB: 0,
    });
    assert.equal(result.geometryAvailable, true);
    assert.equal(result.targetDisplacementEastM, 10);
    assert.equal(result.targetDisplacementNorthM, 5);
    assert.equal(result.poseDisplacementEastM, 8);
    assert.equal(result.poseDisplacementNorthM, 4);
    assert.equal(result.compensatedEastM, 2);
    assert.equal(result.compensatedNorthM, 1);
    assert.equal(result.vectorResidualM, 2.2361);
  });

  it('applies pose-compensation with correct sign', () => {
    const result = computeVectorResidual({
      anchorA: { available: true, east: 0, north: 0 },
      anchorB: { available: true, east: 0, north: 20 },
      poseA: { east: 0, north: 0 },
      poseB: { east: 0, north: 10 },
      headingDegA: 0,
      headingDegB: 0,
    });
    assert.equal(result.compensatedNorthM, 10);
    assert.equal(result.vectorResidualM, 10);
  });

  it('projects longitudinal and lateral residuals in vehicle frame', () => {
    const compensated = { x: 0, y: 10 };
    const rotated = rotateToVehicleFrame(compensated, 90);
    assert.ok(Math.abs(rotated.longitudinal - 10) < 1e-6);
    assert.ok(Math.abs(rotated.lateral) < 1e-6);
  });

  it('marks missing geometry unavailable without substituting zero', () => {
    const result = computeVectorResidual({
      anchorA: { available: false },
      anchorB: { available: true, east: 1, north: 1 },
      poseA: { east: 0, north: 0 },
      poseB: { east: 1, north: 1 },
    });
    assert.equal(result.geometryAvailable, false);
    assert.equal(result.vectorResidualM, null);
    assert.equal(result.unavailableReason, 'anchor_geometry_unavailable');
  });

  it('respects threshold boundary at exactly 12 m', () => {
    const pair = makePair();
    const boundary = { reject: false };
    const ctx = {
      boundary,
      vectorResidual: {
        geometryAvailable: true,
        vectorResidualM: 12,
        targetDisplacementEastM: 12,
        targetDisplacementNorthM: 0,
        poseDisplacementEastM: 0,
        poseDisplacementNorthM: 0,
        compensatedEastM: 12,
        compensatedNorthM: 0,
        longitudinalResidualM: 12,
        lateralResidualM: 0,
        headingCompensatedResidualM: null,
        headingCompensatedUnavailableReason: 'heading_timestamps_not_aligned',
        unavailableReason: null,
        coordinateFrame: 'east/north metres',
        anchorModelXM: ANCHOR_MODEL_X_M,
      },
    };
    const at12 = evaluateBMotionDecision(pair, ctx, { decisionMode: DECISION_MODES.VECTOR_LIMITED });
    assert.equal(at12.authoritativeDecision, 'positive');
    ctx.vectorResidual.vectorResidualM = 12.0001;
    const above = evaluateBMotionDecision(pair, ctx, { decisionMode: DECISION_MODES.VECTOR_LIMITED });
    assert.equal(above.authoritativeDecision, 'negative');
  });
});

describe('Stage 23 decision modes', () => {
  const pair = makePair({ residualAfterPoseM: 37, ruleDerivedClassification: 'ambiguous_spatial_cap_failure' });
  const boundary = boundaryRejection(pair);
  const vectorCtx = {
    boundary,
    vectorResidual: {
      geometryAvailable: true,
      vectorResidualM: 0.2,
      targetDisplacementEastM: 0.2,
      targetDisplacementNorthM: 0,
      poseDisplacementEastM: 0,
      poseDisplacementNorthM: 0,
      compensatedEastM: 0.2,
      compensatedNorthM: 0,
      longitudinalResidualM: 0.2,
      lateralResidualM: 0,
      headingCompensatedResidualM: null,
      headingCompensatedUnavailableReason: 'heading_timestamps_not_aligned',
      unavailableReason: null,
      coordinateFrame: 'east/north metres',
      anchorModelXM: ANCHOR_MODEL_X_M,
    },
  };

  it('legacy_scalar mode leaves authoritative decision unchanged', () => {
    const legacy = deriveLegacyScalarDecision(pair, boundary);
    const evalResult = evaluateBMotionDecision(pair, vectorCtx, { decisionMode: DECISION_MODES.LEGACY_SCALAR });
    assert.equal(evalResult.authoritativeDecision, legacy.decision);
    assert.equal(evalResult.authoritativeDecision, 'negative');
  });

  it('vector_shadow mode does not alter authoritative decisions', () => {
    const legacy = evaluateBMotionDecision(pair, vectorCtx, { decisionMode: DECISION_MODES.LEGACY_SCALAR });
    const shadow = evaluateBMotionDecision(pair, vectorCtx, { decisionMode: DECISION_MODES.VECTOR_SHADOW });
    assert.equal(shadow.authoritativeDecision, legacy.authoritativeDecision);
    assert.equal(shadow.vectorCandidate.decision, 'positive');
    assert.equal(shadow.decisionChanged, true);
  });

  it('vector_limited mode uses vector result when geometry available', () => {
    const limited = evaluateBMotionDecision(pair, vectorCtx, { decisionMode: DECISION_MODES.VECTOR_LIMITED });
    assert.equal(limited.authoritativeDecision, 'positive');
    assert.equal(limited.fallbackUsed, false);
  });

  it('falls back to legacy when geometry unavailable', () => {
    const limited = evaluateBMotionDecision(pair, { boundary }, { decisionMode: DECISION_MODES.VECTOR_LIMITED });
    assert.equal(limited.fallbackUsed, true);
    assert.equal(limited.authoritativeDecision, 'negative');
    assert.equal(limited.fallbackReason, 'anchor_geometry_unavailable');
  });

  it('keeps road-edge overlap separate from continuation rejection', () => {
    const evalResult = evaluateBMotionDecision(pair, {
      ...vectorCtx,
      roadEdgeOverlap: true,
    }, { decisionMode: DECISION_MODES.VECTOR_LIMITED });
    assert.equal(evalResult.concepts.roadEdgeOverlap, true);
    assert.equal(evalResult.concepts.identitySwap, false);
    assert.equal(evalResult.authoritativeDecision, 'positive');
  });

  it('defaults feature flag to disabled legacy_scalar', () => {
    assert.equal(DEFAULT_VECTOR_CONFIG.featureEnabled, false);
    assert.equal(DEFAULT_VECTOR_CONFIG.decisionMode, DECISION_MODES.LEGACY_SCALAR);
    assert.equal(THRESHOLD_CAP_M, 12);
  });
});

describe('Stage 23 limited evaluation reproduction', () => {
  it('reproduces Stage 22 Config B metrics on 175 resolved records', () => {
    const report = runLimitedEvaluation({ root: ROOT });
    assert.equal(report.reproductionPassed, true, report.reproductionErrors.join('; '));
    const c = report.configBReproduction.confusionMatrix;
    assert.equal(c.tp, EXPECTED_CONFIG_B.tp);
    assert.equal(c.tn, EXPECTED_CONFIG_B.tn);
    assert.equal(c.fp, EXPECTED_CONFIG_B.fp);
    assert.equal(c.fn, EXPECTED_CONFIG_B.fn);
    assert.equal(report.configBReproduction.netCorrectImprovement, 17);
    assert.equal(report.configBReproduction.baselineCorrect, 142);
    assert.equal(report.configBReproduction.candidateCorrect, 159);
  });

  it('reproduces corrected and damaged index accounting', () => {
    const report = runLimitedEvaluation({ root: ROOT });
    assert.deepEqual(report.configBReproduction.correctedRecordIndices, [...EXPECTED_CONFIG_B.correctedIndices]);
    assert.deepEqual(report.configBReproduction.newlyDamagedRecordIndices, [...EXPECTED_CONFIG_B.damagedIndices]);
  });

  it('calculates net benefit as +17', () => {
    const report = runLimitedEvaluation({ root: ROOT });
    const net = report.configBReproduction.correctedRecordIndices.length
      - report.configBReproduction.newlyDamagedRecordIndices.length;
    assert.equal(net, 17);
    assert.equal(report.configBReproduction.netCorrectImprovement, 17);
  });

  it('includes record 207 sensitivity without label change', () => {
    const report = runLimitedEvaluation({ root: ROOT });
    assert.equal(report.record207Sensitivity.labelUnchanged, true);
    assert.equal(report.record207Sensitivity.primaryIncluded, true);
    assert.ok(report.record207Sensitivity.metricDelta);
    assert.equal(report.configBReproduction.correctedRecordIndices.includes(207), true);
    const excluding = report.configBReproductionExcludingRecord207;
    assert.equal(excluding.correctedRecordIndices.includes(207), false);
    assert.equal(excluding.netCorrectImprovement, 16);
  });
});
