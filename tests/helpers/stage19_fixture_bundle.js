'use strict';

const { config } = require('../../lib/stage19_spec/config');
const { runP3Branch } = require('../../lib/stage19_spec/p3');
const { applyBranchSelection } = require('../../lib/stage19_spec/uncertainty');

function mkMatch(id, sLo, sHi = sLo + 2, extra = {}) {
  const fp = extra.fp || 'test-fp';
  return {
    observationId: id,
    comparisonSpatialFrameId: extra.csf || '0:0:0',
    featurePairId: fp,
    featureIdLo: fp,
    featureIdHi: fp,
    temporalPassIdLo: '0',
    temporalPassIdHi: '0',
    sLoUm: Math.round(sLo * 1e6),
    sHiUm: Math.round(sHi * 1e6),
    sampleIndexLo: 0,
    sampleIndexHi: 1,
    eLoUm: Math.round(sLo * 1e6),
    nLoUm: Math.round((extra.latLo ?? 0) * 1e6),
    uLoUm: 0,
    eHiUm: Math.round(sHi * 1e6),
    nHiUm: Math.round((extra.latHi ?? extra.latLo ?? 0) * 1e6),
    uHiUm: 0,
    meanLateralOffsetUm: Math.round((extra.latLo ?? 0) * 1e6),
    headingDegLo: extra.heading ?? 0,
    tangentLoDeg: extra.heading ?? 0,
    evidenceUnitKey: extra.eu || '0:0',
  };
}

function multiBranchChain() {
  return [
    mkMatch('m0', 0, 10, { latLo: 0, csf: 'csf-0', fp: 'fp-test' }),
    mkMatch('m1', 5, 15, { latLo: 0.1, csf: 'csf-0', fp: 'fp-test' }),
    mkMatch('m2', 10, 20, { latLo: 3, csf: 'csf-0', fp: 'fp-test' }),
  ];
}

function partitionEligibleChain() {
  return [0, 1, 2].map((i) => mkMatch(String(i), i, i + 2));
}

function p3EligibleChain() {
  return [0, 1, 2, 3, 4, 5].map((i) => mkMatch(String(i), i, i + 2));
}

function mkMinimalBevLoad() {
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const sha = require('crypto').createHash('sha256').update(pngSig).digest('hex');
  return {
    entries: [{
      imageId: 'fixture-bev',
      category: 'fixture',
      featurePairId: 'fp-fixture',
      laneIntervalId: 'iv-fixture',
      payloadPath: 'payloads/fixture.png',
      mime: 'image/png',
      sha256: sha,
      bytes: pngSig.length,
      widthPx: 1,
      heightPx: 1,
      layerValidation: { pass: true, layerAPass: true, layerBPass: true },
      provenance: { conversionTool: 'fixture', sourceArtifact: 'fixture.svg', sourceSvgSha256: sha },
    }],
    payloads: { 'payloads/fixture.png': pngSig },
  };
}

function mkFixtureInterval(id = 'iv-fixture') {
  return {
    laneIntervalId: id,
    leftParentTrackId: '0:0:2:interval',
    rightParentTrackId: '0:0:2:interval',
    chunkId: 0,
    temporalPassId: 0,
    poseSectionId: 0,
    routeSStart: 0,
    routeSEnd: 1000,
    sourceSegmentIds: [0],
  };
}

function mkFixtureContext(intervals = [mkFixtureInterval()]) {
  const observationById = new Map();
  const observationToTrack = new Map();
  return {
    gaps: [],
    gapCount: 0,
    acceptedIntervals: intervals,
    observationById,
    observationToTrack,
    supportedRuns: [],
  };
}

function crossPassCandidate(lo, hi, mLo, mHi, euLo, euHi, parentTrackId = '0:0:2:interval') {
  return {
    featurePairId: `fp:${lo}:${hi}`,
    evidenceUnitKeyLo: euLo,
    evidenceUnitKeyHi: euHi,
    temporalPassIdLo: String(lo),
    temporalPassIdHi: String(hi),
    parentTrackId,
    overlapM: config.minCrossPassTrajectoryOverlapM + 1,
    matchIdsLo: [mLo],
    matchIdsHi: [mHi],
  };
}

module.exports = {
  mkMatch,
  multiBranchChain,
  partitionEligibleChain,
  p3EligibleChain,
  mkMinimalBevLoad,
  mkFixtureInterval,
  mkFixtureContext,
  crossPassCandidate,
  config,
  runP3Branch,
  applyBranchSelection,
};
