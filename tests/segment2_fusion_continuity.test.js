'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const { anchorLateralStats, sharedAnchorPairs } = require('../lib/lane_anchors');
const { computeMatchDetail, trackLanesInPass, DEFAULT_OPTS } = require('../lib/lane_tracking');
const {
  selectOuterLaneTrackBoundaries,
  buildPolygonsFromIntervals,
  collectLaneObservations,
} = require('../lib/sd_fusion');
const { buildReferenceTrajectory } = require('../lib/trajectory');
const { countSelfIntersections } = require('../lib/geometry_sanity');
const SLM = require('../lib/segment_local_map');
const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
const { buildTimeline } = require('../lib/process_route');

const ROOT = path.join(__dirname, '..');
const SEG2 = 'qlog_f449c_2.bz2';

function loadSegment() {
  const segPath = path.join(ROOT, SEG2);
  const modelEvents = extractModel(segPath).map((e) => ({ ...e, sourceFile: SEG2 }));
  const gpsEvents = extractGps(segPath).map((e) => ({ ...e, sourceFile: SEG2 }));
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
  return { ...result, timeline };
}

describe('segment 2 fusion continuity', () => {
  it('pre-dropout track survives through verified dropout without fabricating lane points', () => {
    const data = loadSegment();
    const track0 = data.routeChunks[0].laneTracks.find((t) => t.trackId === 0);
    assert.ok(track0, 'track 0 exists');
    assert.ok(track0.frameIds.includes(2443), 'pre-dropout frame');
    assert.ok(track0.frameIds.includes(2843), 'post-dropout frame');
    const dropoutFrames = data.frames.slice(6, 10);
    assert.ok(dropoutFrames.every((f) => !(f.lanes || []).length), 'dropout has no lanes');
    for (const f of dropoutFrames) {
      assert.equal((f.lanes || []).length, 0);
    }
  });

  it('turn heading compensation reduces false lateral rejection', () => {
    const pairs = [
      { prev: { forwardM: 30, modelY: 1.0 }, next: { forwardM: 30, modelY: 3.2 } },
    ];
    const raw = anchorLateralStats(pairs, 254, 250);
    const uncompensated = Math.abs(3.2 - 1.0);
    assert.ok(raw.maxLatDiff < uncompensated);
  });

  it('coasting tracks skip heading gate on re-acquisition', () => {
    const prev = {
      frameId: 1, logMonoTime: '1000000000', passId: 0, laneIndex: 0, lateralOrder: 0,
      headingDeg: 200, prob: 0.9, gpsAccuracy: 5,
      forwardRange: { min: 5, max: 40 },
      anchors: [{ forwardM: 10, modelY: 2, east: 0, north: 0 }, { forwardM: 20, modelY: 2, east: 5, north: 5 }],
      pose: { east: 0, north: 0, headingDeg: 200, speed: 10 },
    };
    const next = {
      frameId: 2, logMonoTime: '15000000000', passId: 0, laneIndex: 0, lateralOrder: 0,
      headingDeg: 90, prob: 0.9, gpsAccuracy: 5,
      forwardRange: { min: 5, max: 40 },
      anchors: [{ forwardM: 10, modelY: 2.1, east: 40, north: 10 }, { forwardM: 20, modelY: 2.0, east: 50, north: 12 }],
      pose: { east: 40, north: 10, headingDeg: 90, speed: 10 },
    };
    const coasting = { trackId: 0, missedFrames: 4, headingDeg: 200 };
    const d = computeMatchDetail(prev, next, coasting, DEFAULT_OPTS);
    assert.notEqual(d.rejection, 'excessiveHeading');
  });

  it('unrelated lane boundaries are not merged into one polygon pair without s overlap', () => {
    const data = loadSegment();
    const chunk = data.routeChunks[0];
    const traj = buildReferenceTrajectory(chunk.vehiclePath);
    const laneObs = collectLaneObservations(data.frames, traj, {});
    const bounds = selectOuterLaneTrackBoundaries(laneObs, { trajectory: traj });
    assert.ok(bounds);
    const pairs = bounds.pairs ?? [bounds];
    for (const pair of pairs) {
      assert.ok(pair.overlapM >= 20, `overlap ${pair.overlapM}`);
      assert.notEqual(pair.leftTrackId, pair.rightTrackId);
    }
  });

  it('polygon rings do not self-intersect when accepted', () => {
    const data = loadSegment();
    for (const poly of data.routeChunks[0].roadSurfacePolygons) {
      const intersections = countSelfIntersections(poly.ring);
      assert.equal(intersections, 0, `poly ${poly.fragmentIndex} self-intersects`);
    }
  });

  it('fused geometry retains track provenance', () => {
    const data = loadSegment();
    const fused = data.routeChunks[0].fusedLaneLines;
    assert.ok(fused.length > 0);
    assert.ok(fused.every((f) => f.laneTrackId != null));
  });

  it('stationary map checksum constant across audited indices', () => {
    const data = loadSegment();
    const checksums = new Set();
    for (const idx of [0, 4, 8, 12, 16, 29]) {
      const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'fused', timelineIndex: idx });
      checksums.add(map.checksum);
    }
    assert.equal(checksums.size, 1);
  });

  it('road surface polygons exist along post-turn corridor', () => {
    const data = loadSegment();
    const polys = data.routeChunks[0].roadSurfacePolygons;
    assert.ok(polys.length > 0);
    const postTurn = polys.filter((p) => p.stats?.sRange?.[0] >= 300);
    assert.ok(postTurn.length > 0, 'expected post-turn polygons');
  });
});
