'use strict';

/**
 * Production viewer map build helpers. Mirrors the browser/server path:
 *   loadSegmentsData → processRoute → enrichTimelineWithMovement
 *   → buildSegmentLocalMap(pointAccumulated, timelineIndex 0, viewer options)
 *
 * Probes and tests must use this module instead of calling buildPointAccumulatedFragments
 * with ad-hoc reference poses.
 */

const path = require('path');
const { processRoute, buildTimeline } = require('./process_route');
const { enrichTimelineWithMovement } = require('./vehicle_movement_display');
const { normalizeProcessOptions } = require('./process_defaults');
const { PROCESSING_VERSION } = require('./version');
const { loadSegmentsData } = require('./qlog_data');
const { qualifySegments } = require('./segment_qualify');
const SLM = require('./segment_local_map');
const GF = require('./graph_fit');
const PointAccumulation = require('./point_accumulation');

/** Default /api/process options matching public/index.html control defaults. */
const VIEWER_DEFAULT_PROCESS_OPTIONS = normalizeProcessOptions({
  minLaneProb: 0.5,
  maxAccuracyM: 50,
  maxModelGpsDeltaNs: 2 * 1e9,
  maxForwardM: 120,
  fusionIntervalM: 2,
  minSpeedForGpsBearing: 2,
  maxTimeGapSec: 3,
  maxGpsGapM: 30,
  maxImpliedSpeedMps: 55,
  maxLaneFragmentGapM: 10,
  maxRoadEdgeGapM: 10,
  pipelineMode: 'C',
  laneTrackingEnabled: true,
  localSupportFilter: true,
});

/** Local playback map options matching app.js localPlaybackOptions + point mode. */
function viewerLocalMapOptions({ fitEnabled = true } = {}) {
  return {
    geometrySource: 'pointAccumulated',
    timelineIndex: 0,
    minHeadingSpeedMps: VIEWER_DEFAULT_PROCESS_OPTIONS.minSpeedForGpsBearing,
    fitEnabled: !!fitEnabled,
  };
}

function processSegmentLikeViewer(rootDir, segmentFile, options = {}) {
  const merged = normalizeProcessOptions({ ...VIEWER_DEFAULT_PROCESS_OPTIONS, ...options });
  const loaded = loadSegmentsData(rootDir, [segmentFile], merged);
  const segmentQualifications = qualifySegments(loaded.audits);
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
    ...merged,
    segmentQualifications,
    poseSourceReport: loaded.poseSourceReports.length === 1
      ? loaded.poseSourceReports[0]
      : loaded.poseSourceReports,
    fileAudits: loaded.audits,
  });
  const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
  return {
    processingVersion: PROCESSING_VERSION,
    processingOptions: merged,
    mode: result.mode,
    stats: result.stats,
    routeChunks: result.routeChunks,
    vehiclePath: result.vehiclePath,
    frames: result.frames,
    timeline,
    fileAudits: loaded.audits,
  };
}

function buildViewerStationaryMap(processData, { fitEnabled = true } = {}) {
  const map = SLM.buildSegmentLocalMap(processData, viewerLocalMapOptions({ fitEnabled }));
  return SLM.freezeStationaryMapGeometry ? SLM.freezeStationaryMapGeometry(map) : map;
}

function summarizeFitResults(fittedPolylines) {
  const results = fittedPolylines?.results || [];
  const statusCounts = { ...(fittedPolylines?.statusCounts || {}) };
  for (const r of results) {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  }
  const accepted = results.filter((r) => r.status === 'accepted');
  return {
    acceptedCount: accepted.length,
    acceptedIds: accepted.map((r) => r.fragmentId).sort(),
    statusCounts,
    fitEnabled: !!fittedPolylines?.stats?.fitEnabled,
    fitConfig: { ...GF.GRAPH_FIT_DEFAULTS, fitEnabled: !!fittedPolylines?.stats?.fitEnabled },
  };
}

function trajectoryDiagnostics(processData, map) {
  const chunk = processData.routeChunks?.[0];
  const vehiclePath = chunk?.vehiclePath || [];
  const builtTrajectory = vehiclePath.length >= 2
    ? PointAccumulation.buildReferenceTrajectory(vehiclePath)
    : null;
  const totalLength = builtTrajectory?.totalLength ?? null;
  const isStationary = GF.isDegenerateTrajectory(builtTrajectory);
  return {
    vehiclePathPoints: vehiclePath.length,
    builtTrajectoryPoints: builtTrajectory?.points?.length ?? 0,
    builtTrajectoryTotalLengthM: totalLength,
    isStationary,
    referencePose: map?.referencePose ?? null,
  };
}

function summarizeViewerSegment(rootDir, segmentFile, { fitEnabled = true } = {}) {
  const processData = processSegmentLikeViewer(rootDir, segmentFile);
  const mapOff = buildViewerStationaryMap(processData, { fitEnabled: false });
  const mapOn = buildViewerStationaryMap(processData, { fitEnabled });
  const paOff = mapOff.pointAccumulated;
  const paOn = mapOn.pointAccumulated;
  const fitOff = summarizeFitResults(paOff?.fittedPolylines);
  const fitOn = summarizeFitResults(paOn?.fittedPolylines);
  const segNum = parseInt(String(segmentFile).match(/_(\d+)\.bz2$/i)?.[1] ?? '0', 10);
  return {
    segNum,
    segmentFile,
    processingVersion: processData.processingVersion,
    fitOff,
    fitOn,
    polygonCountOff: mapOff.roadSurfacePolygonCount ?? mapOff.roadSurfacePolygons?.length ?? 0,
    polygonCountOn: mapOn.roadSurfacePolygonCount ?? mapOn.roadSurfacePolygons?.length ?? 0,
    polygonUnchanged: (mapOff.roadSurfacePolygonCount ?? 0) === (mapOn.roadSurfacePolygonCount ?? 0),
    fragmentCount: paOn?.constructedFragments?.fragments?.length ?? 0,
    pointCount: paOn?.points?.length ?? 0,
    trajectory: trajectoryDiagnostics(processData, mapOn),
    mapValid: mapOn.valid,
    checksum: mapOn.checksum,
  };
}

function auditSegment9Boundaries(rootDir, segmentFile = 'qlog_f449c_9.bz2') {
  const processData = processSegmentLikeViewer(rootDir, segmentFile);
  const map = buildViewerStationaryMap(processData, { fitEnabled: true });
  const pa = map.pointAccumulated;
  const points = pa?.points || [];
  const byLane = { 0: [], 1: [], 2: [] };
  for (const p of points) {
    const li = p.laneIndex;
    if (li === 0 || li === 1 || li === 2) byLane[li].push(p);
  }
  const laneSummary = [0, 1, 2].map((laneIndex) => ({
    laneIndex,
    observationCount: byLane[laneIndex].length,
    distinctFrames: new Set(byLane[laneIndex].map((p) => p.frameIndex)).size,
    distinctGroupTracks: new Set(byLane[laneIndex].map((p) => p.groupTrackId)).size,
  }));
  const fragments = pa?.constructedFragments?.fragments || [];
  const fitResults = pa?.fittedPolylines?.results || [];
  const boundaryFits = fitResults.map((r) => ({
    fragmentId: r.fragmentId,
    laneIndex: r.laneIndex,
    groupTrackId: r.groupTrackId,
    status: r.status,
    reason: r.reason ?? null,
    nRaw: r.nRaw ?? null,
    distinctFrames: r.distinctFrames ?? null,
    sourceCorridor: r.sourceCorridor ?? null,
  }));
  const lane1Fragments = fragments.filter((f) => f.laneIndex === 1);
  const lane1Fits = boundaryFits.filter((b) => b.laneIndex === 1);
  const stationaryPolys = (map.roadSurfacePolygons || []).filter((p) =>
    p.fragmentKind === 'stationaryLocal' || p.surfaceType === 'egoLaneCorridor');
  const traj = trajectoryDiagnostics(processData, map);
  const collapseExample = traj.isStationary && points.length
    ? (() => {
      const sample = points.slice(0, Math.min(20, points.length)).map((p) => ({
        east: p.localEast,
        north: p.localNorth,
        frameIndex: p.frameIndex,
      }));
      const bins = GF.collapseStationary(
        points.slice(0, 200).map((p) => ({
          east: p.localEast,
          north: p.localNorth,
          mirroredEast: p.mirroredLocalEast,
          mirroredNorth: p.mirroredLocalNorth,
          s: p.s,
          d: p.d,
          frameId: p.frameId,
          frameIndex: p.frameIndex,
          weight: 1,
          score: 1,
        })),
        GF.GRAPH_FIT_DEFAULTS,
      );
      return { sampleObservations: sample.length, collapsedBinCount: bins.length };
    })()
    : null;
  return {
    segmentFile,
    processingVersion: processData.processingVersion,
    trajectory: traj,
    laneSummary,
    stationaryRepeatCollapse: collapseExample,
    fragmentCount: fragments.length,
    lane1FragmentIds: lane1Fragments.map((f) => f.fragmentId),
    lane1FitResults: lane1Fits,
    acceptedCount: fitResults.filter((r) => r.status === 'accepted').length,
    acceptedIds: fitResults.filter((r) => r.status === 'accepted').map((r) => r.fragmentId).sort(),
    boundaryFits,
    stationaryPolygonCount: stationaryPolys.length,
    totalPolygonCount: map.roadSurfacePolygonCount ?? map.roadSurfacePolygons?.length ?? 0,
    polygonsFeedFromFits: false,
  };
}

module.exports = {
  VIEWER_DEFAULT_PROCESS_OPTIONS,
  viewerLocalMapOptions,
  processSegmentLikeViewer,
  buildViewerStationaryMap,
  summarizeFitResults,
  summarizeViewerSegment,
  auditSegment9Boundaries,
  trajectoryDiagnostics,
};
