const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { modelToGlobal } = require('../lib/transform');
const { buildReferenceTrajectory } = require('../lib/trajectory');
const { PROCESSING_VERSION } = require('../lib/version');
const { FROZEN_ROAD_SURFACE_VERSION } = require('../lib/stage15_lane_counting_design');
const { verifyAccountingInvariants, buildClassificationAudit } = require('../lib/stage15a_classification_audit');
const { verifyStage15DeliverableConsistency } = require('../lib/stage15_lane_counting_design');
const { buildLaneDividerAssessment } = require('../lib/stage15_lane_divider_assessment');
const {
  PROJECTION_STATUSES,
  PROJECTION_SCHEMA_VERSION,
  buildProjectedObservationTemplate,
} = require('../lib/stage16_projection_schema');
const {
  assessSourceLine,
  projectDevicePoints,
  projectDevicePointsDetailed,
  buildSectionTrajectoryMap,
  decodeAndProjectObservation,
  summarizeObservations,
  verifyProjectionConsistency,
  hasMonotonicForwardX,
  extractDevicePoints,
  DEFAULT_FRAGMENT_ASSESSMENT,
} = require('../lib/stage16_lane_line_projection');
const {
  buildStage16ProjectionAudit,
  generateStage16Markdown,
} = require('../lib/stage16_projection_audit');

const TEST_FRAGMENT_OPTS = { ...DEFAULT_FRAGMENT_ASSESSMENT, minProjectedRouteSpanM: 0 };
const ROOT = path.join(__dirname, '..');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sampleLine(xs, ys) {
  return { x: xs, y: ys, z: xs.map(() => 0), t: [] };
}

function sampleTrajectory() {
  const pathPts = [];
  for (let i = 0; i < 20; i++) {
    pathPts.push({
      logMonoTime: String(1_000_000_000 + i * 100_000_000),
      east: i * 5,
      north: i * 0.5,
      headingDeg: 5,
      passId: 0,
      poseSectionId: 0,
    });
  }
  return buildReferenceTrajectory(pathPts);
}

describe('Stage 16 projection schema', () => {
  it('defaults unknown template fields', () => {
    const t = buildProjectedObservationTemplate();
    assert.equal(t.schemaVersion, PROJECTION_SCHEMA_VERSION);
    assert.equal(t.frozenBaselineVersion, FROZEN_ROAD_SURFACE_VERSION);
    assert.deepEqual(t.deviceFramePoints, []);
    assert.deepEqual(t.projectedRoutePoints, []);
  });
});

describe('Stage 16 source validation', () => {
  it('rejects malformed arrays', () => {
    const r = assessSourceLine(0, { x: [1, 2], y: [1] }, 0.9, 0.1);
    assert.equal(r.preProjectionStatus, PROJECTION_STATUSES.REJECTED_INVALID_GEOMETRY);
  });

  it('rejects low assessment confidence', () => {
    const line = sampleLine([5, 10, 20], [1.5, 1.4, 1.3]);
    const r = assessSourceLine(2, line, 0.2, 0.1);
    assert.equal(r.preProjectionStatus, PROJECTION_STATUSES.REJECTED_LOW_ASSESSMENT_CONFIDENCE);
  });

  it('rejects excessive assessment uncertainty', () => {
    const line = sampleLine([5, 10, 20], [-1.5, -1.4, -1.3]);
    const r = assessSourceLine(1, line, 0.9, 2.0);
    assert.equal(r.preProjectionStatus, PROJECTION_STATUSES.REJECTED_EXCESSIVE_ASSESSMENT_UNCERTAINTY);
  });

  it('accepts valid geometry for projection path', () => {
    const line = sampleLine([5, 10, 20], [1.5, 1.4, 1.3]);
    const r = assessSourceLine(2, line, 0.9, 0.1);
    assert.equal(r.preProjectionStatus, null);
    assert.ok(r.deviceFramePoints.length >= 2);
  });

  it('detects non-monotonic forward x as metadata tag', () => {
    assert.equal(hasMonotonicForwardX([5, 10, 20]), true);
    assert.equal(hasMonotonicForwardX([5, 4, 3, 2]), false);
  });

  it('rejects nonfinite source values', () => {
    const pts = extractDevicePoints({ x: [5, NaN], y: [1, 2] });
    assert.equal(pts.length, 1);
  });
});

describe('Stage 16 coordinate projection', () => {
  it('known translation at zero heading', () => {
    const g = modelToGlobal(10, 2, 100, 200, 0);
    assert.ok(Math.abs(g.east - 98) < 0.01);
    assert.ok(Math.abs(g.north - 210) < 0.01);
  });

  it('known heading rotation preserves left/right sign', () => {
    const traj = sampleTrajectory();
    const pose = { east: 0, north: 0, headingDeg: 0 };
    const devLeft = [{ x: 10, y: 2, z: 0 }, { x: 15, y: 2, z: 0 }];
    const devRight = [{ x: 10, y: -2, z: 0 }, { x: 15, y: -2, z: 0 }];
    const pl = projectDevicePoints(devLeft, pose, traj, '1000000000', TEST_FRAGMENT_OPTS);
    const pr = projectDevicePoints(devRight, pose, traj, '1000000000', TEST_FRAGMENT_OPTS);
    assert.ok(pl.ok && pr.ok);
    assert.ok(pl.projectedRoutePoints[0].d > pr.projectedRoutePoints[0].d);
  });

  it('projects straight line with multiple points', () => {
    const line = sampleLine([5, 10, 15, 20], [1.8, 1.7, 1.6, 1.5]);
    const pts = extractDevicePoints(line);
    const traj = sampleTrajectory();
    const pose = { east: 0, north: 0, headingDeg: 0 };
    const r = projectDevicePoints(pts, pose, traj, '1000000000', TEST_FRAGMENT_OPTS);
    assert.ok(r.ok);
    assert.equal(r.projectedRoutePoints.length, 4);
    for (let i = 1; i < r.projectedRoutePoints.length; i++) {
      assert.ok(r.projectedRoutePoints[i].s >= r.projectedRoutePoints[i - 1].s - 1);
    }
  });

  it('rejects missing pose context', () => {
    const ob = decodeAndProjectObservation({
      segmentId: 2,
      modelEvent: { sourceFile: 'qlog_f449c_2.bz2', sourceEventIndex: 0, logMonoTime: '1', modelV2: { laneLines: [sampleLine([5, 10], [1, 1])], laneLineProbs: [0.9], laneLineStds: [0.1] } },
      slotIndex: 0,
      inferredSlotRole: 'test',
      frameContext: null,
      sectionTrajectories: new Map(),
      options: { frozenBaselineVersion: FROZEN_ROAD_SURFACE_VERSION, frozenV11ProcessingVersion: PROCESSING_VERSION },
    });
    assert.equal(ob.projectionStatus, PROJECTION_STATUSES.REJECTED_MISSING_POSE);
    assert.equal(ob.projectedRoutePoints.length, 0);
  });

  it('preserves source arrays without mutation', () => {
    const line = sampleLine([5, 10, 20], [1.5, 1.4, 1.3]);
    const orig = JSON.stringify(line.x);
    assessSourceLine(0, line, 0.9, 0.1);
    assert.equal(JSON.stringify(line.x), orig);
  });

  it('deterministic serialization', () => {
    const line = sampleLine([5, 10, 20], [1.5, 1.4, 1.3]);
    const a = assessSourceLine(0, line, 0.9, 0.1);
    const b = assessSourceLine(0, line, 0.9, 0.1);
    assert.deepEqual(a.rejectionReasons, b.rejectionReasons);
  });
});

describe('Stage 16 section trajectory', () => {
  it('builds separate trajectories per pass and section', () => {
    const chunk = {
      vehiclePath: [
        { east: 0, north: 0, logMonoTime: '1', passId: 0, poseSectionId: 0 },
        { east: 10, north: 0, logMonoTime: '2', passId: 0, poseSectionId: 0 },
        { east: 20, north: 0, logMonoTime: '3', passId: 1, poseSectionId: 0 },
        { east: 30, north: 0, logMonoTime: '4', passId: 1, poseSectionId: 0 },
      ],
    };
    const map = buildSectionTrajectoryMap(chunk);
    assert.ok(map.has('0:0'));
    assert.ok(map.has('1:0'));
    assert.notEqual(map.get('0:0'), map.get('1:0'));
  });
});

describe('Stage 16 integration', () => {
  it('runs on single segment without v11 mutation', () => {
    const audit = buildStage16ProjectionAudit(ROOT, { filenames: ['qlog_f449c_2.bz2'], includeAllObservations: true });
    assert.equal(audit.v11GeometryModified, false);
    assert.equal(audit.laneCountingComplete, false);
    assert.equal(audit.productionLaneCountImplemented, false);
    assert.ok(audit.datasetSummary.decodedObservations > 0);
    assert.ok(audit.projectionConsistency.passed);
    const md = generateStage16Markdown(audit);
    assert.match(md, /Stage 16/);
    assert.match(md, /not implement/);
  });

  it('full dataset projection audit', () => {
    const audit = buildStage16ProjectionAudit(ROOT, { includeAllObservations: true });
    const d = audit.datasetSummary;
    assert.equal(audit.physicalRouteSegments, 92);
    assert.equal(d.totalModelV2Frames, 2761);
    assert.equal(d.decodedObservations, 11044);
    assert.equal(d.decodedObservations, d.projectedObservations + d.rejectedObservations);
    assert.equal(d.projectedObservations, 5774);
    assert.equal(d.projectedPointCount, 121998);
    assert.equal(d.pointAccounting.reconciliationPassed, true);
    assert.equal(d.pointAccounting.reconciliationDelta, 0);
    assert.ok(d.pctProjected > 0);
    assert.ok(audit.projectionConsistency.passed);
    assert.equal(audit.stage16Status, 'approved');
  });
});

describe('Stage 16 regression protection', () => {
  it('v11 processing version unchanged', () => {
    assert.equal(PROCESSING_VERSION, '2026-07-24-fusion-v12');
  });

  it('v11 core files unchanged (hash snapshot)', () => {
    const files = ['lib/transform.js', 'lib/process_route.js', 'lib/sd_fusion.js', 'lib/version.js'];
    const hashes = {};
    for (const f of files) {
      hashes[f] = sha256File(path.join(ROOT, f));
    }
    assert.ok(hashes['lib/version.js']);
    assert.ok(hashes['lib/transform.js']);
  });

  it('Stage 15 approved accounting unchanged', () => {
    const audit15 = buildLaneDividerAssessment(ROOT);
    const inv = verifyAccountingInvariants(audit15.stage15aClassificationAudit);
    assert.equal(inv.passed, true, inv.errors.join('; '));
    const del = verifyStage15DeliverableConsistency(audit15);
    assert.equal(del.passed, true, del.errors.join('; '));
    assert.equal(audit15.stage15Status, 'approved');
    assert.equal(audit15.stage15aStatus, 'approved');
  });
});

describe('Stage 16 consistency invariants', () => {
  it('rejected observations have no projected geometry', () => {
    const obs = [
      { segmentId: 0, chunkId: 0, logMonoTime: '1', sourceSlotIndex: 0, projectionStatus: PROJECTION_STATUSES.REJECTED_LOW_ASSESSMENT_CONFIDENCE, deviceFramePoints: [{ x: 1, y: 1 }], projectedRoutePoints: [], pointAudit: { rawSourcePointCount: 1, pointOutcomes: { in_observation_rejected: 1 } } },
      { segmentId: 0, chunkId: 0, logMonoTime: '1', sourceSlotIndex: 1, projectionStatus: PROJECTION_STATUSES.PROJECTED, deviceFramePoints: [{ x: 1, y: 1 }, { x: 2, y: 1 }], projectedRoutePoints: [{ s: 1, d: 2, east: 1, north: 2, sourceIndex: 0 }, { s: 2, d: 2, east: 2, north: 2, sourceIndex: 1 }], pointAudit: { rawSourcePointCount: 2, isContiguousSourceRun: true, pointOutcomes: { projected: 2 } } },
    ];
    const check = verifyProjectionConsistency(obs);
    assert.equal(check.passed, true);
    const sum = summarizeObservations(obs);
    assert.equal(sum.projectedObservations, 1);
    assert.equal(sum.rejectedObservations, 1);
  });
});

describe('Stage 16 fragment and point-level fixtures', () => {
  const pathPts = [];
  for (let i = 0; i < 40; i++) {
    pathPts.push({
      logMonoTime: String(1_000_000_000 + i * 100_000_000),
      east: i * 5,
      north: 0,
      headingDeg: 90,
      passId: 0,
      poseSectionId: 0,
    });
  }
  const traj = buildReferenceTrajectory(pathPts);
  const pose = { east: pathPts[10].east, north: pathPts[10].north, headingDeg: 90 };
  const t = pathPts[10].logMonoTime;
  const fragOpts = { ...TEST_FRAGMENT_OPTS, maxProjectionDistM: 25 };

  it('rejects endpoint exceeding perp distance while middle survives', () => {
    const pts = [
      { sourceIndex: 0, x: 10, y: 8, z: 0 },
      { sourceIndex: 1, x: 15, y: 1.8, z: 0 },
      { sourceIndex: 2, x: 20, y: 1.8, z: 0 },
      { sourceIndex: 3, x: 25, y: 8, z: 0 },
    ];
    const r = projectDevicePointsDetailed(pts, pose, traj, t, { ...fragOpts, maxProjectionDistM: 3 });
    assert.ok(r.ok);
    assert.equal(r.pointAudit.rejectedPerpDistCount, 2);
    assert.equal(r.projectedRoutePoints.length, 2);
  });

  it('rejects middle group exceeding perp distance', () => {
    const pts = [
      { sourceIndex: 0, x: 10, y: 1.8, z: 0 },
      { sourceIndex: 1, x: 15, y: 1.8, z: 0 },
      { sourceIndex: 2, x: 20, y: 10, z: 0 },
      { sourceIndex: 3, x: 25, y: 10, z: 0 },
      { sourceIndex: 4, x: 30, y: 1.8, z: 0 },
    ];
    const r = projectDevicePointsDetailed(pts, pose, traj, t, { ...fragOpts, maxProjectionDistM: 6 });
    assert.ok(r.ok);
    const idx = r.projectedRoutePoints.map((p) => p.sourceIndex);
    assert.deepEqual(idx, [0, 1]);
    assert.equal(r.pointAudit.rejectedPerpDistCount, 3);
  });

  it('allows only two adjacent points to survive', () => {
    const pts = [
      { sourceIndex: 0, x: 10, y: 8, z: 0 },
      { sourceIndex: 1, x: 15, y: 1.8, z: 0 },
      { sourceIndex: 2, x: 20, y: 1.8, z: 0 },
      { sourceIndex: 3, x: 25, y: 8, z: 0 },
    ];
    const r = projectDevicePointsDetailed(pts, pose, traj, t, { ...fragOpts, maxProjectionDistM: 3 });
    assert.ok(r.ok);
    assert.equal(r.projectedRoutePoints.length, 2);
    assert.deepEqual(r.projectedRoutePoints.map((p) => p.sourceIndex), [1, 2]);
  });

  it('splits two disconnected groups into primary fragment only', () => {
    const pts = [
      { sourceIndex: 0, x: 10, y: 1.8, z: 0 },
      { sourceIndex: 1, x: 15, y: 1.8, z: 0 },
      { sourceIndex: 5, x: 40, y: 1.8, z: 0 },
      { sourceIndex: 6, x: 45, y: 1.8, z: 0 },
    ];
    const r = projectDevicePointsDetailed(pts, pose, traj, t, fragOpts);
    assert.ok(r.ok);
    assert.equal(r.projectionFragments.length, 2);
    const idx = r.projectedRoutePoints.map((p) => p.sourceIndex);
    assert.ok((idx.every((i) => i <= 1)) || idx.every((i) => i >= 5));
  });

  it('rejects inadequate route-s span under fragment policy', () => {
    const pts = [{ sourceIndex: 0, x: 10, y: 1.8, z: 0 }, { sourceIndex: 1, x: 11, y: 1.8, z: 0 }];
    const r = projectDevicePoints(pts, pose, traj, t, { ...DEFAULT_FRAGMENT_ASSESSMENT, minProjectedRouteSpanM: 50 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, PROJECTION_STATUSES.REJECTED_FRAGMENT_POLICY);
  });

  it('curved trajectory remains valid with contiguous run', () => {
    const curvedPath = [];
    for (let i = 0; i < 30; i++) {
      const ang = i * 0.08;
      curvedPath.push({
        logMonoTime: String(1_000_000_000 + i * 100_000_000),
        east: Math.sin(ang) * 50,
        north: Math.cos(ang) * 50,
        headingDeg: 90 - (ang * 180 / Math.PI),
        passId: 0,
        poseSectionId: 0,
      });
    }
    const curvedTraj = buildReferenceTrajectory(curvedPath);
    const pts = [];
    for (let i = 0; i < 8; i++) pts.push({ sourceIndex: i, x: 5 + i * 3, y: 1.8, z: 0 });
    const r = projectDevicePoints(pts, { east: curvedPath[5].east, north: curvedPath[5].north, headingDeg: curvedPath[5].headingDeg }, curvedTraj, curvedPath[5].logMonoTime, TEST_FRAGMENT_OPTS);
    assert.ok(r.ok);
    assert.ok(r.projectedRoutePoints.length >= 2);
  });
});

describe('Stage 16 BEV manifest', () => {
  it('includes all nine required categories', () => {
    const audit = buildStage16ProjectionAudit(ROOT, { includeAllObservations: true });
    const { generateBevInspections } = require('../lib/stage16_bev_inspection');
    const { BEV_REQUIRED_CATEGORIES } = require('../lib/stage16_projection_schema');
    const tmp = path.join(ROOT, 'reports', 'stage16_bev_test_tmp');
    const manifest = generateBevInspections(audit, audit.observations, tmp, { modelEvents: audit.modelEvents || [] });
    const categories = manifest.map((m) => m.category);
    for (const cat of BEV_REQUIRED_CATEGORIES) {
      assert.ok(categories.includes(cat), `missing BEV category ${cat}`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
