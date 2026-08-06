/**
 * Transform modelV2 vehicle-relative coordinates to local east/north.
 * Convention: x = forward (m), y = left (m), z = up (m).
 * Bearing θ is clockwise from north (degrees).
 *
 * east  = vehicleEast  + x * sin(θ) - y * cos(θ)
 * north = vehicleNorth + x * cos(θ) + y * sin(θ)
 */

const DEG2RAD = Math.PI / 180;

function modelToGlobal(x, y, vehicleEast, vehicleNorth, bearingDeg) {
  const theta = bearingDeg * DEG2RAD;
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  return {
    east: vehicleEast + x * sinT - y * cosT,
    north: vehicleNorth + x * cosT + y * sinT,
  };
}

function transformXyztLine(line, pose, options = {}) {
  const maxForward = options.maxForwardM ?? 120;
  const minProb = options.minLaneProb ?? 0.5;
  const prob = line.prob ?? 1;
  if (prob < minProb) return null;

  const xs = line.x || [];
  const ys = line.y || [];
  const zs = line.z || [];
  const ts = line.t || [];
  if (!xs.length || xs.length !== ys.length) return null;

  const points = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const y = ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < -5 || x > maxForward) continue;
    const g = modelToGlobal(x, y, pose.east, pose.north, pose.headingDeg);
    points.push({
      east: g.east,
      north: g.north,
      modelX: x,
      modelY: y,
      modelZ: zs[i] ?? 0,
      t: ts[i] ?? 0,
    });
  }
  if (points.length < 2) return null;
  return { points, prob, laneIndex: line.laneIndex };
}

function extractModelGeometry(modelV2, options = {}) {
  const minProb = options.minLaneProb ?? 0.5;
  const laneLines = [];
  const roadEdges = [];
  const probs = modelV2.laneLineProbs || [];
  const lines = modelV2.laneLines || [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const x = line.x || [];
    const y = line.y || [];
    if (!x.length || x.length !== y.length) continue;
    laneLines.push({
      laneIndex: i,
      prob: probs[i] ?? 0,
      x, y,
      z: line.z || [],
      t: line.t || [],
      xStd: line.xStd || [],
      yStd: line.yStd || [],
    });
  }

  const edgeStds = modelV2.roadEdgeStds || [];
  const edges = modelV2.roadEdges || [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (!e) continue;
    roadEdges.push({
      edgeIndex: i,
      // roadEdgeStds are spatial uncertainty (metres), not classification scores
      std: edgeStds[i] ?? 0,
      prob: 1,
      x: e.x || [],
      y: e.y || [],
      z: e.z || [],
      t: e.t || [],
    });
  }

  const position = modelV2.position || null;
  let path = null;
  if (position && position.x && position.x.length) {
    path = {
      x: position.x,
      y: position.y || [],
      z: position.z || [],
      t: position.t || [],
    };
  }

  return {
    frameId: modelV2.frameId,
    timestampEof: modelV2.timestampEof,
    laneLines: laneLines.filter((l) => l.prob >= minProb),
    roadEdges,
    path,
    meta: modelV2.meta || null,
  };
}

function transformFrameGeometry(geometry, pose, options = {}) {
  const lanes = [];
  for (const line of geometry.laneLines) {
    const t = transformXyztLine(line, pose, options);
    if (t) lanes.push(t);
  }
  const edges = [];
  for (const edge of geometry.roadEdges) {
    const t = transformXyztLine({ ...edge, prob: edge.prob }, pose, options);
    if (t) edges.push({ ...t, edgeIndex: edge.edgeIndex });
  }
  let path = null;
  if (geometry.path) {
    path = transformXyztLine({ ...geometry.path, prob: 1, laneIndex: -1 }, pose, options);
  }
  return { lanes, edges, path, frameId: geometry.frameId };
}

module.exports = {
  modelToGlobal,
  transformXyztLine,
  extractModelGeometry,
  transformFrameGeometry,
};
