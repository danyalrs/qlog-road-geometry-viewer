'use strict';

/**
 * Segment 2 road-surface Stage 1: boundary-pair eligibility audit and conservative polygon prototype.
 * Does not modify accepted lane geometry.
 */

const { polygonArea, validateRoadPolygon, countSelfIntersections } = require('./geometry_sanity');

const S_EPS = 0.02;
const MIN_SHARED_SPAN_M = 2.0;
const SAMPLE_STEP_M = 2.0;

const CANDIDATE_PAIRS = [
  { pairId: 'BP-PB1-PB0', leftPb: 'PB1', rightPb: 'PB0', laneLabel: 'mainLane_PB1_left_PB0_right' },
  { pairId: 'BP-PB2-PB1', leftPb: 'PB2', rightPb: 'PB1', laneLabel: 'outerLane_PB2_left_PB1_right' },
];

function getRunGeometry(run) {
  return {
    points: run.displayPoints || run.points || [],
    sdPoints: run.displaySdPoints || run.sdPoints || [],
    runId: run.runId,
    laneTrackId: run.laneTrackId,
    physicalBoundaryId: run.physicalBoundaryId,
    logicalGroupTrackIds: run.logicalGroupTrackIds || [run.laneTrackId],
    chunkId: run.chunkId ?? 0,
    passId: run.passId ?? 0,
    sMin: run.sMin,
    sMax: run.sMax,
    meanD: run.meanD,
  };
}

function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.startS - b.startS);
  const out = [];
  for (const iv of sorted) {
    if (!out.length || iv.startS > out[out.length - 1].endS + S_EPS) {
      out.push({ ...iv });
    } else {
      out[out.length - 1].endS = Math.max(out[out.length - 1].endS, iv.endS);
    }
  }
  return out;
}

function subtractOpenFromInterval(interval, openIntervals) {
  let parts = [{ startS: interval.startS, endS: interval.endS }];
  for (const open of openIntervals) {
    const next = [];
    for (const p of parts) {
      if (open.endS <= p.startS + S_EPS || open.startS >= p.endS - S_EPS) {
        next.push(p);
        continue;
      }
      if (open.startS > p.startS + S_EPS) {
        next.push({ startS: p.startS, endS: Math.min(open.startS, p.endS) });
      }
      if (open.endS < p.endS - S_EPS) {
        next.push({ startS: Math.max(open.endS, p.startS), endS: p.endS });
      }
    }
    parts = next.filter((p) => p.endS - p.startS > S_EPS);
  }
  return parts;
}

function pointAtS(points, sdPoints, targetS) {
  if (!points.length || !sdPoints.length) return null;
  if (targetS < sdPoints[0].s - S_EPS || targetS > sdPoints[sdPoints.length - 1].s + S_EPS) return null;
  for (let i = 0; i < sdPoints.length - 1; i++) {
    const s0 = sdPoints[i].s;
    const s1 = sdPoints[i + 1].s;
    if (targetS < s0 - S_EPS || targetS > s1 + S_EPS) continue;
    if (Math.abs(s1 - s0) < 1e-9) {
      return {
        point: { east: points[i].east, north: points[i].north },
        computed: false,
        vertexAIndex: i,
        vertexBIndex: i,
        fraction: 0,
        d: sdPoints[i].d,
      };
    }
    const t = Math.max(0, Math.min(1, (targetS - s0) / (s1 - s0)));
    return {
      point: {
        east: points[i].east + t * (points[i + 1].east - points[i].east),
        north: points[i].north + t * (points[i + 1].north - points[i].north),
      },
      computed: t > 1e-6 && t < 1 - 1e-6,
      vertexAIndex: i,
      vertexBIndex: i + 1,
      fraction: t,
      d: sdPoints[i].d + t * (sdPoints[i + 1].d - sdPoints[i].d),
    };
  }
  const last = sdPoints.length - 1;
  return {
    point: { east: points[last].east, north: points[last].north },
    computed: false,
    vertexAIndex: last,
    vertexBIndex: last,
    fraction: 0,
    d: sdPoints[last].d,
  };
}

function supportedIntervalsForPb(cleaned, pbId) {
  return cleaned
    .filter((r) => r.physicalBoundaryId === pbId && r.supportStatus === 'supported')
    .map((r) => {
      const g = getRunGeometry(r);
      return {
        runId: g.runId,
        laneTrackId: g.laneTrackId,
        logicalGroupTrackIds: g.logicalGroupTrackIds,
        chunkId: g.chunkId,
        passId: g.passId,
        startS: g.sMin,
        endS: g.sMax,
        meanD: g.meanD,
        geometry: g,
      };
    })
    .filter((iv) => iv.startS != null && iv.endS != null && iv.endS > iv.startS + S_EPS);
}

function intersectIntervals(aList, bList) {
  const out = [];
  for (const a of aList) {
    for (const b of bList) {
      if (a.chunkId !== b.chunkId || a.passId !== b.passId) continue;
      const startS = Math.max(a.startS, b.startS);
      const endS = Math.min(a.endS, b.endS);
      if (endS - startS > S_EPS) {
        out.push({
          startS,
          endS,
          leftRuns: [a],
          rightRuns: [b],
          chunkId: a.chunkId,
          passId: a.passId,
        });
      }
    }
  }
  return mergeIntervals(out.map((x) => ({ startS: x.startS, endS: x.endS, meta: x }))).map((iv, idx) => ({
  ...iv,
  intervalId: `raw-${idx}`,
}));
}

function collectOpenIntervals({
  classDGaps = [],
  interRunBreaks = [],
  separations = [],
  preservedIntervals = [],
}) {
  const opens = [];

  for (const brk of interRunBreaks || []) {
    opens.push({
      splitId: `D12-${brk.gapId}`,
      startS: brk.openIntervalStartS,
      endS: brk.openIntervalEndS,
      openLengthM: brk.openLengthM,
      physicalBoundaryId: brk.physicalBoundaryId,
      laneTrackId: brk.laneTrackId,
      reason: 'D12_remaining_open',
      sourceEvidence: brk.gapId,
      boundaryPairScope: 'single_boundary',
    });
  }

  for (const gap of classDGaps || []) {
    if (gap.primaryMechanism === 'D12' && ['CD-10', 'CD-12', 'CD-18'].includes(gap.gapId)) continue;
    if (gap.primaryMechanism === 'D12' && ['CD-00', 'CD-02'].includes(gap.gapId)) continue;
    const reason = gap.primaryMechanism === 'D6' ? 'D6_rejected_gap'
      : gap.primaryMechanism === 'D10' ? 'D10_control_gap'
        : gap.primaryMechanism === 'D12' ? 'D12_unsupported_gap' : 'classD_gap';
    opens.push({
      splitId: gap.gapId,
      startS: gap.startS,
      endS: gap.endS,
      openLengthM: gap.measuredGapLengthM ?? (gap.endS - gap.startS),
      physicalBoundaryId: gap.physicalBoundaryGroup,
      laneTrackId: gap.sourceTrackId,
      reason,
      sourceEvidence: gap.gapId,
      boundaryPairScope: 'single_boundary',
    });
  }

  for (const sep of separations || []) {
    if (sep.safeToJoin) continue;
    opens.push({
      splitId: `SEP-${sep.physicalBoundaryId}-${sep.prevRunS?.toFixed(1)}`,
      startS: sep.prevRunS,
      endS: sep.nextRunS,
      openLengthM: sep.gapM,
      physicalBoundaryId: sep.physicalBoundaryId,
      laneTrackId: sep.sourceTrackIds?.[0] ?? null,
      reason: sep.reason || sep.classification,
      classification: sep.classification,
      sourceEvidence: 'cleaned_run_separation',
      boundaryPairScope: 'single_boundary',
    });
  }

  for (const p of preservedIntervals || []) {
    if ((p.remainingOpenLengthM ?? 0) > 0.5 && p.openInterval) {
      opens.push({
        splitId: `PRES-${p.gapId}`,
        startS: p.openInterval.startS,
        endS: p.openInterval.endS,
        openLengthM: p.openInterval.lengthM ?? p.remainingOpenLengthM,
        physicalBoundaryId: p.physicalBoundaryGroup,
        laneTrackId: p.trackId,
        reason: 'preservation_remaining_open',
        sourceEvidence: p.gapId,
        boundaryPairScope: 'single_boundary',
      });
    }
  }

  return opens;
}

function openAffectsPair(open, leftPb, rightPb) {
  return open.physicalBoundaryId === leftPb || open.physicalBoundaryId === rightPb;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function samplePairAtS(cleaned, leftPb, rightPb, s, leftRuns, rightRuns) {
  const leftCandidates = leftRuns || supportedIntervalsForPb(cleaned, leftPb);
  const rightCandidates = rightRuns || supportedIntervalsForPb(cleaned, rightPb);
  const leftIv = leftCandidates.find((r) => s >= r.startS - S_EPS && s <= r.endS + S_EPS);
  const rightIv = rightCandidates.find((r) => s >= r.startS - S_EPS && s <= r.endS + S_EPS);
  if (!leftIv || !rightIv) return null;
  const lp = pointAtS(leftIv.geometry.points, leftIv.geometry.sdPoints, s);
  const rp = pointAtS(rightIv.geometry.points, rightIv.geometry.sdPoints, s);
  if (!lp || !rp) return null;
  const widthM = Math.hypot(lp.point.east - rp.point.east, lp.point.north - rp.point.north);
  return {
    s,
    left: lp,
    right: rp,
    widthM,
    leftRunId: leftIv.runId,
    rightRunId: rightIv.runId,
    leftD: lp.d,
    rightD: rp.d,
    orderConsistent: (lp.d ?? leftIv.meanD) > (rp.d ?? rightIv.meanD) - 0.05,
  };
}

function collectSampleWidths(cleaned, pair, sharedIntervals, openIntervals) {
  const widths = [];
  const pairOpens = openIntervals.filter((o) => openAffectsPair(o, pair.leftPb, pair.rightPb));
  for (const iv of sharedIntervals) {
    const trimmed = subtractOpenFromInterval(iv, pairOpens);
    for (const part of trimmed) {
      for (let s = part.startS; s <= part.endS + S_EPS; s += SAMPLE_STEP_M) {
        const sample = samplePairAtS(cleaned, pair.leftPb, pair.rightPb, Math.min(s, part.endS));
        if (sample?.orderConsistent && sample.widthM > 0.2) widths.push(sample.widthM);
      }
    }
  }
  return widths;
}

function inferWidthLimits(observedWidths) {
  const sorted = [...observedWidths].sort((a, b) => a - b);
  if (!sorted.length) {
    return { minPlausibleM: 2.0, maxPlausibleM: 8.0, observed: { count: 0 } };
  }
  return {
    minPlausibleM: Math.max(1.5, percentile(sorted, 0.05) * 0.85),
    maxPlausibleM: Math.min(12.0, percentile(sorted, 0.95) * 1.15),
    observed: {
      count: sorted.length,
      min: sorted[0],
      p05: percentile(sorted, 0.05),
      median: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted[sorted.length - 1],
    },
  };
}

function auditBoundaryPair(cleaned, pair, openIntervals, widthLimits) {
  const leftRuns = supportedIntervalsForPb(cleaned, pair.leftPb);
  const rightRuns = supportedIntervalsForPb(cleaned, pair.rightPb);
  const rawShared = [];
  for (const l of leftRuns) {
    for (const r of rightRuns) {
      if (l.chunkId !== r.chunkId || l.passId !== r.passId) continue;
      const startS = Math.max(l.startS, r.startS);
      const endS = Math.min(l.endS, r.endS);
      if (endS - startS > S_EPS) {
        rawShared.push({
          startS,
          endS,
          sharedLengthM: endS - startS,
          leftRunIds: [l.runId],
          rightRunIds: [r.runId],
          chunkId: l.chunkId,
          passId: l.passId,
        });
      }
    }
  }

  const pairOpens = openIntervals.filter((o) => openAffectsPair(o, pair.leftPb, pair.rightPb));
  const eligibleIntervals = [];
  const splits = [];
  let rejectionReason = null;
  let eligibility = 'ineligible';

  if (!leftRuns.length || !rightRuns.length) {
    rejectionReason = 'missing_boundary_support';
  } else if (!rawShared.length) {
    rejectionReason = 'no_shared_route_s_overlap';
  } else {
    for (const raw of rawShared) {
      const parts = subtractOpenFromInterval(raw, pairOpens);
      for (const part of parts) {
        if (part.endS - part.startS < MIN_SHARED_SPAN_M) continue;
        const samples = [];
        for (let s = part.startS; s <= part.endS + S_EPS; s += SAMPLE_STEP_M) {
          const sample = samplePairAtS(cleaned, pair.leftPb, pair.rightPb, Math.min(s, part.endS), leftRuns, rightRuns);
          if (sample) samples.push(sample);
        }
        if (!samples.length) continue;

        const widths = samples.map((x) => x.widthM);
        const med = percentile([...widths].sort((a, b) => a - b), 0.5);
        const minW = Math.min(...widths);
        const maxW = Math.max(...widths);
        const orderOk = samples.every((x) => x.orderConsistent);
        const widthOk = minW >= widthLimits.minPlausibleM && maxW <= widthLimits.maxPlausibleM;
        const crossing = !orderOk;

        if (orderOk && widthOk) {
          eligibleIntervals.push({
            ...part,
            sharedLengthM: part.endS - part.startS,
            medianWidthM: med,
            minWidthM: minW,
            maxWidthM: maxW,
            widthVariationM: maxW - minW,
            sampleCount: samples.length,
            leftRunIds: [...new Set(samples.map((x) => x.leftRunId))],
            rightRunIds: [...new Set(samples.map((x) => x.rightRunId))],
          });
        } else if (crossing) {
          splits.push({
            splitId: `ORDER-${pair.pairId}-${part.startS.toFixed(1)}`,
            routeS: (part.startS + part.endS) / 2,
            boundaryPairId: pair.pairId,
            reason: 'boundary_order_inversion',
            openLengthM: part.endS - part.startS,
            sourceEvidence: 'lateral_order_check',
          });
        } else {
          splits.push({
            splitId: `WIDTH-${pair.pairId}-${part.startS.toFixed(1)}`,
            routeS: (part.startS + part.endS) / 2,
            boundaryPairId: pair.pairId,
            reason: minW < widthLimits.minPlausibleM ? 'width_collapse' : 'width_spike',
            openLengthM: part.endS - part.startS,
            sourceEvidence: 'width_sampling',
          });
        }
      }
    }

    for (const open of pairOpens) {
      splits.push({
        splitId: open.splitId,
        routeS: (open.startS + open.endS) / 2,
        boundaryPairId: pair.pairId,
        reason: open.reason,
        precedingPolygonId: null,
        followingPolygonId: null,
        openLengthM: open.openLengthM ?? (open.endS - open.startS),
        sourceEvidence: open.sourceEvidence,
        physicalBoundaryId: open.physicalBoundaryId,
      });
    }

    if (eligibleIntervals.length) {
      eligibility = 'eligible';
      rejectionReason = null;
    } else {
      rejectionReason = rejectionReason || 'no_eligible_continuous_interval_after_splits';
    }
  }

  const totalShared = eligibleIntervals.reduce((s, iv) => s + iv.sharedLengthM, 0);
  return {
    candidatePairId: pair.pairId,
    leftPb: pair.leftPb,
    rightPb: pair.rightPb,
    leftTrackIds: [...new Set(leftRuns.flatMap((r) => r.logicalGroupTrackIds))],
    rightTrackIds: [...new Set(rightRuns.flatMap((r) => r.logicalGroupTrackIds))],
    leftCleanedRunIds: leftRuns.map((r) => r.runId),
    rightCleanedRunIds: rightRuns.map((r) => r.runId),
    chunkId: leftRuns[0]?.chunkId ?? rightRuns[0]?.chunkId ?? 0,
    passId: leftRuns[0]?.passId ?? rightRuns[0]?.passId ?? 0,
    sharedRouteSStart: eligibleIntervals.length ? Math.min(...eligibleIntervals.map((x) => x.startS)) : null,
    sharedRouteSEnd: eligibleIntervals.length ? Math.max(...eligibleIntervals.map((x) => x.endS)) : null,
    sharedSupportedLengthM: totalShared,
    medianLaneWidthM: eligibleIntervals.length
      ? percentile(eligibleIntervals.map((x) => x.medianWidthM).sort((a, b) => a - b), 0.5) : null,
    minLaneWidthM: eligibleIntervals.length ? Math.min(...eligibleIntervals.map((x) => x.minWidthM)) : null,
    maxLaneWidthM: eligibleIntervals.length ? Math.max(...eligibleIntervals.map((x) => x.maxWidthM)) : null,
    widthVariationM: eligibleIntervals.length
      ? Math.max(...eligibleIntervals.map((x) => x.widthVariationM)) : null,
    relativeHeadingDifferenceDeg: null,
    boundaryOrderConsistent: eligibility === 'eligible',
    crossingCount: 0,
    openIntervalsOnLeft: pairOpens.filter((o) => o.physicalBoundaryId === pair.leftPb).length,
    openIntervalsOnRight: pairOpens.filter((o) => o.physicalBoundaryId === pair.rightPb).length,
    competingBoundaryEvidence: null,
    eligibilityResult: eligibility,
    rejectionReason,
    eligibleIntervals,
    laneLabel: pair.laneLabel,
  };
}

function buildPolygonForInterval(cleaned, pair, interval, polygonIndex, openIntervals) {
  const leftRuns = supportedIntervalsForPb(cleaned, pair.leftPb);
  const rightRuns = supportedIntervalsForPb(cleaned, pair.rightPb);
  const pairOpens = openIntervals.filter((o) => openAffectsPair(o, pair.leftPb, pair.rightPb));
  const parts = subtractOpenFromInterval(interval, pairOpens);
  const polygons = [];

  for (const part of parts) {
    if (part.endS - part.startS < MIN_SHARED_SPAN_M) continue;
    const knotS = new Set([part.startS, part.endS]);
    for (const r of [...leftRuns, ...rightRuns]) {
      for (const sd of r.geometry.sdPoints || []) {
        if (sd.s >= part.startS - S_EPS && sd.s <= part.endS + S_EPS) knotS.add(sd.s);
      }
    }
    const sValues = [...knotS].sort((a, b) => a - b);
    const leftPts = [];
    const rightPts = [];
    const computedProvenance = [];

    for (const s of sValues) {
      const sample = samplePairAtS(cleaned, pair.leftPb, pair.rightPb, s, leftRuns, rightRuns);
      if (!sample || !sample.orderConsistent) continue;
      leftPts.push({ ...sample.left.point, s });
      rightPts.push({ ...sample.right.point, s });
      if (sample.left.computed) {
        computedProvenance.push({
          side: 'left',
          s,
          vertexAIndex: sample.left.vertexAIndex,
          vertexBIndex: sample.left.vertexBIndex,
          fraction: sample.left.fraction,
          runId: sample.leftRunId,
        });
      }
      if (sample.right.computed) {
        computedProvenance.push({
          side: 'right',
          s,
          vertexAIndex: sample.right.vertexAIndex,
          vertexBIndex: sample.right.vertexBIndex,
          fraction: sample.right.fraction,
          runId: sample.rightRunId,
        });
      }
    }

    if (leftPts.length < 2 || rightPts.length < 2) continue;

    const validation = validateRoadPolygon(leftPts, rightPts, {
      minRoadWidthM: 1.2,
      maxRoadWidthM: 12,
      maxVertexJumpM: 15,
    });
    const ring = [...leftPts, ...rightPts.slice().reverse()];
    const polygonId = `RS-${pair.pairId}-${polygonIndex}-${part.startS.toFixed(0)}`;
    polygons.push({
      polygonId,
      boundaryPairId: pair.pairId,
      leftPb: pair.leftPb,
      rightPb: pair.rightPb,
      leftTrackIds: [...new Set(leftRuns.flatMap((r) => r.logicalGroupTrackIds))],
      rightTrackIds: [...new Set(rightRuns.flatMap((r) => r.logicalGroupTrackIds))],
      leftRunIds: [...new Set(leftPts.map((_, i) => samplePairAtS(cleaned, pair.leftPb, pair.rightPb, sValues[i], leftRuns, rightRuns)?.leftRunId).filter((x) => x != null))],
      rightRunIds: [...new Set(rightPts.map((_, i) => samplePairAtS(cleaned, pair.leftPb, pair.rightPb, sValues[i], leftRuns, rightRuns)?.rightRunId).filter((x) => x != null))],
      chunkId: interval.chunkId ?? 0,
      passId: interval.passId ?? 0,
      routeSStart: part.startS,
      routeSEnd: part.endS,
      routeSSpanM: part.endS - part.startS,
      ring,
      leftBoundary: leftPts,
      rightBoundary: rightPts,
      computedPointProvenance: computedProvenance,
      widthStats: validation.stats,
      areaM2: validation.stats?.area ?? polygonArea(ring),
      vertexCount: ring.length,
      validationResult: validation.valid ? 'accepted' : 'rejected',
      rejectionReason: validation.valid ? null : validation.rejections.join(','),
      fragmentKind: 'roadSurfaceStage1',
      surfaceType: 'conservativeBoundaryStrip',
      provenanceComplete: true,
    });
    polygonIndex += 1;
  }
  return polygons;
}

function polygonsOverlap(a, b) {
  const aBox = boundingBox(a.ring);
  const bBox = boundingBox(b.ring);
  if (aBox.maxE < bBox.minE || bBox.maxE < aBox.minE) return false;
  if (aBox.maxN < bBox.minN || bBox.maxN < aBox.minN) return false;
  const centroidDist = Math.hypot(
    (aBox.minE + aBox.maxE) / 2 - (bBox.minE + bBox.maxE) / 2,
    (aBox.minN + aBox.maxN) / 2 - (bBox.minN + bBox.maxN) / 2,
  );
  return centroidDist < 2;
}

function boundingBox(ring) {
  const easts = ring.map((p) => p.east);
  const norths = ring.map((p) => p.north);
  return {
    minE: Math.min(...easts),
    maxE: Math.max(...easts),
    minN: Math.min(...norths),
    maxN: Math.max(...norths),
  };
}

function polygonSpansOpenInterval(poly, startS, endS, eps = S_EPS) {
  if (!poly) return false;
  const s0 = poly.routeSStart ?? poly.routeS?.start;
  const s1 = poly.routeSEnd ?? poly.routeS?.end;
  if (s0 == null || s1 == null) return false;
  return s0 < endS - eps && s1 > startS + eps;
}

function anyPolygonSpansInterval(polygons, startS, endS) {
  return polygons.some((p) => polygonSpansOpenInterval(p, startS, endS));
}

function polygonCoversRouteS(poly, s) {
  return s >= poly.routeSStart - S_EPS && s <= poly.routeSEnd + S_EPS;
}

function runStage1RoadSurface(cleaned, laneCleanup = {}, options = {}) {
  const classDGaps = options.classDGaps || laneCleanup.classDGaps || [];
  const interRunBreaks = laneCleanup.drawablePathAnalysis?.interRunBreaks || options.interRunBreaks || [];
  const separations = options.separations || [];
  const preservedIntervals = laneCleanup.preservedIntervals || options.preservedIntervals || [];

  const openIntervals = collectOpenIntervals({
    classDGaps,
    interRunBreaks,
    separations,
    preservedIntervals,
  });

  const allWidths = [];
  for (const pair of CANDIDATE_PAIRS) {
    const leftRuns = supportedIntervalsForPb(cleaned, pair.leftPb);
    const rightRuns = supportedIntervalsForPb(cleaned, pair.rightPb);
    const shared = [];
    for (const l of leftRuns) {
      for (const r of rightRuns) {
        const startS = Math.max(l.startS, r.startS);
        const endS = Math.min(l.endS, r.endS);
        if (endS - startS > S_EPS) shared.push({ startS, endS });
      }
    }
    allWidths.push(...collectSampleWidths(cleaned, pair, shared, openIntervals));
  }
  const widthLimits = inferWidthLimits(allWidths);

  const candidates = CANDIDATE_PAIRS.map((pair) => auditBoundaryPair(cleaned, pair, openIntervals, widthLimits));
  const eligible = candidates.filter((c) => c.eligibilityResult === 'eligible');
  const rejected = candidates.filter((c) => c.eligibilityResult !== 'eligible');

  const allSplits = candidates.flatMap((c) => (
    openIntervals
      .filter((o) => openAffectsPair(o, c.leftPb, c.rightPb))
      .map((open) => ({
        splitId: open.splitId,
        routeS: (open.startS + open.endS) / 2,
        boundaryPairId: c.candidatePairId,
        reason: open.reason,
        precedingPolygonId: null,
        followingPolygonId: null,
        openLengthM: open.openLengthM ?? (open.endS - open.startS),
        sourceEvidence: open.sourceEvidence,
        physicalBoundaryId: open.physicalBoundaryId,
      }))
  ));

  let polygons = [];
  let polyIdx = 0;
  for (const cand of eligible) {
    for (const interval of cand.eligibleIntervals) {
      const built = buildPolygonForInterval(
        cleaned,
        { pairId: cand.candidatePairId, leftPb: cand.leftPb, rightPb: cand.rightPb },
        { ...interval, chunkId: cand.chunkId, passId: cand.passId },
        polyIdx,
        openIntervals,
      );
      polygons.push(...built.filter((p) => p.validationResult === 'accepted'));
      polyIdx += built.length;
    }
  }

  const overlapPairs = [];
  for (let i = 0; i < polygons.length; i++) {
    for (let j = i + 1; j < polygons.length; j++) {
      if (polygonsOverlap(polygons[i], polygons[j])) overlapPairs.push([polygons[i].polygonId, polygons[j].polygonId]);
    }
  }

  const validationAudit = polygons.map((p) => ({
    polygonId: p.polygonId,
    areaM2: p.areaM2,
    routeSSpanM: p.routeSSpanM,
    vertexCount: p.vertexCount,
    widthStats: p.widthStats,
    validationResult: p.validationResult,
    rejectionReason: p.rejectionReason,
    provenanceComplete: p.provenanceComplete,
    selfIntersectionCount: countSelfIntersections(p.ring),
  }));

  const rejectedPolys = polygons.filter((p) => p.validationResult !== 'accepted');

  return {
    widthDistribution: widthLimits,
    openIntervals,
    eligibilityAudit: {
      candidateBoundaryPairs: candidates.length,
      eligibleBoundaryPairs: eligible.length,
      rejectedBoundaryPairs: rejected.length,
      candidates,
      rejected,
      eligible,
    },
  splits: allSplits,
    polygons: polygons.filter((p) => p.validationResult === 'accepted'),
    rejectedPolygons: rejectedPolys,
    validationAudit,
    overlapPairs,
    summary: {
      candidateBoundaryPairs: candidates.length,
      eligibleBoundaryPairs: eligible.length,
      rejectedBoundaryPairs: rejected.length,
      polygonsGenerated: polygons.filter((p) => p.validationResult === 'accepted').length,
      totalSupportedPolygonLengthM: polygons
        .filter((p) => p.validationResult === 'accepted')
        .reduce((s, p) => s + p.routeSSpanM, 0),
      totalPolygonAreaM2: polygons
        .filter((p) => p.validationResult === 'accepted')
        .reduce((s, p) => s + (p.areaM2 || 0), 0),
      polygonComponents: polygons.filter((p) => p.validationResult === 'accepted').length,
      unsupportedBreaksRetained: openIntervals.length,
      selfIntersections: validationAudit.reduce((s, v) => s + (v.selfIntersectionCount || 0), 0),
      polygonOverlaps: overlapPairs.length,
      extrapolatedPoints: polygons.reduce((s, p) => s + (p.computedPointProvenance?.length || 0), 0),
    },
    controls: {
      spansGap: (startS, endS) => anyPolygonSpansInterval(
        polygons.filter((p) => p.validationResult === 'accepted'),
        startS,
        endS,
      ),
    },
  };
}

module.exports = {
  CANDIDATE_PAIRS,
  collectOpenIntervals,
  auditBoundaryPair,
  runStage1RoadSurface,
  pointAtS,
  subtractOpenFromInterval,
  polygonCoversRouteS,
  polygonSpansOpenInterval,
  anyPolygonSpansInterval,
  getRunGeometry,
  inferWidthLimits,
};
