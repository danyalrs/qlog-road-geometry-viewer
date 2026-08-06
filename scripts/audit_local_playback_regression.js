'use strict';

const fs = require('fs');
const path = require('path');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
const LP = require('../lib/local_playback');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEG2 = 'qlog_f449c_2.bz2';
const INDICES = [0, 4, 8, 12, 16, 29];

function loadSegment(fileName) {
  const segPath = path.join(ROOT, fileName);
  const modelEvents = extractModel(segPath).map((e) => ({ ...e, sourceFile: fileName }));
  const gpsEvents = extractGps(segPath).map((e) => ({ ...e, sourceFile: fileName }));
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
  return { ...result, timeline };
}

function polylineSpan(points) {
  if (!points?.length) return null;
  let minE = Infinity; let maxE = -Infinity; let minN = Infinity; let maxN = -Infinity;
  for (const p of points) {
    minE = Math.min(minE, p.east); maxE = Math.max(maxE, p.east);
    minN = Math.min(minN, p.north); maxN = Math.max(maxN, p.north);
  }
  return {
    count: points.length,
    eastSpan: maxE - minE,
    northSpan: maxN - minN,
    minE, maxE, minN, maxN,
    first: points[0],
    last: points[points.length - 1],
  };
}

function modelSpan(lanes) {
  const xs = [];
  const ys = [];
  for (const lane of lanes || []) {
    for (const p of lane.points || []) {
      if (Number.isFinite(p.modelX)) xs.push(p.modelX);
      if (Number.isFinite(p.modelY)) ys.push(p.modelY);
    }
  }
  if (!xs.length) return null;
  return {
    modelX: { min: Math.min(...xs), max: Math.max(...xs) },
    modelY: { min: Math.min(...ys), max: Math.max(...ys) },
  };
}

function main() {
  const data = loadSegment(SEG2);
  const chunk = data.routeChunks[0];
  const anchorIdx = LP.resolveAnchorFrameIndex(data.frames, data.timeline);
  const anchor = data.frames[anchorIdx];
  const fusedLanes = chunk?.fusedLaneLines || [];
  const fusedEdges = chunk?.fusedRoadEdges || [];

  const report = {
    segment: SEG2,
    anchorFrameIndex: anchorIdx,
    anchorFrameId: anchor?.frameId,
    frameCount: data.frames.length,
    fusedLaneFragmentCount: fusedLanes.length,
    fusedEdgeFragmentCount: fusedEdges.length,
    fusedGlobalSpan: polylineSpan(fusedLanes[0]?.points),
    previousLocalPlayback: {
      geometrySource: `frames[anchorIdx=${anchorIdx}] static snapshot`,
      wasGenuinelyAccumulated: false,
      arrowSource: 'resolveArrowOnDashPath on anchor frame.path',
      geometryStationary: true,
    },
    currentLocalPlaybackDefault: {
      geometrySource: 'frames[elapsedIdx] per observation',
      arrowSource: 'resolveArrowForCurrentFrame on current frame.path + pose heading',
      geometryStationary: false,
      refitBehavior: 'fitToLocalView uses current frame bounds + arrow on initial applyVisualization only',
    },
    accumulatedMode: {
      geometrySource: 'chunk.fusedLaneLines global coords',
      transform: 'globalToVehicleDisplay(point, frames[elapsedIdx].pose) each draw',
      pathOverlay: 'current display.frame.path (per-frame)',
      preparedOnce: false,
    },
    perIndex: [],
    accumulatedTransformDrift: [],
  };

  for (const idx of INDICES) {
    const frame = data.frames[idx];
    const geom = LP.resolveLocalGeometryFrame(data.frames, data.timeline, idx);
    const laneSpan = polylineSpan(frame?.lanes?.[0]?.points);
    const pathSpan = polylineSpan(frame?.path?.points);
    const anchorLaneSpan = polylineSpan(anchor?.lanes?.[0]?.points);

    const fused0 = fusedLanes[0];
    const fusedTransformed = fused0
      ? LP.transformPolylineToVehicleDisplay(fused0.points, frame.pose)
      : [];
    const fusedTSpan = polylineSpan(fusedTransformed);

    const arrowCurrent = LP.resolveArrowForCurrentFrame({
      frames: data.frames,
      timeline: data.timeline,
      vehiclePath: data.vehiclePath,
      frameIndex: idx,
    });
    const arrowAnchor = LP.resolveArrowOnDashPath({
      anchorFrame: anchor,
      frames: data.frames,
      timeline: data.timeline,
      vehiclePath: data.vehiclePath,
      frameIndex: idx,
    });

    report.perIndex.push({
      elapsedIdx: idx,
      frameId: frame?.frameId,
      laneCount: frame?.lanes?.length ?? 0,
      geometryState: geom.geometryState,
      pose: frame?.pose ? {
        east: frame.pose.east,
        north: frame.pose.north,
        headingDeg: frame.pose.headingDeg,
      } : null,
      perFrameLane0Span: laneSpan,
      perFramePathSpan: pathSpan,
      perFrameModelSpan: modelSpan(frame?.lanes),
      anchorLane0Span: anchorLaneSpan,
      fusedGlobalFirstPoint: fused0?.points?.[0] ?? null,
      fusedTransformedFirstPoint: fusedTransformed[0] ?? null,
      fusedTransformedSpan: fusedTSpan,
      arrowCurrent: { east: arrowCurrent.east, north: arrowCurrent.north, heading: arrowCurrent.headingDeg },
      arrowAnchor: { east: arrowAnchor.east, north: arrowAnchor.north, heading: arrowAnchor.headingDeg },
    });
  }

  const refPose = data.frames[0]?.pose;
  const refTransformed = fusedLanes[0]
    ? LP.transformPolylineToVehicleDisplay(fusedLanes[0].points, refPose)
    : [];
  const refMid = refTransformed[Math.floor(refTransformed.length / 2)];

  for (const idx of INDICES) {
    const pose = data.frames[idx]?.pose;
    const transformed = fusedLanes[0]
      ? LP.transformPolylineToVehicleDisplay(fusedLanes[0].points, pose)
      : [];
    const mid = transformed[Math.floor(transformed.length / 2)];
    report.accumulatedTransformDrift.push({
      elapsedIdx: idx,
      poseHeading: pose?.headingDeg,
      midPointEast: mid?.east,
      midPointNorth: mid?.north,
      deltaFromIdx0MidEast: mid && refMid ? mid.east - refMid.east : null,
      deltaFromIdx0MidNorth: mid && refMid ? mid.north - refMid.north : null,
    });
  }

  const outPath = path.join(ROOT, 'audit_local_playback_regression.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    outPath,
    anchorIdx,
    fusedLanes: fusedLanes.length,
    perIndexSummary: report.perIndex.map((r) => ({
      idx: r.elapsedIdx,
      lanes: r.laneCount,
      lane0EastSpan: r.perFrameLane0Span?.eastSpan?.toFixed(1),
      pathEastSpan: r.perFramePathSpan?.eastSpan?.toFixed(1),
      fusedTransformedEastSpan: r.fusedTransformedSpan?.eastSpan?.toFixed(1),
      arrowE: r.arrowCurrent.east?.toFixed(1),
    })),
    accumulatedDrift: report.accumulatedTransformDrift,
  }, null, 2));
}

main();
