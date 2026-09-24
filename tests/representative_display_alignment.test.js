'use strict';

// Focused tests for representative display-frame alignment.
// The combined-placed display frame transforms observation dots
// (placedEast/placedNorth) but the representative station points must carry the
// SAME display coordinate; otherwise the two layers render in different frames
// and the lateral order reverses.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CAD_SRC = fs.readFileSync(path.join(ROOT, 'public/connected_accumulated_display.js'), 'utf8');
function loadCAD() {
  const sb = { console, module: { exports: {} }, exports: {} };
  sb.global = sb; sb.window = sb;
  vm.runInNewContext(CAD_SRC, sb, { filename: 'cad.js' });
  return sb.ConnectedAccumulatedDisplay || sb.module.exports;
}
const CAD = loadCAD();

function buildSegment(seg) {
  const VMB = require(path.join(ROOT, 'lib/viewer_map_build'));
  const SLM = require(path.join(ROOT, 'lib/segment_local_map'));
  const loaded = require(path.join(ROOT, 'lib/qlog_data')).loadSegmentsData(ROOT, [`qlog_f449c_${seg}.bz2`], VMB.VIEWER_DEFAULT_PROCESS_OPTIONS);
  const { processRoute, buildTimeline } = require(path.join(ROOT, 'lib/process_route'));
  const { qualifySegments } = require(path.join(ROOT, 'lib/segment_qualify'));
  const { enrichTimelineWithMovement } = require(path.join(ROOT, 'lib/vehicle_movement_display'));
  const sq = qualifySegments(loaded.audits);
  const r = processRoute(loaded.modelEvents, loaded.gpsEvents, { ...VMB.VIEWER_DEFAULT_PROCESS_OPTIONS, segmentQualifications: sq, fileAudits: loaded.audits });
  const pd = { ...r, timeline: enrichTimelineWithMovement(buildTimeline(r.frames), r.vehiclePath), fileAudits: loaded.audits };
  const map = SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', timelineIndex: 0, fitEnabled: true });
  return map.pointAccumulated.points || [];
}

function withPlacedFrame(pts, lateral) {
  return pts.map((p) => ({ ...p, placedEast: p.localEast, placedNorth: p.localNorth * lateral, coordinateFrame: 'combinedPlaced' }));
}
function orderBy(points, field, gidOf) {
  const by = {};
  for (const p of points) {
    const g = gidOf(p);
    if (!by[g]) by[g] = [];
    by[g].push(p[field]);
  }
  return Object.entries(by).map(([g, a]) => [g, a.reduce((x, y) => x + y, 0) / a.length]).sort((a, b) => a[1] - b[1]).map((x) => x[0]).join('<');
}

test('A1. representative points carry the combined-placed display coordinate', () => {
  const pts = withPlacedFrame(buildSegment(14), -1);
  const pf = CAD.buildPerFrameConnectedPolylines(pts);
  const on = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, { representativeStationSupportCandidate: true });
  let n = 0; let total = 0;
  for (const pl of on.polylines) for (const p of pl.points) { total += 1; if (Number.isFinite(p.placedEast) && Number.isFinite(p.placedNorth)) n += 1; }
  assert.ok(total > 0);
  assert.equal(n, total, 'every representative point carries placed coords');
  assert.equal(on.polylines[0].points[0].coordinateFrame, 'combinedPlaced');
});

test('A2. blue-red-green dot order equals representative order (combined frame)', () => {
  const pts = withPlacedFrame(buildSegment(14), -1);
  const pf = CAD.buildPerFrameConnectedPolylines(pts);
  const on = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, { representativeStationSupportCandidate: true });
  const dotOrder = orderBy(pts, 'placedNorth', (p) => p.groupTrackId);
  const repPoints = on.polylines.flatMap((pl) => pl.points.map((p) => ({ ...p, groupTrackId: pl.groupTrackId })));
  const repOrder = orderBy(repPoints, 'placedNorth', (p) => p.groupTrackId);
  assert.equal(repOrder, dotOrder, 'representative order must match dot order in the same frame');
});

test('A3. outer lanes do not swap while the centre lane stays central', () => {
  const pts = withPlacedFrame(buildSegment(14), -1);
  const pf = CAD.buildPerFrameConnectedPolylines(pts);
  const on = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, { representativeStationSupportCandidate: true });
  const dotOrder = orderBy(pts, 'placedNorth', (p) => p.groupTrackId).split('<');
  const repPoints = on.polylines.flatMap((pl) => pl.points.map((p) => ({ ...p, groupTrackId: pl.groupTrackId })));
  const repOrder = orderBy(repPoints, 'placedNorth', (p) => p.groupTrackId).split('<');
  assert.equal(dotOrder[0], repOrder[0], 'topmost group unchanged');
  assert.equal(dotOrder[dotOrder.length - 1], repOrder[repOrder.length - 1], 'bottommost group unchanged');
});

test('A4. mirror/reflection is a single decision applied to both layers (order preserved under both)', () => {
  const pts = buildSegment(16);
  for (const lateral of [1, -1]) {
    const framed = withPlacedFrame(pts, lateral);
    const pf = CAD.buildPerFrameConnectedPolylines(framed);
    const on = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, { representativeStationSupportCandidate: true });
    const dotOrder = orderBy(framed, 'placedNorth', (p) => p.groupTrackId);
    const repPoints = on.polylines.flatMap((pl) => pl.points.map((p) => ({ ...p, groupTrackId: pl.groupTrackId })));
    const repOrder = orderBy(repPoints, 'placedNorth', (p) => p.groupTrackId);
    assert.equal(repOrder, dotOrder, `order preserved for lateral=${lateral}`);
  }
});

test('A5. representative points lie on their same-identity placed dot band', () => {
  const pts = withPlacedFrame(buildSegment(16), -1);
  const pf = CAD.buildPerFrameConnectedPolylines(pts);
  const on = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, { representativeStationSupportCandidate: true });
  let within = 0; let total = 0;
  for (const pl of on.polylines) {
    for (const p of pl.points) {
      let best = Infinity;
      for (const d of pts) {
        if (d.groupTrackId !== pl.groupTrackId) continue;
        if (Math.abs(d.localNorth - p.localNorth) > 5 && Math.abs(d.localEast - p.localEast) > 5) continue;
        const dd = Math.hypot(d.placedEast - p.placedEast, d.placedNorth - p.placedNorth);
        if (dd < best) best = dd;
      }
      if (best <= 2.0) within += 1;
      total += 1;
    }
  }
  assert.ok(total > 0);
  assert.ok(within / total > 0.95, `>=95% of rep points within 2 m of their placed dot band (${within}/${total})`);
});

test('A6. non-combined map is unchanged (no placed fields -> no behavior change)', () => {
  const pts = buildSegment(12);
  const pf = CAD.buildPerFrameConnectedPolylines(pts);
  const on = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, { representativeStationSupportCandidate: true });
  for (const pl of on.polylines) for (const p of pl.points) assert.ok(!Number.isFinite(p.placedEast));
});

test('A7. Station Support OFF and ON both carry the placed frame', () => {
  const pts = withPlacedFrame(buildSegment(18), -1);
  const pf = CAD.buildPerFrameConnectedPolylines(pts);
  for (const toggle of [false, true]) {
    const r = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, { representativeStationSupportCandidate: toggle });
    for (const pl of r.polylines) for (const p of pl.points) assert.ok(Number.isFinite(p.placedEast) && Number.isFinite(p.placedNorth));
  }
});

test('A8. no input mutation and no non-finite output', () => {
  const pts = withPlacedFrame(buildSegment(16), -1);
  const before = JSON.stringify(pts.map((p) => [p.localEast, p.localNorth, p.placedEast, p.placedNorth]));
  const pf = CAD.buildPerFrameConnectedPolylines(pts);
  const on = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, { representativeStationSupportCandidate: true });
  const after = JSON.stringify(pts.map((p) => [p.localEast, p.localNorth, p.placedEast, p.placedNorth]));
  assert.equal(after, before);
  for (const pl of on.polylines) for (const p of pl.points) assert.ok(Number.isFinite(p.placedEast) && Number.isFinite(p.placedNorth));
});

test('A9. deterministic repeated build with the placed frame', () => {
  const pts = withPlacedFrame(buildSegment(16), -1);
  const pf = CAD.buildPerFrameConnectedPolylines(pts);
  const a = JSON.stringify(CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, { representativeStationSupportCandidate: true }).polylines);
  const b = JSON.stringify(CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, { representativeStationSupportCandidate: true }).polylines);
  assert.equal(a, b);
});

test('A10. groupTrackId / colour identity preserved through the placed frame', () => {
  const pts = withPlacedFrame(buildSegment(14), -1);
  const pf = CAD.buildPerFrameConnectedPolylines(pts);
  const on = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, { representativeStationSupportCandidate: true });
  const ids = new Set(on.polylines.map((p) => p.groupTrackId));
  for (const g of ids) assert.ok(pts.some((p) => p.groupTrackId === g), 'every line identity exists in the dots');
});
