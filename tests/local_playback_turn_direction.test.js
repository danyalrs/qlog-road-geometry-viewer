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
const SEG2 = path.join(ROOT, 'qlog_f449c_2.bz2');
const RENDER_JS = path.join(ROOT, 'public/render.js');
const APP_JS = path.join(ROOT, 'public/app.js');

function loadSegment(fileName) {
  const segPath = path.join(ROOT, fileName);
  const modelEvents = extractModel(segPath).map((e) => ({ ...e, sourceFile: fileName }));
  const gpsEvents = extractGps(segPath).map((e) => ({ ...e, sourceFile: fileName }));
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
  return { ...result, timeline };
}

function buildSyntheticArcFrames({ heading0 = 0, turnDeg = 90, steps = 12, stepM = 8 } = {}) {
  const frames = [];
  const timeline = [];
  const refEast = 100;
  const refNorth = 200;
  const radius = (Math.abs(turnDeg) * Math.PI / 180) > 0
    ? (steps * stepM) / (Math.abs(turnDeg) * Math.PI / 180)
    : steps * stepM;
  let east = refEast;
  let north = refNorth;
  let heading = heading0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    heading = heading0 + turnDeg * t;
    const theta = heading * Math.PI / 180;
    if (i > 0) {
      const arcStep = stepM;
      east += arcStep * Math.sin(theta);
      north += arcStep * Math.cos(theta);
    }
    const logMonoTime = String(1_000_000_000n + BigInt(i * 100_000_000));
    frames.push({
      chunkId: 0,
      passId: 0,
      frameId: 1000 + i,
      logMonoTime,
      pose: { east, north, headingDeg: heading, speed: 10 },
      lanes: [],
      edges: [],
    });
    timeline.push({ chunkId: 0, logMonoTime, frameId: 1000 + i, speed: 10, movementState: 'moving' });
  }
  return {
    frames,
    timeline,
    routeChunks: [{ chunkId: 0, roadSurfacePolygons: [], fusedLaneLines: [], fusedRoadEdges: [] }],
    referencePose: { east: refEast, north: refNorth, headingDeg: heading0 },
    radius,
  };
}

describe('segment-local turn direction', () => {
  it('left is positive segment-local north relative to forward', () => {
    const ref = { east: 0, north: 0, headingDeg: 0 };
    const left = SLM.globalToSegmentLocal(-1, 5, ref);
    assert.ok(left.north > 0, `expected left to be +north, got ${left.north}`);
    assert.ok(left.east > 0, `expected forward component, got ${left.east}`);
  });

  it('synthetic left turn renders as left-curving trajectory', () => {
    const synth = buildSyntheticArcFrames({ heading0: 0, turnDeg: -90, steps: 16, stepM: 6 });
    const map = SLM.buildSegmentLocalMap(synth, { geometrySource: 'observations', timelineIndex: 0 });
    const cross = SLM.signedTrajectoryTurnCross(map.trajectory, 2, 14);
    assert.ok(cross > 0, `expected left-turn cross > 0, got ${cross}`);
  });

  it('synthetic right turn renders as right-curving trajectory', () => {
    const synth = buildSyntheticArcFrames({ heading0: 0, turnDeg: 90, steps: 16, stepM: 6 });
    const map = SLM.buildSegmentLocalMap(synth, { geometrySource: 'observations', timelineIndex: 0 });
    const cross = SLM.signedTrajectoryTurnCross(map.trajectory, 2, 14);
    assert.ok(cross < 0, `expected right-turn cross < 0, got ${cross}`);
  });

  it('segment 2 left turn agrees between GPS heading and trajectory', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'observations', timelineIndex: 0 });
    const check = SLM.turnDirectionsAgree(data.frames, map.trajectory, 4, 8);
    assert.equal(check.agrees, true, JSON.stringify(check));
    assert.ok(check.gpsDelta < -30, `expected left GPS delta, got ${check.gpsDelta}`);
    assert.ok(check.cross > 0, `expected left trajectory cross, got ${check.cross}`);
  });

  it('arrow position stays on segment trajectory', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'observations', timelineIndex: 0 });
    for (const idx of [0, 8, 16, 29]) {
      const arrow = SLM.resolveArrowOnSegmentMap(map, data.timeline, idx);
      const nearest = LP.nearestPointOnPolyline(map.trajectory, arrow.east, arrow.north);
      assert.ok(nearest, `missing nearest trajectory point at idx ${idx}`);
      assert.ok(nearest.distance < 2, `arrow off trajectory at idx ${idx}: ${nearest.distance} m`);
    }
  });

  it('arrow heading follows trajectory tangent', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'observations', timelineIndex: 0 });
    for (const idx of [4, 8, 16, 24]) {
      const arrow = SLM.resolveArrowOnSegmentMap(map, data.timeline, idx);
      const a = map.trajectory[arrow.bracketA ?? 0];
      const b = map.trajectory[arrow.bracketB ?? 1];
      if (!a || !b) continue;
      const expected = LP.headingDegForVehicleIcon(b.east - a.east, b.north - a.north);
      const delta = Math.abs(((arrow.headingDeg - expected + 540) % 360) - 180);
      assert.ok(delta < 5, `heading mismatch at idx ${idx}: arrow=${arrow.headingDeg} expected≈${expected}`);
    }
  });

  it('stationary geometry checksum remains fixed during playback', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'fused', timelineIndex: 0 });
    const checksum = map.checksum;
    for (const idx of [0, 8, 16, 29]) {
      SLM.resolveArrowOnSegmentMap(map, data.timeline, idx);
      const rebuilt = SLM.buildSegmentLocalMap(data, { geometrySource: 'fused', timelineIndex: idx });
      assert.equal(rebuilt.checksum, checksum, `checksum changed at idx ${idx}`);
    }
  });

  it('road surface polygons reach stationary map in fused mode', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const obs = SLM.buildSegmentLocalMap(data, { geometrySource: 'observations', timelineIndex: 0 });
    const fused = SLM.buildSegmentLocalMap(data, { geometrySource: 'fused', timelineIndex: 0 });
    assert.ok(obs.roadSurfacePolygonCount > 0, 'observations mode should include ego-lane surface');
    assert.ok(fused.roadSurfacePolygonCount > 0, 'fused mode should include ego-lane surface');
    assert.equal(obs.roadSurfacePolygonCount, fused.roadSurfacePolygonCount);
    for (const poly of fused.roadSurfacePolygons) {
      assert.equal(poly.surfaceType ?? 'egoLaneCorridor', 'egoLaneCorridor');
      assert.ok(poly.ring?.length >= 3);
    }
  });

  it('local renderer draws stationary road surface for egoLaneCorridor', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    assert.match(src, /map\.roadSurfacePolygons/);
    assert.match(src, /egoLaneCorridor/);
    assert.match(src, /rgba\(120,120,120,0\.38\)/);
  });

  it('video timeline hooks remain unchanged', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    assert.match(src, /localPlaybackVideo\?\.onTimelineScrub/);
    assert.match(src, /interpolatedLogMonoTime/);
    assert.doesNotMatch(src, /globalToVehicleDisplay/);
  });

  it('global and vehicle-relative render paths remain unchanged', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    assert.match(src, /_drawGlobal\(d\)/);
    assert.match(src, /_drawVehicleFrame\(/);
    assert.match(src, /displayMode === 'vehicle'/);
  });
});
