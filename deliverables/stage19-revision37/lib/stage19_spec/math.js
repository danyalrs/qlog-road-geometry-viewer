'use strict';

function normalQuantile(p) {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [
    -3.969683028665376e+01, 2.209460984245205e+02,
    -2.759285084469024e+02, 1.383577518672690e+02,
    -3.066479806614716e+01, 2.506628277459239e+00,
  ];
  const b = [
    -5.447609879822406e+01, 1.615858368580409e+02,
    -1.556989798598866e+02, 6.680131188771972e+01,
    -1.328068155288572e+01,
  ];
  const c = [
    -7.784894002430293e-03, -3.223964580411365e-01,
    -2.400758277161838e+00, -2.549732539343734e+00,
    4.374664141464968e+00, 2.938163982698783e+00,
  ];
  const d = [
    7.784695709041462e-03, 3.224671290700398e-01,
    2.445134137142996e+00, 3.754408661907416e+00,
  ];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function symmetrize(matrix) {
  const n = matrix.length;
  const out = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) out[i][j] = (matrix[i][j] + matrix[j][i]) / 2;
  }
  return out;
}

function eigenvaluesSymmetric(matrix, maxIter = 100, tol = 1e-12) {
  const n = matrix.length;
  const a = matrix.map((row) => row.slice());
  const vals = Array(n).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    let p = 0;
    let q = 1;
    let max = Math.abs(a[p][q]);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const v = Math.abs(a[i][j]);
        if (v > max) {
          max = v;
          p = i;
          q = j;
        }
      }
    }
    if (max < tol) break;
    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    a[p][q] = 0;
    a[q][p] = 0;
    for (let i = 0; i < n; i++) {
      if (i === p || i === q) continue;
      const aip = a[i][p];
      const aiq = a[i][q];
      a[i][p] = c * aip - s * aiq;
      a[p][i] = a[i][p];
      a[i][q] = s * aip + c * aiq;
      a[q][i] = a[i][q];
    }
  }
  for (let i = 0; i < n; i++) vals[i] = a[i][i];
  return { ok: vals.every(Number.isFinite), values: vals };
}

function eigenvalues(matrix) {
  return eigenvaluesSymmetric(symmetrize(matrix));
}

function quadraticForm(matrix, coeffs) {
  let v = 0;
  const n = matrix.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) v += coeffs[i] * matrix[i][j] * coeffs[j];
  }
  return v;
}

function referenceEigenvaluesQR(matrix, maxIter = 200, tol = 1e-12) {
  const n = matrix.length;
  let a = matrix.map((row) => row.slice());
  for (let iter = 0; iter < maxIter; iter++) {
    let off = 0;
    for (let i = 0; i < n - 1; i++) off += Math.abs(a[i + 1][i]);
    if (off < tol) break;
    for (let p = 0; p < n - 1; p++) {
      let q = p;
      let s = 0;
      for (let i = p; i < n - 1; i++) {
        s += Math.abs(a[i + 1][i]);
        if (s < tol) continue;
        const scale = Math.abs(a[i][i]) + Math.abs(a[i + 1][i + 1]);
        if (scale === 0) continue;
        let h = a[i + 1][i] / scale;
        let g = a[i][i] / scale;
        let f = Math.sqrt((g * g + h * h));
        if (g >= 0) f = -f;
        a[i + 1][i] = scale * f;
        const x = h / f;
        const y = g / f;
        for (let j = i; j < n; j++) {
          g = a[i][j] + y * a[i + 1][j];
          a[i + 1][j] -= x * g;
          a[i][j] += g;
        }
        for (let k = 0; k <= i + 1; k++) {
          g = a[k][i] + x * a[k][i + 1];
          a[k][i + 1] -= y * g;
          a[k][i] += g;
        }
      }
    }
  }
  const vals = Array.from({ length: n }, (_, i) => a[i][i]);
  vals.sort((u, v) => v - u);
  return { ok: vals.every((v) => Number.isFinite(v)), values: vals };
}

function eigenvaluesMatchReference(matrix, relTol = 1e-9) {
  const primary = eigenvalues(matrix);
  const reference = referenceEigenvaluesQR(symmetrize(matrix));
  if (!primary.ok || !reference.ok) return { pass: false, primary, reference };
  const sorted = primary.values.slice().sort((a, b) => b - a);
  const pass = sorted.every((v, i) => Math.abs(v - reference.values[i]) <= relTol * Math.max(1, Math.abs(reference.values[i])));
  return { pass, primary: sorted, reference: reference.values };
}

function runCovarianceMatrixFixtures() {
  const { config } = require('./config');
  const { validateCovariance } = require('./uncertainty');
  const meta = { unitFloor: 1e-12 };
  const I4 = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const neg = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, -0.5],
  ];
  const singular = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const repeated = [
    [2, 0, 0, 0],
    [0, 2, 0, 0],
    [0, 0, 2, 0],
    [0, 0, 0, 2],
  ];
  const asym = [
    [1, 1e-10, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const nonSym = [
    [1, 0.2, 0, 0],
    [0.1, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const nanM = [[NaN, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const infM = [[Infinity, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];

  const cases = [
    { name: 'identity-psd', matrix: I4, expect: true },
    { name: 'negative-eigen', matrix: neg, expect: false },
    { name: 'singular-psd', matrix: singular, expect: true },
    { name: 'repeated-eigen', matrix: repeated, expect: true },
    { name: 'near-symmetric', matrix: asym, expect: true },
    { name: 'non-symmetric-reject', matrix: nonSym, expect: false },
    { name: 'nan-reject', matrix: nanM, expect: false },
    { name: 'infinity-reject', matrix: infM, expect: false },
  ];
  const results = cases.map((c) => ({
    name: c.name,
    pass: validateCovariance(c.matrix, meta) === c.expect,
  }));
  const eigs = eigenvalues(I4);
  results.push({ name: 'eigenvalues-identity', pass: eigs.ok && eigs.values.every((v) => Math.abs(v - 1) < 1e-9) });
  const refCompare = eigenvaluesMatchReference(repeated);
  results.push({ name: 'reference-eigenvalues-repeated', pass: refCompare.pass });
  const refNeg = eigenvaluesMatchReference(neg);
  results.push({ name: 'reference-eigenvalues-negative', pass: refNeg.pass && refNeg.primary.some((v) => v < 0) });
  return { allPass: results.every((r) => r.pass), results, configUsed: { symmetryRelTol: config.symmetryRelTol, eigenRelTol: config.eigenRelTol } };
}

module.exports = {
  normalQuantile,
  symmetrize,
  eigenvalues,
  eigenvaluesSymmetric,
  referenceEigenvaluesQR,
  eigenvaluesMatchReference,
  quadraticForm,
  runCovarianceMatrixFixtures,
};
