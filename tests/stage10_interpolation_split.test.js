const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildReferenceTrajectory } = require('../lib/trajectory');
const {
  resolveMaxInterpolationSpanM,
  splitSupportedRuns,
  pairSupportedRuns,
  interpolateDWithinRun,
  resamplePairedRun,
  resampleBoundaries,
  buildPolygonsFromIntervals,
} = require('../lib/sd_fusion');
const { countSelfIntersections, maxConsecutiveVertexJump } = require('../lib/geometry_sanity');

const BASE_OPTS = {
  fusionIntervalM: 2,
  polygonSampleStepM: 2,
  minRoadWidthM: 2,
  maxRoadWidthM: 30,
  maxVertexJumpM: 15,
};

function makeRun(sValues, dLeft, dRight) {
  return {
    left: sValues.map((s) => ({ s, d: dLeft })),
    right: sValues.map((s) => ({ s, d: dRight })),
  };
}

function trajectoryFromS(points) {
  return buildReferenceTrajectory(points.map((p, i) => ({
    east: p.s,
    north: 0,
    logMonoTime: String(i * 1e9),
    speed: 10,
    headingDeg: 90,
  })));
}

describe('maxInterpolationSpanM splitting', () => {
  it('defaults maxInterpolationSpanM to fusionIntervalM × 2', () => {
    assert.equal(resolveMaxInterpolationSpanM({ fusionIntervalM: 2 }), 4);
    assert.equal(resolveMaxInterpolationSpanM({ fusionIntervalM: 3, maxInterpolationSpanM: 10 }), 10);
  });

  it('allows interpolation exactly at maxInterpolationSpanM', () => {
    const pts = [{ s: 0, d: 5 }, { s: 4, d: 5 }];
    const r = interpolateDWithinRun(pts, 2, 4);
    assert.ok(r);
    assert.equal(r.spanM, 4);
  });

  it('rejects interpolation slightly above maxInterpolationSpanM', () => {
    const pts = [{ s: 0, d: 5 }, { s: 2, d: 5 }, { s: 6.1, d: 5 }, { s: 8.1, d: 5 }];
    const runs = splitSupportedRuns(pts, 4);
    assert.equal(runs.length, 2);
  });

  it('splits on one missing fusion bin gap', () => {
    const pts = [{ s: 0, d: 5 }, { s: 2, d: 5 }, { s: 8, d: 5 }, { s: 10, d: 5 }];
    const runs = splitSupportedRuns(pts, 4);
    assert.equal(runs.length, 2);
    assert.equal(runs[0][runs[0].length - 1].s, 2);
    assert.equal(runs[1][0].s, 8);
  });

  it('splits on several consecutive missing bins', () => {
    const pts = [{ s: 0, d: 5 }, { s: 2, d: 5 }, { s: 14, d: 5 }, { s: 16, d: 5 }];
    const runs = splitSupportedRuns(pts, 4);
    assert.equal(runs.length, 2);
  });

  it('splits left boundary gaps independently from right', () => {
    const leftFrags = [[{ s: 0, d: 6 }, { s: 2, d: 6 }, { s: 10, d: 6 }, { s: 12, d: 6 }]];
    const rightFrags = [[{ s: 0, d: -6 }, { s: 2, d: -6 }, { s: 4, d: -6 }, { s: 12, d: -6 }]];
    const traj = trajectoryFromS([{ s: 0 }, { s: 12 }]);
    const result = resampleBoundaries(leftFrags, rightFrags, traj, BASE_OPTS);
    assert.ok(result.supportedRuns.left.length >= 2);
    assert.ok(result.supportedRuns.right.length >= 1);
  });

  it('pairs only overlapping supported runs', () => {
    const leftRuns = splitSupportedRuns([
      { s: 0, d: 5 }, { s: 2, d: 5 }, { s: 20, d: 5 }, { s: 22, d: 5 }, { s: 24, d: 5 },
    ], 4);
    const rightRuns = splitSupportedRuns([
      { s: 20, d: -5 }, { s: 22, d: -5 }, { s: 24, d: -5 }, { s: 26, d: -5 },
    ], 4);
    const pairs = pairSupportedRuns(leftRuns, rightRuns, 4);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].overlapStart, 20);
    assert.equal(pairs[0].overlapEnd, 24);
  });

  it('handles misaligned left/right supported runs as separate paired intervals', () => {
    const leftFrags = [[
      { s: 0, d: 6 }, { s: 2, d: 6 }, { s: 4, d: 6 },
      { s: 20, d: 6 }, { s: 22, d: 6 }, { s: 24, d: 6 },
    ]];
    const rightFrags = [[
      { s: 0, d: -6 }, { s: 2, d: -6 }, { s: 4, d: -6 },
      { s: 20, d: -6 }, { s: 22, d: -6 }, { s: 24, d: -6 },
    ]];
    const traj = trajectoryFromS([{ s: 0 }, { s: 24 }]);
    const result = resampleBoundaries(leftFrags, rightFrags, traj, BASE_OPTS);
    assert.equal(result.intervals.length, 2);
  });

  it('builds valid polygon from curved boundaries with dense support', () => {
    const sVals = [];
    for (let s = 0; s <= 40; s += 2) sVals.push(s);
    const leftFrags = [sVals.map((s) => ({ s, d: 6 + Math.sin(s / 10) }))];
    const rightFrags = [sVals.map((s) => ({ s, d: -6 + Math.sin(s / 10) * 0.5 }))];
    const traj = trajectoryFromS(sVals.map((s) => ({ s })));
    const { intervals } = resampleBoundaries(leftFrags, rightFrags, traj, BASE_OPTS);
    const { polygons, rejectionLog } = buildPolygonsFromIntervals(intervals, traj, BASE_OPTS);
    assert.equal(polygons.length, 1);
    assert.equal(rejectionLog.length, 0);
    assert.equal(countSelfIntersections(polygons[0].ring), 0);
  });

  it('does not close polygon across separate supported runs', () => {
    const leftFrags = [[
      { s: 0, d: 6 }, { s: 2, d: 6 }, { s: 4, d: 6 },
      { s: 20, d: 6 }, { s: 22, d: 6 }, { s: 24, d: 6 },
    ]];
    const rightFrags = [[
      { s: 0, d: -6 }, { s: 2, d: -6 }, { s: 4, d: -6 },
      { s: 20, d: -6 }, { s: 22, d: -6 }, { s: 24, d: -6 },
    ]];
    const traj = trajectoryFromS([{ s: 0 }, { s: 24 }]);
    const { intervals } = resampleBoundaries(leftFrags, rightFrags, traj, BASE_OPTS);
    const { polygons } = buildPolygonsFromIntervals(intervals, traj, BASE_OPTS);
    assert.equal(polygons.length, 2);
    for (const p of polygons) {
      assert.equal(countSelfIntersections(p.ring), 0);
      assert.ok(maxConsecutiveVertexJump(p.ring) <= BASE_OPTS.maxVertexJumpM);
    }
  });

  it('eliminates self-intersection caused by bridging a large unsupported span', () => {
    const sVals = [];
    for (let s = 0; s <= 100; s += 2) {
      if (s >= 40 && s <= 70) continue;
      sVals.push(s);
    }
    const leftFrags = [sVals.map((s) => ({ s, d: 6 }))];
    const rightFrags = [sVals.map((s) => ({ s, d: -6 }))];
    const traj = trajectoryFromS(sVals.map((s) => ({ s })));
    const { intervals, supportedRuns } = resampleBoundaries(leftFrags, rightFrags, traj, BASE_OPTS);
    assert.ok(supportedRuns.left.length >= 2);
    const { polygons, rejectionLog } = buildPolygonsFromIntervals(intervals, traj, BASE_OPTS);
    for (const p of polygons) {
      assert.equal(countSelfIntersections(p.ring), 0);
    }
    assert.equal(rejectionLog.filter((r) => r.reasons.includes('selfIntersecting')).length, 0);
  });

  it('does not create vertex jump across unsupported gap', () => {
    const leftFrags = [[{ s: 0, d: 6 }, { s: 2, d: 6 }, { s: 10, d: 6 }, { s: 12, d: 6 }]];
    const rightFrags = [[{ s: 0, d: -6 }, { s: 2, d: -6 }, { s: 10, d: -6 }, { s: 12, d: -6 }]];
    const traj = trajectoryFromS([{ s: 0 }, { s: 12 }]);
    const { intervals } = resampleBoundaries(leftFrags, rightFrags, traj, BASE_OPTS);
    const { polygons } = buildPolygonsFromIntervals(intervals, traj, BASE_OPTS);
    for (const p of polygons) {
      assert.ok(maxConsecutiveVertexJump(p.ring) <= BASE_OPTS.maxVertexJumpM);
    }
  });

  it('preserves existing valid dense polygon unchanged', () => {
    const sVals = [];
    for (let s = 0; s <= 30; s += 2) sVals.push(s);
    const leftFrags = [sVals.map((s) => ({ s, d: 6 }))];
    const rightFrags = [sVals.map((s) => ({ s, d: -6 }))];
    const traj = trajectoryFromS(sVals.map((s) => ({ s })));
    const { intervals } = resampleBoundaries(leftFrags, rightFrags, traj, BASE_OPTS);
    const { polygons } = buildPolygonsFromIntervals(intervals, traj, BASE_OPTS);
    assert.equal(polygons.length, 1);
    assert.ok(polygons[0].stats.length > 20);
    assert.equal(countSelfIntersections(polygons[0].ring), 0);
  });

  it('rejects when every resulting run has insufficient paired coverage', () => {
    const leftFrags = [[{ s: 0, d: 6 }, { s: 2, d: 6 }]];
    const rightFrags = [[{ s: 20, d: -6 }, { s: 22, d: -6 }]];
    const traj = trajectoryFromS([{ s: 0 }, { s: 22 }]);
    const result = resampleBoundaries(leftFrags, rightFrags, traj, BASE_OPTS);
    assert.equal(result.intervals.length, 0);
    assert.ok(result.rejected.includes('insufficientPairedCoverage') || result.rejected.includes('rangeTooShort'));
  });
});

describe('downstream multi-polygon retention', () => {
  const ROUTE_OPTS = {
    ...BASE_OPTS,
    pipelineMode: 'C',
    laneTrackingEnabled: true,
    localSupportFilter: true,
    minLaneProb: 0.5,
    maxAccuracyM: 50,
    maxModelGpsDeltaNs: 2e9,
    maxForwardM: 120,
  };

  it('process_route retains every supported-run polygon without collapsing to one', () => {
    const { loadSegmentsData } = require('../lib/qlog_data');
    const { processRoute } = require('../lib/process_route');
    const { qualifySegments } = require('../lib/segment_qualify');
    const loaded = loadSegmentsData('.', ['qlog_f449c_46.bz2'], ROUTE_OPTS);
    const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
      ...ROUTE_OPTS,
      segmentQualifications: qualifySegments(loaded.audits),
      fileAudits: loaded.audits,
    });
    const chunk = result.routeChunks[0];
    const chunkPolys = chunk.roadSurfacePolygons;
    const flatPolys = result.roadSurfacePolygons;
    assert.ok(chunkPolys.length > 1, 'expected multiple polygons per segment');
    assert.equal(flatPolys.length, chunkPolys.length);
    const fragIndexes = new Set(chunkPolys.map((p) => p.fragmentIndex));
    assert.equal(fragIndexes.size, chunkPolys.length);
    for (const p of chunkPolys) {
      assert.ok(p.ring?.length >= 4);
      assert.ok(maxConsecutiveVertexJump(p.ring) <= BASE_OPTS.maxVertexJumpM);
    }
    const roundTrip = JSON.parse(JSON.stringify(chunk));
    assert.equal(roundTrip.roadSurfacePolygons.length, chunkPolys.length);
  });

  it('segment 46 vertex jump: accepted runs pass cap; rejected run fails closure edge', () => {
    const { loadSegmentsData } = require('../lib/qlog_data');
    const { processRoute } = require('../lib/process_route');
    const { qualifySegments } = require('../lib/segment_qualify');
    const { detectPasses, assignFramesToPasses } = require('../lib/passes');
    const { trackLanesAndEdgesInPass } = require('../lib/lane_tracking');
    const { assignPoseSections, applyPoseSectionsToFrames } = require('../lib/pose_continuity');
    const {
      collectEdgeObservations,
      fuseSideBoundary,
      resampleBoundaries,
      buildPolygonsFromIntervals,
    } = require('../lib/sd_fusion');
    const { buildReferenceTrajectory } = require('../lib/trajectory');
    const loaded = loadSegmentsData('.', ['qlog_f449c_46.bz2'], ROUTE_OPTS);
    const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
      ...ROUTE_OPTS,
      segmentQualifications: qualifySegments(loaded.audits),
      fileAudits: loaded.audits,
    });
    const path = result.routeChunks[0].vehiclePath;
    const { passes } = detectPasses(path, ROUTE_OPTS);
    const tracked = trackLanesAndEdgesInPass(
      applyPoseSectionsToFrames(
        assignFramesToPasses(result.frames, passes),
        assignPoseSections(
          passes.flatMap((p) => p.points.map((pt) => ({ ...pt, passId: p.passId }))),
          ROUTE_OPTS
        ).annotatedPoints
      ),
      ROUTE_OPTS
    );
    const traj = buildReferenceTrajectory(path);
    const left = fuseSideBoundary(collectEdgeObservations(tracked.frames, traj, ROUTE_OPTS).observations, 'left', ROUTE_OPTS);
    const right = fuseSideBoundary(collectEdgeObservations(tracked.frames, traj, ROUTE_OPTS).observations, 'right', ROUTE_OPTS);
    const resample = resampleBoundaries(left.fragments, right.fragments, traj, ROUTE_OPTS);
    const built = buildPolygonsFromIntervals(resample.intervals, traj, ROUTE_OPTS);

    const acceptedMax = Math.max(...built.polygons.map((p) => maxConsecutiveVertexJump(p.ring)));
    const rejected = built.rejectionLog.find((r) => r.reasons.includes('vertexJumpTooLarge'));
    assert.ok(rejected);
    assert.ok(rejected.stats.maxVertexJump > ROUTE_OPTS.maxVertexJumpM);
    assert.ok(acceptedMax <= ROUTE_OPTS.maxVertexJumpM);
    assert.ok(Math.abs(rejected.stats.maxVertexJump - 15.129188987881262) < 1e-6);
    assert.ok(Math.abs(acceptedMax - 14.459800276542618) < 1e-6);
  });
});
