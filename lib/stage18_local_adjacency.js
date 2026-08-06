/**
 * Stage 18 — route-s-local lateral adjacency and signed-width sampling.
 */
const { DEFAULT_INTERVAL_ASSESSMENT } = require('./stage18_lane_interval_schema');
const {
  isFiniteWidth,
  isPositiveSignedWidth,
  isNonPositiveSignedWidth,
  WIDTH_POSITIVE_EPS_M,
} = require('./stage18_width_tolerance');

const sortedPtsCache = new WeakMap();

function getSortedRoutePoints(run) {
  if (!sortedPtsCache.has(run)) {
    sortedPtsCache.set(
      run,
      (run.representativeRouteD || [])
        .filter((p) => Number.isFinite(p.s) && Number.isFinite(p.d))
        .sort((a, b) => a.s - b.s),
    );
  }
  return sortedPtsCache.get(run);
}

function interpolateDAtS(run, s) {
  const pts = getSortedRoutePoints(run);
  if (!pts.length) return { d: null, extrapolated: false };
  if (s < pts[0].s) return { d: pts[0].d, extrapolated: true, extrapolationEnd: 'start' };
  if (s > pts[pts.length - 1].s) return { d: pts[pts.length - 1].d, extrapolated: true, extrapolationEnd: 'end' };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (s >= a.s && s <= b.s) {
      const t = (s - a.s) / (b.s - a.s || 1);
      return { d: a.d + t * (b.d - a.d), extrapolated: false };
    }
  }
  return { d: null, extrapolated: false };
}

function computeOverlap(left, right) {
  const lo = Math.max(left.routeSStart, right.routeSStart);
  const hi = Math.min(left.routeSEnd, right.routeSEnd);
  return { lo, hi, span: Math.max(0, hi - lo) };
}

function assignLeftRight(left, right, options = {}) {
  const o = { ...DEFAULT_INTERVAL_ASSESSMENT, ...options };
  if (left.meanD + o.lateralOrderToleranceM < right.meanD) {
    return { left: right, right: left, swapped: true };
  }
  return { left, right, swapped: false };
}

function interveningRunAtS(left, right, allRuns, s, options = {}) {
  const o = { ...DEFAULT_INTERVAL_ASSESSMENT, ...options };
  const dl = interpolateDAtS(left, s);
  const dr = interpolateDAtS(right, s);
  if (!isFiniteWidth(dl.d) || !isFiniteWidth(dr.d)) return null;
  const lo = Math.min(dl.d, dr.d);
  const hi = Math.max(dl.d, dr.d);
  for (const mid of allRuns) {
    if (mid.dividerRunId === left.dividerRunId || mid.dividerRunId === right.dividerRunId) continue;
    const dm = interpolateDAtS(mid, s);
    if (!isFiniteWidth(dm.d)) continue;
    if (dm.d > lo + o.lateralOrderToleranceM && dm.d < hi - o.lateralOrderToleranceM) {
      return mid;
    }
  }
  return null;
}

function sampleRouteSPoints(overlap, stepM) {
  const points = [];
  if (overlap.span <= 0) return points;
  const maxSamples = 250;
  const step = Math.max(stepM, overlap.span / Math.max(1, maxSamples - 1));
  for (let s = overlap.lo; s <= overlap.hi + 1e-9; s += step) {
    points.push(Number(s.toFixed(6)));
  }
  if (points[points.length - 1] < overlap.hi - 1e-9) {
    points.push(Number(overlap.hi.toFixed(6)));
  }
  return points;
}

function evaluateLocalAdjacency(left, right, allRuns, overlap, options = {}) {
  const o = { ...DEFAULT_INTERVAL_ASSESSMENT, ...options };
  const assigned = assignLeftRight(left, right, o);
  const L = assigned.left;
  const R = assigned.right;
  const samples = [];
  const samplePoints = sampleRouteSPoints(overlap, o.sampleSStepM);

  for (const s of samplePoints) {
    const dl = interpolateDAtS(L, s);
    const dr = interpolateDAtS(R, s);
    const widthM = isFiniteWidth(dl.d) && isFiniteWidth(dr.d) ? dl.d - dr.d : NaN;
    const intervening = interveningRunAtS(L, R, allRuns, s, o);
    const validOrder = isPositiveSignedWidth(widthM);
    samples.push({
      s,
      leftD: dl.d,
      rightD: dr.d,
      widthM,
      validOrder,
      hasIntervening: Boolean(intervening),
      interveningRunId: intervening?.dividerRunId ?? null,
      leftExtrapolated: dl.extrapolated,
      rightExtrapolated: dr.extrapolated,
      extrapolated: dl.extrapolated || dr.extrapolated,
      adjacent: validOrder && !intervening,
    });
  }

  const validSubranges = [];
  let current = null;
  for (const sample of samples) {
    if (sample.adjacent) {
      if (!current) current = { lo: sample.s, hi: sample.s };
      current.hi = sample.s;
    } else if (current) {
      validSubranges.push({ ...current, span: current.hi - current.lo });
      current = null;
    }
  }
  if (current) validSubranges.push({ ...current, span: current.hi - current.lo });

  const adjacentSamples = samples.filter((s) => s.adjacent);
  const orderFailures = samples.filter((s) => !s.validOrder);
  const interveningSamples = samples.filter((s) => s.hasIntervening);

  let adjacencyState = 'none';
  if (adjacentSamples.length === samples.length && samples.length > 0) {
    adjacencyState = 'full_span';
  } else if (adjacentSamples.length > 0) {
    adjacencyState = 'partial_span';
  }

  const midIdx = Math.floor(samples.length / 2);
  const lateralOrderAt = {
    start: samples[0] ? { leftD: samples[0].leftD, rightD: samples[0].rightD, valid: samples[0].validOrder } : null,
    midpoint: samples[midIdx] ? { leftD: samples[midIdx].leftD, rightD: samples[midIdx].rightD, valid: samples[midIdx].validOrder } : null,
    end: samples[samples.length - 1]
      ? { leftD: samples[samples.length - 1].leftD, rightD: samples[samples.length - 1].rightD, valid: samples[samples.length - 1].validOrder }
      : null,
  };

  let orderExchange = false;
  let prevSign = null;
  for (const sample of samples) {
    if (!isFiniteWidth(sample.widthM)) continue;
    const sign = sample.widthM > WIDTH_POSITIVE_EPS_M ? 1 : sample.widthM < -WIDTH_POSITIVE_EPS_M ? -1 : 0;
    if (prevSign != null && sign !== 0 && prevSign !== 0 && sign !== prevSign) orderExchange = true;
    if (sign !== 0) prevSign = sign;
  }

  return {
    left: L,
    right: R,
    swapped: assigned.swapped,
    samples,
    validSubranges: validSubranges.filter((r) => r.span >= o.minSharedRouteSM),
    adjacencyState,
    lateralOrderAt,
    orderExchange,
    orderFailureCount: orderFailures.length,
    interveningSampleCount: interveningSamples.length,
    extrapolationSampleCount: samples.filter((s) => s.extrapolated).length,
    adjacentSampleCount: adjacentSamples.length,
    totalSampleCount: samples.length,
  };
}

function buildWidthProfileFromSamples(samples) {
  const widths = samples.map((s) => ({
    s: s.s,
    widthM: s.widthM,
    leftD: s.leftD,
    rightD: s.rightD,
    extrapolated: s.extrapolated,
  }));
  const leftPts = samples.map((s) => ({ s: s.s, d: s.leftD }));
  const rightPts = samples.map((s) => ({ s: s.s, d: s.rightD }));
  return { widths, leftPts, rightPts };
}

module.exports = {
  interpolateDAtS,
  computeOverlap,
  assignLeftRight,
  interveningRunAtS,
  evaluateLocalAdjacency,
  buildWidthProfileFromSamples,
  sampleRouteSPoints,
};
