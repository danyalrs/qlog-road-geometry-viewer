'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { enrichTimelineWithMovement, resolveMovementDisplay } = require('../lib/vehicle_movement_display');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEG54 = path.join(ROOT, 'qlog_f449c_54.bz2');

function processSegment(filePath) {
  const modelEvents = extractModel(filePath).map((e) => ({ ...e, sourceFile: path.basename(filePath) }));
  const gpsEvents = extractGps(filePath).map((e) => ({ ...e, sourceFile: path.basename(filePath) }));
  return processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
}

describe('timeline movement propagation', () => {
  it('propagates movementState onto timeline for segment 54 when vehiclePath annotated', () => {
    if (!fs.existsSync(SEG54)) {
      return;
    }
    const result = processSegment(SEG54);
    const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
    assert.ok(timeline.length > 10);
    const withState = timeline.filter((t) => t.movementState);
    assert.ok(withState.length > 0, 'expected movementState on timeline entries');
    const states = new Set(withState.map((t) => t.movementState));
    assert.ok(states.has('moving') || states.has('stationary') || states.has('creeping'));
  });

  it('segment 54 has moving early frames and stationary later frames', () => {
    if (!fs.existsSync(SEG54)) {
      return;
    }
    const result = processSegment(SEG54);
    const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
    const displays = timeline.map((entry, i) => resolveMovementDisplay({
      timelineEntry: entry,
      vehiclePathPoint: result.vehiclePath?.find((p) => String(p.logMonoTime) === String(entry.logMonoTime)),
      framePose: result.frames[i]?.pose,
    }));

    const earlyMoving = displays.slice(0, Math.min(30, displays.length))
      .some((d) => d.displayState === 'MOVING');
    const laterStopped = displays.slice(-Math.min(30, displays.length))
      .some((d) => d.displayState === 'STOPPED');
    assert.ok(earlyMoving, 'expected MOVING in early segment 54 frames');
    assert.ok(laterStopped, 'expected STOPPED in later segment 54 frames');
  });
});
