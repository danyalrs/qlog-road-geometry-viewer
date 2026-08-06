/** Spatial binning and confidence-weighted geometry fusion — per chunk only. */

const { orderPointsAlongTrajectory, splitPolylineByGap, projectOntoTrajectory } = require('./geometry_sanity');

function alongTrackBinKey(point, trajectory, interval) {
  if (!trajectory?.length) {
    const bx = Math.round(point.east / interval);
    const by = Math.round(point.north / interval);
    return `${bx},${by}`;
  }
  const s = projectOntoTrajectory(trajectory, point);
  return String(Math.round(s / interval));
}

function fuseLaneObservations(observations, trajectory, options = {}) {
  const interval = options.fusionIntervalM ?? 2.0;
  const maxGap = options.maxLaneFragmentGapM ?? 10;
  const bins = new Map();

  for (const obs of observations) {
    for (const pt of obs.points) {
      const key = `${obs.laneIndex ?? 0}:${alongTrackBinKey(pt, trajectory, interval)}`;
      const entry = bins.get(key) || {
        laneIndex: obs.laneIndex,
        eastSum: 0, northSum: 0, weightSum: 0, count: 0,
      };
      const w = obs.prob ?? 1;
      entry.eastSum += pt.east * w;
      entry.northSum += pt.north * w;
      entry.weightSum += w;
      entry.count++;
      bins.set(key, entry);
    }
  }

  const byLane = new Map();
  for (const entry of bins.values()) {
    if (entry.weightSum <= 0) continue;
    const lane = entry.laneIndex ?? 0;
    if (!byLane.has(lane)) byLane.set(lane, []);
    byLane.get(lane).push({
      east: entry.eastSum / entry.weightSum,
      north: entry.northSum / entry.weightSum,
      count: entry.count,
    });
  }

  const fused = [];
  for (const [laneIndex, pts] of byLane) {
    const ordered = orderPointsAlongTrajectory(pts, trajectory);
    const fragments = splitPolylineByGap(ordered, maxGap);
    fragments.forEach((fragment, fragIdx) => {
      fused.push({ laneIndex, fragmentIndex: fragIdx, points: fragment });
    });
  }
  return fused;
}

function fuseRoadEdges(edgeObservations, trajectory, options = {}) {
  const interval = options.fusionIntervalM ?? 2.0;
  const maxGap = options.maxRoadEdgeGapM ?? 10;
  const bins = new Map();

  for (const obs of edgeObservations) {
    for (const pt of obs.points) {
      const key = `${obs.edgeIndex ?? 0}:${alongTrackBinKey(pt, trajectory, interval)}`;
      const entry = bins.get(key) || { edgeIndex: obs.edgeIndex, eastSum: 0, northSum: 0, n: 0 };
      entry.eastSum += pt.east;
      entry.northSum += pt.north;
      entry.n += 1;
      bins.set(key, entry);
    }
  }

  const byEdge = new Map();
  for (const e of bins.values()) {
    const idx = e.edgeIndex ?? 0;
    if (!byEdge.has(idx)) byEdge.set(idx, []);
    byEdge.get(idx).push({ east: e.eastSum / e.n, north: e.northSum / e.n });
  }

  const fused = [];
  for (const [edgeIndex, pts] of byEdge) {
    const ordered = orderPointsAlongTrajectory(pts, trajectory);
    const fragments = splitPolylineByGap(ordered, maxGap);
    fragments.forEach((fragment, fragIdx) => {
      fused.push({ edgeIndex, fragmentIndex: fragIdx, points: fragment });
    });
  }
  return fused;
}

function estimateCentreLine(fusedLanes) {
  if (!fusedLanes.length) return [];

  const byLane = new Map();
  for (const lane of fusedLanes) {
    const laneKey = lane.laneIndex ?? 0;
    if (!byLane.has(laneKey)) byLane.set(laneKey, []);
    byLane.get(laneKey).push(lane);
  }

  const laneKeys = [...byLane.keys()].sort((a, b) => a - b);
  if (laneKeys.length < 2) {
    const only = fusedLanes[0];
    return only ? [{
      fragmentIndex: only.fragmentIndex ?? 0,
      laneIndex: only.laneIndex,
      points: only.points.map((p) => ({ ...p, estimated: true })),
    }] : [];
  }

  const midIdx = Math.floor(laneKeys.length / 2);
  const leftKey = laneKeys[midIdx - 1] ?? laneKeys[midIdx];
  const rightKey = laneKeys[midIdx] ?? laneKeys[midIdx + 1];
  const leftLanes = byLane.get(leftKey) || [];
  const rightLanes = byLane.get(rightKey) || [];
  const centreLines = [];

  for (const left of leftLanes) {
    const right = rightLanes.find((r) => r.fragmentIndex === left.fragmentIndex) || rightLanes[0];
    if (!right) continue;
    const len = Math.min(left.points.length, right.points.length);
    if (len < 2) continue;
    const pts = [];
    for (let i = 0; i < len; i++) {
      pts.push({
        east: (left.points[i].east + right.points[i].east) / 2,
        north: (left.points[i].north + right.points[i].north) / 2,
        estimated: true,
      });
    }
    centreLines.push({
      fragmentIndex: left.fragmentIndex ?? 0,
      laneIndex: leftKey,
      points: pts,
    });
  }
  return centreLines;
}

module.exports = {
  fuseLaneObservations,
  fuseRoadEdges,
  estimateCentreLine,
};
