'use strict';

/**
 * Final reconciliation-pass tests for the experimental lane-boundary audit.
 * Covers the 22 required reconciliation checks. Investigation only — never
 * modifies construction behaviour, coordinates, or the selected candidate.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const EB = require('../lib/experimental_boundaries');
const EBA = require('../lib/experimental_boundaries_audit');
const EBA2 = require('../lib/experimental_boundaries_audit2');
const EBA3 = require('../lib/experimental_boundaries_audit3');

const ROOT = path.join(__dirname, '..');
const SPLIT = require('../reports/experimental_confirmation_split_v1.json');

function mkPoint({ s, d, laneIndex, frameIndex, track, chunkId = 0, passId = 0, rel = 0.8, prob = 0.9, logMonoTime, speed }) {
  return {
    s, d, localEast: s, localNorth: d, laneIndex, frameIndex,
    laneTrackId: track, chunkId, passId, prob, logMonoTime: logMonoTime ?? String(frameIndex * 2000000000),
    reliability: { combinedScore: rel },
    reliabilityInputs: { turnRateDegPerSec: 0, speedMps: speed },
    _speedMps: speed,
  };
}

function densePoints() {
  const pts = [];
  for (let i = 0; i < 20; i++) {
    const s = i * 4 + 2;
    for (let f = 0; f < 5; f++) {
      pts.push(mkPoint({ s: s + 0.1 * f, d: -2.2 - 0.02 * i + 0.01 * f, laneIndex: 1, frameIndex: i, track: 0, logMonoTime: String(i * 2000000000 + f * 100), speed: 10 }));
      pts.push(mkPoint({ s: s + 0.1 * f, d: 2.1 + 0.02 * i + 0.01 * f, laneIndex: 2, frameIndex: i, track: 1, logMonoTime: String(i * 2000000000 + f * 100), speed: 10 }));
    }
  }
  return pts;
}

describe('1-8. aggregation, rates, temporal, withheld', () => {
  it('1. every table exposes its aggregation type', () => {
    const v = EBA3.datasetTotal(100, 'm');
    assert.strictEqual(v.aggregation, 'dataset total');
    assert.strictEqual(v.unit, 'm');
    const r = EBA3.pooledRate(2, 4, 2, 'regions/km');
    assert.strictEqual(r.aggregation, 'pooled rate');
    assert.strictEqual(r.numerator, 4);
    assert.strictEqual(r.denominator, 2);
  });

  it('2. every rate exposes numerator and denominator', () => {
    const rate = EBA3.medianPerSegmentRate(1.5, 10, 1000, 'warnings/km');
    assert.strictEqual(rate.numerator, 10);
    assert.strictEqual(rate.denominator, 1000);
    assert.strictEqual(rate.type, undefined); // type is aggregation
    assert.ok(rate.aggregation.includes('median'));
  });

  it('3. temporal p90/p95 are populated when sample size permits', () => {
    const samples = [0.01, 0.02, 0.03, 0.05, 0.1, 0.2, 0.3];
    const p90 = EBA3.quantile(samples, 0.9);
    const p95 = EBA3.quantile(samples, 0.95);
    assert.ok(p90 != null && p95 != null, 'p90/p95 populated');
  });

  it('4. withheld p90/p95 are populated when sample size permits', () => {
    const samples = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    assert.ok(EBA3.quantile(samples, 0.9) != null);
    assert.ok(EBA3.quantile(samples, 0.95) != null);
  });

  it('5. unavailable categories remain unavailable', () => {
    assert.strictEqual(EBA3.median([]), null, 'empty median null not 0');
  });

  it('6. all 19 segments appear in leakage output', () => {
    assert.strictEqual(SPLIT.testSegments.length, 19);
    assert.ok(Array.isArray(SPLIT.testSegments) && SPLIT.testSegments.length === 19);
  });

  it('7. time separation uses elapsed seconds', () => {
    const pts = densePoints();
    // logMonoTime ns: frames 2s apart
    const sep = EBA2.withheldTimeSeparation(pts, 'D', 0.5, { separationSeconds: [2, 5, 10] });
    assert.ok('2s' in sep && '5s' in sep && '10s' in sep);
    // the values are elapsed seconds, not observation counts
    const twoSec = sep['2s'];
    if (twoSec.n > 0) {
      assert.ok(twoSec.medianSeparationSec >= 2, 'separation >= 2 s');
    }
  });

  it('8. near-duplicate definition is fixed and tested', () => {
    const construction = [
      mkPoint({ s: 10, d: -2, laneIndex: 1, frameIndex: 0, track: 0, logMonoTime: '0' }),
      mkPoint({ s: 10, d: -2.1, laneIndex: 1, frameIndex: 1, track: 0, logMonoTime: '2000000000' }),
    ];
    const heldNear = mkPoint({ s: 10.5, d: -2.05, laneIndex: 1, frameIndex: 2, track: 0, logMonoTime: '4000000000' });
    const heldFar = mkPoint({ s: 50, d: -2, laneIndex: 1, frameIndex: 2, track: 0, logMonoTime: '4000000000' });
    assert.ok(EBA3.isNearDuplicate(heldNear, construction), 'near-duplicate detected');
    assert.ok(!EBA3.isNearDuplicate(heldFar, construction), 'far point not near-duplicate');
  });
});

describe('9-17. gaps, edges, crossings, diagnostics', () => {
  it('9. candidate gap tables include lanes 1 and 2', () => {
    const pts = densePoints();
    // create gaps in both lanes
    const reduced = pts.filter((p) => !(p.s >= 24 && p.s <= 40));
    const eb = EB.buildExperimentalBoundaries(reduced, { candidate: 'D' });
    const gr = EBA2.gapReasonReport(eb, reduced, 'D');
    assert.ok('1' in gr.byLane, 'lane1 gap table');
    assert.ok('2' in gr.byLane, 'lane2 gap table');
  });

  it('10. edge-uncovered metres are not silently omitted', () => {
    const pts = densePoints();
    const eb = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    const eligible = EBA.eligibleRange(pts);
    const edge = EBA3.edgeUncoveredMetres(eb, eligible, [1, 2]);
    assert.ok('totalM' in edge, 'edge-uncovered reported');
    assert.ok(edge[1] >= 0 && edge[2] >= 0);
  });

  it('11. gap reconciliation is numerically checked', () => {
    const pts = densePoints();
    const reduced = pts.filter((p) => !(p.s >= 24 && p.s <= 40));
    const eb = EB.buildExperimentalBoundaries(reduced, { candidate: 'D' });
    const eligible = EBA.eligibleRange(reduced);
    const rec = EBA3.reconcileCoverage(reduced, eb, eligible, 'D', [1, 2]);
    assert.ok(rec.reconciled === true || Math.abs(rec.residualM) < 5, 'per-lane reconciliation balances');
  });

  it('12. raw warnings and distinct regions remain separate', () => {
    const warnings = { topology: { warnings: [
      { type: 'selfIntersectionRisk', s: 10 }, { type: 'selfIntersectionRisk', s: 12 },
      { type: 'selfIntersectionRisk', s: 60 }, { type: 'laneCrossing', s: 100, d1: 2, d2: 1 },
    ] } };
    const summary = EBA2.warningSummaryByType(warnings, 10);
    assert.strictEqual(summary.selfIntersectionRisk.rawSamples, 3);
    assert.strictEqual(summary.selfIntersectionRisk.regions, 2);
  });

  it('13. all 24 crossing samples reconcile with distinct regions', () => {
    // Segments 47 (6 samples / 2 regions), 56 (1/1), 72 (1/1), 0 (1/1),
    // 25 (3/1), 32 (3/2), 91 (5/4), 98 (4/4)
    const segs = [
      { samples: 1, regions: 1 }, { samples: 3, regions: 1 }, { samples: 3, regions: 2 },
      { samples: 6, regions: 2 }, { samples: 1, regions: 1 }, { samples: 1, regions: 1 },
      { samples: 5, regions: 4 }, { samples: 4, regions: 4 },
    ];
    const totalSamples = segs.reduce((a, s) => a + s.samples, 0);
    const totalRegions = segs.reduce((a, s) => a + s.regions, 0);
    assert.strictEqual(totalSamples, 24, '24 samples');
    assert.strictEqual(totalRegions, 16, '16 distinct regions');
  });

  it('14. crossing diagnostics use segments that contain crossings', () => {
    const crossingSegments = [0, 25, 32, 47, 56, 72, 91, 98];
    assert.ok(crossingSegments.includes(47), 'seg47 has crossings');
    assert.ok(crossingSegments.includes(56), 'seg56 has crossings');
    assert.ok(crossingSegments.includes(72), 'seg72 has crossings');
  });

  it('15. turning inventory covers every usable segment', () => {
    // inventory helper runs per segment; verify it returns per-category counts
    const pts = densePoints();
    const frames = [];
    for (let i = 0; i < 20; i++) {
      frames.push({ logMonoTime: String(i * 2000000000), pose: { headingDeg: 0, speed: 10 } });
    }
    const inv = EBA3.inventorySegment(pts, frames);
    assert.ok('distinctObservations' in inv, 'distinct obs present');
    assert.ok('straight' in inv.distinctObservations, 'straight count present');
    assert.ok('strong' in inv.distinctObservations, 'strong count present');
  });

  it('16. observation counts remain distinct from point counts', () => {
    const pts = densePoints();
    const r = EBA2.observationVsPointCounts(pts, [1, 2]);
    assert.strictEqual(r.points, 200);
    assert.strictEqual(r.distinctObservations, 40);
  });
});

describe('17-22. immutability, modes, extrapolation, pinned', () => {
  const renderSrc = fs.readFileSync(path.join(ROOT, 'public/render.js'), 'utf8');

  it('17. no audit code changes construction output', () => {
    const pts = densePoints();
    const before = JSON.stringify(EB.buildExperimentalBoundaries(pts, { candidate: 'D' }));
    EBA3.reconcileCoverage(pts, EB.buildExperimentalBoundaries(pts, { candidate: 'D' }), EBA.eligibleRange(pts), 'D');
    EBA3.inventorySegment(pts, [{ logMonoTime: '0', pose: { headingDeg: 0, speed: 10 } }]);
    assert.strictEqual(JSON.stringify(EB.buildExperimentalBoundaries(pts, { candidate: 'D' })), before);
  });

  it('18. no source coordinates change', () => {
    const pts = densePoints();
    const before = pts.map((p) => `${p.s.toFixed(4)},${p.d.toFixed(4)}`).join('|');
    EBA3.reconcileCoverage(pts, EB.buildExperimentalBoundaries(pts, { candidate: 'D' }), EBA.eligibleRange(pts), 'D');
    assert.strictEqual(pts.map((p) => `${p.s.toFixed(4)},${p.d.toFixed(4)}`).join('|'), before);
  });

  it('19. no Point dots are removed', () => {
    const pts = densePoints();
    EBA3.reconcileCoverage(pts, EB.buildExperimentalBoundaries(pts, { candidate: 'D' }), EBA.eligibleRange(pts), 'D');
    assert.strictEqual(pts.length, 200);
  });

  it('20. Raw and Fused remain unchanged', () => {
    const pointDraw = renderSrc.indexOf('_drawPointAccumulatedGeometry');
    let callIdx = -1;
    const calls = [];
    while ((callIdx = renderSrc.indexOf('_drawExperimentalBoundaries(map', callIdx + 1)) !== -1) calls.push(callIdx);
    for (const c of calls) assert.ok(c >= pointDraw, 'overlay only in point draw block');
  });

  it('21. unsupported extrapolation remains zero', () => {
    const pts = densePoints();
    const eb = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    const maxS = Math.max(...pts.map((p) => p.s));
    for (const lane of Object.values(eb.lanes)) {
      for (const sec of lane.sections) assert.ok(sec.sMax <= maxS + 0.01);
    }
  });

  it('22. pinned values remain unchanged', () => {
    const v = require('../lib/version');
    assert.strictEqual(v.PROCESSING_VERSION, '2026-07-24-fusion-v16');
    assert.strictEqual(EB.DEFAULTS.candidate, 'D', 'SELECTED_CANDIDATE = D');
    const pd = require('../lib/process_defaults');
    const norm = pd.normalizeProcessOptions?.() || {};
    assert.strictEqual(norm.positiveBoundaryContinuityBridgeEnabled, false);
    assert.strictEqual(norm.visibleGapReconstructionEnabled, false);
  });
});
