'use strict';

const { config } = require('./config');
const { normalQuantile, symmetrize, eigenvalues, quadraticForm } = require('./math');

function convertConfidenceScalar(f) {
  const p = f.confidenceLevel;
  if (!(p > 0 && p < 1)) return { ok: false };
  const z = normalQuantile((1 + p) / 2);
  if (!Number.isFinite(z) || z <= 0) return { ok: false };
  const sigma = f.halfWidth / z;
  if (!Number.isFinite(sigma) || sigma < 0) return { ok: false };
  return { ok: true, value: sigma };
}

function validateCovariance(matrix, meta) {
  const n = matrix.length;
  if (n !== 4 && n !== 5) return false;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (!Number.isFinite(matrix[i][j])) return false;
    }
  }
  let maxAbs = 0;
  let maxAsym = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      maxAbs = Math.max(maxAbs, Math.abs(matrix[i][j]));
      maxAsym = Math.max(maxAsym, Math.abs(matrix[i][j] - matrix[j][i]));
    }
  }
  const unitScale = Math.max(meta.unitFloor || 1e-12, maxAbs);
  if (maxAsym > config.symmetryRelTol * unitScale) return false;
  const sym = symmetrize(matrix);
  const eigs = eigenvalues(sym);
  if (!eigs.ok) return false;
  const spectralScale = Math.max(meta.unitFloor || 1e-12, Math.max(...eigs.values.map(Math.abs)));
  if (Math.min(...eigs.values) < -config.eigenRelTol * spectralScale) return false;
  return true;
}

function applyBranchSelection(fields, meta) {
  const converted = [];
  for (const f of fields.requiredScalars) {
    const c = convertConfidenceScalar(f);
    if (!c.ok) return { ok: false, reason: 'confidence' };
    converted.push(c.value);
  }
  if (meta.covarianceMatrixAvailable && validateCovariance(meta.covarianceMatrix, meta)) {
    const v = quadraticForm(meta.covarianceMatrix, meta.coefficientVector);
    if (!Number.isFinite(v) || v < 0) return { ok: false, reason: 'covariance' };
    return { ok: true, value: Math.sqrt(v) };
  }
  if (meta.uncertaintyInterpretation === 'one_sigma' && meta.documentedIndependent) {
    const rss = Math.sqrt(converted.reduce((s, x) => s + x * x, 0));
    return { ok: true, value: rss };
  }
  if (meta.uncertaintyInterpretation === 'one_sigma') {
    return { ok: true, value: converted.reduce((s, x) => s + x, 0) };
  }
  if (meta.uncertaintyInterpretation === 'bound') {
    return { ok: true, value: converted.reduce((s, x) => s + x, 0) };
  }
  return { ok: false, reason: 'interpretation' };
}

module.exports = {
  convertConfidenceScalar,
  validateCovariance,
  applyBranchSelection,
};
