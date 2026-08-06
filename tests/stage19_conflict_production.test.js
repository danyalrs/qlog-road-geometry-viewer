'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  detectProductionConflicts,
  buildHeadingForCandidates,
  buildCrossPassCandidates,
} = require('../lib/stage19_cross_pass_production');
const { buildStage19InputContext } = require('../lib/stage19_stage18_loader');
const { injectStage17Gaps, clearStage17Gaps } = require('../lib/stage19_runtime');

const ROOT = path.join(__dirname, '..');

function mkMatch(id, heading, eu, sLen = 5) {
  return {
    observationId: id,
    comparisonSpatialFrameId: '0:0:0',
    featurePairId: 'fp1',
    featureIdLo: 'fp1',
    featureIdHi: 'fp1',
    temporalPassIdLo: '0',
    temporalPassIdHi: '0',
    sLoUm: 0,
    sHiUm: sLen * 1e6,
    sampleIndexLo: 0,
    sampleIndexHi: 1,
    eLoUm: 0,
    nLoUm: 0,
    uLoUm: 0,
    eHiUm: sLen * 1e6,
    nHiUm: 0,
    uHiUm: 0,
    meanLateralOffsetUm: 0,
    headingDegLo: heading,
    tangentLoDeg: heading,
    evidenceUnitKey: eu,
  };
}

function candidate(lo, hi, mLo, mHi, euLo, euHi) {
  return {
    featurePairId: 'fp1',
    evidenceUnitKeyLo: euLo,
    evidenceUnitKeyHi: euHi,
    temporalPassIdLo: String(lo),
    temporalPassIdHi: String(hi),
    parentTrackId: 't',
    matchIdsLo: [mLo],
    matchIdsHi: [mHi],
  };
}

describe('Stage 19 v2 production conflict regression', () => {
  it('detectProductionConflicts flags 5 vs 50 degree conflict', () => {
    const c = candidate(0, 1, 'a', 'b', '0:0', '0:1');
    const matches = [mkMatch('a', 5, '0:0'), mkMatch('b', 50, '0:1')];
    const { headingByPairId } = buildHeadingForCandidates([c], matches);
    const r = detectProductionConflicts([c], headingByPairId);
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.insufficient.length, 0);
  });

  it('detectProductionConflicts treats 359 vs 1 as agreement', () => {
    const c = candidate(0, 1, 'a', 'b', '0:0', '0:1');
    const matches = [mkMatch('a', 359, '0:0'), mkMatch('b', 1, '0:1')];
    const { headingByPairId } = buildHeadingForCandidates([c], matches);
    const r = detectProductionConflicts([c], headingByPairId);
    assert.equal(r.conflicts.length, 0);
  });

  it('rejects same-pass and missing heading via production wrapper', () => {
    const same = candidate(0, 0, 'a', 'b', '0:0', '0:0');
    const matches = [mkMatch('a', 5, '0:0'), mkMatch('b', 50, '0:0')];
    const { headingByPairId } = buildHeadingForCandidates([same], matches);
    const rSame = detectProductionConflicts([same], headingByPairId);
    assert.ok(rSame.insufficient.length >= 1);

    const c = candidate(0, 1, 'a', 'b', '0:0', '0:1');
    const rMiss = detectProductionConflicts([c], new Map());
    assert.equal(rMiss.insufficient.length, 1);
  });

  it('real dataset has zero candidates — not agreement', () => {
    const context = buildStage19InputContext(ROOT);
    injectStage17Gaps(context.gaps);
    try {
      const { buildMatchRecords } = require('../lib/stage19_match_builder');
      const { matches } = buildMatchRecords(context);
      const cp = buildCrossPassCandidates(context, matches);
      assert.equal(cp.candidates.length, 0);
      const { headingByPairId } = buildHeadingForCandidates(cp.candidates, matches);
      const r = detectProductionConflicts(cp.candidates, headingByPairId);
      assert.equal(r.conflicts.length, 0);
      assert.equal(r.insufficient.length, 0);
    } finally {
      clearStage17Gaps();
    }
  });
});
