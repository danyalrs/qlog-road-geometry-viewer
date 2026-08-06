'use strict';

const PROGRESS_FIELDS = ['totalPairs', 'completed', 'pending', 'positive', 'negative', 'unresolved'];

/** Observation ID schema: segmentId:chunkId:logMonoTime:sourceSlotIndex */
const OBSERVATION_ID_RE = /^\d+:\d+:\d+:\d+$/;

const TARGET_LANE_COLOR = '#e879f9';
const NON_TARGET_LANE_COLOR = '#64748b';
const ROAD_EDGE_COLOR = '#f97316';

function normalizeProgress(apiProgress) {
  const p = apiProgress || {};
  const totalPairs = p.totalPairs ?? p.total ?? 0;
  const completed = p.completed ?? 0;
  return {
    totalPairs,
    completed,
    pending: p.pending ?? Math.max(0, totalPairs - completed),
    positive: p.positive ?? 0,
    negative: p.negative ?? 0,
    unresolved: p.unresolved ?? 0,
  };
}

/**
 * Parse endpoint observation ID. sourceSlotIndex is the Stage 16 modelV2 laneLines
 * slot, which equals processRoute laneIndex — not inferred from array order alone.
 */
function parseObservationEndpoint(observationId) {
  if (!observationId || typeof observationId !== 'string' || !OBSERVATION_ID_RE.test(observationId)) {
    return null;
  }
  const [segmentId, chunkId, logMonoTime, sourceSlotIndex] = observationId.split(':');
  return {
    observationId,
    segmentId: Number(segmentId),
    chunkId: Number(chunkId),
    logMonoTime,
    sourceSlotIndex: Number(sourceSlotIndex),
  };
}

function formatPairTitle(pair) {
  if (!pair) return '—';
  const parsedA = parseObservationEndpoint(pair.observationIdA);
  const parsedB = parseObservationEndpoint(pair.observationIdB);
  const seg = pair.segmentId != null ? `Segment ${pair.segmentId}` : 'Segment ?';
  const slotA = parsedA ? parsedA.sourceSlotIndex : '?';
  const slotB = parsedB ? parsedB.sourceSlotIndex : '?';
  return `${seg} · pair ${pair.reviewPairId || '?'} · slot ${slotA} → ${slotB}`;
}

function formatPairIdentity(pair) {
  const parsedA = parseObservationEndpoint(pair?.observationIdA);
  const parsedB = parseObservationEndpoint(pair?.observationIdB);
  return {
    reviewPairId: pair?.reviewPairId ?? null,
    observationIdA: pair?.observationIdA ?? null,
    observationIdB: pair?.observationIdB ?? null,
    sourceSlotIndexA: parsedA?.sourceSlotIndex ?? null,
    sourceSlotIndexB: parsedB?.sourceSlotIndex ?? null,
    logMonoTimeA: parsedA?.logMonoTime ?? pair?.logMonoTimeA ?? null,
    logMonoTimeB: parsedB?.logMonoTime ?? pair?.logMonoTimeB ?? null,
  };
}

function pointXY(p) {
  if (!p || typeof p !== 'object') return null;
  const x = Number.isFinite(p.east) ? p.east : (Number.isFinite(p.modelX) ? p.modelX : null);
  const y = Number.isFinite(p.north) ? p.north : (Number.isFinite(p.modelY) ? -p.modelY : null);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function finitePoints(points) {
  const out = [];
  for (const p of points || []) {
    const xy = pointXY(p);
    if (xy) out.push(xy);
  }
  return out;
}

function analyzeFrameGeometry(frame) {
  let laneLineCount = 0;
  let roadEdgeCount = 0;
  let pointCount = 0;

  for (const lane of frame?.laneLines || []) {
    const pts = finitePoints(lane.points);
    pointCount += pts.length;
    if (pts.length >= 2) laneLineCount += 1;
  }
  for (const edge of frame?.roadEdges || []) {
    const pts = finitePoints(edge.points);
    pointCount += pts.length;
    if (pts.length >= 2) roadEdgeCount += 1;
  }

  const drawableLineCount = laneLineCount + roadEdgeCount;
  return {
    laneLineCount,
    roadEdgeCount,
    pointCount,
    drawableLineCount,
    hasDrawable: drawableLineCount > 0,
  };
}

function serializePlaybackFrame(frame, index) {
  const laneLines = (frame.lanes || frame.laneLines || []).map((lane) => ({
    laneIndex: lane.laneIndex,
    prob: lane.prob,
    points: (lane.points || []).slice(0, 40).map((p) => ({
      east: p.east,
      north: p.north,
      modelX: p.modelX,
      modelY: p.modelY,
    })),
  }));
  const roadEdges = (frame.edges || frame.roadEdges || []).map((edge) => ({
    edgeIndex: edge.edgeIndex,
    points: (edge.points || []).slice(0, 40).map((p) => ({
      east: p.east,
      north: p.north,
      modelX: p.modelX,
      modelY: p.modelY,
    })),
  }));
  return {
    index,
    logMonoTime: String(frame.logMonoTime),
    chunkId: frame.chunkId,
    passId: frame.passId ?? frame.temporalPassId,
    laneLines,
    roadEdges,
  };
}

function computeBounds(frame) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;

  const ingest = (points) => {
    for (const p of finitePoints(points)) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
      count += 1;
    }
  };

  for (const lane of frame?.laneLines || []) ingest(lane.points);
  for (const edge of frame?.roadEdges || []) ingest(edge.points);

  if (!count) return null;
  return { minX, minY, maxX, maxY, count };
}

function findLaneBySourceSlot(frame, sourceSlotIndex) {
  if (sourceSlotIndex == null || !Number.isFinite(sourceSlotIndex)) return null;
  const lanes = frame?.laneLines || [];
  for (const lane of lanes) {
    if (lane.laneIndex === sourceSlotIndex) return lane;
  }
  return null;
}

/**
 * Resolve which endpoint target applies to the current playback frame.
 * Frame A uses Observation A's sourceSlotIndex; Frame B uses Observation B's.
 */
function resolveActiveTarget(pair, payload, frameIndex) {
  const identity = formatPairIdentity(pair);
  const frame = payload?.frames?.[frameIndex] ?? null;
  if (!frame || !payload) {
    return {
      ok: false,
      error: 'playback_frame_unavailable',
      identity,
      endpoint: null,
      sourceSlotIndex: null,
      laneIndex: null,
      targetFound: false,
    };
  }

  const idxA = payload.suggestedFrameIndexA;
  const idxB = payload.suggestedFrameIndexB;
  let endpoint = null;
  let sourceSlotIndex = null;
  let observationId = null;

  if (frameIndex === idxA) {
    endpoint = 'A';
    sourceSlotIndex = identity.sourceSlotIndexA;
    observationId = identity.observationIdA;
  } else if (frameIndex === idxB) {
    endpoint = 'B';
    sourceSlotIndex = identity.sourceSlotIndexB;
    observationId = identity.observationIdB;
  } else if (String(frame.logMonoTime) === String(identity.logMonoTimeA)) {
    endpoint = 'A';
    sourceSlotIndex = identity.sourceSlotIndexA;
    observationId = identity.observationIdA;
  } else if (String(frame.logMonoTime) === String(identity.logMonoTimeB)) {
    endpoint = 'B';
    sourceSlotIndex = identity.sourceSlotIndexB;
    observationId = identity.observationIdB;
  } else {
    return {
      ok: false,
      error: 'current_frame_is_not_pair_endpoint',
      identity,
      endpoint: null,
      sourceSlotIndex: null,
      laneIndex: null,
      observationId: null,
      targetFound: false,
      message: 'Navigate to Frame A or Frame B to judge this pair',
    };
  }

  if (sourceSlotIndex == null) {
    return {
      ok: false,
      error: 'observation_id_unparseable',
      identity,
      endpoint,
      sourceSlotIndex: null,
      laneIndex: null,
      observationId,
      targetFound: false,
      message: `Cannot parse sourceSlotIndex from Observation ${endpoint}`,
    };
  }

  const lane = findLaneBySourceSlot(frame, sourceSlotIndex);
  if (!lane || finitePoints(lane.points).length < 2) {
    return {
      ok: false,
      error: 'target_lane_not_found_in_frame',
      identity,
      endpoint,
      sourceSlotIndex,
      laneIndex: sourceSlotIndex,
      observationId,
      targetFound: false,
      message: `Target Observation ${endpoint} slot ${sourceSlotIndex} not found in frame geometry`,
    };
  }

  return {
    ok: true,
    error: null,
    identity,
    endpoint,
    sourceSlotIndex,
    laneIndex: sourceSlotIndex,
    observationId,
    targetFound: true,
    message: null,
  };
}

/**
 * Validate both endpoints can be mapped in their respective frames.
 */
function resolvePairTargetMapping(pair, payload) {
  const identity = formatPairIdentity(pair);
  const issues = [];
  if (identity.sourceSlotIndexA == null) {
    issues.push({ endpoint: 'A', error: 'observation_id_unparseable', observationId: identity.observationIdA });
  }
  if (identity.sourceSlotIndexB == null) {
    issues.push({ endpoint: 'B', error: 'observation_id_unparseable', observationId: identity.observationIdB });
  }

  const frameA = payload?.frames?.[payload.suggestedFrameIndexA];
  const frameB = payload?.frames?.[payload.suggestedFrameIndexB];
  if (!frameA) issues.push({ endpoint: 'A', error: 'frame_a_unavailable' });
  if (!frameB) issues.push({ endpoint: 'B', error: 'frame_b_unavailable' });

  let laneA = null;
  let laneB = null;
  if (frameA && identity.sourceSlotIndexA != null) {
    laneA = findLaneBySourceSlot(frameA, identity.sourceSlotIndexA);
    if (!laneA || finitePoints(laneA.points).length < 2) {
      issues.push({
        endpoint: 'A',
        error: 'target_lane_not_found_in_frame',
        sourceSlotIndex: identity.sourceSlotIndexA,
      });
    }
  }
  if (frameB && identity.sourceSlotIndexB != null) {
    laneB = findLaneBySourceSlot(frameB, identity.sourceSlotIndexB);
    if (!laneB || finitePoints(laneB.points).length < 2) {
      issues.push({
        endpoint: 'B',
        error: 'target_lane_not_found_in_frame',
        sourceSlotIndex: identity.sourceSlotIndexB,
      });
    }
  }

  return {
    ok: issues.length === 0,
    identity,
    issues,
    frameIndexA: payload?.suggestedFrameIndexA ?? null,
    frameIndexB: payload?.suggestedFrameIndexB ?? null,
    sourceSlotIndexA: identity.sourceSlotIndexA,
    sourceSlotIndexB: identity.sourceSlotIndexB,
    targetLaneIndexA: laneA ? identity.sourceSlotIndexA : null,
    targetLaneIndexB: laneB ? identity.sourceSlotIndexB : null,
  };
}

function buildDrawPlan(frame, width, height, options = {}) {
  const stats = analyzeFrameGeometry(frame);
  const targetLaneIndex = options.targetLaneIndex;
  const hasExplicitTarget = targetLaneIndex != null && Number.isFinite(targetLaneIndex);

  if (!stats.hasDrawable) {
    return {
      stats,
      hasDrawable: false,
      targetFound: false,
      message: 'No drawable lane-model geometry in this frame',
      paths: [],
      transform: null,
    };
  }

  const bounds = computeBounds(frame);
  if (!bounds) {
    return {
      stats,
      hasDrawable: false,
      targetFound: false,
      message: 'Geometry points are not finite — cannot render',
      paths: [],
      transform: null,
    };
  }

  const pad = 30;
  const rangeX = Math.max(bounds.maxX - bounds.minX, 1);
  const rangeY = Math.max(bounds.maxY - bounds.minY, 1);
  const scale = Math.min((width - pad * 2) / rangeX, (height - pad * 2) / rangeY);
  const midX = (bounds.minX + bounds.maxX) / 2;
  const midY = (bounds.minY + bounds.maxY) / 2;

  const toScreen = (p) => ({
    x: width / 2 + (p.x - midX) * scale,
    y: height / 2 - (p.y - midY) * scale,
  });

  const mutedPaths = [];
  const targetPaths = [];
  let targetFound = false;

  for (const lane of frame.laneLines || []) {
    const pts = finitePoints(lane.points);
    if (pts.length < 2) continue;
    const isTarget = hasExplicitTarget && lane.laneIndex === targetLaneIndex;
    const path = {
      role: isTarget ? 'target' : 'non_target',
      laneIndex: lane.laneIndex,
      color: isTarget ? TARGET_LANE_COLOR : (hasExplicitTarget ? NON_TARGET_LANE_COLOR : '#38bdf8'),
      width: isTarget ? 4 : (hasExplicitTarget ? 1.25 : 2),
      muted: hasExplicitTarget && !isTarget,
      points: pts.map(toScreen),
    };
    if (isTarget) {
      targetFound = true;
      targetPaths.push(path);
    } else {
      mutedPaths.push(path);
    }
  }

  for (const edge of frame.roadEdges || []) {
    const pts = finitePoints(edge.points);
    if (pts.length < 2) continue;
    mutedPaths.push({
      role: 'road_edge',
      laneIndex: edge.edgeIndex ?? null,
      color: ROAD_EDGE_COLOR,
      width: 1.5,
      muted: false,
      points: pts.map(toScreen),
    });
  }

  // Draw muted first, target last so highlight is on top.
  const paths = mutedPaths.concat(targetPaths);

  if (hasExplicitTarget && !targetFound) {
    return {
      stats,
      hasDrawable: paths.length > 0,
      targetFound: false,
      message: `Target laneIndex ${targetLaneIndex} not present in this frame`,
      paths,
      transform: { scale, midX, midY, bounds },
      targetLaneIndex,
    };
  }

  return {
    stats,
    hasDrawable: paths.length > 0,
    targetFound: hasExplicitTarget ? targetFound : null,
    message: null,
    paths,
    transform: { scale, midX, midY, bounds },
    targetLaneIndex: hasExplicitTarget ? targetLaneIndex : null,
  };
}

function canSubmitReviewLabel({
  evidenceLoaded,
  hasDrawable,
  label,
  evidenceMode,
  targetMapped = true,
}) {
  if (label === 'unresolved') {
    return evidenceLoaded || evidenceMode === 'insufficient';
  }
  if (label === 'positive_continuation' || label === 'negative_non_continuation') {
    if (evidenceMode === 'insufficient') return false;
    return evidenceLoaded && hasDrawable && targetMapped;
  }
  return false;
}

function clampFrameIndex(frameIndex, frameCount) {
  if (!frameCount) return 0;
  return Math.max(0, Math.min(frameCount - 1, frameIndex));
}

function navigationFrameIndex(action, currentIndex, payload) {
  const count = payload?.frames?.length || 0;
  if (!count) return 0;
  switch (action) {
    case 'prev':
      return clampFrameIndex(currentIndex - 1, count);
    case 'next':
      return clampFrameIndex(currentIndex + 1, count);
    case 'frameA':
      return clampFrameIndex(payload.suggestedFrameIndexA ?? 0, count);
    case 'frameB':
      return clampFrameIndex(payload.suggestedFrameIndexB ?? 0, count);
    default:
      return clampFrameIndex(currentIndex, count);
  }
}

/** Dependency-ordered names required when inlining helpers for the browser bundle. */
const BROWSER_PLAYBACK_BUNDLE_ORDER = [
  'normalizeProgress',
  'parseObservationEndpoint',
  'formatPairTitle',
  'formatPairIdentity',
  'pointXY',
  'finitePoints',
  'analyzeFrameGeometry',
  'computeBounds',
  'findLaneBySourceSlot',
  'resolveActiveTarget',
  'resolvePairTargetMapping',
  'buildDrawPlan',
  'canSubmitReviewLabel',
  'clampFrameIndex',
  'navigationFrameIndex',
];

const BROWSER_PLAYBACK_PUBLIC_API = [
  'normalizeProgress',
  'parseObservationEndpoint',
  'formatPairTitle',
  'formatPairIdentity',
  'analyzeFrameGeometry',
  'findLaneBySourceSlot',
  'resolveActiveTarget',
  'resolvePairTargetMapping',
  'buildDrawPlan',
  'canSubmitReviewLabel',
  'navigationFrameIndex',
  'clampFrameIndex',
  'TARGET_LANE_COLOR',
  'NON_TARGET_LANE_COLOR',
  'ROAD_EDGE_COLOR',
];

function buildBrowserPlaybackScript(api = null) {
  const playback = api || module.exports;
  const defs = BROWSER_PLAYBACK_BUNDLE_ORDER
    .map((name) => {
      const fn = playback[name];
      if (typeof fn !== 'function') {
        throw new Error(`missing browser playback helper: ${name}`);
      }
      return `const ${name} = ${fn.toString()};`;
    })
    .join('\n\n');
  const constants = [
    `const TARGET_LANE_COLOR = ${JSON.stringify(TARGET_LANE_COLOR)};`,
    `const NON_TARGET_LANE_COLOR = ${JSON.stringify(NON_TARGET_LANE_COLOR)};`,
    `const ROAD_EDGE_COLOR = ${JSON.stringify(ROAD_EDGE_COLOR)};`,
    `const OBSERVATION_ID_RE = ${OBSERVATION_ID_RE.toString()};`,
  ].join('\n');
  return `${constants}\n\n${defs}\nwindow.BMotionPlayback = { ${BROWSER_PLAYBACK_PUBLIC_API.join(', ')} };\n`;
}

module.exports = {
  PROGRESS_FIELDS,
  OBSERVATION_ID_RE,
  TARGET_LANE_COLOR,
  NON_TARGET_LANE_COLOR,
  ROAD_EDGE_COLOR,
  normalizeProgress,
  parseObservationEndpoint,
  formatPairTitle,
  formatPairIdentity,
  pointXY,
  finitePoints,
  analyzeFrameGeometry,
  serializePlaybackFrame,
  computeBounds,
  findLaneBySourceSlot,
  resolveActiveTarget,
  resolvePairTargetMapping,
  buildDrawPlan,
  canSubmitReviewLabel,
  clampFrameIndex,
  navigationFrameIndex,
  BROWSER_PLAYBACK_BUNDLE_ORDER,
  BROWSER_PLAYBACK_PUBLIC_API,
  buildBrowserPlaybackScript,
};
