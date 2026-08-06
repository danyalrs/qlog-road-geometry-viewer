'use strict';

const fs = require('fs');
const path = require('path');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
const SLM = require('../lib/segment_local_map');
const { modelToGlobal } = require('../lib/transform');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEG2 = 'qlog_f449c_2.bz2';
const OBS_INDICES = [0, 4, 12, 16, 20, 24, 29];

function loadSegment(fileName) {
  const segPath = path.join(ROOT, fileName);
  const modelEvents = extractModel(segPath).map((e) => ({ ...e, sourceFile: fileName }));
  const gpsEvents = extractGps(segPath).map((e) => ({ ...e, sourceFile: fileName }));
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
  return { ...result, timeline };
}

function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < (points?.length || 0); i++) {
    len += Math.hypot(points[i].east - points[i - 1].east, points[i].north - points[i - 1].north);
  }
  return len;
}

function nearestPointAtModelX(lane, targetX = 10) {
  const pts = (lane?.points || []).filter((p) => Number.isFinite(p.modelX));
  if (!pts.length) return null;
  let best = pts[0];
  let bestD = Math.abs(pts[0].modelX - targetX);
  for (const p of pts) {
    const d = Math.abs(p.modelX - targetX);
    if (d < bestD) { best = p; bestD = d; }
  }
  return best;
}

function distToTrajectory(point, trajectory) {
  if (!trajectory?.length) return null;
  let best = Infinity;
  for (const t of trajectory) {
    best = Math.min(best, Math.hypot(point.east - t.east, point.north - t.north));
  }
  return best;
}

function main() {
  const data = loadSegment(SEG2);
  const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'observations', timelineIndex: 0 });
  const ref = map.referencePose;
  const chunk = data.routeChunks?.[0];

  const polygonTrace = {
    propertyPath: 'routeChunks[].roadSurfacePolygons',
    chunkCount: data.routeChunks?.length ?? 0,
    polygonsInChunk0: chunk?.roadSurfacePolygons?.length ?? 0,
    geometryDebugCount: data.geometryDebug?.polygonCount ?? null,
    statsRoadPolygonCount: data.stats?.roadPolygonCount ?? null,
    samplePolygon: chunk?.roadSurfacePolygons?.[0] ? {
      passId: chunk.roadSurfacePolygons[0].passId,
      fragmentIndex: chunk.roadSurfacePolygons[0].fragmentIndex,
      ringPoints: chunk.roadSurfacePolygons[0].ring?.length,
      firstRingPoint: chunk.roadSurfacePolygons[0].ring?.[0],
      coordinateFrame: 'global east/north (route s-d fused frame)',
      stats: chunk.roadSurfacePolygons[0].stats,
    } : null,
    inBuildSegmentLocalMap: map.roadSurfacePolygons?.length ?? 0,
    inMapBounds: false,
    renderedInLocalPlayback: false,
    layerEnabledInLocalMode: false,
    firstLossStage: null,
  };

  if (map.roadSurfacePolygons?.length) {
    polygonTrace.inBuildSegmentLocalMap = map.roadSurfacePolygons.length;
    polygonTrace.roadPolygonsTransformed = true;
    polygonTrace.sampleTransformedPolygon = {
      ringPoints: map.roadSurfacePolygons[0].ring?.length,
      firstPoint: map.roadSurfacePolygons[0].ring?.[0],
    };
  }

  if (!polygonTrace.inBuildSegmentLocalMap) {
    polygonTrace.firstLossStage = 'buildSegmentLocalMap — polygons not included in stationary map builder';
  }

  const fragmentStats = [];
  for (const frag of map.laneFragments) {
    const len = polylineLength(frag.points);
    const mid = frag.points?.[Math.floor((frag.points.length - 1) / 2)];
    fragmentStats.push({
      kind: 'lane',
      sourceFrameIndex: frag.sourceFrameIndex,
      frameId: frag.frameId,
      laneIndex: frag.laneIndex,
      laneTrackId: frag.laneTrackId,
      pointCount: frag.points?.length ?? 0,
      lengthM: len,
      distToTrajectoryM: mid ? distToTrajectory(mid, map.trajectory) : null,
      bounds: frag.points?.length ? {
        minE: Math.min(...frag.points.map((p) => p.east)),
        maxE: Math.max(...frag.points.map((p) => p.east)),
        minN: Math.min(...frag.points.map((p) => p.north)),
        maxN: Math.max(...frag.points.map((p) => p.north)),
      } : null,
    });
  }
  for (const frag of map.edgeFragments) {
    const len = polylineLength(frag.points);
    const mid = frag.points?.[Math.floor((frag.points.length - 1) / 2)];
    fragmentStats.push({
      kind: 'edge',
      sourceFrameIndex: frag.sourceFrameIndex,
      frameId: frag.frameId,
      edgeIndex: frag.edgeIndex,
      pointCount: frag.points?.length ?? 0,
      lengthM: len,
      distToTrajectoryM: mid ? distToTrajectory(mid, map.trajectory) : null,
    });
  }

  fragmentStats.sort((a, b) => b.lengthM - a.lengthM);
  const lengths = fragmentStats.map((f) => f.lengthM).filter((x) => x > 0).sort((a, b) => a - b);
  const medianLen = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0;

  const perObservation = [];
  for (const idx of OBS_INDICES) {
    const frame = data.frames[idx];
    const entry = data.timeline[idx];
    const pose = frame?.pose;
    const modelEv = extractModel(path.join(ROOT, SEG2)).find((e) => e.logMonoTime === frame?.logMonoTime);
    const modelTs = modelEv?.modelV2?.timestampEof ?? modelEv?.modelV2?.meta?.timestampEof ?? null;

    const lane0 = frame?.lanes?.[0];
    const pt = nearestPointAtModelX(lane0, 10);
    const recomputedGlobal = pt && pose
      ? modelToGlobal(pt.modelX, pt.modelY, pose.east, pose.north, pose.headingDeg)
      : null;
    const segmentLocal = pt
      ? SLM.globalToSegmentLocal(pt.east, pt.north, ref)
      : null;
    const directLocal = pt && pose && ref
      ? (() => {
        const g = modelToGlobal(pt.modelX, pt.modelY, pose.east, pose.north, pose.headingDeg);
        return SLM.globalToSegmentLocal(g.east, g.north, ref);
      })()
      : null;

    perObservation.push({
      elapsedIdx: idx,
      frameId: frame?.frameId,
      logMonoTime: frame?.logMonoTime,
      modelTimestampEof: modelTs,
      poseLogMonoTime: pose?.logMonoTime ?? frame?.logMonoTime,
      timestampDiffNs: modelTs && frame?.logMonoTime
        ? Number(BigInt(String(modelTs)) - BigInt(String(frame.logMonoTime)))
        : null,
      pose: pose ? { east: pose.east, north: pose.north, headingDeg: pose.headingDeg, headingSource: pose.headingSource } : null,
      chunkId: frame?.chunkId,
      passId: frame?.passId ?? frame?.temporalPassId,
      lane0At10m: pt ? {
        modelX: pt.modelX,
        modelY: pt.modelY,
        storedGlobal: { east: pt.east, north: pt.north },
        recomputedGlobal,
        globalDeltaM: recomputedGlobal
          ? Math.hypot(recomputedGlobal.east - pt.east, recomputedGlobal.north - pt.north)
          : null,
        segmentLocal: { east: segmentLocal?.east, north: segmentLocal?.north },
        vehicleInRefFrame: pose
          ? SLM.globalToSegmentLocal(pose.east, pose.north, ref)
          : null,
      } : null,
      laneTrackIds: (frame?.lanes || []).map((l) => l.laneTrackId).filter((x) => x != null),
    });
  }

  const rightBoundarySamples = [];
  for (const idx of OBS_INDICES) {
    const frame = data.frames[idx];
    const lane = (frame?.lanes || []).find((l) => (l.laneIndex ?? 0) === 0) || frame?.lanes?.[0];
    const pt = nearestPointAtModelX(lane, 10);
    if (!pt) continue;
    const local = SLM.globalToSegmentLocal(pt.east, pt.north, ref);
    rightBoundarySamples.push({ idx, frameId: frame.frameId, localE: local.east, localN: local.north });
  }

  const boundarySpread = [];
  for (let i = 1; i < rightBoundarySamples.length; i++) {
    const a = rightBoundarySamples[i - 1];
    const b = rightBoundarySamples[i];
    boundarySpread.push({
      fromIdx: a.idx,
      toIdx: b.idx,
      separationM: Math.hypot(b.localE - a.localE, b.localN - a.localN),
    });
  }

  const report = {
    segment: SEG2,
    referencePose: ref,
    polygonTrace,
    fragmentSummary: {
      totalLaneFragments: map.laneFragmentCount,
      totalEdgeFragments: map.edgeFragmentCount,
      mapBounds: map.bounds,
      medianFragmentLengthM: medianLen,
      maxFragmentLengthM: fragmentStats[0]?.lengthM ?? 0,
      longestFive: fragmentStats.slice(0, 5),
    },
    perObservation,
    rightBoundaryAt10m: rightBoundarySamples,
    boundarySpreadBetweenObservations: boundarySpread,
    fanAnalysis: {
      hypothesis: 'Each observation lane fragment originates at vehicle pose in reference frame; along a curve, origins spread along trajectory creating fan pattern',
      meanBoundarySpreadM: boundarySpread.length
        ? boundarySpread.reduce((s, x) => s + x.separationM, 0) / boundarySpread.length
        : null,
      maxBoundarySpreadM: boundarySpread.length ? Math.max(...boundarySpread.map((x) => x.separationM)) : null,
    },
    transformConsistency: perObservation.map((o) => ({
      idx: o.elapsedIdx,
      globalRecomputeDeltaM: o.lane0At10m?.globalDeltaM ?? null,
    })),
    verdict: {
      roadPolygonsExistInProcessedData: (chunk?.roadSurfacePolygons?.length ?? 0) > 0,
      roadPolygonsReachLocalBuilder: (map.roadSurfacePolygons?.length ?? 0) > 0,
      roadPolygonsTransformed: (map.roadSurfacePolygons?.length ?? 0) > 0,
      roadPolygonsRendered: 'pending UI — enabled via layerRoadSurface in local mode after this fix',
      firstPolygonLossStage: polygonTrace.firstLossStage,
      storedGlobalMatchesRecomputed: perObservation.every((o) => (o.lane0At10m?.globalDeltaM ?? 0) < 0.01),
      repeatedBoundariesOverlap: boundarySpread.every((b) => b.separationM < 3),
      fanPatternCause: null,
      longUpperFragment: fragmentStats.find((f) => f.bounds?.maxN > 200) || fragmentStats[0],
      viewportCompressionCause: 'Fit includes all fragment vertices including long outlier polylines',
      firstIncorrectCoordinateStage: null,
    },
  };

  if (!report.verdict.storedGlobalMatchesRecomputed) {
    report.verdict.firstIncorrectCoordinateStage = 'transformFrameGeometry / stored global coords';
  } else if (!report.verdict.repeatedBoundariesOverlap) {
    report.verdict.firstIncorrectCoordinateStage = 'accumulation — per-observation vehicle origins along curved trajectory (not a single transform bug)';
    report.verdict.fanPatternCause = 'Per-observation global lanes transformed to fixed reference frame; each fragment anchored at its observation vehicle position along route curve';
  }

  const outPath = path.join(ROOT, 'audit_segment2_stationary_alignment.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main();
