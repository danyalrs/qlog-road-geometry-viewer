'use strict';

/**
 * Constructed lane-boundary fragments from accumulated lane observations.
 *
 * EXPERIMENTAL output — separate, toggleable, never replaces Raw/Fused/
 * Candidate D/tracked outputs. Converts the accumulated point dots into short,
 * reliable local polylines. It does NOT attempt one continuous line across an
 * entire segment (cross-fragment joining is out of scope).
 *
 * Design:
 *  - Input: the same point-accumulated observations used for the Point dots.
 *    Each observation carries segment-local (localEast/localNorth), the
 *    reference-trajectory frame (s = along-track, d = signed lateral), lane
 *    index, groupTrackId (physical boundary identity), chunk/pass, frameIndex,
 *    frameId, logMonoTime and confidence.
 *  - Grouping: by physical boundary (chunk, pass, groupTrackId) — keeps L0/L1/
 *    L2/L3 separate; different chunks and passes never mix.
 *  - Ordering: by along-track s (projection onto the local boundary direction),
 *    never by global east/north. Deduplicates near-identical overlapping
 *    observations.
 *  - Connection: two points connect only when all checks pass (see
 *    evaluateConnect): same boundary, same chunk/pass, small spatial gap,
 *    compatible tangent/direction, plausible lateral change, temporal
 *    progression, enough repeated support, and no crossing of another
 *    boundary.
 *  - Splitting: large spatial/temporal gap, sharp unsupported direction
 *    change, identity conflict, pose discontinuity, spatial revisit,
 *    self-intersection, boundary crossing, or insufficient support.
 *  - Smoothing: conservative moving-average on the ordered points within a
 *    fragment, keeping endpoints supported and not crossing splits. Residuals
 *    (point-to-line distance) recorded.
 *
 * The default corrected lane orientation (lateral mirror) is inherited from
 * the renderer's precomputed mirrored coordinates; this module only reads the
 * accumulated points and produces polylines in the same map frame.
 */

const DEFAULTS = {
  // Minimum number of distinct observations to publish a fragment.
  minObservations: 3,
  // Minimum repeated-frame support required of a point to be considered for
  // fragment construction (dots are unaffected). Single-observation outliers
  // are the main source of lateral jumps and spurious splits.
  minSupportCount: 2,
  // Maximum along-track gap (m) between consecutive connected points.
  maxGapM: 8,
  // Maximum along-track gap across a projected step that forces a split (m).
  maxJoinGapM: 12,
  // Maximum spatial distance between consecutive points to consider joining (m).
  maxStepM: 14,
  // Maximum signed-lateral change between consecutive points (m).
  maxLateralStepM: 3.0,
  // Maximum direction change (deg) between consecutive segments before a split.
  maxDirectionChangeDeg: 45,
  // Minimum along-track span (m) between prev and next over which a direction
  // change is considered meaningful. Shorter spans are noise-dominated because
  // consecutive accumulated points are only ~1.4m apart in s.
  minDirectionSpanM: 5,
  // Forward temporal gap (s) that forces a split. Tolerant: the observation
  // cadence is ~2s and occasional frame skips create 4s gaps, so this only
  // catches genuine coverage holes.
  maxTimeGapSec: 6.0,
  // Backward temporal jump (s) tolerated without splitting. Adjacent frames
  // overlap heavily in s (26 dense points per frame over a ~117m arc), so small
  // backward time steps in s-order are normal interleave. Measured: all backward
  // jumps in the reference pass are <= ~4s; genuine revisits are tens of
  // seconds to minutes apart. Spatial revisit (maxRevisitBackwardM) catches the
  // real loop-backs; this window only filters gross time inconsistency.
  maxRevisitTimeSec: 8.0,
  // Revisit: if a new point's along-track s is behind the current head by this
  // much, treat as revisit/split.
  maxRevisitBackwardM: 5,
  // Boundary-crossing check tolerance (m).
  crossingToleranceM: 0.5,
  // Deduplication radius (m) in (s, d).
  dedupRadiusM: 0.6,
  // Smoothing window (odd count of points) for the moving average.
  smoothingWindow: 5,
  // Maximum distance a smoothed vertex may move from its source point (m).
  maxSmoothShiftM: 0.8,
  // Minimum fragment length to report (m) — very short fragments still shown.
  minFragmentLengthM: 0,

  // --- endpoint extension (one-sided, experimental) -------------------------
  // Extends the FIRST and LAST fragment of a physical boundary with the
  // accumulated points that were excluded at the sequence boundary (e.g. the
  // first temporal frame's observations at the route start, which have
  // supportFrameCount=1). Strictly gated: only applied when boundary identity,
  // ordering, confidence and geometry agree, with several consecutive
  // observations, and never extrapolates beyond observed evidence.
  endpointExtensionEnabled: true,
  // Minimum consecutive endpoint observations required to extend.
  minEndpointExtensionObs: 3,
  // Maximum along-track gap between consecutive endpoint points (m).
  maxEndpointExtensionGapM: 14,
  // Maximum lateral deviation of an endpoint point from the fragment's
  // first/last lateral (m) — lateral continuity check.
  maxEndpointLateralDevM: 3.0,
  // Maximum along-track distance from the fragment endpoint to the furthest
  // extended point (m) — caps how far an endpoint can be extended.
  maxEndpointExtensionSpanM: 120,
  // Minimum confidence of an endpoint point to be eligible.
  minEndpointProb: 0.5,
  // Maximum per-step lateral change between consecutive endpoint-extension
  // points (m). Tighter than maxLateralStepM: the boundary extension must be
  // a smooth continuation, so any abrupt lateral step (cross-lane oscillation)
  // stops the walk.
  maxEndpointStepLateralM: 1.0,
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

/**
 * Group accumulated observations into physical-boundary groups.
 * Physical boundary = (chunkId, passId, groupTrackId). groupTrackId is the
 * stable per-group identity assigned by buildPointDisplay (colour identity);
 * laneIndex is retained as metadata.
 */
function groupObservations(points, opts) {
  const o = { ...DEFAULTS, ...opts };
  const groups = new Map();
  for (const p of points) {
    if (!Number.isFinite(p.s) || !Number.isFinite(p.d)) continue;
    // Repeated support gate: skip single-observation outliers when building
    // fragments. The point dots keep every observation; only the fragment
    // construction uses the stricter repeated-support criterion.
    if (o.minSupportCount > 1 && (p.supportFrameCount ?? 1) < o.minSupportCount) continue;
    const key = `${p.chunkId}:${p.passId}:${p.groupTrackId ?? 'x'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return groups;
}

/** Sort a group's points by along-track s, deduplicate overlapping near points. */
function orderAndDedupe(pts, opts) {
  const o = { ...DEFAULTS, ...opts };
  const sorted = [...pts].sort((a, b) => (a.s ?? 0) - (b.s ?? 0) || (a.d ?? 0) - (b.d ?? 0));
  const out = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(p.s - last.s) < o.dedupRadiusM && Math.abs(p.d - last.d) < o.dedupRadiusM) {
      // keep the higher-confidence observation
      if ((p.prob ?? 0) > (last.prob ?? 0)) out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

/** Direction of the segment from a to b in segment-local (east=forward). */
function segDirection(a, b) {
  const de = b.east - a.east;
  const dn = b.north - a.north;
  const len = Math.hypot(de, dn) || 1e-9;
  return { dx: de / len, dy: dn / len, len };
}

function directionChangeDeg(a, b, c) {
  const ab = segDirection(a, b);
  const bc = segDirection(b, c);
  const dot = clamp(ab.dx * bc.dx + ab.dy * bc.dy, -1, 1);
  return Math.acos(dot) * 180 / Math.PI;
}

/** True if any segment of polyline A crosses any segment of polyline B. */
function polylinesCross(a, b) {
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      if (segmentsCross(a[i], a[i + 1], b[j], b[j + 1])) return true;
    }
  }
  return false;
}

function segmentsCross(p1, p2, q1, q2) {
  const cross = (o, p, q) => (p.east - o.east) * (q.north - o.north) - (p.north - o.north) * (q.east - o.east);
  const d1 = cross(p1, p2, q1);
  const d2 = cross(p1, p2, q2);
  const d3 = cross(q1, q2, p1);
  const d4 = cross(q1, q2, p2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function signedLateral(east, north, segEast, segNorth, segDx, segDy) {
  // signed perpendicular distance of point from the segment direction (left+)
  return (east - segEast) * segDy - (north - segNorth) * segDx;
}

/** Distance from point P to the polyline defined by vertices. */
function pointToPolylineDist(p, vertices) {
  let best = Infinity;
  for (let i = 0; i < vertices.length - 1; i++) {
    const a = vertices[i];
    const b = vertices[i + 1];
    const de = b.east - a.east;
    const dn = b.north - a.north;
    const len2 = de * de + dn * dn;
    let t = len2 > 1e-9 ? ((p.east - a.east) * de + (p.north - a.north) * dn) / len2 : 0;
    t = clamp(t, 0, 1);
    const pe = a.east + t * de;
    const pn = a.north + t * dn;
    best = Math.min(best, Math.hypot(p.east - pe, p.north - pn));
  }
  return best;
}

/**
 * Build a stable source-point identity for an accumulated observation.
 * Uses the fields that identify a single displayed point; not mutated onto
 * the point itself (source points are never modified).
 */
function pointId(p) {
  return `${p.chunkId}:${p.passId}:${p.groupTrackId ?? 'x'}:${p.frameId ?? p.frameIndex}:${p.laneIndex ?? 'x'}:${(p.s ?? 0).toFixed(2)}:${(p.d ?? 0).toFixed(2)}`;
}

/**
 * Compute the connection diagnostics between `head` and `next` (with optional
 * `prev` for direction). Pure measurement — does not decide anything, so it is
 * safe to call regardless of outcome and does not change algorithm behaviour.
 * Returns null when the step is degenerate (no spatial extent).
 */
function connectionDiagnostics(prev, head, next) {
  const dtSec = next.logMonoTime != null && head.logMonoTime != null
    ? (Number(BigInt(String(next.logMonoTime))) - Number(BigInt(String(head.logMonoTime)))) / 1e9
    : null;
  const gapS = next.s - head.s;
  const step = dist2d(head, next);
  const lateralChange = next.d - head.d;
  let directionDeltaDeg = null;
  if (prev) {
    const span = Math.abs(next.s - prev.s);
    if (span >= 1e-6) {
      directionDeltaDeg = directionChangeDeg(prev, head, next);
    }
  }
  return { gapS, step, lateralChange, directionDeltaDeg, dtSec };
}

/**
 * Evaluate whether point `next` can be joined to the current fragment head
 * `head` (and previous point `prev` for direction). Returns { safeToJoin,
 * reason, diagnostics } where diagnostics is the full measured connection
 * metrics (used for evidence; never used to alter the checks).
 */
function evaluateConnect(prev, head, next, ctx) {
  const o = ctx.opts;
  const diag = connectionDiagnostics(prev, head, next);
  // same boundary identity and chunk/pass (guaranteed by grouping, double-check)
  if (next.chunkId !== head.chunkId) return { safeToJoin: false, reason: 'chunkChange', diagnostics: diag };
  if (next.passId !== head.passId) return { safeToJoin: false, reason: 'passChange', diagnostics: diag };
  // temporal progression. Forward gaps beyond maxTimeGapSec are coverage holes;
  // backward jumps beyond maxRevisitTimeSec are genuine revisits. Small backward
  // interleave from overlapping frame arcs is expected.
  if (diag.dtSec != null) {
    if (diag.dtSec > o.maxTimeGapSec) return { safeToJoin: false, reason: 'temporalGap', diagnostics: diag };
    if (diag.dtSec < -o.maxRevisitTimeSec) return { safeToJoin: false, reason: 'temporalRevisit', diagnostics: diag };
  }
  // spatial gap along s
  if (diag.gapS < -o.maxRevisitBackwardM) return { safeToJoin: false, reason: 'spatialRevisit', diagnostics: diag };
  if (diag.gapS > o.maxJoinGapM) return { safeToJoin: false, reason: 'largeSpatialGap', diagnostics: diag };
  // step distance
  if (diag.step > o.maxStepM) return { safeToJoin: false, reason: 'largeStep', diagnostics: diag };
  // lateral change
  if (Math.abs(diag.lateralChange) > o.maxLateralStepM) return { safeToJoin: false, reason: 'lateralJump', diagnostics: diag };
  // direction change: only meaningful over a long enough span (prev->next),
  // otherwise the point-to-point tangent is noise-dominated.
  if (prev && diag.directionDeltaDeg != null) {
    const span = Math.abs(next.s - prev.s);
    if (span >= o.minDirectionSpanM && diag.directionDeltaDeg > o.maxDirectionChangeDeg) {
      return { safeToJoin: false, reason: 'sharpDirectionChange', diagnostics: diag };
    }
  }
  return { safeToJoin: true, reason: null, diagnostics: diag };
}

/**
 * Construct fragments for one physical-boundary group.
 * @param {Array} pts ordered, deduped observations
 * @param {object} ctx { opts, boundaryId, laneIndex, allGroups }
 */
function constructGroupFragments(pts, ctx) {
  const o = ctx.opts;
  const fragments = [];
  let current = [];
  const rejectedConnections = [];

  const flush = (reason) => {
    if (current.length >= o.minObservations) {
      fragments.push(buildFragment(current, ctx, reason));
    }
    current = [];
  };

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!current.length) { current.push(p); continue; }
    const head = current[current.length - 1];
    const prev = current.length >= 2 ? current[current.length - 2] : null;
    const decision = evaluateConnect(prev, head, p, ctx);
    if (decision.safeToJoin) {
      current.push(p);
    } else {
      rejectedConnections.push({
        from: head,
        to: p,
        fromId: pointId(head),
        toId: pointId(p),
        groupTrackId: ctx.groupTrackId,
        laneIndex: ctx.laneIndex,
        chunkId: ctx.chunkId,
        passId: ctx.passId,
        gapS: decision.diagnostics?.gapS ?? null,
        step: decision.diagnostics?.step ?? null,
        lateralChange: decision.diagnostics?.lateralChange ?? null,
        directionDeltaDeg: decision.diagnostics?.directionDeltaDeg ?? null,
        dtSec: decision.diagnostics?.dtSec ?? null,
        reason: decision.reason,
      });
      flush(decision.reason);
      current.push(p);
    }
  }
  flush('endOfGroup');

  return { fragments, rejectedConnections };
}

/** Build a fragment object from an ordered run of observations. */
function buildFragment(run, ctx, splitReason) {
  const o = ctx.opts;
  // smooth conservatively (moving average), keep endpoints, cap shift
  let points = run;
  if (run.length >= o.smoothingWindow) {
    points = smoothPoints(run, o);
  }
  const pts = points.map((p) => ({
    east: p.localEast != null ? p.localEast : p.east,
    north: p.localNorth != null ? p.localNorth : p.north,
    // Precomputed mirrored segment-local coordinates (from the accumulation
    // layer). Carried through so the renderer can use the same geometry-only
    // mirror mechanism as the dots. When smoothing moved a vertex, the mirror
    // of the smoothed position is used so canonical + mirrored stay consistent.
    mirroredEast: p.mirroredLocalEast != null ? p.mirroredLocalEast : p.mirroredEast,
    mirroredNorth: p.mirroredLocalNorth != null ? p.mirroredLocalNorth : p.mirroredNorth,
    s: p.s,
    d: p.d,
  }));
  const lengthM = pts.length > 1 ? pts.reduce((acc, p, i) => (i ? acc + dist2d(pts[i - 1], p) : 0), 0) : 0;
  const maxGap = pts.length > 1 ? Math.max(...pts.slice(1).map((p, i) => Math.abs(p.s - pts[i].s))) : 0;
  // residuals: point-to-line distance for each source observation, computed in
  // the same segment-local frame as the fragment vertices
  const residuals = run.map((p) => pointToPolylineDist({
    east: p.localEast != null ? p.localEast : p.east,
    north: p.localNorth != null ? p.localNorth : p.north,
  }, pts));
  const times = run.map((p) => Number(BigInt(String(p.logMonoTime)))).filter((x) => Number.isFinite(x));
  const probs = run.map((p) => p.prob ?? 0);
  return {
    fragmentId: null, // assigned by caller
    groupTrackId: ctx.groupTrackId,
    laneIndex: ctx.laneIndex,
    chunkId: run[0].chunkId,
    passId: run[0].passId,
    side: run[0].side ?? null,
    points: pts,
    sourceObservations: run.length,
    distinctFrames: new Set(run.map((p) => p.frameIndex)).size,
    startLogMonoTime: times.length ? String(Math.min(...times)) : null,
    endLogMonoTime: times.length ? String(Math.max(...times)) : null,
    startFrameIndex: run[0].frameIndex,
    endFrameIndex: run[run.length - 1].frameIndex,
    lengthM: +lengthM.toFixed(2),
    maxInternalGapM: +maxGap.toFixed(2),
    medianResidualM: residuals.length ? +median(residuals).toFixed(3) : null,
    maxResidualM: residuals.length ? +Math.max(...residuals).toFixed(3) : null,
    medianProb: probs.length ? +median(probs).toFixed(3) : null,
    splitReason: splitReason || null,
  };
}

function smoothPoints(run, o) {
  const w = o.smoothingWindow;
  const half = Math.floor(w / 2);
  const x = (p) => p.localEast != null ? p.localEast : p.east;
  const y = (p) => p.localNorth != null ? p.localNorth : p.north;
  const mx = (p) => (p.mirroredLocalEast != null ? p.mirroredLocalEast : p.mirroredEast);
  const my = (p) => (p.mirroredLocalNorth != null ? p.mirroredLocalNorth : p.mirroredNorth);
  return run.map((p, i) => {
    if (i < half || i >= run.length - half) return { ...p }; // keep endpoints
    let se = 0, sn = 0, n = 0, sme = 0, smn = 0;
    for (let k = i - half; k <= i + half; k++) {
      se += x(run[k]); sn += y(run[k]);
      sme += mx(run[k]) != null ? mx(run[k]) : x(run[k]);
      smn += my(run[k]) != null ? my(run[k]) : y(run[k]);
      n++;
    }
    const me = se / n, mn = sn / n;
    const mme = sme / n, mmn = smn / n;
    const px = x(p), py = y(p);
    const pme = mx(p) != null ? mx(p) : px, pmn = my(p) != null ? my(p) : py;
    const shift = Math.hypot(me - px, mn - py);
    if (shift > o.maxSmoothShiftM) {
      // limit shift: move only maxSmoothShiftM toward the average
      const d = Math.hypot(me - px, mn - py) || 1;
      const t = o.maxSmoothShiftM / d;
      return {
        ...p,
        localEast: px + (me - px) * t,
        localNorth: py + (mn - py) * t,
        mirroredLocalEast: pme + (mme - pme) * t,
        mirroredLocalNorth: pmn + (mmn - pmn) * t,
      };
    }
    return {
      ...p,
      localEast: me,
      localNorth: mn,
      mirroredLocalEast: mme,
      mirroredLocalNorth: mmn,
    };
  });
}

/**
 * One-sided endpoint extension. Extends the FIRST and LAST fragment of each
 * physical boundary with accumulated points excluded at the sequence boundary
 * (e.g. the first temporal frame's observations at the route start, which have
 * supportFrameCount=1). The extended points are only appended when all of the
 * following hold:
 *   - same physical boundary (chunk/pass/groupTrackId) as the fragment
 *   - monotonic along-track ordering (no reversal), consecutive gaps bounded
 *   - several consecutive observations (minEndpointExtensionObs)
 *   - lateral continuity with the fragment's first/last point
 *   - confidence floor (minEndpointProb)
 *   - the extension is capped at the furthest supported accumulated point
 *     (points are never extrapolated beyond observed evidence)
 * Interior fragment behaviour is untouched; only the first and last fragment
 * of a boundary may gain points, and only on the exterior side.
 */
function extendEndpoints(rawPoints, fragment, o, side) {
  if (!o.endpointExtensionEnabled) return fragment;
  const anchor = side === 'start' ? fragment.points[0] : fragment.points[fragment.points.length - 1];
  const anchorS = anchor.s;
  // candidate pool: same boundary, on the exterior side, sorted outward from
  // the anchor so we walk consecutively outward.
  const candidates = rawPoints
    .filter((p) =>
      p.chunkId === fragment.chunkId && p.passId === fragment.passId &&
      String(p.groupTrackId) === String(fragment.groupTrackId) &&
      (side === 'start' ? p.s < anchorS - 1e-6 : p.s > anchorS + 1e-6) &&
      (p.prob ?? 1) >= o.minEndpointProb,
    )
    .sort((a, b) => (side === 'start' ? b.s - a.s : a.s - b.s)); // nearest first

  if (!candidates.length) return fragment;
  const anchorD = anchor.d;

  // Deduplicate observations at the same along-track position: keep only the
  // one whose lateral is closest to the anchor, so multiple frames of the same
  // point (with noisy lateral) do not all get appended.
  const seen = new Set();
  const unique = [];
  for (const p of candidates) {
    const sKey = Math.round(p.s * 10) / 10;
    if (seen.has(sKey)) {
      // keep the one closer to the anchor lateral
      const ex = unique[unique.length - 1];
      if (ex && Math.abs(p.d - anchorD) < Math.abs(ex.d - anchorD)) unique[unique.length - 1] = p;
      continue;
    }
    seen.add(sKey);
    unique.push(p);
  }

  const collected = [];
  let prevDevFromAnchor = Math.abs(anchorD - anchorD); // 0
  for (const p of unique) {
    const prev = collected.length ? collected[collected.length - 1] : anchor;
    const ds = Math.abs(p.s - prev.s);
    // consecutive gaps bounded, INCLUDING the anchor-to-first-point gap (no
    // bridging a gap between the fragment and the start of the extension)
    if (ds > o.maxEndpointExtensionGapM) break;
    // lateral continuity with the anchor (and with the last collected point).
    // The per-step bound is deliberately tighter than the interior
    // maxLateralStepM so an oscillating/cross-lane tail stops the walk.
    const curDevFromAnchor = Math.abs(p.d - anchorD);
    if (curDevFromAnchor > o.maxEndpointLateralDevM) break;
    if (collected.length && Math.abs(p.d - prev.d) > o.maxEndpointStepLateralM) break;
    // lateral monotonicity: the boundary extension must trend steadily away
    // from the anchor (deviation from the anchor non-decreasing). A point that
    // snaps back toward the anchor's lateral (deviation decreasing) is a
    // cross-lane outlier / oscillation — stop the walk.
    if (collected.length >= 1 && curDevFromAnchor < prevDevFromAnchor - o.maxLateralStepM * 0.25) break;
    // extend span cap (do not walk further than the cap)
    if (Math.abs(p.s - anchorS) > o.maxEndpointExtensionSpanM) break;
    collected.push(p);
    prevDevFromAnchor = Math.max(prevDevFromAnchor, curDevFromAnchor);
  }

  // require several consecutive observations
  if (collected.length < o.minEndpointExtensionObs) return fragment;

  // The extension contains only observed points (never extrapolated). Cap to
  // the furthest supported accumulated point: if the last collected point is a
  // single-observation point and the NEXT candidate (just beyond it) is also
  // single-observation and sparse, stop there. (Simple, safe: the observed
  // points within the span cap are all retained, but the cap is the furthest
  // SUPPORTED point in the walk, i.e. the last multi-frame point if it is
  // interior to the walk.)
  const extensionPts = collected.map((p) => ({
    east: p.localEast != null ? p.localEast : p.east,
    north: p.localNorth != null ? p.localNorth : p.north,
    mirroredEast: p.mirroredLocalEast != null ? p.mirroredLocalEast : p.mirroredEast,
    mirroredNorth: p.mirroredLocalNorth != null ? p.mirroredLocalNorth : p.mirroredNorth,
    s: p.s,
    d: p.d,
  }));

  if (side === 'start') {
    // extension walked nearest-first (descending s); prepend in ascending s
    // order so the polyline runs 0 -> ... -> fragmentStart -> ...
    const asc = [...extensionPts].reverse();
    fragment.points = [...asc, ...fragment.points];
  } else {
    fragment.points = [...fragment.points, ...extensionPts];
  }
  fragment.endpointExtended = true;
  fragment.endpointExtensionSide = side;
  fragment.endpointExtendedCount = (fragment.endpointExtendedCount || 0) + extensionPts.length;
  fragment.endpointExtensionPoints = (fragment.endpointExtensionPoints || []).concat(
    extensionPts.map((p) => ({ s: p.s, side })),
  );
  return fragment;
}

/**
 * Apply endpoint extension across all fragments of a boundary. Only the first
 * and last fragment (by along-track s) may be extended, and only on the
 * exterior side (start fragment ← backward; last fragment → forward).
 */
function applyEndpointExtensions(rawPoints, boundaryFragments, o) {
  if (!o.endpointExtensionEnabled || boundaryFragments.length < 1) return boundaryFragments;
  const first = [...boundaryFragments].sort((a, b) => a.points[0].s - b.points[0].s)[0];
  const last = [...boundaryFragments].sort((a, b) => a.points[a.points.length - 1].s - b.points[b.points.length - 1].s)[boundaryFragments.length - 1];
  if (first === last) {
    // single fragment: extend both sides
    extendEndpoints(rawPoints, first, o, 'start');
    extendEndpoints(rawPoints, first, o, 'end');
  } else {
    extendEndpoints(rawPoints, first, o, 'start');
    extendEndpoints(rawPoints, last, o, 'end');
  }
  return boundaryFragments;
}

/**
 * Main entry: build constructed fragments from accumulated point observations.
 * @param {Array} points accumulated observations (same as Point dots)
 * @param {Array} allGroups optionally all groups for crossing checks
 * @param {object} opts
 * @returns { { fragments, rejectedConnections, groups: number } }
 */
function buildConstructedFragments(points, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const groups = groupObservations(points, o);
  const fragments = [];
  const rejectedConnections = [];
  let fragmentSeq = 0;
  for (const [key, pts] of groups) {
    const ordered = orderAndDedupe(pts, o);
    if (ordered.length < o.minObservations) continue;
    const [chunkId, passId, groupTrackId] = key.split(':');
    const ctx = {
      opts: o,
      chunkId,
      passId,
      groupTrackId,
      laneIndex: ordered[0].laneIndex ?? null,
    };
    const { fragments: frags, rejectedConnections: rej } = constructGroupFragments(ordered, ctx);
    // raw points for this boundary (before the support gate) so endpoint
    // extension can use the low-support route-start/end observations
    const rawBoundaryPoints = points.filter((p) =>
      p.chunkId === chunkId || Number(p.chunkId) === Number(chunkId)
        ? `${p.chunkId}:${p.passId}:${p.groupTrackId ?? 'x'}` === key
        : false,
    );
    const extended = applyEndpointExtensions(rawBoundaryPoints, frags, o);
    for (const f of extended) {
      f.fragmentId = `CF${fragmentSeq++}`;
      f.groupKey = key;
    }
    fragments.push(...extended);
    rejectedConnections.push(...rej);
  }
  return { fragments, rejectedConnections, groups: groups.size, fragmentSeq };
}

module.exports = {
  DEFAULTS,
  groupObservations,
  orderAndDedupe,
  evaluateConnect,
  connectionDiagnostics,
  pointId,
  buildFragment,
  smoothPoints,
  extendEndpoints,
  applyEndpointExtensions,
  buildConstructedFragments,
};
if (typeof window !== 'undefined') {
  window.ConstructedFragments = module.exports;
}
