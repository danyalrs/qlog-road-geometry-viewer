/** Road polygon construction and geometry sanity checks. */

const { dist2d } = require('./chunking');

function polygonArea(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i].east * pts[j].north - pts[j].east * pts[i].north;
  }
  return Math.abs(area) / 2;
}

function polylineLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist2d(pts[i - 1], pts[i]);
  return len;
}

function segmentsIntersect(a1, a2, b1, b2) {
  const cross = (o, a, b) => (a.east - o.east) * (b.north - o.north) - (a.north - o.north) * (b.east - o.east);
  const d1 = cross(a1, a2, b1);
  const d2 = cross(a1, a2, b2);
  const d3 = cross(b1, b2, a1);
  const d4 = cross(b1, b2, a2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function countSelfIntersections(pts) {
  let count = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = i + 2; j < pts.length - 1; j++) {
      if (i === 0 && j === pts.length - 2) continue;
      if (segmentsIntersect(pts[i], pts[i + 1], pts[j], pts[j + 1])) count++;
    }
  }
  return count;
}

function maxConsecutiveVertexJump(pts) {
  let max = 0;
  for (let i = 1; i < pts.length; i++) {
    max = Math.max(max, dist2d(pts[i - 1], pts[i]));
  }
  return max;
}

function widthsAlongPolygon(left, right) {
  const widths = [];
  const len = Math.min(left.length, right.length);
  for (let i = 0; i < len; i++) {
    widths.push(dist2d(left[i], right[i]));
  }
  return widths;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function validateRoadPolygon(left, right, options = {}) {
  const minWidth = options.minRoadWidthM ?? 2;
  const maxWidth = options.maxRoadWidthM ?? 30;
  const maxVertexJump = options.maxVertexJumpM ?? 15;
  const maxAreaPerLength = options.maxAreaPerLength ?? 50;
  const rejections = [];

  if (!left?.length || !right?.length || left.length < 2 || right.length < 2) {
    return { valid: false, rejections: ['tooFewPoints'] };
  }

  const len = Math.min(left.length, right.length);
  const widths = widthsAlongPolygon(left.slice(0, len), right.slice(0, len));
  const medW = median(widths);
  const minW = Math.min(...widths);
  const maxW = Math.max(...widths);

  if (minW < minWidth) rejections.push('widthBelowMin');
  if (maxW > maxWidth) rejections.push('widthAboveMax');

  const ring = [...left.slice(0, len), ...right.slice(0, len).reverse()];
  const maxJump = maxConsecutiveVertexJump(ring);
  if (maxJump > maxVertexJump) rejections.push('vertexJumpTooLarge');

  const intersections = countSelfIntersections(ring);
  if (intersections > 0) rejections.push('selfIntersecting');

  const length = polylineLength(left.slice(0, len));
  const area = polygonArea(ring);
  if (length > 0 && area / length > maxAreaPerLength) rejections.push('areaImplausible');

  for (let i = 0; i < len; i++) {
    if (dist2d(left[i], right[i]) > maxWidth * 2) {
      rejections.push('boundaryMismatch');
      break;
    }
  }

  return {
    valid: rejections.length === 0,
    rejections,
    stats: {
      length,
      area,
      medianWidth: medW,
      minWidth: minW,
      maxWidth: maxW,
      maxVertexJump: maxJump,
      intersections,
    },
  };
}

function splitPolylineByGap(points, maxGap) {
  if (!points?.length) return [];
  const fragments = [];
  let current = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (dist2d(points[i - 1], points[i]) > maxGap) {
      if (current.length >= 2) fragments.push(current);
      current = [points[i]];
    } else {
      current.push(points[i]);
    }
  }
  if (current.length >= 2) fragments.push(current);
  return fragments;
}

function projectOntoTrajectory(trajectory, point) {
  if (!trajectory?.length) return 0;
  if (trajectory.length === 1) return 0;

  let bestS = 0;
  let bestD = Infinity;
  let cum = 0;

  for (let i = 0; i < trajectory.length - 1; i++) {
    const a = trajectory[i];
    const b = trajectory[i + 1];
    const de = b.east - a.east;
    const dn = b.north - a.north;
    const segLen2 = de * de + dn * dn;
    let t = 0;
    if (segLen2 > 1e-9) {
      t = ((point.east - a.east) * de + (point.north - a.north) * dn) / segLen2;
      t = Math.max(0, Math.min(1, t));
    }
    const proj = { east: a.east + t * de, north: a.north + t * dn };
    const d = dist2d(point, proj);
    const s = cum + t * Math.sqrt(segLen2);
    if (d < bestD) {
      bestD = d;
      bestS = s;
    }
    cum += Math.sqrt(segLen2);
  }
  return bestS;
}

function arcLengthAtNearest(trajectory, point) {
  return projectOntoTrajectory(trajectory, point);
}

function enforceMonotonicArcLength(points, toleranceM = 2) {
  if (!points.length) return [];
  const out = [points[0]];
  let lastS = points[0].s ?? 0;
  for (let i = 1; i < points.length; i++) {
    const s = points[i].s ?? 0;
    if (s >= lastS - toleranceM) {
      out.push(points[i]);
      lastS = Math.max(lastS, s);
    }
  }
  return out;
}

function orderPointsAlongTrajectory(points, trajectory) {
  if (!trajectory?.length || !points?.length) return [...points];

  const withS = points.map((p) => ({ ...p, s: projectOntoTrajectory(trajectory, p) }));
  withS.sort((a, b) => a.s - b.s || a.east - b.east || a.north - b.north);
  return enforceMonotonicArcLength(withS);
}

function lateralOffset(point, trajectory) {
  if (!trajectory?.length) return 0;
  let bestIdx = 0;
  let bestD = Infinity;
  for (let i = 0; i < trajectory.length; i++) {
    const d = dist2d(trajectory[i], point);
    if (d < bestD) { bestD = d; bestIdx = i; }
  }
  const i0 = Math.max(0, bestIdx - 1);
  const i1 = Math.min(trajectory.length - 1, bestIdx + 1);
  const de = trajectory[i1].east - trajectory[i0].east;
  const dn = trajectory[i1].north - trajectory[i0].north;
  const len = Math.hypot(de, dn) || 1;
  const nx = -dn / len;
  const ny = de / len;
  return (point.east - trajectory[bestIdx].east) * nx + (point.north - trajectory[bestIdx].north) * ny;
}

function meanLateralOffset(points, trajectory) {
  if (!points?.length) return 0;
  let sum = 0;
  for (const p of points) sum += lateralOffset(p, trajectory);
  return sum / points.length;
}

function groupFusedEdgesByIndex(fusedEdges) {
  const groups = new Map();
  for (const edge of fusedEdges || []) {
    const idx = edge.edgeIndex ?? 0;
    if (!groups.has(idx)) groups.set(idx, []);
    groups.get(idx).push(edge);
  }
  return groups;
}

function collectEdgePoints(edgeGroup) {
  return edgeGroup.flatMap((e) => e.points || []);
}

function selectLeftRightEdges(fusedEdges, gpsTrajectory) {
  const groups = groupFusedEdgesByIndex(fusedEdges);
  if (groups.size < 2) return null;

  const ranked = [...groups.entries()].map(([edgeIndex, fragments]) => ({
    edgeIndex,
    fragments,
    offset: meanLateralOffset(collectEdgePoints(fragments), gpsTrajectory),
  }));
  ranked.sort((a, b) => a.offset - b.offset);

  const left = ranked[0];
  const right = ranked[ranked.length - 1];
  if (left.edgeIndex === right.edgeIndex) return null;
  if (Math.abs(right.offset - left.offset) < 1) return null;
  return { left, right };
}

function meanArcLength(points, trajectory) {
  if (!points?.length) return 0;
  let sum = 0;
  for (const p of points) sum += projectOntoTrajectory(trajectory, p);
  return sum / points.length;
}

function pairFragmentsByArcLength(leftFrags, rightFrags, trajectory) {
  const pairs = [];
  const usedRight = new Set();
  for (let li = 0; li < leftFrags.length; li++) {
    const left = leftFrags[li];
    const leftS = meanArcLength(left, trajectory);
    let bestRi = -1;
    let bestD = Infinity;
    for (let ri = 0; ri < rightFrags.length; ri++) {
      if (usedRight.has(ri)) continue;
      const d = Math.abs(meanArcLength(rightFrags[ri], trajectory) - leftS);
      if (d < bestD) { bestD = d; bestRi = ri; }
    }
    if (bestRi >= 0 && bestD < 50) {
      usedRight.add(bestRi);
      pairs.push({ left, right: rightFrags[bestRi], fragmentIndex: li });
    }
  }
  return pairs;
}

function buildRoadSurfacePolygons(fusedEdges, gpsTrajectory, options = {}) {
  const maxBoundaryGap = options.maxRoadEdgeGapM ?? 10;
  const polygons = [];
  const rejectionLog = [];

  const pair = selectLeftRightEdges(fusedEdges, gpsTrajectory);
  if (!pair) {
    if (fusedEdges?.length) {
      rejectionLog.push({ fragmentIndex: -1, reasons: ['insufficientEdgePair'] });
    }
    return { polygons, rejectionLog };
  }

  const leftAll = collectEdgePoints(pair.left.fragments);
  const rightAll = collectEdgePoints(pair.right.fragments);

  const leftFrags = splitPolylineByGap(
    orderPointsAlongTrajectory(leftAll, gpsTrajectory),
    maxBoundaryGap
  );
  const rightFrags = splitPolylineByGap(
    orderPointsAlongTrajectory(rightAll, gpsTrajectory),
    maxBoundaryGap
  );

  const pairs = pairFragmentsByArcLength(leftFrags, rightFrags, gpsTrajectory);
  for (const { left, right, fragmentIndex } of pairs) {
    const check = validateRoadPolygon(left, right, options);
    if (check.valid) {
      polygons.push({
        fragmentIndex,
        leftEdgeIndex: pair.left.edgeIndex,
        rightEdgeIndex: pair.right.edgeIndex,
        left,
        right,
        ring: [...left, ...[...right].reverse()],
        stats: check.stats,
      });
    } else {
      rejectionLog.push({ fragmentIndex, reasons: check.rejections, stats: check.stats });
    }
  }

  if (leftFrags.length !== rightFrags.length || pairs.length < Math.min(leftFrags.length, rightFrags.length)) {
    rejectionLog.push({
      fragmentIndex: -1,
      reasons: ['fragmentCountMismatch'],
      leftCount: leftFrags.length,
      rightCount: rightFrags.length,
    });
  }

  return { polygons, rejectionLog };
}

module.exports = {
  polygonArea,
  polylineLength,
  segmentsIntersect,
  countSelfIntersections,
  maxConsecutiveVertexJump,
  validateRoadPolygon,
  splitPolylineByGap,
  orderPointsAlongTrajectory,
  projectOntoTrajectory,
  buildRoadSurfacePolygons,
  selectLeftRightEdges,
  lateralOffset,
  widthsAlongPolygon,
};
