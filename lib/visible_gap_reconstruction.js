'use strict';

/**
 * Stage 8: controlled visible reconstruction for structurally bridged gaps
 * that remain visually open (> renderer intra-gap threshold).
 */

const { dist2d } = require('./chunking');
const { endpointCompatibility, curvatureSummary } = require('./lane_run_audit');
const {
  canBridgeTrackerContinuousFusionGap,
  DEFAULT_TRACKER_CONTINUITY_BRIDGE,
} = require('./sd_fusion');

const RENDERER_MAX_INTRA_GAP_M = 15;
const DEFAULT_RECON_OPTS = {
  maxPointSpacingM: 1.0,
  minStructuralBridgeGapM: 12,
  maxStructuralBridgeGapM: 18,
  maxPositiveBoundaryBridgeGapM: 18,
  minRealSupportPoints: 3,
  tangentLookbackM: 8,
  tangentLookaheadM: 8,
  maxBridgeCurvatureDeg: 35,
  maxLateralDepartureM: 2.5,
  maxJoinHeadingDeltaDeg: 25,
  maxJoinLateralDeltaM: 0.8,
  minTangentStabilityDot: 0.7,
  repairStage: 8,
};

function isGeneratedPoint(pt) {
  return !!(pt?.generated || pt?.interpolationProvenance?.generated);
}

function isRealPoint(pt) {
  return pt && !isGeneratedPoint(pt);
}

function headingFromPoints(a, b) {
  return Math.atan2(b.north - a.north, b.east - a.east);
}

function headingDeg(a, b) {
  return (headingFromPoints(a, b) * 180) / Math.PI;
}

function normalizeVec(v) {
  const len = Math.hypot(v.east, v.north);
  if (len < 1e-9) return null;
  return { east: v.east / len, north: v.north / len };
}

function collectSupportPoints(points, sdPoints, index, direction, options = {}) {
  const opts = { ...DEFAULT_RECON_OPTS, ...options };
  const lookM = direction === 'before' ? opts.tangentLookbackM : opts.tangentLookaheadM;
  const out = [{ east: points[index].east, north: points[index].north, s: sdPoints[index]?.s, index }];
  let lastHeading = null;

  if (direction === 'before') {
    for (let i = index - 1; i >= 0; i--) {
      if (!isRealPoint(points[i])) continue;
      const prev = out[out.length - 1];
      const segHeading = headingDeg(points[i], prev);
      if (lastHeading != null) {
        let d = Math.abs(segHeading - lastHeading);
        if (d > 180) d = 360 - d;
        if (d > opts.maxJoinHeadingDeltaDeg) break;
      }
      lastHeading = segHeading;
      out.push({ east: points[i].east, north: points[i].north, s: sdPoints[i]?.s, index: i });
      const span = (sdPoints[index]?.s ?? 0) - (sdPoints[i]?.s ?? 0);
      if (out.length >= opts.minRealSupportPoints && span >= lookM) break;
    }
    out.reverse();
  } else {
    for (let i = index + 1; i < points.length; i++) {
      if (!isRealPoint(points[i])) continue;
      const prev = out[out.length - 1];
      const segHeading = headingDeg({ east: prev.east, north: prev.north }, points[i]);
      if (lastHeading != null) {
        let d = Math.abs(segHeading - lastHeading);
        if (d > 180) d = 360 - d;
        if (d > opts.maxJoinHeadingDeltaDeg) continue;
      }
      lastHeading = segHeading;
      out.push({ east: points[i].east, north: points[i].north, s: sdPoints[i]?.s, index: i });
      const span = (sdPoints[i]?.s ?? 0) - (sdPoints[index]?.s ?? 0);
      if (out.length >= opts.minRealSupportPoints && span >= lookM) break;
    }
  }
  return out;
}

function estimateEndpointTangent(points, sdPoints, index, direction, options = {}) {
  const opts = { ...DEFAULT_RECON_OPTS, ...options };
  const support = collectSupportPoints(points, sdPoints, index, direction, opts);
  if (support.length < opts.minRealSupportPoints) {
    return { stable: false, reason: 'insufficientSupportPoints', usedCount: support.length, supportPoints: support };
  }

  const segments = [];
  for (let i = 0; i < support.length - 1; i++) {
    segments.push({
      a: support[i],
      b: support[i + 1],
      ds: Math.abs((support[i + 1].s ?? 0) - (support[i].s ?? 0)),
    });
  }
  let vx = 0;
  let vy = 0;
  let wsum = 0;
  for (const seg of segments) {
    const w = Math.max(seg.ds, 0.25);
    vx += (seg.b.east - seg.a.east) * w;
    vy += (seg.b.north - seg.a.north) * w;
    wsum += w;
  }
  const tangent = normalizeVec({ east: vx / wsum, north: vy / wsum });
  if (!tangent) return { stable: false, reason: 'degenerateTangent', usedCount: support.length };

  const headings = segments.map((seg) => headingDeg(seg.a, seg.b));
  let maxDelta = 0;
  for (let i = 1; i < headings.length; i++) {
    let d = Math.abs(headings[i] - headings[i - 1]);
    if (d > 180) d = 360 - d;
    maxDelta = Math.max(maxDelta, d);
  }
  const lookDist = direction === 'before' ? opts.tangentLookbackM : opts.tangentLookaheadM;
  return {
    stable: maxDelta <= opts.maxJoinHeadingDeltaDeg,
    tangent,
    headingDeg: (Math.atan2(tangent.north, tangent.east) * 180) / Math.PI,
    usedCount: support.length,
    lookDistanceM: lookDist,
    maxSegmentHeadingDeltaDeg: maxDelta,
    supportPoints: support.map((p) => ({ east: p.east, north: p.north, s: p.s })),
  };
}

function findIntraRunJumps(points, sdPoints, thresholdM = RENDERER_MAX_INTRA_GAP_M) {
  const jumps = [];
  for (let i = 0; i < points.length - 1; i++) {
    const jumpM = dist2d(points[i], points[i + 1]);
    if (jumpM > thresholdM) {
      jumps.push({
        indexBefore: i,
        indexAfter: i + 1,
        jumpM,
        s0: sdPoints[i]?.s,
        s1: sdPoints[i + 1]?.s,
        pointBefore: points[i],
        pointAfter: points[i + 1],
        sdBefore: sdPoints[i],
        sdAfter: sdPoints[i + 1],
      });
    }
  }
  return jumps;
}

function mergeDecisionAtGap(mergeDecisions, s0, s1) {
  return (mergeDecisions || []).find((d) =>
    d.wasJoined
    && d.physicalBoundaryId
    && Math.abs((d.endS ?? -999) - s0) < 2
    && Math.abs((d.startS ?? -999) - s1) < 2);
}

function fragmentJoinAtGap(run, jump) {
  const frags = run.sourceFragments || [];
  if (frags.length < 2) return null;
  let ptCount = 0;
  for (let fi = 0; fi < frags.length - 1; fi++) {
    const frag = frags[fi];
    const next = frags[fi + 1];
    ptCount += (frag.points || []).length;
    const endS = frag.sdPoints?.slice(-1)[0]?.s;
    const startS = next.sdPoints?.[0]?.s;
    if (Math.abs(endS - jump.s0) < 2 && Math.abs(startS - jump.s1) < 2) {
      return { fragmentIndex: fi, endS, startS };
    }
  }
  return null;
}

function validateStructuralBridgeEvidence(run, jump, mergeDecisions, options = {}) {
  const opts = { ...DEFAULT_RECON_OPTS, ...DEFAULT_TRACKER_CONTINUITY_BRIDGE, ...options };
  const ds = (jump.s1 ?? 0) - (jump.s0 ?? 0);
  if (ds < opts.minStructuralBridgeGapM) {
    return { accepted: false, reason: 'belowMinStructuralBridgeGap' };
  }
  if (ds > opts.maxStructuralBridgeGapM) {
    return { accepted: false, reason: 'exceedsMaxStructuralBridgeGap' };
  }
  if (!run.physicalBoundaryId || !run.laneTrackId) {
    return { accepted: false, reason: 'missingBoundaryOrTrack' };
  }

  const compat = endpointCompatibility(
    { sdPoints: [jump.sdBefore, jump.sdBefore] },
    { sdPoints: [jump.sdAfter, jump.sdAfter] },
    {
      maxJoinLateralDeltaM: opts.maxJoinLateralDeltaM,
      maxJoinHeadingDeltaDeg: opts.maxJoinHeadingDeltaDeg,
    },
  );
  if (!compat.compatible) {
    return { accepted: false, reason: compat.reason || 'endpointIncompatible', compat };
  }

  const mergeHit = mergeDecisionAtGap(mergeDecisions, jump.s0, jump.s1);
  const fragJoin = fragmentJoinAtGap(run, jump);
  const laneObs = options.laneObservations?.filter((o) => o.laneTrackId === run.laneTrackId) || [];
  let fusionBridge = null;
  if (laneObs.length && jump.sdBefore && jump.sdAfter) {
    const prev = { s: jump.sdBefore.s, d: jump.sdBefore.d };
    const pt = { s: jump.sdAfter.s, d: jump.sdAfter.d };
    const current = [jump.sdBefore];
    const nextPt = jump.sdAfter;
    fusionBridge = canBridgeTrackerContinuousFusionGap(prev, pt, current, nextPt, laneObs, {
      ...opts,
      laneTrackId: run.laneTrackId,
      allLaneObservations: options.allLaneObservations || options.laneObservations,
      positiveBoundaryContinuityBridgeEnabled: options.positiveBoundaryContinuityBridgeEnabled !== false,
      trackerContinuityBridgeEnabled: true,
    });
  }

  const accepted = !!(mergeHit || fragJoin || fusionBridge?.bridge);
  if (fusionBridge?.bridge && fusionBridge.boundarySide !== 'positive') {
    return { accepted: false, reason: 'notPositiveBoundaryBridge', fusionBridge };
  }

  if (!accepted) {
    return {
      accepted: false,
      reason: fusionBridge?.reason || 'noStructuralBridgeEvidence',
      mergeHit: !!mergeHit,
      fragJoin: !!fragJoin,
      fusionBridge,
    };
  }

  return {
    accepted: true,
    reason: mergeHit ? 'cleanedRunMerge' : fragJoin ? 'fragmentJoin' : fusionBridge?.bridge ? 'fusionTrackerBridge' : 'geometryStructuralSignature',
    mergeHit,
    fragJoin,
    fusionBridge,
    gapRouteSM: ds,
    endpointCompatibility: compat,
  };
}

function sampleStraightBridge(p0, p1, s0, s1, maxSpacingM) {
  const chordM = dist2d(p0, p1);
  const n = Math.max(1, Math.ceil(chordM / maxSpacingM) - 1);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const s = s0 + t * (s1 - s0);
    out.push({
      east: p0.east + t * (p1.east - p0.east),
      north: p0.north + t * (p1.north - p0.north),
      s,
      d: (p0.d ?? 0) + t * ((p1.d ?? 0) - (p0.d ?? 0)),
    });
  }
  return out;
}

function hermite1d(p0, m0, p1, m1, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
}

function sampleHermiteBridge(p0, tan0, p1, tan1, sd0, sd1, maxSpacingM) {
  const chordM = dist2d(p0, p1);
  const n = Math.max(1, Math.ceil(chordM / maxSpacingM) - 1);
  const scale = chordM;
  const m0e = tan0.east * scale;
  const m0n = tan0.north * scale;
  const m1e = tan1.east * scale;
  const m1n = tan1.north * scale;
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const s = sd0.s + t * (sd1.s - sd0.s);
    out.push({
      east: hermite1d(p0.east, m0e, p1.east, m1e, t),
      north: hermite1d(p0.north, m0n, p1.north, m1n, t),
      s,
      d: hermite1d(sd0.d ?? 0, (tan0.north / Math.max(Math.hypot(tan0.east, tan0.north), 1e-9)) * 0,
        sd1.d ?? 0, (tan1.north / Math.max(Math.hypot(tan1.east, tan1.north), 1e-9)) * 0, t)
        || (sd0.d ?? 0) + t * ((sd1.d ?? 0) - (sd0.d ?? 0)),
    });
  }
  // Fix d interpolation linearly in s (more stable than hermite on d)
  for (const pt of out) {
    const t = (pt.s - sd0.s) / Math.max(sd1.s - sd0.s, 1e-9);
    pt.d = (sd0.d ?? 0) + t * ((sd1.d ?? 0) - (sd0.d ?? 0));
  }
  return out;
}

function bridgeCurvatureStats(points, sdPoints) {
  if (points.length < 3) return { maxHeadingDeltaDeg: 0 };
  const sd = sdPoints || points.map((p, i) => ({ s: p.s ?? i }));
  return curvatureSummary(sd);
}

function maxLateralDepartureFromChord(bridgePts, p0, p1) {
  const dx = p1.east - p0.east;
  const dy = p1.north - p0.north;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return 0;
  let max = 0;
  for (const p of bridgePts) {
    const t = ((p.east - p0.east) * dx + (p.north - p0.north) * dy) / len2;
    const px = p0.east + t * dx;
    const py = p0.north + t * dy;
    max = Math.max(max, Math.hypot(p.east - px, p.north - py));
  }
  return max;
}

function segmentCrossesBridge(bridgePts, otherPts) {
  if (!otherPts?.length || otherPts.length < 2 || bridgePts.length < 2) return false;
  const full = [bridgePts[0], ...bridgePts, bridgePts[bridgePts.length - 1]];
  for (let i = 0; i < full.length - 1; i++) {
    for (let j = 0; j < otherPts.length - 1; j++) {
      const cross = (o, p, q) => (p.east - o.east) * (q.north - o.north) - (p.north - o.north) * (q.east - o.east);
      const a = full[i];
      const b = full[i + 1];
      const c = otherPts[j];
      const d = otherPts[j + 1];
      const d1 = cross(a, b, c);
      const d2 = cross(a, b, d);
      const d3 = cross(c, d, a);
      const d4 = cross(c, d, b);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
        return true;
      }
    }
  }
  return false;
}

function attachProvenance(pt, meta, confidence) {
  return {
    east: pt.east,
    north: pt.north,
    generated: true,
    interpolationProvenance: {
      source: 'interpolated',
      generated: true,
      repairStage: meta.repairStage ?? DEFAULT_RECON_OPTS.repairStage,
      gapStableKey: meta.gapStableKey ?? null,
      physicalBoundaryId: meta.physicalBoundaryId,
      laneTrackId: meta.laneTrackId,
      chunkId: meta.chunkId,
      passId: meta.passId,
      interpolationMethod: meta.interpolationMethod,
      leftRealEndpoint: meta.leftRealEndpoint,
      rightRealEndpoint: meta.rightRealEndpoint,
      distanceToNearestRealObservationM: meta.distanceToNearestRealObservationM,
      confidence,
    },
  };
}

function confidenceAtT(t, baseConfidence) {
  const centre = 1 - 4 * (t - 0.5) * (t - 0.5);
  const floor = Math.max(0.05, baseConfidence * 0.35);
  const peak = Math.max(floor + 0.01, baseConfidence * 0.75);
  return floor + (peak - floor) * centre;
}

function evaluateReconstructionCandidates(run, jump, tangents, options = {}) {
  const opts = { ...DEFAULT_RECON_OPTS, ...options };
  const p0 = jump.pointBefore;
  const p1 = jump.pointAfter;
  const sd0 = jump.sdBefore;
  const sd1 = jump.sdAfter;
  const baseConf = Math.min(run.meanConfidence ?? 0.9, 0.95);

  const chord = { east: p1.east - p0.east, north: p1.north - p0.north };
  const chordLen = Math.hypot(chord.east, chord.north);
  const chordUnit = chordLen > 1e-9 ? { east: chord.east / chordLen, north: chord.north / chordLen } : null;
  if (!chordUnit) return { accepted: false, verdict: 'G', reason: 'degenerateGap' };

  const dot0 = tangents.before.tangent
    ? tangents.before.tangent.east * chordUnit.east + tangents.before.tangent.north * chordUnit.north
    : 0;
  const dot1 = tangents.after.tangent
    ? tangents.after.tangent.east * chordUnit.east + tangents.after.tangent.north * chordUnit.north
    : 0;
  if (dot0 < opts.minTangentStabilityDot || dot1 < opts.minTangentStabilityDot) {
    return { accepted: false, verdict: 'C', reason: 'unstableTangentOrDirectionReversal', dot0, dot1 };
  }

  const beforeCurv = bridgeCurvatureStats(
    tangents.before.supportPoints?.map((p) => ({ east: p.east, north: p.north })) || [],
    tangents.before.supportPoints?.map((p) => ({ s: p.s, d: 0 })) || [],
  );
  const afterCurv = bridgeCurvatureStats(
    tangents.after.supportPoints?.map((p) => ({ east: p.east, north: p.north })) || [],
    tangents.after.supportPoints?.map((p) => ({ s: p.s, d: 0 })) || [],
  );

  const candidates = [];
  const straightPts = sampleStraightBridge(p0, p1, sd0.s, sd1.s, opts.maxPointSpacingM);
  candidates.push({
    method: 'straight',
    points: straightPts,
    sdPoints: straightPts,
  });

  if (tangents.before.stable && tangents.after.stable) {
    const hermitePts = sampleHermiteBridge(
      p0, tangents.before.tangent, p1, tangents.after.tangent, sd0, sd1, opts.maxPointSpacingM,
    );
    candidates.push({
      method: 'cubicHermite',
      points: hermitePts,
      sdPoints: hermitePts,
    });
  }

  let best = null;
  for (const cand of candidates) {
    const pts = cand.points;
    if (!pts.length) continue;

    let monotonic = true;
    let prevS = sd0.s;
    for (const p of pts) {
      if (p.s <= prevS) { monotonic = false; break; }
      prevS = p.s;
    }
    if (!monotonic) continue;

    let maxSpacing = 0;
    const seq = [p0, ...pts, p1];
    for (let i = 0; i < seq.length - 1; i++) {
      maxSpacing = Math.max(maxSpacing, dist2d(seq[i], seq[i + 1]));
    }
    if (maxSpacing > opts.maxPointSpacingM + 0.05) continue;

    const latDep = maxLateralDepartureFromChord(pts, p0, p1);
    const curv = bridgeCurvatureStats(pts, pts);
    const maxCurv = Math.max(curv.maxHeadingDeltaDeg, beforeCurv.maxHeadingDeltaDeg, afterCurv.maxHeadingDeltaDeg);
    if (maxCurv > opts.maxBridgeCurvatureDeg) continue;
    if (latDep > opts.maxLateralDepartureM) continue;

  const straightCurv = bridgeCurvatureStats(straightPts, straightPts).maxHeadingDeltaDeg;
    const hermiteBetter = cand.method === 'cubicHermite'
      && Math.abs(tangents.before.headingDeg - tangents.after.headingDeg) > 8
      && curv.maxHeadingDeltaDeg + 0.5 < straightCurv;

    const score = (cand.method === 'straight' ? 10 : 0)
      + (hermiteBetter ? 5 : 0)
      - curv.maxHeadingDeltaDeg
      - latDep;

    if (!best || score > best.score) {
      best = {
        ...cand,
        score,
        maxSpacing,
        maxLateralDepartureM: latDep,
        maxCurvatureDeg: curv.maxHeadingDeltaDeg,
        hermiteBetter,
      };
    }
  }

  if (!best) {
    return { accepted: false, verdict: 'D', reason: 'noValidCandidate' };
  }

  const useHermite = best.method === 'cubicHermite' && best.hermiteBetter;
  const method = useHermite ? 'cubicHermite' : 'straight';
  const chosen = candidates.find((c) => c.method === method) || candidates[0];
  const gapKey = `${run.physicalBoundaryId}|${sd0.s.toFixed(2)}|${sd1.s.toFixed(2)}`;

  const provenancePts = chosen.points.map((pt, idx) => {
    const t = (idx + 1) / (chosen.points.length + 1);
    const conf = confidenceAtT(t, baseConf - 0.05);
    const distToReal = Math.min(t, 1 - t) * jump.jumpM;
    return attachProvenance(pt, {
      repairStage: opts.repairStage,
      gapStableKey: gapKey,
      physicalBoundaryId: run.physicalBoundaryId,
      laneTrackId: run.laneTrackId,
      chunkId: run.chunkId,
      passId: run.passId,
      interpolationMethod: method,
      leftRealEndpoint: { east: p0.east, north: p0.north, s: sd0.s },
      rightRealEndpoint: { east: p1.east, north: p1.north, s: sd1.s },
      distanceToNearestRealObservationM: distToReal,
    }, conf);
  });

  const provSd = chosen.points.map((pt, idx) => ({
    s: pt.s,
    d: pt.d,
    generated: true,
    interpolationMethod: method,
    confidence: provenancePts[idx].interpolationProvenance.confidence,
  }));

  return {
    accepted: true,
    verdict: method === 'straight' ? 'A' : 'B',
    method,
    points: provenancePts,
    sdPoints: provSd,
    insertedPointCount: provenancePts.length,
    generatedLengthM: chosen.points.reduce((sum, p, i) => {
      const prev = i === 0 ? p0 : chosen.points[i - 1];
      return sum + dist2d(prev, p);
    }, 0) + dist2d(chosen.points[chosen.points.length - 1], p1),
    maxPointSpacingM: best.maxSpacing,
    maxCurvatureDeg: best.maxCurvatureDeg,
    maxLateralDepartureM: best.maxLateralDepartureM,
    confidenceRange: [
      Math.min(...provenancePts.map((p) => p.interpolationProvenance.confidence)),
      Math.max(...provenancePts.map((p) => p.interpolationProvenance.confidence)),
    ],
    tangents: {
      before: tangents.before,
      after: tangents.after,
      headingDeltaDeg: Math.abs(tangents.before.headingDeg - tangents.after.headingDeg),
    },
    curvatureBefore: beforeCurv,
    curvatureAfter: afterCurv,
    gapStableKey: gapKey,
    inputEndpoints: [
      { east: p0.east, north: p0.north, s: sd0.s },
      { east: p1.east, north: p1.north, s: sd1.s },
    ],
  };
}

function applyVisibleGapReconstruction(cleaned, mergeDecisions, options = {}) {
  if (options.visibleGapReconstructionEnabled === false) {
    return { cleaned, repairs: [], stats: { enabled: false } };
  }

  const opts = { ...DEFAULT_RECON_OPTS, ...options };
  const repairs = [];
  const updated = cleaned.map((run) => ({ ...run, points: [...(run.points || [])], sdPoints: [...(run.sdPoints || [])] }));

  for (let ri = 0; ri < updated.length; ri++) {
    const run = updated[ri];
    const jumps = findIntraRunJumps(run.points, run.sdPoints, RENDERER_MAX_INTRA_GAP_M);
    if (!jumps.length) continue;

    const runMergeDecisions = (mergeDecisions || []).filter((d) =>
      d.physicalBoundaryId === run.physicalBoundaryId);

    let offset = 0;
    for (const jump of jumps) {
      const idxBefore = jump.indexBefore + offset;
      const idxAfter = jump.indexAfter + offset;
      const bridgeEvidence = validateStructuralBridgeEvidence(
        run,
        { ...jump, indexBefore: idxBefore, indexAfter: idxAfter },
        runMergeDecisions,
        opts,
      );
      if (!bridgeEvidence.accepted) {
        repairs.push({
          gapStableKey: `${run.physicalBoundaryId}|${jump.s0?.toFixed(2)}|${jump.s1?.toFixed(2)}`,
          accepted: false,
          verdict: 'G',
          reason: bridgeEvidence.reason,
          jumpM: jump.jumpM,
        });
        continue;
      }

      const tangents = {
        before: estimateEndpointTangent(run.points, run.sdPoints, idxBefore, 'before', opts),
        after: estimateEndpointTangent(run.points, run.sdPoints, idxAfter, 'after', opts),
      };
      if (!tangents.before.stable || !tangents.after.stable) {
        repairs.push({
          gapStableKey: `${run.physicalBoundaryId}|${jump.s0?.toFixed(2)}|${jump.s1?.toFixed(2)}`,
          accepted: false,
          verdict: 'C',
          reason: 'unstableTangent',
          tangents,
        });
        continue;
      }

      const recon = evaluateReconstructionCandidates(
        run,
        { ...jump, indexBefore: idxBefore, indexAfter: idxAfter },
        tangents,
        opts,
      );
      if (!recon.accepted) {
        repairs.push({
          gapStableKey: `${run.physicalBoundaryId}|${jump.s0?.toFixed(2)}|${jump.s1?.toFixed(2)}`,
          accepted: false,
          verdict: recon.verdict,
          reason: recon.reason,
        });
        continue;
      }

      const others = updated.filter((r, i) => i !== ri);
      let crossing = false;
      for (const other of others) {
        if (segmentCrossesBridge(recon.points, other.points)) {
          crossing = true;
          break;
        }
      }
      if (crossing) {
        repairs.push({
          gapStableKey: recon.gapStableKey,
          accepted: false,
          verdict: 'E',
          reason: 'crossingRisk',
        });
        continue;
      }

      const newPoints = [
        ...run.points.slice(0, idxAfter),
        ...recon.points,
        ...run.points.slice(idxAfter),
      ];
      const newSd = [
        ...run.sdPoints.slice(0, idxAfter),
        ...recon.sdPoints,
        ...run.sdPoints.slice(idxAfter),
      ];
      run.points = newPoints;
      run.sdPoints = newSd;
      offset += recon.insertedPointCount;
      run.visibleGapReconstruction = run.visibleGapReconstruction || [];
      run.visibleGapReconstruction.push(recon);

      repairs.push({
        gapStableKey: recon.gapStableKey,
        physicalBoundaryId: run.physicalBoundaryId,
        laneTrackId: run.laneTrackId,
        accepted: true,
        verdict: recon.verdict,
        method: recon.method,
        insertedPointCount: recon.insertedPointCount,
        generatedLengthM: recon.generatedLengthM,
        maxPointSpacingM: recon.maxPointSpacingM,
        confidenceRange: recon.confidenceRange,
        inputEndpoints: recon.inputEndpoints,
        tangents: recon.tangents,
        maxCurvatureDeg: recon.maxCurvatureDeg,
        maxLateralDepartureM: recon.maxLateralDepartureM,
        structuralEvidence: bridgeEvidence,
      });
    }
    updated[ri] = run;
  }

  const inserted = repairs.filter((r) => r.accepted);
  return {
    cleaned: updated,
    repairs,
    stats: {
      enabled: true,
      repairCount: inserted.length,
      rejectedCount: repairs.length - inserted.length,
      totalInsertedPoints: inserted.reduce((s, r) => s + r.insertedPointCount, 0),
      totalGeneratedLengthM: inserted.reduce((s, r) => s + r.generatedLengthM, 0),
    },
  };
}

function computeCoordinateChecksum(cleanedRuns) {
  let h = 2166136261;
  const mix = (n) => { h ^= n; h = Math.imul(h, 16777619); };
  for (const run of cleanedRuns || []) {
    for (const pt of run.points || []) {
      mix(Math.round((pt.east ?? 0) * 1000));
      mix(Math.round((pt.north ?? 0) * 1000));
      mix(pt.generated ? 1 : 0);
    }
  }
  return (h >>> 0).toString(16);
}

module.exports = {
  RENDERER_MAX_INTRA_GAP_M,
  DEFAULT_RECON_OPTS,
  isGeneratedPoint,
  isRealPoint,
  collectSupportPoints,
  estimateEndpointTangent,
  findIntraRunJumps,
  validateStructuralBridgeEvidence,
  sampleStraightBridge,
  sampleHermiteBridge,
  evaluateReconstructionCandidates,
  applyVisibleGapReconstruction,
  computeCoordinateChecksum,
  maxLateralDepartureFromChord,
  segmentCrossesBridge,
};
