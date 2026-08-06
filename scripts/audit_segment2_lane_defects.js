'use strict';

/**
 * Segment 2 lane defect audit for local playback cleanup.
 * Usage: node scripts/audit_segment2_lane_defects.js
 */

const fs = require('fs');
const path = require('path');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
const SLM = require('../lib/segment_local_map');
const LMC = require('../lib/lane_map_cleanup');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEG = path.join(ROOT, 'qlog_f449c_2.bz2');
const OUT = path.join(ROOT, 'audit_segment2_lane_defects.json');

function loadSegment() {
  const modelEvents = extractModel(SEG).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const gpsEvents = extractGps(SEG).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
  return { ...result, timeline };
}

function modeReport(data, geometrySource) {
  const map = SLM.freezeStationaryMapGeometry(
    SLM.buildSegmentLocalMap(data, { geometrySource, timelineIndex: 0 }),
  );
  return {
    geometrySource,
    laneFragmentCount: map.laneFragmentCount,
    laneChecksum: map.laneChecksum,
    roadSurfacePolygonCount: map.roadSurfacePolygonCount,
    cleanupStats: map.laneCleanup?.stats ?? null,
  };
}

function auditObservations(data) {
  const chunk = data.routeChunks[0];
  const obsCount = data.frames.reduce((n, f) => n + (f.lanes?.length || 0), 0);
  const tracks = (chunk.laneTracks || []).map((t) => ({
    trackId: t.trackId,
    frameIds: t.frameIds,
    frameSpan: t.frameIds?.length
      ? `${Math.min(...t.frameIds.map((id) => data.frames.findIndex((f) => f.frameId === id)))}-${Math.max(...t.frameIds.map((id) => data.frames.findIndex((f) => f.frameId === id)))}`
      : null,
    fusedFragments: (chunk.fusedLaneLines || []).filter((f) => f.laneTrackId === t.trackId).length,
    stats: LMC.trackSdStats((chunk.fusedLaneLines || []).filter((f) => f.laneTrackId === t.trackId)),
  }));
  return { perFrameLaneObservations: obsCount, tracks };
}

function main() {
  if (!fs.existsSync(SEG)) {
    console.error('Missing', SEG);
    process.exit(1);
  }
  const data = loadSegment();
  const chunk = data.routeChunks[0];
  const cleanup = LMC.buildCleanedLaneMap({
    frames: data.frames,
    fusedLanes: chunk.fusedLaneLines,
    tracks: chunk.laneTracks,
    chunkId: 0,
    passId: 0,
  });

  let crossingBefore = 0;
  const fusedFrags = chunk.fusedLaneLines || [];
  for (let i = 0; i < fusedFrags.length; i++) {
    for (let j = i + 1; j < fusedFrags.length; j++) {
      if (LMC.segmentCrosses(fusedFrags[i].points, fusedFrags[j].points)) crossingBefore++;
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    segment: 'qlog_f449c_2.bz2',
    colorLegend: {
      blue: 'TRACK_COLORS[0] / lane index 0 — track 0 right boundary',
      red: 'TRACK_COLORS[1] — track 1 left boundary (early segment)',
      green: 'TRACK_COLORS[2] — track 2 left boundary (late segment)',
      purple: 'TRACK_COLORS[4] — track 3 outer left',
      observationMode: 'cycles LANE_COLORS by fragment index (not track identity)',
    },
    displayLayers: {
      observations: 'All per-frame mapped lane polylines (buildObservationFragments)',
      tracked: 'Midpoint polyline per lane track (buildTrackedPolylines)',
      fused: 'chunk.fusedLaneLines transformed to segment-local frame',
      rejected: 'lane_map_cleanup rejected fragments',
      cleaned: 'Evidence-based fused track runs with gaps preserved',
      cleanedWithSurface: 'cleaned lanes + road surface filtered to validated track pairs',
    },
    rootCause: {
      duplicatedParallelLines: 'observations mode draws every per-frame lane fragment separately (53 on seg2)',
      branches: 'Multiple fragments per track across s-bins appear as parallel branches in observation mode',
      lateralJumps: 'Raw frame observations vary in lateral offset; not track-associated in observation mode',
      stageIntroducingMess: 'rendering/geometrySource=observations (default diagnostic mode)',
    },
    observations: auditObservations(data),
    modes: [
      'observations', 'tracked', 'fused', 'rejected', 'cleaned', 'cleanedWithSurface',
    ].map((m) => modeReport(data, m)),
    cleanup: {
      stats: cleanup.stats,
      mergeGroups: cleanup.mergeGroups,
      suppressedTrackIds: cleanup.suppressedTrackIds,
      audit: cleanup.audit,
      crossingCountBefore: crossingBefore,
      crossingCountAfter: cleanup.stats.crossingCount,
      cleanedRunCount: cleanup.stats.cleanedRunCount,
      trackCoverage: cleanup.cleaned.map((r) => ({
        laneTrackId: r.laneTrackId,
        lengthM: r.lengthM,
        sMin: r.sMin,
        sMax: r.sMax,
        lateralOrder: r.lateralOrder,
      })),
    },
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    out: OUT,
    obsFragments: report.modes.find((m) => m.geometrySource === 'observations').laneFragmentCount,
    cleanedRuns: cleanup.stats.cleanedRunCount,
    crossingBefore: crossingBefore,
    crossingAfter: cleanup.stats.crossingCount,
  }, null, 2));
}

main();
