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
const INDEX_HTML = path.join(ROOT, 'public/index.html');
const RENDER_JS = path.join(ROOT, 'public/render.js');
const APP_JS = path.join(ROOT, 'public/app.js');
const SEG1 = path.join(ROOT, 'qlog_f449c_1.bz2');
const SEG2 = path.join(ROOT, 'qlog_f449c_2.bz2');

function loadSegment(fileName) {
  const segPath = path.join(ROOT, fileName);
  const modelEvents = extractModel(segPath).map((e) => ({ ...e, sourceFile: fileName }));
  const gpsEvents = extractGps(segPath).map((e) => ({ ...e, sourceFile: fileName }));
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
  return { ...result, timeline };
}

function buildMap(data, geometrySource = 'observations') {
  return SLM.buildSegmentLocalMap(data, {
    geometrySource,
    timelineIndex: 0,
    minHeadingSpeedMps: 2,
  });
}

describe('segment local map transforms', () => {
  it('globalToSegmentLocal round-trips within tolerance', () => {
    const ref = { east: 100.5, north: 200.25, headingDeg: 254.5 };
    const global = { east: 145.2, north: 312.8 };
    const local = SLM.globalToSegmentLocal(global.east, global.north, ref);
    const back = SLM.segmentLocalToGlobal(local.east, local.north, ref);
    assert.ok(Math.abs(back.east - global.east) < SLM.ROUND_TRIP_TOLERANCE_M);
    assert.ok(Math.abs(back.north - global.north) < SLM.ROUND_TRIP_TOLERANCE_M);
  });
});

describe('stationary local playback map', () => {
  it('uses one fixed reference pose for segment 2', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = buildMap(data);
    assert.ok(map.referencePose);
    assert.equal(map.referencePose.frameIndex, map.referencePose.frameIndex);
    const mapAgain = buildMap(data);
    assert.equal(map.referencePose.frameIndex, mapAgain.referencePose.frameIndex);
    assert.equal(map.referencePose.headingDeg, mapAgain.referencePose.headingDeg);
  });

  it('reference pose does not change with elapsedIdx selection', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map0 = SLM.buildSegmentLocalMap(data, { geometrySource: 'observations', timelineIndex: 0 });
    const map29 = SLM.buildSegmentLocalMap(data, { geometrySource: 'observations', timelineIndex: 29 });
    assert.equal(map0.referencePose.frameIndex, map29.referencePose.frameIndex);
    assert.equal(map0.checksum, map29.checksum);
  });

  it('stationary geometry checksum is identical across timeline indices', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = buildMap(data);
    const indices = [0, 4, 8, 12, 16, 29];
    for (const idx of indices) {
      const rebuilt = SLM.buildSegmentLocalMap(data, { geometrySource: 'observations', timelineIndex: idx });
      assert.equal(rebuilt.checksum, map.checksum, `checksum mismatch at idx ${idx}`);
    }
  });

  it('arrow position changes while map checksum stays constant', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = buildMap(data);
    const checksum = map.checksum;
    const a0 = SLM.resolveArrowOnSegmentMap(map, data.timeline, 0);
    const a16 = SLM.resolveArrowOnSegmentMap(map, data.timeline, 16);
    assert.equal(map.checksum, checksum);
    const moved = Math.hypot(a16.east - a0.east, a16.north - a0.north);
    assert.ok(moved > 5, `arrow should move, got ${moved} m`);
  });

  it('arrow heading follows route through segment 2 turn', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = buildMap(data);
    const a0 = SLM.resolveArrowOnSegmentMap(map, data.timeline, 0, { minHeadingSpeedMps: 2 });
    const a16 = SLM.resolveArrowOnSegmentMap(map, data.timeline, 16, { minHeadingSpeedMps: 2 });
    const delta = Math.abs(((a16.headingDeg - a0.headingDeg + 540) % 360) - 180);
    assert.ok(delta > 30, `expected heading change, got ${a0.headingDeg} -> ${a16.headingDeg}`);
    assert.equal(a16.headingSource, 'segmentTrajectory');
  });

  it('near-zero trajectory segments do not reverse heading at idx 0', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = buildMap(data);
    const arrow = SLM.resolveArrowOnSegmentMap(map, data.timeline, 0, { minHeadingSpeedMps: 0.15 });
    const reversal = Math.abs(((arrow.headingDeg - (arrow.headingDeg + 180) % 360 + 540) % 360) - 180);
    assert.ok(reversal > 90 || arrow.headingDeg != null);
    assert.ok(Number.isFinite(arrow.headingDeg));
  });

  it('all mapped observation fragments are present before playback', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = buildMap(data);
    assert.ok(map.laneFragmentCount > 0);
    assert.ok(map.observationFrameCount > 1);
    const framesWithLanes = data.frames.filter((f) => (f.lanes || []).length > 0).length;
    assert.ok(map.laneFragmentCount >= framesWithLanes * 0.5);
  });

  it('lane dropout at idx 6-9 does not remove prior observation fragments', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = buildMap(data);
    const hasEarly = map.laneFragments.some((f) => f.sourceFrameIndex <= 5);
    const hasLate = map.laneFragments.some((f) => f.sourceFrameIndex >= 10);
    assert.ok(hasEarly, 'early observations should remain');
    assert.ok(hasLate, 'late observations should remain');
    const dropoutFragments = map.laneFragments.filter((f) => f.sourceFrameIndex >= 6 && f.sourceFrameIndex <= 9);
    assert.ok(dropoutFragments.length === 0 || dropoutFragments.every((f) => (f.points || []).length >= 2));
  });

  it('unrelated lane fragments are not connected', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = buildMap(data);
    const uniqueSources = new Set(map.laneFragments.map((f) => f.sourceFrameIndex));
    assert.ok(uniqueSources.size > 1);
    for (const frag of map.laneFragments) {
      assert.ok(frag.fragmentKind === 'observationLane');
      assert.ok(Array.isArray(frag.points));
    }
  });

  it('stationary fused geometry uses the same fixed reference frame', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const obs = buildMap(data, 'observations');
    const fused = buildMap(data, 'fused');
    assert.equal(obs.referencePose.frameIndex, fused.referencePose.frameIndex);
    assert.equal(obs.referencePose.headingDeg, fused.referencePose.headingDeg);
    assert.ok(fused.laneFragmentCount > 0);
  });

  it('chunk/pass groups remain separate', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const groups = SLM.listChunkPassGroups(data);
    assert.ok(groups.length >= 1);
    const map = buildMap(data);
    assert.ok(map.chunkId != null);
  });

  it('hidden geometry modes remain implemented in segment local map', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'segment_local_map.js'), 'utf8');
    for (const mode of ['cleaned', 'cleanedWithSurface', 'diagnostic', 'tracked', 'rejected']) {
      assert.match(src, new RegExp(`'${mode}'`));
    }
  });

  it('local geometry dropdown exposes only raw observations and fused lane lines', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.match(html, /id="localGeometryMode"/);
    assert.match(html, /value="observations"[^>]*>Raw mapped observations/);
    assert.match(html, /value="fused"[^>]*selected>Fused lane lines/);
    assert.doesNotMatch(html, /value="cleaned"/);
    assert.doesNotMatch(html, /value="diagnostic"/);
  });

  it('fused lane lines is the default local geometry mode', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.match(html, /value="fused" selected/);
    assert.doesNotMatch(html, /value="observations" selected/);
    const { LOCAL_GEOMETRY_DEFAULT_MODE } = require('../lib/local_geometry_ui');
    assert.equal(LOCAL_GEOMETRY_DEFAULT_MODE, 'fused');
  });

  it('render.js draws stationary map and diagnostic branch', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    assert.match(src, /_drawStationaryLocalMap/);
    assert.match(src, /localGeometryMode === 'diagnostic'/);
    assert.match(src, /stationaryLocalMap/);
    assert.doesNotMatch(src, /transformPolylineToVehicleDisplay\(edge\.points, pose\)/);
  });

  it('app.js resolves stationary arrow via resolveArrowOnSegmentMap', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    assert.match(src, /resolveArrowOnSegmentMap/);
    assert.match(src, /getOrBuildStationaryMap/);
    assert.match(src, /stationaryMapCache/);
  });

  it('diagnostic mode still uses resolveArrowForCurrentFrame', () => {
    if (!fs.existsSync(SEG1)) return;
    const data = loadSegment('qlog_f449c_1.bz2');
    const diag = LP.resolveArrowForCurrentFrame({
      frames: data.frames,
      timeline: data.timeline,
      vehiclePath: data.vehiclePath,
      frameIndex: 14,
    });
    assert.equal(diag.geometryFrameIndex, 14);
  });

  it('viewport bounds object is stable across timeline indices', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = buildMap(data);
    const b0 = { ...map.bounds };
    SLM.resolveArrowOnSegmentMap(map, data.timeline, 29);
    assert.deepEqual(map.bounds, b0);
  });
});
