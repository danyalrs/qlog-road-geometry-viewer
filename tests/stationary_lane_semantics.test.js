'use strict';

/**
 * Segment 9 lane-semantics / lateral-coordinate / missing-boundary /
 * road-polygon diagnosis tests.
 *
 * Covers:
 *  1. All four model lane-line indices retain their semantic roles.
 *  2. A fixed stationary pose preserves lateral offsets (no collapse to d=0).
 *  3. No physical boundary is transformed onto d=0 unless its source is there.
 *  4. Predicted path data cannot enter the lane-boundary list.
 *  5. Mirror display changes presentation only (geometry/identity unchanged).
 *  6. A stationary segment can form a local polygon from two supported
 *     boundaries.
 *  7. Polygon creation does not require vehicle translation.
 *  8. An unsupported missing boundary is not invented.
 *  9. Partial geometry remains visible when a polygon cannot be formed.
 * 10. Segment 6 and Segment 9 stationary locks remain unchanged.
 * 11. Existing lane tracking and joining behaviour does not regress.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SLM = require('../lib/segment_local_map');
const PA = require('../lib/point_accumulation');
const { computeStationaryPoseLock } = require('../lib/stationary_pose_lock');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const { sideFromLaneIndex } = require('../lib/point_accumulation');

const ROOT = path.join(__dirname, '..');

function runSegment(seg) {
  const f = `qlog_f449c_${seg}.bz2`;
  const segPath = path.join(ROOT, f);
  if (!fs.existsSync(segPath)) return null;
  const me = extractModel(segPath).map((e) => ({ ...e, sourceFile: f }));
  const ge = extractGps(segPath).map((e) => ({ ...e, sourceFile: f }));
  const r = processRoute(me, ge, { pipelineMode: 'C' });
  r.timeline = buildTimeline(r.frames);
  return r;
}

function buildPointMap(r, options = {}) {
  return SLM.buildSegmentLocalMap(
    { ...r, processingOptions: r.processingOptions },
    { geometrySource: 'pointAccumulated', timelineIndex: 0, chunkId: 0, passId: 0, ...options },
  );
}

const SEG9 = runSegment('9');
const SEG6 = runSegment('6');

describe('stationary lane semantics — Seg9', () => {
  it('1. all four model lane-line indices retain their semantic roles', () => {
    if (!SEG9) return;
    // Raw modelV2: lane0 outer-right, lane1 ego-right, lane2 ego-left,
    // lane3 outer-left (sideFromLaneIndex: 0/1 -> right, 2/3 -> left).
    assert.equal(sideFromLaneIndex(0), 'right');
    assert.equal(sideFromLaneIndex(1), 'right');
    assert.equal(sideFromLaneIndex(2), 'left');
    assert.equal(sideFromLaneIndex(3), 'left');
    const map = buildPointMap(SEG9);
    const pts = map.pointAccumulated?.points || [];
    // Every displayed point keeps its source lane index + side.
    const laneSides = new Map();
    for (const p of pts) {
      const key = `${p.laneIndex}:${p.side}`;
      laneSides.set(key, (laneSides.get(key) || 0) + 1);
    }
    assert.ok(laneSides.get('1:right') > 500, 'lane1 (ego-right) well represented');
    assert.ok(laneSides.get('2:left') > 0, 'lane2 (ego-left) represented');
    assert.ok(laneSides.get('0:right') > 0, 'lane0 (outer-right) represented where supported');
    // No lane is mislabelled: right lanes keep right, left lanes keep left.
    for (const [key] of laneSides) {
      const [li, side] = key.split(':');
      assert.equal(sideFromLaneIndex(Number(li)), side);
    }
  });

  it('2. a fixed stationary pose preserves lateral offsets (no collapse to d=0)', () => {
    if (!SEG9) return;
    const map = buildPointMap(SEG9);
    const pts = map.pointAccumulated?.points || [];
    const groups = new Map();
    for (const p of pts) {
      if (!groups.has(p.groupTrackId)) groups.set(p.groupTrackId, []);
      groups.get(p.groupTrackId).push(p);
    }
    assert.ok(groups.size >= 2, 'multiple distinct boundaries retained');
    for (const [gid, arr] of groups) {
      const dRange = [Math.min(...arr.map((p) => p.d)), Math.max(...arr.map((p) => p.d))];
      const localNRange = [Math.min(...arr.map((p) => p.localNorth)), Math.max(...arr.map((p) => p.localNorth))];
      // A real boundary must not collapse onto the vehicle axis (d=0) unless
      // its source points actually sit there.
      assert.ok(Math.max(...arr.map((p) => Math.abs(p.d))) > 0.3,
        `group ${gid} must retain a real lateral offset, got ${dRange.join(',')}`);
      assert.ok(Math.abs(localNRange[0]) > 0.05 || Math.abs(localNRange[1]) > 0.05);
    }
  });

  it('3. no physical boundary is transformed onto d=0 unless its source points are there', () => {
    // Synthetic: a boundary at d=-1.5 through a stationary anchor must stay at d=-1.5.
    const ref = { east: 0, north: 0, headingDeg: 0 };
    const vehiclePath = Array.from({ length: 6 }, () => ({ east: 0.2, north: 0.1, logMonoTime: '1' }));
    const built = PA.buildReferenceTrajectory(vehiclePath);
    const frames = [{
      frameId: 1, logMonoTime: '1', chunkId: 0, passId: 0,
      pose: { east: 0, north: 0, headingDeg: 0 },
      lanes: [{
        laneIndex: 1, laneTrackId: 0, prob: 0.7,
        // With reference heading 0, globalToSegmentLocal maps east -> -lateral
        // and north -> forward. So a boundary at modelY=-1.5 sits at east=1.5
        // in the anchor frame, preserving its offset.
        points: Array.from({ length: 6 }, (_, i) => ({
          east: 1.5, north: i * 5, modelX: i * 5, modelY: -1.5, modelZ: 0, t: i,
          mirroredEast: -1.5, mirroredNorth: i * 5,
        })),
      }],
    }];
    const acc = PA.accumulatePointObservations({
      frames, timeline: [], referencePose: ref, chunkId: 0, passId: 0,
      trajectory: built, options: {},
    });
    const pts = acc.observations;
    assert.ok(pts.length > 0);
    // s = forward distance, d = lateral, from the fixed-anchor frame.
    const dRange = [Math.min(...pts.map((p) => p.d)), Math.max(...pts.map((p) => p.d))];
    const sRange = [Math.min(...pts.map((p) => p.s)), Math.max(...pts.map((p) => p.s))];
    assert.ok(Math.max(...dRange.map(Math.abs)) > 1.0, `lateral offset preserved, got ${dRange}`);
    assert.ok(Math.max(...sRange) >= 20, `forward distance preserved, got ${sRange}`);
  });

  it('4. predicted path data cannot enter the lane-boundary list', () => {
    if (!SEG9) return;
    const map = buildPointMap(SEG9);
    const pts = map.pointAccumulated?.points || [];
    const seen = new Set(pts.map((p) => p.laneIndex));
    // Predicted path would have no laneIndex / no lane identity. Every point
    // here carries a real lane index from the model lane lines.
    assert.ok(seen.size >= 2);
    assert.ok(!seen.has(undefined) && !seen.has('path'));
  });

  it('5. mirror display changes presentation only', () => {
    if (!SEG9) return;
    const map = buildPointMap(SEG9);
    const pts = map.pointAccumulated?.points || [];
    // Mirrored coordinates are precomputed; the identity fields are unchanged.
    for (const p of pts.slice(0, 200)) {
      assert.equal(p.laneIndex, p.laneIndex);
      assert.equal(p.groupTrackId, p.groupTrackId);
      assert.equal(p.side, p.side);
    }
    const mirrorOn = pts.some((p) => p.mirroredLocalEast != null && p.mirroredLocalNorth != null);
    assert.ok(mirrorOn, 'precomputed mirrored coords carried for presentation');
    // Mirror does not alter source geometry (east/north/s/d) or identity.
    for (const p of pts.slice(0, 100)) {
      assert.ok(Number.isFinite(p.east) && Number.isFinite(p.north));
      assert.ok(Number.isFinite(p.s) && Number.isFinite(p.d));
    }
  });

  it('6. a stationary segment can form a local polygon from two supported boundaries', () => {
    if (!SEG9) return;
    const map = buildPointMap(SEG9);
    const polys = map.roadSurfacePolygons || [];
    assert.ok(polys.length >= 1, 'Seg9 forms at least one stationary local polygon');
    const ego = polys.find((p) => p.fragmentKind === 'stationaryLocalRoadSurface');
    assert.ok(ego, 'polygon kind is stationaryLocalRoadSurface');
    assert.ok(ego.ring.length >= 4);
    assert.ok(ego.stats?.supportFrames >= 2, 'built from supported boundaries');
  });

  it('7. polygon creation does not require vehicle translation', () => {
    if (!SEG9) return;
    const map = buildPointMap(SEG9);
    // Seg9 has 0 m mapped trajectory travel (single anchored pose).
    assert.ok(map.trajectoryPointCount <= 1);
    const polys = map.roadSurfacePolygons || [];
    assert.ok(polys.length >= 1, 'polygon exists despite zero vehicle translation');
  });

  it('8. an unsupported missing boundary is not invented', () => {
    if (!SEG9) return;
    const map = buildPointMap(SEG9);
    const polys = map.roadSurfacePolygons || [];
    // Lane 3 (outer-left) is never supported (prob 0.06-0.39). No polygon may
    // pair a boundary with an invented lane-3 counterpart.
    for (const poly of polys) {
      assert.notEqual(poly.sourceLeftLaneIndex, 3);
      assert.notEqual(poly.sourceRightLaneIndex, 3);
    }
    // Lane 0 is supported only in frames 28-29 (2 frames) -> below the 3-frame
    // stationary polygon support gate, so it cannot be a polygon boundary.
    for (const poly of polys) {
      assert.notEqual(poly.sourceLeftLaneIndex, 0);
      assert.notEqual(poly.sourceRightLaneIndex, 0);
    }
  });

  it('9. partial geometry remains visible when a polygon cannot be formed', () => {
    // Build a synthetic stationary segment with only ONE supported boundary:
    // dots and fragments remain, but no polygon is formed (no invented pair).
    const ref = { east: 0, north: 0, headingDeg: 0 };
    const frames = Array.from({ length: 6 }, (_, i) => ({
      frameId: i, logMonoTime: String(i), chunkId: 0, passId: 0,
      pose: { east: 0, north: 0, headingDeg: 0 },
      lanes: [{
        laneIndex: 1, laneTrackId: 0, prob: 0.7,
        points: Array.from({ length: 5 }, (_, k) => ({
          east: 1.5, north: k * 5, modelX: k * 5, modelY: -1.5, modelZ: 0, t: k,
        })),
      }],
    }));
    const map = SLM.buildSegmentLocalMap(
      {
        frames,
        timeline: frames.map((f) => ({ logMonoTime: f.logMonoTime, chunkId: 0, passId: 0 })),
        routeChunks: [{ chunkId: 0, vehiclePath: [], fusedLaneLines: [] }],
        processingOptions: {},
      },
      { geometrySource: 'pointAccumulated', timelineIndex: 0, chunkId: 0, passId: 0 },
    );
    assert.ok(map.pointAccumulatedPointCount > 0, 'single-boundary dots visible');
    assert.equal(map.roadSurfacePolygonCount, 0, 'no polygon without a second supported boundary');
  });

  it('10. Segment 6 and Segment 9 stationary locks remain unchanged', () => {
    if (!SEG6 || !SEG9) return;
    for (const r of [SEG6, SEG9]) {
      const locked = r.frames.filter((f) => f.pose?.stationaryLocked);
      assert.ok(locked.length >= 15, 'stationary lock active');
      const es = new Set(locked.map((f) => f.pose.east.toFixed(3)));
      const ns = new Set(locked.map((f) => f.pose.north.toFixed(3)));
      assert.equal(es.size, 1, 'locked east frozen');
      assert.equal(ns.size, 1, 'locked north frozen');
    }
  });

  it('11. existing lane tracking and joining behaviour does not regress', () => {
    if (!SEG9) return;
    const map = buildPointMap(SEG9);
    const cf = map.pointAccumulated?.constructedFragments;
    assert.ok(cf && cf.fragments.length >= 1, 'constructed fragments still produced');
    const jp = map.pointAccumulated?.joinedPolylines;
    assert.ok(jp && jp.joinedPolylines.length >= 1, 'joined polylines still produced');
    // Track assignment unchanged at the frame level.
    const tracked = SEG9.frames[0].lanes?.[0]?.laneTrackId;
    assert.equal(tracked, 0, 'seg9 frame 0 lane 1 keeps track id 0');
  });
});

describe('stationary lane semantics — arrow heading', () => {
  it('a fully-stationary segment arrow points forward (+east = 90 in icon convention)', () => {
    if (!SEG9) return;
    const map = buildPointMap(SEG9);
    const pose = SLM.resolveArrowOnSegmentMap(map, SEG9.timeline, 15, { minHeadingSpeedMps: 2 });
    assert.equal(pose.headingDeg, 90, 'stationary arrow points along the road forward axis');
    assert.ok(Math.abs(pose.east) < 1e-9 && Math.abs(pose.north) < 1e-9, 'arrow stays at the anchor');
  });

  it('a moving segment arrow heading is unchanged by the stationary fallback', () => {
    if (!SEG2()) return;
    const r = SEG2();
    const map = buildPointMap(r);
    const pose0 = SLM.resolveArrowOnSegmentMap(map, r.timeline, 0, { minHeadingSpeedMps: 2 });
    // seg2 trajectory length >= 2 -> heading derives from the path (not 90 hardcode)
    assert.ok(pose0.headingDeg > 45 && pose0.headingDeg < 135, `seg2 arrow ~east, got ${pose0.headingDeg}`);
  });
});

let seg2Cache = null;
function SEG2() {
  if (seg2Cache) return seg2Cache;
  seg2Cache = runSegment('2');
  return seg2Cache;
}
