/**
 * Main route processing pipeline with per-chunk fusion and road polygon sanity checks.
 */
const { setLocalCoords, trajectoryDistance } = require('./projection');
const { interpolateGpsAtTime, enrichGpsHeadings } = require('./alignment');
const { extractModelGeometry, transformFrameGeometry } = require('./transform');
const { fuseLaneObservations, fuseRoadEdges, estimateCentreLine } = require('./fusion');
const { processChunkSdFusion } = require('./sd_fusion');
const { validateGpsRecord, createRejectionStats } = require('./gps_validate');
const { sortFilesByLogTime, detectOverlaps, detectOrderingUncertainty } = require('./file_ordering');
const { chunkFrames, maxInternalGpsGap, trajectoryLength, dist2d } = require('./chunking');
const { buildRoadSurfacePolygons, polygonArea } = require('./geometry_sanity');
const { buildFrameStats } = require('./frame_stats');
const {
  normalizeProcessOptions,
  buildProcessingOptionsSnapshot,
} = require('./process_defaults');

function segmentAllowsFusion(files, qualifications) {
  if (!qualifications?.length || !files?.length) return true;
  const byFile = new Map(qualifications.map((q) => [q.filename, q]));
  return files.every((f) => byFile.get(f)?.allowFusion !== false);
}

function processRoute(modelEvents, gpsEvents, options = {}) {
  const opts = normalizeProcessOptions({
    minLaneProb: 0.5,
    maxAccuracyM: 50,
    maxModelGpsDeltaNs: 2e9,
    maxForwardM: 120,
    fusionIntervalM: 2.0,
    maxInterpolationSpanM: undefined,
    minSpeedForGpsBearing: 2.0,
    maxJumpM: 200,
    maxTimeGapSec: 3,
    maxGpsGapM: 30,
    maxImpliedSpeedMps: 55,
    minObsPerBin: 2,
    minFramesPerBin: 2,
    maxLateralJumpM: 2.5,
    madMultiplier: 3.0,
    minRoadWidthM: 2,
    maxRoadWidthM: 30,
    maxVertexJumpM: 15,
    pipelineMode: 'C',
    laneTrackingEnabled: true,
    localSupportFilter: true,
    ...options,
  });
  if (opts.maxInterpolationSpanM == null) {
    opts.maxInterpolationSpanM = opts.fusionIntervalM * 2;
  }
  if (opts.pipelineMode === 'A') {
    opts.laneTrackingEnabled = false;
    opts.localSupportFilter = false;
  } else if (opts.pipelineMode === 'B') {
    opts.laneTrackingEnabled = opts.laneTrackingEnabled !== false;
    opts.localSupportFilter = false;
  } else {
    opts.laneTrackingEnabled = opts.laneTrackingEnabled !== false;
    opts.localSupportFilter = opts.localSupportFilter !== false;
  }

  const rejectionStats = createRejectionStats();
  const sourceFiles = [...new Set([
    ...modelEvents.map((e) => e.sourceFile),
    ...gpsEvents.map((e) => e.sourceFile),
  ])];

  const fileAnalyses = sortFilesByLogTime(modelEvents, gpsEvents, sourceFiles);
  const overlaps = detectOverlaps(fileAnalyses);
  const orderingUncertain = detectOrderingUncertainty(fileAnalyses);

  const rawGps = [...gpsEvents].sort((a, b) => {
    const d = BigInt(a.logMonoTime) - BigInt(b.logMonoTime);
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  });

  const preValid = [];
  for (const g of rawGps) {
    if (validateGpsRecord(g, { maxAccuracyM: opts.maxAccuracyM, maxJumpM: Infinity }, null, rejectionStats)) {
      preValid.push({ ...g });
    }
  }

  const hasGlobalGps = preValid.length >= 2 && hasChangingPositions(preValid);
  let validGps = [];
  let origin = null;
  let mode = 'vehicle-relative';

  if (hasGlobalGps) {
    origin = { lat: preValid[0].latitude, lon: preValid[0].longitude };
    setLocalCoords(preValid, origin);

    validGps = [];
    let prev = null;
    for (const g of preValid) {
      const sameFile = prev && prev.sourceFile === g.sourceFile;
      const prevForJump = sameFile ? prev : null;
      if (validateGpsRecord(g, { maxAccuracyM: opts.maxAccuracyM, maxJumpM: opts.maxJumpM }, prevForJump, rejectionStats)) {
        validGps.push({ ...g });
        prev = g;
      }
    }
    validGps = enrichGpsHeadings(validGps, { minSpeedForGpsBearing: opts.minSpeedForGpsBearing });
    if (validGps.length < 2) {
      mode = 'vehicle-relative';
      validGps = [];
      origin = null;
    } else {
      mode = 'global';
    }
  }

  const fileOrder = fileAnalyses.map((a) => a.sourceFile);
  const models = [...modelEvents].sort((a, b) => {
    const fa = fileOrder.indexOf(a.sourceFile);
    const fb = fileOrder.indexOf(b.sourceFile);
    if (fa !== fb) return fa - fb;
    const d = BigInt(a.logMonoTime) - BigInt(b.logMonoTime);
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  });

  const transformedFrames = [];
  let rejectedFrames = 0;

  for (const ev of models) {
    const geom = extractModelGeometry(ev.modelV2, { minLaneProb: opts.minLaneProb, maxForwardM: opts.maxForwardM });
    if (!geom.laneLines.length && !geom.roadEdges.length && !geom.path) continue;

    if (mode === 'global') {
      const pose = interpolateGpsAtTime(validGps, ev.logMonoTime, opts.maxModelGpsDeltaNs);
      if (!pose) { rejectedFrames++; continue; }

      const framePose = {
        east: pose.east,
        north: pose.north,
        headingDeg: pose.headingDeg ?? 0,
        headingSource: pose.headingSource || 'interpolated',
        speed: pose.speed ?? 0,
        horizontalAccuracy: pose.horizontalAccuracy ?? 0,
        latitude: pose.latitude,
        longitude: pose.longitude,
      };

      const transformed = transformFrameGeometry(geom, framePose, opts);
      transformedFrames.push({
        logMonoTime: ev.logMonoTime,
        sourceFile: ev.sourceFile,
        sourceEventIndex: ev.sourceEventIndex,
        frameId: geom.frameId,
        pose: framePose,
        ...transformed,
      });
    } else {
      transformedFrames.push({
        logMonoTime: ev.logMonoTime,
        sourceFile: ev.sourceFile,
        sourceEventIndex: ev.sourceEventIndex,
        frameId: geom.frameId,
        vehicleRelative: true,
        chunkId: 0,
        sessionId: 0,
        lanes: geom.laneLines.map((l) => ({
          laneIndex: l.laneIndex,
          prob: l.prob,
          points: l.x.map((x, i) => ({
            modelX: x, modelY: l.y[i], modelZ: (l.z && l.z[i]) || 0,
            east: x, north: -l.y[i],
          })),
        })),
        edges: geom.roadEdges.map((e) => ({
          edgeIndex: e.edgeIndex,
          points: e.x.map((x, i) => ({
            modelX: x, modelY: e.y[i], east: x, north: -e.y[i],
          })),
        })),
        path: geom.path ? {
          points: geom.path.x.map((x, i) => ({
            modelX: x, modelY: geom.path.y[i] || 0,
            east: x, north: -(geom.path.y[i] || 0),
          })),
        } : null,
      });
    }
  }

  const routeChunks = [];
  let gpsTrajectory = [];
  let allFusedLanes = [];
  let allFusedEdges = [];
  let allCentreLines = [];
  let allRoadPolygons = [];
  let totalPolygonRejections = 0;

  if (mode === 'global') {
    const frameChunks = chunkFrames(transformedFrames, opts);

    for (const fc of frameChunks) {
      const rawGpsForChunk = validGps.filter((g) =>
        fc.files.includes(g.sourceFile)
        && BigInt(g.logMonoTime) >= BigInt(fc.startLogMonoTime)
        && BigInt(g.logMonoTime) <= BigInt(fc.endLogMonoTime)
      );

      const { segments: gpsSegments, maxInternalGapM: rawGpsMaxGap } = filterContinuousGpsPoints(rawGpsForChunk, opts.maxGpsGapM);
      const primaryGps = gpsSegments.reduce((best, seg) => (seg.length > (best?.length ?? 0) ? seg : best), gpsSegments[0] || []);

      const rawLaneObs = [];
      const rawEdgeObs = [];
      const vehiclePath = [];

      for (const frame of fc.frames) {
        for (const lane of frame.lanes || []) rawLaneObs.push(lane);
        for (const edge of frame.edges || []) rawEdgeObs.push(edge);
        if (frame.pose) {
          vehiclePath.push({
            logMonoTime: frame.logMonoTime,
            east: frame.pose.east,
            north: frame.pose.north,
            speed: frame.pose.speed,
            headingDeg: frame.pose.headingDeg,
            sourceFile: frame.sourceFile,
            frameId: frame.frameId,
            chunkId: fc.chunkId,
          });
        }
      }

      const fusionTrajectory = vehiclePath.length >= 2 ? vehiclePath : primaryGps;
      const canFuse = segmentAllowsFusion(fc.files, opts.segmentQualifications);
      const sdResult = canFuse
        ? processChunkSdFusion(fc.frames, fusionTrajectory, { ...opts, chunkId: fc.chunkId })
        : {
          fusedLaneLines: [],
          fusedRoadEdges: [],
          roadSurfacePolygons: [],
          polygonRejections: [],
          annotatedFrames: fc.frames,
          annotatedVehiclePath: vehiclePath,
          diagnostics: { skipped: true, reason: 'segmentIncompleteOrInsufficientEvidence' },
          passDiagnostics: [],
          passCoverage: [],
          laneTrackingSummary: null,
          allTracks: [],
          framePairAudits: [],
          geometryLayers: null,
        };

      for (const af of sdResult.annotatedFrames || []) {
        const idx = transformedFrames.findIndex((f) => f.frameId === af.frameId && f.sourceFile === af.sourceFile);
        if (idx >= 0) transformedFrames[idx] = { ...transformedFrames[idx], ...af };
      }

      const fusedLanes = sdResult.fusedLaneLines;
      const fusedEdges = sdResult.fusedRoadEdges;
      const centreLine = estimateCentreLine(fusedLanes);
      const polygons = sdResult.roadSurfacePolygons;
      const rejectionLog = sdResult.polygonRejections;

      const gpsTraj = primaryGps.map((g) => ({
        logMonoTime: g.logMonoTime,
        east: g.east,
        north: g.north,
        speed: g.speed,
        bearingDeg: g.bearingDeg,
        headingSource: g.headingSource,
        horizontalAccuracy: g.horizontalAccuracy,
        latitude: g.latitude,
        longitude: g.longitude,
        sourceFile: g.sourceFile,
        chunkId: fc.chunkId,
      }));

      const chunkQual = (opts.segmentQualifications || []).filter((q) => fc.files.includes(q.filename));
      const chunk = {
        chunkId: fc.chunkId,
        sessionId: fc.sessionId,
        files: fc.files,
        segmentQualification: chunkQual,
        fusionSkipped: !canFuse,
        frameCount: fc.frames.length,
        gpsPointCount: gpsTraj.length,
        startLogMonoTime: fc.startLogMonoTime,
        endLogMonoTime: fc.endLogMonoTime,
        durationSec: fc.durationSec,
        distanceM: trajectoryLength(gpsTraj),
        maxInternalGpsGapM: maxInternalGpsGap(gpsTraj),
        rawGpsMaxGapM: rawGpsMaxGap,
        gpsSegmentCount: gpsSegments.length,
        sdDiagnostics: sdResult.diagnostics,
        passDiagnostics: sdResult.passDiagnostics,
        passCoverage: sdResult.passCoverage,
        laneTrackingSummary: sdResult.laneTrackingSummary,
        laneTracks: sdResult.allTracks,
        framePairAudits: sdResult.framePairAudits,
        geometryLayers: sdResult.geometryLayers,
        laneOnlyCandidates: sdResult.geometryLayers?.laneOnlyCandidates ?? [],
        rejectedLaneOutliers: sdResult.geometryLayers?.rejectedOutliers ?? [],
        startGps: gpsTraj[0] ? { lat: gpsTraj[0].latitude, lon: gpsTraj[0].longitude } : null,
        endGps: gpsTraj.length ? { lat: gpsTraj[gpsTraj.length - 1].latitude, lon: gpsTraj[gpsTraj.length - 1].longitude } : null,
        gpsTrajectory: gpsTraj,
        vehiclePath: sdResult.annotatedVehiclePath?.length ? sdResult.annotatedVehiclePath : vehiclePath,
        trajectorySegments: sdResult.trajectorySegments?.length ? sdResult.trajectorySegments : null,
        fusedLaneLines: sdResult.geometryLayers?.acceptedFusedLanes ?? fusedLanes,
        fusedRoadEdges: fusedEdges,
        centreLine,
        roadSurfacePolygons: polygons.map((p) => ({
          fragmentIndex: p.fragmentIndex,
          passId: p.passId,
          ring: p.ring,
          stats: p.stats,
          source: p.source,
          sourceLeftTrackId: p.sourceLeftTrackId,
          sourceRightTrackId: p.sourceRightTrackId,
          surfaceType: p.surfaceType,
          bridgeProvenance: p.bridgeProvenance,
          safeBridgeGapM: p.safeBridgeGapM,
        })),
        polygonRejections: rejectionLog,
        frames: sdResult.annotatedFrames?.length ? sdResult.annotatedFrames : fc.frames,
      };

      routeChunks.push(chunk);
      gpsTrajectory.push(...gpsTraj);
      allFusedLanes.push(...(sdResult.geometryLayers?.acceptedFusedLanes ?? fusedLanes).map((l) => ({ ...l, chunkId: fc.chunkId })));
      allFusedEdges.push(...fusedEdges.map((e) => ({ ...e, chunkId: fc.chunkId })));
      allCentreLines.push(...centreLine.map((c) => ({ ...c, chunkId: fc.chunkId })));
      allRoadPolygons.push(...polygons.map((p) => ({ ...p, chunkId: fc.chunkId })));
      totalPolygonRejections += rejectionLog.length;
    }
  } else if (transformedFrames.length) {
    routeChunks.push({
      chunkId: 0,
      sessionId: 0,
      files: [...new Set(transformedFrames.map((f) => f.sourceFile))],
      frameCount: transformedFrames.length,
      gpsPointCount: 0,
      frames: transformedFrames,
      fusedLaneLines: [],
      fusedRoadEdges: [],
      centreLine: [],
      roadSurfacePolygons: [],
      gpsTrajectory: [],
      vehiclePath: [],
      polygonRejections: [],
    });
  }

  const sessionIds = [...new Set(routeChunks.map((c) => c.sessionId))];
  const largestPolygon = allRoadPolygons.reduce((best, p) => {
    const area = p.stats?.area ?? polygonArea(p.ring || []);
    return area > (best?.area ?? 0) ? { area, width: p.stats?.maxWidth, chunkId: p.chunkId } : best;
  }, null);

  const betweenGps = maxGapBetweenChunks(routeChunks);
  const maxInternalPerChunk = routeChunks.length
    ? Math.max(...routeChunks.map((c) => c.maxInternalGpsGapM || 0))
    : 0;

  const pipelineAudit = buildPipelineAudit(modelEvents, gpsEvents, models, transformedFrames, rejectedFrames, opts);
  const frameStats = buildFrameStats(modelEvents, transformedFrames, opts);
  const t0 = models.length ? BigInt(models[0].logMonoTime) : 0n;
  const t1 = models.length ? BigInt(models[models.length - 1].logMonoTime) : 0n;

  return {
    mode,
    origin,
    options: opts,
    processingOptions: buildProcessingOptionsSnapshot(opts),
    routeChunks,
    gpsTrajectory,
    fusedLanes: allFusedLanes,
    fusedEdges: allFusedEdges,
    centreLine: allCentreLines,
    roadSurfacePolygons: allRoadPolygons,
    frames: transformedFrames,
    vehiclePath: routeChunks.flatMap((c) => c.vehiclePath || []),
    fileAnalyses,
    stats: {
      modelEventCount: modelEvents.length,
      validModelFrames: transformedFrames.length,
      frameCounts: frameStats.totals,
      frameCountsPerFile: frameStats.perFile,
      rejectedModelFrames: rejectedFrames,
      poseSource: opts.poseSourceReport || { pipelinePoseSource: 'gpsLocation' },
      gpsEventCount: rawGps.length,
      validGpsCount: validGps.length,
      gpsRejectionStats: rejectionStats,
      globallyTransformedFrames: mode === 'global' ? transformedFrames.length : 0,
      routeDurationSec: models.length ? Number(t1 - t0) / 1e9 : 0,
      gpsTrajectoryDistanceM: mode === 'global' ? trajectoryDistance(validGps) : 0,
      routeChunkCount: routeChunks.length,
      recordingSessionCount: sessionIds.length,
      roadPolygonCount: allRoadPolygons.length,
      rejectedPolygonCount: totalPolygonRejections,
      largestPolygonArea: largestPolygon?.area ?? 0,
      largestPolygonWidth: largestPolygon?.width ?? 0,
      fileOverlaps: overlaps,
      maxInternalGpsGapPerChunkM: maxInternalPerChunk,
      maxGpsGapBetweenChunksM: betweenGps.maxGapM,
      maxGpsGapBetweenChunksDetail: betweenGps.detail,
      pipelineAudit,
      orderingUncertain,
      laneTrackingSummary: routeChunks.reduce((acc, c) => {
        if (c.laneTrackingSummary) acc.push(...(c.laneTrackingSummary.passes || []));
        return acc;
      }, []),
    },
    chunkDiagnostics: routeChunks.map((c) => ({
      chunkId: c.chunkId,
      sessionId: c.sessionId,
      files: c.files,
      frameCount: c.frameCount,
      gpsPointCount: c.gpsPointCount,
      startLogMonoTime: c.startLogMonoTime,
      endLogMonoTime: c.endLogMonoTime,
      durationSec: c.durationSec,
      distanceM: c.distanceM,
      startGps: c.startGps,
      endGps: c.endGps,
      maxInternalGpsGapM: c.maxInternalGpsGapM,
      rawGpsMaxGapM: c.rawGpsMaxGapM,
      sdDiagnostics: c.sdDiagnostics,
      passCoverage: c.passCoverage,
      passDiagnostics: c.passDiagnostics,
      passCount: c.passCoverage?.length ?? 0,
      fusionSkipped: c.fusionSkipped ?? false,
      segmentQualification: c.segmentQualification ?? [],
      fusedLaneFragmentCount: c.fusedLaneLines?.length ?? 0,
      roadSurfacePolygonCount: c.roadSurfacePolygons?.length ?? 0,
      geometryRejectionCount: c.polygonRejections?.length ?? 0,
    })),
  };
}

function filterContinuousGpsPoints(gpsPoints, maxGapM) {
  if (!gpsPoints?.length) return { segments: [], maxInternalGapM: 0 };
  const segments = [];
  let current = [gpsPoints[0]];
  let maxInternalGapM = 0;

  for (let i = 1; i < gpsPoints.length; i++) {
    const gap = dist2d(gpsPoints[i - 1], gpsPoints[i]);
    maxInternalGapM = Math.max(maxInternalGapM, gap);
    if (gap > maxGapM) {
      if (current.length) segments.push(current);
      current = [gpsPoints[i]];
    } else {
      current.push(gpsPoints[i]);
    }
  }
  if (current.length) segments.push(current);
  return { segments, maxInternalGapM };
}

function maxGapBetweenChunks(chunks) {
  let max = 0;
  let detail = null;
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1].gpsTrajectory;
    const cur = chunks[i].gpsTrajectory;
    if (!prev?.length || !cur?.length) continue;
    const gap = dist2d(prev[prev.length - 1], cur[0]);
    if (gap > max) {
      max = gap;
      detail = {
        prevChunkId: chunks[i - 1].chunkId,
        nextChunkId: chunks[i].chunkId,
        prevFile: prev[prev.length - 1].sourceFile,
        nextFile: cur[0].sourceFile,
        distanceM: gap,
      };
    }
  }
  return { maxGapM: max, detail };
}

function buildPipelineAudit(modelEvents, gpsEvents, sortedModels, transformedFrames, rejectedFrames, opts) {
  const file = modelEvents.length ? modelEvents[0].sourceFile : null;
  const fileModels = sortedModels.filter((m) => !file || m.sourceFile === file);

  let withGeom = 0;
  for (const ev of fileModels) {
    const geom = extractModelGeometry(ev.modelV2, { minLaneProb: opts.minLaneProb, maxForwardM: opts.maxForwardM });
    if (geom.laneLines.length || geom.roadEdges.length || geom.path) withGeom++;
  }

  const t0 = fileModels.length ? BigInt(fileModels[0].logMonoTime) : 0n;
  const t1 = fileModels.length ? BigInt(fileModels[fileModels.length - 1].logMonoTime) : 0n;
  const durationSec = fileModels.length > 1 ? Number(t1 - t0) / 1e9 : 0;

  return {
    sourceFile: file,
    qlogDurationSec: durationSec,
    decodedModelV2Events: fileModels.length,
    modelV2FrequencyHz: durationSec > 0 ? (fileModels.length - 1) / durationSec : 0,
    modelEventsWithGeometry: withGeom,
    gpsAlignedFrames: transformedFrames.length,
    rejectedGpsAlignment: rejectedFrames,
    rejectionReason: rejectedFrames > 0 ? 'modelGpsDeltaExceeded or no GPS fix' : null,
    timelineFrames: transformedFrames.length,
    renderedFrames: transformedFrames.length,
    downsamplingInterval: null,
    meaningOfFrameCount: 'transformed frames after GPS alignment (not all decoded modelV2 events)',
  };
}

function hasChangingPositions(gps) {
  const threshold = 0.00001;
  for (let i = 1; i < gps.length; i++) {
    if (Math.abs(gps[i].latitude - gps[0].latitude) > threshold) return true;
    if (Math.abs(gps[i].longitude - gps[0].longitude) > threshold) return true;
  }
  return false;
}

function buildTimeline(frames) {
  return frames.map((f, i) => ({
    index: i,
    logMonoTime: f.logMonoTime,
    sourceFile: f.sourceFile,
    frameId: f.frameId,
    chunkId: f.chunkId,
    speed: f.pose?.speed ?? 0,
    bearingDeg: f.pose?.headingDeg ?? 0,
    headingSource: f.pose?.headingSource ?? 'n/a',
    gpsAccuracy: f.pose?.horizontalAccuracy ?? 0,
    laneCount: (f.lanes || []).length,
    laneProbs: (f.lanes || []).map((l) => l.prob),
  }));
}

module.exports = {
  processRoute,
  buildTimeline,
  hasChangingPositions,
  filterContinuousGpsPoints,
  maxGapBetweenChunks,
  buildPipelineAudit,
};
