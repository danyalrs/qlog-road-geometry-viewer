'use strict';

const {
  splitTrajectoryOverlayRuns,
  TRAJECTORY_OVERLAY_MAX_GAP_M,
} = require('./local_trajectory_overlay');

const LOCAL_ROAD_SURFACE_PATH_RADIUS_M = 15;
const CORRIDOR_END_CAP_SEGMENTS = 8;

function isFinitePoint(pt) {
  return pt && Number.isFinite(pt.east) && Number.isFinite(pt.north);
}

function ringHasFiniteCoords(ring) {
  return Array.isArray(ring) && ring.length >= 3 && ring.every(isFinitePoint);
}

function distPointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function minDistanceToSection(point, section) {
  let best = Infinity;
  for (let i = 0; i < section.length - 1; i++) {
    const a = section[i];
    const b = section[i + 1];
    best = Math.min(
      best,
      distPointToSegment(point.east, point.north, a.east, a.north, b.east, b.north),
    );
  }
  return best;
}

function minDistanceToSections(point, sections) {
  let best = Infinity;
  for (const section of sections) {
    if (section.length < 2) continue;
    best = Math.min(best, minDistanceToSection(point, section));
  }
  return best;
}

function minDistanceRingToSections(ring, sections) {
  let best = Infinity;
  for (const pt of ring) {
    if (!isFinitePoint(pt)) continue;
    best = Math.min(best, minDistanceToSections(pt, sections));
  }
  return best;
}

function segmentNormal(dx, dy) {
  const len = Math.hypot(dx, dy);
  if (!len) return { nx: 0, ny: 1 };
  return { nx: -dy / len, ny: dx / len };
}

function addSemicircleArc(out, center, startAngle, endAngle, radiusM, segments) {
  const steps = Math.max(2, segments);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ang = startAngle + (endAngle - startAngle) * t;
    out.push({
      east: center.east + Math.cos(ang) * radiusM,
      north: center.north + Math.sin(ang) * radiusM,
    });
  }
}

function buildCorridorRing(section, radiusM) {
  if (!section || section.length < 2 || !Number.isFinite(radiusM) || radiusM <= 0) return null;
  const left = [];
  const right = [];
  const n = section.length;

  for (let i = 0; i < n; i++) {
    let dx;
    let dy;
    if (i === 0) {
      dx = section[1].east - section[0].east;
      dy = section[1].north - section[0].north;
    } else if (i === n - 1) {
      dx = section[i].east - section[i - 1].east;
      dy = section[i].north - section[i - 1].north;
    } else {
      dx = section[i + 1].east - section[i - 1].east;
      dy = section[i + 1].north - section[i - 1].north;
    }
    const { nx, ny } = segmentNormal(dx, dy);
    left.push({ east: section[i].east + nx * radiusM, north: section[i].north + ny * radiusM });
    right.push({ east: section[i].east - nx * radiusM, north: section[i].north - ny * radiusM });
  }

  const start = section[0];
  const end = section[n - 1];
  const startDir = segmentNormal(section[1].east - section[0].east, section[1].north - section[0].north);
  const endDir = segmentNormal(end.east - section[n - 2].east, end.north - section[n - 2].north);
  const startAngle = Math.atan2(-startDir.nx, startDir.ny);
  const endAngle = Math.atan2(endDir.nx, -endDir.ny);

  const ring = [...left];
  addSemicircleArc(ring, end, endAngle, endAngle + Math.PI, radiusM, CORRIDOR_END_CAP_SEGMENTS);
  ring.push(...right.reverse());
  addSemicircleArc(ring, start, startAngle + Math.PI, startAngle + Math.PI * 2, radiusM, CORRIDOR_END_CAP_SEGMENTS);
  return ring.filter(isFinitePoint);
}

function buildTrajectoryCorridorSections(trajectory, options = {}) {
  const maxGapM = options.maxGapM ?? TRAJECTORY_OVERLAY_MAX_GAP_M;
  const runs = splitTrajectoryOverlayRuns(trajectory, { maxGapM });
  return runs.filter((run) => run.length >= 2);
}

function buildTrajectoryCorridorRings(trajectory, options = {}) {
  const radiusM = options.radiusM ?? LOCAL_ROAD_SURFACE_PATH_RADIUS_M;
  const sections = buildTrajectoryCorridorSections(trajectory, options);
  const rings = [];
  for (const section of sections) {
    const ring = buildCorridorRing(section, radiusM);
    if (ringHasFiniteCoords(ring)) rings.push(ring);
  }
  return { sections, rings, radiusM };
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].east;
    const yi = ring[i].north;
    const xj = ring[j].east;
    const yj = ring[j].north;
    const intersect = ((yi > point.north) !== (yj > point.north))
      && (point.east < ((xj - xi) * (point.north - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function ringBbox(ring) {
  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (const pt of ring) {
    if (!isFinitePoint(pt)) continue;
    minE = Math.min(minE, pt.east);
    maxE = Math.max(maxE, pt.east);
    minN = Math.min(minN, pt.north);
    maxN = Math.max(maxN, pt.north);
  }
  return { minE, maxE, minN, maxN };
}

function bboxesOverlap(a, b) {
  return a.minE <= b.maxE && a.maxE >= b.minE && a.minN <= b.maxN && a.maxN >= b.minN;
}

function intersectsCorridor(ring, corridor) {
  const { sections, rings, radiusM } = corridor;
  if (!ringHasFiniteCoords(ring)) return false;

  const minDist = minDistanceRingToSections(ring, sections);
  if (minDist <= radiusM) return true;

  const bbox = ringBbox(ring);
  for (const corridorRing of rings) {
    const cb = ringBbox(corridorRing);
    if (!bboxesOverlap(bbox, cb)) continue;
    for (const pt of ring) {
      if (pointInRing(pt, corridorRing)) return true;
    }
    for (const pt of corridorRing) {
      if (pointInRing(pt, ring)) return true;
    }
  }
  return false;
}

function clipInsideHalfPlane(points, nx, ny, c) {
  if (!points.length) return [];
  const out = [];
  const inside = (pt) => nx * pt.east + ny * pt.north >= c;
  const intersect = (a, b) => {
    const da = nx * a.east + ny * a.north - c;
    const db = nx * b.east + ny * b.north - c;
    const t = da / (da - db);
    return {
      east: a.east + t * (b.east - a.east),
      north: a.north + t * (b.north - a.north),
    };
  };
  for (let i = 0; i < points.length; i++) {
    const curr = points[i];
    const prev = points[(i + points.length - 1) % points.length];
    const currIn = inside(curr);
    const prevIn = inside(prev);
    if (currIn) {
      if (!prevIn) out.push(intersect(prev, curr));
      out.push(curr);
    } else if (prevIn) {
      out.push(intersect(prev, curr));
    }
  }
  return out;
}

function clipPolygonToConvexRing(ring, clipRing) {
  if (!ringHasFiniteCoords(ring) || !ringHasFiniteCoords(clipRing)) return null;
  let output = ring.map((pt) => ({ east: pt.east, north: pt.north }));
  for (let i = 0; i < clipRing.length; i++) {
    const a = clipRing[i];
    const b = clipRing[(i + 1) % clipRing.length];
    const dx = b.east - a.east;
    const dy = b.north - a.north;
    const nx = dy;
    const ny = -dx;
    const c = nx * a.east + ny * a.north;
    output = clipInsideHalfPlane(output, nx, ny, c);
    if (output.length < 3) return null;
  }
  return output;
}

function clipPolygonToCorridorRings(ring, corridorRings) {
  let best = null;
  let bestArea = 0;
  for (const corridorRing of corridorRings) {
    try {
      const clipped = clipPolygonToConvexRing(ring, corridorRing);
      if (!ringHasFiniteCoords(clipped)) continue;
      const bb = ringBbox(clipped);
      const area = Math.max(0, bb.maxE - bb.minE) * Math.max(0, bb.maxN - bb.minN);
      if (area > bestArea) {
        best = clipped;
        bestArea = area;
      }
    } catch (_err) {
      // skip failed clip candidate
    }
  }
  return best;
}

function filterRoadSurfacePolygonsForTrajectory(polygons, trajectory, options = {}) {
  const radiusM = options.radiusM ?? LOCAL_ROAD_SURFACE_PATH_RADIUS_M;
  const corridor = buildTrajectoryCorridorRings(trajectory, { ...options, radiusM });
  const drawables = [];
  const skipped = [];
  let clippedCount = 0;
  let clipFailed = 0;

  for (let i = 0; i < (polygons || []).length; i++) {
    const poly = polygons[i];
    const ring = poly?.ring;
    if (!ringHasFiniteCoords(ring)) {
      skipped.push({ index: i, fragmentIndex: poly?.fragmentIndex ?? i, reason: 'invalidPolygon' });
      continue;
    }
    if (!intersectsCorridor(ring, corridor)) {
      skipped.push({ index: i, fragmentIndex: poly?.fragmentIndex ?? i, reason: 'outsideTrajectoryCorridor' });
      continue;
    }

    let displayRing = ring;
    let clipped = false;
    const minDist = minDistanceRingToSections(ring, corridor.sections);
    const allInside = ring.every((pt) => {
      for (const corridorRing of corridor.rings) {
        if (pointInRing(pt, corridorRing)) return true;
      }
      return minDistanceToSections(pt, corridor.sections) <= radiusM;
    });

    if (!allInside && corridor.rings.length) {
      const clippedRing = clipPolygonToCorridorRings(ring, corridor.rings);
      if (ringHasFiniteCoords(clippedRing)) {
        displayRing = clippedRing;
        clipped = true;
        clippedCount += 1;
      } else if (minDist <= radiusM) {
        displayRing = ring;
      } else {
        skipped.push({ index: i, fragmentIndex: poly?.fragmentIndex ?? i, reason: 'clipFailed' });
        clipFailed += 1;
        continue;
      }
    }

    drawables.push({
      poly,
      displayRing,
      clipped,
      sourceIndex: i,
    });
  }

  return {
    drawables,
    skipped,
    corridor,
    stats: {
      radiusM,
      sectionsProcessed: corridor.sections.length,
      sourceCount: polygons?.length ?? 0,
      drawableCount: drawables.length,
      skippedCount: skipped.length,
      clippedCount,
      clipFailed,
      offRouteRemoved: skipped.filter((s) => s.reason === 'outsideTrajectoryCorridor').length,
    },
  };
}

function traceTrajectoryCorridorPath(ctx, trajectory, worldToScreen, options = {}) {
  if (!ctx || !trajectory?.length || typeof worldToScreen !== 'function') return false;
  const { rings } = buildTrajectoryCorridorRings(trajectory, options);
  if (!rings.length) return false;
  for (const ring of rings) {
    const p0 = worldToScreen(ring[0].east, ring[0].north);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < ring.length; i++) {
      const p = worldToScreen(ring[i].east, ring[i].north);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
  }
  return true;
}

module.exports = {
  LOCAL_ROAD_SURFACE_PATH_RADIUS_M,
  buildTrajectoryCorridorSections,
  buildTrajectoryCorridorRings,
  buildCorridorRing,
  filterRoadSurfacePolygonsForTrajectory,
  traceTrajectoryCorridorPath,
  distPointToSegment,
  minDistanceRingToSections,
  intersectsCorridor,
};
