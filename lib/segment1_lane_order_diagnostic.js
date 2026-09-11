'use strict';

const crypto = require('crypto');
const VMC = require('./viewer_mirror_coords');
const VDC = require('./viewer_display_corrections');
const CST = require('./combined_source_transform');

const SEG1 = 'qlog_f449c_1.bz2';
const PRIMARY_FRAME_ID = 1803;
const SAMPLE_VIDEO_TIMES = [18.0, 28.1, 38.1];

function det2x2(a, b, c, d) {
  return a * d - b * c;
}

function laneIdentityKey(p) {
  return `${p.sourceFile}|${p.frameId ?? p.frameIndex}|${p.laneIndex}|${p.groupTrackId ?? 'null'}|${p.trackId ?? 'null'}`;
}

function resolvePointCoords(point) {
  if (!point) return null;
  const east = point.localEast ?? point.east;
  const north = point.localNorth ?? point.north;
  if (!Number.isFinite(east) || !Number.isFinite(north)) return null;
  return { east, north };
}

function nearestTrajectoryIndex(trajectory, east, north, sourceFile = null) {
  const pts = sourceFile
    ? (trajectory || []).filter((p) => p.sourceFile === sourceFile)
    : (trajectory || []);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(east - pts[i].east, north - pts[i].north);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return { index: best, point: pts[best], points: pts };
}

function roadRelativeLateralM(trajectory, east, north, sourceFile = null) {
  const { index, points } = nearestTrajectoryIndex(trajectory, east, north, sourceFile);
  if (!points.length) return null;
  const i0 = Math.max(0, index - 1);
  const i1 = Math.min(points.length - 1, index + 1);
  const a = points[i0];
  const b = points[i1];
  const tx = b.east - a.east;
  const ty = b.north - a.north;
  const len = Math.hypot(tx, ty) || 1;
  const ref = points[index];
  const nx = -ty / len;
  const ny = tx / len;
  return (east - ref.east) * nx + (north - ref.north) * ny;
}

function standaloneDisplayPoint(map, point, mirrorChecked = true) {
  const c = resolvePointCoords(point);
  if (!c) return null;
  const resolved = VMC.resolveRoadDisplayCoords(
    c.east,
    c.north,
    point.mirroredLocalEast,
    point.mirroredLocalNorth,
    mirrorChecked,
    {
      trajectory: map.trajectory,
      referencePose: map.referencePose,
      useTrajectoryFallback: false,
    },
  );
  return {
    east: resolved.east,
    north: resolved.north,
    method: resolved.method,
  };
}

function combinedDisplayPoint(point) {
  return {
    east: point.placedEast ?? point.east,
    north: point.placedNorth ?? point.north,
    method: point.coordinateFrame === CST.OUTPUT_FRAME ? 'combinedPlaced' : 'segmentLocalFallback',
  };
}

function placementMatrixFromEntry(entry) {
  if (!entry?.applyCanonical) return null;
  const o = { east: 0, north: 0 };
  const ex = entry.applyCanonical(1, 0);
  const ey = entry.applyCanonical(0, 1);
  const t = entry.applyCanonical(o.east, o.north);
  const a = ex.east - t.east;
  const b = ex.north - t.north;
  const c = ey.east - t.east;
  const d = ey.north - t.north;
  return {
    a, b, c, d,
    tx: t.east,
    ty: t.north,
    determinant: det2x2(a, b, c, d),
    rotationDeg: entry.rotationRad != null ? entry.rotationRad * (180 / Math.PI) : null,
    reflectionApplied: entry.reflectionApplied === true,
    displayCorrection: entry.displayCorrection === true,
  };
}

function laneColourForPoint(rendererLike, pt) {
  const LANE_COLORS = ['#7c3aed', '#0891b2', '#94a3b8', '#f97316'];
  if (pt?.groupTrackId != null && rendererLike?.trackColor) {
    return rendererLike.trackColor(pt.groupTrackId);
  }
  if (pt?.side === 'left') return 'rgba(124,58,237,0.9)';
  if (pt?.side === 'right') return 'rgba(8,145,178,0.9)';
  return LANE_COLORS[(pt?.laneIndex ?? 0) % LANE_COLORS.length];
}

function pointsAtFrame(map, frameId, sourceFile = SEG1) {
  return (map?.pointAccumulated?.points || []).filter((p) => (
    p.sourceFile === sourceFile && (p.frameId === frameId || p.frameIndex === frameId)
  ));
}

function summarizeLaneLines(map, mode, frameId, mirrorChecked = true) {
  const pts = pointsAtFrame(map, frameId);
  const traj = mode === 'standalone'
    ? map.trajectory
    : (map.trajectory || []).filter((p) => p.sourceFile === SEG1);
  return pts.map((p, modelLaneArrayIndex) => {
    const canonical = resolvePointCoords(p);
    const standalone = standaloneDisplayPoint(map, p, mirrorChecked);
    const combined = combinedDisplayPoint(p);
    const display = mode === 'standalone' ? standalone : combined;
    const d = display ? roadRelativeLateralM(traj, display.east, display.north, mode === 'combined' ? SEG1 : null) : null;
    const sortedPts = [...(p.points || [p])].sort((a, b) => {
      const aa = resolvePointCoords(a);
      const bb = resolvePointCoords(b);
      if (!aa || !bb) return 0;
      return Math.hypot(aa.east, aa.north) - Math.hypot(bb.east, bb.north);
    });
    const first = sortedPts[0];
    const last = sortedPts[sortedPts.length - 1];
    const mid = sortedPts[Math.floor(sortedPts.length / 2)];
    return {
      sourceFile: p.sourceFile,
      frameId: p.frameId ?? p.frameIndex,
      modelLaneArrayIndex,
      laneIndex: p.laneIndex,
      groupTrackId: p.groupTrackId ?? null,
      trackId: p.trackId ?? null,
      side: p.side ?? null,
      assignedColour: laneColourForPoint(null, p),
      pointCount: sortedPts.length,
      firstPoint: first ? resolvePointCoords(first) : null,
      middlePoint: mid ? resolvePointCoords(mid) : null,
      finalPoint: last ? resolvePointCoords(last) : null,
      canonicalLocal: canonical,
      mirroredLocal: {
        east: p.mirroredLocalEast,
        north: p.mirroredLocalNorth,
      },
      standaloneDisplay: standalone,
      candidateCInput: { east: canonical?.east, north: canonical?.north },
      candidateCOutput: {
        placedEast: p.placedEast ?? null,
        placedNorth: p.placedNorth ?? null,
        coordinateFrame: p.coordinateFrame ?? null,
      },
      rendererSelected: display,
      signedLateralM: d,
      laneIdentityKey: laneIdentityKey(p),
    };
  });
}

function aggregateByGroupTrackId(lanes) {
  const byId = new Map();
  for (const lane of lanes) {
    const id = lane.groupTrackId;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(lane.signedLateralM);
  }
  const out = [];
  for (const [groupTrackId, ds] of byId) {
    const finite = ds.filter((d) => Number.isFinite(d));
  out.push({
      groupTrackId,
      medianSignedLateralM: finite.length
        ? finite.slice().sort((a, b) => a - b)[Math.floor(finite.length / 2)]
        : null,
      sampleCount: finite.length,
    });
  }
  return out.sort((a, b) => (b.medianSignedLateralM ?? 0) - (a.medianSignedLateralM ?? 0));
}

function compareRoadRelativeOrder(standaloneLanes, combinedLanes) {
  const stand = aggregateByGroupTrackId(standaloneLanes);
  const comb = aggregateByGroupTrackId(combinedLanes);
  const rows = [];
  const allIds = [...new Set([...stand.map((r) => r.groupTrackId), ...comb.map((r) => r.groupTrackId)])];
  for (const id of allIds) {
    const s = stand.find((r) => r.groupTrackId === id);
    const c = comb.find((r) => r.groupTrackId === id);
    const standColour = standaloneLanes.find((l) => l.groupTrackId === id)?.assignedColour ?? null;
    const combColour = combinedLanes.find((l) => l.groupTrackId === id)?.assignedColour ?? null;
    rows.push({
      laneIdentity: `groupTrackId:${id}`,
      groupTrackId: id,
      standaloneDM: s?.medianSignedLateralM ?? null,
      combinedDM: c?.medianSignedLateralM ?? null,
      identitySame: true,
      colourSame: standColour === combColour,
      sideReversed: Number.isFinite(s?.medianSignedLateralM) && Number.isFinite(c?.medianSignedLateralM)
        ? Math.sign(s.medianSignedLateralM) !== Math.sign(c.medianSignedLateralM)
        : null,
    });
  }
  return rows;
}

function laneOrderChecksum(lanes) {
  const order = aggregateByGroupTrackId(lanes).map((r) => `${r.groupTrackId}:${r.medianSignedLateralM?.toFixed(3)}`);
  return crypto.createHash('sha256').update(order.join('|')).digest('hex');
}

function identityChecksum(lanes) {
  const keys = lanes.map((l) => l.laneIdentityKey).sort();
  return crypto.createHash('sha256').update(keys.join('|')).digest('hex');
}

function classifyRootCause({
  roadRelativeRows,
  placementMatrix,
  standaloneLanes,
  combinedLanes,
  rendererFieldTrace,
  cacheComparison,
}) {
  const sideReversals = roadRelativeRows.filter((r) => r.sideReversed === true);
  const colourOnly = sideReversals.length === 0
    && roadRelativeRows.some((r) => r.colourSame === false);
  const geometryReflected = sideReversals.length > 0
    && placementMatrix?.determinant != null
    && placementMatrix.determinant < 0;
  const rendererWrong = rendererFieldTrace?.usesLocalInsteadOfPlaced === true;
  const cacheFault = cacheComparison?.freshVsCachedLaneOrderDiffers === true
    || cacheComparison?.freshVsReprocessLaneOrderDiffers === true;
  const canvasReflection = rendererFieldTrace?.canvasDeterminant != null
    && rendererFieldTrace.canvasDeterminant < 0;

  let classification = 'INCONCLUSIVE';
  let firstFailingStage = null;
  const secondary = [];

  if (geometryReflected) {
    classification = 'A — LANE GEOMETRY REFLECTED';
    firstFailingStage = 'Candidate C source placement (applyCanonical / boundary-anchored fit)';
  } else if (sideReversals.length > 0) {
    classification = 'A — LANE GEOMETRY REFLECTED';
    firstFailingStage = 'Candidate C placed coordinates invert road-relative lane side';
  } else if (colourOnly) {
    classification = 'C — COLOUR ASSIGNMENT CHANGED';
    firstFailingStage = 'pointAccumulated lane dot colour selection';
  } else if (rendererWrong) {
    classification = 'D — RENDERER SELECTED WRONG COORDINATE FIELDS';
    firstFailingStage = rendererFieldTrace?.drawFunction ?? '_drawPointAccumulatedGeometry';
  } else if (cacheFault) {
    classification = 'E — STALE CACHE OR MIXED COORDINATE FRAME';
    firstFailingStage = 'stationary map cache';
  } else if (canvasReflection) {
    classification = 'F — CANVAS TRANSFORM REFLECTION';
    firstFailingStage = 'canvas ctx transform';
  }

  if (classification.startsWith('A') && colourOnly) secondary.push('C — COLOUR ASSIGNMENT CHANGED');
  if (rendererWrong && !classification.startsWith('D')) secondary.push('D — RENDERER SELECTED WRONG COORDINATE FIELDS');

  let status = 'DIAGNOSIS INCONCLUSIVE';
  if (classification === 'A — LANE GEOMETRY REFLECTED') status = 'DIAGNOSIS COMPLETE — GEOMETRY REFLECTION PROVEN';
  else if (classification === 'B — LANE IDENTITY OR ARRAY ORDER CHANGED') status = 'DIAGNOSIS COMPLETE — IDENTITY/ORDER FAULT PROVEN';
  else if (classification === 'C — COLOUR ASSIGNMENT CHANGED') status = 'DIAGNOSIS COMPLETE — COLOUR-ONLY FAULT PROVEN';
  else if (classification === 'D — RENDERER SELECTED WRONG COORDINATE FIELDS') status = 'DIAGNOSIS COMPLETE — RENDERER FIELD SELECTION FAULT PROVEN';
  else if (classification === 'E — STALE CACHE OR MIXED COORDINATE FRAME') status = 'DIAGNOSIS COMPLETE — CACHE/FRAME FAULT PROVEN';
  else if (classification === 'F — CANVAS TRANSFORM REFLECTION') status = 'DIAGNOSIS COMPLETE — CANVAS REFLECTION PROVEN';

  return {
    classification,
    status,
    firstFailingStage,
    secondaryFaults: secondary,
    sideReversalCount: sideReversals.length,
    proposedRepairScope: geometryReflected || sideReversals.length > 0
      ? 'Investigate Segment 1 boundary-anchored rigid placement handedness (2×2 placement determinant / fit orientation) without changing accepted road bridges, video switching, or Segment 0 correction.'
      : colourOnly
        ? 'Investigate groupTrackId colour cache order only.'
        : rendererWrong
          ? 'Investigate _drawPointAccumulatedGeometry coordinate field selection for combinedPlaced points.'
          : 'Collect additional browser-stage evidence before proposing a repair.',
  };
}

function findTimelineIndexForFrame(timeline, frameId, sourceFile = SEG1) {
  return timeline.findIndex((t) => t.sourceFile === sourceFile && t.frameId === frameId);
}

function findTimelineIndexNearVideoSec(timeline, videoSec, sourceFile = SEG1) {
  const segRows = timeline.filter((t) => t.sourceFile === sourceFile);
  if (!segRows.length) return -1;
  const start = timeline[0]?.logMonoTime;
  let best = segRows[0];
  let bestDiff = Infinity;
  for (const row of segRows) {
    const sec = (BigInt(row.logMonoTime) - BigInt(start)) / 1000000000n;
    const diff = Math.abs(Number(sec) - videoSec);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = row;
    }
  }
  return timeline.indexOf(best);
}

module.exports = {
  SEG1,
  PRIMARY_FRAME_ID,
  SAMPLE_VIDEO_TIMES,
  det2x2,
  laneIdentityKey,
  roadRelativeLateralM,
  standaloneDisplayPoint,
  combinedDisplayPoint,
  placementMatrixFromEntry,
  summarizeLaneLines,
  aggregateByGroupTrackId,
  compareRoadRelativeOrder,
  laneOrderChecksum,
  identityChecksum,
  classifyRootCause,
  findTimelineIndexForFrame,
  findTimelineIndexNearVideoSec,
  pointsAtFrame,
};
