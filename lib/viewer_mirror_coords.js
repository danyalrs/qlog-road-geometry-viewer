'use strict';

/**
 * Shared viewer mirror coordinate selection for stationary segment-local maps.
 *
 * Mirror contract (display only): select precomputed mirrored segment-local
 * coordinates when present; otherwise reflect lateral offset about the map
 * trajectory centreline (fallback). modelX / forward distance is unchanged;
 * lateral sign reverses; distance from the vehicle axis is unchanged.
 */

function selectPrecomputedMirror(east, north, mirroredEast, mirroredNorth, mirrorOn) {
  if (!mirrorOn) return { east, north };
  return {
    east: mirroredEast != null ? mirroredEast : east,
    north: mirroredNorth != null ? mirroredNorth : north,
    usedPrecomputed: mirroredEast != null && mirroredNorth != null,
  };
}

function reflectSegmentLocalLateral(east, north) {
  return { east, north: -north };
}

function buildTrajectoryArcLengths(trajectory) {
  const lengths = [0];
  for (let i = 1; i < trajectory.length; i++) {
    const a = trajectory[i - 1];
    const b = trajectory[i];
    lengths.push(lengths[i - 1] + Math.hypot(b.east - a.east, b.north - a.north));
  }
  return lengths;
}

function projectOntoTrajectory(east, north, trajectory) {
  if (!trajectory || trajectory.length < 2) return null;
  const arc = buildTrajectoryArcLengths(trajectory);
  let best = null;
  for (let i = 0; i < trajectory.length - 1; i++) {
    const a = trajectory[i];
    const b = trajectory[i + 1];
    const ax = b.east - a.east;
    const ay = b.north - a.north;
    const segLen2 = ax * ax + ay * ay || 1;
    let t = ((east - a.east) * ax + (north - a.north) * ay) / segLen2;
    t = Math.max(0, Math.min(1, t));
    const px = a.east + t * ax;
    const py = a.north + t * ay;
    const dx = east - px;
    const dy = north - py;
    const dist2 = dx * dx + dy * dy;
    if (!best || dist2 < best.dist2) {
      const segLen = Math.sqrt(segLen2);
      const tx = ax / segLen;
      const ty = ay / segLen;
      const nx = -ty;
      const ny = tx;
      const lateral = dx * nx + dy * ny;
      const alongOffset = dx * tx + dy * ty;
      const s = arc[i] + segLen * t;
      best = {
        s,
        lateral,
        alongOffset,
        px,
        py,
        tx,
        ty,
        nx,
        ny,
        dist2,
      };
    }
  }
  return best;
}

function positionAtTrajectorySLateral(trajectory, s, lateral) {
  if (!trajectory || trajectory.length < 2) return null;
  const arc = buildTrajectoryArcLengths(trajectory);
  const total = arc[arc.length - 1];
  const clampedS = Math.max(0, Math.min(total, s));
  let seg = 0;
  while (seg < arc.length - 2 && arc[seg + 1] < clampedS) seg++;
  const a = trajectory[seg];
  const b = trajectory[seg + 1];
  const ax = b.east - a.east;
  const ay = b.north - a.north;
  const segLen = Math.hypot(ax, ay) || 1;
  const tx = ax / segLen;
  const ty = ay / segLen;
  const nx = -ty;
  const ny = tx;
  const t = segLen > 0 ? (clampedS - arc[seg]) / segLen : 0;
  const px = a.east + tx * segLen * t;
  const py = a.north + ty * segLen * t;
  return {
    east: px + nx * lateral,
    north: py + ny * lateral,
  };
}

function reflectAboutTrajectory(east, north, trajectory) {
  const proj = projectOntoTrajectory(east, north, trajectory);
  if (!proj) return reflectSegmentLocalLateral(east, north);
  return {
    east: proj.px + proj.tx * proj.alongOffset - proj.nx * proj.lateral,
    north: proj.py + proj.ty * proj.alongOffset - proj.ny * proj.lateral,
  };
}

/**
 * Resolve segment-local road display coordinates for one mirror state.
 */
function resolveRoadDisplayCoords(east, north, mirroredEast, mirroredNorth, mirrorOn, options = {}) {
  if (!mirrorOn) return { east, north, method: 'canonical' };
  if (mirroredEast != null && mirroredNorth != null) {
    return { east: mirroredEast, north: mirroredNorth, method: 'precomputed' };
  }
  if (options.useTrajectoryFallback && options.trajectory?.length >= 2) {
    const reflected = reflectAboutTrajectory(east, north, options.trajectory);
    return { east: reflected.east, north: reflected.north, method: 'trajectoryFallback' };
  }
  const referencePose = options.referencePose;
  if (options.useReferencePoseFallback && referencePose && Number.isFinite(referencePose.north)) {
    const anchorNorth = referencePose.north;
    return {
      east,
      north: anchorNorth - (north - anchorNorth),
      method: 'referencePoseFallback',
    };
  }
  return { east, north, method: 'canonicalWithoutPrecomputed' };
}

/**
 * Negate lateral offset reconstructed from trajectory guide + normal.
 */
function mirrorBoundaryOffset(east, north, guideEast, guideNorth, normalEast, normalNorth) {
  const de = east - guideEast;
  const dn = north - guideNorth;
  const lateral = de * normalEast + dn * normalNorth;
  return {
    east: guideEast - lateral * normalEast,
    north: guideNorth - lateral * normalNorth,
  };
}

module.exports = {
  selectPrecomputedMirror,
  reflectSegmentLocalLateral,
  reflectAboutTrajectory,
  projectOntoTrajectory,
  positionAtTrajectorySLateral,
  resolveRoadDisplayCoords,
  mirrorBoundaryOffset,
};
