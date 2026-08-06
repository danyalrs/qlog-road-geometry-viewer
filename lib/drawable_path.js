'use strict';

/**
 * Drawable path analysis for cleaned lane runs.
 * Detects unsupported intervals that must not receive canvas line segments.
 */

const { PROVENANCE_TYPE } = require('./source_polyline_preservation');

const UNSUPPORTED_S_GAP_M = 0.15;
const RENDERER_MAX_GAP_M = 15;

function euclideanM(a, b) {
  return Math.hypot(b.east - a.east, b.north - a.north);
}

/**
 * Split one cleaned run into drawable components at internal unsupported breaks.
 */
function splitRunIntoDrawableComponents(run, openIntervals = []) {
  const pts = run.points || [];
  const sd = run.sdPoints || [];
  const prov = run.pointProvenance || [];
  if (pts.length < 2) {
    return [{
      drawableComponentId: `${run.runId}:0`,
      runId: run.runId,
      physicalBoundaryId: run.physicalBoundaryId,
      laneTrackId: run.laneTrackId,
      componentIndex: 0,
      points: pts,
      sdPoints: sd,
      pointProvenance: prov,
      sMin: sd[0]?.s ?? run.sMin,
      sMax: sd[sd.length - 1]?.s ?? run.sMax,
      breakBefore: false,
    }];
  }

  const components = [];
  let current = {
    points: [pts[0]],
    sdPoints: [sd[0]],
    pointProvenance: [prov[0]],
    startIndex: 0,
  };

  const isUnsupportedInternal = (i) => {
    const sPrev = sd[i - 1]?.s;
    const sCur = sd[i]?.s;
    if (sPrev == null || sCur == null) return false;
    const ds = sCur - sPrev;
    if (ds <= UNSUPPORTED_S_GAP_M) return false;
    const openHit = openIntervals.some((iv) => sPrev < iv.endS - 0.01 && sCur > iv.startS + 0.01
      && sCur - sPrev > UNSUPPORTED_S_GAP_M);
    if (openHit) return true;
    const pidPrev = prov[i - 1];
    const pidCur = prov[i];
    if (pidPrev === PROVENANCE_TYPE && pidCur === PROVENANCE_TYPE) {
      const metaPrev = run.displayPointMeta?.[i - 1];
      const metaCur = run.displayPointMeta?.[i];
      if (metaPrev?.sourcePolylineId && metaCur?.sourcePolylineId
        && metaPrev.sourcePolylineId !== metaCur.sourcePolylineId) {
        return true;
      }
    }
    return false;
  };

  for (let i = 1; i < pts.length; i++) {
    if (isUnsupportedInternal(i)) {
      components.push(current);
      current = {
        points: [pts[i]],
        sdPoints: [sd[i]],
        pointProvenance: [prov[i]],
        startIndex: i,
        breakBefore: true,
        breakReason: 'unsupportedSourcePolylineGap',
        openIntervalStartS: sd[i - 1]?.s,
        openIntervalEndS: sd[i]?.s,
        openLengthM: (sd[i]?.s ?? 0) - (sd[i - 1]?.s ?? 0),
      };
    } else {
      current.points.push(pts[i]);
      current.sdPoints.push(sd[i]);
      current.pointProvenance.push(prov[i]);
    }
  }
  components.push(current);

  return components.map((c, ci) => ({
    drawableComponentId: `${run.runId}:${ci}`,
    runId: run.runId,
    physicalBoundaryId: run.physicalBoundaryId,
    laneTrackId: run.laneTrackId,
    componentIndex: ci,
    points: c.points,
    sdPoints: c.sdPoints,
    pointProvenance: c.pointProvenance,
    sMin: c.sdPoints[0]?.s,
    sMax: c.sdPoints[c.sdPoints.length - 1]?.s,
    breakBefore: c.breakBefore ?? false,
    breakReason: c.breakReason ?? null,
    openIntervalStartS: c.openIntervalStartS ?? null,
    openIntervalEndS: c.openIntervalEndS ?? null,
    openLengthM: c.openLengthM ?? null,
  }));
}

/**
 * Detect unsupported breaks between consecutive cleaned runs on the same PB/track.
 */
function detectInterRunBreaks(runs, preservedIntervals = []) {
  const breaks = [];
  const partialGaps = preservedIntervals.filter((p) => !p.fullCoverage && !p.isTailExtension);

  for (const gap of partialGaps) {
    const pb = gap.physicalBoundaryGroup;
    const trackId = gap.trackId;
    const tail = preservedIntervals.find((p) => p.parentGapId === gap.gapId && p.isTailExtension);
    const openStart = gap.endS;
    const openEnd = gap.gapEndS;
    if (openEnd - openStart < 0.05 && !tail) continue;

    const pbRuns = runs
      .filter((r) => r.physicalBoundaryId === pb && r.laneTrackId === trackId)
      .sort((a, b) => (a.sMin ?? 0) - (b.sMin ?? 0));

    for (let i = 0; i < pbRuns.length - 1; i++) {
      const a = pbRuns[i];
      const b = pbRuns[i + 1];
      const aEnd = a.sMax ?? a.sdPoints?.[a.sdPoints.length - 1]?.s;
      const bStart = b.sMin ?? b.sdPoints?.[0]?.s;
      if (aEnd == null || bStart == null) continue;
      const openLen = bStart - aEnd;
      if (openLen < UNSUPPORTED_S_GAP_M) continue;
      const overlapsOpen = aEnd <= openEnd + 0.01 && bStart >= openStart - 0.01
        && openLen > UNSUPPORTED_S_GAP_M;
      if (!overlapsOpen) continue;

      const aLast = a.points?.[a.points.length - 1];
      const bFirst = b.points?.[0];
      const labelEast = aLast && bFirst ? (aLast.east + bFirst.east) / 2 : null;
      const labelNorth = aLast && bFirst ? (aLast.north + bFirst.north) / 2 : null;
      breaks.push({
        gapId: gap.gapId,
        physicalBoundaryId: pb,
        laneTrackId: trackId,
        precedingRunId: a.runId,
        followingRunId: b.runId,
        precedingComponentId: `${a.runId}:last`,
        followingComponentId: `${b.runId}:0`,
        openIntervalStartS: aEnd,
        openIntervalEndS: bStart,
        openLengthM: openLen,
        routeSDistanceM: openLen,
        euclideanDistanceM: aLast && bFirst ? euclideanM(aLast, bFirst) : null,
        labelEast,
        labelNorth,
        shareOneCanvasPath: false,
        rendererWouldBridge: false,
        breakReason: 'unsupportedSourcePolylineGap',
        breakBefore: true,
      });
    }
  }

  return breaks;
}

/**
 * Full drawable-path audit for cleaned lane map output.
 */
function analyzeDrawablePaths(cleaned, preservedIntervals = []) {
  const openIntervals = [];
  for (const gap of preservedIntervals.filter((p) => !p.isTailExtension)) {
    const tail = preservedIntervals.find((t) => t.parentGapId === gap.gapId && t.isTailExtension);
    if (!gap.fullCoverage) {
      if (gap.openAfterM > 0.05) {
        if (tail) {
          openIntervals.push({ gapId: gap.gapId, startS: gap.endS, endS: tail.startS, kind: 'primaryToTail' });
          if (tail.openAfterM > 0.05) {
            openIntervals.push({ gapId: gap.gapId, startS: tail.endS, endS: gap.gapEndS, kind: 'tailToFused' });
          }
        } else {
          openIntervals.push({ gapId: gap.gapId, startS: gap.endS, endS: gap.gapEndS, kind: 'preservedToFused' });
        }
      }
    }
  }

  const drawableComponents = [];
  for (const run of cleaned) {
    drawableComponents.push(...splitRunIntoDrawableComponents(run, openIntervals));
  }

  const interRunBreaks = detectInterRunBreaks(cleaned, preservedIntervals);

  return {
    logicalCleanedRunCount: cleaned.length,
    drawableSubpathCount: drawableComponents.length,
    drawableComponents,
    interRunBreaks,
    openIntervals,
    falseVisualBridgeDetected: interRunBreaks.some((b) => b.shareOneCanvasPath),
    falseVisualBridges: interRunBreaks.filter((b) => b.shareOneCanvasPath),
    rendererNote: 'Mode 5 draws one canvas path per cleaned run fragment; inter-run unsupported gaps are separate draw calls and do not receive line segments unless points share one coordinate array.',
  };
}

/**
 * Simulate canvas line segments for one polyline points array.
 */
function simulateRendererSegments(points, maxGapM = RENDERER_MAX_GAP_M) {
  const segments = [];
  if (!points?.length) return segments;
  let run = [0];
  for (let i = 1; i < points.length; i++) {
    const jump = euclideanM(points[i - 1], points[i]);
    if (jump > maxGapM) {
      if (run.length >= 2) {
        for (let j = 1; j < run.length; j++) {
          segments.push({ from: run[j - 1], to: run[j], euclideanM: euclideanM(points[run[j - 1]], points[run[j]]) });
        }
      }
      run = [i];
    } else {
      run.push(i);
    }
  }
  if (run.length >= 2) {
    for (let j = 1; j < run.length; j++) {
      segments.push({ from: run[j - 1], to: run[j], euclideanM: euclideanM(points[run[j - 1]], points[run[j]]) });
    }
  }
  return segments;
}

/**
 * Check whether any renderer segment within a single run crosses a recorded open interval.
 */
function segmentCrossesOpenInterval(seg, points, interval) {
  const s0 = points[seg.from]?.s;
  const s1 = points[seg.to]?.s;
  if (s0 == null || s1 == null) return false;
  const lo = Math.min(s0, s1);
  const hi = Math.max(s0, s1);
  return lo < interval.startS - 0.01 && hi > interval.endS + 0.01;
}

function verifyNoRendererBridgeAcrossGaps(cleaned, preservedIntervals, gapIds) {
  const analysis = analyzeDrawablePaths(cleaned, preservedIntervals);
  const violations = [];

  for (const gapId of gapIds) {
    const brk = analysis.interRunBreaks.find((b) => b.gapId === gapId);
    if (!brk) {
      violations.push({ gapId, reason: 'noInterRunBreakRecorded' });
      continue;
    }
    if (brk.shareOneCanvasPath) {
      violations.push({ gapId, reason: 'shareOneCanvasPath', brk });
    }

    const interval = {
      startS: brk.openIntervalStartS,
      endS: brk.openIntervalEndS,
    };

    for (const runId of [brk.precedingRunId, brk.followingRunId]) {
      const run = cleaned.find((r) => r.runId === runId);
      if (!run?.points?.length) continue;
      const pts = (run.sdPoints || []).map((sd, i) => ({
        s: sd.s,
        d: sd.d,
        east: run.points[i].east,
        north: run.points[i].north,
      }));
      const segs = simulateRendererSegments(pts);
      for (const seg of segs) {
        if (segmentCrossesOpenInterval(seg, pts, interval)) {
          violations.push({ gapId, runId, seg, reason: 'intraRunCrossesOpenInterval' });
        }
      }
    }
  }

  return { violations, analysis };
}

module.exports = {
  UNSUPPORTED_S_GAP_M,
  RENDERER_MAX_GAP_M,
  splitRunIntoDrawableComponents,
  detectInterRunBreaks,
  analyzeDrawablePaths,
  simulateRendererSegments,
  verifyNoRendererBridgeAcrossGaps,
};
