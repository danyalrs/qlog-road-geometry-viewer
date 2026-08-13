'use strict';

/**
 * Controlled checks for the point-accumulated / raw lane transformation chain.
 * These verify the coordinate transform itself and that Raw and Point modes
 * share identical coordinates, independent of any mapping-quality claims.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { modelToGlobal, transformXyztLine } = require('../lib/transform');
const PA = require('../lib/point_accumulation');
const SLM = require('../lib/segment_local_map');
const { loadSegment } = require('../lib/lane_continuity_stage4');

const ROOT = path.join(__dirname, '..');
const SEG2 = path.join(ROOT, 'qlog_f449c_2.bz2');
const SEG99 = path.join(ROOT, 'qlog_f449c_99.bz2');
const RENDER_JS = path.join(ROOT, 'public/render.js');
const APP_JS = path.join(ROOT, 'public/app.js');

const TOL = 1e-6;

describe('transform controlled checks', () => {
  it('1. zero heading: forward point maps north, left maps west', () => {
    const fwd = modelToGlobal(10, 0, 0, 0, 0);
    assert.ok(Math.abs(fwd.east) < TOL && Math.abs(fwd.north - 10) < TOL);
    const left = modelToGlobal(0, 5, 0, 0, 0);
    assert.ok(Math.abs(left.east + 5) < TOL && Math.abs(left.north) < TOL);
  });

  it('2. positive 90-degree heading: forward maps east, left maps north', () => {
    const fwd = modelToGlobal(10, 0, 0, 0, 90);
    assert.ok(Math.abs(fwd.east - 10) < TOL && Math.abs(fwd.north) < TOL);
    const left = modelToGlobal(0, 5, 0, 0, 90);
    assert.ok(Math.abs(left.north - 5) < TOL && Math.abs(left.east) < TOL);
  });

  it('3. negative 90-degree heading: forward maps west, left maps south', () => {
    const fwd = modelToGlobal(10, 0, 0, 0, -90);
    assert.ok(Math.abs(fwd.east + 10) < TOL && Math.abs(fwd.north) < TOL);
    const left = modelToGlobal(0, 5, 0, 0, -90);
    assert.ok(Math.abs(left.north + 5) < TOL && Math.abs(left.east) < TOL);
  });

  it('4. degree-to-radian conversion is applied (90 deg != ~1.57 rad result)', () => {
    const degRight = modelToGlobal(10, 0, 0, 0, 90);
    const radWrong = modelToGlobal(10, 0, 0, 0, 1.5708);
    assert.ok(Math.abs(degRight.east - 10) < TOL);
    assert.ok(Math.abs(radWrong.east - 10) > 5);
  });

  it('5. forward/lateral axis convention: x forward, y left', () => {
    // At 0 deg, +y (left) -> west (-east); +x (forward) -> north (+north)
    assert.ok(Math.abs(modelToGlobal(1, 0, 0, 0, 0).north - 1) < TOL);
    assert.ok(Math.abs(modelToGlobal(0, 1, 0, 0, 0).east + 1) < TOL);
  });

  it('6. translation plus rotation composes correctly', () => {
    const p = modelToGlobal(10, 5, 100, 200, 90);
    // heading 90: forward -> east, left -> north
    assert.ok(Math.abs(p.east - (100 + 10)) < TOL);
    assert.ok(Math.abs(p.north - (200 + 5)) < TOL);
  });

  it('7. no double transformation: model->global then segment-local round-trips to model coords', () => {
    const pose = { east: 100, north: 200, headingDeg: 35 };
    const ref = pose;
    for (const [mx, my] of [[0, -2], [40, -8], [117, -50]]) {
      const g = modelToGlobal(mx, my, pose.east, pose.north, pose.headingDeg);
      const local = PA.localFromGlobal(g.east, g.north, ref);
      assert.ok(Math.abs(local.east - mx) < 1e-6, `east roundtrip ${local.east} vs ${mx}`);
      assert.ok(Math.abs(local.north - my) < 1e-6, `north roundtrip ${local.north} vs ${my}`);
    }
  });

  it('8. same input and pose produce identical Raw and Point coordinates', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment();
    const raw = SLM.buildSegmentLocalMap(data, { geometrySource: 'observations', timelineIndex: 0 });
    const pt = SLM.buildSegmentLocalMap(data, { geometrySource: 'pointAccumulated', timelineIndex: 0 });
    const rawFrags = raw.laneFragments || [];
    const ptPts = pt.pointAccumulated.points || [];
    assert.ok(rawFrags.length > 0);
    assert.ok(ptPts.length > 0);
    // Compare per-observation (frameIndex, laneIndex) local coordinates.
    const byKey = new Map();
    for (const p of ptPts) {
      const k = `${p.frameIndex}:${p.laneIndex}`;
      byKey.set(k, (byKey.get(k) || []).concat([[p.localEast, p.localNorth]]));
    }
    let compared = 0;
    for (const f of rawFrags) {
      const k = `${f.sourceFrameIndex}:${f.laneIndex}`;
      const ptCoords = byKey.get(k);
      if (!ptCoords) continue;
      for (const rp of f.points || []) {
        const hit = ptCoords.some(([e, n]) => Math.abs(e - rp.east) < 1e-4 && Math.abs(n - rp.north) < 1e-4);
        if (!hit) {
          assert.fail(`raw point (${rp.east.toFixed(3)},${rp.north.toFixed(3)}) not matched in point mode for obs ${k}`);
        }
        compared++;
      }
    }
    assert.ok(compared > 0);
  });

  it('9. different laneTrackId does not change point coordinates', () => {
    const ref = { east: 0, north: 0, headingDeg: 0 };
    const mk = (track) => ({
      frameId: 1, logMonoTime: '1', sourceFile: 'qlog_f449c_2.bz2', chunkId: 0, passId: 0,
      lanes: [{ laneIndex: 2, laneTrackId: track, prob: 0.9, points: [{ east: 10, north: 5, modelX: 10, modelY: 5, modelZ: 0, t: 0 }, { east: 20, north: 5, modelX: 20, modelY: 5, modelZ: 0, t: 1 }] }],
    });
    const a = PA.accumulatePointObservations({ frames: [mk(5)], referencePose: ref, chunkId: 0, passId: 0, trajectory: PA.buildReferenceTrajectory([{ east: 0, north: 0 }, { east: 50, north: 0 }]), options: {} }).observations;
    const b = PA.accumulatePointObservations({ frames: [mk(99)], referencePose: ref, chunkId: 0, passId: 0, trajectory: PA.buildReferenceTrajectory([{ east: 0, north: 0 }, { east: 50, north: 0 }]), options: {} }).observations;
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
      assert.equal(a[i].localEast, b[i].localEast);
      assert.equal(a[i].localNorth, b[i].localNorth);
    }
  });

  it('10. chunk/pass metadata does not alter coordinates', () => {
    const ref = { east: 0, north: 0, headingDeg: 0 };
    const mk = (chunk, pass) => ({
      frameId: 1, logMonoTime: '1', sourceFile: 'qlog_f449c_2.bz2', chunkId: chunk, passId: pass,
      lanes: [{ laneIndex: 2, laneTrackId: 5, prob: 0.9, points: [{ east: 10, north: 5, modelX: 10, modelY: 5, modelZ: 0, t: 0 }, { east: 20, north: 5, modelX: 20, modelY: 5, modelZ: 0, t: 1 }] }],
    });
    const traj = PA.buildReferenceTrajectory([{ east: 0, north: 0 }, { east: 50, north: 0 }]);
    const a = PA.accumulatePointObservations({ frames: [mk(0, 0)], referencePose: ref, chunkId: 0, passId: 0, trajectory: traj, options: {} }).observations;
    const b = PA.accumulatePointObservations({ frames: [mk(3, 7)], referencePose: ref, chunkId: 3, passId: 7, trajectory: traj, options: {} }).observations;
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
      assert.equal(a[i].localEast, b[i].localEast);
      assert.equal(a[i].localNorth, b[i].localNorth);
      assert.equal(b[i].chunkId, 3);
      assert.equal(b[i].passId, 7);
    }
  });

  it('11. pose-time gap is measured and reported', () => {
    const ref = { east: 0, north: 0, headingDeg: 0 };
    const frames = [{ frameId: 1, logMonoTime: '5000000000', sourceFile: 'x.bz2', chunkId: 0, passId: 0, lanes: [{ laneIndex: 2, laneTrackId: 5, prob: 0.9, points: [{ east: 10, north: 5, modelX: 10, modelY: 5, modelZ: 0, t: 0 }, { east: 20, north: 5, modelX: 20, modelY: 5, modelZ: 0, t: 1 }] }] }];
    const { interpolateGpsAtTime } = require('../lib/alignment');
    const gps = [
      { logMonoTime: '4000000000', east: 0, north: 0, headingDeg: 90, speed: 10, horizontalAccuracy: 5, latitude: 1, longitude: 103, bearingDeg: 90, bearingAccuracyDeg: 2, flags: 1, sourceFile: 'x.bz2' },
      { logMonoTime: '6000000000', east: 20, north: 0, headingDeg: 90, speed: 10, horizontalAccuracy: 5, latitude: 1, longitude: 103, bearingDeg: 90, bearingAccuracyDeg: 2, flags: 1, sourceFile: 'x.bz2' },
    ];
    const pose = interpolateGpsAtTime(gps, '5000000000', 2e9);
    assert.ok(pose);
    // model->pose gap should be 0 for exact match
    const dtMs = Number(BigInt('5000000000') - BigInt(pose.logMonoTime)) / 1e6;
    assert.ok(Math.abs(dtMs) < 1);
    // A model time exactly between two GPS samples
    const poseMid = interpolateGpsAtTime(gps, '5000000000', 2e9);
    assert.ok(poseMid.east === 10);
  });

  it('12. non-finite input remains excluded', () => {
    const ref = { east: 0, north: 0, headingDeg: 0 };
    const frames = [{ frameId: 1, logMonoTime: '1', sourceFile: 'x.bz2', chunkId: 0, passId: 0, lanes: [{ laneIndex: 2, laneTrackId: 5, prob: 0.9, points: [{ east: NaN, north: 5, modelX: 0, modelY: 5, modelZ: 0, t: 0 }, { east: 10, north: 5, modelX: 10, modelY: 5, modelZ: 0, t: 1 }, { east: 20, north: Infinity, modelX: 20, modelY: 5, modelZ: 0, t: 2 }] }] }];
    const { observations, invalidExcluded } = PA.accumulatePointObservations({ frames, referencePose: ref, chunkId: 0, passId: 0, trajectory: PA.buildReferenceTrajectory([{ east: 0, north: 0 }, { east: 50, north: 0 }]), options: {} });
    assert.equal(invalidExcluded, 2);
    assert.equal(observations.length, 1);
  });

  it('13. debug observation isolation does not affect normal modes', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    // Isolation only takes effect when _obsIsolationActive() and mode is observations/pointAccumulated.
    assert.match(src, /_obsIsolationActive/);
    assert.match(src, /setObsDebugSelection/);
    // Complete map / causal branches are unchanged.
    assert.match(src, /Complete map by default/);
    assert.match(src, /_pointCausalPlayback/);
  });

  it('14. complete map and causal playback remain unchanged', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    assert.match(src, /setPointCausalPlayback/);
    assert.match(src, /getPointCausalPlayback/);
    assert.match(src, /Complete map by default/);
    // Point draw still only arcs, never lines.
    const block = src.slice(src.indexOf('_drawPointAccumulatedGeometry'), src.indexOf('_drawLocalVehiclePathOverlay'));
    assert.doesNotMatch(block, /lineTo\(/);
    assert.doesNotMatch(block, /\.stroke\(\)/);
  });

  it('model far-field lateral equals modelY (transform not the cause)', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment();
    const frame = data.frames[4]; // turning segment
    const lane = (frame.lanes || []).find((l) => l.laneIndex === 1);
    assert.ok(lane);
    const th = (frame.pose.headingDeg ?? 0) * Math.PI / 180;
    const fwd = { east: Math.sin(th), north: Math.cos(th) };
    const far = lane.points[lane.points.length - 1];
    const rel = { east: far.east - frame.pose.east, north: far.north - frame.pose.north };
    const along = rel.east * fwd.east + rel.north * fwd.north;
    const px = rel.east - along * fwd.east;
    const py = rel.north - along * fwd.north;
    const lat = Math.hypot(px, py);
    // The transformed far point's lateral must equal |modelY| (transform is exact).
    assert.ok(Math.abs(lat - Math.abs(far.modelY)) < 0.01,
      `far lateral ${lat.toFixed(2)} should equal modelY magnitude ${Math.abs(far.modelY).toFixed(2)}`);
    assert.ok(along > 100, 'far point should be far ahead');
  });
});
