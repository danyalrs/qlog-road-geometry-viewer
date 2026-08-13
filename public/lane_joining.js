'use strict';

/**
 * Browser mirror of lib/lane_joining.js.
 * Regenerate with: node scripts/sync_lane_joining_public.js
 */

(function initLaneJoining(global) {
  const DEFAULTS = global.ConstructedFragments ? global.ConstructedFragments.DEFAULTS : {};
  /**
   * Lane-boundary fragment joining (EXPERIMENTAL, separate stage).
   *
   * Joins compatible constructed fragments into longer lane-boundary polylines
   * ("Joined lane polylines"). The constructed fragments are NEVER modified —
   * the joined output references them and adds connectors only across accepted
   * gaps.
   *
   * Hard prohibitions (never joined):
   *   - different chunk / pass / session
   *   - different physical boundary (L0/L1/L2/laneIndex)
   *   - opposite travel direction
   *   - spatial revisits (large backward temporal or spatial overlap)
   *   - GPS / pose discontinuities (split reasons largeStep)
   *   - self-intersection splits (split reasons lateralJump / spatialRevisit)
   *   - confirmed boundary crossings (connector crosses another boundary)
   *   - unresolved tracking-identity conflicts (split reasons temporalRevisit)
   *   - unsupported large gaps (no corridor evidence)
   *
   * Candidate generation: only same-boundary fragments whose start is forward in
   * local s from the current fragment end, inside a bounded spatial search area
   * (spatial grid index, not global pairwise comparison).
   *
   * Connection checks (all must pass before scoring):
   *   1. endpoint distance (euclidean gap)
   *   2. along-track continuity (forward in s, no reversal)
   *   3. robust tangent compatibility (endpoint tangents from several points)
   *   4. lateral alignment (extrapolated continuation vs other endpoint)
   *   5. curvature compatibility (no kink / sudden bend)
   *   6. temporal compatibility (timestamp order; temporal closeness never
   *      overrides bad geometry)
   *   7. evidence corridor (directly / weakly / occluded / unsupported)
   *   8. boundary separation (connector does not cross another boundary)
   *   9. track evidence (identity is supporting evidence only, never approval)
   *  10. ambiguity (one endpoint with several plausible candidates stays unjoined)
   *
   * Scoring + selection:
   *   - hard rejection gates run first
   *   - composite candidate score (gap, tangent, lateral, curvature, temporal,
   *     support, identity)
   *   - acceptance: all hard checks pass AND score >= threshold AND mutual-best
   *     AND clear margin over second-best AND no conflicting existing connection
   *   - each fragment has at most one predecessor and one successor (no
   *     branching — forks/merges belong to the later topology stage)
   *
   * Joined geometry: original fragments preserved byte-for-byte; a connector is
   * generated only across the accepted gap via conservative cubic interpolation
   * anchored on endpoint position and tangent, staying inside the supported
   * corridor. No smoothing across multiple joins.
   *
   * All thresholds live in the single JOINING_DEFAULTS configuration object.
   */

  // ---------------------------------------------------------------------------
  // Joining configuration. Derived from the accepted Segments 14/16 fragment
  // statistics and endpoint-gap distributions (see reports/joining_input_audit.json
  // and reports/joining_pair_audit.json). NOT tuned from the regression segments.
  // ---------------------------------------------------------------------------
  const JOINING_DEFAULTS = {
    // --- candidate search -----------------------------------------------------
    // Bounded spatial search area (m) around a fragment endpoint.
    maxSearchRadiusM: 40,
    // Grid cell size (m) for the spatial index.
    gridCellSizeM: 40,

    // --- hard gates -----------------------------------------------------------
    // Maximum euclidean endpoint gap accepted (m). Measured: seg14 max forward
    // pair gap 37.4 m, seg16 29.3 m; p90 30.4 m. 40 m = search bound; a candidate
    // must fall inside this to be scored.
    maxEndpointGapM: 40,
    // Maximum along-track (s) gap accepted (m). Module splits at 12 m; joining
    // across a larger along-track gap requires evidence.
    maxAlongTrackGapM: 40,
    // Maximum endpoint tangent difference (deg) — robust tangents (k points).
    // Measured: seg14 max 8.0°, seg16 max 3.6°; medians ~2°/1°. Reject sharp
    // kinks (unsupported bends).
    maxTangentDiffDeg: 20,
    // Maximum lateral extrapolation error (m). Measured: seg14 med 0.88, p90 1.48,
    // max 2.86; seg16 med 0.86, max 1.17.
    maxLateralErrM: 3.0,
    // Maximum connector curvature change (deg over the gap) before a kink is
    // declared. Derived from maxTangentDiffDeg across the connector.
    maxCurvatureChangeDeg: 25,
    // Maximum temporal separation (s) between fragment end and next start.
    // Frame interleave produces dt of -4..0 s; genuine revisits are tens of
    // seconds. Reject only large gaps in EITHER direction.
    maxTemporalSepSec: 30,
    // Maximum backward temporal jump tolerated (s) — beyond this it is a
    // genuine revisit, not interleave.
    maxRevisitBackwardSec: 10,
    // Minimum number of same-boundary corridor observations with repeated-frame
    // support required to classify a gap as "directly supported".
    minCorridorSupportedDots: 2,
    // For gaps larger than this (m) the corridor must be directly supported.
    largeGapThresholdM: 12,

    // --- scoring --------------------------------------------------------------
    // Score weights (must sum to 1.0).
    weightGap: 0.25,
    weightTangent: 0.25,
    weightLateral: 0.20,
    weightCurvature: 0.10,
    weightTemporal: 0.05,
    weightSupport: 0.10,
    weightIdentity: 0.05,
    // Minimum composite score to accept a join.
    minAcceptScore: 0.55,
    // Minimum margin over the second-best candidate to accept.
    minAmbiguityMargin: 0.12,

    // --- connector geometry ---------------------------------------------------
    // Number of interpolated connector vertices (excluding endpoints).
    connectorSegments: 6,
    // Maximum lateral deviation of the connector from the straight line between
    // endpoints (m) — keeps the connector inside the supported corridor.
    maxConnectorDeviationM: 4.0,
  };

  // --- small helpers ---------------------------------------------------------

  function dist2d(a, b) {
    return Math.hypot((b.east ?? 0) - (a.east ?? 0), (b.north ?? 0) - (a.north ?? 0));
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  /** Physical-boundary identity of a fragment. */
  function boundaryId(f) {
    return `${f.chunkId}:${f.passId}:${f.groupTrackId}:${f.laneIndex}`;
  }

  /** Robust endpoint tangent (unit vector) from the last/first k points. */
  function endpointTangent(frag, which, k = 4) {
    const pts = frag.points;
    if (pts.length < 2) return null;
    const kk = Math.min(k, pts.length - 1);
    let a, b;
    if (which === 'end') { a = pts[pts.length - 1 - kk]; b = pts[pts.length - 1]; }
    else { a = pts[0]; b = pts[kk]; }
    const len = dist2d(a, b) || 1e-9;
    return { dx: (b.east - a.east) / len, dy: (b.north - a.north) / len };
  }

  /**
   * Robust endpoint tangent in the MIRRORED frame, from the precomputed
   * mirrored coordinates on the fragment points. Display-only; used to build the
   * mirrored connector path consistently with the canonical one.
   */
  function endpointTangentMirrored(frag, which, k = 4) {
    const pts = frag.points;
    if (pts.length < 2) return null;
    const kk = Math.min(k, pts.length - 1);
    let a, b;
    if (which === 'end') { a = pts[pts.length - 1 - kk]; b = pts[pts.length - 1]; }
    else { a = pts[0]; b = pts[kk]; }
    const ex = (p) => (p.mirroredEast != null ? p.mirroredEast : p.east);
    const ey = (p) => (p.mirroredNorth != null ? p.mirroredNorth : p.north);
    const len = Math.hypot(ex(b) - ex(a), ey(b) - ey(a)) || 1e-9;
    return { dx: (ex(b) - ex(a)) / len, dy: (ey(b) - ey(a)) / len };
  }

  function tangentDiffDeg(t1, t2) {
    if (!t1 || !t2) return null;
    const dot = clamp(t1.dx * t2.dx + t1.dy * t2.dy, -1, 1);
    return Math.acos(dot) * 180 / Math.PI;
  }

  /** Signed lateral offset of point p from the oriented line a->b (left positive). */
  function lateralOffset(p, a, b) {
    const de = b.east - a.east, dn = b.north - a.north;
    const len = Math.hypot(de, dn) || 1e-9;
    return ((p.east - a.east) * (-dn) + (p.north - a.north) * de) / len;
  }

  /** Signed perpendicular distance of point p to the line through a,b (abs). */
  function pointToLineDist(p, a, b) {
    const de = b.east - a.east, dn = b.north - a.north;
    const len = Math.hypot(de, dn) || 1e-9;
    return Math.abs(((p.east - a.east) * dn - (p.north - a.north) * de) / len);
  }

  /** True if segment (a1,a2) strictly crosses segment (b1,b2). */
  function segmentsCross(a1, a2, b1, b2) {
    const cross = (o, p, q) => (p.east - o.east) * (q.north - o.north) - (p.north - o.north) * (q.east - o.east);
    const d1 = cross(a1, a2, b1), d2 = cross(a1, a2, b2);
    const d3 = cross(b1, b2, a1), d4 = cross(b1, b2, a2);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }

  // ---------------------------------------------------------------------------
  // Evidence corridor classification
  // ---------------------------------------------------------------------------

  /**
   * Classify the evidence between fragment A's end and fragment B's start.
   * Corridor points are same-boundary observations whose s lies between the two
   * endpoints (inclusive window). The fragment ENDPOINT observations themselves
   * are excluded — only interior evidence counts. Returns the label and counts.
   */
  function classifyCorridor(A, B, allPoints, opts) {
    const Ae = A.points[A.points.length - 1];
    const Bs = B.points[0];
    const corridor = allPoints.filter((p) =>
      p.chunkId === A.chunkId && p.passId === A.passId &&
      String(p.groupTrackId) === String(A.groupTrackId) &&
      p.s >= Ae.s - 2 && p.s <= Bs.s + 2,
    );
    // interior only: exclude observations at or beyond the fragment endpoints
    const interior = corridor.filter((p) => p.s > Ae.s + 0.5 && p.s < Bs.s - 0.5);
    const supported = interior.filter((p) => (p.supportFrameCount ?? 1) >= 2);
    const gap = dist2d(Ae, Bs);

    let label;
    if (supported.length >= opts.minCorridorSupportedDots) {
      label = 'directly_supported';
    } else if (supported.length >= 1 || interior.length >= 2) {
      label = 'weakly_supported';
    } else if (interior.length === 0 && gap > opts.largeGapThresholdM) {
      label = 'unsupported';
    } else {
      label = 'occluded_or_missing';
    }
    return {
      label,
      corridorTotal: corridor.length,
      corridorInside: interior.length,
      supportedInside: supported,
    };
  }

  /**
   * Check whether the connector segment Aend->Bstart crosses any OTHER
   * physical boundary's polyline (boundary separation, check 8).
   */
  function connectorCrossesOtherBoundary(A, B, fragments) {
    const Ae = A.points[A.points.length - 1];
    const Bs = B.points[0];
    const bId = boundaryId(A);
    for (const F of fragments) {
      if (boundaryId(F) === bId) continue;
      const pts = F.points;
      for (let i = 0; i < pts.length - 1; i++) {
        if (segmentsCross(Ae, Bs, pts[i], pts[i + 1])) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Connection evaluation
  // ---------------------------------------------------------------------------

  /** Estimate curvature at a fragment end (deg/m over the last few segments). */
  function endpointCurvature(frag, which) {
    const pts = frag.points;
    if (pts.length < 4) return 0;
    let iA, iB, iC;
    if (which === 'end') { iA = pts.length - 3; iB = pts.length - 2; iC = pts.length - 1; }
    else { iA = 0; iB = 1; iC = 2; }
    const a = pts[iA], b = pts[iB], c = pts[iC];
    const ab = [b.east - a.east, b.north - a.north];
    const bc = [c.east - b.east, c.north - b.north];
    const la = Math.hypot(...ab) || 1e-9, lb = Math.hypot(...bc) || 1e-9;
    const dot = clamp((ab[0] * bc[0] + ab[1] * bc[1]) / (la * lb), -1, 1);
    const deg = Math.acos(dot) * 180 / Math.PI;
    const span = dist2d(a, c) || 1e-9;
    return deg / span;
  }

  /**
   * Evaluate one candidate join (A end -> B start). Returns
   * { pass, reasons, measurements, score, ... } or { pass:false, reason }.
   */
  function evaluateCandidate(A, B, ctx) {
    const o = ctx.opts;
    const Ae = A.points[A.points.length - 1];
    const Bs = B.points[0];
    const gap = dist2d(Ae, Bs);
    const sGap = Bs.s - Ae.s;
    const measurements = {
      endpointGapM: gap,
      alongTrackGapM: sGap,
      fromFragmentId: A.fragmentId,
      toFragmentId: B.fragmentId,
      physicalBoundaryId: boundaryId(A),
      chunkId: A.chunkId,
      passId: A.passId,
      laneIndex: A.laneIndex,
    };

    // --- hard checks ----------------------------------------------------------

    // 0. identity + chunk/pass
    if (boundaryId(A) !== boundaryId(B)) {
      return { pass: false, reason: 'different_physical_boundary', measurements };
    }

    // 2. along-track continuity (forward in s, no reversal / overlap)
    if (sGap <= 0) {
      return { pass: false, reason: 'not_forward_in_s', measurements };
    }

    // split reasons that hard-prohibit joining
    const prohibitSplits = new Set(['spatialRevisit', 'temporalRevisit', 'largeStep', 'lateralJump', 'chunkChange', 'passChange']);
    if (prohibitSplits.has(A.splitReason) || prohibitSplits.has(B.splitReason)) {
      return { pass: false, reason: `hard_prohibit_split_${A.splitReason || B.splitReason}`, measurements };
    }

    // 1. endpoint distance
    if (gap > o.maxEndpointGapM) {
      return { pass: false, reason: 'endpoint_gap_too_large', measurements };
    }
    if (sGap > o.maxAlongTrackGapM) {
      return { pass: false, reason: 'along_track_gap_too_large', measurements };
    }

    // 3. tangent compatibility (robust)
    const tA = endpointTangent(A, 'end');
    const tB = endpointTangent(B, 'start');
    const tanDiff = tangentDiffDeg(tA, tB);
    if (tanDiff == null || tanDiff > o.maxTangentDiffDeg) {
      return { pass: false, reason: 'tangent_incompatible', measurements };
    }
    // opposite travel direction
    if (tA && tB && (tA.dx * tB.dx + tA.dy * tB.dy) < 0) {
      return { pass: false, reason: 'opposite_travel_direction', measurements };
    }

    // 4. lateral alignment (extrapolate A's continuation to B's s)
    let lateralErr = null;
    if (tA && sGap > 0) {
      const predE = Ae.east + tA.dx * sGap;
      const predN = Ae.north + tA.dy * sGap;
      lateralErr = Math.abs(lateralOffset(Bs, Ae, { east: predE, north: predN }));
    }
    if (lateralErr != null && lateralErr > o.maxLateralErrM) {
      return { pass: false, reason: 'lateral_misalignment', measurements };
    }

    // 5. curvature compatibility (no unsupported bend across the gap)
    const curvA = endpointCurvature(A, 'end');
    const curvB = endpointCurvature(B, 'start');
    const impliedCurv = sGap > 0 ? tanDiff / Math.max(sGap, 0.5) : 0;
    const curvatureChange = Math.max(Math.abs(impliedCurv - curvA), Math.abs(impliedCurv - curvB));
    measurements.curvatureChangeDegPerM = curvatureChange;
    if (curvatureChange > o.maxCurvatureChangeDeg) {
      return { pass: false, reason: 'curvature_kink', measurements };
    }

    // 6. temporal compatibility
    let dtSec = null;
    if (A.endLogMonoTime != null && B.startLogMonoTime != null) {
      dtSec = (Number(BigInt(String(B.startLogMonoTime))) - Number(BigInt(String(A.endLogMonoTime)))) / 1e9;
    }
    measurements.temporalDiffSec = dtSec;
    if (dtSec != null && dtSec < -o.maxRevisitBackwardSec) {
      return { pass: false, reason: 'temporal_revisit', measurements };
    }
    if (dtSec != null && dtSec > o.maxTemporalSepSec) {
      return { pass: false, reason: 'temporal_gap', measurements };
    }

    // 7. evidence corridor
    const corridor = classifyCorridor(A, B, ctx.allPoints, o);
    measurements.corridor = corridor.label;
    measurements.corridorSupportedInside = corridor.supportedInside.length;
    measurements.corridorTotalInside = corridor.corridorInside;
    if (corridor.label === 'unsupported') {
      return { pass: false, reason: 'unsupported_gap', measurements };
    }
    // large gaps (> largeGapThresholdM) require directly-supported corridor
    if (gap > o.largeGapThresholdM && corridor.label !== 'directly_supported') {
      return { pass: false, reason: 'large_gap_insufficient_evidence', measurements };
    }

    // 8. boundary separation (connector does not cross another boundary)
    if (connectorCrossesOtherBoundary(A, B, ctx.fragments)) {
      return { pass: false, reason: 'crosses_other_boundary', measurements };
    }

    // 9. track evidence is supporting only — identity already required to match.

    // 10. ambiguity handled at selection (not here).

    measurements.tangentDiffDeg = tanDiff;
    measurements.lateralErrM = lateralErr;
    measurements.curvatureA = curvA;
    measurements.curvatureB = curvB;

    // --- scoring --------------------------------------------------------------
    const score = scoreCandidate(measurements, corridor, o);
    return { pass: true, reason: 'candidate', measurements, score };
  }

  function scoreCandidate(m, corridor, o) {
    const gapScore = 1 - clamp(m.endpointGapM / o.maxEndpointGapM, 0, 1);
    const tangentScore = 1 - clamp((m.tangentDiffDeg ?? 0) / o.maxTangentDiffDeg, 0, 1);
    const lateralScore = 1 - clamp((m.lateralErrM ?? 0) / o.maxLateralErrM, 0, 1);
    const curvatureScore = 1 - clamp((m.curvatureChangeDegPerM ?? 0) / o.maxCurvatureChangeDeg, 0, 1);
    const temporalScore = m.temporalDiffSec == null
      ? 0.5
      : 1 - clamp(Math.abs(m.temporalDiffSec) / o.maxTemporalSepSec, 0, 1);
    const supportScore = corridor.label === 'directly_supported' ? 1
      : corridor.label === 'weakly_supported' ? 0.6
        : corridor.label === 'occluded_or_missing' ? 0.4 : 0;
    const identityScore = 1; // identity matched (hard gate)

    const score =
      o.weightGap * gapScore +
      o.weightTangent * tangentScore +
      o.weightLateral * lateralScore +
      o.weightCurvature * curvatureScore +
      o.weightTemporal * temporalScore +
      o.weightSupport * supportScore +
      o.weightIdentity * identityScore;
    return +score.toFixed(4);
  }

  // ---------------------------------------------------------------------------
  // Candidate generation + selection
  // ---------------------------------------------------------------------------

  /**
   * Spatial grid index over fragment start points for bounded candidate search.
   * Cells keyed by rounded (east, north) / cellSize. Query returns fragments
   * whose start point lies within maxSearchRadiusM of the query point.
   */
  function buildSpatialIndex(fragments, o) {
    const index = new Map();
    const cellOf = (e, n) => `${Math.round(e / o.gridCellSizeM)}:${Math.round(n / o.gridCellSizeM)}`;
    for (const f of fragments) {
      const s = f.points[0];
      const key = cellOf(s.east, s.north);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(f);
    }
    return { index, cellOf };
  }

  function querySpatialIndex(si, e, n, radius, o) {
    const result = [];
    const rCells = Math.ceil(radius / o.gridCellSizeM);
    const cx = Math.round(e / o.gridCellSizeM);
    const cy = Math.round(n / o.gridCellSizeM);
    for (let dx = -rCells; dx <= rCells; dx++) {
      for (let dy = -rCells; dy <= rCells; dy++) {
        const bucket = si.index.get(`${cx + dx}:${cy + dy}`);
        if (!bucket) continue;
        for (const f of bucket) {
          const s = f.points[0];
          if (dist2d({ east: e, north: n }, s) <= radius) result.push(f);
        }
      }
    }
    return result;
  }

  /**
   * Generate candidate pairs. For each fragment A, query the spatial index near
   * A's END point for fragments B with:
   *   - different fragmentId
   *   - same physical boundary
   *   - B start forward in s (Bs.s > Ae.s)
   *   - within maxSearchRadiusM
   * The spatial index restricts the search to a bounded area (no global
   * pairwise comparison).
   */
  function generateCandidates(fragments, si, o) {
    const candidates = [];
    const indexByBoundary = new Map();
    for (const f of fragments) {
      const k = boundaryId(f);
      if (!indexByBoundary.has(k)) indexByBoundary.set(k, []);
      indexByBoundary.get(k).push(f);
    }
    for (const A of fragments) {
      const Ae = A.points[A.points.length - 1];
      const near = querySpatialIndex(si, Ae.east, Ae.north, o.maxSearchRadiusM, o);
      for (const B of near) {
        if (B.fragmentId === A.fragmentId) continue;
        if (boundaryId(A) !== boundaryId(B)) continue;
        const Bs = B.points[0];
        if (Bs.s <= Ae.s) continue; // must continue forward
        candidates.push({ from: A, to: B });
      }
    }
    return candidates;
  }

  /**
   * Select accepted joins with mutual-best matching, clear margin over the
   * second-best candidate, and at most one predecessor + one successor per
   * fragment (no branching).
   */
  /**
   * Select accepted joins with mutual-best matching, clear margin over the
   * second-best candidate, and at most one predecessor + one successor per
   * fragment (no branching).
   *
   * Mutual-best: a connection A->B is accepted only when A's best successor is B
   * AND B's best predecessor is A. Forks/merges (branching) are left unjoined.
   */
  function selectJoins(candidateResults, opts) {
    const o = opts || JOINING_DEFAULTS;

    // best candidate per source (A -> its best target)
    const bySource = new Map();
    for (const c of candidateResults) {
      if (!bySource.has(c.from)) bySource.set(c.from, []);
      bySource.get(c.from).push(c);
    }
    const bestPerSource = new Map(); // fragmentId -> {c, margin}
    for (const [from, list] of bySource) {
      const scored = list.filter((c) => c.pass).sort((a, b) => b.score - a.score);
      if (!scored.length) continue;
      const best = scored[0];
      const second = scored[1];
      const margin = second ? best.score - second.score : 1;
      bestPerSource.set(from.fragmentId, { c: best, margin, secondBestScore: second ? second.score : null });
    }

    // best candidate per target (B -> its best source) — mutual best check
    const byTarget = new Map();
    for (const c of candidateResults) {
      if (!byTarget.has(c.to)) byTarget.set(c.to, []);
      byTarget.get(c.to).push(c);
    }
    const bestPerTarget = new Map(); // fragmentId -> c
    for (const [to, list] of byTarget) {
      const scored = list.filter((c) => c.pass).sort((a, b) => b.score - a.score);
      if (!scored.length) continue;
      bestPerTarget.set(to.fragmentId, scored[0]);
    }

    const chosen = [];
    const usedAsSource = new Set();
    const usedAsTarget = new Set();

    // Process sources in order of decreasing (margin, score) so clear winners are
    // claimed first and conflicting endpoints are skipped.
    const order = [...bestPerSource.entries()]
      .sort((a, b) => (b[1].margin - a[1].margin) || (b[1].c.score - a[1].c.score));

    for (const [fromId, { c: best, margin, secondBestScore }] of order) {
      if (usedAsSource.has(fromId)) continue;
      if (margin < o.minAmbiguityMargin) continue; // ambiguous -> stay unjoined
      if (best.score < o.minAcceptScore) continue;
      const toId = best.to.fragmentId;
      if (usedAsTarget.has(toId)) continue; // target already claimed (no branching)

      // mutual-best: B's best predecessor must be A
      const bBest = bestPerTarget.get(toId);
      if (!bBest || bBest.from.fragmentId !== fromId) continue;

      chosen.push({ ...best, margin, secondBestScore });
      usedAsSource.add(fromId);
      usedAsTarget.add(toId);
    }
    return chosen;
  }

  // ---------------------------------------------------------------------------
  // Connector geometry + joined polyline
  // ---------------------------------------------------------------------------

  /**
   * Build a connector polyline from A's end to B's start using cubic interpolation
   * anchored on endpoint positions and tangents. Carries BOTH the canonical
   * (east/north) and the precomputed mirrored (mirroredEast/mirroredNorth)
   * coordinates, so the renderer can use the same geometry-only mirror mechanism
   * as the dots. Returns { points, lengthM, maxDeviationM }.
   */
  function buildConnector(A, B, o) {
    const Ae = A.points[A.points.length - 1];
    const Bs = B.points[0];
    const tA = endpointTangent(A, 'end') || { dx: (Bs.east - Ae.east) / (dist2d(Ae, Bs) || 1e-9), dy: (Bs.north - Ae.north) / (dist2d(Ae, Bs) || 1e-9) };
    const tB = endpointTangent(B, 'start') || { dx: (Bs.east - Ae.east) / (dist2d(Ae, Bs) || 1e-9), dy: (Bs.north - Ae.north) / (dist2d(Ae, Bs) || 1e-9) };
    const gap = dist2d(Ae, Bs) || 1e-9;
    // control handles: tangent-scaled (Catmull-Rom-like / Hermite)
    const handle = gap * 0.35;
    const c1 = { east: Ae.east + tA.dx * handle, north: Ae.north + tA.dy * handle };
    const c2 = { east: Bs.east - tB.dx * handle, north: Bs.north - tB.dy * handle };

    // Mirrored frame: the same cubic built from the precomputed mirrored endpoints
    // and their mirrored tangents. This selects the corresponding precomputed
    // mirrored geometry for display only — it never alters the canonical join.
    const AeM = { east: Ae.mirroredEast != null ? Ae.mirroredEast : Ae.east, north: Ae.mirroredNorth != null ? Ae.mirroredNorth : Ae.north };
    const BsM = { east: Bs.mirroredEast != null ? Bs.mirroredEast : Bs.east, north: Bs.mirroredNorth != null ? Bs.mirroredNorth : Bs.north };
    const tAM = endpointTangentMirrored(A, 'end') || { dx: (BsM.east - AeM.east) / (dist2d(AeM, BsM) || 1e-9), dy: (BsM.north - AeM.north) / (dist2d(AeM, BsM) || 1e-9) };
    const tBM = endpointTangentMirrored(B, 'start') || { dx: (BsM.east - AeM.east) / (dist2d(AeM, BsM) || 1e-9), dy: (BsM.north - AeM.north) / (dist2d(AeM, BsM) || 1e-9) };
    const handleM = dist2d(AeM, BsM) * 0.35;
    const c1M = { east: AeM.east + tAM.dx * handleM, north: AeM.north + tAM.dy * handleM };
    const c2M = { east: BsM.east - tBM.dx * handleM, north: BsM.north - tBM.dy * handleM };

    const n = o.connectorSegments;
    const pts = [{
      east: Ae.east, north: Ae.north, s: Ae.s, d: Ae.d,
      mirroredEast: Ae.mirroredEast != null ? Ae.mirroredEast : Ae.east,
      mirroredNorth: Ae.mirroredNorth != null ? Ae.mirroredNorth : Ae.north,
    }];
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const inv = 1 - t;
      const x = inv * inv * inv * Ae.east + 3 * inv * inv * t * c1.east + 3 * inv * t * t * c2.east + t * t * t * Bs.east;
      const y = inv * inv * inv * Ae.north + 3 * inv * inv * t * c1.north + 3 * inv * t * t * c2.north + t * t * t * Bs.north;
      const xm = inv * inv * inv * AeM.east + 3 * inv * inv * t * c1M.east + 3 * inv * t * t * c2M.east + t * t * t * BsM.east;
      const ym = inv * inv * inv * AeM.north + 3 * inv * inv * t * c1M.north + 3 * inv * t * t * c2M.north + t * t * t * BsM.north;
      pts.push({ east: x, north: y, s: Ae.s + (Bs.s - Ae.s) * t, d: Ae.d + (Bs.d - Ae.d) * t, mirroredEast: xm, mirroredNorth: ym });
    }
    pts.push({
      east: Bs.east, north: Bs.north, s: Bs.s, d: Bs.d,
      mirroredEast: Bs.mirroredEast != null ? Bs.mirroredEast : Bs.east,
      mirroredNorth: Bs.mirroredNorth != null ? Bs.mirroredNorth : Bs.north,
    });

    // length

    let lengthM = 0;
    for (let i = 1; i < pts.length; i++) lengthM += dist2d(pts[i - 1], pts[i]);
    // max deviation from the straight A->B segment
    let maxDeviation = 0;
    for (const p of pts) maxDeviation = Math.max(maxDeviation, pointToLineDist(p, Ae, Bs));
    return { points: pts, lengthM, maxDeviationM: maxDeviation };
  }

  // ---------------------------------------------------------------------------
  // Main entry
  // ---------------------------------------------------------------------------

  /**
   * Chain accepted connections into longer polylines. Each fragment has at most
   * one predecessor and one successor, so the accepted connections form disjoint
   * directed paths. Each path becomes one joined polyline with ordered source
   * fragments and a connector between consecutive fragments.
   */
  function chainJoins(chosen, o) {
    const bySource = new Map();
    for (const c of chosen) bySource.set(c.from.fragmentId, c);
    const byTarget = new Map();
    for (const c of chosen) byTarget.set(c.to.fragmentId, c);

    // find path starts: fragments that are a source but not a target
    const starts = chosen.map((c) => c.from).filter((f) => !byTarget.has(f.fragmentId));
    const paths = [];

    for (const start of starts) {
      const path = [];
      let cur = start;
      let guard = 0;
      while (cur && guard++ < chosen.length + 2) {
        path.push(cur);
        const conn = bySource.get(cur.fragmentId);
        if (!conn) break;
        path.push(conn); // connector after cur
        cur = conn.to;
      }
      paths.push(path);
    }
    return paths;
  }

  /**
   * Build a joined polyline object from an ordered path of [fragment, connector,
   * fragment, connector, ...]. Returns { joinedPolyline, connections }.
   */
  function buildPathPolyline(path, o, idx) {
    // path = [F0, c0, F1, c1, F2, ...]
    const fragments = path.filter((x) => x.points && x.orderedSourceFragmentIds === undefined);
    const connectors = path.filter((x) => x.measurements);
    const A = fragments[0];
    const B = fragments[fragments.length - 1];
    const points = [];
    for (let i = 0; i < path.length; i++) {
      const item = path[i];
      if (item.points && item.orderedSourceFragmentIds === undefined) {
        // fragment
        points.push(...item.points.map((p) => ({ ...p })));
      } else {
        // connector
        const conn = buildConnector(item.from, item.to, o);
        points.push(...conn.points.slice(1, -1));
      }
    }
    const totalLength = fragments.reduce((a, f) => a + (f.lengthM ?? 0), 0) +
      connectors.reduce((a, c) => a + buildConnector(c.from, c.to, o).lengthM, 0);
    const connectorGaps = connectors.map((c) => c.measurements.endpointGapM);
    const connectorDevs = connectors.map((c) => buildConnector(c.from, c.to, o).maxDeviationM);
    const connectionRecords = connectors.map((c) => c.connectionRecord);
    return {
      joinedPolylineId: `JP${idx}`,
      orderedSourceFragmentIds: fragments.map((f) => f.fragmentId),
      physicalBoundaryId: boundaryId(A),
      chunkId: A.chunkId,
      passId: A.passId,
      laneIndex: A.laneIndex,
      groupTrackId: A.groupTrackId,
      side: A.side ?? null,
      joinedPoints: points,
      sourceFragments: fragments.map((f) => f.fragmentId),
      connections: connectionRecords,
      totalLengthM: +totalLength.toFixed(2),
      sourceFragmentCount: fragments.length,
      connectorCount: connectors.length,
      maxConnectorGapM: connectorGaps.length ? +Math.max(...connectorGaps).toFixed(2) : null,
      medianConnectorDeviationM: connectorDevs.length ? +median(connectorDevs).toFixed(3) : null,
      maxConnectorDeviationM: connectorDevs.length ? +Math.max(...connectorDevs).toFixed(3) : null,
      confidence: connectors.length ? +median(connectors.map((c) => c.score)).toFixed(4) : null,
      unresolvedEndpointReasons: [],
    };
  }

  /**
   * Join compatible constructed fragments.
   * @param {Array} fragments constructed-fragment list (unchanged on output)
   * @param {Array} allPoints accumulated point observations (for corridor evidence)
   * @param {object} opts
   * @returns { { joinedPolylines, connections, candidates, stats, config } }
   */
  function joinConstructedFragments(fragments, allPoints, opts = {}) {
    const o = { ...JOINING_DEFAULTS, ...opts };
    const ctx = { opts: o, fragments, allPoints: allPoints || [] };

    // candidate generation (bounded spatial search)
    const si = buildSpatialIndex(fragments, o);
    const candidatePairs = generateCandidates(fragments, si, o);

    // evaluate all candidates
    const candidateResults = candidatePairs.map(({ from, to }) => ({ from, to, ...evaluateCandidate(from, to, ctx) }));
    const hardRejected = candidateResults.filter((c) => !c.pass);
    const scored = candidateResults.filter((c) => c.pass);

    // selection (mutual-best, margin, no branching)
    const chosen = selectJoins(scored, o);

    // build connection records (full chosen objects carry from/to/measurements)
    const chosenWithRecords = chosen.map((c) => {
      const connectionRecord = {
        fromFragmentId: c.from.fragmentId,
        toFragmentId: c.to.fragmentId,
        endpointDistanceM: +c.measurements.endpointGapM.toFixed(2),
        tangentDiffDeg: c.measurements.tangentDiffDeg != null ? +c.measurements.tangentDiffDeg.toFixed(2) : null,
        lateralExtrapolationErrM: c.measurements.lateralErrM != null ? +c.measurements.lateralErrM.toFixed(2) : null,
        curvatureChangeDegPerM: c.measurements.curvatureChangeDegPerM != null ? +c.measurements.curvatureChangeDegPerM.toFixed(3) : null,
        temporalSepSec: c.measurements.temporalDiffSec != null ? +c.measurements.temporalDiffSec.toFixed(2) : null,
        supportClassification: c.measurements.corridor,
        candidateScore: c.score,
        secondBestScore: c.secondBestScore,
        ambiguityMargin: +c.margin.toFixed(4),
        acceptanceReason: 'accepted',
        rejectionReason: null,
      };
      return { ...c, connectionRecord };
    });
    const connections = chosenWithRecords.map((c) => c.connectionRecord);

    // chain accepted connections into directed paths, then fold in every
    // fragment with no accepted connection as a one-fragment singleton so the
    // joined output represents EVERY valid constructed fragment.
    const paths = chainJoins(chosenWithRecords, o);

    // fragments already represented in the chains
    const inChain = new Set();
    for (const p of paths) {
      for (const item of p) {
        if (item.points && item.orderedSourceFragmentIds === undefined) inChain.add(item.fragmentId);
      }
    }
    // every valid fragment not in a chain becomes a singleton component
    for (const f of fragments) {
      if (!inChain.has(f.fragmentId)) {
        paths.push([f]);
      }
    }

    const joinedPolylines = paths.map((p, i) => buildPathPolyline(p, o, i + 1));

    // ambiguous candidates = scored but not chosen (margin/score/conflict)
    const chosenIds = new Set(chosenWithRecords.map((c) => `${c.from.fragmentId}->${c.to.fragmentId}`));
    const ambiguous = scored.filter((c) => !chosenIds.has(`${c.from.fragmentId}->${c.to.fragmentId}`)).length;

    const joinedFragIds = new Set(joinedPolylines.flatMap((j) => j.orderedSourceFragmentIds));
    const stats = {
      fragmentCount: fragments.length,
      candidatePairCount: candidatePairs.length,
      hardRejectedCount: hardRejected.length,
      hardRejectedByReason: hardRejected.reduce((a, c) => { a[c.reason] = (a[c.reason] || 0) + 1; return a; }, {}),
      scoredCandidateCount: scored.length,
      acceptedConnectionCount: connections.length,
      ambiguousCount: ambiguous,
      joinedPolylineCount: joinedPolylines.length,
      unjoinedFragmentCount: fragments.length - joinedFragIds.size,
    };

    return { joinedPolylines, connections, candidates: candidateResults, stats, config: o };
  }


  global.LaneJoining = {
  JOINING_DEFAULTS,
  boundaryId,
  endpointTangent,
  tangentDiffDeg,
  classifyCorridor,
  connectorCrossesOtherBoundary,
  evaluateCandidate,
  scoreCandidate,
  buildSpatialIndex,
  querySpatialIndex,
  generateCandidates,
  selectJoins,
  chainJoins,
  buildConnector,
  buildPathPolyline,
  joinConstructedFragments,
};
}(typeof window !== 'undefined' ? window : globalThis));
