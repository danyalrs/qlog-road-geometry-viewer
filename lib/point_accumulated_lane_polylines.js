'use strict';

/**
 * Default-off candidate: pointAccumulatedLanePolylineCandidate
 *
 * Builds continuous coloured lane polylines from accumulated observation dots.
 * Display-layer only — never mutates road, trajectory, arrow, bridges, or
 * processing output. Uses points in their final display world coordinates
 * (after combinedVisibleLaneProjection when that candidate is also active).
 *
 * Grouping key (not colour):
 *   chunkId + passId + groupTrackId (+ laneIndex when present)
 *
 * Ordering: along-track `s` (stable road-relative), never frame-index alone.
 */

const QUERY_PARAM = 'pointAccumulatedLanePolylineCandidate';

const DEFAULTS = Object.freeze({
  minPoints: 3,
  minSupportCount: 1,
  maxGapS: 12,
  maxStepM: 16,
  maxLateralStepM: 3.5,
  maxDirectionChangeDeg: 50,
  minDirectionSpanM: 4,
  maxRevisitBackwardM: 5,
  dedupRadiusM: 0.55,
  excludeIsolatedSingleObs: true,
});

function parsePointAccumulatedLanePolylineCandidate(search) {
  const raw = typeof search === 'string'
    ? new URLSearchParams(search).get(QUERY_PARAM)
    : search?.get?.(QUERY_PARAM);
  return raw === '1';
}

function identityKey(p) {
  const lane = p.laneIndex != null ? `:L${p.laneIndex}` : '';
  return `${p.chunkId ?? 'x'}:${p.passId ?? 'x'}:${p.groupTrackId ?? 'x'}${lane}`;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function segDirection(a, b) {
  const de = (b.east ?? 0) - (a.east ?? 0);
  const dn = (b.north ?? 0) - (a.north ?? 0);
  const len = Math.hypot(de, dn) || 1e-9;
  return { dx: de / len, dy: dn / len, len };
}

function directionChangeDeg(a, b, c) {
  const ab = segDirection(a, b);
  const bc = segDirection(b, c);
  const dot = clamp(ab.dx * bc.dx + ab.dy * bc.dy, -1, 1);
  return Math.acos(dot) * 180 / Math.PI;
}

function groupPoints(points, opts) {
  const o = { ...DEFAULTS, ...opts };
  const groups = new Map();
  for (const p of points || []) {
    if (!Number.isFinite(p.east) || !Number.isFinite(p.north)) continue;
    if (!Number.isFinite(p.s)) continue;
    if (o.excludeIsolatedSingleObs && p.singleObservation === true && (p.supportFrameCount ?? 1) < 2) {
      continue;
    }
    if (o.minSupportCount > 1 && (p.supportFrameCount ?? 1) < o.minSupportCount) continue;
    if (p.chunkId == null || p.passId == null || p.groupTrackId == null) continue;
    const key = identityKey(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return groups;
}

function orderAndDedupe(pts, opts) {
  const o = { ...DEFAULTS, ...opts };
  const sorted = [...pts].sort((a, b) => (a.s ?? 0) - (b.s ?? 0) || (a.d ?? 0) - (b.d ?? 0)
    || (a.frameIndex ?? 0) - (b.frameIndex ?? 0));
  const out = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last
      && Math.abs((p.s ?? 0) - (last.s ?? 0)) < o.dedupRadiusM
      && Math.abs((p.d ?? 0) - (last.d ?? 0)) < o.dedupRadiusM) {
      if ((p.prob ?? 0) > (last.prob ?? 0)) out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

function shouldSplit(prev, curr, run, opts) {
  const o = { ...DEFAULTS, ...opts };
  if (!prev) return { split: false, reason: null };

  // Identity hard gates
  if (String(prev.chunkId) !== String(curr.chunkId)) return { split: true, reason: 'crossChunk' };
  if (String(prev.passId) !== String(curr.passId)) return { split: true, reason: 'crossPass' };
  if (String(prev.groupTrackId) !== String(curr.groupTrackId)) return { split: true, reason: 'crossLaneIdentity' };
  if (prev.laneIndex != null && curr.laneIndex != null && prev.laneIndex !== curr.laneIndex) {
    return { split: true, reason: 'crossLaneIndex' };
  }

  const gapS = (curr.s ?? 0) - (prev.s ?? 0);
  if (gapS < -o.maxRevisitBackwardM) return { split: true, reason: 'backwardAlongTrack' };
  if (gapS > o.maxGapS) return { split: true, reason: 'largeAlongTrackGap' };

  const step = Math.hypot((curr.east ?? 0) - (prev.east ?? 0), (curr.north ?? 0) - (prev.north ?? 0));
  if (step > o.maxStepM) return { split: true, reason: 'largeSpatialGap' };

  const lateral = Math.abs((curr.d ?? 0) - (prev.d ?? 0));
  if (lateral > o.maxLateralStepM) return { split: true, reason: 'largeLateralStep' };

  if (run.length >= 2) {
    const a = run[run.length - 2];
    const span = Math.abs((curr.s ?? 0) - (a.s ?? 0));
    if (span >= o.minDirectionSpanM) {
      const deg = directionChangeDeg(a, prev, curr);
      if (deg > o.maxDirectionChangeDeg) return { split: true, reason: 'largeHeadingChange' };
    }
  }

  return { split: false, reason: null };
}

function buildRunsForGroup(pts, opts) {
  const ordered = orderAndDedupe(pts, opts);
  const runs = [];
  let run = [];
  let splitReasons = [];
  for (const p of ordered) {
    const prev = run[run.length - 1] || null;
    const decision = shouldSplit(prev, p, run, opts);
    if (decision.split && run.length) {
      runs.push({ points: run, splitReason: decision.reason });
      splitReasons.push(decision.reason);
      run = [];
    }
    run.push(p);
  }
  if (run.length) runs.push({ points: run, splitReason: null });
  return { runs, splitReasons, orderedCount: ordered.length };
}

/**
 * @param {Array} displayPoints points with display-world east/north + identity + s/d
 * @returns {{ polylines: Array, diagnostics: object }}
 */
function buildPointAccumulatedLanePolylines(displayPoints, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const diagnostics = {
    candidateActive: true,
    inputCount: displayPoints?.length ?? 0,
    groupCount: 0,
    polylineCount: 0,
    vertexCount: 0,
    skippedShortRuns: 0,
    splitReasonCounts: {},
    crossLanePrevented: 0,
    crossPassPrevented: 0,
    crossChunkPrevented: 0,
    revisitSplits: 0,
  };

  const groups = groupPoints(displayPoints, opts);
  diagnostics.groupCount = groups.size;
  const polylines = [];

  for (const [key, pts] of groups.entries()) {
    const { runs, splitReasons } = buildRunsForGroup(pts, opts);
    for (const reason of splitReasons) {
      diagnostics.splitReasonCounts[reason] = (diagnostics.splitReasonCounts[reason] || 0) + 1;
      if (reason === 'crossLaneIdentity' || reason === 'crossLaneIndex') diagnostics.crossLanePrevented += 1;
      if (reason === 'crossPass') diagnostics.crossPassPrevented += 1;
      if (reason === 'crossChunk') diagnostics.crossChunkPrevented += 1;
      if (reason === 'backwardAlongTrack') diagnostics.revisitSplits += 1;
    }
    for (const run of runs) {
      if ((run.points?.length || 0) < opts.minPoints) {
        diagnostics.skippedShortRuns += 1;
        continue;
      }
      const sample = run.points[0];
      // Detect colour changes inside the run (should never happen with identity grouping).
      const colourIds = new Set(run.points.map((p) => p.groupTrackId));
      if (colourIds.size > 1) diagnostics.crossLanePrevented += 1;
      polylines.push({
        identityKey: key,
        chunkId: sample.chunkId,
        passId: sample.passId,
        groupTrackId: sample.groupTrackId,
        laneIndex: sample.laneIndex ?? null,
        side: sample.side ?? null,
        sourceFile: sample.sourceFile ?? null,
        points: run.points.map((p) => ({
          east: p.east,
          north: p.north,
          s: p.s,
          d: p.d,
          frameId: p.frameId ?? null,
          frameIndex: p.frameIndex ?? null,
          groupTrackId: p.groupTrackId,
          chunkId: p.chunkId,
          passId: p.passId,
          sourceFile: p.sourceFile ?? null,
        })),
        pointCount: run.points.length,
        splitReason: run.splitReason,
      });
      diagnostics.polylineCount += 1;
      diagnostics.vertexCount += run.points.length;
    }
  }

  return { polylines, diagnostics };
}

function emptyDiagnostics() {
  return {
    candidateActive: false,
    inputCount: 0,
    groupCount: 0,
    polylineCount: 0,
    vertexCount: 0,
    skippedShortRuns: 0,
    splitReasonCounts: {},
    crossLanePrevented: 0,
    crossPassPrevented: 0,
    crossChunkPrevented: 0,
    revisitSplits: 0,
  };
}

function auditPolylineSet(polylines) {
  const issues = [];
  let maxSegLen = 0;
  let nonFinite = 0;
  let backward = 0;
  let colourChange = 0;
  let crossPass = 0;
  let crossChunk = 0;
  for (const poly of polylines || []) {
    const pts = poly.points || [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!Number.isFinite(p.east) || !Number.isFinite(p.north) || !Number.isFinite(p.s)) {
        nonFinite += 1;
        issues.push({ type: 'nonFinite', identityKey: poly.identityKey, i });
      }
      if (i > 0) {
        const prev = pts[i - 1];
        const len = Math.hypot(p.east - prev.east, p.north - prev.north);
        if (len > maxSegLen) maxSegLen = len;
        if ((p.s ?? 0) < (prev.s ?? 0) - 1e-6) {
          backward += 1;
          issues.push({ type: 'backwardOrdering', identityKey: poly.identityKey, i });
        }
        if (String(p.groupTrackId) !== String(prev.groupTrackId)) {
          colourChange += 1;
          issues.push({ type: 'identityChange', identityKey: poly.identityKey, i });
        }
        if (String(p.passId) !== String(prev.passId)) crossPass += 1;
        if (String(p.chunkId) !== String(prev.chunkId)) crossChunk += 1;
      }
    }
  }
  return {
    polylineCount: polylines?.length ?? 0,
    maxSegmentLengthM: maxSegLen,
    nonFiniteCount: nonFinite,
    backwardOrderingCount: backward,
    identityChangeCount: colourChange,
    crossPassCount: crossPass,
    crossChunkCount: crossChunk,
    issues: issues.slice(0, 50),
  };
}

const api = {
  QUERY_PARAM,
  DEFAULTS,
  parsePointAccumulatedLanePolylineCandidate,
  identityKey,
  groupPoints,
  orderAndDedupe,
  shouldSplit,
  buildPointAccumulatedLanePolylines,
  emptyDiagnostics,
  auditPolylineSet,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.PointAccumulatedLanePolylines = api;
