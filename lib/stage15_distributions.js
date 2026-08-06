/**
 * Empirical distribution helpers for Stage 15 threshold policy (read-only).
 */

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarizeNumeric(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) {
    return { count: 0, min: null, max: null, mean: null, median: null, p10: null, p25: null, p75: null, p90: null, p95: null };
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    median: percentile(sorted, 0.5),
    p10: percentile(sorted, 0.1),
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
  };
}

function buildHistogram(values, bins) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length || !bins.length) return { bins: [], counts: [], total: 0 };
  const counts = new Array(bins.length).fill(0);
  for (const v of finite) {
    let placed = false;
    for (let i = 0; i < bins.length; i++) {
      const b = bins[i];
      const inBin = i === bins.length - 1
        ? v >= b.min && v <= b.max
        : v >= b.min && v < b.max;
      if (inBin) { counts[i]++; placed = true; break; }
    }
    if (!placed && finite.length) counts[counts.length - 1]++;
  }
  return {
    bins: bins.map((b, i) => ({ ...b, count: counts[i] })),
    counts,
    total: finite.length,
  };
}

const PROB_BINS = [
  { min: 0, max: 0.1, label: '0.00-0.10' },
  { min: 0.1, max: 0.25, label: '0.10-0.25' },
  { min: 0.25, max: 0.5, label: '0.25-0.50' },
  { min: 0.5, max: 0.75, label: '0.50-0.75' },
  { min: 0.75, max: 0.9, label: '0.75-0.90' },
  { min: 0.9, max: 1.01, label: '0.90-1.00' },
];

const STD_BINS_M = [
  { min: 0, max: 0.05, label: '0.00-0.05' },
  { min: 0.05, max: 0.1, label: '0.05-0.10' },
  { min: 0.1, max: 0.2, label: '0.10-0.20' },
  { min: 0.2, max: 0.4, label: '0.20-0.40' },
  { min: 0.4, max: 0.8, label: '0.40-0.80' },
  { min: 0.8, max: 100, label: '0.80+' },
];

const LANE_WIDTH_BINS_M = [
  { min: 0, max: 2.5, label: '<2.5' },
  { min: 2.5, max: 3.0, label: '2.5-3.0' },
  { min: 3.0, max: 3.5, label: '3.0-3.5' },
  { min: 3.5, max: 4.0, label: '3.5-4.0' },
  { min: 4.0, max: 5.0, label: '4.0-5.0' },
  { min: 5.0, max: 100, label: '5.0+' },
];

module.exports = {
  percentile,
  summarizeNumeric,
  buildHistogram,
  PROB_BINS,
  STD_BINS_M,
  LANE_WIDTH_BINS_M,
};
