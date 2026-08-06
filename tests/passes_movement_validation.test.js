const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectPasses } = require('../lib/passes');
const {
  assessSelfIntersectionCrossing,
  assessSpatialRevisit,
} = require('../lib/pass_revisit_assess');

const DEFAULT_OPTS = {
  revisitDistM: 8,
  revisitMinTravelM: 25,
  spatialRevisitMaxTravelToEuclideanRatio: 50,
  selfIntersectionMinAlongTrackSepM: 45,
  selfIntersectionMinCrossingAngleDeg: 35,
};

function pt(east, north, headingDeg, frameId, tIndex) {
  return {
    east,
    north,
    headingDeg,
    speed: 12,
    logMonoTime: String(1_000_000_000 + tIndex * 2_000_000_000),
    frameId: 1000 + frameId,
  };
}

function subsample(points, step = 2) {
  const out = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  return out.map((p, i) => ({ ...p, frameId: 1000 + i, logMonoTime: String(1_000_000_000 + i * 2_000_000_000) }));
}

function addNoise(points, amp = 2) {
  return points.map((p, i) => ({
    ...p,
    east: p.east + Math.sin(i * 1.7) * amp,
    north: p.north + Math.cos(i * 2.3) * amp,
  }));
}

function closedLoopPath() {
  const pts = [];
  const n = 24;
  const r = 75;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 2 * Math.PI;
    const east = r * Math.sin(t);
    const north = r * (1 - Math.cos(t));
    const heading = (90 + (i * 360) / n) % 360;
    pts.push(pt(east, north, heading, i, i));
  }
  return pts;
}

function sameRoadReturnPath() {
  const pts = [];
  let id = 0;
  for (let i = 0; i < 8; i++) pts.push(pt(0, i * 22, 0, id++, id));
  pts.push(pt(1, 154, 90, id++, id));
  for (let i = 7; i >= 0; i--) pts.push(pt(0, i * 22, 180, id++, id));
  return pts;
}

function figureEightPath() {
  const pts = [];
  const n = 28;
  for (let i = 0; i < n; i++) {
    const t = -Math.PI + (2 * Math.PI * i) / (n - 1);
    const denom = 1 + Math.sin(t) ** 2;
    const scale = 55 / denom;
    const east = scale * Math.cos(t);
    const north = scale * Math.sin(t) * Math.cos(t);
    const heading = (Math.atan2(
      scale * (Math.cos(t) ** 2 - Math.sin(t) ** 2),
      -scale * Math.sin(t) * Math.cos(t)
    ) * 180) / Math.PI;
    pts.push(pt(east, north, heading, i, i));
  }
  return pts;
}

function roadCrossingPath() {
  const pts = [];
  let id = 0;
  for (let i = 0; i <= 8; i++) pts.push(pt(0, i * 18, 0, id++, id));
  for (let i = 1; i <= 8; i++) pts.push(pt(i * 18, 72, 90, id++, id));
  for (let i = 1; i <= 8; i++) pts.push(pt(144, 72 - i * 18, 180, id++, id));
  return pts;
}

function uTurnRevisitPath() {
  const pts = [];
  let id = 0;
  for (let i = 0; i < 10; i++) pts.push(pt(0, i * 20, 0, id++, id));
  for (let i = 1; i <= 10; i++) pts.push(pt(Math.sin(i * 0.4) * 8, 180 - i * 18, 180, id++, id));
  return pts;
}

function expectMultiPass(points, label) {
  const { diagnostics } = detectPasses(points, DEFAULT_OPTS);
  assert.ok(
    diagnostics.passCount >= 2,
  `${label}: expected >=2 passes, got ${diagnostics.passCount}; splits=${JSON.stringify(diagnostics.splitEvents)}`
  );
  assert.ok(
    diagnostics.splitEvents.length >= 1,
    `${label}: expected at least one split event`
  );
}

function expectSinglePass(points, label) {
  const { diagnostics } = detectPasses(points, DEFAULT_OPTS);
  assert.equal(diagnostics.passCount, 1, `${label}: expected 1 pass, got ${diagnostics.passCount}; splits=${JSON.stringify(diagnostics.splitEvents)}`);
}

describe('genuine movement — dense paths', () => {
  it('detects closed driving loop closure', () => {
    expectMultiPass(closedLoopPath(), 'closed loop');
  });

  it('detects genuine return along same road (U-turn back)', () => {
    expectMultiPass(sameRoadReturnPath(), 'same road return');
    const pts = sameRoadReturnPath();
    const earlier = pts[2];
    const current = pts[pts.length - 1];
    const a = assessSpatialRevisit(earlier, current, pts.slice(0, -1), 2, 200, 5, DEFAULT_OPTS);
    assert.equal(a.verdict, 'genuineRevisit');
    assert.ok(a.headingDeltaDeg >= 60, `heading delta ${a.headingDeltaDeg}`);
  });

  it('detects figure-eight self-intersection', () => {
    expectMultiPass(figureEightPath(), 'figure eight');
    const { diagnostics } = detectPasses(figureEightPath(), DEFAULT_OPTS);
    assert.ok(
      diagnostics.splitEvents.some((e) => e.reason === 'selfIntersection' || e.reason === 'sharpHeadingChange'),
      `expected selfIntersection or sharpHeadingChange, got ${JSON.stringify(diagnostics.splitEvents.map((e) => e.reason))}`
    );
  });

  it('detects real road crossing intersection', () => {
    expectMultiPass(roadCrossingPath(), 'road crossing');
    const { diagnostics } = detectPasses(roadCrossingPath(), DEFAULT_OPTS);
    assert.ok(
      diagnostics.splitEvents.some((e) => ['selfIntersection', 'spatialRevisit', 'directionReversal'].includes(e.reason)),
      `expected crossing split, got ${JSON.stringify(diagnostics.splitEvents.map((e) => e.reason))}`
    );
  });

  it('detects U-turn revisit of earlier coordinates', () => {
    expectMultiPass(uTurnRevisitPath(), 'U-turn revisit');
    const pts = uTurnRevisitPath();
    const a = assessSpatialRevisit(pts[3], pts[pts.length - 1], pts.slice(0, -1), 3, 250, 6, DEFAULT_OPTS);
    assert.equal(a.verdict, 'genuineRevisit');
    assert.ok(a.headingDeltaDeg >= 100);
  });
});

describe('genuine movement — sparse GPS sampling', () => {
  const cases = [
    ['closed loop', closedLoopPath],
    ['same road return', sameRoadReturnPath],
    ['figure eight', figureEightPath],
    ['road crossing', roadCrossingPath],
    ['U-turn revisit', uTurnRevisitPath],
  ];

  for (const [name, builder] of cases) {
    it(`sparse: ${name} still splits`, () => {
      expectMultiPass(subsample(builder(), 2), `sparse ${name}`);
    });
  }
});

describe('genuine movement — noisy sparse paths', () => {
  const cases = [
    ['closed loop', closedLoopPath],
    ['same road return', sameRoadReturnPath],
    ['figure eight', figureEightPath],
    ['road crossing', roadCrossingPath],
    ['U-turn revisit', uTurnRevisitPath],
  ];

  for (const [name, builder] of cases) {
    it(`noisy sparse: ${name} still splits`, () => {
      const noisy = addNoise(subsample(builder(), 2), 2.5);
      expectMultiPass(noisy, `noisy sparse ${name}`);
    });
  }
});

describe('curve chord artifacts — reference trajectories', () => {
  it('suppresses seg-2-like forward curve chord self-intersection', () => {
    const audit = require('../audit_transform_qlog_f449c_2.json');
    const points = audit.transformedTrajectorySample.map((p) => ({ ...p, speed: 12 }));
    expectSinglePass(points, 'seg 2 reference');
    const { diagnostics } = detectPasses(points, DEFAULT_OPTS);
    const sup = diagnostics.suppressedSplitEvents.find((e) => e.reason === 'suppressedChordSelfIntersection');
    assert.ok(sup);
    assert.ok(sup.bothSegmentsForwardAligned);
    assert.ok(sup.headingContinuityDeg < 45);
    assert.ok(sup.oldSegAlignDeg < 30);
    assert.ok(sup.newSegAlignDeg < 30);
  });

  it('suppresses seg-99-like curve false spatial revisit', () => {
    const audit = require('../audit_transform_qlog_f449c_99.json');
    const points = audit.transformedTrajectorySample.map((p) => ({ ...p, speed: 12 }));
    expectSinglePass(points, 'seg 99 reference');
    const { diagnostics } = detectPasses(points, DEFAULT_OPTS);
    const supChord = diagnostics.suppressedSplitEvents.find((e) => e.reason === 'suppressedChordSelfIntersection');
    const supSpatial = diagnostics.suppressedSplitEvents.find((e) => e.reason === 'suppressedCurveSpatialRevisit');
    assert.ok(supChord || supSpatial, `expected chord or spatial suppression, got ${JSON.stringify(diagnostics.suppressedSplitEvents)}`);
    if (supSpatial) {
      assert.ok(supSpatial.travelToEuclid > 50);
      assert.ok(supSpatial.tangentAlignmentDeg < 70);
    }
    if (supChord) {
      assert.ok(supChord.bothSegmentsForwardAligned);
      assert.ok(supChord.headingContinuityDeg < 45);
    }
  });
});

describe('assessment geometry factors', () => {
  it('self-intersection uses crossing angle not only along-track distance', () => {
    const prev = pt(50, 72, 90, 0, 0);
    const cur = pt(50, 90, 90, 1, 1);
    const b1 = pt(0, 50, 0, 2, 2);
    const b2 = pt(100, 50, 90, 3, 3);
    const path = [b1, b2, pt(100, 0, 180, 4, 4), pt(50, 0, 180, 5, 5)];
    const a = assessSelfIntersectionCrossing(prev, cur, b1, b2, path, 0, DEFAULT_OPTS);
    assert.equal(a.verdict, 'genuineCrossing');
    assert.ok(a.crossingAngleDeg >= 35);
  });

  it('spatial revisit uses heading and tangent not only travel/euclidean ratio', () => {
    const earlier = pt(0, 0, 0, 0, 0);
    const current = pt(3, 2, 175, 1, 10);
    const path = [earlier, pt(0, 50, 0, 2, 1), pt(0, 100, 0, 3, 2), pt(0, 150, 0, 4, 3)];
    const a = assessSpatialRevisit(earlier, current, path, 0, 180, 3.6, DEFAULT_OPTS);
    assert.equal(a.verdict, 'genuineRevisit');
    assert.ok(a.headingDeltaDeg >= 120);
  });
});
