'use strict';

/**
 * Post-D12 preservation audit for Segment 2.
 * Usage: node scripts/audit_segment2_d12_preservation.js
 */

const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const LMC = require('../lib/lane_map_cleanup');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'audit_segment2_d12_preservation.json');

function loadSegment() {
  const seg = path.join(ROOT, 'qlog_f449c_2.bz2');
  const modelEvents = extractModel(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const gpsEvents = extractGps(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  return processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
}

function main() {
  const result = loadSegment();
  const chunk = result.routeChunks[0];
  const classAudit = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit_segment2_class_d_fusion_gaps.json'), 'utf8'));
  const d12Gaps = classAudit.gaps.filter((g) => g.primaryMechanism === 'D12');

  const without = LMC.buildCleanedLaneMap({
    frames: chunk.frames,
    fusedLanes: chunk.fusedLaneLines,
    tracks: chunk.laneTracks,
    chunkId: 0,
    passId: 0,
    vehiclePath: chunk.vehiclePath,
    enableD12Preservation: false,
  });

  const withPres = LMC.buildCleanedLaneMap({
    frames: chunk.frames,
    fusedLanes: chunk.fusedLaneLines,
    tracks: chunk.laneTracks,
    chunkId: 0,
    passId: 0,
    vehiclePath: chunk.vehiclePath,
    classDGaps: d12Gaps,
    enableD12Preservation: true,
  });

  const fusedLen = (frags) => frags.reduce((s, f) => {
    const pts = f.sdPoints || [];
    if (pts.length < 2) return s;
    return s + Math.abs(pts[pts.length - 1].s - pts[0].s);
  }, 0);

  const report = {
    generatedAt: new Date().toISOString(),
    segment: 'qlog_f449c_2.bz2',
    before: {
      fusedFragmentCount: without.stats.fusedFragmentCount,
      cleanedRunCount: without.cleaned.length,
      classDCount: classAudit.classDGapCount,
      classDTotalGapM: classAudit.countsBeforeCorrection.classDTotalGapM,
      acceptedFusedSpanSumM: fusedLen(without.cleanedFusedOnly || without.cleaned),
    },
    after: {
      fusedFragmentCount: withPres.stats.fusedFragmentCount,
      cleanedRunCount: withPres.cleaned.length,
      preservedIntervalCount: withPres.preservedIntervals.length,
      preservedSpanSumM: withPres.stats.preservedCoverageM,
      fullyResolvedD12: withPres.preservedIntervals.filter((p) => p.fullCoverage && !p.isTailExtension).map((p) => p.gapId),
      partiallyResolvedD12: withPres.preservedIntervals.filter((p) => !p.fullCoverage && !p.isTailExtension).map((p) => p.gapId),
      tailExtensions: withPres.preservedIntervals.filter((p) => p.isTailExtension).map((p) => ({
        gapId: p.gapId,
        parentGapId: p.parentGapId,
        sourceFrameId: p.sourceFrameId,
        preservedLengthM: p.preservedLengthM,
        remainingOpenLengthM: p.remainingOpenLengthM,
      })),
      displayCleanedSpanSumM: fusedLen(withPres.cleaned),
      acceptedFusedUnionM: withPres.stats.acceptedFusedUnionM,
      d12PreservedUnionM: withPres.stats.d12PreservedUnionM,
      combinedSupportedUnionM: withPres.stats.combinedSupportedUnionM,
      overlapAcceptedAndPreservedM: withPres.stats.overlapAcceptedAndPreservedM,
    },
    coverageAccounting: withPres.coverageAccounting,
    coverageReporting: {
      acceptedFusedPerBoundarySpanSumM: withPres.coverageAccounting?.routeSIntervalCoverage?.acceptedSpanSumM,
      d12PreservedPerBoundarySpanSumM: withPres.coverageAccounting?.routeSIntervalCoverage?.preservedSpanSumM,
      naiveComponentSpanSumM: withPres.coverageAccounting?.routeSIntervalCoverage?.naiveSpanSumM,
      displayMergedRunSpanSumM: withPres.coverageAccounting?.routeSIntervalCoverage?.displayCleanedSpanSumM,
      displayMergeBoundaryDifferenceM: withPres.coverageAccounting?.routeSIntervalCoverage?.displayMinusNaiveSpanSumM,
      d12PreservedIntervalUnionM: withPres.coverageAccounting?.routeSIntervalCoverage?.d12PreservedUnionM,
      combinedSupportedRouteSUnionM: withPres.coverageAccounting?.routeSIntervalCoverage?.combinedSupportedUnionM,
      acceptedFusedPolylineArcM: withPres.coverageAccounting?.polylineArcLength?.acceptedFusedArcM,
      d12PreservedPolylineArcM: withPres.coverageAccounting?.polylineArcLength?.d12PreservedArcM,
      displayCleanedPolylineArcM: withPres.coverageAccounting?.polylineArcLength?.displayCleanedArcM,
      exactRemainingD12OpenLengthM: 4.58,
      remainingOpenByGapM: { 'CD-10': 1.466, 'CD-12': 1.640, 'CD-18': 1.476 },
      unionVsSpanSumNote: 'Per-boundary span sums count parallel PBs separately; route-s union removes overlap between boundaries on a single s-axis. Union is not a replacement for per-boundary mapped-lane coverage.',
    },
    renderingVerification: withPres.drawablePathAnalysis ? {
      falseVisualBridgeDetected: withPres.drawablePathAnalysis.falseVisualBridgeDetected,
      logicalCleanedRunCount: withPres.drawablePathAnalysis.logicalCleanedRunCount,
      drawableSubpathCount: withPres.drawablePathAnalysis.drawableSubpathCount,
      interRunBreaks: withPres.drawablePathAnalysis.interRunBreaks,
    } : null,
    d12Candidates: withPres.preservationResults,
    preservedIntervals: withPres.preservedIntervals.map((p) => ({
      gapId: p.gapId,
      sourceFrameId: p.sourceFrameId,
      sourcePolylineId: p.sourcePolylineId,
      preservedPointCount: p.preservedPointCount,
      preservedLengthM: p.preservedLengthM,
      remainingOpenLengthM: p.remainingOpenLengthM,
      fullCoverage: p.fullCoverage,
      compoundD12D6: p.compoundD12D6,
      resolution: p.resolution,
    })),
    crossings: withPres.stats.crossingCount,
    unchanged: {
      d6GapsOpen: classAudit.gaps.filter((g) => g.primaryMechanism === 'D6').map((g) => g.gapId),
      d10GapsOpen: classAudit.gaps.filter((g) => g.primaryMechanism === 'D10').map((g) => g.gapId),
    },
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main();
