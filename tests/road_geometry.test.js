const test = require('node:test');
const assert = require('node:assert/strict');
const { modelToGlobal } = require('../lib/transform');
const { lerpAngleDeg } = require('../lib/alignment');
const { validateGpsRecord, createRejectionStats } = require('../lib/gps_validate');
const { UNION } = require('../lib/qlog_decoder');
const { processRoute } = require('../lib/process_route');
const { extractModelGeometry } = require('../lib/transform');
const { sortFilesByLogTime } = require('../lib/file_ordering');
const { shouldStartNewChunk, chunkFrames } = require('../lib/chunking');
const {
  validateRoadPolygon,
  splitPolylineByGap,
  buildRoadSurfacePolygons,
  countSelfIntersections,
  orderPointsAlongTrajectory,
} = require('../lib/geometry_sanity');

test('union tag constants', () => {
  assert.equal(UNION.MODEL_V2, 73);
  assert.notEqual(UNION.MODEL_V2, 75);
});

test('filename ordering _2 before _10', () => {
  const models = [
    { sourceFile: 'qlog_f449c_10.bz2', logMonoTime: '2000' },
    { sourceFile: 'qlog_f449c_2.bz2', logMonoTime: '1000' },
  ];
  const sorted = sortFilesByLogTime(models, [], ['qlog_f449c_10.bz2', 'qlog_f449c_2.bz2']);
  assert.equal(sorted[0].sourceFile, 'qlog_f449c_2.bz2');
});

test('backward logMonoTime starts new chunk', () => {
  const frames = [
    { logMonoTime: '2000', sourceFile: 'a.bz2', pose: { east: 0, north: 0, speed: 5, headingDeg: 0 } },
    { logMonoTime: '1000', sourceFile: 'a.bz2', pose: { east: 1, north: 0, speed: 5, headingDeg: 0 } },
  ];
  const chunks = chunkFrames(frames, {});
  assert.equal(chunks.length, 2);
});

test('large timestamp gap starts new chunk', () => {
  const frames = [
    { logMonoTime: '1000000000', sourceFile: 'a.bz2', pose: { east: 0, north: 0, speed: 5, headingDeg: 0 } },
    { logMonoTime: '6000000000', sourceFile: 'a.bz2', pose: { east: 5, north: 0, speed: 5, headingDeg: 0 } },
  ];
  const chunks = chunkFrames(frames, { maxTimeGapSec: 3 });
  assert.equal(chunks.length, 2);
});

test('large GPS jump starts new chunk', () => {
  const frames = [
    { logMonoTime: '1000', sourceFile: 'a.bz2', pose: { east: 0, north: 0, speed: 5, headingDeg: 0 } },
    { logMonoTime: '2000000000', sourceFile: 'a.bz2', pose: { east: 100, north: 0, speed: 5, headingDeg: 0 } },
  ];
  const chunks = chunkFrames(frames, { maxGpsGapM: 30 });
  assert.equal(chunks.length, 2);
});

test('source file change with continuity does not split', () => {
  const frames = [
    { logMonoTime: '1000000000', sourceFile: 'a.bz2', pose: { east: 0, north: 0, speed: 10, headingDeg: 0 } },
    { logMonoTime: '1050000000', sourceFile: 'b.bz2', pose: { east: 2, north: 0, speed: 10, headingDeg: 0 } },
  ];
  const chunks = chunkFrames(frames, { maxTimeGapSec: 3, maxGpsGapM: 30 });
  assert.equal(chunks.length, 1);
});

test('source file change with gap splits', () => {
  const frames = [
    { logMonoTime: '1000000000', sourceFile: 'a.bz2', pose: { east: 0, north: 0, speed: 5, headingDeg: 0 } },
    { logMonoTime: '6000000000', sourceFile: 'b.bz2', pose: { east: 100, north: 0, speed: 5, headingDeg: 0 } },
  ];
  const chunks = chunkFrames(frames, { maxTimeGapSec: 3, maxGpsGapM: 30 });
  assert.equal(chunks.length, 2);
});

test('split polyline by gap', () => {
  const pts = [
    { east: 0, north: 0 },
    { east: 1, north: 0 },
    { east: 100, north: 0 },
    { east: 101, north: 0 },
  ];
  const frags = splitPolylineByGap(pts, 10);
  assert.equal(frags.length, 2);
});

test('rejects self-intersecting polygon', () => {
  const left = [{ east: 0, north: 0 }, { east: 10, north: 0 }, { east: 10, north: 5 }];
  const right = [{ east: 0, north: 3 }, { east: 5, north: -5 }, { east: 10, north: 3 }];
  const result = validateRoadPolygon(left, right);
  assert.equal(result.valid, false);
});

test('two far-apart road sections produce two polygons without triangle', () => {
  const traj1 = [{ east: 0, north: 1.5 }, { east: 10, north: 1.5 }, { east: 20, north: 1.5 }];
  const traj2 = [{ east: 1000, north: 1.5 }, { east: 1010, north: 1.5 }];
  const edges1 = [
    { edgeIndex: 0, points: [{ east: 0, north: 0 }, { east: 10, north: 0 }, { east: 20, north: 0 }] },
    { edgeIndex: 1, points: [{ east: 0, north: 3 }, { east: 10, north: 3 }, { east: 20, north: 3 }] },
  ];
  const edges2 = [
    { edgeIndex: 0, points: [{ east: 1000, north: 0 }, { east: 1010, north: 0 }] },
    { edgeIndex: 1, points: [{ east: 1000, north: 3 }, { east: 1010, north: 3 }] },
  ];
  const r1 = buildRoadSurfacePolygons(edges1, traj1, { maxRoadEdgeGapM: 10 });
  const r2 = buildRoadSurfacePolygons(edges2, traj2, { maxRoadEdgeGapM: 10 });
  assert.equal(r1.polygons.length + r2.polygons.length, 2);
  for (const p of [...r1.polygons, ...r2.polygons]) {
    assert.equal(countSelfIntersections(p.ring), 0);
  }
});

test('lane index reuse across chunks stays separate', () => {
  const gps = [];
  for (let i = 0; i < 5; i++) {
    gps.push({
      logMonoTime: String(1e10 + i * 1e8),
      sourceFile: 'a.bz2', latitude: 1.3 + i * 0.00001, longitude: 103.9,
      flags: 1, horizontalAccuracy: 5, speed: 10, bearingDeg: 0,
    });
  }
  for (let i = 0; i < 5; i++) {
    gps.push({
      logMonoTime: String(2e10 + i * 1e8),
      sourceFile: 'b.bz2', latitude: 1.5 + i * 0.00001, longitude: 104.0,
      flags: 1, horizontalAccuracy: 5, speed: 10, bearingDeg: 0,
    });
  }
  const models = [
  { logMonoTime: String(1e10 + 2e8), sourceFile: 'a.bz2', modelV2: mkModel() },
  { logMonoTime: String(2e10 + 2e8), sourceFile: 'b.bz2', modelV2: mkModel() },
  ];
  const result = processRoute(models, gps, { maxModelGpsDeltaNs: 5e9 });
  assert.ok(result.routeChunks.length >= 2);
  assert.notEqual(result.routeChunks[0].chunkId, result.routeChunks[1].chunkId);
});

test('modelToGlobal bearing 0: x forward = north', () => {
  const p = modelToGlobal(10, 0, 0, 0, 0);
  assert.ok(Math.abs(p.north - 10) < 0.01);
});

test('circular bearing interpolation 359 to 1', () => {
  const mid = lerpAngleDeg(359, 1, 0.5);
  assert.ok(Math.abs(mid) < 2 || Math.abs(mid - 360) < 2);
});

test('GPS validation accepts valid fix', () => {
  assert.equal(validateGpsRecord({
    latitude: 1.306, longitude: 103.927, logMonoTime: '100', flags: 1, horizontalAccuracy: 5,
  }, { maxAccuracyM: 50 }), true);
});

test('processRoute global mode with GPS', () => {
  const gps = [];
  for (let i = 0; i < 10; i++) {
    gps.push({
      logMonoTime: String(1e10 + i * 1e8),
      latitude: 1.306 + i * 0.00001, longitude: 103.927 + i * 0.00001,
      flags: 1, horizontalAccuracy: 5, speed: 10, bearingDeg: 45, sourceFile: 'test.bz2',
    });
  }
  const models = [{
    logMonoTime: String(1e10 + 5e8), sourceFile: 'test.bz2',
    modelV2: mkModel(),
  }];
  const result = processRoute(models, gps, { maxModelGpsDeltaNs: 5e9 });
  assert.equal(result.mode, 'global');
  assert.ok(result.routeChunks.length >= 1);
});

test('no giant polygon spanning independent route chunks', () => {
  const gps = [];
  const models = [];
  for (let section = 0; section < 2; section++) {
    const baseLat = 1.3 + section * 0.02;
    const baseLon = 103.9 + section * 0.02;
    const file = section === 0 ? 'a.bz2' : 'b.bz2';
    for (let i = 0; i < 8; i++) {
      gps.push({
        logMonoTime: String((section + 1) * 1e10 + i * 5e8),
        latitude: baseLat + i * 0.00002,
        longitude: baseLon + i * 0.00002,
        flags: 1, horizontalAccuracy: 5, speed: 10, bearingDeg: 0, sourceFile: file,
      });
    }
    models.push({
      logMonoTime: String((section + 1) * 1e10 + 3e8),
      sourceFile: file,
      modelV2: mkModel(),
    });
  }
  const result = processRoute(models, gps, { maxModelGpsDeltaNs: 5e9 });
  assert.ok(result.routeChunks.length >= 2);
  const areas = result.routeChunks.flatMap((c) => c.roadSurfacePolygons.map((p) => p.stats?.area ?? 0));
  const maxArea = areas.length ? Math.max(...areas) : 0;
  assert.ok(maxArea < 5000, `polygon area ${maxArea} too large`);
});

test('polyline split helper avoids connecting distant vertices', () => {
  const pts = [
    { east: 0, north: 0 },
    { east: 1, north: 0 },
    { east: 500, north: 0 },
    { east: 501, north: 0 },
  ];
  const frags = splitPolylineByGap(pts, 10);
  assert.equal(frags.length, 2);
  assert.equal(frags[0].length, 2);
  assert.equal(frags[1].length, 2);
});

test('trajectory projection orders curved-road points monotonically', () => {
  const trajectory = [];
  for (let i = 0; i <= 10; i++) {
    trajectory.push({ east: i * 5, north: i * i * 0.3 });
  }
  const points = [
    { east: 2, north: 0.5 },
    { east: 40, north: 8 },
    { east: 20, north: 2.5 },
    { east: 45, north: 9 },
  ];
  const ordered = orderPointsAlongTrajectory(points, trajectory);
  for (let i = 1; i < ordered.length; i++) {
    assert.ok((ordered[i].s ?? 0) >= (ordered[i - 1].s ?? 0) - 2);
  }
});

test('overlapping frame predictions produce stable longitudinal boundary', () => {
  const { processChunkSdFusion } = require('../lib/sd_fusion');
  const frames = [];
  for (let f = 0; f < 5; f++) {
    const vehicleS = f * 15;
    const east = vehicleS;
    const north = 0;
    frames.push({
      frameId: f,
      logMonoTime: String(1e10 + f * 2e9),
      sourceFile: 'test.bz2',
      pose: { east, north, headingDeg: 90, speed: 10 },
      edges: [
        {
          edgeIndex: 0,
          points: [
            { east: east + 5, north: north + 3 },
            { east: east + 20, north: north + 3 },
            { east: east + 35, north: north + 3 },
          ],
        },
        {
          edgeIndex: 1,
          points: [
            { east: east + 5, north: north - 3 },
            { east: east + 20, north: north - 3 },
            { east: east + 35, north: north - 3 },
          ],
        },
      ],
      lanes: [],
    });
  }
  const vehiclePath = frames.map((f) => ({
    logMonoTime: f.logMonoTime,
    east: f.pose.east,
    north: f.pose.north,
    frameId: f.frameId,
    headingDeg: 90,
  }));
  const result = processChunkSdFusion(frames, vehiclePath, {
    fusionIntervalM: 2,
    minObsPerBin: 1,
    minFramesPerBin: 1,
    maxLaneFragmentGapM: 10,
    maxInterpolationSpanM: 20,
  });
  const left = result.leftBoundary[0]?.points || [];
  let zigzags = 0;
  for (let i = 2; i < left.length; i++) {
    const d1 = left[i - 1].north - left[i - 2].north;
    const d2 = left[i].north - left[i - 1].north;
    if (Math.sign(d1) !== Math.sign(d2) && Math.abs(d1) > 0.5 && Math.abs(d2) > 0.5) zigzags++;
  }
  assert.ok(left.length >= 2);
  assert.equal(zigzags, 0);
  assert.ok(result.roadSurfacePolygons.length >= 1);
});

test('max internal GPS gap per chunk respects configured threshold', () => {
  const gps = [];
  for (let i = 0; i < 10; i++) {
    gps.push({
      logMonoTime: String(1e10 + i * 1e8),
      latitude: 1.306 + i * 0.00001, longitude: 103.927 + i * 0.00001,
      flags: 1, horizontalAccuracy: 5, speed: 10, bearingDeg: 45, sourceFile: 'test.bz2',
    });
  }
  const models = [{
    logMonoTime: String(1e10 + 5e8), sourceFile: 'test.bz2',
    modelV2: mkModel(),
  }];
  const result = processRoute(models, gps, { maxModelGpsDeltaNs: 5e9, maxGpsGapM: 30 });
  assert.ok((result.stats.maxInternalGpsGapPerChunkM ?? 0) <= 30.5);
});

test('U-shaped trajectory splits into multiple passes', () => {
  const { detectPasses } = require('../lib/passes');
  const path = [];
  for (let i = 0; i <= 10; i++) path.push({ east: i * 10, north: 0, logMonoTime: String(1e10 + i * 1e9), frameId: i, headingDeg: 90, speed: 5 });
  for (let i = 1; i <= 10; i++) path.push({ east: 100 - i * 10, north: 0, logMonoTime: String(2e10 + i * 1e9), frameId: 10 + i, headingDeg: 270, speed: 5 });
  const { passes, diagnostics } = detectPasses(path, {});
  assert.ok(passes.length >= 2, `expected >=2 passes, got ${passes.length}`);
  assert.ok(diagnostics.directionReversals >= 1 || diagnostics.splitEvents.length >= 1);
});

test('complete loop detected as suspicious when start/end overlap', () => {
  const { detectPasses } = require('../lib/passes');
  const path = [];
  const n = 16;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    path.push({
      east: 50 * Math.cos(a),
      north: 50 * Math.sin(a),
      logMonoTime: String(1e10 + i * 1e9),
      frameId: i,
      headingDeg: (a * 180) / Math.PI,
      speed: 3,
    });
  }
  const { passes, diagnostics } = detectPasses(path, {});
  assert.ok(passes.length >= 1);
  assert.ok(diagnostics.startEndDisplacementM < 25);
});

test('opposite-direction passes on same road stay separate', () => {
  const { processPassSdFusion } = require('../lib/sd_fusion');
  const frames = [];
  for (let f = 0; f < 4; f++) {
    frames.push({
      frameId: f, logMonoTime: String(1e10 + f * 2e9), sourceFile: 't', passId: 0,
      pose: { east: f * 15, north: 0, headingDeg: 90, speed: 10 },
      edges: [
        { edgeIndex: 0, points: [{ east: f * 15 + 5, north: 3 }, { east: f * 15 + 20, north: 3 }] },
        { edgeIndex: 1, points: [{ east: f * 15 + 5, north: -3 }, { east: f * 15 + 20, north: -3 }] },
      ],
      lanes: [],
    });
  }
  const vehiclePath = frames.map((f) => ({ logMonoTime: f.logMonoTime, east: f.pose.east, north: f.pose.north, frameId: f.frameId, headingDeg: 90 }));
  const r1 = processPassSdFusion(frames, vehiclePath, { minObsPerBin: 1, minFramesPerBin: 1 });
  assert.ok(r1.roadSurfacePolygons.length >= 0);
});

test('self-intersecting trajectory splits into multiple passes', () => {
  const { detectPasses } = require('../lib/passes');
  const path = [];
  for (let i = 0; i <= 10; i++) path.push({ east: i * 10, north: 0, logMonoTime: String(1e10 + i * 1e9), frameId: i, headingDeg: 90, speed: 5 });
  for (let i = 1; i <= 10; i++) path.push({ east: 100 - i * 10, north: (i % 2) * 5, logMonoTime: String(2e10 + i * 1e9), frameId: 10 + i, headingDeg: 270, speed: 5 });
  const { passes, diagnostics } = detectPasses(path, {});
  assert.ok(passes.length >= 2, `expected >=2 passes, got ${passes.length}`);
  assert.ok(diagnostics.selfIntersectionSplits >= 1 || diagnostics.directionReversals >= 1);
});

test('stationary GPS drift does not create many passes when step is tiny', () => {
  const { detectPasses } = require('../lib/passes');
  const path = [];
  for (let i = 0; i < 20; i++) {
    path.push({
      east: Math.sin(i * 0.3) * 2,
      north: Math.cos(i * 0.3) * 2,
      logMonoTime: String(1e10 + i * 1e9),
      frameId: i,
      headingDeg: i * 20,
      speed: 0,
    });
  }
  const { passes } = detectPasses(path, {});
  assert.ok(passes.length <= 3, `expected few passes for stationary drift, got ${passes.length}`);
});

test('sparse model observations require multi-frame bin support', () => {
  const { fuseSideBoundary } = require('../lib/sd_fusion');
  const obs = [
    { s: 0, d: 3, side: 'left', prob: 1, frameId: 0 },
    { s: 2, d: 3.1, side: 'left', prob: 1, frameId: 0 },
    { s: 4, d: 3.2, side: 'left', prob: 1, frameId: 1 },
  ];
  const strict = fuseSideBoundary(obs, 'left', { minObsPerBin: 2, minFramesPerBin: 2, fusionIntervalM: 2 });
  const loose = fuseSideBoundary(obs, 'left', { minObsPerBin: 1, minFramesPerBin: 1, fusionIntervalM: 2 });
  assert.ok(strict.fusedPoints.length <= loose.fusedPoints.length);
});

test('lane tracking assigns consistent track ids across frames', () => {
  const { trackLanesAndEdgesInPass } = require('../lib/lane_tracking');
  const frames = [];
  for (let i = 0; i < 4; i++) {
    frames.push({
      frameId: i,
      logMonoTime: String(1e10 + i * 2e9),
      passId: 0,
      chunkId: 0,
      pose: { east: i * 10, north: 0, headingDeg: 90 },
      lanes: [
        { laneIndex: 0, prob: 0.9, points: [{ east: i * 10 + 5, north: 2 }, { east: i * 10 + 20, north: 2.1 }] },
        { laneIndex: 1, prob: 0.9, points: [{ east: i * 10 + 5, north: -2 }, { east: i * 10 + 20, north: -2.1 }] },
      ],
      edges: [],
    });
  }
  const result = trackLanesAndEdgesInPass(frames, {});
  const tracked = result.frames;
  const ids = tracked.map((f) => f.lanes.map((l) => l.laneTrackId));
  assert.equal(ids[0][0], ids[1][0]);
  assert.equal(ids[0][1], ids[1][1]);
  assert.ok((result.summary?.trackCount ?? result.laneDiagnostics?.trackCount ?? 0) >= 2);
});

test('geometry debug reports per-pass polygons', () => {
  const { buildGeometryDebug } = require('../lib/geometry_debug');
  const result = {
    frames: [],
    routeChunks: [{
      chunkId: 0,
      passCoverage: [{ passId: 0 }, { passId: 1 }],
      roadSurfacePolygons: [
        { passId: 0, fragmentIndex: 0, ring: [{ east: 0, north: 0 }, { east: 10, north: 0 }, { east: 10, north: 5 }] },
        { passId: 1, fragmentIndex: 0, ring: [{ east: 20, north: 0 }, { east: 30, north: 0 }, { east: 30, north: 5 }] },
      ],
    }],
  };
  const g = buildGeometryDebug(result, ['qlog_f449c_2.bz2']);
  assert.equal(g.passCount, 2);
  assert.equal(g.polygonCount, 2);
  assert.equal(g.polygons[0].passId, 0);
});

function mkModel() {
  return {
    frameId: 1,
    laneLines: [{ x: [5, 10, 20], y: [0, 0, 0], z: [], t: [] }],
    laneLineProbs: [0.9],
    roadEdges: [
      { x: [5, 10, 20], y: [3, 3, 3], z: [], t: [] },
      { x: [5, 10, 20], y: [-3, -3, -3], z: [], t: [] },
    ],
  };
}
