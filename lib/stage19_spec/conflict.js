'use strict';

const { config } = require('./config');
const { wrappedAbs } = require('./geometry');

function measuredConflictForGroup(pairRecords, headingResultsByPairId) {
  const estimates = [];
  for (const pr of pairRecords) {
    const hr = headingResultsByPairId.get(pr.featurePairId);
    if (!hr || hr.estimates.length === 0) continue;
    const best = hr.estimates.reduce((a, b) => (a.meanResultant > b.meanResultant ? a : b));
    if (best.evidenceUnitKey !== pr.evidenceUnitKey) throw new Error('evidenceUnitMismatch');
    estimates.push({
      featurePairId: pr.featurePairId,
      mean: best.mean,
      evidenceUnitKey: best.evidenceUnitKey,
    });
  }
  const units = new Set(estimates.map((e) => e.evidenceUnitKey));
  if (units.size < config.minCorroboratingEvidenceUnits) return false;
  for (const hr of headingResultsByPairId.values()) {
    if (hr.qualifying.length > 0) return false;
  }
  for (let i = 0; i < estimates.length; i++) {
    for (let j = i + 1; j < estimates.length; j++) {
      if (wrappedAbs(estimates[i].mean - estimates[j].mean) > config.maxCrossPassHeadingDiffDeg) {
        return true;
      }
    }
  }
  return false;
}

function runMeasuredConflictFixture() {
  const saved = config.maxCrossPassHeadingDiffDeg;
  config.maxCrossPassHeadingDiffDeg = 10;
  const pairRecords = [
    { featurePairId: 'fp-A', evidenceUnitKey: 'KA' },
    { featurePairId: 'fp-B', evidenceUnitKey: 'KB' },
  ];
  const headingResultsByPairId = new Map([
    ['fp-A', {
      estimates: [{ mean: 5, meanResultant: 2, evidenceUnitKey: 'KA', featurePairId: 'fp-A' }],
      qualifying: [],
    }],
    ['fp-B', {
      estimates: [{ mean: 20, meanResultant: 2, evidenceUnitKey: 'KB', featurePairId: 'fp-B' }],
      qualifying: [],
    }],
  ]);
  const result = measuredConflictForGroup(pairRecords, headingResultsByPairId);
  config.maxCrossPassHeadingDiffDeg = saved;
  return {
    thresholdDeg: 10,
    pairA: { mean: 5, evidenceUnitKey: 'KA' },
    pairB: { mean: 20, evidenceUnitKey: 'KB' },
    result,
    pass: result === true,
  };
}

function runMeasuredConflictEmptyFixture() {
  const result = measuredConflictForGroup(
    [{ featurePairId: 'fp-X', evidenceUnitKey: 'KX' }],
    new Map([['fp-X', { estimates: [], qualifying: [] }]]),
  );
  return { result, pass: result === false };
}

module.exports = {
  measuredConflictForGroup,
  runMeasuredConflictFixture,
  runMeasuredConflictEmptyFixture,
};
