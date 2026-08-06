'use strict';

/**
 * Segment 2 cleaned-run audit, separation classification, fusion-bin audit, Mode 6 diagnosis.
 * Usage: node scripts/audit_segment2_cleaned_runs.js
 */

const fs = require('fs');
const path = require('path');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
const SLM = require('../lib/segment_local_map');
const LMC = require('../lib/lane_map_cleanup');
const { auditCleanedRuns, SEP_CLASSES } = require('../lib/lane_run_audit');
const { auditTrackBins } = require('../lib/fusion_bins');
const { collectLaneObservations } = require('../lib/sd_fusion');
const { buildReferenceTrajectory } = require('../lib/trajectory');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEG = path.join(ROOT, 'qlog_f449c_2.bz2');
const OUT = path.join(ROOT, 'audit_segment2_cleaned_runs.json');

function loadSegment() {
  const modelEvents = extractModel(SEG).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const gpsEvents = extractGps(SEG).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
  return { ...result, timeline };
}

function tracePolylineSource(run) {
  const frags = run.sourceFragments || [];
  return {
    representation: 'full fused lane geometry (all sdPoints from joined fused fragments projected to map)',
    usesObservationMidpoints: false,
    usesEndpointsOnly: false,
    fusedFragmentCount: frags.length,
    fusedPointCount: frags.reduce((n, f) => n + (f.points?.length || 0), 0),
    sdPointCount: frags.reduce((n, f) => n + (f.sdPoints?.length || 0), 0),
  };
}

function diagnoseMode6Surface(data, cleanup, chunk) {
  const allPolys = chunk.roadSurfacePolygons || [];
  const cleanedMap = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleanedWithSurface', timelineIndex: 16 });
  const filtered = LMC.filterRoadSurfaceForCleanedLanes(allPolys, cleanup.cleaned, cleanup.physicalBoundaryGroups);
  const bounds = cleanedMap.roadSurfaceBounds;

  const pairs = [];
  const leftTracks = cleanup.physicalBoundaryGroups.filter((g) => g.side === 'left');
  const rightGroups = cleanup.physicalBoundaryGroups.filter((g) => g.side === 'right');
  for (const left of leftTracks) {
    for (const right of rightGroups) {
      for (const lt of left.trackIds) {
        for (const rt of right.trackIds) {
          const overlapPolys = filtered.filter((p) => p.sourceLeftTrackId === lt && p.sourceRightTrackId === rt);
          if (!overlapPolys.length) continue;
          pairs.push({
            pairId: `L${lt}-R${rt}`,
            leftTrackId: lt,
            rightTrackId: rt,
            leftPhysicalBoundaryId: left.physicalBoundaryId,
            rightPhysicalBoundaryId: right.physicalBoundaryId,
            polygonCount: overlapPolys.length,
            overlapIntervals: overlapPolys.map((p) => p.stats?.sRange || null),
            totalArea: overlapPolys.reduce((s, p) => s + (p.stats?.area || 0), 0),
          });
        }
      }
    }
  }

  return {
    cleanedLeftRightPairCount: pairs.length,
    pairs,
    polygonPipeline: {
      generatedInChunk: allPolys.length,
      reachingFrontendAfterFilter: filtered.length,
      reachingCleanedWithSurfaceMap: cleanedMap.roadSurfacePolygonCount,
      passingValidation: filtered.length,
      surfaceTypes: [...new Set(filtered.map((p) => p.surfaceType))],
      sRanges: filtered.map((p) => p.stats?.sRange),
      bounds: bounds,
      medianWidth: filtered.length
        ? filtered.reduce((s, p) => s + (p.stats?.medianWidth || 0), 0) / filtered.length
        : null,
    },
    likelyInvisibleReason: [
      filtered.length === 0 ? 'noCompatibleBoundaryOverlap' : null,
      filtered.every((p) => (p.stats?.area || 0) < 20) ? 'polygonsTooSmall' : null,
      filtered.every((p) => (p.stats?.medianWidth || 0) < 2) ? 'polygonsTooNarrow' : null,
      'surfaceOnlyCoversPostDropoutRegion (s~332+)',
      'fillOpacityRgba035MayBeLowAgainstGreyBackground',
      'laneLinesDrawnAboveSurfaceMayObscureNarrowFill',
    ].filter(Boolean),
    primaryCause: 'Road surface polygons only exist where track 2 (post-dropout left) overlaps track 0 (right); pre-dropout region has no L/R pair with fused overlap, so Mode 6 appears identical to Mode 5 except for faint fill after s~332',
  };
}

function main() {
  if (!fs.existsSync(SEG)) {
    console.error('Missing', SEG);
    process.exit(1);
  }
  const data = loadSegment();
  const chunk = data.routeChunks[0];
  const trajectory = buildReferenceTrajectory(chunk.frames);
  const laneObs = collectLaneObservations(chunk.frames, trajectory);

  const cleanup = LMC.buildCleanedLaneMap({
    frames: chunk.frames,
    fusedLanes: chunk.fusedLaneLines,
    tracks: chunk.laneTracks,
    chunkId: 0,
    passId: 0,
  });

  const fusionBinAudits = [0, 1, 2, 3, 4].map((tid) => auditTrackBins(laneObs, tid, chunk.frames, trajectory));

  const rejectedBins = fusionBinAudits.flatMap((a) => a.bins.filter((b) => !b.accepted));
  const rejectedBinSummary = rejectedBins.reduce((acc, b) => {
    const r = b.rejectionReason || 'unknown';
    acc[r] = (acc[r] || 0) + 1;
    return acc;
  }, {});

  const audit = auditCleanedRuns({
    frames: chunk.frames,
    fusedLanes: chunk.fusedLaneLines,
    tracks: chunk.laneTracks,
    cleaned: cleanup.cleaned,
    mergeDecisions: cleanup.mergeDecisions,
    physicalBoundaryGroups: cleanup.physicalBoundaryGroups,
    chunkId: 0,
    passId: 0,
  });

  const polylineTraces = cleanup.cleaned.map((run) => ({
    runId: run.runIndex,
    physicalBoundaryId: run.physicalBoundaryId,
    trackIds: run.logicalGroupTrackIds,
    ...tracePolylineSource(run),
    sourceFusedLengthM: run.sourceFusedLengthM,
    cleanedLengthM: run.lengthM,
    renderedLengthM: run.lengthM,
    lengthRetention: run.sourceFusedLengthM > 0 ? run.lengthM / run.sourceFusedLengthM : 1,
  }));

  const mode6 = diagnoseMode6Surface(data, cleanup, chunk);

  const report = {
    ...audit,
    beforeAfter: {
      cleanedRunCountBefore: 30,
      cleanedRunCountAfter: cleanup.stats.cleanedRunCount,
      physicalBoundaryGroupCount: cleanup.stats.physicalBoundaryGroupCount,
      joinsPerformed: cleanup.stats.joinsPerformed,
      joinsRejected: cleanup.stats.joinsRejected,
    },
    physicalBoundaryVerification: cleanup.physicalBoundaryGroups.map((g) => ({
      ...g,
      trackStats: g.trackIds.map((tid) => cleanup.trackStats[tid]),
    })),
    adaptiveJoinInfo: cleanup.adaptiveJoinInfo,
    fusionBinRejection: {
      rejectedBinSummary,
      rejectedBins: rejectedBins.slice(0, 50),
      trackSummaries: fusionBinAudits.map((a) => a.summary),
    },
    polylineSourceTraces: polylineTraces,
    mode6Diagnosis: mode6,
    crossings: { before: 0, after: cleanup.stats.crossingCount },
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    out: OUT,
    runs: cleanup.stats.cleanedRunCount,
    groups: cleanup.stats.physicalBoundaryGroupCount,
    separations: audit.separationCount,
    classificationSummary: audit.classificationSummary,
    mode6polygons: mode6.polygonPipeline.reachingCleanedWithSurfaceMap,
  }, null, 2));
}

main();
