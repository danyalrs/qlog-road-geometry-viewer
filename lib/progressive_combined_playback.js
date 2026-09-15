'use strict';

const crypto = require('crypto');
const VDC = require('./viewer_display_corrections');
const CBAO = require('./combined_boundary_anchored_orientation');
const CST = require('./combined_source_transform');
const CRB = require('./combined_route_boundary_bridge');

/**
 * Bounded opt-in progressive combined playback helpers.
 * Default-off via progressiveCombinedPlaybackCandidate URL flag.
 */

function parseProgressiveCombinedPlaybackCandidate(search = '') {
  const raw = String(search ?? '');
  const query = raw.startsWith('?') ? raw.slice(1) : raw;
  const params = new URLSearchParams(query);
  const value = params.get('progressiveCombinedPlaybackCandidate');
  if (value === '1') return true;
  if (value === '0') return false;
  return false;
}

function segmentNumericId(filename) {
  const match = String(filename ?? '').match(/^qlog_f449c_(\d+)\.bz2$/i);
  return match ? parseInt(match[1], 10) : NaN;
}

function orderPrefixFiles(files, availableOrdered = null) {
  const unique = [...new Set((files || []).filter(Boolean))];
  const orderMap = Array.isArray(availableOrdered)
    ? new Map(availableOrdered.map((f, i) => [f, i]))
    : null;
  return unique.sort((a, b) => {
    const ida = segmentNumericId(a);
    const idb = segmentNumericId(b);
    if (Number.isFinite(ida) && Number.isFinite(idb) && ida !== idb) return ida - idb;
    if (orderMap) return (orderMap.get(a) ?? 9999) - (orderMap.get(b) ?? 9999);
    return String(a).localeCompare(String(b));
  });
}

function resolveNextAvailableSegment(availableOrdered, prefix) {
  const list = orderPrefixFiles(availableOrdered, availableOrdered);
  const current = orderPrefixFiles(prefix, list);
  const prefixSet = new Set(current);
  if (!current.length) return list[0] ?? null;

  const lastId = segmentNumericId(current[current.length - 1]);
  let best = null;
  let bestId = Infinity;
  for (const file of list) {
    if (prefixSet.has(file)) continue;
    const id = segmentNumericId(file);
    if (!Number.isFinite(lastId) || !Number.isFinite(id)) continue;
    if (id > lastId && id < bestId) {
      best = file;
      bestId = id;
    }
  }
  return best;
}

function findLastTimelineIndexForSource(timeline, sourceFile) {
  if (!timeline?.length || !sourceFile) return 0;
  let last = 0;
  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i].sourceFile === sourceFile) last = i;
  }
  return last;
}

function findFirstTimelineIndexForSource(timeline, sourceFile) {
  if (!timeline?.length || !sourceFile) return 0;
  const idx = timeline.findIndex((t) => t.sourceFile === sourceFile);
  return idx >= 0 ? idx : 0;
}

function initialVisibleTimelineIndex(timeline, visiblePrefix) {
  const first = orderPrefixFiles(visiblePrefix)[0];
  return findFirstTimelineIndexForSource(timeline, first);
}

function mapPreservedTimelineIndex(newTimeline, priorTimeline, priorIndex) {
  if (!newTimeline?.length) return 0;
  if (!priorTimeline?.length) return 0;
  const safePrior = clampTimelineIndex(priorTimeline, priorIndex);
  const entry = priorTimeline[safePrior];
  if (!entry) return 0;
  const mapped = newTimeline.findIndex(
    (t) => t.sourceFile === entry.sourceFile && t.logMonoTime === entry.logMonoTime,
  );
  if (mapped >= 0) return mapped;
  const fallback = newTimeline.findIndex(
    (t) => t.sourceFile === entry.sourceFile && t.frameId === entry.frameId,
  );
  if (fallback >= 0) return fallback;
  return clampTimelineIndex(newTimeline, safePrior);
}

function clampTimelineIndex(timeline, idx) {
  if (!timeline?.length) return 0;
  const max = timeline.length - 1;
  const n = Number(idx);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(0, Math.trunc(n)), max);
}

function roundCoord(value) {
  if (!Number.isFinite(value)) return 'null';
  return Number(value).toFixed(4);
}

function perSourcePlacedPayloads(map, sourceFiles) {
  const out = {};
  const trajectory = map?.trajectory || [];
  for (const sourceFile of sourceFiles || []) {
    const payload = trajectory
      .filter((p) => p.sourceFile === sourceFile)
      .map((p) => [
        p.frameId ?? null,
        roundCoord(p.placedEast ?? p.east),
        roundCoord(p.placedNorth ?? p.north),
      ]);
    out[sourceFile] = JSON.stringify(payload);
  }
  return out;
}

function perSourcePlacedChecksums(map, sourceFiles) {
  const payloads = perSourcePlacedPayloads(map, sourceFiles);
  const out = {};
  for (const [sourceFile, payload] of Object.entries(payloads)) {
    out[sourceFile] = crypto.createHash('sha256').update(payload).digest('hex');
  }
  return out;
}

function verifyPrefixChecksumsStable(beforeChecksums, afterChecksums, prefixSources) {
  const mismatches = [];
  for (const sourceFile of prefixSources || []) {
    const before = beforeChecksums?.[sourceFile];
    const after = afterChecksums?.[sourceFile];
    if (before == null || after == null) {
      mismatches.push({ sourceFile, reason: 'missing_checksum' });
      continue;
    }
    if (before !== after) {
      mismatches.push({ sourceFile, before, after });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

function verifyPrefixPayloadsStable(beforePayloads, afterPayloads, prefixSources) {
  const mismatches = [];
  for (const sourceFile of prefixSources || []) {
    const before = beforePayloads?.[sourceFile];
    const after = afterPayloads?.[sourceFile];
    if (before == null || after == null) {
      mismatches.push({ sourceFile, reason: 'missing_payload' });
      continue;
    }
    if (before !== after) {
      mismatches.push({ sourceFile, before, after });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

function segmentDisplayLabel(sourceFile) {
  const id = segmentNumericId(sourceFile);
  return Number.isFinite(id) ? `Seg${id}` : String(sourceFile ?? '—');
}

function formatProgressiveStatusLabel(prefix, hiddenLookahead = null) {
  const ordered = orderPrefixFiles(prefix);
  if (!ordered.length) return 'Progressive combined range: (none)';
  const ids = ordered.map(segmentNumericId).filter((id) => Number.isFinite(id));
  const lo = ids[0];
  const hi = ids[ids.length - 1];
  const range = ids.length === 1 ? `Seg${lo}` : `Seg${lo}–Seg${hi}`;
  const base = `Progressive combined range: ${range} (${ordered.length} sources)`;
  if (hiddenLookahead) {
    return `${base} | Next prepared: ${segmentDisplayLabel(hiddenLookahead)}`;
  }
  return base;
}

function buildLookaheadProcessList(visiblePrefix, availableOrdered) {
  const visible = orderPrefixFiles(visiblePrefix, availableOrdered);
  const hidden = resolveNextAvailableSegment(availableOrdered, visible);
  return hidden ? [...visible, hidden] : visible;
}

function isVisibleTrajectoryPoint(point, visibleSet) {
  if (!point) return false;
  if (visibleSet.has(point.sourceFile)) return true;
  if (point.bridgeSection) {
    return visibleSet.has(point.bridgeFromSourceFile) && visibleSet.has(point.bridgeToSourceFile);
  }
  return false;
}

function isVisiblePolygon(poly, visibleSet) {
  if (!poly) return false;
  if (poly.fragmentKind === 'combinedRouteBoundaryBridge') {
    const from = poly.bridgeProvenance?.fromSourceFile;
    const to = poly.bridgeProvenance?.toSourceFile;
    return visibleSet.has(from) && visibleSet.has(to);
  }
  const sf = poly.sourceFile ?? null;
  return !sf || visibleSet.has(sf);
}

function collectCoordPoints(map, visibleSet = null) {
  const pts = [];
  const add = (p) => {
    if (!p) return;
    if (visibleSet && p.sourceFile && !visibleSet.has(p.sourceFile) && !p.bridgeSection) return;
    const e = p.placedEast ?? p.east;
    const n = p.placedNorth ?? p.north;
    if (Number.isFinite(e) && Number.isFinite(n)) pts.push({ east: e, north: n, sourceFile: p.sourceFile });
  };
  for (const p of map?.trajectory || []) {
    if (!visibleSet || isVisibleTrajectoryPoint(p, visibleSet)) add(p);
  }
  for (const p of map?.pointAccumulated?.points || []) {
    if (!visibleSet || visibleSet.has(p.sourceFile)) add(p);
  }
  return pts;
}

function computeVisibleFitBounds(map, visibleSources) {
  const visibleSet = new Set(orderPrefixFiles(visibleSources));
  const pts = collectCoordPoints(map, visibleSet);
  if (!pts.length) return map?.fitBounds ?? map?.bounds ?? null;
  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (const p of pts) {
    minE = Math.min(minE, p.east);
    maxE = Math.max(maxE, p.east);
    minN = Math.min(minN, p.north);
    maxN = Math.max(maxN, p.north);
  }
  return {
    minE, maxE, minN, maxN,
    finite: Number.isFinite(minE) && Number.isFinite(maxE) && Number.isFinite(minN) && Number.isFinite(maxN),
  };
}

function filterTimelineToVisibleSources(timeline, visibleSources) {
  const visibleSet = new Set(orderPrefixFiles(visibleSources));
  return (timeline || []).filter((t) => visibleSet.has(t.sourceFile));
}

function filterProcessDataToVisibleSources(processData, visibleSources) {
  if (!processData) return processData;
  const visibleSet = new Set(orderPrefixFiles(visibleSources));
  const keepIndices = [];
  for (let i = 0; i < (processData.timeline || []).length; i++) {
    if (visibleSet.has(processData.timeline[i]?.sourceFile)) keepIndices.push(i);
  }
  return {
    ...processData,
    timeline: keepIndices.map((i) => processData.timeline[i]),
    frames: keepIndices.map((i) => processData.frames[i]),
  };
}

function filterMapToVisibleSources(map, visibleSources) {
  if (!map) return map;
  const visibleSet = new Set(orderPrefixFiles(visibleSources));
  const filtered = {
    ...map,
    trajectory: (map.trajectory || []).filter((p) => isVisibleTrajectoryPoint(p, visibleSet)),
    laneFragments: (map.laneFragments || []).filter((f) => visibleSet.has(f.sourceFile)),
    edgeFragments: (map.edgeFragments || []).filter((f) => visibleSet.has(f.sourceFile)),
    roadSurfacePolygons: (map.roadSurfacePolygons || []).filter((p) => isVisiblePolygon(p, visibleSet)),
    progressiveVisibleSources: [...visibleSet],
    progressiveHiddenLookaheadActive: true,
  };
  if (map.pointAccumulated) {
    filtered.pointAccumulated = {
      ...map.pointAccumulated,
      points: (map.pointAccumulated.points || []).filter((p) => visibleSet.has(p.sourceFile)),
      rejected: (map.pointAccumulated.rejected || []).filter((p) => visibleSet.has(p.sourceFile)),
    };
  }
  if (map.sourceTransformByFile) {
    filtered.sourceTransformByFile = Object.fromEntries(
      Object.entries(map.sourceTransformByFile).filter(([sf]) => visibleSet.has(sf)),
    );
  }
  filtered.fitBounds = computeVisibleFitBounds(map, visibleSources);
  filtered.bounds = filtered.fitBounds;
  return filtered;
}

function findHiddenGeometryLeaks(displayMap, visibleSources, hiddenSource) {
  if (!hiddenSource) return [];
  const visibleSet = new Set(orderPrefixFiles(visibleSources));
  const leaks = [];
  const checkPoints = (items, layer) => {
    for (const p of items || []) {
      if (p.sourceFile === hiddenSource) leaks.push({ layer, kind: 'sourceFile', sourceFile: p.sourceFile });
      if (p.bridgeSection && (p.bridgeToSourceFile === hiddenSource || p.bridgeFromSourceFile === hiddenSource)) {
        leaks.push({ layer, kind: 'bridge', sourceFile: hiddenSource });
      }
    }
  };
  checkPoints(displayMap?.trajectory, 'trajectory');
  checkPoints(displayMap?.pointAccumulated?.points, 'pointAccumulated.points');
  checkPoints(displayMap?.laneFragments?.flatMap((f) => f.points), 'laneFragments');
  for (const poly of displayMap?.roadSurfacePolygons || []) {
    if (poly.sourceFile === hiddenSource) leaks.push({ layer: 'roadSurfacePolygons', kind: 'sourceFile' });
    if (poly.bridgeProvenance?.toSourceFile === hiddenSource || poly.bridgeProvenance?.fromSourceFile === hiddenSource) {
      if (!visibleSet.has(poly.bridgeProvenance?.fromSourceFile) || !visibleSet.has(poly.bridgeProvenance?.toSourceFile)) {
        leaks.push({ layer: 'roadSurfacePolygons', kind: 'bridge', sourceFile: hiddenSource });
      }
    }
  }
  return leaks;
}

function buildInitialLookaheadDisplay(fullMap, fullProcessData, visiblePrefix, hiddenLookahead) {
  const visible = orderPrefixFiles(visiblePrefix);
  const displayMap = filterMapToVisibleSources(fullMap, visible);
  const displayProcessData = filterProcessDataToVisibleSources(fullProcessData, visible);
  const leaks = hiddenLookahead ? findHiddenGeometryLeaks(displayMap, visible, hiddenLookahead) : [];
  return {
    visiblePrefix: visible,
    hiddenLookahead,
    processPrefix: hiddenLookahead ? [...visible, hiddenLookahead] : visible,
    fullMap: snapshotFrozenMap(fullMap),
    displayMap: snapshotFrozenMap(displayMap),
    fullProcessData,
    displayProcessData,
    hiddenLeaks: leaks,
  };
}

function revealPreparedLookahead(state, { continuePlayback = false } = {}) {
  const prepared = state.hiddenLookahead;
  if (!prepared) return { ok: false, reason: 'noPreparedLookahead' };
  const visible = orderPrefixFiles(state.visiblePrefix);
  const newVisible = [...visible, prepared];
  const beforeVisibleChecksums = perSourcePlacedChecksums(state.fullMap, visible);
  const preparedChecksum = perSourcePlacedChecksums(state.fullMap, [prepared])[prepared];
  const displayMap = filterMapToVisibleSources(state.fullMap, newVisible);
  const afterVisibleChecksums = perSourcePlacedChecksums(state.fullMap, visible);
  const visibleStable = verifyPrefixPayloadsStable(beforeVisibleChecksums, afterVisibleChecksums, visible);
  const revealedChecksum = perSourcePlacedChecksums(displayMap, [prepared])[prepared];
  const displayProcessData = filterProcessDataToVisibleSources(state.fullProcessData, newVisible);
  const timelineIndex = continuePlayback
    ? findFirstTimelineIndexForSource(displayProcessData.timeline, prepared)
    : null;
  return {
    ok: visibleStable.ok && preparedChecksum === revealedChecksum,
    reason: visibleStable.ok ? null : 'visiblePrefixMovedDuringReveal',
    visiblePrefix: newVisible,
    hiddenLookahead: null,
    fullMap: state.fullMap,
    displayMap: snapshotFrozenMap(displayMap),
    fullProcessData: state.fullProcessData,
    displayProcessData,
    timelineIndex,
    preparedChecksum,
    revealedChecksum,
    visibleStable,
  };
}

function prepareNextHiddenLookahead(state, hiddenSource, freshBaseMap, processedData, options = {}) {
  const visible = orderPrefixFiles(state.visiblePrefix);
  const beforeDisplay = snapshotFrozenMap(state.displayMap);
  const beforeFull = snapshotFrozenMap(state.fullMap);
  const appendResult = applyProgressiveFrozenAppend(
    beforeFull,
    freshBaseMap,
    processedData,
    visible,
    hiddenSource,
    options,
  );
  if (!appendResult.ok) {
    return { ok: false, reason: appendResult.reason || 'lookaheadPrepareFailed', appendResult };
  }
  const fullMap = snapshotFrozenMap(appendResult.map);
  const afterDisplay = filterMapToVisibleSources(fullMap, visible);
  const verify = verifyFrozenPrefixUnchanged(beforeDisplay, afterDisplay, visible);
  if (!verify.ok) {
    return { ok: false, reason: 'visiblePrefixMovedDuringLookaheadPrepare', verify, appendResult };
  }
  const leaks = findHiddenGeometryLeaks(afterDisplay, visible, hiddenSource);
  return {
    ok: true,
    visiblePrefix: visible,
    hiddenLookahead: hiddenSource,
    processPrefix: [...visible, hiddenSource],
    fullMap,
    displayMap: beforeDisplay,
    fullProcessData: processedData,
    displayProcessData: state.displayProcessData,
    hiddenLeaks: leaks,
    appendResult,
  };
}

function simulateLegacyStandaloneAppendRotation(visiblePrefix, availableOrdered, { processPrefix, buildBaseMap }) {
  const visible = orderPrefixFiles(visiblePrefix, availableOrdered);
  const hidden = resolveNextAvailableSegment(availableOrdered, visible);
  if (!hidden) return { ok: false, reason: 'noHidden' };
  const standalone = buildBaseMap(processPrefix(visible));
  standalone.valid = true;
  const freshPd = processPrefix([...visible, hidden]);
  const append = applyProgressiveFrozenAppend(
    standalone,
    buildBaseMap(freshPd),
    freshPd,
    visible,
    hidden,
    { mirrorChecked: true },
  );
  const before = perSourcePlacedChecksums(standalone, visible);
  const after = perSourcePlacedChecksums(append.ok ? append.map : standalone, visible);
  const rotated = visible.some((sf) => before[sf] !== after[sf]);
  return { ok: true, rotated, before, after, hidden };
}

function resolveProgressiveTimelineIndex(timeline, {
  continuePlayback = false,
  enterSourceFile = null,
  anchorSourceFile = null,
  savedTimelineIndex = null,
} = {}) {
  if (!timeline?.length) return 0;
  if (continuePlayback && enterSourceFile) {
    return clampTimelineIndex(timeline, findFirstTimelineIndexForSource(timeline, enterSourceFile));
  }
  if (anchorSourceFile) {
    return clampTimelineIndex(timeline, findLastTimelineIndexForSource(timeline, anchorSourceFile));
  }
  if (savedTimelineIndex != null) {
    return clampTimelineIndex(timeline, savedTimelineIndex);
  }
  return 0;
}

function canRemoveLastSegment(prefix) {
  return Array.isArray(prefix) && prefix.length > 1;
}

function prefixSnapshotKey(prefix) {
  return orderPrefixFiles(prefix).join('|');
}

function tangentRadAtEnd(points) {
  const n = points.length;
  if (n < 2) return 0;
  const a = points[n - 2];
  const b = points[n - 1];
  return Math.atan2(
    (b.placedNorth ?? b.north) - (a.placedNorth ?? a.north),
    (b.placedEast ?? b.east) - (a.placedEast ?? a.east),
  );
}

function tangentRadAtStart(points) {
  if (points.length < 2) return 0;
  const a = points[0];
  const b = points[1];
  return Math.atan2(
    (b.placedNorth ?? b.north) - (a.placedNorth ?? a.north),
    (b.placedEast ?? b.east) - (a.placedEast ?? a.east),
  );
}

function cloneMapGeometry(map) {
  if (!map) return null;
  return JSON.parse(JSON.stringify(map));
}

function snapshotFrozenMap(map) {
  return cloneMapGeometry(map);
}

function extractFrozenBoundaryAnchor(frozenMap, lastSourceFile) {
  const annotated = CBAO.annotateTrajectorySources(frozenMap?.trajectory, null);
  const chunks = CBAO.splitTrajectoryBySource(annotated);
  const chunk = chunks.find((c) => c.sourceFile === lastSourceFile);
  if (!chunk?.points?.length) return null;
  const end = chunk.points[chunk.points.length - 1];
  return {
    sourceFile: lastSourceFile,
    endPosition: {
      east: end.placedEast ?? end.east,
      north: end.placedNorth ?? end.north,
    },
    tangentRadAtEnd: tangentRadAtEnd(chunk.points),
  };
}

function isFrozenTrajectoryPoint(point, oldPrefixSet) {
  if (!point) return false;
  if (oldPrefixSet.has(point.sourceFile)) return true;
  if (point.bridgeSection) {
    return oldPrefixSet.has(point.bridgeFromSourceFile) && oldPrefixSet.has(point.bridgeToSourceFile);
  }
  return false;
}

function isFrozenPolygon(poly, oldPrefixSet) {
  if (!poly) return false;
  if (poly.fragmentKind === 'combinedRouteBoundaryBridge') return true;
  const sf = poly.sourceFile
    ?? poly.bridgeProvenance?.fromSourceFile
    ?? poly.bridgeProvenance?.toSourceFile
    ?? null;
  return !sf || oldPrefixSet.has(sf);
}

function transformPointListLocal(points, registry, timeline, hintSourceFile = null) {
  return (points || []).map((pt) => CST.transformMapPoint(pt, registry, timeline, hintSourceFile ?? pt.sourceFile ?? null));
}

function transformFragmentListLocal(fragments, registry, timeline) {
  return (fragments || []).map((frag) => ({
    ...frag,
    points: transformPointListLocal(frag.points, registry, timeline, frag.sourceFile ?? null),
  }));
}

function transformPolygonListLocal(polygons, registry, timeline) {
  return (polygons || []).map((poly) => ({
    ...poly,
    ring: transformPointListLocal(poly.ring, registry, timeline, poly.sourceFile ?? null),
  }));
}

function mergePointsByFrozenPrefix(frozenList, freshList, oldPrefixSet, newSourceFile, registry, timeline) {
  const kept = (frozenList || []).filter((p) => oldPrefixSet.has(p.sourceFile));
  const newRaw = (freshList || []).filter((p) => p.sourceFile === newSourceFile);
  const newPlaced = transformPointListLocal(newRaw, registry, timeline);
  return [...kept, ...newPlaced];
}

function mergeFragmentListByFrozenPrefix(frozenFrags, freshFrags, oldPrefixSet, newSourceFile, registry, timeline) {
  const kept = (frozenFrags || []).filter((f) => oldPrefixSet.has(f.sourceFile));
  const newRaw = (freshFrags || []).filter((f) => f.sourceFile === newSourceFile);
  return [...kept, ...transformFragmentListLocal(newRaw, registry, timeline)];
}

function buildAppendTransformEntry(chunk, shaByFile, mirrorChecked, frozenBoundary) {
  const sourceFile = chunk.sourceFile;
  const sha = shaByFile[sourceFile];
  const points = chunk.points;
  if (!points?.length) return { ok: false, reason: 'emptyNewSourceChunk' };

  const baselineStart = points[0];
  const baselineEnd = points[points.length - 1];
  const headingRad = CST.headingRadForChunk(points);
  const origin = baselineStart;
  const displayCorrection = VDC.isExactDisplayCorrectionActive(mirrorChecked, sha);

  const correctedLocal = points.map((p) => {
    const local = CST.toSourceLocal(p, origin, headingRad);
    return displayCorrection ? VDC.transformDisplayPoint(local.east, local.north) : local;
  });

  const baselineTan = tangentRadAtStart(points);
  const rot = frozenBoundary.tangentRadAtEnd - baselineTan;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const vec = {
    east: baselineEnd.east - baselineStart.east,
    north: baselineEnd.north - baselineStart.north,
  };
  const dstA = frozenBoundary.endPosition;
  const dstB = {
    east: dstA.east + cos * vec.east - sin * vec.north,
    north: dstA.north + sin * vec.east + cos * vec.north,
  };

  const fit = CBAO.solveRigidFromTwoAnchors(
    correctedLocal[0],
    correctedLocal[correctedLocal.length - 1],
    dstA,
    dstB,
  );
  if (fit.residualM > CBAO.MAX_FIT_RESIDUAL_M) {
    return {
      ok: false,
      reason: 'fitResidualExceedsBaselineContract',
      residualM: fit.residualM,
    };
  }

  const applyCanonical = (east, north) => {
    const local = CST.toSourceLocal({ east, north }, origin, headingRad);
    const corrected = displayCorrection
      ? VDC.transformDisplayPoint(local.east, local.north)
      : local;
    return fit.apply(corrected);
  };
  const probe = applyCanonical(origin.east, origin.north);
  const entry = {
    sourceFile,
    sourceQlogSha256: sha ?? null,
    displayCorrection,
    reflectionApplied: displayCorrection,
    rotationRad: (fit.rotationDeg ?? 0) * (Math.PI / 180),
    translationEast: probe.east - origin.east,
    translationNorth: probe.north - origin.north,
    placementResidualM: fit.residualM ?? 0,
    outputFrame: CST.OUTPUT_FRAME,
    identity: false,
    rejected: false,
    applyCanonical,
  };
  return { ok: true, entry, fit };
}

function validateAppendBoundary(trajectory, timeline, fromSourceFile, toSourceFile) {
  const metrics = CBAO.measureBoundaryMetrics(trajectory, timeline);
  const seam = (metrics.seams || []).find((s) => s.fromSource === fromSourceFile && s.toSource === toSourceFile);
  if (!seam) return { ok: false, reason: 'missingBoundarySeam' };
  const positionOk = seam.seamDistanceM <= CBAO.BASELINE_SEAM_TOLERANCE_M;
  const headingOk = Math.abs(seam.tangentDeltaDeg) <= CBAO.BASELINE_TANGENT_TOLERANCE_DEG;
  return {
    ok: positionOk && headingOk,
    seam,
    positionOk,
    headingOk,
  };
}

function applyProgressiveFrozenAppend(frozenMap, freshBaseMap, processedData, oldPrefix, newSourceFile, options = {}) {
  if (!frozenMap?.trajectory?.length) return { ok: false, reason: 'missingFrozenMap' };
  if (!freshBaseMap?.trajectory?.length) return { ok: false, reason: 'missingFreshBaseMap' };
  if (!oldPrefix?.length || !newSourceFile) return { ok: false, reason: 'invalidPrefix' };

  const mirrorChecked = options.mirrorChecked !== false;
  const shaByFile = CBAO.buildSourceSha256Lookup(processedData?.fileAudits);
  const timeline = processedData?.timeline;
  const lastFrozenSource = oldPrefix[oldPrefix.length - 1];
  const frozenBoundary = extractFrozenBoundaryAnchor(frozenMap, lastFrozenSource);
  if (!frozenBoundary) return { ok: false, reason: 'missingFrozenBoundaryAnchor' };

  const annotated = CBAO.annotateTrajectorySources(freshBaseMap.trajectory, timeline);
  const chunks = CBAO.splitTrajectoryBySource(annotated);
  const newChunk = chunks.find((c) => c.sourceFile === newSourceFile);
  if (!newChunk) return { ok: false, reason: 'missingNewSourceChunk' };

  const transformResult = buildAppendTransformEntry(newChunk, shaByFile, mirrorChecked, frozenBoundary);
  if (!transformResult.ok) return transformResult;

  const oldPrefixSet = new Set(oldPrefix);
  const registry = {
    ...(frozenMap.sourceTransformByFile || {}),
    [newSourceFile]: transformResult.entry,
  };

  const frozenTraj = (frozenMap.trajectory || []).filter((p) => isFrozenTrajectoryPoint(p, oldPrefixSet));
  const newTraj = transformPointListLocal(
    annotated.filter((p) => p.sourceFile === newSourceFile),
    registry,
    timeline,
  );

  const merged = {
    ...frozenMap,
    trajectory: [...frozenTraj, ...newTraj],
    laneFragments: mergeFragmentListByFrozenPrefix(
      frozenMap.laneFragments,
      freshBaseMap.laneFragments,
      oldPrefixSet,
      newSourceFile,
      registry,
      timeline,
    ),
    edgeFragments: mergeFragmentListByFrozenPrefix(
      frozenMap.edgeFragments,
      freshBaseMap.edgeFragments,
      oldPrefixSet,
      newSourceFile,
      registry,
      timeline,
    ),
    roadSurfacePolygons: [
      ...(frozenMap.roadSurfacePolygons || []).filter((poly) => isFrozenPolygon(poly, oldPrefixSet)),
      ...transformPolygonListLocal(
        (freshBaseMap.roadSurfacePolygons || []).filter((p) => p.sourceFile === newSourceFile),
        registry,
        timeline,
      ),
    ],
    pointAccumulated: frozenMap.pointAccumulated ? {
      ...frozenMap.pointAccumulated,
      points: mergePointsByFrozenPrefix(
        frozenMap.pointAccumulated.points,
        freshBaseMap.pointAccumulated?.points,
        oldPrefixSet,
        newSourceFile,
        registry,
        timeline,
      ),
      rejected: mergePointsByFrozenPrefix(
        frozenMap.pointAccumulated.rejected,
        freshBaseMap.pointAccumulated?.rejected,
        oldPrefixSet,
        newSourceFile,
        registry,
        timeline,
      ),
    } : freshBaseMap.pointAccumulated,
    sourceTransformByFile: registry,
    combinedCoordinateFrame: CST.OUTPUT_FRAME,
    boundaryAnchoredOrientationActive: true,
    combinedOrientationCandidate: CBAO.CANDIDATE_BOUNDARY_ANCHORED,
    progressiveFrozenPrefixActive: true,
    isMultiSource: true,
    valid: true,
  };

  const bridged = CRB.applyCombinedRouteBoundaryBridges(merged, processedData, options);
  const boundaryValidation = validateAppendBoundary(
    bridged.trajectory,
    timeline,
    lastFrozenSource,
    newSourceFile,
  );
  if (!boundaryValidation.ok) {
    return {
      ok: false,
      reason: 'boundaryValidationFailed',
      boundaryValidation,
      transformResult,
    };
  }

  bridged.boundaryAnchoredMetrics = {
    baseline: CBAO.measureBoundaryMetrics(bridged.trajectory, timeline),
    final: CBAO.measureBoundaryMetrics(bridged.trajectory, timeline),
    maxConsecutiveGapM: bridged.combinedRouteContinuity?.maxConsecutiveGapM,
    centerlineContinuous: CBAO.trajectoryIsContinuous(bridged.trajectory),
  };
  bridged.sourceFiles = CBAO.uniqueSourceFiles(bridged.trajectory);

  return {
    ok: true,
    map: bridged,
    registry,
    boundaryValidation,
    transformResult,
  };
}

function verifyFrozenPrefixUnchanged(beforeMap, afterMap, prefixSources) {
  const before = perSourcePlacedPayloads(beforeMap, prefixSources);
  const after = perSourcePlacedPayloads(afterMap, prefixSources);
  return verifyPrefixPayloadsStable(before, after, prefixSources);
}

function isCandidateEnabled(search) {
  return parseProgressiveCombinedPlaybackCandidate(search);
}

module.exports = {
  parseProgressiveCombinedPlaybackCandidate,
  isCandidateEnabled,
  segmentNumericId,
  segmentDisplayLabel,
  orderPrefixFiles,
  resolveNextAvailableSegment,
  buildLookaheadProcessList,
  findLastTimelineIndexForSource,
  findFirstTimelineIndexForSource,
  initialVisibleTimelineIndex,
  mapPreservedTimelineIndex,
  clampTimelineIndex,
  perSourcePlacedPayloads,
  perSourcePlacedChecksums,
  verifyPrefixChecksumsStable,
  verifyPrefixPayloadsStable,
  formatProgressiveStatusLabel,
  resolveProgressiveTimelineIndex,
  canRemoveLastSegment,
  prefixSnapshotKey,
  snapshotFrozenMap,
  cloneMapGeometry,
  extractFrozenBoundaryAnchor,
  buildAppendTransformEntry,
  validateAppendBoundary,
  applyProgressiveFrozenAppend,
  verifyFrozenPrefixUnchanged,
  tangentRadAtEnd,
  tangentRadAtStart,
  filterMapToVisibleSources,
  filterTimelineToVisibleSources,
  filterProcessDataToVisibleSources,
  computeVisibleFitBounds,
  findHiddenGeometryLeaks,
  buildInitialLookaheadDisplay,
  revealPreparedLookahead,
  prepareNextHiddenLookahead,
  simulateLegacyStandaloneAppendRotation,
};
