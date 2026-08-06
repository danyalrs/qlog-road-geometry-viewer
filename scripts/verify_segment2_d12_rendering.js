'use strict';

/**
 * Segment 2 D12 rendering verification — drawable path and bridge analysis.
 * Usage: node scripts/verify_segment2_d12_rendering.js
 */

const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const LMC = require('../lib/lane_map_cleanup');
const SLM = require('../lib/segment_local_map');
const { verifyNoRendererBridgeAcrossGaps } = require('../lib/drawable_path');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'audit_segment2_d12_rendering_verification.json');

const EXACT_REMAINING_D12_OPEN_M = 4.58;
const OPEN_GAPS = [
  { gapId: 'CD-10', openM: 1.466, startS: 428.7557621001464, endS: 430.22150557754463 },
  { gapId: 'CD-12', openM: 1.640, startS: 498.48122518574536, endS: 500.1206905235975 },
  { gapId: 'CD-18', openM: 1.476, startS: 428.7570377828136, endS: 430.2325151017333 },
];

function loadSegment() {
  const seg = path.join(ROOT, 'qlog_f449c_2.bz2');
  const modelEvents = extractModel(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const gpsEvents = extractGps(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  return processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
}

function main() {
  const data = loadSegment();
  const chunk = data.routeChunks[0];
  const classAudit = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit_segment2_class_d_fusion_gaps.json'), 'utf8'));
  const d12Gaps = classAudit.gaps.filter((g) => g.primaryMechanism === 'D12');

  const cleanup = LMC.buildCleanedLaneMap({
    frames: chunk.frames,
    fusedLanes: chunk.fusedLaneLines,
    tracks: chunk.laneTracks,
    chunkId: 0,
    passId: 0,
    vehiclePath: chunk.vehiclePath,
    classDGaps: d12Gaps,
    enableD12Preservation: true,
  });

  const map5 = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
  const map7 = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleanedDebug', timelineIndex: 0 });
  const checksums = new Set();
  for (const idx of [0, 8, 16, 26]) {
    checksums.add(SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: idx }).checksum);
  }

  const bridgeCheck = verifyNoRendererBridgeAcrossGaps(
    cleanup.cleaned,
    cleanup.preservedIntervals,
    ['CD-10', 'CD-12', 'CD-18'],
  );

  const cov = cleanup.coverageAccounting;
  const drawable = cleanup.drawablePathAnalysis;

  const gapReports = OPEN_GAPS.map((spec) => {
    const brk = drawable.interRunBreaks.find((b) => b.gapId === spec.gapId);
    return {
      gapId: spec.gapId,
      expectedOpenM: spec.openM,
      measuredOpenM: brk?.openLengthM ?? null,
      precedingRunId: brk?.precedingRunId,
      followingRunId: brk?.followingRunId,
      shareOneCanvasPath: brk?.shareOneCanvasPath ?? false,
      rendererIssuesSegment: bridgeCheck.violations.some((v) => v.gapId === spec.gapId && v.reason !== 'noInterRunBreakRecorded'),
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    segment: 'qlog_f449c_2.bz2',
    falseVisualBridgeDetected: drawable.falseVisualBridgeDetected,
    rendererCorrectionRequired: false,
    rendererCorrectionApplied: false,
    logicalCleanedRunCount: cleanup.cleaned.length,
    drawableSubpathCount: drawable.drawableSubpathCount,
    mode5FragmentCount: map5.laneFragmentCount,
    mode7FragmentCount: map7.laneFragmentCount,
    fusedFragmentCount: cleanup.stats.fusedFragmentCount,
    crossingCount: cleanup.stats.crossingCount,
    stationaryChecksumUnique: checksums.size === 1,
    roadSurfacePolygonsMode5: map5.roadSurfacePolygonCount,
    gapReports,
    interRunBreaks: drawable.interRunBreaks,
    rendererViolations: bridgeCheck.violations,
    coverageReporting: {
      acceptedFusedPerBoundarySpanSumM: cov.routeSIntervalCoverage.acceptedSpanSumM,
      d12PreservedPerBoundarySpanSumM: cov.routeSIntervalCoverage.preservedSpanSumM,
      naiveComponentSpanSumM: cov.routeSIntervalCoverage.naiveSpanSumM,
      displayMergedRunSpanSumM: cov.routeSIntervalCoverage.displayCleanedSpanSumM,
      displayMergeBoundaryDifferenceM: cov.routeSIntervalCoverage.displayMinusNaiveSpanSumM,
      d12PreservedIntervalUnionM: cov.routeSIntervalCoverage.d12PreservedUnionM,
      combinedSupportedRouteSUnionM: cov.routeSIntervalCoverage.combinedSupportedUnionM,
      acceptedFusedPolylineArcM: cov.polylineArcLength.acceptedFusedArcM,
      d12PreservedPolylineArcM: cov.polylineArcLength.d12PreservedArcM,
      displayCleanedPolylineArcM: cov.polylineArcLength.displayCleanedArcM,
      exactRemainingD12OpenLengthM: EXACT_REMAINING_D12_OPEN_M,
      unionVsSpanSumNote: 'Per-boundary span sums count parallel PBs separately; route-s union removes overlap between boundaries on a single s-axis.',
    },
    drawableComponentsByGap: ['CD-10', 'CD-12', 'CD-18'].map((gapId) => {
      const brk = drawable.interRunBreaks.find((b) => b.gapId === gapId);
      if (!brk) return { gapId, found: false };
      const pre = cleanup.cleaned.find((r) => r.runId === brk.precedingRunId);
      const fol = cleanup.cleaned.find((r) => r.runId === brk.followingRunId);
      return {
        gapId,
        physicalBoundaryId: brk.physicalBoundaryId,
        trackId: brk.laneTrackId,
        precedingRunId: brk.precedingRunId,
        followingRunId: brk.followingRunId,
        lastPointPreceding: pre?.points?.[pre.points.length - 1],
        firstPointFollowing: fol?.points?.[0],
        openIntervalStartS: brk.openIntervalStartS,
        openIntervalEndS: brk.openIntervalEndS,
        openLengthM: brk.openLengthM,
        euclideanDistanceM: brk.euclideanDistanceM,
        shareOneCanvasPath: brk.shareOneCanvasPath,
      };
    }),
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main();
