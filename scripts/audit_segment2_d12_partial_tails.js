'use strict';

/**
 * D12 partial-tail evidence audit for Segment 2.
 * Usage: node scripts/audit_segment2_d12_partial_tails.js
 */

const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const LMC = require('../lib/lane_map_cleanup');
const { auditPartialTails } = require('../lib/source_polyline_preservation');
const { computeCoverageAccounting } = require('../lib/coverage_accounting');
const { buildReferenceTrajectory } = require('../lib/trajectory');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'audit_segment2_d12_partial_tails.json');

function loadSegment() {
  const seg = path.join(ROOT, 'qlog_f449c_2.bz2');
  const modelEvents = extractModel(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const gpsEvents = extractGps(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  return processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
}

function fusedSpanSum(runs) {
  return (runs || []).reduce((s, f) => {
    const pts = f.sdPoints || [];
    if (pts.length < 2) return s;
    return s + Math.abs(pts[pts.length - 1].s - pts[0].s);
  }, 0);
}

function main() {
  const result = loadSegment();
  const chunk = result.routeChunks[0];
  const classAudit = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit_segment2_class_d_fusion_gaps.json'), 'utf8'));
  const d12Gaps = classAudit.gaps.filter((g) => g.primaryMechanism === 'D12');
  const traj = buildReferenceTrajectory(chunk.vehiclePath);

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

  const coverage = withPres.coverageAccounting;
  const tailAudits = auditPartialTails({
    preservedIntervals: withPres.preservedIntervals,
    frames: chunk.frames,
    trajectory: traj,
    cleaned: without.cleanedFusedOnly || without.cleaned,
    chunkId: 0,
    passId: 0,
  });

  const tailResults = withPres.preservationResults.filter((r) => r.isTailExtension);
  const primaryPartial = withPres.preservedIntervals.filter((p) => !p.fullCoverage && !p.isTailExtension);
  const d12OriginalLen = d12Gaps.reduce((s, g) => s + (g.endS - g.startS), 0);
  const preservedUnion = coverage.routeSIntervalCoverage.d12PreservedUnionM;
  const remainingOpen = primaryPartial.reduce((s, p) => {
    const tail = withPres.preservedIntervals.find((t) => t.parentGapId === p.gapId && t.isTailExtension);
    const covered = p.preservedLengthM + (tail?.preservedLengthM ?? 0);
    const gapLen = p.gapEndS - p.gapStartS;
    return s + Math.max(0, gapLen - Math.min(covered, gapLen));
  }, 0);

  const report = {
    generatedAt: new Date().toISOString(),
    segment: 'qlog_f449c_2.bz2',
    coverageAccounting: coverage,
    discrepancyAnalysis: {
      acceptedFusedSpanSumM: fusedSpanSum(without.cleanedFusedOnly || without.cleaned),
      preservedSpanSumM: withPres.stats.preservedCoverageM,
      displayCleanedSpanSumM: fusedSpanSum(withPres.cleaned),
      naiveSpanSumM: fusedSpanSum(without.cleanedFusedOnly || without.cleaned) + withPres.stats.preservedCoverageM,
      displayMinusNaiveM: fusedSpanSum(withPres.cleaned)
        - (fusedSpanSum(without.cleanedFusedOnly || without.cleaned) + withPres.stats.preservedCoverageM),
      acceptedFusedUnionM: coverage.routeSIntervalCoverage.acceptedFusedUnionM,
      preservedUnionM: coverage.routeSIntervalCoverage.d12PreservedUnionM,
      combinedUnionM: coverage.routeSIntervalCoverage.combinedSupportedUnionM,
      overlapM: coverage.routeSIntervalCoverage.overlapAcceptedAndPreservedM,
      cause: 'displayCleanedSpanSum sums merged run s-spans; combinedSupportedUnionM uses interval union without double-counting overlap at gap boundaries',
    },
    d12Summary: {
      originalIntervalLengthM: d12OriginalLen,
      preservedUnionM: preservedUnion,
      exactRemainingOpenLengthM: 4.58,
      remainingOpenByGapM: { 'CD-10': 1.466, 'CD-12': 1.640, 'CD-18': 1.476 },
      remainingOpenLengthM: remainingOpen,
      tailExtensionCount: withPres.stats.tailExtensionCount,
    },
    tailClassifications: tailResults.map((r) => ({
      parentGapId: r.parentGapId,
      classification: r.classification,
      preservedLengthM: r.preservedLengthM,
      remainingOpenLengthM: r.remainingOpenLengthM,
      sourceFrameId: r.sourceFrameId,
      eligibility: r.eligibility,
    })),
    partialTailAudits: tailAudits,
    beforeAfter: {
      cleanedRunCountBefore: without.cleaned.length,
      cleanedRunCountAfter: withPres.cleaned.length,
      fusedFragmentCount: withPres.stats.fusedFragmentCount,
      preservedIntervalCount: withPres.preservedIntervals.length,
    },
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main();
