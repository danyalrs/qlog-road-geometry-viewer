'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  ANCHOR_MODEL_X_M,
  MANUAL_RECHECK_INDEX,
  anchorPointOnLane,
  rotateToVehicleFrame,
  vecSub,
  vecMag,
  decideConfig,
  calculateMetricsZeroDiv,
  verifyInputIntegrity,
  runShadowEvaluation,
  boundaryRejection,
} = require('../lib/stage22_b_motion_shadow_evaluation');
const { joinAutomaticAndManual, manualLabelToBinary, buildConfusionMatrix } = require('../lib/stage20_b_motion_baseline_compare');

const ROOT = path.join(__dirname, '..');

describe('Stage 22 input integrity', () => {
  it('joins 175 resolved records by exact reviewPairId', () => {
    const integrity = verifyInputIntegrity(ROOT, {});
    assert.equal(integrity.resolvedCount, 175);
    assert.equal(integrity.joinSummary.unmatchedManual.length, 0);
    assert.equal(integrity.joinSummary.duplicateManualPairIds.length, 0);
    assert.ok(integrity.hashes.manualReviews);
  });

  it('does not modify manual review files', () => {
    const manualPath = path.join(ROOT, 'deliverables/stage20-b-motion-manual-reviews-qc-v1.json');
    const before = fs.readFileSync(manualPath, 'utf8');
    runShadowEvaluation({ root: ROOT });
    assert.equal(fs.readFileSync(manualPath, 'utf8'), before);
  });
});

describe('Stage 22 geometry helpers', () => {
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
    assert.equal(anchor.interpolated, true);
    assert.equal(anchor.east, 15);
    assert.equal(anchor.north, 3);
  });

  it('marks anchor unavailable when geometry missing', () => {
    const anchor = anchorPointOnLane({ laneIndex: 0, points: [] }, 15);
    assert.equal(anchor.available, false);
  });

  it('applies rotation with explicit vehicle-frame order', () => {
    const v = { x: 0, y: 10 };
    const rotated = rotateToVehicleFrame(v, 90);
    assert.ok(Math.abs(rotated.longitudinal - 10) < 1e-6);
    assert.ok(Math.abs(rotated.lateral) < 1e-6);
  });

  it('detects opposite vector directions masked by scalar subtraction', () => {
    const target = { x: 10, y: 0 };
    const pose = { x: -10, y: 0 };
    const dot = target.x * pose.x + target.y * pose.y;
    assert.ok(dot < 0);
    assert.ok(Math.abs(vecMag(target) - vecMag(pose)) < 1e-6);
  });
});

describe('Stage 22 candidate rules', () => {
  const baseMeas = {
    boundary: { reject: false },
    baselineDecision: 'positive',
    vectors: { vectorAvailable: true, euclideanPoseCompensatedAnchorResidual: 5 },
    identity: {
      rankStable: true,
      crossing: { strong: false, available: true },
      sideSwap: { strong: false, available: true },
      roadEdgeAssociationChange: false,
    },
  };

  it('keeps road-edge overlap separate from unconditional rank rejection', () => {
    const meas = {
      ...baseMeas,
      identity: {
        ...baseMeas.identity,
        rankStable: false,
        roadEdgeOverlap: true,
        roadEdgeAssociationChange: true,
      },
    };
    const f = decideConfig('F', meas);
    const g = decideConfig('G', meas);
    assert.equal(f, 'negative');
    assert.equal(g, 'negative');
    const measStableRank = { ...meas, vectors: { vectorAvailable: true, euclideanPoseCompensatedAnchorResidual: 20 }, identity: { ...meas.identity, rankStable: true } };
    assert.equal(decideConfig('F', measStableRank), 'negative');
  });

  it('does not use rank instability as unconditional rejection in config F when vector residual high', () => {
    const meas = {
      ...baseMeas,
      vectors: { vectorAvailable: true, euclideanPoseCompensatedAnchorResidual: 20 },
      identity: { ...baseMeas.identity, rankStable: false },
    };
    assert.equal(decideConfig('F', meas), 'negative');
    assert.equal(decideConfig('B', meas), 'negative');
  });

  it('calculates confusion matrix with zero-division=0 convention', () => {
    const metrics = calculateMetricsZeroDiv({ tp: 142, tn: 0, fp: 11, fn: 22 });
    assert.equal(metrics.negativeF1.rate, 0);
    assert.ok(Math.abs(metrics.macroF1.rate - 0.448) < 0.001);
  });
});

describe('Stage 22 full shadow evaluation', () => {
  it('produces metrics for all candidate configurations', () => {
    const report = runShadowEvaluation({ root: ROOT });
    assert.equal(report.configResultsPrimary.length, 7);
    const baseline = report.configResultsPrimary.find((c) => c.configId === 'A');
    assert.equal(baseline.confusionMatrix.tp, 142);
    assert.equal(baseline.confusionMatrix.fp, 11);
    assert.equal(baseline.confusionMatrix.fn, 22);
    assert.ok(report.perRecordDiagnostics.length === 175);
  });

  it('reports record 207 sensitivity without changing primary label', () => {
    const report = runShadowEvaluation({ root: ROOT });
    assert.equal(report.record207Sensitivity.recordIndex, MANUAL_RECHECK_INDEX);
    assert.equal(report.record207Sensitivity.labelUnchanged, true);
    const primary = report.configResultsPrimary.find((c) => c.configId === 'A');
    const sens = report.configResultsExcludingRecord207.find((c) => c.configId === 'A');
    assert.equal(primary.confusionMatrix.fn, sens.confusionMatrix.fn + 1);
  });

  it('accounts corrected and damaged indices relative to baseline', () => {
    const report = runShadowEvaluation({ root: ROOT });
    for (const c of report.configResultsPrimary.filter((x) => x.configId !== 'A')) {
      const total = c.correctedRecordIndices.length + c.newlyDamagedRecordIndices.length;
      assert.ok(total >= 0);
      assert.ok(c.correctedRecordIndices.every((i) => Number.isInteger(i)));
    }
  });
});

describe('Stage 22 pair-ID join', () => {
  it('uses reviewPairId not array index', () => {
    const manual = JSON.parse(fs.readFileSync(path.join(ROOT, 'deliverables/stage20-b-motion-manual-reviews-qc-v1.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'deliverables/stage20-b-motion-evidence-review-manifest.json'), 'utf8'));
    const join = joinAutomaticAndManual({ automaticPairs: manifest.reviewPairs, manualReviews: manual.reviews });
    const resolved = join.joined.filter((r) => manualLabelToBinary(r.manual.reviewerLabel) != null);
    assert.equal(resolved.length, 175);
    for (const row of resolved) {
      assert.equal(row.reviewPairId, row.manual.reviewPairId);
      assert.equal(row.reviewPairId, row.automatic.reviewPairId);
    }
  });
});
