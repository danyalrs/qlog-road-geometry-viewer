'use strict';

const path = require('path');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
const LP = require('../lib/local_playback');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');

function loadSegment(fileName) {
  const segPath = path.join(ROOT, fileName);
  const modelEvents = extractModel(segPath).map((e) => ({ ...e, sourceFile: fileName }));
  const gpsEvents = extractGps(segPath).map((e) => ({ ...e, sourceFile: fileName }));
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
  return { ...result, timeline };
}

function headingDelta(a, b) {
  return Math.abs(((b - a + 540) % 360) - 180);
}

function verifySegment(fileName, indices) {
  const data = loadSegment(fileName);
  const anchorIdx = LP.resolveAnchorFrameIndex(data.frames, data.timeline);
  const anchor = data.frames[anchorIdx];
  const rows = [];
  let lastValid = null;
  for (const idx of indices) {
    const geom = LP.resolveLocalGeometryFrame(data.frames, data.timeline, idx, lastValid);
    if (geom.geometryState === 'current') lastValid = geom;
    const current = LP.resolveArrowForCurrentFrame({
      frames: data.frames,
      timeline: data.timeline,
      vehiclePath: data.vehiclePath,
      frameIndex: idx,
      options: { minHeadingSpeedMps: 2 },
    });
    const anchorPose = LP.resolveArrowOnDashPath({
      anchorFrame: anchor,
      frames: data.frames,
      timeline: data.timeline,
      vehiclePath: data.vehiclePath,
      frameIndex: idx,
      options: { minHeadingSpeedMps: 2 },
    });
    rows.push({
      elapsedIdx: idx,
      frameId: data.frames[idx]?.frameId,
      geometryState: geom.geometryState,
      geometrySourceIdx: geom.geometrySourceIndex,
      laneCount: data.frames[idx]?.lanes?.length ?? 0,
      currentHeading: current.headingDeg,
      anchorHeading: anchorPose.headingDeg,
      poseHeading: data.frames[idx]?.pose?.headingDeg,
      headingSource: current.headingSource,
      corridor: LP.computeCorridorOffsetFromFrame(data.frames[idx]),
    });
  }
  return { fileName, anchorIdx, rows };
}

function main() {
  const seg1 = verifySegment('qlog_f449c_1.bz2', [9, 12, 13, 14, 19]);
  const seg2 = verifySegment('qlog_f449c_2.bz2', [0, 5, 8, 13, 16, 29]);

  console.log('=== Segment 1 current-frame verification ===');
  for (const r of seg1.rows) {
    console.log(JSON.stringify({
      idx: r.elapsedIdx,
      lanes: r.laneCount,
      geom: r.geometryState,
      corridorOffset: r.corridor.valid ? r.corridor.vehicleOffsetFromCorridorCenterM.toFixed(2) : null,
      currentH: r.currentHeading?.toFixed(1),
      anchorH: r.anchorHeading?.toFixed(1),
    }));
  }

  console.log('\n=== Segment 2 current-frame verification ===');
  for (const r of seg2.rows) {
    console.log(JSON.stringify({
      idx: r.elapsedIdx,
      lanes: r.laneCount,
      geom: r.geometryState,
      currentH: r.currentHeading?.toFixed(1),
      anchorH: r.anchorHeading?.toFixed(1),
      poseH: r.poseHeading?.toFixed(1),
      deltaCurrentVsAnchor: headingDelta(r.currentHeading, r.anchorHeading).toFixed(1),
    }));
  }

  const seg2idx0 = seg2.rows.find((r) => r.elapsedIdx === 0);
  const seg2idx16 = seg2.rows.find((r) => r.elapsedIdx === 16);
  console.log('\n=== Summary ===');
  console.log(`Seg2 heading idx0 current=${seg2idx0?.currentHeading?.toFixed(1)} idx16 current=${seg2idx16?.currentHeading?.toFixed(1)} delta=${headingDelta(seg2idx0?.currentHeading, seg2idx16?.currentHeading).toFixed(1)}°`);
  console.log(`Seg2 idx16 current vs anchor delta=${headingDelta(seg2idx16?.currentHeading, seg2idx16?.anchorHeading).toFixed(1)}°`);
}

main();
