/**
 * Shared geometry helpers for Stage 15 lane-line assessment (read-only).
 */
const NEAR_FORWARD_X = [5, 15];

function meanYAtForwardX(line, xRange = NEAR_FORWARD_X) {
  const xs = line.x || [];
  const ys = line.y || [];
  const samples = [];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] >= xRange[0] && xs[i] <= xRange[1] && Number.isFinite(ys[i])) {
      samples.push(ys[i]);
    }
  }
  if (!samples.length) return null;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

function lateralAtForwardX(line, x = 10) {
  const xs = line.x || [];
  const ys = line.y || [];
  let best = null;
  let bestDx = Infinity;
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
    const dx = Math.abs(xs[i] - x);
    if (dx < bestDx) { bestDx = dx; best = ys[i]; }
  }
  return best;
}

module.exports = { NEAR_FORWARD_X, meanYAtForwardX, lateralAtForwardX };
