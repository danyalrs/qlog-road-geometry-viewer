'use strict';

/**
 * Canvas layer pixel attribution helpers (diagnostic only).
 * Used when ?debugLayerAttribution=1 is active in the viewer.
 */

function parseLayerAttributionFlag(search) {
  const raw = typeof search === 'string'
    ? new URLSearchParams(search).get('debugLayerAttribution')
    : search?.get?.('debugLayerAttribution');
  return raw === '1';
}

function dominantAddedColours(before, after, changedMask, maxColours = 8) {
  const counts = new Map();
  const n = changedMask.length;
  for (let i = 0; i < n; i++) {
    if (!changedMask[i]) continue;
    const o = i * 4;
    const a = after[o + 3];
    if (a < 8) continue;
    const key = `${after[o]},${after[o + 1]},${after[o + 2]},${a}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxColours)
    .map(([rgba, count]) => ({ rgba, count }));
}

function diffImageData(before, after, alphaThreshold = 8) {
  const len = before.length;
  const changedMask = new Uint8Array(len / 4);
  let changedPixelCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const width = Math.sqrt(len / 4); // not used for bbox - need width param

  return { changedMask, changedPixelCount, bbox: null, dominantColours: [] };
}

function diffImageDataSized(before, after, width, height, alphaThreshold = 8) {
  const pixelCount = width * height;
  const changedMask = new Uint8Array(pixelCount);
  let changedPixelCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    const dr = Math.abs(after[o] - before[o]);
    const dg = Math.abs(after[o + 1] - before[o + 1]);
    const db = Math.abs(after[o + 2] - before[o + 2]);
    const da = Math.abs(after[o + 3] - before[o + 3]);
    const changed = (dr + dg + db + da) > alphaThreshold || (after[o + 3] >= alphaThreshold && before[o + 3] < alphaThreshold);
    if (!changed) continue;
    changedMask[i] = 1;
    changedPixelCount += 1;
    const x = i % width;
    const y = (i / width) | 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  const bbox = changedPixelCount > 0
    ? { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 }
    : null;

  return {
    changedMask,
    changedPixelCount,
    bbox,
    dominantColours: dominantAddedColours(before, after, changedMask),
  };
}

function maskToRgba(mask, after, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    if (!mask[i]) {
      out[o + 3] = 0;
      continue;
    }
    out[o] = after[o];
    out[o + 1] = after[o + 1];
    out[o + 2] = after[o + 2];
    out[o + 3] = after[o + 3];
  }
  return out;
}

function summarizeCoordinateFrames(points) {
  const counts = {};
  for (const p of points || []) {
    const f = p?.coordinateFrame ?? 'unset';
    counts[f] = (counts[f] || 0) + 1;
  }
  return counts;
}

function sourceProvenanceCoveragePct(points) {
  const pts = points || [];
  if (!pts.length) return 0;
  let n = 0;
  for (const p of pts) {
    if (p?.sourceFile) n += 1;
  }
  return +(100 * n / pts.length).toFixed(2);
}

module.exports = {
  parseLayerAttributionFlag,
  diffImageDataSized,
  maskToRgba,
  dominantAddedColours,
  summarizeCoordinateFrames,
  sourceProvenanceCoveragePct,
};
