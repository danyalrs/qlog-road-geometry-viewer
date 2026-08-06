'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  runProductionPartition,
  runP3WithBranchSelection,
} = require('../lib/stage19_partition_production');
const { applyBranchSelection } = require('../lib/stage19_spec/uncertainty');
const { runP3Branch } = require('../lib/stage19_spec/p3');

function mk(id, sLo, sHi = sLo + 2) {
  return {
    observationId: id,
    comparisonSpatialFrameId: '0:0:0',
    featurePairId: 'test-fp',
    featureIdLo: 'test-fp',
    featureIdHi: 'test-fp',
    temporalPassIdLo: '0',
    temporalPassIdHi: '0',
    sLoUm: Math.round(sLo * 1e6),
    sHiUm: Math.round(sHi * 1e6),
    sampleIndexLo: 0,
    sampleIndexHi: 1,
    eLoUm: Math.round(sLo * 1e6),
    nLoUm: 0,
    uLoUm: 0,
    eHiUm: Math.round(sHi * 1e6),
    nHiUm: 0,
    uHiUm: 0,
    meanLateralOffsetUm: 0,
    headingDegLo: 0,
    tangentLoDeg: 0,
    evidenceUnitKey: '0:0',
  };
}

/** P3-eligible chain: 1 m steps spanning >= minCrossPassTrajectoryOverlapM. */
function p3EligibleChain() {
  return [0, 1, 2, 3, 4, 5].map((i) => mk(String(i), i, i + 2));
}

/** Partition-eligible chain (3 matches, 1 m steps). P3 density may still fail. */
function partitionEligibleChain() {
  return [0, 1, 2].map((i) => mk(String(i), i, i + 2));
}

describe('Stage 19 v2 P3 branch selection production', () => {
  it('skips P3 for singleton chains', () => {
    const chain = [mk('a', 0, 10)];
    const r = runProductionPartition(chain);
    assert.equal(r.stats.p3Eligible, 0);
    assert.equal(r.stats.p3Executed, 0);
  });

  it('invokes runP3Branch and applyBranchSelection for eligible chain', () => {
    const chain = p3EligibleChain();
    const p3 = runP3WithBranchSelection(chain, {
      direction: 'inc',
      directionComponentId: 'd',
      branchId: 0,
      featureIdLo: 'test-fp',
      featureIdHi: 'test-fp',
      comparisonSpatialFrameId: '0:0:0',
    });
    assert.equal(p3.p3Eligible, true);
    assert.equal(p3.p3Executed, true);
    assert.equal(p3.branchSelection?.ok, true);
    assert.ok(Number.isFinite(p3.branchSelection.value));
  });

  it('production partition fails if runP3Branch stubbed', () => {
    const chain = partitionEligibleChain();
    const stub = () => ({ ok: false, branchCanonical: null });
    const r = runProductionPartition(chain, {
      runP3WithBranchSelection: (c, meta) => {
        const p3Result = stub();
        return {
          p3Eligible: true,
          p3Executed: true,
          p3Result,
          branchSelection: { ok: false, reason: 'p3_failed' },
        };
      },
    });
    assert.equal(r.stats.p3Failed, 1);
    assert.equal(r.stats.p3Selected, 0);
  });

  it('production partition fails if applyBranchSelection stubbed to fail', () => {
    const chain = partitionEligibleChain();
    const r = runProductionPartition(chain, {
      runP3WithBranchSelection: (c, meta) => {
        const p3Result = runP3Branch(c, meta);
        return {
          p3Eligible: true,
          p3Executed: true,
          p3Result,
          branchSelection: { ok: false, reason: 'stub' },
        };
      },
    });
    assert.equal(r.stats.p3Executed, 1);
    assert.equal(r.stats.p3Selected, 0);
    assert.equal(r.stats.p3Failed, 1);
  });

  it('deterministic branch selection across reruns', () => {
    const chain = p3EligibleChain();
    const a = runP3WithBranchSelection(chain, {
      direction: 'inc', directionComponentId: 'd', branchId: 0,
      featureIdLo: 'f', featureIdHi: 'f', comparisonSpatialFrameId: 'csf',
    });
    const b = runP3WithBranchSelection(chain, {
      direction: 'inc', directionComponentId: 'd', branchId: 0,
      featureIdLo: 'f', featureIdHi: 'f', comparisonSpatialFrameId: 'csf',
    });
    assert.equal(a.branchSelection.value, b.branchSelection.value);
    assert.equal(applyBranchSelection(
      { requiredScalars: [{ confidenceLevel: 0.95, halfWidth: 1 }] },
      { uncertaintyInterpretation: 'one_sigma', documentedIndependent: true },
    ).ok, true);
  });
});
