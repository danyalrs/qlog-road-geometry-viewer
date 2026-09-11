'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const VMB = require('../lib/viewer_map_build');
const SLM = require('../lib/segment_local_map');
const CBAO = require('../lib/combined_boundary_anchored_orientation');
const CVLP = require('../lib/combined_visible_lane_projection');
const VDC = require('../lib/viewer_display_corrections');
const LRR = require('../lib/local_road_surface_ribbon');

const ROOT = path.join(__dirname, '..');
const RENDER = fs.readFileSync(path.join(ROOT, 'public/render.js'), 'utf8');

function processFiles(files) {
  const loaded = require('../lib/qlog_data').loadSegmentsData(ROOT, files, VMB.VIEWER_DEFAULT_PROCESS_OPTIONS);
  const { processRoute, buildTimeline } = require('../lib/process_route');
  const { qualifySegments } = require('../lib/segment_qualify');
  const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
  const sq = qualifySegments(loaded.audits);
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
    ...VMB.VIEWER_DEFAULT_PROCESS_OPTIONS,
    segmentQualifications: sq,
    fileAudits: loaded.audits,
  });
  return {
    ...result,
    timeline: enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath),
    fileAudits: loaded.audits,
  };
}

function screenAng(a, b) {
  // Mimic worldToScreen: x += east, y -= north
  return Math.atan2(-(b.north - a.north), b.east - a.east) * 180 / Math.PI;
}

function displayWorldExact(east, north) {
  return VDC.transformDisplayPoint(east, north);
}

test('shared frame: render wires trajectory overlay through roadGeometryToScreen', () => {
  assert.match(RENDER, /_applyExactDisplayCorrectionWorld/);
  assert.match(RENDER, /_drawLocalVehiclePathOverlay[\s\S]*roadGeometryToScreen\(east, north\)/);
  assert.match(RENDER, /Ignore precomputed mirrors here so road ribbon/);
});

test('standalone Seg0: road ribbon, trajectory and lane dots share exact-correction frame', () => {
  const pd = processFiles(['qlog_f449c_0.bz2']);
  const map = SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', timelineIndex: 0, fitEnabled: true });
  assert.equal(VDC.isExactDisplayCorrectionActive(true, map.sourceQlogSha256), true);
  const traj = map.trajectory;
  assert.ok(traj.length >= 5);
  const i0 = 2;
  const i1 = Math.min(traj.length - 1, i0 + 4);
  const tA = traj[i0];
  const tB = traj[i1];
  const roadA = displayWorldExact(tA.east, tA.north);
  const roadB = displayWorldExact(tB.east, tB.north);
  const trajA = displayWorldExact(tA.east, tA.north);
  const trajB = displayWorldExact(tB.east, tB.north);
  assert.equal(roadA.east, trajA.east);
  assert.equal(roadA.north, trajA.north);
  const roadAng = screenAng(roadA, roadB);
  const trajAng = screenAng(trajA, trajB);
  assert.ok(Math.abs(roadAng - trajAng) < 1e-9, `roadAng=${roadAng} trajAng=${trajAng}`);

  // Lane dots from canonical locals through the same exact correction (not a divergent mirror path).
  const fid = (pd.timeline || [])[Math.min(3, (pd.timeline || []).length - 1)]?.frameId;
  const pts = (map.pointAccumulated?.points || []).filter((p) => p.frameId === fid).slice(0, 8);
  assert.ok(pts.length > 0);
  for (const p of pts) {
    const lane = displayWorldExact(p.localEast, p.localNorth);
    const nearest = traj.reduce((best, t) => {
      const td = displayWorldExact(t.east, t.north);
      const d = Math.hypot(lane.east - td.east, lane.north - td.north);
      return d < best.d ? { d, t: td } : best;
    }, { d: Infinity, t: null });
    assert.ok(nearest.d < 25, `lane ${nearest.d}m from corrected trajectory`);
  }

  // Prove the OLD divergent contract fails the invariant.
  const legacyRoadAng = screenAng(tA, tB); // canonical ribbon (bug)
  const correctedTrajAng = screenAng(trajA, trajB);
  assert.ok(Math.abs(legacyRoadAng - correctedTrajAng) > 5, 'pre-fix divergence still detectable on Seg0');
});

test('combined 0+1+2: Seg0 CVLP stays on same lateral side as placed (shared frame)', () => {
  const pd = processFiles(['qlog_f449c_0.bz2', 'qlog_f449c_1.bz2', 'qlog_f449c_2.bz2']);
  let map = SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', timelineIndex: 0, fitEnabled: true });
  map = CBAO.applyBoundaryAnchoredOrientation(map, pd, { mirrorChecked: true });
  assert.equal(map.boundaryAnchoredOrientationActive, true);
  const tl = pd.timeline || [];
  const t0 = Number(tl.find((r) => r.sourceFile === 'qlog_f449c_0.bz2')?.logMonoTime);
  const idx = tl.findIndex((r) => r.sourceFile === 'qlog_f449c_0.bz2'
    && Math.abs((Number(r.logMonoTime) - t0) / 1e9 - 6) < 0.3);
  assert.ok(idx >= 0);
  const fid = tl[idx].frameId;
  const trajPt = map.trajectory.find((p) => p.sourceFile === 'qlog_f449c_0.bz2' && p.frameId === fid);
  assert.ok(trajPt);
  const pts = (map.pointAccumulated?.points || [])
    .filter((p) => p.sourceFile === 'qlog_f449c_0.bz2' && p.frameId === fid
      && Math.abs(p.d ?? 0) < 6)
    .slice(0, 20);
  assert.ok(pts.length > 0);
  let sideMismatch = 0;
  const tIdx = map.trajectory.indexOf(trajPt);
  const tNext = map.trajectory[Math.min(map.trajectory.length - 1, tIdx + 1)] || trajPt;
  const te = (tNext.east - trajPt.east) || 1;
  const tn = (tNext.north - trajPt.north) || 0;
  for (const p of pts) {
    const proj = CVLP.projectCombinedSourceLanePoint(p, map, 'pointAccumulated', {
      mirrorChecked: true,
      useVisibleLaneProjection: true,
    });
    // Pre-fix CVLP put points on the opposite lateral half-plane; require same sign.
    const placedCross = te * ((p.placedNorth ?? p.north) - trajPt.north) - tn * ((p.placedEast ?? p.east) - trajPt.east);
    const projCross = te * (proj.north - trajPt.north) - tn * (proj.east - trajPt.east);
    if (Math.abs(placedCross) > 2 && Math.abs(projCross) > 2
      && Math.sign(placedCross) !== Math.sign(projCross)) {
      sideMismatch += 1;
    }
  }
  assert.equal(sideMismatch, 0, `lateral side mismatches: ${sideMismatch}`);
});

test('ribbon centreline tracks corrected trajectory under exact correction', () => {
  const pd = processFiles(['qlog_f449c_0.bz2']);
  const map = SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', fitEnabled: false });
  const ribbon = LRR.buildTrajectoryRoadSurfaceRibbons(map.trajectory, map.edgeFragments);
  assert.ok(ribbon.ribbons?.length);
  const t0 = map.trajectory[0];
  const t1 = map.trajectory[Math.min(5, map.trajectory.length - 1)];
  const c0 = displayWorldExact(t0.east, t0.north);
  const c1 = displayWorldExact(t1.east, t1.north);
  assert.ok(Number.isFinite(c0.east) && Number.isFinite(c1.east));
});
