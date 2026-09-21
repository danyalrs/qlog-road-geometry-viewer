'use strict';
(function (global) {
const PCP = global.ProgressiveCombinedPlayback;
'use strict';

/**
 * Opt-in progressive viewport / draw-performance candidate.
 * Default-off via progressiveViewportCandidate URL flag.
 * Active only when progressive combined playback is also enabled.
 */

function parseProgressiveViewportCandidate(search = '') {
  const raw = String(search ?? '');
  const query = raw.startsWith('?') ? raw.slice(1) : raw;
  const params = new URLSearchParams(query);
  const value = params.get('progressiveViewportCandidate');
  if (value === '1') return true;
  if (value === '0') return false;
  return false;
}

function isCandidateEnabled(search = '', progressiveCombinedEnabled = false) {
  return !!progressiveCombinedEnabled && parseProgressiveViewportCandidate(search);
}

function computeVisibleRouteBounds(displayMap, visibleSources) {
  return PCP.computeVisibleFitBounds(displayMap, visibleSources);
}

function computeActiveSegmentBounds(displayMap, sourceFile) {
  if (!displayMap || !sourceFile) return null;
  return PCP.computeVisibleFitBounds(displayMap, [sourceFile]);
}

function isDegenerateBounds(bounds, minSpanM = 1) {
  if (!bounds?.finite) return true;
  const spanE = Math.abs(bounds.maxE - bounds.minE);
  const spanN = Math.abs(bounds.maxN - bounds.minN);
  return spanE < minSpanM && spanN < minSpanM;
}

function resolveFitBounds(displayMap, visibleSources, activeSourceFile) {
  const active = computeActiveSegmentBounds(displayMap, activeSourceFile);
  if (!isDegenerateBounds(active)) return { bounds: active, mode: 'activeSegment' };
  const visible = computeVisibleRouteBounds(displayMap, visibleSources);
  return { bounds: visible, mode: 'visibleRoute' };
}

function coordFromPoint(p) {
  const east = p?.placedEast ?? p?.east ?? p?.localEast;
  const north = p?.placedNorth ?? p?.north ?? p?.localNorth;
  if (!Number.isFinite(east) || !Number.isFinite(north)) return null;
  return { east, north };
}

function countDrawableGeometry(displayMap, visibleSources = null) {
  const visibleSet = visibleSources
    ? new Set(PCP.orderPrefixFiles(visibleSources))
    : null;
  const includeSource = (sf) => !visibleSet || !sf || visibleSet.has(sf);

  let pointDots = 0;
  let trajectoryPoints = 0;
  let laneFragmentVertices = 0;
  let roadPolygonVertices = 0;
  let connectedPolylineVertices = 0;

  for (const p of displayMap?.trajectory || []) {
    if (!includeSource(p.sourceFile)) continue;
    if (coordFromPoint(p)) trajectoryPoints += 1;
  }
  for (const p of displayMap?.pointAccumulated?.points || []) {
    if (!includeSource(p.sourceFile)) continue;
    if (coordFromPoint(p)) pointDots += 1;
  }
  for (const frag of displayMap?.laneFragments || []) {
    if (!includeSource(frag.sourceFile)) continue;
    laneFragmentVertices += (frag.points || []).length;
  }
  for (const poly of displayMap?.roadSurfacePolygons || []) {
    if (!includeSource(poly.sourceFile)) continue;
    roadPolygonVertices += (poly.ring || []).length;
  }
  const reps = displayMap?.representativeLaneLines?.lines
    || displayMap?.representativeLaneLines
    || [];
  for (const line of reps) {
    connectedPolylineVertices += (line.points || line.vertices || []).length;
  }

  return {
    visibleSourceCount: visibleSet ? visibleSet.size : null,
    pointDots,
    trajectoryPoints,
    laneFragmentVertices,
    roadPolygonVertices,
    connectedPolylineVertices,
    totalVertices: pointDots + trajectoryPoints + laneFragmentVertices
      + roadPolygonVertices + connectedPolylineVertices,
  };
}

function screenDist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function turnSharpness(screenA, screenB, screenC) {
  const v1x = screenB.x - screenA.x;
  const v1y = screenB.y - screenA.y;
  const v2x = screenC.x - screenB.x;
  const v2y = screenC.y - screenB.y;
  const l1 = Math.hypot(v1x, v1y);
  const l2 = Math.hypot(v2x, v2y);
  if (l1 < 1e-6 || l2 < 1e-6) return 0;
  const dot = (v1x * v2x + v1y * v2y) / (l1 * l2);
  return 1 - Math.max(-1, Math.min(1, dot));
}

/**
 * Returns indices to draw. Does not mutate source arrays.
 */
function screenSpaceDecimateIndices(length, projectIndexToScreen, {
  minPixelGap = 2,
  preserveIndices = null,
  sharpTurnThreshold = 0.35,
} = {}) {
  const n = Number(length) || 0;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const preserve = preserveIndices instanceof Set ? preserveIndices : new Set(preserveIndices || []);
  preserve.add(0);
  preserve.add(n - 1);

  const out = [0];
  let lastKept = 0;
  let lastScreen = projectIndexToScreen(0);

  for (let i = 1; i < n - 1; i++) {
    if (preserve.has(i)) {
      out.push(i);
      lastKept = i;
      lastScreen = projectIndexToScreen(i);
      continue;
    }
    const cur = projectIndexToScreen(i);
    const dist = screenDist(lastScreen, cur);
    const next = projectIndexToScreen(i + 1);
    const sharp = turnSharpness(lastScreen, cur, next);
    if (dist >= minPixelGap || sharp >= sharpTurnThreshold) {
      out.push(i);
      lastKept = i;
      lastScreen = cur;
    }
  }
  if (out[out.length - 1] !== n - 1) out.push(n - 1);
  return out;
}

function decimatePolylineForDraw(points, projectPointToScreen, options = {}) {
  if (!Array.isArray(points) || points.length <= 2) {
    return { indices: Array.from({ length: points?.length || 0 }, (_, i) => i), drawCount: points?.length || 0 };
  }
  const indices = screenSpaceDecimateIndices(
    points.length,
    (i) => projectPointToScreen(points[i], i),
    options,
  );
  return { indices, drawCount: indices.length, sourceCount: points.length };
}

function mapGeometryChecksum(displayMap, visibleSources = null) {
  if (!displayMap) return null;
  const payloads = PCP.perSourcePlacedPayloads(
    displayMap,
    visibleSources ? PCP.orderPrefixFiles(visibleSources) : Object.keys(displayMap.sourceTransformByFile || {}),
  );
  return JSON.stringify(payloads);
}

const api = {
  parseProgressiveViewportCandidate,
  isCandidateEnabled,
  computeVisibleRouteBounds,
  computeActiveSegmentBounds,
  isDegenerateBounds,
  resolveFitBounds,
  countDrawableGeometry,
  screenSpaceDecimateIndices,
  decimatePolylineForDraw,
  mapGeometryChecksum,
  screenDist,
  turnSharpness,
};

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.ProgressiveViewportCandidate = api;
})(typeof window !== 'undefined' ? window : global);
