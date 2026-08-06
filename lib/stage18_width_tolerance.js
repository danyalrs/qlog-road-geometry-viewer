/**
 * Stage 18 — signed-width comparison tolerance policy.
 *
 * Signed-width convention: widthM = leftRouteD - rightRouteD where left is the boundary
 * with higher mean route-d (left-to-right, route-d increases toward the left).
 * Absolute width is never used to hide ordering failures.
 */
const WIDTH_COMPARISON_EPS_M = 1e-3;
const WIDTH_POSITIVE_EPS_M = 1e-9;

const WIDTH_TOLERANCE_DOCS = {
  widthComparisonToleranceM: {
    value: WIDTH_COMPARISON_EPS_M,
    units: 'metres',
    purpose: 'Floating-point slack for prototype band and threshold comparisons only',
  },
  widthPositiveToleranceM: {
    value: WIDTH_POSITIVE_EPS_M,
    units: 'metres',
    purpose: 'Strict floor for signed positivity; must not legitimise genuinely non-positive widths',
  },
  comparisonsUsingComparisonTolerance: [
    'narrowWidthThresholdM gate (stats.min vs threshold)',
    'wideWidthThresholdM gate (stats.max vs threshold)',
    'minPrototypeWidthM / maxPrototypeWidthM classification bands',
    'WIDTH_ASSESSMENT_BANDS bucket assignment',
  ],
  comparisonsUsingPositiveTolerance: [
    'nonPositiveCount and accepted-interval positivity invariants',
    'per-sample width validity before interval acceptance',
  ],
  nearZeroTreatment: 'Widths with value <= WIDTH_POSITIVE_EPS_M are non-positive. Widths in (WIDTH_POSITIVE_EPS_M, WIDTH_COMPARISON_EPS_M] remain positive but may still fail narrow prototype gates.',
  thresholdExamples: {
    '1.9999999999999998': 'Treat as >= 2.0 m for narrow/minPrototype gates (within comparison tolerance)',
    '2.0': 'Exactly on prototype lower bound',
    '2.0000000000000004': 'Treat as >= 2.0 m for narrow/minPrototype gates',
    '5.499999999999999': 'Treat as <= 5.5 m for wide/maxPrototype gates',
    '5.5': 'Exactly on prototype upper bound',
    '5.500000000000001': 'Treat as <= 5.5 m for wide/maxPrototype gates',
  },
  nanAndInfiniteTreatment: 'NaN and ±Infinity widths are invalid samples; they increment nonPositiveCount and invalidate finiteSampleRate.',
  signedWidthConvention: 'leftRouteD - rightRouteD with left assigned as the higher mean-d boundary within the pair',
};

function isFiniteWidth(w) {
  return Number.isFinite(w);
}

function isPositiveSignedWidth(w) {
  return Number.isFinite(w) && w > WIDTH_POSITIVE_EPS_M;
}

function isNonPositiveSignedWidth(w) {
  return !Number.isFinite(w) || w <= WIDTH_POSITIVE_EPS_M;
}

function widthBelowThreshold(w, thresholdM) {
  return !Number.isFinite(w) || w + WIDTH_COMPARISON_EPS_M < thresholdM;
}

function widthAboveThreshold(w, thresholdM) {
  return Number.isFinite(w) && w - WIDTH_COMPARISON_EPS_M > thresholdM;
}

function widthWithinBand(w, minM, maxM) {
  return Number.isFinite(w)
    && !widthBelowThreshold(w, minM)
    && (maxM === Infinity || !widthAboveThreshold(w, maxM));
}

function assignWidthBand(widthM, bands) {
  if (!Number.isFinite(widthM)) return null;
  for (const b of bands) {
    if (widthWithinBand(widthM, b.min, b.max)) return b.label;
  }
  return null;
}

module.exports = {
  WIDTH_COMPARISON_EPS_M,
  WIDTH_POSITIVE_EPS_M,
  WIDTH_TOLERANCE_DOCS,
  isFiniteWidth,
  isPositiveSignedWidth,
  isNonPositiveSignedWidth,
  widthBelowThreshold,
  widthAboveThreshold,
  widthWithinBand,
  assignWidthBand,
};
