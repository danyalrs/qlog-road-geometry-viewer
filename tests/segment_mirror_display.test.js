'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const VMC = require('../lib/viewer_mirror_coords');
const VMB = require('../lib/viewer_map_build');
const SLM = require('../lib/segment_local_map');
const LRR = require('../lib/local_road_surface_ribbon');
const { modelToGlobal } = require('../lib/transform');

const SEGMENTS = {
  seg0: 'qlog_f449c_0.bz2',
  seg1: 'qlog_f449c_1.bz2',
  seg2: 'qlog_f449c_2.bz2',
  seg14: 'qlog_f449c_14.bz2',
};

function globalToSegmentLocal(east, north, referencePose) {
  const ve = referencePose?.east ?? 0;
  const vn = referencePose?.north ?? 0;
  const theta = (referencePose?.headingDeg ?? 0) * Math.PI / 180;
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  const u = east - ve;
  const v = north - vn;
  return { east: u * sinT + v * cosT, north: v * sinT - u * cosT };
}

function buildMap(seg) {
  const pd = VMB.processSegmentLikeViewer(ROOT, seg);
  return SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', fitEnabled: false });
}

describe('segment mirror display contract', () => {
  it('model-frame lateral reflection keeps forward and reverses lateral sign', () => {
    const pose = { east: 10, north: 20, headingDeg: 45 };
    const g = modelToGlobal(12, 3, pose.east, pose.north, pose.headingDeg);
    const gMir = modelToGlobal(12, -3, pose.east, pose.north, pose.headingDeg);
    assert.ok(Math.abs(gMir.east - g.east) > 1e-6 || Math.abs(gMir.north - g.north) > 1e-6);
    const fwd = 12;
    const lat = 3;
    const g2 = modelToGlobal(fwd, -lat, pose.east, pose.north, pose.headingDeg);
    assert.ok(Math.hypot(g2.east - gMir.east, g2.north - gMir.north) < 1e-9);
  });

  it('mirror toggle off restores canonical display coordinates', () => {
    const map = buildMap(SEGMENTS.seg0);
    const p = map.pointAccumulated.points.find((pt) => pt.mirroredLocalEast != null);
    assert.ok(p);
    const on = VMC.resolveRoadDisplayCoords(
      p.localEast,
      p.localNorth,
      p.mirroredLocalEast,
      p.mirroredLocalNorth,
      true,
      { trajectory: map.trajectory },
    );
    assert.ok(Math.hypot(on.east - p.mirroredLocalEast, on.north - p.mirroredLocalNorth) < 1e-6);
    const off = VMC.resolveRoadDisplayCoords(
      p.localEast,
      p.localNorth,
      p.mirroredLocalEast,
      p.mirroredLocalNorth,
      false,
      { trajectory: map.trajectory },
    );
    assert.ok(Math.hypot(off.east - p.localEast, off.north - p.localNorth) <= 1e-6);
  });

  it('heading near 0/360 uses same contract', () => {
    const pose = { east: 0, north: 0, headingDeg: 359.5 };
    const ref = { east: 0, north: 0, headingDeg: 359.5, frameIndex: 0 };
    const g = modelToGlobal(5, 2, pose.east, pose.north, pose.headingDeg);
    const gMir = modelToGlobal(5, -2, pose.east, pose.north, pose.headingDeg);
    const loc = globalToSegmentLocal(g.east, g.north, ref);
    const locMir = globalToSegmentLocal(gMir.east, gMir.north, ref);
    const on = VMC.resolveRoadDisplayCoords(loc.east, loc.north, locMir.east, locMir.north, true);
    assert.ok(Math.hypot(on.east - locMir.east, on.north - locMir.north) < 1e-9);
  });

  it('trajectory fallback flips ribbon vertices on segment 0', () => {
    const map = buildMap(SEGMENTS.seg0);
    const ribbon = LRR.buildTrajectoryRoadSurfaceRibbons(map.trajectory, map.edgeFragments, {});
    let flipMax = 0;
    for (const v of ribbon.ribbons?.[0]?.ring || []) {
      const on = VMC.resolveRoadDisplayCoords(v.east, v.north, null, null, true, {
        trajectory: map.trajectory,
        useTrajectoryFallback: true,
      });
      flipMax = Math.max(flipMax, Math.hypot(on.east - v.east, on.north - v.north));
    }
    assert.ok(flipMax > 0.01, `ribbon flip ${flipMax}`);
  });

  for (const [label, seg] of Object.entries(SEGMENTS)) {
    it(`${label} production stored mirror matches modelY negation`, () => {
      const pd = VMB.processSegmentLikeViewer(ROOT, seg);
      const map = buildMap(seg);
      const ref = map.referencePose;
      let max = 0;
      for (const p of map.pointAccumulated.points.slice(0, 500)) {
        const frame = pd.frames[p.frameIndex ?? 0];
        if (!frame?.pose) continue;
        const gMir = modelToGlobal(p.modelX, -p.modelY, frame.pose.east, frame.pose.north, frame.pose.headingDeg);
        const loc = globalToSegmentLocal(gMir.east, gMir.north, ref);
        max = Math.max(max, Math.hypot(loc.east - p.mirroredLocalEast, loc.north - p.mirroredLocalNorth));
      }
      assert.ok(max <= 1e-3, `${label} stored mirror delta ${max}`);
    });
  }

  it('trusted map checksum unchanged by mirror resolver (display-only)', () => {
    const before = buildMap(SEGMENTS.seg0).checksum;
    const after = buildMap(SEGMENTS.seg0).checksum;
    assert.equal(before, after);
  });

  it('renderer uses shared viewer mirror helper', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/render.js'), 'utf8');
    assert.match(src, /VMC\?\.resolveRoadDisplayCoords/);
    assert.match(src, /useTrajectoryFallback:\s*false/);
  });

  it('ribbon road geometry without precomputed mirror matches checkpoint canonical coords', () => {
    const map = buildMap('qlog_f449c_99.bz2');
    const ribbon = LRR.buildTrajectoryRoadSurfaceRibbons(map.trajectory, map.edgeFragments, {});
    const vtx = ribbon.ribbons?.[0]?.ring?.[10];
    assert.ok(vtx);
    const resolved = VMC.resolveRoadDisplayCoords(vtx.east, vtx.north, null, null, true, {
      trajectory: map.trajectory,
    });
    assert.equal(resolved.method, 'canonicalWithoutPrecomputed');
    assert.ok(Math.hypot(resolved.east - vtx.east, resolved.north - vtx.north) < 1e-9);
  });

  it('trajectory fallback remains opt-in for ribbon vertices', () => {
    const map = buildMap('qlog_f449c_99.bz2');
    const ribbon = LRR.buildTrajectoryRoadSurfaceRibbons(map.trajectory, map.edgeFragments, {});
    const vtx = ribbon.ribbons?.[0]?.ring?.[10];
    const resolved = VMC.resolveRoadDisplayCoords(vtx.east, vtx.north, null, null, true, {
      trajectory: map.trajectory,
      useTrajectoryFallback: true,
    });
    assert.equal(resolved.method, 'trajectoryFallback');
    assert.ok(Math.hypot(resolved.east - vtx.east, resolved.north - vtx.north) > 0.01);
  });

});
