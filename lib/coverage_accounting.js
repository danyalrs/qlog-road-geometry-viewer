'use strict';

/**
 * Route-s interval and polyline arc-length coverage accounting.
 * Keeps fused, preserved, overlap, and union metrics separate.
 */

const { polylineLength } = require('./geometry_sanity');

const DEFAULT_TOLERANCE_M = 0.05;

function intervalsFromRuns(runs) {
  return (runs || [])
    .map((r) => {
      const sd = r.sdPoints || [];
      if (sd.length < 2) return null;
      return {
        startS: Math.min(...sd.map((p) => p.s)),
        endS: Math.max(...sd.map((p) => p.s)),
        runId: r.runId,
        physicalBoundaryId: r.physicalBoundaryId,
        laneTrackId: r.laneTrackId,
        layer: r.layer || 'acceptedFused',
      };
    })
    .filter(Boolean);
}

function intervalsFromPreserved(preservedIntervals) {
  return (preservedIntervals || []).map((p) => ({
    startS: p.startS,
    endS: p.endS,
    gapId: p.gapId,
    physicalBoundaryGroup: p.physicalBoundaryGroup,
    trackId: p.trackId,
    layer: p.isTailExtension ? 'd12TailExtension' : 'd12Preserved',
  }));
}

function mergeIntervals(intervals) {
  if (!intervals?.length) return [];
  const sorted = [...intervals].sort((a, b) => a.startS - b.startS);
  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = merged[merged.length - 1];
    if (cur.startS <= last.endS + DEFAULT_TOLERANCE_M) {
      last.endS = Math.max(last.endS, cur.endS);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

function intervalUnionLength(intervals) {
  return mergeIntervals(intervals).reduce((s, iv) => s + (iv.endS - iv.startS), 0);
}

function intervalOverlapLength(a, b) {
  const mergedA = mergeIntervals(a);
  const mergedB = mergeIntervals(b);
  let overlap = 0;
  for (const ivA of mergedA) {
    for (const ivB of mergedB) {
      const start = Math.max(ivA.startS, ivB.startS);
      const end = Math.min(ivA.endS, ivB.endS);
      if (end > start) overlap += end - start;
    }
  }
  return overlap;
}

function intervalSpanSum(intervals) {
  return (intervals || []).reduce((s, iv) => s + (iv.endS - iv.startS), 0);
}

function polylineArcLengthFromRuns(runs) {
  return (runs || []).reduce((s, r) => s + polylineLength(r.points || []), 0);
}

function polylineArcLengthFromPreserved(preservedIntervals) {
  return (preservedIntervals || []).reduce((s, p) => {
    const pts = (p.points || []).map((pt) => ({ east: pt.east, north: pt.north }));
    return s + polylineLength(pts);
  }, 0);
}

/**
 * Full coverage breakdown for cleaned lane map layers.
 */
function computeCoverageAccounting({
  cleanedFusedOnly = [],
  cleanedWithPreserved = [],
  preservedIntervals = [],
  toleranceM = DEFAULT_TOLERANCE_M,
}) {
  const acceptedIntervals = intervalsFromRuns(cleanedFusedOnly.map((r) => ({ ...r, layer: 'acceptedFused' })));
  const displayIntervals = intervalsFromRuns(cleanedWithPreserved.map((r) => ({ ...r, layer: 'display' })));
  const preservedOnlyIntervals = intervalsFromPreserved(preservedIntervals);

  const acceptedUnionM = intervalUnionLength(acceptedIntervals);
  const preservedUnionM = intervalUnionLength(preservedOnlyIntervals);
  const overlapM = intervalOverlapLength(acceptedIntervals, preservedOnlyIntervals);
  const combinedUnionM = intervalUnionLength([...acceptedIntervals, ...preservedOnlyIntervals]);

  const acceptedSpanSumM = intervalSpanSum(acceptedIntervals);
  const preservedSpanSumM = intervalSpanSum(preservedOnlyIntervals);
  const displaySpanSumM = intervalSpanSum(displayIntervals);

  const acceptedArcM = polylineArcLengthFromRuns(cleanedFusedOnly);
  const preservedArcM = polylineArcLengthFromPreserved(preservedIntervals);
  const displayArcM = polylineArcLengthFromRuns(cleanedWithPreserved);

  const naiveSpanSumM = acceptedSpanSumM + preservedSpanSumM;
  const displayMinusAcceptedM = displaySpanSumM - acceptedSpanSumM;

  return {
    toleranceM,
    routeSIntervalCoverage: {
      acceptedFusedUnionM: acceptedUnionM,
      d12PreservedUnionM: preservedUnionM,
      overlapAcceptedAndPreservedM: overlapM,
      combinedSupportedUnionM: combinedUnionM,
      acceptedSpanSumM,
      preservedSpanSumM,
      displayCleanedSpanSumM: displaySpanSumM,
      naiveSpanSumM,
      naiveAcceptedPlusPreservedM: naiveSpanSumM,
      displayMinusNaiveSpanSumM: displaySpanSumM - naiveSpanSumM,
      combinedMinusNaiveSumM: combinedUnionM - naiveSpanSumM,
      displaySpanMinusAcceptedSpanM: displayMinusAcceptedM,
    },
    polylineArcLength: {
      acceptedFusedArcM: acceptedArcM,
      d12PreservedArcM: preservedArcM,
      displayCleanedArcM: displayArcM,
    },
    reconciliation: {
      combinedEqualsUnionWithinTolerance: Math.abs(combinedUnionM - (acceptedUnionM + preservedUnionM - overlapM)) <= toleranceM + 0.01,
      spanSumReconcilesWithinTolerance: Math.abs((displaySpanSumM - naiveSpanSumM)) < 1.0,
      explanation: overlapM > toleranceM
        ? 'combined union differs from span-sum naive total when preserved intervals overlap accepted fused spans inside merged display runs'
        : (Math.abs(displaySpanSumM - naiveSpanSumM) > toleranceM
          ? 'display span sum exceeds naive span sum when merged runs extend s-range across gap boundaries without adding unique union length'
          : 'metrics reconcile within tolerance'),
    },
  };
}

function d12OpenLength(preservedIntervals, gapIntervals) {
  let totalOpen = 0;
  for (const gap of gapIntervals || []) {
    const preserved = (preservedIntervals || []).filter((p) => p.gapId === gap.gapId || p.parentGapId === gap.gapId);
    const covered = mergeIntervals(preserved.map((p) => ({ startS: p.startS, endS: p.endS })));
    let coveredLen = intervalUnionLength(covered);
    const gapLen = gap.endS - gap.startS;
    totalOpen += Math.max(0, gapLen - Math.min(coveredLen, gapLen));
  }
  return totalOpen;
}

module.exports = {
  DEFAULT_TOLERANCE_M,
  intervalsFromRuns,
  intervalsFromPreserved,
  mergeIntervals,
  intervalUnionLength,
  intervalOverlapLength,
  intervalSpanSum,
  polylineArcLengthFromRuns,
  polylineArcLengthFromPreserved,
  computeCoverageAccounting,
  d12OpenLength,
};
