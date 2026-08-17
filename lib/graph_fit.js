'use strict';

/**
 * Path-1 graph fitting of accumulated lane-boundary points (EXPERIMENTAL).
 *
 * Converts the ordered, identity-tagged point sequence of one trusted
 * constructed fragment into a cleaner fitted curve. This is a geometry-cleaning
 * stage only: it does not compensate for pose, identity, detection or tracking
 * failures, and it never changes lane detection, tracking, pose locking,
 * fragments, joining, chunks, passes, mirror semantics or video.
 *
 * OUT OF SCOPE (by design):
 *  - Path 2 graph-order recovery for folded/uncertain runs: such runs are left
 *    `orderingInvalid` and are never fitted.
 *  - Fitting across chunks or passes (one fit = one fragment within one
 *    chunk/pass).
 *  - Feeding fitted curves into road-polygon construction.
 *
 * MATHEMATICS (normalized weighted objective; independent for east(t) and
 * north(t), t = u / L in [0,1], u = cumulative chord length in metres):
 *
 *   J(f) = [ Σ_i w_i (y_i - f(t_i))^2 / Σ_i w_i ]  +  λ ∫_0^1 (f''(t))^2 dt
 *
 *   Normal equations (A β = b):
 *     A = Bᵀ W B / Σw + λ Ω
 *     b = Bᵀ W y / Σw
 *
 * This normalization makes the smoothing strength invariant to the number of
 * points, frames, stationary bins or sampling density: duplicating every
 * observation leaves BᵀWB/Σw and BᵀWy/Σw unchanged, so the fit and the
 * selected λ are unchanged.
 *
 * LAMBDA SCALING under the normalized objective:
 *   The normalized objective is equivalent (same minimizer) to
 *   Σ_i w_i (y_i - f(t_i))^2 + λ·Σw ∫(f'')² dt, i.e. an unnormalized penalty
 *   λ̃ = λ·Σw. The Silverman cutoff relation for
 *   min Σw(y-f)² + λ̃∫(f'')² on [0,1] is  Λ_c ≈ L·(λ̃/Σw)^{1/4}.
 *   Substituting λ̃ = λ·Σw gives  Λ_c = L·λ^{1/4}, so
 *
 *     λ = (Λ_c / L)^4
 *
 *   The Σw dependence cancels exactly, so λ is a pure function of the physical
 *   cutoff wavelength Λ_c (metres) and run length L (metres). This is the
 *   corrected derivation (the earlier unnormalized derivation is NOT used).
 *
 * SPLINE BOOKKEEPING:
 *   degree p = 3 (cubic B-splines, clamped at 0 and 1).
 *   interiorBreaks = number of interior breakpoints (uniform in (0,1)).
 *   basisCount     = interiorBreaks + degree + 1   (number of basis functions)
 *   knotLen        = basisCount + degree + 1       (complete knot-vector length)
 *   knot vector    = [0]*(p+1), interior, [1]*(p+1)
 *   Clamped endpoint multiplicity = degree + 1 = 4.
 *
 * STATUSES (one result record per attempted run):
 *   accepted             normal fitted layer (solid)
 *   orderingInvalid      Path-2 (folded/broken order); never fitted
 *   insufficientSupport  below min frames/points/span or zero total weight
 *   validationInsufficient  fit+topology ok but grouped held-out folds lack
 *                           training support; dashed diagnostic layer only
 *   topologyRejected     fitted curve self-intersects / crosses another
 *   qualityRejected      held-out error exceeds gates
 *   numericalFailure     solver failure after deterministic fallback
 *
 * Deterministic: no randomness; every branch is a pure function of inputs.
 */

// --- defaults ---------------------------------------------------------------

const GRAPH_FIT_DEFAULTS = {
  fitEnabled: false,
  fitMethod: 'robustSmoothingSpline',
  // Physical cutoff wavelengths (metres) that define the lambda grid.
  fitLambdaCutoffsM: [1.5, 2, 3, 5, 8, 12, 20, 35],
  // Knot spacing expressed in metres of arc; effective span is
  // max(fitKnotSpacingM, L / (fitMaxBasis - 1)).
  fitKnotSpacingM: 2.0,
  // Cap on basis functions (bounds Cholesky cost and over-fitting).
  fitMaxBasis: 40,
  fitTukeyK: 3.5,
  // Gap break on collapsed-bin chord distance (metres).
  fitMaxGapM: 8.0,
  // Stationary runs: model forward spacing is sampling, not a coverage gap.
  fitStationaryMaxGapM: 30.0,
  // Ordering gate: a step beyond this on collapsed bins = broken.
  fitOrderingMaxStepM: 20.0,
  fitMinSupport: 2,
  fitLowSupportWeight: 0.25,
  // Spatial bin for collapsing repeated evidence (metres).
  fitStationaryBinM: 0.25,
  fitMinTotalFrames: 5,
  fitMinTrainingFrames: 4,
  fitMinSpanM: 3.0,
  fitMinPointsPerRun: 4,
  fitMaxEndTrimM: 1.0,
  fitCrossingToleranceM: 0.5,
  fitOutputStepM: 0.5,
  fitIRLSMaxIter: 20,
  fitIRLSTol: 1e-8,
  fitMaxCond: 1e10,
  fitJitterEps: 1e-9,
  fitFoldCountMax: 5,
  fitMinPosesForTravelFit: 3,
  // Explicit stationary signal from the map build (degenerate reference
  // trajectory). When null, fitRun falls back to the pose-count heuristic.
  fitIsStationary: null,
  fitMaxHeldOutMedianM: 0.5,
  fitMaxHeldOutP95M: 1.5,
  // Held-out tie tolerance (fractional) for lambda selection.
  fitSelectMedianTol: 0.05,
  fitSelectP95Tol: 0.10,
  fitDiagnosticDashed: true,
  // Max distance (m) from any fitted vertex to its own source fragment polyline.
  // Detached or frame-mismatched fits are rejected before rendering.
  fitMaxSourceCorridorM: 3.0,
};

/** Coordinate frame tag for fitted output vertices and result records. */
const SEGMENT_LOCAL_COORDINATE_FRAME = 'segmentLocal';

// --- small numeric helpers --------------------------------------------------

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
function dist2d(a, b) {
  return Math.hypot((b.east ?? 0) - (a.east ?? 0), (b.north ?? 0) - (a.north ?? 0));
}

/** Deterministic Gauss-Legendre 8-point nodes/weights on [-1,1]. */
const GL8_NODES = [
  -0.9602898564975363, -0.7966664774136267, -0.5255324099163290, -0.1834346424956498,
  0.1834346424956498, 0.5255324099163290, 0.7966664774136267, 0.9602898564975363,
];
const GL8_WEIGHTS = [
  0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.3626837833783620,
  0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763,
];

// --- ordering audit ---------------------------------------------------------

function segmentsCross(p1, p2, q1, q2) {
  const cross = (o, p, q) => (p.east - o.east) * (q.north - o.north) - (p.north - o.north) * (q.east - o.east);
  const d1 = cross(p1, p2, q1);
  const d2 = cross(p1, p2, q2);
  const d3 = cross(q1, q2, p1);
  const d4 = cross(q1, q2, p2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Ordering audit in the physical local frame (east/north).
 * @param {Array<{east,north,s,logMonoTime?,frameIndex?}>} seq ordered sequence
 * @returns {{backtracks, crossings, maxStepM, sMonotonic, timeMonotonic,
 *            frameMonotonic, forwardExtentM, arcLengthM}}
 */
function auditOrder(seq) {
  const n = seq.length;
  let backtracks = 0;
  let crossings = 0;
  let maxStep = 0;
  let sMonotonic = 0;
  let timeMonotonic = 0;
  let frameMonotonic = 0;
  let arc = 0;
  let sPairs = 0;
  let tPairs = 0;
  let fPairs = 0;
  const dirE = n >= 3 ? seq[n - 1].east - seq[0].east : 0;
  const dirN = n >= 3 ? seq[n - 1].north - seq[0].north : 0;
  const dirLen = Math.hypot(dirE, dirN) || 1e-9;
  for (let i = 1; i < n; i++) {
    const step = dist2d(seq[i - 1], seq[i]);
    arc += step;
    if (step > maxStep) maxStep = step;
    if (n >= 3) {
      const proj = ((seq[i].east - seq[i - 1].east) * dirE + (seq[i].north - seq[i - 1].north) * dirN) / dirLen;
      if (proj < -1.0) backtracks++;
    }
    if (seq[i].s != null && seq[i - 1].s != null) {
      sPairs++;
      if (seq[i].s > seq[i - 1].s - 1e-9) sMonotonic++;
    }
    if (seq[i].logMonoTime != null && seq[i - 1].logMonoTime != null) {
      tPairs++;
      if (Number(seq[i].logMonoTime) >= Number(seq[i - 1].logMonoTime)) timeMonotonic++;
    }
    if (seq[i].frameIndex != null && seq[i - 1].frameIndex != null) {
      fPairs++;
      if (seq[i].frameIndex >= seq[i - 1].frameIndex) frameMonotonic++;
    }
  }
  for (let i = 0; i + 2 < n; i++) {
    for (let j = i + 2; j + 1 < n; j++) {
      if (segmentsCross(seq[i], seq[i + 1], seq[j], seq[j + 1])) crossings++;
    }
  }
  return {
    backtracks,
    crossings,
    maxStepM: +maxStep.toFixed(3),
    sMonotonic: sPairs ? sMonotonic / sPairs : 1,
    timeMonotonic: tPairs ? timeMonotonic / tPairs : 1,
    frameMonotonic: fPairs ? frameMonotonic / fPairs : 1,
    forwardExtentM: n >= 2 ? +dist2d(seq[0], seq[n - 1]).toFixed(2) : 0,
    arcLengthM: +arc.toFixed(2),
  };
}

// --- stationary collapse ----------------------------------------------------

/** Distinct poses at `round` precision (0.5 m). */
function distinctPoseCount(seq) {
  const seen = new Set();
  for (const p of seq) {
    const key = `${Math.round((p.east ?? 0) * 2)},${Math.round((p.north ?? 0) * 2)}`;
    seen.add(key);
  }
  return seen.size;
}

/**
 * Collapse repeated evidence into spatial bins. Each bin's position is the
 * weighted median of member canonical (and mirrored) coordinates, and the bin
 * weight is the MEDIAN member weight (so a cluster of N identical observations
 * counts as one evidence unit, never N). Members from different frames are
 * retained so the bin participates in every frame's fold correctly.
 * Binning is spatial (fitStationaryBinM grid), which merges repeated
 * observations from one pose without needing a forward axis, and is a no-op for
 * already-spaced moving samples.
 *
 * @returns {Array<{east,north,mirroredEast,mirroredNorth,s,weight,
 *                  frameIds:number[], frameIndexMin, count, medianScore}>}
 */
function collapseStationary(seq, opts) {
  const bin = opts.fitStationaryBinM || 0.25;
  const buckets = new Map();
  for (const p of seq) {
    const key = `${Math.round((p.east ?? 0) / bin)},${Math.round((p.north ?? 0) / bin)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }
  const bins = [];
  for (const members of buckets.values()) {
    // weighted median of each coordinate (weight = w)
    const ws = members.map((m) => m.weight ?? 1);
    const totalW = ws.reduce((a, b) => a + b, 0) || 1;
    const wmed = (getter) => {
      const entries = members.map((m, i) => ({ v: getter(m), w: ws[i] }))
        .filter((e) => Number.isFinite(e.v))
        .sort((a, b) => a.v - b.v);
      let acc = 0;
      for (const e of entries) {
        acc += e.w;
        if (acc >= totalW * 0.5) return e.v;
      }
      return entries.length ? entries[entries.length - 1].v : null;
    };
    const frameIds = [...new Set(members.map((m) => m.frameId).filter((x) => x != null))];
    const east = wmed((m) => m.east);
    const north = wmed((m) => m.north);
    bins.push({
      east,
      north,
      mirroredEast: wmed((m) => (m.mirroredEast != null ? m.mirroredEast : m.east)),
      mirroredNorth: wmed((m) => (m.mirroredNorth != null ? m.mirroredNorth : m.north)),
      s: wmed((m) => m.s),
      weight: median(ws) ?? 1,
      frameIds,
      frameIndexMin: Math.min(...members.map((m) => m.frameIndex).filter((x) => x != null)),
      count: members.length,
      medianScore: median(members.map((m) => m.score ?? 0)) ?? 0,
      _members: members,
    });
  }
  return bins;
}

// --- B-spline basis ---------------------------------------------------------

/**
 * Build a clamped uniform B-spline basis descriptor.
 * @returns {{degree, interiorBreaks, basisCount, knotLen, knots:number[]}}
 */
function buildSplineBasis(interiorBreaks, degree = 3) {
  const p = degree;
  const nb = interiorBreaks; // interior breakpoints
  const basisCount = nb + p + 1;
  const knotLen = basisCount + p + 1;
  const knots = [];
  for (let i = 0; i <= p; i++) knots.push(0);
  for (let i = 1; i <= nb; i++) knots.push(i / (nb + 1));
  for (let i = 0; i <= p; i++) knots.push(1);
  return { degree: p, interiorBreaks: nb, basisCount, knotLen, knots };
}

/**
 * Evaluate all B-spline basis functions (and 1st/2nd derivatives) at t using
 * Cox-de Boor recursion. Returns array of {v, d1, d2} per basis function.
 *
 * Basis functions of degree r on knot vector `knots` (length knotLen) number
 * knotLen - (r+1). The derivative recurrence uses the same knot vector with
 * degree reduced by one:
 *   d/dt N_{i,p} = p*( N_{i,p-1}/(k_{i+p}-k_i) - N_{i+1,p-1}/(k_{i+p+1}-k_{i+1}) )
 */
function evalDegreeBasis(tt, knots, r) {
  const count = knots.length - (r + 1);
  let vals = new Array(count).fill(0);
  for (let i = 0; i < count; i++) {
    if (tt >= knots[i] && tt < knots[i + 1]) vals[i] = 1;
  }
  if (tt === knots[knots.length - 1] && r === 0) vals[count - 1] = 1;
  for (let d = 1; d <= r; d++) {
    const nxt = new Array(count).fill(0);
    for (let i = 0; i < count; i++) {
      if (i + d + 1 >= knots.length) continue;
      const denom1 = knots[i + d] - knots[i];
      const denom2 = knots[i + d + 1] - knots[i + 1];
      nxt[i] = (denom1 !== 0 ? ((tt - knots[i]) / denom1) * vals[i] : 0)
        + (denom2 !== 0 ? ((knots[i + d + 1] - tt) / denom2) * vals[i + 1] : 0);
    }
    vals = nxt;
  }
  return vals;
}

function evalBasisAll(t, basis) {
  const { knots, degree: p, basisCount } = basis;
  const last = knots[knots.length - 1];
  // At exactly the right clamped knot the spline equals its left limit; nudge
  // by a tiny epsilon so the Cox-de Boor recursion stays inside [knots[0],last).
  const atLast = t >= last;
  const tt = clamp(atLast ? last - 1e-12 : t, knots[0], last);
  const values = evalDegreeBasis(tt, knots, p);
  const out = [];
  for (let j = 0; j < basisCount; j++) out.push({ v: values[j] ?? 0, d1: 0, d2: 0 });
  if (p >= 1) {
    // first derivative of degree p basis
    const Np1 = evalDegreeBasis(tt, knots, p - 1); // length basisCount+1
    for (let j = 0; j < basisCount; j++) {
      const denom1 = knots[j + p] - knots[j];
      const denom2 = knots[j + p + 1] - knots[j + 1];
      out[j].d1 = (denom1 !== 0 ? (p / denom1) * Np1[j] : 0)
        - (denom2 !== 0 ? (p / denom2) * Np1[j + 1] : 0);
    }
  }
  if (p >= 2) {
    // second derivative: derivative of d1, using degree p-1 first derivatives
    const Np2 = evalDegreeBasis(tt, knots, p - 2); // length basisCount+2
    const d1p1 = [];
    for (let j = 0; j < basisCount + 1; j++) {
      const denom1 = knots[j + (p - 1)] - knots[j];
      const denom2 = knots[j + p] - knots[j + 1];
      d1p1.push((denom1 !== 0 ? ((p - 1) / denom1) * Np2[j] : 0)
        - (denom2 !== 0 ? ((p - 1) / denom2) * Np2[j + 1] : 0));
    }
    for (let j = 0; j < basisCount; j++) {
      const denom1 = knots[j + p] - knots[j];
      const denom2 = knots[j + p + 1] - knots[j + 1];
      out[j].d2 = (denom1 !== 0 ? (p / denom1) * d1p1[j] : 0)
        - (denom2 !== 0 ? (p / denom2) * d1p1[j + 1] : 0);
    }
  }
  return out;
}

/** Design matrix B (n x basisCount) at parameter values t[]. */
function buildDesignMatrix(ts, basis) {
  const n = ts.length;
  const m = basis.basisCount;
  const B = [];
  for (let i = 0; i < n; i++) {
    const row = evalBasisAll(ts[i], basis).map((e) => e.v);
    B.push(row);
  }
  return { B, rows: n, cols: m };
}

/** First/second derivative rows for residual/topology checks. */
function evalRow(ts, basis, deriv) {
  const n = ts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const e = evalBasisAll(ts[i], basis);
    out.push(e.map((x) => (deriv === 1 ? x.d1 : deriv === 2 ? x.d2 : x.v)));
  }
  return out;
}

/**
 * Penalty matrix Ω = ∫_0^1 B''(t) B''(t)ᵀ dt by Gauss-Legendre quadrature over
 * each knot span (degree-3 second derivatives are piecewise linear, so the
 * integrand is piecewise quadratic; 8-point quadrature is exact).
 *
 * The raw integral scales with knot density (~1/h³); we normalize by the mean
 * diagonal so the penalty term is O(1) and the dimensionless λ grid
 * (λ = (Λ_c/L)⁴) has comparable meaning across runs with different knot
 * counts. Normalization is a pure function of the basis, so determinism and
 * duplication-invariance are preserved.
 */
function buildPenaltyMatrix(basis) {
  const m = basis.basisCount;
  const knots = basis.knots;
  const Omega = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let s = 0; s + 1 < knots.length; s++) {
    const a = knots[s];
    const b = knots[s + 1];
    if (b - a < 1e-12) continue;
    const mid = (a + b) / 2;
    const half = (b - a) / 2;
    for (let g = 0; g < GL8_NODES.length; g++) {
      const t = mid + half * GL8_NODES[g];
      const row = evalBasisAll(t, basis).map((e) => e.d2);
      for (let i = 0; i < m; i++) {
        for (let j = i; j < m; j++) {
          Omega[i][j] += GL8_WEIGHTS[g] * half * row[i] * row[j];
        }
      }
    }
  }
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < i; j++) Omega[i][j] = Omega[j][i];
  }
  const meanDiag = m ? Omega.reduce((a, row, i) => a + (row[i] ?? 0), 0) / m : 1;
  if (!(meanDiag > 0) || !Number.isFinite(meanDiag)) return Omega;
  const scale = 1 / meanDiag;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) Omega[i][j] *= scale;
  }
  return Omega;
}

// --- linear solver (Cholesky with jitter fallback) --------------------------

function isSymmetricPositiveSemidefinite(M, tol) {
  const n = M.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (Math.abs(M[i][j] - M[j][i]) > (tol || 1e-8)) return false;
    }
  }
  // leading principal minors non-negative (rough check)
  for (let k = 0; k < n; k++) {
    const sub = M.slice(0, k + 1).map((row) => row.slice(0, k + 1));
    let det = 1;
    try { det = determinant(sub); } catch { return false; }
    if (!Number.isFinite(det) || det < -1e-8) return false;
  }
  return true;
}
function determinant(M) {
  const n = M.length;
  if (n === 0) return 1;
  if (n === 1) return M[0][0];
  let sign = 1;
  const A = M.map((row) => [...row]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[pivot][i])) pivot = r;
    if (Math.abs(A[pivot][i]) < 1e-14) return 0;
    if (pivot !== i) { [A[i], A[pivot]] = [A[pivot], A[i]]; sign = -sign; }
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / A[i][i];
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
    }
  }
  let d = sign;
  for (let i = 0; i < n; i++) d *= A[i][i];
  return d;
}

/**
 * Solve (A) β = b by Cholesky (LDLᵀ) with deterministic diagonal jitter
 * fallback. Returns { beta, method, jittered, condEstimate }.
 */
function solveSymmetric(A, b, opts = {}) {
  const n = A.length;
  const maxCond = opts.maxCond ?? GRAPH_FIT_DEFAULTS.fitMaxCond;
  const jitterEps = opts.jitterEps ?? GRAPH_FIT_DEFAULTS.fitJitterEps;
  const maxDiag = Math.max(1, ...A.map((row, i) => Math.abs(row[i] ?? 0)));
  const attempt = (jitter) => {
    const M = A.map((row) => [...row]);
    if (jitter > 0) for (let i = 0; i < n; i++) M[i][i] += jitter;
    const L = Array.from({ length: n }, () => new Array(n).fill(0));
    const D = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = M[i][j];
        for (let k = 0; k < j; k++) sum -= L[i][k] * D[k] * L[j][k];
        if (i === j) {
          D[i] = sum;
          if (D[i] <= 1e-14 * maxDiag || !Number.isFinite(D[i])) return null;
          L[i][i] = 1;
        } else {
          L[i][j] = sum / D[j];
        }
      }
    }
    // forward/back solve for β (L D Lᵀ β = b)
    const y = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = b[i];
      for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
      y[i] = s;
    }
    const z = new Array(n).fill(0);
    for (let i = 0; i < n; i++) z[i] = y[i] / D[i];
    const beta = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let s = z[i];
      for (let k = i + 1; k < n; k++) s -= L[k][i] * beta[k];
      beta[i] = s;
    }
    // condition estimate: ratio of extreme pivots (crude but deterministic)
    const dmin = Math.min(...D.map((d) => Math.abs(d)));
    const dmax = Math.max(...D.map((d) => Math.abs(d)));
    const condEst = dmin > 0 ? dmax / dmin : Infinity;
    return { beta, condEstimate: condEst };
  };
  let res = attempt(0);
  let jittered = false;
  if (!res || res.condEstimate > maxCond) {
    res = attempt(jitterEps * maxDiag);
    jittered = true;
  }
  if (!res || !res.beta.every((x) => Number.isFinite(x))) {
    return { beta: null, method: 'failed', jittered, condEstimate: Infinity };
  }
  return { beta: res.beta, method: jittered ? 'jitteredCholesky' : 'cholesky', jittered, condEstimate: res.condEstimate };
}

// --- IRLS robust fit of one coordinate --------------------------------------

/**
 * Fit coordinate y(t) under the normalized weighted objective with Tukey IRLS.
 * @returns {{beta, method, residualScale, iter, weights, converged, failed}}
 */
/**
 * Result-identical caches:
 *  - OmegaCache: roughness penalty matrix keyed by basis spec
 *    (`${interiorBreaks}:${degree}`). Ω depends only on the basis, so it is
 *    identical across the whole λ grid, across folds, and across east/north.
 *  - DesignCache: design matrix keyed by exact t-values + basis spec. B depends
 *    only on the t parameter values and the basis, so it is identical across λ
 *    candidates and across east/north for the same bin subset.
 *
 * Both are pure-function memoizations; they cannot change results.
 *
 * CACHE SCOPE: per complete-map fit invocation (per fitConstructedRuns call).
 * A fresh cache context is created for every build and dropped when the build
 * returns, so navigating segments never accumulates matrices in memory. This is
 * result-identical: the cache only memoizes values that are pure functions of
 * their arguments within one build, and no cross-build retention is required.
 */
const OMEGA_CACHE_MAX = 512;
const DESIGN_CACHE_MAX = 2048;

function createFitCaches() {
  return {
    omega: new Map(),
    design: new Map(),
    omegaBuilds: 0,
    designBuilds: 0,
  };
}

function basisCacheKey(basis) {
  return `${basis.interiorBreaks}:${basis.degree}`;
}
function designCacheKey(ts, basis) {
  return `${basisCacheKey(basis)}|${ts.map((x) => x.toFixed(12)).join(',')}`;
}

function cachedPenaltyMatrix(basis, cacheCtx) {
  const ctx = cacheCtx || {};
  if (ctx.omega && ctx.omega.has(basisCacheKey(basis))) return ctx.omega.get(basisCacheKey(basis));
  ctx.omegaBuilds = (ctx.omegaBuilds || 0) + 1;
  const O = buildPenaltyMatrix(basis);
  if (ctx.omega) {
    if (ctx.omega.size >= OMEGA_CACHE_MAX) ctx.omega.clear();
    ctx.omega.set(basisCacheKey(basis), O);
  }
  return O;
}

function cachedDesignMatrix(ts, basis, cacheCtx) {
  const ctx = cacheCtx || {};
  const key = designCacheKey(ts, basis);
  if (ctx.design && ctx.design.has(key)) return ctx.design.get(key);
  ctx.designBuilds = (ctx.designBuilds || 0) + 1;
  const D = buildDesignMatrix(ts, basis);
  if (ctx.design) {
    if (ctx.design.size >= DESIGN_CACHE_MAX) ctx.design.clear();
    ctx.design.set(key, D);
  }
  return D;
}

function fitCoordinate(ts, y, weights, lambda, basis, opts, precomputed = null, cacheCtx = null) {
  const n = ts.length;
  const m = basis.basisCount;
  const totalW = weights.reduce((a, b) => a + b, 0);
  if (!(totalW > 0) || !Number.isFinite(totalW)) {
    return { beta: null, failed: true, reason: 'zeroTotalWeight' };
  }
  const { B } = precomputed && precomputed.B ? precomputed : cachedDesignMatrix(ts, basis, cacheCtx);
  const Omega = precomputed && precomputed.Omega ? precomputed.Omega : cachedPenaltyMatrix(basis, cacheCtx);

  let w = weights.slice();
  let beta = null;
  let converged = false;
  let residualScale = 0;
  let method = 'cholesky';
  let lastResidual = null;

  for (let iter = 0; iter <= opts.fitIRLSMaxIter; iter++) {
    // A = Bᵀ W B / Σw + λ Ω ; b = Bᵀ W y / Σw
    const A = Array.from({ length: m }, () => new Array(m).fill(0));
    const b = new Array(m).fill(0);
    const wsum = w.reduce((a, c) => a + c, 0) || 1;
    for (let i = 0; i < n; i++) {
      const wi = w[i] / wsum;
      const row = B[i];
      for (let j = 0; j < m; j++) {
        b[j] += wi * row[j] * y[i];
        for (let k = 0; k < m; k++) A[j][k] += wi * row[j] * row[k];
      }
    }
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) A[i][j] += lambda * Omega[i][j];
    }
    const solved = solveSymmetric(A, b, opts);
    if (!solved.beta) {
      return { beta: null, failed: true, reason: solved.method === 'failed' ? 'singular' : 'singularJittered' };
    }
    beta = solved.beta;
    if (solved.jittered) method = 'jitteredCholesky';

    // residuals
    const res = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let f = 0;
      for (let j = 0; j < m; j++) f += B[i][j] * beta[j];
      res[i] = y[i] - f;
    }
    const medRes = median(res) ?? 0;
    const absDev = res.map((r) => Math.abs(r - medRes));
    residualScale = 1.4826 * (median(absDev) ?? 0);
    lastResidual = res;

    if (iter === opts.fitIRLSMaxIter) break;

    if (residualScale <= 1e-9) {
      // MAD = 0: nothing to down-weight; keep weights, stop IRLS.
      converged = true;
      break;
    }
    // Tukey weights
    const k = opts.fitTukeyK;
    const newW = res.map((r) => {
      const u = Math.abs(r) / (k * residualScale);
      if (u >= 1) return 0;
      return (1 - u * u) * (1 - u * u);
    });
    // combine with evidence weights (element-wise), renormalize not needed here
    const combined = weights.map((w0, i) => w0 * newW[i]);
    const delta = combined.reduce((a, c, i) => a + Math.abs(c - w[i]), 0) / (combined.reduce((a, c) => a + Math.abs(c), 0) || 1);
    w = combined;
    if (delta < opts.fitIRLSTol) { converged = true; break; }
  }

  if (!beta || !beta.every((x) => Number.isFinite(x))) {
    return { beta: null, failed: true, reason: 'nonFiniteBeta' };
  }
  return {
    beta,
    failed: false,
    converged,
    method,
    residualScale,
    iterations: undefined,
    weights: w,
    residual: lastResidual,
  };
}

/** Evaluate fitted curve values at ts for coordinate beta. */
function evalCurve(ts, basis, beta) {
  const rows = evalRow(ts, basis, 0);
  const vals = [];
  for (let i = 0; i < ts.length; i++) {
    let v = 0;
    for (let j = 0; j < beta.length; j++) v += rows[i][j] * beta[j];
    vals.push(v);
  }
  return vals;
}

/**
 * Determine whether a reference trajectory is degenerate (fully stationary),
 * matching the segment-local-map semantics exactly:
 *   trajectory === null (absent), OR its totalLength <= 1e-6 m (one point or
 *   multiple identical points collapse to zero length).
 *
 * This is the single source of truth for the stationary fit condition. It must
 * agree with the map's stationary local-map condition (segment_local_map treats
 * a trajectory as present only when builtTrajectory && totalLength > 1e-6).
 *
 * @param {object|null} trajectory  buildReferenceTrajectory output (has
 *   points/segments/totalLength) or null.
 * @returns {boolean}
 */
function isDegenerateTrajectory(trajectory) {
  if (trajectory == null) return true;
  if (!Array.isArray(trajectory.points)) return true;
  if (trajectory.points.length < 2) return true;
  const len = Number.isFinite(trajectory.totalLength) ? trajectory.totalLength : null;
  if (len == null) return true;
  return len <= 1e-6;
}

// --- folded / break segmentation --------------------------------------------

/**
 * Split collapsed bins into contiguous sub-runs separated by physical gaps
 * exceeding the threshold (gap break). A sub-run with fewer than
 * fitMinPointsPerRun bins is dropped from fitting (reported as gap fragments).
 */
function splitByGaps(bins, opts, isStationary) {
  const maxGap = isStationary ? opts.fitStationaryMaxGapM : opts.fitMaxGapM;
  const runs = [];
  let current = [];
  for (const b of bins) {
    if (!current.length) { current.push(b); continue; }
    const gap = dist2d(current[current.length - 1], b);
    if (gap > maxGap) {
      if (current.length >= opts.fitMinPointsPerRun) runs.push(current);
      current = [b];
    } else {
      current.push(b);
    }
  }
  if (current.length >= opts.fitMinPointsPerRun) runs.push(current);
  return runs;
}

// --- folds ------------------------------------------------------------------

/**
 * Deterministic frame-grouped fold assignment.
 * - moving: order frames by median along-track s; fold = rank mod K (preserves
 *   temporal + spatial coverage).
 * - stationary: frames observe near-identical forward ranges; fold =
 *   chronological frameIndex order mod K (no spatial stratification claim).
 * Every observation of one frame stays in one fold.
 */
function assignFolds(bins, opts, isStationary) {
  // collect frame -> member indices (observation level is bin level; a bin can
  // belong to several frames, so we assign the bin's evidence to each frame's
  // fold for held-out evaluation using per-frame sub-bins)
  const frameInfo = new Map();
  const frames = [];
  for (const b of bins) {
    for (const fid of b.frameIds || []) {
      if (!frameInfo.has(fid)) frameInfo.set(fid, { id: fid, bins: [], medianS: null, frameIndex: b.frameIndexMin });
      frameInfo.get(fid).bins.push(b);
    }
  }
  for (const [id, info] of frameInfo) frames.push(info);
  const distinctFrames = frames.length;
  const K = Math.max(1, Math.min(opts.fitFoldCountMax, distinctFrames));
  const foldOf = new Map();
  if (isStationary) {
    frames.sort((a, b) => a.frameIndex - b.frameIndex);
  } else {
    for (const info of frames) {
      const svals = info.bins.map((b) => b.s).filter((x) => x != null);
      info.medianS = svals.length ? median(svals) : null;
    }
    frames.sort((a, b) => (a.medianS ?? 0) - (b.medianS ?? 0));
  }
  frames.forEach((info, rank) => foldOf.set(info.id, rank % K));
  return { foldOf, K, distinctFrames, frames };
}

// --- topology ------------------------------------------------------------------

/** Self-intersection count of a polyline (segment pairs, non-adjacent). */
function selfIntersections(poly) {
  let count = 0;
  for (let i = 0; i + 2 < poly.length; i++) {
    for (let j = i + 2; j + 1 < poly.length; j++) {
      if (segmentsCross(poly[i], poly[i + 1], poly[j], poly[j + 1])) count++;
    }
  }
  return count;
}

/** Crossing count between two polylines. */
function polylineCrossings(a, b) {
  let count = 0;
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      if (segmentsCross(a[i], a[i + 1], b[j], b[j + 1])) count++;
    }
  }
  return count;
}

// --- main per-run fit -----------------------------------------------------------

/**
 * Fit one trusted fragment's raw run (Path 1). Gap-broken sub-runs are fit
 * independently so a fitted polyline never bridges a coverage gap.
 *
 * @param {object} runCtx
 *   @param {Array} rawRun        ordered raw observations (local east/north,
 *     s, d, weight, score, frameId, frameIndex, mirroredEast/North, chunkId,
 *     passId, groupTrackId, laneIndex, logMonoTime)
 *   @param {string} physicalBoundaryId
 *   @param {string} fragmentId
 *   @param {object} options
 * @returns {object} result record with status.
 */
function fitRun(runCtx, options = {}, cacheCtx = null) {
  const opts = { ...GRAPH_FIT_DEFAULTS, ...options };
  const rawRun = runCtx.rawRun || [];
  const physicalBoundaryId = runCtx.physicalBoundaryId;
  const fragmentId = runCtx.fragmentId;

  const base = {
    physicalBoundaryId,
    fragmentId,
    chunkId: runCtx.chunkId,
    passId: runCtx.passId,
    groupTrackId: runCtx.groupTrackId,
    laneIndex: runCtx.laneIndex,
    status: null,
    method: null,
    fallbackReason: null,
    deterministic: true,
  };

  // --- weights ------------------------------------------------------------------
  const finiteRun = rawRun.filter((p) => Number.isFinite(p.east) && Number.isFinite(p.north));
  if (finiteRun.length < opts.fitMinPointsPerRun) {
    return { ...base, status: 'insufficientSupport', reason: 'tooFewFinitePoints', nRaw: rawRun.length };
  }
  const withWeight = finiteRun.map((p) => {
    const score = Number.isFinite(p.score) ? p.score : 1;
    const support = Number.isFinite(p.supportFrameCount) ? p.supportFrameCount : 1;
    const gate = support >= opts.fitMinSupport ? 1 : opts.fitLowSupportWeight;
    const w = clamp(score * gate, 0, 1);
    return { ...p, weight: w, score };
  });

  // --- support checks -------------------------------------------------------------
  const distinctFrames = new Set(withWeight.map((p) => p.frameId).filter((x) => x != null)).size;
  const totalW = withWeight.reduce((a, p) => a + p.weight, 0);
  const order = auditOrder(withWeight);
  const nRaw = withWeight.length;
  if (nRaw < opts.fitMinPointsPerRun) {
    return { ...base, status: 'insufficientSupport', reason: 'tooFewPoints', nRaw };
  }
  if (distinctFrames < opts.fitMinTotalFrames) {
    return { ...base, status: 'insufficientSupport', reason: 'tooFewFrames', nRaw, distinctFrames };
  }
  if (!(totalW > 0) || !Number.isFinite(totalW)) {
    return { ...base, status: 'insufficientSupport', reason: 'zeroTotalWeight', nRaw, distinctFrames };
  }
  if (order.forwardExtentM < opts.fitMinSpanM && nRaw < opts.fitMinPointsPerRun * 2) {
    return { ...base, status: 'insufficientSupport', reason: 'belowMinSpan', nRaw, distinctFrames, forwardExtentM: order.forwardExtentM };
  }

  // --- ordering gate (Path 2 = folded/broken order) -------------------------------
  // Stationary classification: prefer the caller's explicit signal. When the
  // caller supplies a trajectory, classify it with the same degenerate-check
  // used by the segment-local map. Fall back to the pose-count heuristic only
  // when no trajectory signal is provided (e.g. direct fitRun tests).
  const isStationary = opts.fitTrajectory != null
    ? isDegenerateTrajectory(opts.fitTrajectory)
    : (opts.fitIsStationary != null
      ? !!opts.fitIsStationary
      : distinctPoseCount(withWeight) < opts.fitMinPosesForTravelFit);
  if (order.crossings > 0) {
    return { ...base, status: 'orderingInvalid', reason: 'crossing', nRaw, distinctFrames, order };
  }
  if (order.backtracks > 1 && order.sMonotonic < 0.6) {
    return { ...base, status: 'orderingInvalid', reason: 'backtrack', nRaw, distinctFrames, order };
  }
  if (order.maxStepM > opts.fitOrderingMaxStepM) {
    return { ...base, status: 'orderingInvalid', reason: 'brokenStep', nRaw, distinctFrames, order };
  }

  // --- collapse + gap-break --------------------------------------------------------
  const bins = collapseStationary(withWeight, opts);
  const runs = splitByGaps(bins, opts, isStationary);
  if (!runs.length) {
    return { ...base, status: 'insufficientSupport', reason: 'noFitSubRuns', nRaw, distinctFrames };
  }

  // --- fit each gap-broken sub-run independently ------------------------------------
  const segments = [];
  let sawValidationInsufficient = false;
  let sawQualityRejected = false;
  let sawTopologyRejected = false;
  let sawNumericalFailure = false;

  for (let s = 0; s < runs.length; s++) {
    const segBins = runs[s];
    const segRes = fitSegment(segBins, { ...opts, isStationary }, cacheCtx);
    if (!segRes) { sawNumericalFailure = true; continue; }
    segments.push(segRes);
    if (segRes.status === 'validationInsufficient') sawValidationInsufficient = true;
    if (segRes.status === 'qualityRejected') sawQualityRejected = true;
    if (segRes.status === 'topologyRejected') sawTopologyRejected = true;
    if (segRes.status === 'numericalFailure') sawNumericalFailure = true;
  }

  const acceptedSegments = segments.filter((s) => s.status === 'accepted');
  if (segments.length === 0) {
    return { ...base, status: 'numericalFailure', reason: 'fitFailed', nRaw, nBins: bins.length, distinctFrames };
  }
  if (!acceptedSegments.length) {
    // No segment accepted. Prefer a deterministic status ranking.
    let status = 'numericalFailure';
    let reason = 'noAcceptedSegment';
    if (segments.every((s) => s.status === 'insufficientSupport')) {
      status = 'insufficientSupport';
      reason = 'segmentsInsufficient';
    } else if (sawTopologyRejected) {
      status = 'topologyRejected';
      reason = 'topologyRejected';
    } else if (sawQualityRejected) {
      status = 'qualityRejected';
      reason = 'qualityRejected';
    } else if (sawValidationInsufficient) {
      status = 'validationInsufficient';
      reason = 'validationInsufficient';
    }
    return {
      ...base,
      status,
      reason,
      nRaw,
      nBins: bins.length,
      distinctFrames,
      segments,
      isStationary,
      order: {
        sMonotonic: order.sMonotonic,
        timeMonotonic: order.timeMonotonic,
        frameMonotonic: order.frameMonotonic,
        backtracks: order.backtracks,
        crossings: order.crossings,
        maxStepM: order.maxStepM,
      },
    };
  }

  // Some segments accepted: expose each accepted polyline; reject non-accepted ones.
  const accepted = acceptedSegments.map((s) => s.fittedPolyline).filter((p) => p && p.length);
  const trainingMedian = median(acceptedSegments.map((s) => s.trainingMedian).filter((x) => x != null)) ?? null;
  const trainingP95 = pct(acceptedSegments.map((s) => s.trainingP95).filter((x) => x != null), 0.95) ?? null;
  const heldOutMedian = median(acceptedSegments.map((s) => s.heldOut?.median).filter((x) => Number.isFinite(x))) ?? null;
  const heldOutP95 = pct(acceptedSegments.map((s) => s.heldOut?.p95).filter((x) => Number.isFinite(x)), 0.95) ?? null;
  const maxBridgedGap = Math.max(...acceptedSegments.map((s) => s.maxBridgedGap ?? 0));
  const selfX = acceptedSegments.reduce((a, s) => a + (s.selfX ?? 0), 0);
  const unsupported = acceptedSegments.reduce((a, s) => a + (s.unsupported ?? 0), 0);

  const sourceFragmentPoints = runCtx.sourceFragmentPoints || [];
  if (sourceFragmentPoints.length) {
    const corridorChecks = accepted.map((poly) => validateFitSourceCorridor(poly, sourceFragmentPoints, opts));
    const failedCorridor = corridorChecks.find((c) => !c.ok);
    if (failedCorridor) {
      return {
        ...base,
        status: 'coordinateFrameRejected',
        reason: failedCorridor.reason,
        coordinateFrame: SEGMENT_LOCAL_COORDINATE_FRAME,
        nRaw,
        nBins: bins.length,
        distinctFrames,
        fittedPolyline: accepted.length === 1 ? accepted[0] : accepted,
        sourceCorridor: failedCorridor,
        segments,
        isStationary,
        order: {
          sMonotonic: order.sMonotonic,
          timeMonotonic: order.timeMonotonic,
          frameMonotonic: order.frameMonotonic,
          backtracks: order.backtracks,
          crossings: order.crossings,
          maxStepM: order.maxStepM,
        },
      };
    }
  }

  return {
    ...base,
    status: 'accepted',
    coordinateFrame: SEGMENT_LOCAL_COORDINATE_FRAME,
    method: acceptedSegments[0].method,
    lambda: acceptedSegments[0].lambda,
    lambdaCutoffM: acceptedSegments[0].lambdaCutoffM,
    nRaw,
    nBins: bins.length,
    distinctFrames,
    trainingMedian,
    trainingP95,
    heldOut: { median: heldOutMedian, p95: heldOutP95, n: acceptedSegments.reduce((a, s) => a + (s.heldOut?.n ?? 0), 0), sufficient: !sawValidationInsufficient },
    maxBridgedGap,
    selfX,
    unsupported,
    fittedPolyline: accepted.length === 1 ? accepted[0] : accepted,
    fallbackReason: null,
    sourceCorridor: sourceFragmentPoints.length
      ? (() => {
        const checks = accepted.map((poly) => validateFitSourceCorridor(poly, sourceFragmentPoints, opts));
        return checks.find((c) => !c.ok) || checks[0];
      })()
      : null,
    selectedInteriorBreaks: acceptedSegments[0].interiorBreaks,
    selectedBasisCount: acceptedSegments[0].basisCount,
    isStationary,
    segments,
    order: {
      sMonotonic: order.sMonotonic,
      timeMonotonic: order.timeMonotonic,
      frameMonotonic: order.frameMonotonic,
      backtracks: order.backtracks,
      crossings: order.crossings,
      maxStepM: order.maxStepM,
    },
  };
}

/**
 * Fit one gap-broken contiguous sub-run. Returns a segment result or null on
 * numerical failure.
 */
function fitSegment(segBins, opts, cacheCtx = null) {
  const nB = segBins.length;
  if (nB < opts.fitMinPointsPerRun) {
    return { status: 'insufficientSupport', reason: 'tooFewPoints', nBins: nB };
  }
  const segFrames = new Set(segBins.flatMap((b) => b.frameIds || [])).size;
  if (segFrames < opts.fitMinTotalFrames) {
    return { status: 'insufficientSupport', reason: 'tooFewFrames', nBins: nB, distinctFrames: segFrames };
  }
  // parameterize by cumulative chord length over the sub-run
  const u = [];
  let acc = 0;
  for (let i = 0; i < nB; i++) {
    if (i) acc += dist2d(segBins[i - 1], segBins[i]);
    u.push(acc);
  }
  const Lsub = Math.max(1e-6, acc);
  if (Lsub < opts.fitMinSpanM) {
    return { status: 'insufficientSupport', reason: 'belowMinSpan', nBins: nB };
  }
  const ts = u.map((x) => x / Lsub);

  // lambda grid under the normalized objective: λ = (Λ_c / L)^4
  const lambdas = (opts.fitLambdaCutoffsM || []).map((lc) => Math.pow(lc / Lsub, 4));

  // frame-grouped folds for THIS sub-run
  const { foldOf, K } = assignFolds(segBins, opts, opts.isStationary);
  const foldBins = new Map();
  for (let f = 0; f < K; f++) foldBins.set(f, []);
  for (const b of segBins) {
    const fid = b.frameIds?.[0];
    const f = fid != null && foldOf.has(fid) ? foldOf.get(fid) : 0;
    foldBins.get(f).push(b);
  }

  const fitBins = (binsSubset, lambda) => {
    const subU = [];
    let subAcc = 0;
    for (let i = 0; i < binsSubset.length; i++) {
      if (i) subAcc += dist2d(binsSubset[i - 1], binsSubset[i]);
      subU.push(subAcc);
    }
    const subL = Math.max(1e-6, subAcc);
    const subTs = subU.map((x) => x / subL);
    const sB = binsSubset.length;
    const interiorBreaks = clamp(
      Math.round(subL / (opts.fitKnotSpacingM || 2)) - 1,
      1,
      Math.max(1, Math.min(opts.fitMaxBasis - (3 + 1), sB - (3 + 1) - 1)),
    );
    const basis = buildSplineBasis(interiorBreaks, 3);
    const ws = binsSubset.map((b) => b.weight);
    // Share the design matrix and penalty matrix between east and north: both
    // use identical t values and the same basis, so B and Ω are identical. The
    // IRLS robust weights can diverge between coordinates (different residuals),
    // so the factorization is NOT shared once weights differ — only B and Ω.
    const shared = { B: cachedDesignMatrix(subTs, basis, cacheCtx).B, Omega: cachedPenaltyMatrix(basis, cacheCtx) };
    const fe = fitCoordinate(subTs, binsSubset.map((b) => b.east), ws, lambda, basis, opts, shared, cacheCtx);
    const fn = fitCoordinate(subTs, binsSubset.map((b) => b.north), ws, lambda, basis, opts, shared, cacheCtx);
    const fme = fitCoordinate(subTs, binsSubset.map((b) => b.mirroredEast), ws, lambda, basis, opts, shared, cacheCtx);
    const fmn = fitCoordinate(subTs, binsSubset.map((b) => b.mirroredNorth), ws, lambda, basis, opts, shared, cacheCtx);
    if (fe.failed || fn.failed || fme.failed || fmn.failed) return null;
    return {
      basis, Lsub: subL, u: subU, ts: subTs, betaE: fe.beta, betaN: fn.beta,
      betaME: fme.beta, betaMN: fmn.beta,
      interiorBreaks: basis.interiorBreaks, basisCount: basis.basisCount,
      residualScale: Math.max(fe.residualScale || 0, fn.residualScale || 0),
    };
  };

  // Candidate-independent fold preparation (shared across every λ candidate):
  // the fold -> training-bin subset -> (B, Ω, ts, weights, basis) mapping is a
  // pure function of the fold, so it is computed once. Only the λ-scaled
  // penalty and the IRLS re-solve differ between candidates. Result-identical:
  // B/Ω/ts/weights are identical to what fitBins would build per call.
  const foldPrep = [];
  for (let f = 0; f < K; f++) {
    const trainBins = segBins.filter((b) => !(b.frameIds?.[0] != null && foldOf.has(b.frameIds[0]) && foldOf.get(b.frameIds[0]) === f));
    const held = foldBins.get(f) || [];
    const distinctTrain = new Set(trainBins.flatMap((b) => b.frameIds || [])).size;
    const subU = [];
    let subAcc = 0;
    for (let i = 0; i < trainBins.length; i++) {
      if (i) subAcc += dist2d(trainBins[i - 1], trainBins[i]);
      subU.push(subAcc);
    }
    const subL = Math.max(1e-6, subAcc);
    const subTs = subU.map((x) => x / subL);
    const sB = trainBins.length;
    const interiorBreaks = clamp(
      Math.round(subL / (opts.fitKnotSpacingM || 2)) - 1,
      1,
      Math.max(1, Math.min(opts.fitMaxBasis - (3 + 1), sB - (3 + 1) - 1)),
    );
    const basis = buildSplineBasis(interiorBreaks, 3);
    const ws = trainBins.map((b) => b.weight);
    foldPrep.push({
      f, held, distinctTrain,
      trainBins,
      subU, subL, subTs, basis, ws,
      shared: { B: cachedDesignMatrix(subTs, basis, cacheCtx).B, Omega: cachedPenaltyMatrix(basis, cacheCtx) },
    });
  }

  const fitPrepared = (prep, lambda) => {
    const fe = fitCoordinate(prep.subTs, prep.trainBins.map((b) => b.east), prep.ws, lambda, prep.basis, opts, prep.shared, cacheCtx);
    const fn = fitCoordinate(prep.subTs, prep.trainBins.map((b) => b.north), prep.ws, lambda, prep.basis, opts, prep.shared, cacheCtx);
    const fme = fitCoordinate(prep.subTs, prep.trainBins.map((b) => b.mirroredEast), prep.ws, lambda, prep.basis, opts, prep.shared, cacheCtx);
    const fmn = fitCoordinate(prep.subTs, prep.trainBins.map((b) => b.mirroredNorth), prep.ws, lambda, prep.basis, opts, prep.shared, cacheCtx);
    if (fe.failed || fn.failed || fme.failed || fmn.failed) return null;
    return {
      basis: prep.basis, Lsub: prep.subL, u: prep.subU, ts: prep.subTs,
      betaE: fe.beta, betaN: fn.beta, betaME: fme.beta, betaMN: fmn.beta,
      interiorBreaks: prep.basis.interiorBreaks, basisCount: prep.basis.basisCount,
      residualScale: Math.max(fe.residualScale || 0, fn.residualScale || 0),
    };
  };

  const evaluateHeldOut = (lambda) => {
    const errs = [];
    let sufficient = true;
    for (const prep of foldPrep) {
      if (prep.distinctTrain < opts.fitMinTrainingFrames && prep.trainBins.length > 0) sufficient = false;
      const model = fitPrepared(prep, lambda);
      if (!model) { sufficient = false; continue; }
      const poly = resamplePolyline(model, opts.fitOutputStepM);
      for (const b of prep.held) errs.push(pointToPolylineDist(b, poly));
    }
    return {
      median: errs.length ? (median(errs) ?? Infinity) : Infinity,
      p95: errs.length ? (pct(errs, 0.95) ?? Infinity) : Infinity,
      n: errs.length,
      sufficient,
    };
  };

  // lambda selection: largest cutoff (smoothest) within tolerance of best held-out
  let bestMed = Infinity;
  let bestP95 = Infinity;
  for (let i = 0; i < lambdas.length; i++) {
    const ev = evaluateHeldOut(lambdas[i]);
    if (ev.n === 0 || !Number.isFinite(ev.median)) continue;
    if (ev.median < bestMed) { bestMed = ev.median; bestP95 = ev.p95; }
  }
  let selectedIdx = -1;
  for (let i = lambdas.length - 1; i >= 0; i--) {
    const ev = evaluateHeldOut(lambdas[i]);
    if (ev.n === 0 || !Number.isFinite(ev.median)) continue;
    if (ev.median <= bestMed * (1 + opts.fitSelectMedianTol) && ev.p95 <= (bestP95 || Infinity) * (1 + opts.fitSelectP95Tol)) {
      selectedIdx = i;
      break;
    }
  }
  if (selectedIdx < 0) selectedIdx = Math.floor(lambdas.length / 2);
  const lambda = lambdas[selectedIdx];
  const lambdaCutoffM = opts.fitLambdaCutoffsM[selectedIdx];

  // validation sufficiency
  let validationSufficient = true;
  for (let f = 0; f < K; f++) {
    const trainBins = segBins.filter((b) => !(b.frameIds?.[0] != null && foldOf.has(b.frameIds[0]) && foldOf.get(b.frameIds[0]) === f));
    const distinctTrain = new Set(trainBins.flatMap((b) => b.frameIds || [])).size;
    if (distinctTrain < opts.fitMinTrainingFrames) validationSufficient = false;
  }
  const heldOut = evaluateHeldOut(lambda);

  // final fit on the sub-run
  const model = fitBins(segBins, lambda);
  if (!model) {
    return { status: 'numericalFailure', reason: 'fitFailed', nBins: nB };
  }
  const poly = resamplePolyline(model, opts.fitOutputStepM, SEGMENT_LOCAL_COORDINATE_FRAME);
  if (!poly.length || !poly.every((p) => Number.isFinite(p.east) && Number.isFinite(p.north))) {
    return { status: 'numericalFailure', reason: 'nonFiniteOutput', nBins: nB };
  }
  if (poly.some((p) => p.mirroredEast == null || p.mirroredNorth == null
    || !Number.isFinite(p.mirroredEast) || !Number.isFinite(p.mirroredNorth))) {
    return { status: 'coordinateFrameRejected', reason: 'missingMirroredOutput', nBins: nB };
  }

  const trainResiduals = segBins.map((b) => pointToPolylineDist(b, poly));
  const trainingMedian = median(trainResiduals) ?? Infinity;
  const trainingP95 = pct(trainResiduals, 0.95) ?? Infinity;
  const maxBridgedGap = maxConsecutiveGap(segBins);
  const selfX = selfIntersections(poly);
  const unsupported = unsupportedLengthM(segBins, poly, opts.isStationary ? opts.fitStationaryMaxGapM : opts.fitMaxGapM);
  // Rejected outliers: bins whose distance to the fitted curve exceeds the
  // robust scale bound (k * residualScale). Only reported; never fed to
  // polygons and never removed from the raw point layer.
  const rejectedOutliers = [];
  if (model.residualScale != null && model.residualScale > 1e-9) {
    const bound = opts.fitTukeyK * model.residualScale;
    for (let i = 0; i < segBins.length; i++) {
      if (trainResiduals[i] > bound) {
        rejectedOutliers.push({
          east: segBins[i].east,
          north: segBins[i].north,
          mirroredEast: segBins[i].mirroredEast,
          mirroredNorth: segBins[i].mirroredNorth,
          s: segBins[i].s,
          d: segBins[i].d,
          residualM: +trainResiduals[i].toFixed(3),
          frameIds: segBins[i].frameIds || [],
        });
      }
    }
  }

  const common = {
    nRaw: nB, nBins: nB, method: opts.fitMethod, lambda, lambdaCutoffM,
    trainingMedian, trainingP95, heldOut, maxBridgedGap, selfX, unsupported,
    fittedPolyline: poly, fallbackReason: null,
    interiorBreaks: model.interiorBreaks, basisCount: model.basisCount,
    rejectedOutliers,
    // Gap-break marker positions (where consecutive collapsed bins exceed the
    // gap threshold within this accepted sub-run, or where it was split). Only
    // diagnostic; never alters geometry.
    gapMarkers: (segBins.length >= 2 ? segBins.slice(1).map((b, i) => {
      const prev = segBins[i];
      const gap = dist2d(prev, b);
      if (gap > (opts.isStationary ? opts.fitStationaryMaxGapM : opts.fitMaxGapM)) {
        return { east: (prev.east + b.east) / 2, north: (prev.north + b.north) / 2, mirroredEast: (prev.mirroredEast + b.mirroredEast) / 2, mirroredNorth: (prev.mirroredNorth + b.mirroredNorth) / 2, gapM: +gap.toFixed(2) };
      }
      return null;
    }).filter(Boolean) : []),
  };
  if (selfX > 0) return { status: 'topologyRejected', reason: 'selfIntersection', ...common };
  if (unsupported > opts.fitMaxGapM) return { status: 'topologyRejected', reason: 'unsupportedSpan', ...common };
  if (!validationSufficient || !heldOut.sufficient) {
    return { status: 'validationInsufficient', reason: 'foldInsufficient', ...common };
  }
  if (heldOut.median > opts.fitMaxHeldOutMedianM || heldOut.p95 > opts.fitMaxHeldOutP95M) {
    return { status: 'qualityRejected', reason: 'heldOutError', ...common };
  }
  return { status: 'accepted', reason: null, ...common };
}

/** Resample fitted spline to uniform u steps. Spline is clamped to [0,1] so no
 * extrapolation occurs; the polyline spans the full observed u range. When
 * mirrored betas are present, mirroredEast/mirroredNorth are emitted in the
 * same segment-local frame as east/north. */
function resamplePolyline(model, stepM, coordinateFrame = SEGMENT_LOCAL_COORDINATE_FRAME) {
  const { basis, Lsub, u, betaE, betaN, betaME, betaMN } = model;
  const uMax = u.length ? u[u.length - 1] : 0;
  if (uMax <= 0 || basis.basisCount < 1) return [];
  const out = [];
  const nSteps = Math.max(1, Math.ceil(uMax / (stepM || 0.5)));
  const hasMirror = Array.isArray(betaME) && Array.isArray(betaMN)
    && betaME.length === basis.basisCount && betaMN.length === basis.basisCount;
  for (let k = 0; k <= nSteps; k++) {
    const uu = (uMax * k) / nSteps;
    const t = clamp(uu / Lsub, 0, 1);
    const row = evalBasisAll(t, basis);
    let e = 0;
    let n = 0;
    let me = null;
    let mn = null;
    for (let j = 0; j < basis.basisCount; j++) {
      e += row[j].v * betaE[j];
      n += row[j].v * betaN[j];
      if (hasMirror) {
        me = (me ?? 0) + row[j].v * betaME[j];
        mn = (mn ?? 0) + row[j].v * betaMN[j];
      }
    }
    const vtx = {
      east: e,
      north: n,
      coordinateFrame,
      u: uu,
      t,
    };
    if (hasMirror && Number.isFinite(me) && Number.isFinite(mn)) {
      vtx.mirroredEast = me;
      vtx.mirroredNorth = mn;
    }
    out.push(vtx);
  }
  return out;
}

/**
 * Validate that a fitted polyline lies on its own source fragment in the same
 * coordinate frame. Rejects global coordinates consumed as segment-local.
 */
function validateFitSourceCorridor(fittedPolyline, sourcePoints, opts = {}) {
  const maxCorridorM = opts.fitMaxSourceCorridorM ?? GRAPH_FIT_DEFAULTS.fitMaxSourceCorridorM;
  if (!fittedPolyline?.length || !sourcePoints?.length) {
    return { ok: false, reason: 'missingSourceGeometry', maxDistM: Infinity, maxEndpointM: Infinity };
  }
  let maxDistM = 0;
  for (const p of fittedPolyline) {
    maxDistM = Math.max(maxDistM, pointToPolylineDist(p, sourcePoints));
  }
  const ep0 = Math.hypot(
    fittedPolyline[0].east - sourcePoints[0].east,
    fittedPolyline[0].north - sourcePoints[0].north,
  );
  const ep1 = Math.hypot(
    fittedPolyline[fittedPolyline.length - 1].east - sourcePoints[sourcePoints.length - 1].east,
    fittedPolyline[fittedPolyline.length - 1].north - sourcePoints[sourcePoints.length - 1].north,
  );
  const maxEndpointM = Math.max(ep0, ep1);
  const srcExtents = sourcePoints.reduce((acc, p) => ({
    maxAbsE: Math.max(acc.maxAbsE, Math.abs(p.east ?? 0)),
    maxAbsN: Math.max(acc.maxAbsN, Math.abs(p.north ?? 0)),
  }), { maxAbsE: 0, maxAbsN: 0 });
  const fitExtents = fittedPolyline.reduce((acc, p) => ({
    maxAbsE: Math.max(acc.maxAbsE, Math.abs(p.east ?? 0)),
    maxAbsN: Math.max(acc.maxAbsN, Math.abs(p.north ?? 0)),
  }), { maxAbsE: 0, maxAbsN: 0 });
  const globalAsLocal = (
    (fitExtents.maxAbsE > Math.max(1e4, srcExtents.maxAbsE * 50))
    || (fitExtents.maxAbsN > Math.max(1e4, srcExtents.maxAbsN * 50))
  ) && srcExtents.maxAbsE < 5000 && srcExtents.maxAbsN < 5000;
  if (globalAsLocal) {
    return { ok: false, reason: 'globalConsumedAsLocal', maxDistM, maxEndpointM, globalAsLocal: true };
  }
  if (maxDistM > maxCorridorM || maxEndpointM > maxCorridorM) {
    return { ok: false, reason: 'sourceCorridorExceeded', maxDistM, maxEndpointM, maxCorridorM };
  }
  for (const p of fittedPolyline) {
    if (p.coordinateFrame && p.coordinateFrame !== SEGMENT_LOCAL_COORDINATE_FRAME) {
      return { ok: false, reason: 'unknownCoordinateFrame', maxDistM, maxEndpointM };
    }
  }
  return { ok: true, reason: null, maxDistM, maxEndpointM, maxCorridorM };
}

/** Distance from point p to polyline (segment-local). */
function pointToPolylineDist(p, poly) {
  if (!poly.length) return Infinity;
  let best = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i];
    const b = poly[i + 1];
    const de = b.east - a.east;
    const dn = b.north - a.north;
    const len2 = de * de + dn * dn;
    let t = len2 > 1e-12 ? ((p.east - a.east) * de + (p.north - a.north) * dn) / len2 : 0;
    t = clamp(t, 0, 1);
    const pe = a.east + t * de;
    const pn = a.north + t * dn;
    best = Math.min(best, Math.hypot(p.east - pe, p.north - pn));
  }
  return best;
}

/** Max consecutive gap among bins (chord). */
function maxConsecutiveGap(bins) {
  let mx = 0;
  for (let i = 1; i < bins.length; i++) mx = Math.max(mx, dist2d(bins[i - 1], bins[i]));
  return mx;
}

/** Length of fitted polyline whose nearest bin is farther than maxGap. */
function unsupportedLengthM(bins, poly, maxGap) {
  let unsupported = 0;
  for (let i = 1; i < poly.length; i++) {
    const mid = { east: (poly[i - 1].east + poly[i].east) / 2, north: (poly[i - 1].north + poly[i].north) / 2 };
    const nearest = Math.min(...bins.map((b) => dist2d(b, mid)));
    if (nearest > maxGap) unsupported += dist2d(poly[i - 1], poly[i]);
  }
  return unsupported;
}

// --- module API ------------------------------------------------------------------

/**
 * Fit all fragments of one build. rawRuns[i] corresponds to fragments[i].
 * Approach A: raw runs are passed in the same build operation and are NOT
 * stored on fragments or in the public map.
 *
 * @returns {{ results, acceptedCount, statusCounts, stats }}
 */
function fitConstructedRuns(fragments, rawRuns, options = {}) {
  const opts = { ...GRAPH_FIT_DEFAULTS, ...options };
  // Per-build cache scope: a fresh cache context for every complete-map fit
  // invocation. Dropped when this function returns; never accumulates across
  // segments or browser navigation.
  const cacheCtx = createFitCaches();
  const results = [];
  const statusCounts = {};
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  for (let i = 0; i < fragments.length; i++) {
    const frag = fragments[i];
    const rawRun = rawRuns[i] || [];
    if (!rawRun.length) continue;
    const physicalBoundaryId = `${frag.chunkId}:${frag.passId}:${frag.groupTrackId}:${frag.laneIndex}`;
    const runObs = rawRun.map((p) => ({
      east: p.localEast != null ? p.localEast : p.east,
      north: p.localNorth != null ? p.localNorth : p.north,
      mirroredEast: p.mirroredLocalEast != null ? p.mirroredLocalEast : p.mirroredEast,
      mirroredNorth: p.mirroredLocalNorth != null ? p.mirroredLocalNorth : p.mirroredNorth,
      s: p.s,
      d: p.d,
      frameId: p.frameId,
      frameIndex: p.frameIndex,
      logMonoTime: p.logMonoTime,
      score: p.reliability?.combinedScore ?? p.score ?? 1,
      supportFrameCount: p.supportFrameCount ?? 1,
      chunkId: frag.chunkId,
      passId: frag.passId,
      groupTrackId: frag.groupTrackId,
      laneIndex: frag.laneIndex,
    }));
    const res = fitRun({
      rawRun: runObs,
      physicalBoundaryId,
      fragmentId: frag.fragmentId,
      chunkId: frag.chunkId,
      passId: frag.passId,
      groupTrackId: frag.groupTrackId,
      laneIndex: frag.laneIndex,
      sourceFragmentPoints: frag.points || [],
      coordinateFrame: SEGMENT_LOCAL_COORDINATE_FRAME,
    }, opts, cacheCtx);
    statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
    results.push(res);
  }
  const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  const cacheStats = getGraphFitCacheStatsFromContext(cacheCtx);
  return {
    results,
    acceptedCount: statusCounts.accepted || 0,
    statusCounts,
    stats: { elapsedMs, runs: results.length, fitEnabled: !!opts.fitEnabled, cache: cacheStats },
  };
}

/** Cross-identity boundary-crossing check over accepted fits. */
function checkBoundaryCrossings(results) {
  const accepted = results.filter((r) => r.status === 'accepted' && r.fittedPolyline);
  let violations = 0;
  for (let i = 0; i < accepted.length; i++) {
    for (let j = i + 1; j < accepted.length; j++) {
      const a = accepted[i];
      const b = accepted[j];
      if (a.chunkId !== b.chunkId || a.passId !== b.passId) continue;
      const cross = polylineCrossings(a.fittedPolyline, b.fittedPolyline);
      if (cross > 0) {
        violations += cross;
        // downgrade both to topologyRejected
        a.status = 'topologyRejected';
        a.reason = 'boundaryCrossing';
        b.status = 'topologyRejected';
        b.reason = 'boundaryCrossing';
      }
    }
  }
  return violations;
}

function estimateMatrixBytes(matrix) {
  if (!matrix) return 0;
  if (Array.isArray(matrix)) {
    if (!matrix.length) return 0;
    if (Array.isArray(matrix[0])) return matrix.length * matrix[0].length * 8;
    return matrix.length * 8;
  }
  if (matrix.B) return estimateMatrixBytes(matrix.B);
  return 0;
}

function polylineLengthM(poly) {
  if (!poly?.length) return 0;
  let len = 0;
  for (let i = 1; i < poly.length; i++) {
    len += Math.hypot(poly[i].east - poly[i - 1].east, poly[i].north - poly[i - 1].north);
  }
  return len;
}

/** Normalize fittedPolyline to an array of vertex arrays (never bridges gaps). */
function normalizeFitPolylines(fittedPolyline) {
  if (!fittedPolyline) return [];
  if (!Array.isArray(fittedPolyline)) return [];
  if (!fittedPolyline.length) return [];
  if (typeof fittedPolyline[0]?.east === 'number') return [fittedPolyline];
  if (Array.isArray(fittedPolyline[0])) {
    return fittedPolyline.filter((p) => Array.isArray(p) && p.length);
  }
  return [fittedPolyline];
}

function fragmentVerticesToPolyline(points) {
  return (points || []).map((v) => ({
    east: v.east,
    north: v.north,
    mirroredEast: v.mirroredEast,
    mirroredNorth: v.mirroredNorth,
    coordinateFrame: SEGMENT_LOCAL_COORDINATE_FRAME,
  })).filter((v) => Number.isFinite(v.east) && Number.isFinite(v.north));
}

function collectFitGapMarkers(fitResult) {
  const out = [];
  for (const seg of fitResult?.segments || []) {
    for (const mk of seg.gapMarkers || []) {
      if (mk) out.push(mk);
    }
  }
  return out;
}

/**
 * Build a per-fragment hybrid lane-boundary display map: accepted graph fits
 * for accepted fragments, constructed-fragment geometry for all others.
 * Never joins separate fragments; gaps between fitted sub-runs remain gaps.
 *
 * @param {Array} fragments constructed fragment records
 * @param {{ results?: Array }} fittedPolylines output of fitConstructedRuns
 * @returns {{ boundaries: Array, stats: object }}
 */
function buildHybridFittedBoundaries(fragments, fittedPolylines) {
  const fitById = new Map();
  for (const r of fittedPolylines?.results || []) {
    if (r?.fragmentId) fitById.set(r.fragmentId, r);
  }

  const boundaries = [];
  let fittedFragments = 0;
  let fallbackFragments = 0;
  let fittedLengthM = 0;
  let fallbackLengthM = 0;

  for (const frag of fragments || []) {
    const fit = fitById.get(frag.fragmentId);
    const physicalBoundaryId = `${frag.chunkId}:${frag.passId}:${frag.groupTrackId}:${frag.laneIndex}`;
    const accepted = fit?.status === 'accepted' && fit.fittedPolyline;

    let displaySource;
    let polylines;
    let fitStatus;
    let rejectionReason;
    let gapMarkers = [];

    if (accepted) {
      displaySource = 'acceptedFit';
      polylines = normalizeFitPolylines(fit.fittedPolyline);
      fitStatus = 'accepted';
      rejectionReason = null;
      gapMarkers = collectFitGapMarkers(fit);
      fittedFragments += 1;
      for (const poly of polylines) fittedLengthM += polylineLengthM(poly);
    } else {
      displaySource = 'fragmentFallback';
      polylines = [fragmentVerticesToPolyline(frag.points)];
      fitStatus = fit?.status || 'notFitted';
      rejectionReason = fit?.reason || (fit ? fit.status : 'noFitAttempt');
      fallbackFragments += 1;
      for (const poly of polylines) fallbackLengthM += polylineLengthM(poly);
    }

    boundaries.push({
      fragmentId: frag.fragmentId,
      physicalBoundaryId,
      groupTrackId: frag.groupTrackId,
      laneIndex: frag.laneIndex,
      side: frag.side ?? null,
      chunkId: frag.chunkId,
      passId: frag.passId,
      fitStatus,
      displaySource,
      rejectionReason,
      coordinateFrame: SEGMENT_LOCAL_COORDINATE_FRAME,
      polylines,
      mirroredPolylines: polylines,
      gapMarkers,
      metrics: accepted ? {
        trainingMedian: fit.trainingMedian,
        trainingP95: fit.trainingP95,
        heldOutMedian: fit.heldOut?.median ?? null,
        heldOutP95: fit.heldOut?.p95 ?? null,
        sourceCorridorMaxM: fit.sourceCorridor?.maxDistM ?? null,
      } : {
        fragmentLengthM: frag.lengthM ?? null,
        medianResidualM: frag.medianResidualM ?? null,
        splitReason: frag.splitReason ?? null,
      },
    });
  }

  return {
    boundaries,
    stats: {
      totalFragments: fragments?.length || 0,
      fittedFragments,
      fallbackFragments,
      fittedLengthM: +fittedLengthM.toFixed(2),
      fallbackLengthM: +fallbackLengthM.toFixed(2),
      totalDisplayedLengthM: +(fittedLengthM + fallbackLengthM).toFixed(2),
    },
  };
}

/** Read cache occupancy for a per-build cache context (not module-global). */
function getGraphFitCacheStatsFromContext(cacheCtx) {
  if (!cacheCtx) {
    return { omegaEntries: 0, designEntries: 0, omegaBuilds: 0, designBuilds: 0, estimatedBytes: 0 };
  }
  let bytes = 0;
  for (const o of cacheCtx.omega?.values() || []) bytes += estimateMatrixBytes(o);
  for (const d of cacheCtx.design?.values() || []) bytes += estimateMatrixBytes(d);
  return {
    omegaEntries: cacheCtx.omega?.size ?? 0,
    designEntries: cacheCtx.design?.size ?? 0,
    omegaBuilds: cacheCtx.omegaBuilds ?? 0,
    designBuilds: cacheCtx.designBuilds ?? 0,
    estimatedBytes: bytes,
  };
}

module.exports = {
  GRAPH_FIT_DEFAULTS,
  isDegenerateTrajectory,
  createFitCaches,
  cachedPenaltyMatrix,
  cachedDesignMatrix,
  // Per-build caches are created inside fitConstructedRuns and dropped when it
  // returns, so there is no module-level state to clear. These helpers remain
  // for tests that exercise the cache API with an explicit context.
  clearGraphFitCaches: () => {},
  getGraphFitCacheStats: () => ({ omegaEntries: 0, designEntries: 0, omegaBuilds: 0, designBuilds: 0, estimatedBytes: 0 }),
  getGraphFitCacheStatsFromContext,
  median,
  pct,
  auditOrder,
  distinctPoseCount,
  collapseStationary,
  buildSplineBasis,
  evalBasisAll,
  evalRow,
  buildDesignMatrix,
  buildPenaltyMatrix,
  solveSymmetric,
  fitCoordinate,
  assignFolds,
  splitByGaps,
  selfIntersections,
  polylineCrossings,
  fitRun,
  fitConstructedRuns,
  buildHybridFittedBoundaries,
  normalizeFitPolylines,
  checkBoundaryCrossings,
  resamplePolyline,
  pointToPolylineDist,
  validateFitSourceCorridor,
  SEGMENT_LOCAL_COORDINATE_FRAME,
};
if (typeof window !== 'undefined') {
  window.GraphFit = module.exports;
}
