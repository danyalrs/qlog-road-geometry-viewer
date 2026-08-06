'use strict';

const LOCAL_ROAD_SURFACE_RIBBON_FALLBACK_HALF_WIDTH_M = 7.5;
const LOCAL_ROAD_SURFACE_RIBBON_MIN_HALF_WIDTH_M = 3;
const LOCAL_ROAD_SURFACE_RIBBON_MAX_HALF_WIDTH_M = 15;
const RIBBON_END_CAP_SEGMENTS = 6;
const EDGE_SEARCH_ALONG_M = 12;
const EDGE_SEARCH_LATERAL_M = 22;

function splitTrajectorySections(trajectory, options = {}) {
  const LTO = typeof window !== 'undefined' ? window.LocalTrajectoryOverlay : null;
  const maxGapM = options.maxGapM ?? LTO?.TRAJECTORY_OVERLAY_MAX_GAP_M ?? 150;
  const split = LTO?.splitTrajectoryOverlayRuns
    || function fallbackSplit(points, opts) {
      const gap = opts?.maxGapM ?? maxGapM;
      if (!points?.length) return [];
      const runs = [];
      let run = [points[0]];
      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        const jump = Math.hypot(curr.east - prev.east, curr.north - prev.north);
        const prevTime = Number(prev.logMonoTime);
        const currTime = Number(curr.logMonoTime);
        const timeReversal = Number.isFinite(prevTime) && Number.isFinite(currTime) && currTime < prevTime;
        if (jump > gap || timeReversal) {
          runs.push(run);
          run = [curr];
        } else {
          run.push(curr);
        }
      }
      runs.push(run);
      return runs;
    };
  return split(trajectory, { maxGapM }).filter((run) => run.length >= 2);
}

function tangentAt(section, index) {
  let dx;
  let dy;
  if (section.length < 2) return { tx: 1, ty: 0 };
  if (index === 0) {
    dx = section[1].east - section[0].east;
    dy = section[1].north - section[0].north;
  } else if (index === section.length - 1) {
    dx = section[index].east - section[index - 1].east;
    dy = section[index].north - section[index - 1].north;
  } else {
    dx = section[index + 1].east - section[index - 1].east;
    dy = section[index + 1].north - section[index - 1].north;
  }
  const len = Math.hypot(dx, dy) || 1;
  return { tx: dx / len, ty: dy / len };
}

function leftNormal(tx, ty) {
  return { nx: -ty, ny: tx };
}

function clampHalfWidth(value, options) {
  const min = options.minHalfWidthM ?? LOCAL_ROAD_SURFACE_RIBBON_MIN_HALF_WIDTH_M;
  const max = options.maxHalfWidthM ?? LOCAL_ROAD_SURFACE_RIBBON_MAX_HALF_WIDTH_M;
  return Math.max(min, Math.min(max, value));
}

function smoothHalfWidths(widths, windowSize = 3) {
  if (widths.length <= 2) return widths.slice();
  const out = widths.slice();
  const half = Math.floor(windowSize / 2);
  for (let i = 0; i < widths.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= widths.length) continue;
      sum += widths[j];
      count += 1;
    }
    out[i] = count ? sum / count : widths[i];
  }
  return out;
}

function estimateHalfWidthAtPoint(trajPoint, tangent, edgeFragments, options) {
  const fallback = options.fallbackHalfWidthM ?? LOCAL_ROAD_SURFACE_RIBBON_FALLBACK_HALF_WIDTH_M;
  const alongM = options.edgeSearchAlongM ?? EDGE_SEARCH_ALONG_M;
  const lateralM = options.edgeSearchLateralM ?? EDGE_SEARCH_LATERAL_M;
  let leftDist = null;
  let rightDist = null;

  for (const frag of edgeFragments || []) {
    for (const p of frag.points || []) {
      if (!Number.isFinite(p.east) || !Number.isFinite(p.north)) continue;
      const rx = p.east - trajPoint.east;
      const ry = p.north - trajPoint.north;
      const forward = rx * tangent.tx + ry * tangent.ty;
      const lateral = rx * (-tangent.ty) + ry * tangent.tx;
      if (Math.abs(forward) > alongM || Math.abs(lateral) > lateralM) continue;

      const side = p.side === 'left' || p.side === 'right' ? p.side : (lateral >= 0 ? 'left' : 'right');
      if (side === 'left' && lateral > 0) {
        leftDist = leftDist == null ? lateral : Math.min(leftDist, lateral);
      } else if (side === 'right' && lateral < 0) {
        const dist = Math.abs(lateral);
        rightDist = rightDist == null ? dist : Math.min(rightDist, dist);
      }
    }
  }

  if (leftDist != null && rightDist != null) {
    return clampHalfWidth((leftDist + rightDist) / 2, options);
  }
  if (leftDist != null) return clampHalfWidth(leftDist, options);
  if (rightDist != null) return clampHalfWidth(rightDist, options);
  return clampHalfWidth(fallback, options);
}

function estimateSectionHalfWidths(section, edgeFragments, options = {}) {
  const raw = section.map((pt, i) => {
    const tangent = tangentAt(section, i);
    return estimateHalfWidthAtPoint(pt, tangent, edgeFragments, options);
  });
  return smoothHalfWidths(raw);
}

function offsetPoint(point, normal, distance, sign) {
  return {
    east: point.east + normal.nx * distance * sign,
    north: point.north + normal.ny * distance * sign,
  };
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

function buildSegmentQuad(section, i, halfWidths) {
  const t0 = tangentAt(section, i);
  const t1 = tangentAt(section, i + 1);
  const n0 = leftNormal(t0.tx, t0.ty);
  const n1 = leftNormal(t1.tx, t1.ty);
  const hw0 = halfWidths[i];
  const hw1 = halfWidths[i + 1];
  return [
    offsetPoint(section[i], n0, hw0, 1),
    offsetPoint(section[i + 1], n1, hw1, 1),
    offsetPoint(section[i + 1], n1, hw1, -1),
    offsetPoint(section[i], n0, hw0, -1),
  ];
}

function buildSectionEndCap(section, index, halfWidths, side) {
  const tangent = tangentAt(section, index);
  const n = leftNormal(tangent.tx, tangent.ty);
  const hw = halfWidths[index];
  const center = section[index];
  const sign = side === 'start' ? -1 : 1;
  const baseAngle = Math.atan2(-n.nx * sign, n.ny * sign);
  const ring = [];
  addSemicircleArc(ring, center, baseAngle, baseAngle + Math.PI, hw, RIBBON_END_CAP_SEGMENTS);
  return ring;
}

function buildSectionRibbonParts(section, halfWidths) {
  if (section.length < 2) return { quads: [], endCaps: [] };
  const quads = [];
  for (let i = 0; i < section.length - 1; i++) {
    quads.push(buildSegmentQuad(section, i, halfWidths));
  }
  const endCaps = [
    buildSectionEndCap(section, 0, halfWidths, 'start'),
    buildSectionEndCap(section, section.length - 1, halfWidths, 'end'),
  ];
  return { quads, endCaps };
}

function buildSectionRibbonRing(section, halfWidths) {
  const parts = buildSectionRibbonParts(section, halfWidths);
  return [...parts.quads.flat(), ...parts.endCaps.flat()];
}

function ringLooksValid(ring) {
  if (!ring || ring.length < 3) return false;
  for (const pt of ring) {
    if (!Number.isFinite(pt.east) || !Number.isFinite(pt.north)) return false;
  }
  return true;
}

function segmentsIntersect(a1, a2, b1, b2) {
  const cross = (p, q, r) => (q.east - p.east) * (r.north - p.north) - (q.north - p.north) * (r.east - p.east);
  const d1 = cross(a1, a2, b1);
  const d2 = cross(a1, a2, b2);
  const d3 = cross(b1, b2, a1);
  const d4 = cross(b1, b2, a2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function ringHasSelfIntersection(ring) {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a1 = ring[i];
    const a2 = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (j === i || (j + 1) % n === i) continue;
      const b1 = ring[j];
      const b2 = ring[(j + 1) % n];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

function buildTrajectoryRoadSurfaceRibbons(trajectory, edgeFragments, options = {}) {
  const sections = splitTrajectorySections(trajectory, options);
  const ribbons = [];
  const widthSamples = [];

  for (let si = 0; si < sections.length; si++) {
    const section = sections[si];
    const halfWidths = estimateSectionHalfWidths(section, edgeFragments, options);
    halfWidths.forEach((w) => widthSamples.push(w));
    const ring = buildSectionRibbonRing(section, halfWidths);
    const parts = buildSectionRibbonParts(section, halfWidths);
    if (!parts.quads.length) continue;
    const quadRings = [...parts.quads, ...parts.endCaps].filter(ringLooksValid);
    if (!quadRings.length) continue;
    ribbons.push({
      sectionIndex: si,
      ring,
      parts: quadRings,
      pointCount: section.length,
      segmentCount: section.length - 1,
      halfWidths,
      widthSource: halfWidths.some((w, i) => {
        const tangent = tangentAt(section, i);
        const fb = options.fallbackHalfWidthM ?? LOCAL_ROAD_SURFACE_RIBBON_FALLBACK_HALF_WIDTH_M;
        const noEdges = !(edgeFragments || []).some((f) => f.points?.length);
        if (noEdges) return false;
        const withoutEdges = estimateHalfWidthAtPoint(section[i], tangent, [], { ...options, fallbackHalfWidthM: fb });
        return Math.abs(w - withoutEdges) > 0.05;
      }) ? 'edgeEvidence' : 'fallback',
      selfIntersecting: quadRings.some((r) => ringHasSelfIntersection(r)),
    });
  }

  return {
    ribbons,
    sections,
    stats: {
      sectionCount: sections.length,
      ribbonCount: ribbons.length,
      trajectoryPointCount: trajectory?.length ?? 0,
      widthMin: widthSamples.length ? Math.min(...widthSamples) : null,
      widthMax: widthSamples.length ? Math.max(...widthSamples) : null,
      widthMedian: widthSamples.length
        ? [...widthSamples].sort((a, b) => a - b)[Math.floor(widthSamples.length / 2)]
        : null,
      fallbackHalfWidthM: options.fallbackHalfWidthM ?? LOCAL_ROAD_SURFACE_RIBBON_FALLBACK_HALF_WIDTH_M,
    },
  };
}

function drawRoadSurfaceRibbon(ctx, ringOrParts, worldToScreen, fillStyle) {
  if (!ctx || typeof worldToScreen !== 'function') return false;
  const parts = Array.isArray(ringOrParts?.parts)
    ? ringOrParts.parts
    : Array.isArray(ringOrParts)
      ? ringOrParts
      : ringOrParts?.ring
        ? [ringOrParts.ring]
        : null;
  if (!parts?.length) return false;
  ctx.fillStyle = fillStyle;
  let drawn = 0;
  for (const ring of parts) {
    if (!ringLooksValid(ring)) continue;
    ctx.beginPath();
    const p0 = worldToScreen(ring[0].east, ring[0].north);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < ring.length; i++) {
      const p = worldToScreen(ring[i].east, ring[i].north);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fill();
    drawn += 1;
  }
  return drawn > 0;
}

const LocalRoadSurfaceRibbon = {
  LOCAL_ROAD_SURFACE_RIBBON_FALLBACK_HALF_WIDTH_M,
  LOCAL_ROAD_SURFACE_RIBBON_MIN_HALF_WIDTH_M,
  LOCAL_ROAD_SURFACE_RIBBON_MAX_HALF_WIDTH_M,
  splitTrajectorySections,
  estimateHalfWidthAtPoint,
  estimateSectionHalfWidths,
  buildSectionRibbonParts,
  buildSectionRibbonRing,
  buildTrajectoryRoadSurfaceRibbons,
  drawRoadSurfaceRibbon,
  ringHasSelfIntersection,
  ringLooksValid,
};

if (typeof window !== 'undefined') {
  window.LocalRoadSurfaceRibbon = LocalRoadSurfaceRibbon;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = LocalRoadSurfaceRibbon;
}
