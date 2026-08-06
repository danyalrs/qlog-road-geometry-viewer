'use strict';

/**
 * D12 source-polyline preservation — provenance-preserving reconstruction only.
 * Does not alter fusion acceptance, interpolate, or fabricate coordinates.
 */

const { projectPointTemporal } = require('./temporal_projection');
const { sToMap } = require('./trajectory');
const { endpointCompatibility } = require('./lane_run_audit');

const PROVENANCE_TYPE = 'sourcePolylinePreserved';
const DEDUP_S_TOLERANCE_M = 0.05;
const DEDUP_XY_TOLERANCE_M = 0.02;
const MAX_LATERAL_JUMP_M = 2.5;
const MAX_HEADING_DELTA_DEG = 25;
const MAX_CURVATURE_DELTA_DEG = 35;
const MIN_COVERAGE_FRAC = 0.85;

/** Segment 2 D12 candidates — fallback when audit JSON unavailable (browser bundle). */
const SEGMENT2_D12_GAPS = [
  { gapId: 'CD-00', physicalBoundaryGroup: 'PB0', sourceTrackId: 0, startS: 42.29187659366445, endS: 65.78727043441252, primaryMechanism: 'D12', rejectedBinsInGap: 7 },
  { gapId: 'CD-02', physicalBoundaryGroup: 'PB0', sourceTrackId: 0, startS: 412.4419997969666, endS: 434.9420161044949, primaryMechanism: 'D12', rejectedBinsInGap: 7 },
  { gapId: 'CD-10', physicalBoundaryGroup: 'PB1', sourceTrackId: 2, startS: 412.22180615396644, endS: 434.5339771485253, primaryMechanism: 'D12', rejectedBinsInGap: 7 },
  { gapId: 'CD-12', physicalBoundaryGroup: 'PB1', sourceTrackId: 2, startS: 478.79387292483455, endS: 500.1206905235975, primaryMechanism: 'D12', rejectedBinsInGap: 6 },
  { gapId: 'CD-18', physicalBoundaryGroup: 'PB2', sourceTrackId: 3, startS: 412.2329184179182, endS: 434.5449151711091, primaryMechanism: 'D12', rejectedBinsInGap: 7 },
];

function headingFromSdPts(sdPoints) {
  if (!sdPoints || sdPoints.length < 2) return null;
  const ds = sdPoints[sdPoints.length - 1].s - sdPoints[0].s;
  const dd = sdPoints[sdPoints.length - 1].d - sdPoints[0].d;
  if (Math.abs(ds) < 0.01) return null;
  return (Math.atan2(dd, ds) * 180) / Math.PI;
}

function maxLateralJump(sdPoints) {
  let max = 0;
  for (let i = 1; i < sdPoints.length; i++) {
    max = Math.max(max, Math.abs(sdPoints[i].d - sdPoints[i - 1].d));
  }
  return max;
}

function maxCurvatureDeltaDeg(sdPoints) {
  if (sdPoints.length < 3) return 0;
  let max = 0;
  for (let i = 1; i < sdPoints.length - 1; i++) {
    const h1 = headingFromSdPts([sdPoints[i - 1], sdPoints[i]]);
    const h2 = headingFromSdPts([sdPoints[i], sdPoints[i + 1]]);
    if (h1 == null || h2 == null) continue;
    max = Math.max(max, Math.abs(((h2 - h1 + 540) % 360) - 180));
  }
  return max;
}

function extractMappedPolylinePoints(frame, lane, trajectory, sMin, sMax, options = {}) {
  const maxPerpDist = options.maxProjectionDistM ?? 25;
  const points = [];
  for (let i = 0; i < (lane.points || []).length; i++) {
    const pt = lane.points[i];
    const proj = projectPointTemporal(trajectory, pt.east, pt.north, frame.logMonoTime, options);
    if (!proj.valid || proj.ambiguous || proj.perpDist > maxPerpDist) continue;
    if (proj.s < sMin - 0.5 || proj.s > sMax + 0.5) continue;
    if (!Number.isFinite(proj.s) || !Number.isFinite(proj.d)) continue;
    const map = sToMap(trajectory, proj.s, proj.d);
    points.push({
      east: map.east,
      north: map.north,
      s: proj.s,
      d: proj.d,
      originalPointIndex: i,
      sourceConfidence: lane.prob ?? 1,
    });
  }
  points.sort((a, b) => a.s - b.s);
  return points;
}

function polylineId(frameId, laneIndex, laneTrackId) {
  return `${frameId}:L${laneIndex}:T${laneTrackId}`;
}

function findBestSpanningPolyline(frames, trajectory, gap, trackId, chunkId, passId, options = {}) {
  const { startS, endS } = gap;
  const gapM = endS - startS;
  const excludePolylineId = options.excludePolylineId;
  const minInteriorS = options.minInteriorS;
  let best = null;

  for (const frame of frames) {
    if (frame.chunkId != null && frame.chunkId !== chunkId) continue;
    if (frame.passId != null && frame.passId !== passId) continue;
    for (const lane of frame.lanes || []) {
      if (lane.laneTrackId !== trackId) continue;
      const pid = polylineId(frame.frameId, lane.laneIndex, trackId);
      if (excludePolylineId && pid === excludePolylineId) continue;
      const mapped = extractMappedPolylinePoints(frame, lane, trajectory, startS, endS);
      if (mapped.length < 2) continue;
      const interior = minInteriorS != null
        ? mapped.filter((p) => p.s > minInteriorS + 0.01)
        : mapped;
      if (interior.length < 2) continue;
      const spanStart = mapped[0].s;
      const spanEnd = mapped[mapped.length - 1].s;
      const spanM = spanEnd - spanStart;
      const coversStart = spanStart <= startS + 0.5;
      const coversEnd = spanEnd >= endS - 0.5;
      const entersOpenTail = minInteriorS != null
        ? interior.some((p) => p.s > minInteriorS + 0.05)
        : true;
      if (minInteriorS != null && !entersOpenTail) continue;
      const score = (coversStart ? 1000 : 0) + (coversEnd ? 1000 : 0) + spanM;
      if (!best || score > best.score) {
        best = {
          score,
          frameId: frame.frameId,
          logMonoTime: frame.logMonoTime,
          laneIndex: lane.laneIndex,
          sourcePolylineId: pid,
          mappedPoints: mapped,
          interiorPoints: interior,
          spanStart,
          spanEnd,
          spanM,
          coversStart,
          coversEnd,
          coverageFrac: spanM / gapM,
          originalPointCount: lane.points?.length ?? 0,
          sourceConfidence: lane.prob ?? 1,
        };
      }
    }
  }
  return best;
}

function listCandidatePolylinesInRange(frames, trajectory, range, trackId, chunkId, passId) {
  const { startS, endS } = range;
  const candidates = [];
  for (const frame of frames) {
    if (frame.chunkId != null && frame.chunkId !== chunkId) continue;
    if (frame.passId != null && frame.passId !== passId) continue;
    for (const lane of frame.lanes || []) {
      if (lane.laneTrackId !== trackId) continue;
      const mapped = extractMappedPolylinePoints(frame, lane, trajectory, startS, endS);
      if (!mapped.length) continue;
      const inOpen = mapped.filter((p) => p.s >= startS && p.s <= endS);
      candidates.push({
        sourceFrameId: frame.frameId,
        logMonoTime: frame.logMonoTime,
        sourceLaneIndex: lane.laneIndex,
        sourcePolylineId: polylineId(frame.frameId, lane.laneIndex, trackId),
        mappedSRange: [mapped[0].s, mapped[mapped.length - 1].s],
        mappedPointCount: mapped.length,
        pointsInOpenInterval: inOpen.length,
        pointsInOpenSRange: inOpen.length >= 2
          ? [inOpen[0].s, inOpen[inOpen.length - 1].s]
          : inOpen.length === 1 ? [inOpen[0].s, inOpen[0].s] : null,
        sourceConfidence: lane.prob ?? 1,
        meanD: inOpen.reduce((s, p) => s + p.d, 0) / (inOpen.length || 1),
      });
    }
  }
  return candidates;
}

function preservationCompetingBoundaryInGap(gap, allCleaned, physicalBoundaryId, trackId) {
  const { startS, endS } = gap;
  const target = allCleaned.find((r) => r.physicalBoundaryId === physicalBoundaryId);
  const targetD = target?.meanD ?? 0;
  for (const run of allCleaned || []) {
    if (run.physicalBoundaryId === physicalBoundaryId) continue;
    if (run.laneTrackId === trackId) continue;
    const sMin = run.sMin ?? run.sdPoints?.[0]?.s;
    const sMax = run.sMax ?? run.sdPoints?.[run.sdPoints.length - 1]?.s;
    if (sMin == null || sMax == null) continue;
    if (sMax <= startS || sMin >= endS) continue;
    const runD = run.meanD ?? 0;
    if (Math.sign(runD) === Math.sign(targetD) && Math.abs(runD - targetD) < 1.2) {
      return true;
    }
  }
  return false;
}

function checkPolylineContinuity(sdPoints) {
  if (sdPoints.length < 2) return { ok: false, reason: 'tooFewPoints' };
  if (maxLateralJump(sdPoints) > MAX_LATERAL_JUMP_M) {
    return { ok: false, reason: 'lateralDiscontinuity' };
  }
  if (maxCurvatureDeltaDeg(sdPoints) > MAX_CURVATURE_DELTA_DEG) {
    return { ok: false, reason: 'curvatureDiscontinuity' };
  }
  return { ok: true };
}

function checkEndpointCompatibility(prevSd, nextSd, preservedSd) {
  if (!prevSd?.length || !nextSd?.length || !preservedSd?.length) {
    return { ok: true, skipped: true };
  }
  const prevFrag = { sdPoints: [prevSd[prevSd.length - 1], preservedSd[0]] };
  const nextFrag = { sdPoints: [preservedSd[preservedSd.length - 1], nextSd[0]] };
  const toPrev = endpointCompatibility(
    { sdPoints: prevSd.slice(-2) },
    { sdPoints: [preservedSd[0], preservedSd[Math.min(1, preservedSd.length - 1)]] },
    { maxJoinLateralDeltaM: 0.8, maxJoinHeadingDeltaDeg: MAX_HEADING_DELTA_DEG },
  );
  const toNext = endpointCompatibility(
    { sdPoints: [preservedSd[Math.max(0, preservedSd.length - 2)], preservedSd[preservedSd.length - 1]] },
    { sdPoints: nextSd.slice(0, 2) },
    { maxJoinLateralDeltaM: 0.8, maxJoinHeadingDeltaDeg: MAX_HEADING_DELTA_DEG },
  );
  if (!toPrev.compatible) return { ok: false, reason: 'lateralOrHeadingMismatchAtStart', detail: toPrev };
  if (!toNext.compatible) return { ok: false, reason: 'lateralOrHeadingMismatchAtEnd', detail: toNext };
  return { ok: true };
}

function dedupePointsByS(points) {
  const out = [];
  for (const p of points) {
    if (out.length && Math.abs(p.s - out[out.length - 1].s) < DEDUP_S_TOLERANCE_M) continue;
    if (out.length) {
      const prev = out[out.length - 1];
      if (Math.hypot(p.east - prev.east, p.north - prev.north) < DEDUP_XY_TOLERANCE_M) continue;
    }
    out.push(p);
  }
  return out;
}

function attachProvenance(points, meta) {
  return points.map((p) => ({
    ...p,
    provenanceType: PROVENANCE_TYPE,
    provenance: {
      provenanceType: PROVENANCE_TYPE,
      gapId: meta.gapId,
      sourceFrameId: meta.sourceFrameId,
      logMonoTime: meta.logMonoTime,
      sourceLaneIndex: meta.sourceLaneIndex,
      sourcePolylineId: meta.sourcePolylineId,
      physicalBoundaryGroup: meta.physicalBoundaryGroup,
      trackId: meta.trackId,
      chunkId: meta.chunkId,
      passId: meta.passId,
      originalPointIndex: p.originalPointIndex,
      sourceConfidence: p.sourceConfidence ?? meta.sourceConfidence,
      mappedS: p.s,
      mappedD: p.d,
      preservationReason: meta.preservationReason,
    },
  }));
}

/**
 * Evaluate and preserve D12 source polylines for class-D gaps.
 */
function preserveSourcePolylinesForGaps({
  gaps = [],
  frames = [],
  trajectory,
  physicalBoundaryGroups = [],
  cleaned = [],
  chunkId = 0,
  passId = 0,
  options = {},
}) {
  const results = [];
  const preservedIntervals = [];
  const trackToPb = new Map();
  for (const g of physicalBoundaryGroups) {
    for (const tid of g.trackIds || []) trackToPb.set(tid, g.physicalBoundaryId);
  }

  for (const gap of gaps) {
    const trackId = gap.sourceTrackId ?? gap.trackId;
    const pbId = gap.physicalBoundaryGroup ?? gap.physicalBoundaryId ?? trackToPb.get(trackId);
    const startS = gap.startS ?? gap.prevRunS;
    const endS = gap.endS ?? gap.nextRunS;
    const gapM = endS - startS;
    const gapId = gap.gapId;

    const baseResult = {
      gapId,
      physicalBoundaryGroup: pbId,
      trackId,
      chunkId,
      passId,
      startS,
      endS,
      measuredGapLengthM: gapM,
      d6RejectedBinsInGap: gap.rejectedBinsInGap ?? gap.rejectedBinsInGap ?? 0,
      eligibility: { passed: false, reason: null },
      resolution: 'unchanged',
      preservedLengthM: 0,
      remainingOpenLengthM: gapM,
      preservedPointCount: 0,
      sourceFrameId: null,
      sourcePolylineId: null,
    };

    if (gap.primaryMechanism && gap.primaryMechanism !== 'D12') {
      baseResult.eligibility.reason = `not D12 candidate (${gap.primaryMechanism})`;
      results.push(baseResult);
      continue;
    }

    if (preservationCompetingBoundaryInGap({ startS, endS }, cleaned, pbId, trackId)) {
      baseResult.eligibility.reason = 'competingBoundaryInGap';
      results.push(baseResult);
      continue;
    }

    const candidate = findBestSpanningPolyline(frames, trajectory, { startS, endS }, trackId, chunkId, passId);
    if (!candidate) {
      baseResult.eligibility.reason = 'noMappedSourcePolyline';
      results.push(baseResult);
      continue;
    }

    const continuity = checkPolylineContinuity(candidate.mappedPoints);
    if (!continuity.ok) {
      baseResult.eligibility.reason = continuity.reason;
      baseResult.candidate = { sourceFrameId: candidate.frameId, sourcePolylineId: candidate.sourcePolylineId };
      results.push(baseResult);
      continue;
    }

    const prevRun = cleaned.find((r) => r.physicalBoundaryId === pbId
      && Math.abs((r.sMax ?? 0) - startS) < 2.5);
    const nextRun = cleaned.find((r) => r.physicalBoundaryId === pbId
      && Math.abs((r.sMin ?? 0) - endS) < 2.5);
    const endpointCheck = checkEndpointCompatibility(
      prevRun?.sdPoints,
      nextRun?.sdPoints,
      candidate.mappedPoints,
    );
    if (!endpointCheck.ok) {
      baseResult.eligibility.reason = endpointCheck.reason;
      baseResult.candidate = { sourceFrameId: candidate.frameId, sourcePolylineId: candidate.sourcePolylineId };
      results.push(baseResult);
      continue;
    }

    const clipped = candidate.mappedPoints.filter((p) => p.s >= startS - 0.01 && p.s <= endS + 0.01);
    const preservedSd = dedupePointsByS(clipped);
    if (preservedSd.length < 2) {
      baseResult.eligibility.reason = 'insufficientPreservedPoints';
      results.push(baseResult);
      continue;
    }

    const preservedStart = preservedSd[0].s;
    const preservedEnd = preservedSd[preservedSd.length - 1].s;
    const preservedLengthM = preservedEnd - preservedStart;
    const openBefore = Math.max(0, preservedStart - startS);
    const openAfter = Math.max(0, endS - preservedEnd);
    const remainingOpenLengthM = openBefore + openAfter;
    const fullCoverage = candidate.coversStart && candidate.coversEnd
      && remainingOpenLengthM < 0.5;

    const meta = {
      gapId,
      sourceFrameId: candidate.frameId,
      logMonoTime: candidate.logMonoTime,
      sourceLaneIndex: candidate.laneIndex,
      sourcePolylineId: candidate.sourcePolylineId,
      physicalBoundaryGroup: pbId,
      trackId,
      chunkId,
      passId,
      sourceConfidence: candidate.sourceConfidence,
      preservationReason: fullCoverage ? 'D12_fullSpan' : 'D12_partialSpan',
    };

    const preservedPoints = attachProvenance(preservedSd, meta);
    const interval = {
      ...meta,
      provenanceType: PROVENANCE_TYPE,
      startS: preservedStart,
      endS: preservedEnd,
      gapStartS: startS,
      gapEndS: endS,
      measuredGapLengthM: gapM,
      preservedLengthM,
      remainingOpenLengthM,
      openBeforeM: openBefore,
      openAfterM: openAfter,
      preservedPointCount: preservedPoints.length,
      originalPointCount: candidate.originalPointCount,
      mappedPointCount: candidate.mappedPoints.length,
      sourcePolylineSRange: [candidate.spanStart, candidate.spanEnd],
      fullCoverage,
      resolution: fullCoverage ? 'fullyResolved' : (preservedLengthM > 0 ? 'partiallyResolved' : 'unchanged'),
      points: preservedPoints,
      sdPoints: preservedPoints.map((p) => ({ s: p.s, d: p.d })),
      d6RejectedBinsInGap: gap.rejectedBinsInGap ?? 0,
      compoundD12D6: (gap.rejectedBinsInGap ?? 0) > 0,
    };

    preservedIntervals.push(interval);
    results.push({
      ...baseResult,
      eligibility: { passed: true, reason: null },
      resolution: interval.resolution,
      preservedLengthM,
      remainingOpenLengthM,
      preservedPointCount: preservedPoints.length,
      sourceFrameId: candidate.frameId,
      logMonoTime: candidate.logMonoTime,
      sourceLaneIndex: candidate.laneIndex,
      sourcePolylineId: candidate.sourcePolylineId,
      sourcePolylineSRange: [candidate.spanStart, candidate.spanEnd],
      mappedPolylineSRange: [preservedStart, preservedEnd],
      originalPointCount: candidate.originalPointCount,
      mappedPointCount: candidate.mappedPoints.length,
      pointsInsideGap: preservedPoints.length,
      sourceConfidence: candidate.sourceConfidence,
      fullCoverage,
      compoundD12D6: interval.compoundD12D6,
      endpointLateralDelta: endpointCheck.detail?.dDelta ?? null,
      endpointHeadingDelta: endpointCheck.detail?.headingDelta ?? null,
    });
  }

  return { preservedIntervals, results };
}

/**
 * Audit open D12 partial tails and list every candidate source polyline.
 */
function auditPartialTails({
  preservedIntervals = [],
  frames = [],
  trajectory,
  cleaned = [],
  chunkId = 0,
  passId = 0,
}) {
  const audits = [];
  const partialGaps = ['CD-10', 'CD-12', 'CD-18'];

  for (const gapId of partialGaps) {
    const primary = preservedIntervals.find((p) => p.gapId === gapId && !p.isTailExtension);
    if (!primary) {
      audits.push({ gapId, error: 'noPrimaryPreservation' });
      continue;
    }

    const openStartS = primary.endS;
    const openEndS = primary.gapEndS;
    const openLengthM = openEndS - openStartS;
    const trackId = primary.trackId;
    const pbId = primary.physicalBoundaryGroup;

    const prevRun = cleaned.find((r) => r.physicalBoundaryId === pbId
      && Math.abs((r.sMax ?? 0) - primary.gapStartS) < 2.5);
    const nextRun = cleaned.find((r) => r.physicalBoundaryId === pbId
      && Math.abs((r.sMin ?? 0) - primary.gapEndS) < 2.5);

    const candidates = listCandidatePolylinesInRange(
      frames, trajectory, { startS: openStartS, endS: openEndS }, trackId, chunkId, passId,
    );

    const candidateAudits = candidates.map((c) => {
      const interiorCount = c.pointsInOpenInterval;
      const entersInterior = c.pointsInOpenSRange
        && c.pointsInOpenSRange[0] > openStartS + DEDUP_S_TOLERANCE_M
        && interiorCount >= 2
        && (c.pointsInOpenSRange[1] - c.pointsInOpenSRange[0]) > DEDUP_S_TOLERANCE_M;
      const distToTail = c.mappedSRange[0] > openStartS
        ? c.mappedSRange[0] - openStartS
        : 0;
      let rejectionReason = null;
      if (c.sourcePolylineId === primary.sourcePolylineId) {
        rejectionReason = 'alreadyUsedPrimaryPreservation';
      } else if (interiorCount < 2) {
        rejectionReason = 'insufficientPointsInOpenInterval';
      } else if (!entersInterior) {
        rejectionReason = c.pointsInOpenSRange?.[0] <= openStartS + DEDUP_S_TOLERANCE_M
          ? 'doesNotEnterOpenTailInterior'
          : 'collapsedSpanInOpenInterval';
      }
      return {
        ...c,
        entersOpenTailInterior: entersInterior,
        distanceFromMappedEndpointToOpenStartM: distToTail,
        rejectionReason,
      };
    });

    const tailExtension = preservedIntervals.find((p) => p.parentGapId === gapId && p.isTailExtension);

    audits.push({
      gapId,
      physicalBoundaryGroup: pbId,
      trackId,
      chunkId,
      passId,
      openInterval: { startS: openStartS, endS: openEndS, lengthM: openLengthM },
      primaryPreservation: {
        sourceFrameId: primary.sourceFrameId,
        sourcePolylineId: primary.sourcePolylineId,
        preservedEndS: primary.endS,
        finalMappedPoint: primary.points[primary.points.length - 1],
      },
      surroundingFusedFragments: {
        prevRunId: prevRun?.runId ?? null,
        prevRunSMax: prevRun?.sMax ?? null,
        nextRunId: nextRun?.runId ?? null,
        nextRunSMin: nextRun?.sMin ?? null,
        nextAcceptedFusedPoint: nextRun?.sdPoints?.[0] ?? null,
      },
      inspectedSourceFrames: [...new Set(frames
        .filter((f) => {
          if (f.chunkId != null && f.chunkId !== chunkId) return false;
          if (f.passId != null && f.passId !== passId) return false;
          return (f.lanes || []).some((l) => l.laneTrackId === trackId);
        })
        .map((f) => f.frameId))].sort((a, b) => a - b),
      candidateSourcePolylines: candidateAudits,
      tailExtension: tailExtension ? {
        gapId: tailExtension.gapId,
        sourceFrameId: tailExtension.sourceFrameId,
        preservedLengthM: tailExtension.preservedLengthM,
        remainingOpenAfterExtensionM: tailExtension.remainingOpenLengthM,
      } : null,
    });
  }

  return audits;
}

/**
 * Extend partially resolved D12 gaps using additional original mapped points in open tails only.
 */
function extendPartialTailPreservation({
  preservedIntervals = [],
  frames = [],
  trajectory,
  cleaned = [],
  chunkId = 0,
  passId = 0,
}) {
  const extensions = [];
  const results = [];

  for (const primary of preservedIntervals) {
    if (primary.isTailExtension) continue;
    const openAfterM = primary.openAfterM ?? 0;
    if (primary.fullCoverage || openAfterM < 0.05) continue;

    const tailStart = primary.endS;
    const tailEnd = primary.gapEndS;
    const tailGapM = tailEnd - tailStart;
    const trackId = primary.trackId;
    const pbId = primary.physicalBoundaryGroup;
    const parentGapId = primary.gapId;

    const baseResult = {
      gapId: `${parentGapId}-TAIL`,
      parentGapId,
      physicalBoundaryGroup: pbId,
      trackId,
      chunkId,
      passId,
      startS: tailStart,
      endS: tailEnd,
      measuredGapLengthM: tailGapM,
      eligibility: { passed: false, reason: null },
      classification: 'T7',
      resolution: 'unchanged',
      preservedLengthM: 0,
      remainingOpenLengthM: tailGapM,
      preservedPointCount: 0,
      isTailExtension: true,
    };

    if (preservationCompetingBoundaryInGap({ startS: tailStart, endS: tailEnd }, cleaned, pbId, trackId)) {
      baseResult.eligibility.reason = 'competingBoundaryInGap';
      baseResult.classification = 'T6';
      results.push(baseResult);
      continue;
    }

    const candidate = findBestSpanningPolyline(
      frames, trajectory, { startS: tailStart, endS: tailEnd },
      trackId, chunkId, passId,
      { excludePolylineId: primary.sourcePolylineId, minInteriorS: tailStart },
    );

    if (!candidate) {
      baseResult.eligibility.reason = 'noMappedSourcePolylineInOpenTail';
      baseResult.classification = 'T7';
      results.push(baseResult);
      continue;
    }

    const openPoints = candidate.mappedPoints.filter(
      (p) => p.s > tailStart + DEDUP_S_TOLERANCE_M && p.s <= tailEnd + 0.01,
    );
    const preservedSd = dedupePointsByS(openPoints);

    if (preservedSd.length < 2) {
      const nearOnly = candidate.mappedPoints.filter((p) => p.s >= tailStart && p.s <= tailEnd);
      baseResult.eligibility.reason = preservedSd.length === 0 && nearOnly.length > 0
        ? 'candidateApproachesButDoesNotEnterOpenTailInterior'
        : 'insufficientPreservedPointsInOpenTail';
      baseResult.classification = nearOnly.length > 0 ? 'T3' : 'T7';
      baseResult.candidate = {
        sourceFrameId: candidate.frameId,
        sourcePolylineId: candidate.sourcePolylineId,
        mappedPointCount: nearOnly.length,
      };
      results.push(baseResult);
      continue;
    }

    const continuity = checkPolylineContinuity(preservedSd);
    if (!continuity.ok) {
      baseResult.eligibility.reason = continuity.reason;
      baseResult.classification = 'T5';
      baseResult.candidate = { sourceFrameId: candidate.frameId, sourcePolylineId: candidate.sourcePolylineId };
      results.push(baseResult);
      continue;
    }

    const nextRun = cleaned.find((r) => r.physicalBoundaryId === pbId
      && Math.abs((r.sMin ?? 0) - tailEnd) < 2.5);
    let endpointOk = true;
    let endpointReason = null;
    if (nextRun?.sdPoints?.length >= 2) {
      const toNext = endpointCompatibility(
        { sdPoints: [preservedSd[Math.max(0, preservedSd.length - 2)], preservedSd[preservedSd.length - 1]] },
        { sdPoints: nextRun.sdPoints.slice(0, 2) },
        { maxJoinLateralDeltaM: 0.8, maxJoinHeadingDeltaDeg: MAX_HEADING_DELTA_DEG },
      );
      if (!toNext.compatible) {
        endpointOk = false;
        endpointReason = 'lateralOrHeadingMismatchAtEnd';
      }
    }
    if (!endpointOk) {
      baseResult.eligibility.reason = endpointReason;
      baseResult.classification = 'T5';
      results.push(baseResult);
      continue;
    }

    const preservedStart = preservedSd[0].s;
    const preservedEnd = preservedSd[preservedSd.length - 1].s;
    const preservedLengthM = preservedEnd - preservedStart;
    const gapBeforeExtension = preservedStart - tailStart;
    const gapAfterExtension = tailEnd - preservedEnd;
    const remainingOpenLengthM = gapBeforeExtension + gapAfterExtension;

    const meta = {
      gapId: `${parentGapId}-TAIL`,
      parentGapId,
      sourceFrameId: candidate.frameId,
      logMonoTime: candidate.logMonoTime,
      sourceLaneIndex: candidate.laneIndex,
      sourcePolylineId: candidate.sourcePolylineId,
      physicalBoundaryGroup: pbId,
      trackId,
      chunkId,
      passId,
      sourceConfidence: candidate.sourceConfidence,
      preservationReason: remainingOpenLengthM < 0.5 ? 'D12_tailFullSpan' : 'D12_tailPartialSpan',
    };

    const preservedPoints = attachProvenance(preservedSd, meta);
    const interval = {
      ...meta,
      provenanceType: PROVENANCE_TYPE,
      isTailExtension: true,
      startS: preservedStart,
      endS: preservedEnd,
      gapStartS: primary.gapStartS,
      gapEndS: primary.gapEndS,
      tailOpenStartS: tailStart,
      tailOpenEndS: tailEnd,
      measuredGapLengthM: tailGapM,
      preservedLengthM,
      remainingOpenLengthM,
      openBeforeM: gapBeforeExtension,
      openAfterM: gapAfterExtension,
      preservedPointCount: preservedPoints.length,
      originalPointCount: candidate.originalPointCount,
      mappedPointCount: candidate.mappedPoints.length,
      sourcePolylineSRange: [candidate.spanStart, candidate.spanEnd],
      fullCoverage: remainingOpenLengthM < 0.5,
      resolution: remainingOpenLengthM < 0.5 ? 'fullyResolved' : 'partiallyResolved',
      points: preservedPoints,
      sdPoints: preservedPoints.map((p) => ({ s: p.s, d: p.d })),
      compoundD12D6: primary.compoundD12D6,
    };

    extensions.push(interval);
    const classification = remainingOpenLengthM < 0.5 ? 'T1' : 'T2';
    results.push({
      ...baseResult,
      eligibility: { passed: true, reason: null },
      classification,
      resolution: interval.resolution,
      preservedLengthM,
      remainingOpenLengthM,
      preservedPointCount: preservedPoints.length,
      sourceFrameId: candidate.frameId,
      sourcePolylineId: candidate.sourcePolylineId,
      gapBeforeExtensionM: gapBeforeExtension,
      gapAfterExtensionM: gapAfterExtension,
    });
  }

  return { extensions, results, tailAudit: results };
}

function mergePointsWithPreserved(fusedPoints, fusedSd, preservedPoints) {
  const combined = [];
  for (let i = 0; i < fusedPoints.length; i++) {
    combined.push({
      east: fusedPoints[i].east,
      north: fusedPoints[i].north,
      s: fusedSd[i]?.s,
      d: fusedSd[i]?.d,
      provenanceType: 'fusedAccepted',
    });
  }
  for (const p of preservedPoints) {
    combined.push({
      east: p.east,
      north: p.north,
      s: p.s,
      d: p.d,
      provenanceType: PROVENANCE_TYPE,
      provenance: p.provenance,
    });
  }
  combined.sort((a, b) => (a.s ?? 0) - (b.s ?? 0));
  return dedupePointsByS(combined);
}

/**
 * Apply preserved intervals to cleaned runs — merge display geometry only.
 */
function applyPreservedGeometryToCleaned(cleaned, preservedIntervals) {
  const byPbGap = new Map();
  for (const interval of preservedIntervals) {
    byPbGap.set(interval.gapId, interval);
  }

  const augmented = cleaned.map((run) => ({
    ...run,
    displayPoints: [...(run.points || [])],
    displaySdPoints: [...(run.sdPoints || [])],
    preservedSegments: [],
    pointProvenance: (run.points || []).map(() => 'fusedAccepted'),
  }));

  const runByKey = new Map();
  for (const run of augmented) {
    runByKey.set(`${run.physicalBoundaryId}:${run.sMin?.toFixed(1)}`, run);
  }

  for (const interval of preservedIntervals) {
    const pbId = interval.physicalBoundaryGroup;
    const gapStartS = interval.gapStartS;
    const gapEndS = interval.gapEndS;
    const prevRun = augmented.find((r) => r.physicalBoundaryId === pbId
      && Math.abs((r.sMax ?? 0) - gapStartS) < 2.5);
    const nextRun = augmented.find((r) => r.physicalBoundaryId === pbId
      && Math.abs((r.sMin ?? 0) - gapEndS) < 2.5);

    if (interval.fullCoverage && !interval.isTailExtension && prevRun && nextRun && prevRun !== nextRun) {
      const merged = mergePointsWithPreserved(
        [...prevRun.displayPoints, ...nextRun.displayPoints],
        [...prevRun.displaySdPoints, ...nextRun.displaySdPoints],
        interval.points,
      );
      prevRun.displayPoints = merged.map((p) => ({ east: p.east, north: p.north }));
      prevRun.displaySdPoints = merged.map((p) => ({ s: p.s, d: p.d }));
      prevRun.pointProvenance = merged.map((p) => p.provenanceType);
      prevRun.preservedSegments.push(interval);
      prevRun.mergedWithRunId = nextRun.runId;
      prevRun.sMax = Math.max(prevRun.sMax ?? 0, nextRun.sMax ?? 0, interval.endS);
      prevRun.sourceFragments = [
        ...(prevRun.sourceFragments || []),
        ...(nextRun.sourceFragments || []),
      ];
      nextRun._superseded = true;
      prevRun._absorbedNext = nextRun;
    } else if (prevRun) {
      const clipMin = interval.isTailExtension
        ? (interval.tailOpenStartS ?? interval.startS)
        : gapStartS;
      const merged = mergePointsWithPreserved(
        prevRun.displayPoints,
        prevRun.displaySdPoints,
        interval.points.filter((p) => p.s >= clipMin - 0.01),
      );
      prevRun.displayPoints = merged.map((p) => ({ east: p.east, north: p.north }));
      prevRun.displaySdPoints = merged.map((p) => ({ s: p.s, d: p.d }));
      prevRun.pointProvenance = merged.map((p) => p.provenanceType);
      prevRun.preservedSegments.push(interval);
      prevRun.sMax = Math.max(prevRun.sMax ?? 0, interval.endS);
    } else if (nextRun) {
      const merged = mergePointsWithPreserved(
        nextRun.displayPoints,
        nextRun.displaySdPoints,
        interval.points.filter((p) => p.s <= interval.gapEndS),
      );
      nextRun.displayPoints = merged.map((p) => ({ east: p.east, north: p.north }));
      nextRun.displaySdPoints = merged.map((p) => ({ s: p.s, d: p.d }));
      nextRun.pointProvenance = merged.map((p) => p.provenanceType);
      nextRun.preservedSegments.push(interval);
      nextRun.sMin = Math.min(nextRun.sMin ?? Infinity, interval.startS);
    }
  }

  const displayCleaned = augmented.filter((r) => !r._superseded).map((run) => ({
    ...run,
    points: run.displayPoints,
    sdPoints: run.displaySdPoints,
    lengthM: run.displaySdPoints.length >= 2
      ? Math.abs(run.displaySdPoints[run.displaySdPoints.length - 1].s - run.displaySdPoints[0].s)
      : run.lengthM,
  }));

  return { displayCleaned, augmented };
}

module.exports = {
  PROVENANCE_TYPE,
  DEDUP_S_TOLERANCE_M,
  SEGMENT2_D12_GAPS,
  extractMappedPolylinePoints,
  findBestSpanningPolyline,
  listCandidatePolylinesInRange,
  preserveSourcePolylinesForGaps,
  extendPartialTailPreservation,
  auditPartialTails,
  applyPreservedGeometryToCleaned,
  mergePointsWithPreserved,
  dedupePointsByS,
};
