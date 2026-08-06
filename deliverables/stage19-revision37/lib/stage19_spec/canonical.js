'use strict';

const { sha256 } = require('./crypto_util');
const { jcsUtf8Bytes } = require('./jcs');

function quantizeUm(x) {
  if (!Number.isFinite(x)) throw new Error('invalidQuantizeInput');
  const scaled = x * 1e6;
  return scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5);
}

function CanonicalMatchTuple(m) {
  return [
    m.sLoUm, m.sHiUm, m.sampleIndexLo, m.sampleIndexHi,
    m.eLoUm, m.nLoUm, m.uLoUm, m.eHiUm, m.nHiUm, m.uHiUm,
    m.meanLateralOffsetUm,
  ];
}

function canonicalMatchId(m) {
  return sha256(jcsUtf8Bytes({
    comparisonSpatialFrameId: m.comparisonSpatialFrameId,
    featureIdLo: m.featureIdLo,
    featureIdHi: m.featureIdHi,
    temporalPassIdLo: m.temporalPassIdLo,
    temporalPassIdHi: m.temporalPassIdHi,
    tuple: CanonicalMatchTuple(m),
  }));
}

function canonicalPassPair(lo, hi) {
  return lo <= hi ? { lo, hi } : { lo: hi, hi: lo };
}

module.exports = {
  quantizeUm,
  CanonicalMatchTuple,
  canonicalMatchId,
  canonicalPassPair,
};
