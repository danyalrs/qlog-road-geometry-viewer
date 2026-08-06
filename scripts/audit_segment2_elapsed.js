'use strict';

const path = require('path');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
const LP = require('../lib/local_playback');
const PAS = require('../lib/playback_arrow_screen');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEG = path.join(ROOT, 'qlog_f449c_2.bz2');

function headingFromTangent(ux, uy) {
  return (Math.atan2(ux, uy) * 180 / Math.PI + 360) % 360;
}

function deltaHeading(a, b) {
  if (a == null || b == null) return null;
  return ((b - a + 540) % 360) - 180;
}

function main() {
  const modelEvents = extractModel(SEG).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const gpsEvents = extractGps(SEG).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
  const frames = result.frames;
  const anchorIdx = LP.resolveAnchorFrameIndex(frames, timeline);
  const anchor = frames[anchorIdx];
  const ctx = LP.buildPlaybackContext({
    anchorFrame: anchor,
    timeline,
    vehiclePath: result.vehiclePath,
    options: { minHeadingSpeedMps: 2 },
  });

  const w = 1200;
  const h = 800;
  const bounds = LP.computeVehicleFrameBounds(anchor);
  const pad = 40;
  const scale = Math.min((w - pad * 2) / (bounds.maxE - bounds.minE), (h - pad * 2) / (bounds.maxN - bounds.minN));
  const midE = (bounds.minE + bounds.maxE) / 2;
  const midN = (bounds.minN + bounds.maxN) / 2;
  const offsetX = -midE * scale;
  const offsetY = midN * scale;
  const worldToScreen = (e, n) => ({ x: w / 2 + offsetX + e * scale, y: h / 2 + offsetY - n * scale });
  const screenPoints = PAS.projectPathPoints(anchor.path.points, worldToScreen);

  const rows = [];
  for (let idx = 0; idx < timeline.length; idx++) {
    const t = timeline[idx];
    const frame = frames[idx];
    const pose = LP.resolveArrowOnDashPath({
      anchorFrame: anchor,
      frames,
      timeline,
      vehiclePath: result.vehiclePath,
      frameIndex: idx,
      options: { minHeadingSpeedMps: 2 },
    });
    const vp = LP.matchVehiclePathPoint(result.vehiclePath, t, { minHeadingSpeedMps: 2 });
    const tangent = PAS.resolveScreenPathTangent(screenPoints, pose.pathIndex);
    const pair = LP.findHeadingPair(ctx.timedPath, pose.pathIndex);
    const pathHeading = pair ? LP.headingDegForVehicleIcon(pair.dx, pair.dy) : null;
    const screenHeading = tangent ? headingFromTangent(tangent.ux, tangent.uy) : null;

    rows.push({
      elapsedIdx: idx,
      logMonoTime: t.logMonoTime,
      frameId: t.frameId,
      movementState: t.movementState ?? vp?.point?.movementState ?? null,
      modelV2: {
        east: frame?.pose?.east,
        north: frame?.pose?.north,
        speedMps: frame?.pose?.speed,
        headingDeg: frame?.pose?.headingDeg,
        laneCount: frame?.lanes?.length ?? 0,
        pathPointCount: frame?.path?.points?.length ?? 0,
      },
      gps: vp?.point ? {
        east: vp.point.east,
        north: vp.point.north,
        speedMps: vp.point.speed,
        headingDeg: vp.point.headingDeg,
        matchMethod: vp.method,
      } : null,
      arrowPose: {
        east: pose.east,
        north: pose.north,
        pathIndex: pose.pathIndex,
        headingDeg: pose.headingDeg,
        frozen: pose.frozen,
      },
      pathTangent: pair ? {
        dx: pair.dx,
        dy: pair.dy,
        pathHeadingDeg: pathHeading,
        bracket: [pair.bracketA, pair.bracketB],
      } : null,
      screenTangent: tangent ? {
        ux: tangent.ux,
        uy: tangent.uy,
        screenHeadingDeg: screenHeading,
        segment: [tangent.previousIndex, tangent.nextIndex],
      } : null,
    });
  }

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].screenTangent?.screenHeadingDeg;
    const cur = rows[i].screenTangent?.screenHeadingDeg;
    rows[i].screenHeadingStepDeg = deltaHeading(prev, cur);
  }

  const phases = [
    [0, 2, 'straight-before'],
    [3, 5, 'entering-curve'],
    [6, 13, 'through-curve'],
    [14, 15, 'leaving-curve'],
    [16, 29, 'straight-after'],
  ];

  const phaseStats = phases.map(([start, end, label]) => {
    const slice = rows.slice(start, end + 1);
    const headings = slice.map((r) => r.screenTangent?.screenHeadingDeg).filter((v) => v != null);
    const steps = slice.map((r) => r.screenHeadingStepDeg).filter((v) => v != null);
    const totalChange = headings.length > 1
      ? headings.slice(1).reduce((acc, h, i) => acc + deltaHeading(headings[i], h), 0)
      : 0;
    return {
      label,
      range: start + '-' + end,
      count: slice.length,
      screenHeadingStartDeg: headings[0] ?? null,
      screenHeadingEndDeg: headings[headings.length - 1] ?? null,
      totalScreenHeadingChangeDeg: totalChange,
      meanAbsStepDeg: steps.length ? steps.reduce((s, v) => s + Math.abs(v), 0) / steps.length : 0,
      maxAbsStepDeg: steps.length ? Math.max(...steps.map(Math.abs)) : 0,
    };
  });

  const output = {
    segment: 'qlog_f449c_2.bz2',
    anchorFrameIndex: anchorIdx,
    timelineCount: timeline.length,
    timelineStartLogMonoTime: timeline[0]?.logMonoTime,
    phaseStats,
    rows,
  };

  const outPath = path.join(ROOT, 'audit_segment2_elapsed.json');
  require('fs').writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ outPath, phaseStats, rowCount: rows.length }, null, 2));
}

main();
