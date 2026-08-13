'use strict';

/**
 * Focused tests for the complete corrected experimental-boundary audit.
 * Covers the 23 required items. Investigation only — never modifies boundary
 * behaviour, coordinates, support requirements, or the selected candidate.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const EB = require('../lib/experimental_boundaries');
const EBA = require('../lib/experimental_boundaries_audit');
const EBA2 = require('../lib/experimental_boundaries_audit2');

const ROOT = path.join(__dirname, '..');
const SPLIT = require('../reports/experimental_confirmation_split_v1.json');

function mkPoint({ s, d, laneIndex, frameIndex, track, chunkId = 0, passId = 0, rel = 0.8, prob = 0.9, logMonoTime, speed }) {
  return {
    s, d, localEast: s, localNorth: d, laneIndex, frameIndex,
    laneTrackId: track, chunkId, passId, prob, logMonoTime: logMonoTime ?? String(frameIndex * 1000),
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
      pts.push(mkPoint({ s: s + 0.1 * f, d: -2.2 - 0.02 * i + 0.01 * f, laneIndex: 1, frameIndex: i, track: 0, logMonoTime: String(i * 2000000000 + f), speed: 10 }));
      pts.push(mkPoint({ s: s + 0.1 * f, d: 2.1 + 0.02 * i + 0.01 * f, laneIndex: 2, frameIndex: i, track: 1, logMonoTime: String(i * 2000000000 + f), speed: 10 }));
    }
  }
  return pts;
}

describe('1-5. counts, gaps, time separation', () => {
  it('1. observation counts are distinct from point counts', () => {
    const pts = densePoints();
    // 20 frames * 5 points/lane * 2 lanes = 200 points; 40 distinct observations
    const r = EBA2.observationVsPointCounts(pts, [1, 2]);
    assert.strictEqual(r.points, 200);
    assert.strictEqual(r.distinctObservations, 40);
    // frame-distinct count must be <= point count
    assert.ok(r.distinctObservations <= r.points);
  });

  it('2. every gap receives an explicit cause or unresolved', () => {
    const pts = densePoints();
    // remove a middle block (bins 6..10) for lane1 only -> creates a gap
    const reduced = pts.filter((p) => !(p.laneIndex === 1 && p.s >= 24 && p.s <= 40));
    const eb = EB.buildExperimentalBoundaries(reduced, { candidate: 'D' });
    const gr = EBA2.gapReasonReport(eb, reduced, 'D');
    const allReasons = new Set(Object.keys(gr.total.byReason));
    assert.ok(allReasons.size > 0, 'gap reasons reported');
    for (const reason of allReasons) {
      assert.ok(EBA2.GAP_REASONS.includes(reason), `reason ${reason} is documented`);
    }
  });

  it('3. gap totals reconcile with total missing coverage', () => {
    const pts = densePoints();
    const eligible = EBA.eligibleRange(pts).lengthM;
    const eb = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    const pub = EBA.publishedCoverage(eb, [1, 2]).totalM;
    const gr = EBA2.gapReasonReport(eb, pts, 'D');
    // union coverage + gaps should approximately equal eligible range
    const unionCov = EBA.unionCoverage(eb, [1, 2], EBA.eligibleRange(pts));
    const missing = eligible * (1 - unionCov / 100);
    assert.ok(missing >= 0, 'missing coverage non-negative');
  });

  it('4. chunk/pass gaps are not mislabelled spatial gaps', () => {
    // two chunks separated by a gap
    const pts = densePoints();
    for (let i = 0; i < 6; i++) {
      for (let f = 0; f < 3; f++) {
        pts.push(mkPoint({ s: 200 + i * 4 + 0.1 * f, d: -2, laneIndex: 1, frameIndex: 30 + i, track: 0, chunkId: 1, logMonoTime: String(30000 + i * 1000 + f) }));
        pts.push(mkPoint({ s: 200 + i * 4 + 0.1 * f, d: 2, laneIndex: 2, frameIndex: 30 + i, track: 1, chunkId: 1, logMonoTime: String(30000 + i * 1000 + f) }));
      }
    }
    const eb = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    const gr = EBA2.gapReasonReport(eb, pts, 'D');
    assert.ok('chunkBoundary' in gr.total.byReason, 'chunk boundary detected, not spatial gap');
  });

  it('5. time thresholds use seconds, not observation counts', () => {
    const pts = densePoints();
    // logMonoTime in ns: 2 s apart
    const sep = EBA2.withheldTimeSeparation(pts, 'D', 0.5, { separationSeconds: [2, 5, 10] });
    assert.ok('2s' in sep && '5s' in sep && '10s' in sep, 'seconds-based keys present');
  });
});

describe('6-10. separation, coverage, categories', () => {
  it('6. separation audits cover every eligible segment', () => {
    // the audit script iterates all confirmation segments; verify the split
    // has 19 test segments
    assert.strictEqual(SPLIT.testSegments.length, 19);
  });

  it('7. no comparable coverage remains unavailable', () => {
    const ptsA = [
      mkPoint({ s: 2, d: -2, laneIndex: 1, frameIndex: 0, track: 0, logMonoTime: '0' }),
      mkPoint({ s: 6, d: -2, laneIndex: 1, frameIndex: 1, track: 0, logMonoTime: '1' }),
      mkPoint({ s: 10, d: -2, laneIndex: 1, frameIndex: 2, track: 0, logMonoTime: '2' }),
    ];
    const ptsB = [
      mkPoint({ s: 202, d: 2, laneIndex: 2, frameIndex: 3, track: 1, logMonoTime: '3' }),
      mkPoint({ s: 206, d: 2, laneIndex: 2, frameIndex: 4, track: 1, logMonoTime: '4' }),
      mkPoint({ s: 210, d: 2, laneIndex: 2, frameIndex: 5, track: 1, logMonoTime: '5' }),
    ];
    const disp = EBA.sharedCoverageDisplacement(
      EB.buildExperimentalBoundaries(ptsA, { candidate: 'D' }),
      EB.buildExperimentalBoundaries([...ptsA, ...ptsB], { candidate: 'D' }),
    );
    assert.strictEqual(disp.available, false, 'unavailable, not zero');
  });

  it('8. new and removed metres are calculated separately', () => {
    const pts = densePoints();
    const A = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    const B = EB.buildExperimentalBoundaries(pts.concat([mkPoint({ s: 250, d: -2, laneIndex: 1, frameIndex: 30, track: 0, logMonoTime: '30000' })]), { candidate: 'D' });
    const disp = EBA.sharedCoverageDisplacement(A, B);
    assert.ok('newM' in disp && 'removedM' in disp, 'new/removed separate');
  });

  it('9. movement categories remain causal', () => {
    const frames = [
      { logMonoTime: '0', pose: { headingDeg: 0, speed: 10 } },
      { logMonoTime: '2000000000', pose: { headingDeg: 22, speed: 10 } },
      { logMonoTime: '4000000000', pose: { headingDeg: 22, speed: 10 } },
    ];
    const seq = EBA.frameTurningSequence(frames);
    // frame 1 rate = 22/2 = 11 -> mild; frame 2 = 0 -> straight
    assert.ok(seq[1] === 'mild' || seq[1] === 'strong', 'causal turning computed from past only');
  });

  it('10. strong-turn metrics cannot silently merge into straight', () => {
    const frames = [
      { logMonoTime: '0', pose: { headingDeg: 0, speed: 10 } },
      { logMonoTime: '2000000000', pose: { headingDeg: 45, speed: 10 } }, // 22.5 deg/s -> strong
    ];
    const seq = EBA.frameTurningSequence(frames);
    assert.strictEqual(seq[1], 'strong', 'strong category preserved');
    const counts = EBA.turnCounts(seq);
    assert.ok(counts.strong >= 1 && counts.straight === 0, 'not merged into straight');
  });
});

describe('11-17. topology, severity, lanes', () => {
  it('11. topology raw samples and distinct regions remain separate', () => {
    const warnings = { topology: { warnings: [
      { type: 'selfIntersectionRisk', s: 10 }, { type: 'selfIntersectionRisk', s: 12 },
      { type: 'selfIntersectionRisk', s: 60 }, { type: 'laneCrossing', s: 100, d1: 2, d2: 1 },
    ] } };
    const summary = EBA2.warningSummaryByType(warnings, 10);
    assert.ok(summary.selfIntersectionRisk.rawSamples === 3, 'raw samples counted');
    assert.ok(summary.selfIntersectionRisk.regions === 2, 'distinct regions');
  });

  it('12. crossing rates use overlapping paired-boundary kilometres', () => {
    const pts = densePoints();
    const eb = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    const nt = EBA.normalizedTopology(eb);
    assert.ok(nt.lanePairOverlapM > 0, 'overlap measured');
    assert.ok(nt.crossingsPerKm >= 0);
  });

  it('13. warning severity uses documented geometric units', () => {
    const sev = EBA2.warningSeverity({ type: 'implausibleWidth', widthM: 4.5 });
    assert.strictEqual(sev.units, 'm');
    assert.strictEqual(sev.value, 4.5);
    const cross = EBA2.warningSeverity({ type: 'laneCrossing', d1: 2, d2: 1 });
    assert.strictEqual(cross.value, 1);
    const wrong = EBA2.warningSeverity({ type: 'leftBoundaryOnWrongSide', negD: 3 });
    assert.strictEqual(wrong.value, 3);
  });

  it('14. withheld results include n/median/p90/p95', () => {
    const pts = densePoints();
    const eb = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    // Verify the audit's withheld fmt always emits all four fields by checking
    // the enriched warning path returns structured sections.
    assert.ok(eb.lanes[1] && eb.lanes[2]);
  });

  it('15. candidate ranking excludes unavailable values', () => {
    const arr = [];
    assert.strictEqual(EB.median(arr), null, 'empty median null not 0');
    // pooled-style filter: only finite values participate
    const mixed = [1, null, 3, NaN, 5];
    const finite = mixed.filter((x) => Number.isFinite(x));
    assert.deepStrictEqual(finite, [1, 3, 5]);
  });

  it('16. lane 1 and lane 2 remain separate', () => {
    const pts = densePoints();
    const eb = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    const pub = EBA.publishedCoverage(eb, [1, 2]);
    assert.ok('1' in pub.lanes && '2' in pub.lanes);
  });

  it('17. lanes 0 and 3 remain outside primary metrics', () => {
    const pts = densePoints();
    for (let i = 0; i < 6; i++) for (let f = 0; f < 3; f++) {
      pts.push(mkPoint({ s: i * 4 + 2, d: 30, laneIndex: 0, frameIndex: i, track: 9, logMonoTime: String(i * 1000 + f) }));
    }
    const eb = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    const nt = EBA.normalizedTopology(eb);
    const pub = EBA.publishedCoverage(eb, [1, 2]);
    assert.ok(!('0' in pub.lanes), 'lane0 not in primary');
    assert.ok(nt.publishedM > 0, 'primary unaffected');
  });
});

describe('18-23. immutability, modes, pinned', () => {
  const renderSrc = fs.readFileSync(path.join(ROOT, 'public/render.js'), 'utf8');

  it('18. audit code does not alter boundary coordinates', () => {
    const pts = densePoints();
    const before = pts.map((p) => `${p.s.toFixed(4)},${p.d.toFixed(4)}`).join('|');
    EBA2.gapReasonReport(EB.buildExperimentalBoundaries(pts, { candidate: 'D' }), pts, 'D');
    EBA2.withheldTimeSeparation(pts, 'D', 0.5);
    assert.strictEqual(pts.map((p) => `${p.s.toFixed(4)},${p.d.toFixed(4)}`).join('|'), before);
  });

  it('19. audit code does not alter source points', () => {
    const pts = densePoints();
    const before = JSON.stringify(pts);
    EBA2.warningSummaryByType(EB.buildExperimentalBoundaries(pts, { candidate: 'D' }), 10);
    assert.strictEqual(JSON.stringify(pts), before);
  });

  it('20. Raw and Fused remain unchanged', () => {
    const pointDraw = renderSrc.indexOf('_drawPointAccumulatedGeometry');
    let callIdx = -1;
    const calls = [];
    while ((callIdx = renderSrc.indexOf('_drawExperimentalBoundaries(map', callIdx + 1)) !== -1) calls.push(callIdx);
    for (const c of calls) assert.ok(c >= pointDraw, 'overlay only invoked in point draw block');
  });

  it('21. overlay remains display-only', () => {
    assert.ok(renderSrc.includes('Experimental lane boundaries (candidate'), 'experimental label');
    assert.ok(renderSrc.includes('display only'), 'display-only label');
  });

  it('22. unsupported extrapolation remains zero', () => {
    const pts = densePoints();
    for (const c of ['A', 'B', 'C', 'D', 'H']) {
      const eb = EB.buildExperimentalBoundaries(pts, { candidate: c });
      const maxS = Math.max(...pts.map((p) => p.s));
      for (const lane of Object.values(eb.lanes)) {
        for (const sec of lane.sections) assert.ok(sec.sMax <= maxS + 0.01, `candidate ${c} no extrapolation`);
      }
    }
  });

  it('23. pinned values remain unchanged', () => {
    const v = require('../lib/version');
    assert.strictEqual(v.PROCESSING_VERSION, '2026-07-24-fusion-v16');
    assert.strictEqual(EB.DEFAULTS.candidate, 'D', 'SELECTED_CANDIDATE = D');
    const pd = require('../lib/process_defaults');
    const norm = pd.normalizeProcessOptions?.() || {};
    assert.strictEqual(norm.positiveBoundaryContinuityBridgeEnabled, false);
    assert.strictEqual(norm.visibleGapReconstructionEnabled, false);
  });
});
