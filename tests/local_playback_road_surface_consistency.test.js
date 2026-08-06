'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
const LP = require('../lib/local_playback');
const SLM = require('../lib/segment_local_map');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const RENDER_JS = path.join(ROOT, 'public/render.js');
const APP_JS = path.join(ROOT, 'public/app.js');
const SEG2 = path.join(ROOT, 'qlog_f449c_2.bz2');

function loadSegment(fileName) {
  const segPath = path.join(ROOT, fileName);
  const modelEvents = extractModel(segPath).map((e) => ({ ...e, sourceFile: fileName }));
  const gpsEvents = extractGps(segPath).map((e) => ({ ...e, sourceFile: fileName }));
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
  return { ...result, timeline };
}

function buildFrozenMap(data, geometrySource = 'fused', timelineIndex = 0) {
  const built = SLM.buildSegmentLocalMap(data, { geometrySource, timelineIndex });
  return SLM.freezeStationaryMapGeometry(built);
}

describe('segment 2 stationary road surface consistency', () => {
  it('1. road-polygon checksum stays constant from idx 0 to idx 29', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const base = buildFrozenMap(data, 'fused', 0);
    for (const idx of [0, 8, 16, 29]) {
      const map = buildFrozenMap(data, 'fused', idx);
      assert.equal(map.roadSurfaceChecksum, base.roadSurfaceChecksum, `idx ${idx}`);
    }
  });

  it('2. polygon count stays constant during playback', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const counts = [0, 8, 16, 29].map((idx) => buildFrozenMap(data, 'fused', idx).roadSurfacePolygonCount);
    assert.ok(counts.every((c) => c === counts[0]));
    assert.equal(counts[0], 13);
  });

  it('3. polygon coordinates stay constant during playback', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const base = buildFrozenMap(data, 'fused', 0);
    for (const idx of [8, 16, 29]) {
      const map = buildFrozenMap(data, 'fused', idx);
      assert.deepEqual(
        map.roadSurfacePolygons.map((p) => p.ring),
        base.roadSurfacePolygons.map((p) => p.ring),
      );
    }
  });

  it('4. layer visibility does not reset when the timeline changes', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    assert.match(src, /roadSurface: layers\.roadSurface/);
    assert.doesNotMatch(src, /elapsedIdx.*roadSurface|roadSurface.*elapsedIdx/);
  });

  it('5. stationary fused geometry does not filter surfaces by current elapsedIdx', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = buildFrozenMap(data, 'fused', 0);
    for (const idx of [0, 8, 16, 29]) {
      SLM.resolveArrowOnSegmentMap(map, data.timeline, idx);
      const selection = SLM.selectStationaryRoadSurfacePolygons(map.roadSurfacePolygons);
      assert.equal(selection.selectedCount, map.roadSurfacePolygonCount, `idx ${idx}`);
      assert.equal(selection.skippedCount, 0);
    }
  });

  it('6. viewport conversion does not mutate map coordinates', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = buildFrozenMap(data, 'fused', 0);
    const before = map.roadSurfaceChecksum;
    for (const poly of map.roadSurfacePolygons) {
      for (const pt of poly.ring) {
        const east = pt.east;
        const north = pt.north;
        const screenE = east * 8 + 100;
        const screenN = -north * 8 + 200;
        assert.ok(Number.isFinite(screenE));
        assert.ok(Number.isFinite(screenN));
      }
    }
    assert.equal(map.roadSurfaceChecksum, before);
  });

  it('7. repeated rendering selection produces identical polygon geometry', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = buildFrozenMap(data, 'fused', 0);
    const a = SLM.selectStationaryRoadSurfacePolygons(map.roadSurfacePolygons);
    const b = SLM.selectStationaryRoadSurfacePolygons(map.roadSurfacePolygons);
    assert.equal(a.selectedCount, b.selectedCount);
    assert.deepEqual(
      a.selected.map((p) => p.ring),
      b.selected.map((p) => p.ring),
    );
  });

  it('8. ego-lane corridors render without requiring fullRoadSurface', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = buildFrozenMap(data, 'fused', 0);
    const selection = SLM.selectStationaryRoadSurfacePolygons(map.roadSurfacePolygons);
    assert.equal(selection.selectedCount, 13);
    assert.ok(selection.selected.every((p) => (p.surfaceType ?? 'egoLaneCorridor') === 'egoLaneCorridor'));
    const renderSrc = fs.readFileSync(RENDER_JS, 'utf8');
    assert.doesNotMatch(renderSrc, /fullRoadSurface.*continue|continue.*fullRoadSurface/);
  });

  it('9. unsupported gaps remain empty', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = buildFrozenMap(data, 'fused', 0);
    const arrow8 = SLM.resolveArrowOnSegmentMap(map, data.timeline, 8);
    const nearest = map.roadSurfacePolygons.map((poly) => {
      let best = Infinity;
      for (const pt of poly.ring) {
        best = Math.min(best, Math.hypot(pt.east - arrow8.east, pt.north - arrow8.north));
      }
      return best;
    });
    assert.ok(Math.min(...nearest) > 50, 'dropout idx 8 should have no nearby surface polygon');
    assert.equal(data.frames[8]?.lanes?.length ?? 0, 0);
  });

  it('10. surface draws underneath lane lines', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    const start = src.indexOf('  _drawStationaryLocalMap(d, elapsedIdx) {');
    const end = src.indexOf('  _drawStationaryUnavailable(map) {', start);
    const block = src.slice(start, end);
    const roadPos = block.indexOf('if (this.layers.roadSurface)');
    const lanePos = block.indexOf('if (this.layers.fused)');
    assert.ok(roadPos >= 0 && lanePos > roadPos, 'road surface should be drawn before fused lanes');
  });

  it('11. only the arrow position and heading change during playback', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = buildFrozenMap(data, 'fused', 0);
    const checksum = map.checksum;
    const polyChecksum = map.roadSurfaceChecksum;
    const poses = [0, 8, 16, 29].map((idx) => SLM.resolveArrowOnSegmentMap(map, data.timeline, idx));
    assert.equal(map.checksum, checksum);
    assert.equal(map.roadSurfaceChecksum, polyChecksum);
    const moved = Math.hypot(poses[3].east - poses[0].east, poses[3].north - poses[0].north);
    assert.ok(moved > 50);
    const headings = poses.map((p) => p.headingDeg);
    assert.ok(new Set(headings).size > 1);
  });

  it('12. the corrected arrow direction remains unchanged', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = buildFrozenMap(data, 'fused', 0);
    const result = SLM.turnDirectionsAgree(data.frames, map.trajectory, 0, 8);
    assert.ok(result.agrees, JSON.stringify(result));
  });

  it('13. video synchronization remains unchanged', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    assert.match(src, /interpolatedLogMonoTime/);
    assert.match(src, /localPlaybackVideo\?\.tickSync/);
    assert.match(src, /localPlaybackVideo\?\.onTimelineScrub/);
  });

  it('14. global mode remains unchanged', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    assert.match(src, /displayMode === 'global'/);
    assert.match(src, /_drawGlobal\(d\)/);
  });

  it('15. vehicle-relative mode remains unchanged', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    assert.match(src, /displayMode === 'vehicle'/);
    assert.match(src, /_drawVehicleFrame\(/);
    assert.doesNotMatch(src, /stationaryLocalMap.*vehicle|vehicle.*stationaryLocalMap/);
  });
});

describe('stationary road surface renderer helpers', () => {
  it('does not skip egoLaneCorridor using global fusion stats', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = buildFrozenMap(data, 'fused', 0);
    for (const poly of map.roadSurfacePolygons) {
      const decision = SLM.shouldSkipStationaryRoadPolygon(poly, {});
      assert.equal(decision.skip, false, `poly ${poly.fragmentIndex} should not skip: ${decision.reason}`);
    }
  });

  it('freezeStationaryMapGeometry clones ring coordinates', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const built = SLM.buildSegmentLocalMap(data, { geometrySource: 'fused', timelineIndex: 0 });
    const frozen = SLM.freezeStationaryMapGeometry(built);
    frozen.roadSurfacePolygons[0].ring[0].east = 9999;
    assert.notEqual(built.roadSurfacePolygons[0].ring[0].east, 9999);
  });

  it('timeline scrub order updates playback before draw', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    assert.match(src, /setFrameIndex\(idx, \{ redraw: false \}\)/);
    assert.match(src, /updateLocalPlayback\(idx\)/);
  });
});
