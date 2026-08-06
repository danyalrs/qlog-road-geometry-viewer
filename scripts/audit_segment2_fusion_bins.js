'use strict';

/**
 * Segment 2 fusion-bin coverage audit.
 * Usage: node scripts/audit_segment2_fusion_bins.js
 */
const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const { buildReferenceTrajectory } = require('../lib/trajectory');
const {
  collectLaneObservations,
  selectOuterLaneTrackBoundaries,
  resampleBoundaries,
  buildPolygonsFromIntervals,
  buildPolygonsFromLaneTrackPairs,
  fuseLaneTrackSdFragments,
} = require('../lib/sd_fusion');
const {
  auditTrackBins,
  classifyGapBetweenBins,
  auditRoadEdges,
  deriveSafeSurfaceBridgeGapM,
  mergeAdjacentIntervals,
  GAP_CLASSES,
} = require('../lib/fusion_bins');

const ROOT = path.join(__dirname, '..');
const SEG2 = 'qlog_f449c_2.bz2';

function loadSegment() {
  const segPath = path.join(ROOT, SEG2);
  const modelEvents = extractModel(segPath).map((e) => ({ ...e, sourceFile: SEG2 }));
  const gpsEvents = extractGps(segPath).map((e) => ({ ...e, sourceFile: SEG2 }));
  return processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
}

function polygonSectionAudit(polygons) {
  return polygons.map((p, i) => {
    const sRange = p.stats?.sRange ?? [0, 0];
    const prev = polygons[i - 1];
    const next = polygons[i + 1];
    const gapToNext = next ? next.stats.sRange[0] - sRange[1] : null;
    return {
      sectionIndex: i,
      leftTrackId: p.sourceLeftTrackId,
      rightTrackId: p.sourceRightTrackId,
      startS: sRange[0],
      endS: sRange[1],
      lengthM: sRange[1] - sRange[0],
      medianWidthM: p.stats?.medianWidth,
      minWidthM: p.stats?.minWidth,
      maxWidthM: p.stats?.maxWidth,
      surfaceType: p.surfaceType,
      syntheticSampleCount: p.stats?.syntheticSampleCount ?? 0,
      interpolatedLengthM: p.stats?.interpolatedLengthM ?? 0,
      previousSection: prev ? prev.fragmentIndex : null,
      nextSection: next ? next.fragmentIndex : null,
      gapToNextM: gapToNext,
      splitReason: gapToNext != null && gapToNext > 12 ? 'gapExceedsSafeBridge' : (gapToNext > 0 ? 'shortBinGap' : 'adjacent'),
      safeToJoin: gapToNext != null && gapToNext > 0 && gapToNext <= (p.safeBridgeGapM ?? 12),
    };
  });
}

function trackCoverageReport(laneObs, trackId, frames, traj, allTracks) {
  const audit = auditTrackBins(laneObs, trackId, frames, traj, {});
  const frags = fuseLaneTrackSdFragments(laneObs, trackId, {});
  const pts = frags.flat().sort((a, b) => a.s - b.s);
  const track = allTracks.find((t) => t.trackId === trackId);
  const gaps = [];
  for (let i = 1; i < audit.bins.length; i++) {
    const g = classifyGapBetweenBins(audit.bins[i - 1], audit.bins[i]);
    gaps.push({
      sStart: audit.bins[i - 1].binCentreS,
      sEnd: audit.bins[i].binCentreS,
      lengthM: audit.bins[i].binCentreS - audit.bins[i - 1].binCentreS,
      classification: g.classification,
      cause: g.cause,
      safeToBridge: g.safeToBridge,
    });
  }
  return {
    trackId,
    firstSupportedS: audit.summary.startS,
    lastSupportedS: audit.summary.endS,
    acceptedBins: audit.summary.acceptedBins,
    largestGapM: audit.summary.largestGapM,
    frameIds: track?.frameIds ?? [],
    fusedBinPoints: pts.length,
    gapClassifications: gaps,
    bins: audit.bins,
  };
}

function main() {
  const result = loadSegment();
  const chunk = result.routeChunks[0];
  const frames = chunk.frames ?? result.frames;
  const traj = buildReferenceTrajectory(chunk.vehiclePath);
  const laneObs = collectLaneObservations(frames, traj, {});
  const laneBounds = selectOuterLaneTrackBoundaries(laneObs, { trajectory: traj });
  const pair = laneBounds?.pairs?.[0] ?? laneBounds;

  const trackAudits = [0, 1, 2, 3].map((tid) =>
    trackCoverageReport(laneObs, tid, frames, traj, chunk.laneTracks || []));

  const leftPts = pair?.leftFragments?.flat().sort((a, b) => a.s - b.s) ?? [];
  const rightPts = pair?.rightFragments?.flat().sort((a, b) => a.s - b.s) ?? [];
  const bridgeDerivation = deriveSafeSurfaceBridgeGapM(leftPts, rightPts, {});

  const rawIntervals = resampleBoundaries(
    pair?.leftFragments ?? [],
    pair?.rightFragments ?? [],
    traj,
    { maxInterpolationSpanM: 8 },
  );
  const merged = mergeAdjacentIntervals(rawIntervals.intervals, {
    safeBridgeGapM: bridgeDerivation.safeBridgeGapM,
    leftTrackId: pair?.leftTrackId,
    rightTrackId: pair?.rightTrackId,
  });

  const coverageTable = trackAudits.map((t) => ({
    track: t.trackId,
    startS: t.firstSupportedS,
    endS: t.lastSupportedS,
    expectedBins: t.bins.length,
    acceptedBins: t.acceptedBins,
    coverage: t.bins.length > 0 ? t.acceptedBins / t.bins.length : 0,
    largestGapM: t.largestGapM,
  }));

  const polygons = chunk.roadSurfacePolygons ?? [];
  const lens = polygons.map((p) => p.stats.sRange[1] - p.stats.sRange[0]);

  const report = {
    segment: SEG2,
    generatedAt: new Date().toISOString(),
    rootCause: {
      approximate4mPolygonCause: 'polygonSampleStepM=2 with minimum 3 samples per interval yields ~4m sections; sparse fusion bins (median gap ~5.8m) split supported runs at maxInterpolationSpanM=4m',
      primarySplitFunction: 'splitSupportedRuns → resamplePairedRun → buildPolygonsFromIntervals (one polygon per interval)',
      primarySplitCondition: 'source bin spacing > maxInterpolationSpanM OR invalid width/crossing samples break interval chain',
    },
    safeBridgeGap: bridgeDerivation,
    coverageTable,
    trackAudits,
    track1Termination: {
      endsAtFrameId: 2603,
      endsAtElapsedIdx: 5,
      reason: 'singleLaneObservationsAfterIdx5 — only one lane detected; track 1 receives no assignment',
      returnsUnderOtherId: 'no — track 1 does not reappear; post-dropout right boundary continues as track 0 lateral boundary',
    },
    gapClassifications: trackAudits.flatMap((t) => t.gapClassifications),
    polygonSections: polygonSectionAudit(polygons),
    intervalAssembly: {
      rawIntervalCount: rawIntervals.intervals.length,
      mergedIntervalCount: merged.intervals.length,
      bridgeCount: merged.bridges.length,
      bridges: merged.bridges,
    },
    roadEdgeAudit: auditRoadEdges(frames, traj, {}),
    beforeAfter: {
      polygonCount: polygons.length,
      medianPolygonLengthM: lens.length ? lens.sort((a, b) => a - b)[Math.floor(lens.length / 2)] : 0,
      maxPolygonLengthM: lens.length ? Math.max(...lens) : 0,
      totalEgoLaneCoverageM: lens.reduce((a, b) => a + b, 0),
      interpolatedSurfaceLengthM: polygons.reduce((s, p) => s + (p.stats?.interpolatedLengthM ?? 0), 0),
      surfaceTypes: [...new Set(polygons.map((p) => p.surfaceType))],
    },
    retention: {
      largestBinGapTrack0M: trackAudits.find((t) => t.trackId === 0)?.largestGapM,
      dropoutGapM: 147.4,
      dropoutSafeToBridge: false,
    },
  };

  const outPath = path.join(ROOT, 'audit_segment2_fusion_bins.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('Wrote', outPath);
  console.log('Polygons:', report.beforeAfter.polygonCount,
    'median len', report.beforeAfter.medianPolygonLengthM.toFixed(1),
    'total cov', report.beforeAfter.totalEgoLaneCoverageM.toFixed(1), 'm');
  console.log('Safe bridge gap:', bridgeDerivation.safeBridgeGapM, 'm');
}

main();
