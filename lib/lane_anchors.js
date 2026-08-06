/**
 * Fixed-distance forward anchors on lane curves (vehicle-relative).
 */

const DEFAULT_ANCHOR_DISTANCES = [5, 10, 20, 30];

function interpolateAtForwardX(points, forwardM) {
  if (!points?.length) return null;
  const withX = points.filter((p) => Number.isFinite(p.modelX));
  if (!withX.length) {
    const sorted = [...points].sort((a, b) => (a.east - b.east));
    const total = sorted.length;
    const idx = Math.min(total - 1, Math.floor((forwardM / 40) * total));
    return sorted[idx] ?? null;
  }
  if (forwardM < withX[0].modelX - 0.5 || forwardM > withX[withX.length - 1].modelX + 0.5) return null;
  for (let i = 1; i < withX.length; i++) {
    if (forwardM <= withX[i].modelX) {
      const a = withX[i - 1];
      const b = withX[i];
      const t = (forwardM - a.modelX) / (b.modelX - a.modelX || 1);
      return {
        east: a.east + t * (b.east - a.east),
        north: a.north + t * (b.north - a.north),
        modelX: forwardM,
        modelY: (a.modelY ?? 0) + t * ((b.modelY ?? 0) - (a.modelY ?? 0)),
      };
    }
  }
  return withX[withX.length - 1];
}

function sampleLaneAnchors(lane, frame, options = {}) {
  const distances = options.anchorDistancesM ?? DEFAULT_ANCHOR_DISTANCES;
  const maxForward = options.maxForwardM ?? 120;
  const anchors = [];
  for (const fwd of distances) {
    if (fwd > maxForward) continue;
    const pt = interpolateAtForwardX(lane.points, fwd);
    if (!pt) continue;
    anchors.push({
      frameId: frame.frameId,
      logMonoTime: frame.logMonoTime,
      sessionId: frame.sessionId ?? 0,
      chunkId: frame.chunkId ?? 0,
      passId: frame.passId ?? 0,
      laneIndex: lane.laneIndex,
      forwardM: fwd,
      modelX: pt.modelX ?? fwd,
      modelY: pt.modelY ?? 0,
      east: pt.east,
      north: pt.north,
      confidence: lane.prob ?? 1,
      laneTrackId: lane.laneTrackId ?? null,
    });
  }
  return anchors;
}

function sharedAnchorPairs(prevAnchors, nextAnchors, toleranceM = 4) {
  const pairs = [];
  for (const pa of prevAnchors) {
    for (const na of nextAnchors) {
      if (Math.abs(pa.forwardM - na.forwardM) <= toleranceM) {
        pairs.push({ prev: pa, next: na, forwardM: (pa.forwardM + na.forwardM) / 2 });
      }
    }
  }
  return pairs;
}

/**
 * Lateral difference between matched forward anchors.
 * Compensates expected model-Y shift from heading change (same physical lane through a turn).
 */
function anchorLateralStats(pairs, headingPrevDeg, headingNextDeg) {
  if (!pairs.length) return { meanLatDiff: Infinity, maxLatDiff: Infinity, count: 0 };
  let hd = Math.abs((headingPrevDeg ?? 0) - (headingNextDeg ?? 0));
  if (hd > 180) hd = 360 - hd;
  const hdRad = hd * Math.PI / 180;
  const diffs = pairs.map((p) => {
    const raw = Math.abs((p.prev.modelY ?? 0) - (p.next.modelY ?? 0));
    const fwd = ((p.prev.forwardM ?? 0) + (p.next.forwardM ?? 0)) / 2;
    const rotationAllowance = fwd * Math.sin(hdRad);
    return Math.max(0, raw - rotationAllowance);
  });
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  return { meanLatDiff: mean, maxLatDiff: Math.max(...diffs), count: pairs.length };
}

module.exports = {
  DEFAULT_ANCHOR_DISTANCES,
  interpolateAtForwardX,
  sampleLaneAnchors,
  sharedAnchorPairs,
  anchorLateralStats,
};
