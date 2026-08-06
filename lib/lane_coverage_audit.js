'use strict';

/**
 * Read-only lane coverage audit for segment comparison.
 * Does not modify pipeline thresholds, coordinates, or assignments.
 */

const { dist2d } = require('./chunking');
const { buildReferenceTrajectory } = require('./trajectory');
const { collectLaneObservations } = require('./sd_fusion');
const { buildCleanedLaneMap } = require('./lane_map_cleanup');
const { traceLaneTrackFusion, findFusedFragmentGaps } = require('./fusion_gap_trace');
const { polylineLength } = require('./segment_local_map');
const { extractModelGeometry } = require('./transform');

const MIN_LANE_PROB = 0.5;
const BIN_M = 2;

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

function polylineLengthLocal(points) {
  if (!points?.length) return 0;
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].east - points[i - 1].east, points[i].north - points[i - 1].north);
  }
  return len;
}

function frameRouteS(frame, trajectory) {
  const pose = frame.pose;
  if (!pose || !trajectory?.segments?.length) return null;
  let best = null;
  for (const seg of trajectory.segments) {
    const de = seg.b.east - seg.a.east;
    const dn = seg.b.north - seg.a.north;
    const len2 = de * de + dn * dn;
    if (len2 < 1e-12) continue;
    let t = ((pose.east - seg.a.east) * de + (pose.north - seg.a.north) * dn) / len2;
    t = Math.max(0, Math.min(1, t));
    const s = seg.s0 + t * seg.length;
    if (!best || s < best) best = s;
  }
  return best;
}

function buildFrameRouteSMap(frames, trajectory) {
  const map = new Map();
  for (const f of frames) {
    const s = frameRouteS(f, trajectory);
    if (s != null) map.set(f.frameId, s);
  }
  return map;
}

function rawModelV2LaneRows(modelV2) {
  const probs = modelV2?.laneLineProbs || [];
  const lines = modelV2?.laneLines || [];
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const prob = probs[i] ?? 0;
    rows.push({ laneIndex: i, prob, pointCount: (line.x || []).length });
  }
  return rows;
}

function buildRawObservationAudit(frames, modelEventsByFrameId) {
  const perFrame = [];
  let modelV2Count = 0;
  let usableCount = 0;
  const byLaneIndex = new Map();
  const frameSpacings = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    modelV2Count++;
    const rawRows = rawModelV2LaneRows(modelEventsByFrameId.get(frame.frameId)?.modelV2);
    const mappedLanes = frame.lanes || [];
    const obsRecords = [];

    for (const lane of mappedLanes) {
      usableCount++;
      const idx = lane.laneIndex;
      const rec = {
        frameId: frame.frameId,
        elapsedIndex: i,
        laneIndex: lane.laneIndex,
        laneProbability: lane.prob ?? null,
        pointCount: (lane.points || []).length,
        mappedLengthM: polylineLengthLocal(lane.points),
        laneTrackId: lane.laneTrackId ?? null,
      };
      obsRecords.push(rec);
      if (!byLaneIndex.has(lane.laneIndex)) byLaneIndex.set(lane.laneIndex, []);
      byLaneIndex.get(lane.laneIndex).push(rec);
    }

    const lowProbOnly = rawRows.filter((r) => r.prob < MIN_LANE_PROB && r.pointCount >= 2);
    perFrame.push({
      frameId: frame.frameId,
      elapsedIndex: i,
      rawLaneRows: rawRows,
      mappedLaneCount: mappedLanes.length,
      lowProbFilteredCount: lowProbOnly.length,
      lowProbRows: lowProbOnly,
      observations: obsRecords,
      poseValid: !!frame.pose,
      chunkId: frame.chunkId ?? 0,
      passId: frame.passId ?? 0,
      poseSectionId: frame.poseSectionId ?? 0,
    });
  }

  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (a.pose && b.pose) frameSpacings.push(dist2d(a.pose, b.pose));
  }

  const rawLengthByLaneIndex = {};
  for (const [idx, recs] of byLaneIndex.entries()) {
    rawLengthByLaneIndex[idx] = recs.reduce((s, r) => s + r.mappedLengthM, 0);
  }

  return {
    modelV2ObservationCount: modelV2Count,
    usableLaneObservationCount: usableCount,
    frameSpacingMeanM: mean(frameSpacings),
    frameSpacingMedianM: median(frameSpacings),
    observationsByLaneIndex: Object.fromEntries([...byLaneIndex.entries()].map(([k, v]) => [k, v])),
    rawMappedLengthByLaneIndex: rawLengthByLaneIndex,
    perFrame,
    allObservations: [...byLaneIndex.values()].flat(),
  };
}

function inferTrackLifecycle(tracks, framePairAudits, frames) {
  const trackById = new Map(tracks.map((t) => [t.trackId, t]));
  const begins = new Map();
  const ends = new Map();

  for (const audit of framePairAudits || []) {
    for (const a of audit.assignments || []) {
      if (a.newTrack) {
        begins.set(a.resultingTrackId, {
          trackId: a.resultingTrackId,
          reason: 'newTrackCreated',
          frameId: audit.nextFrameId,
          detail: audit.rejections?.find((r) => r.nextIdx === a.nextIdx)?.reason || 'noValidContinuation',
        });
      }
    }
  }

  for (const t of tracks) {
    if (!begins.has(t.trackId)) {
      begins.set(t.trackId, {
        trackId: t.trackId,
        reason: 'passInitialObservation',
        frameId: t.frameIds?.[0] ?? null,
        detail: 'firstFrameInPass',
      });
    }
    const lastFrame = t.frameIds?.[t.frameIds.length - 1];
    const lastIdx = frames.findIndex((f) => f.frameId === lastFrame);
    const isLastPassFrame = lastIdx === frames.length - 1;
    const shortTrack = (t.frameIds?.length ?? 0) <= 1;
    ends.set(t.trackId, {
      trackId: t.trackId,
      reason: isLastPassFrame ? 'endOfPass' : (shortTrack ? 'shortTrack' : 'trackGapExceeded'),
      frameId: lastFrame,
      missedFrames: t.missedFrames ?? 0,
      frameCount: t.frameIds?.length ?? 0,
    });
  }

  return {
    begins: Object.fromEntries(begins),
    ends: Object.fromEntries(ends),
  };
}

function buildFusedTrackAudit(chunk, frames, trajectory, laneObs, vehiclePath) {
  const fused = chunk.fusedLaneLines || [];
  const tracks = chunk.laneTracks || [];
  const pathLengthM = trajectory.totalLength || 0;
  const tracking = (chunk.laneTrackingSummary?.passes || [])[0] || chunk.laneTrackingSummary || {};
  const cleanup = buildCleanedLaneMap({
    fusedLanes: fused,
    tracks,
    frames,
    vehiclePath,
    chunkId: chunk.chunkId,
    passId: 0,
    laneObservations: laneObs,
    enableD12Preservation: false,
    classDGaps: [],
    options: chunk.processingOptions || {},
  });

  const rejectedCleanup = cleanup.rejected || [];
  const cleaned = cleanup.cleaned || [];

  const trackByKey = new Map();
  for (const t of tracks) {
    const key = `${t.passId ?? 0}:${t.trackId}`;
    const prev = trackByKey.get(key);
    if (!prev || (t.frameIds?.length ?? 0) > (prev.frameIds?.length ?? 0)) trackByKey.set(key, t);
  }
  const uniqueTracks = [...trackByKey.values()];
  const trackRows = [];
  for (const t of uniqueTracks) {
    const frags = fused.filter((f) => f.laneTrackId === t.trackId);
    const sdPts = frags.flatMap((f) => f.sdPoints || []);
    const sVals = sdPts.map((p) => p.s).filter(Number.isFinite);
    const sMin = sVals.length ? Math.min(...sVals) : null;
    const sMax = sVals.length ? Math.max(...sVals) : null;
    const fusedLengthM = frags.reduce((sum, f) => sum + polylineLength(f.points), 0);
    const routeCoveragePct = pathLengthM > 0 && sMin != null && sMax != null
      ? ((Math.max(0, sMax - sMin) / pathLengthM) * 100)
      : 0;

    let largestGapM = 0;
    const fragGaps = findFusedFragmentGaps(fused, t.trackId);
    for (const g of fragGaps) largestGapM = Math.max(largestGapM, g.gapM);

    const fusionTrace = traceLaneTrackFusion(laneObs, t.trackId, {});
    const rejectedBins = (fusionTrace.rejectedBins || []).length;
    const acceptedBins = (fusionTrace.acceptedBins || []).length;

    const cleanedFrags = cleaned.filter((c) => c.laneTrackId === t.trackId);
    const rejectedFrags = rejectedCleanup.filter((r) => r.laneTrackId === t.trackId);

    trackRows.push({
      trackId: t.trackId,
      passId: t.passId ?? 0,
      laneOrder: t.laneOrder,
      dominantLaneIndices: [...new Set(
        frames.flatMap((f) => (f.lanes || [])
          .filter((l) => l.laneTrackId === t.trackId)
          .map((l) => l.laneIndex)),
      )].sort(),
      frameCount: t.frameIds?.length ?? 0,
      fusedFragmentCount: frags.length,
      fusedLengthM,
      routeCoveragePct: Math.round(routeCoveragePct * 10) / 10,
      sRange: sMin != null ? [sMin, sMax] : null,
      largestUnsupportedGapM: Math.round(largestGapM * 100) / 100,
      fusionAcceptedBins: acceptedBins,
      fusionRejectedBins: rejectedBins,
      cleanedFragmentCount: cleanedFrags.length,
      rejectedCleanupCount: rejectedFrags.length,
      rejectedCleanupReasons: [...new Set(rejectedFrags.map((r) => r.rejectReason).filter(Boolean))],
      coveredDistanceM: t.coveredDistanceM ?? 0,
      confidence: t.confidence ?? null,
    });
  }

  const trackRowsSorted = trackRows;

  const fragmentationPairs = [];
  const sorted = [...uniqueTracks].sort((a, b) => (a.frameIds?.[0] ?? 0) - (b.frameIds?.[0] ?? 0));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (a.laneOrder !== b.laneOrder) continue;
      const gapFrames = (b.frameIds?.[0] ?? 0) - (a.frameIds?.[a.frameIds.length - 1] ?? 0);
      if (gapFrames > 0 && gapFrames < 500) {
        fragmentationPairs.push({
          earlierTrack: a.trackId,
          laterTrack: b.trackId,
          laneOrder: a.laneOrder,
          gapFrames,
          likelySameLane: gapFrames < 120,
        });
      }
    }
  }

  return {
    fusedTrackCount: trackRowsSorted.length,
    tracks: trackRowsSorted,
    trackerSummary: {
      createdTracks: tracking.createdTracks ?? tracking.trackCount ?? tracks.length,
      continuedTracks: tracking.continuedTracks ?? null,
      terminatedTracks: tracking.terminatedTracks ?? null,
      rejectedMatches: tracking.rejectedMatches ?? null,
      ambiguousMatches: tracking.ambiguousMatches ?? null,
      oneFrameTracks: tracking.oneFrameTracks ?? null,
      fragmentationRate: tracking.fragmentationRate ?? null,
      observationAssociationPct: tracking.observationAssociationPct ?? null,
    },
    cleanupSummary: cleanup.stats || {},
    rejectedCleanupFragments: rejectedCleanup.map((r) => ({
      laneTrackId: r.laneTrackId,
      fragmentIndex: r.fragmentIndex,
      rejectReason: r.rejectReason,
      lengthM: r.lengthM ?? polylineLength(r.points),
      sMin: r.sMin ?? null,
      sMax: r.sMax ?? null,
    })),
    identityChanges: fragmentationPairs,
  };
}

function classifyGap(context) {
  const {
    hasRawModel, hasUsableMapped, hasProjection, hasTrack, hasFused, hasCleaned,
    lowProb, atBoundary, invalidPose, cleanupRejected, fusionRejected, trackSplit,
  } = context;
  if (invalidPose) return 'invalidPose';
  if (atBoundary) return 'trajectoryChunkBoundary';
  if (!hasRawModel) return 'sourceObservationMissing';
  if (lowProb) return 'lowLaneProbability';
  if (hasUsableMapped && !hasProjection) return 'projectionRejected';
  if (hasProjection && !hasTrack) return 'trackerAssociationFailed';
  if (trackSplit) return 'trackIdentitySplit';
  if (hasTrack && !hasFused) return 'insufficientFusionSupport';
  if (hasFused && !hasCleaned && cleanupRejected) return 'cleanupRemoved';
  return 'unknown';
}

function buildCoverageGraph(spec) {
  const {
    pathLengthM, binM, rawByLaneIndex, fusedByTrack, frames, frameRouteSMap,
    fused, cleaned, rejectedCleanup, tracks, poseSectionBoundaries, modelByFrame,
  } = spec;
  const binCount = Math.max(1, Math.ceil(pathLengthM / binM));
  const bins = Array.from({ length: binCount }, (_, i) => i * binM);

  function markRanges(rows, keyField, outMap) {
    for (const row of rows) {
      const key = row[keyField];
      if (!outMap.has(key)) outMap.set(key, new Array(binCount).fill(null));
      const arr = outMap.get(key);
      const s0 = row.sMin ?? row.sRange?.[0];
      const s1 = row.sMax ?? row.sRange?.[1];
      if (!Number.isFinite(s0) || !Number.isFinite(s1)) continue;
      for (let b = 0; b < binCount; b++) {
        const bs = bins[b];
        const be = bs + binM;
        if (s1 >= bs && s0 < be) arr[b] = row.state || 'observed';
      }
    }
  }

  const rawRows = [];
  for (const [laneIndex, obsList] of Object.entries(rawByLaneIndex)) {
    const sVals = obsList.map((o) => o.s).filter(Number.isFinite);
    if (!sVals.length) continue;
    rawRows.push({
      laneIndex: Number(laneIndex),
      sMin: Math.min(...sVals),
      sMax: Math.max(...sVals),
      state: 'observed',
    });
  }

  const rawMap = new Map();
  markRanges(rawRows, 'laneIndex', rawMap);

  const fusedMap = new Map();
  for (const t of fusedByTrack) {
    fusedMap.set(t.trackId, new Array(binCount).fill(null));
    const arr = fusedMap.get(t.trackId);
    const s0 = t.sRange?.[0];
    const s1 = t.sRange?.[1];
    if (!Number.isFinite(s0) || !Number.isFinite(s1)) continue;
    for (let b = 0; b < binCount; b++) {
      const bs = bins[b];
      const be = bs + binM;
      if (s1 >= bs && s0 < be) arr[b] = 'observed';
    }
  }

  const gapSections = [];
  for (const [laneIndex, obsList] of Object.entries(rawByLaneIndex)) {
    const obsByBin = new Array(binCount).fill(false);
    for (const o of obsList) {
      if (!Number.isFinite(o.s)) continue;
      const b = Math.min(binCount - 1, Math.floor(o.s / binM));
      obsByBin[b] = true;
    }
    let gapStart = null;
    for (let b = 0; b < binCount; b++) {
      const s = bins[b];
      const atBoundary = poseSectionBoundaries.some((pb) => Math.abs(pb - s) < binM);
      const frameAtBin = frames.find((f) => {
        const fs = frameRouteSMap.get(f.frameId);
        return fs != null && fs >= s && fs < s + binM;
      });
      const invalidPose = frameAtBin && !frameAtBin.pose;
      const rawRows = frameAtBin ? rawModelV2LaneRows(modelByFrame.get(frameAtBin.frameId)?.modelV2) : [];
      const hasRaw = rawRows.some((r) => r.pointCount >= 2);
      const lowProb = hasRaw && rawRows.every((r) => r.prob < MIN_LANE_PROB || r.pointCount < 2);
      const hasProj = obsList.some((o) => o.s >= s && o.s < s + binM);
      const hasTrack = obsList.some((o) => o.s >= s && o.s < s + binM && o.laneTrackId != null);
      const trackIds = tracks.filter((t) => {
        const fr = (t.frameIds || []);
        return frameAtBin && fr.includes(frameAtBin.frameId);
      }).map((t) => t.trackId);
      const trackSplit = trackIds.length > 1;
      const hasFused = fused.some((f) => {
        const ss = (f.sdPoints || []).map((p) => p.s);
        return ss.some((x) => x >= s && x < s + binM);
      });
      const hasCleaned = cleaned.some((c) => c.sMin <= s + binM && c.sMax >= s);
      const cleanupRejected = rejectedCleanup.some((r) => r.sMin <= s + binM && r.sMax >= s);

      if (!obsByBin[b]) {
        if (gapStart == null) gapStart = b;
      } else if (gapStart != null) {
        const reason = classifyGap({
          hasRawModel: !!frameAtBin,
          hasUsableMapped: !lowProb,
          hasProjection: hasProj,
          hasTrack,
          hasFused,
          hasCleaned,
          lowProb,
          atBoundary,
          invalidPose,
          cleanupRejected,
          fusionRejected: hasTrack && !hasFused,
          trackSplit,
        });
        gapSections.push({
          laneIndex: Number(laneIndex),
          sStartM: bins[gapStart],
          sEndM: bins[b],
          lengthM: bins[b] - bins[gapStart],
          classification: reason,
        });
        gapStart = null;
      }
    }
  }

  return {
    binSizeM: binM,
    pathLengthM,
    binCount,
    rawLaneRows: [...rawMap.entries()].map(([laneIndex, cells]) => ({ laneIndex, cells })),
    fusedTrackRows: [...fusedMap.entries()].map(([trackId, cells]) => ({ trackId, cells })),
    gapSections,
  };
}

function renderCoverageSvg(graph, title) {
  const rowH = 14;
  const padL = 120;
  const padT = 40;
  const widthPx = 1200;
  const rawRows = graph.rawLaneRows || [];
  const fusedRows = graph.fusedTrackRows || [];
  const totalRows = rawRows.length + fusedRows.length + 2;
  const heightPx = padT + totalRows * rowH + 30;
  const plotW = widthPx - padL - 20;
  const scale = plotW / Math.max(graph.pathLengthM, 1);

  const color = (state) => {
    if (state === 'observed') return '#2563eb';
    if (state === 'rejected') return '#dc2626';
    if (state === 'terminated') return '#f97316';
    if (state === 'missing') return '#e2e8f0';
    return '#f8fafc';
  };

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}">`;
  svg += `<text x="10" y="24" font-size="14" font-family="sans-serif">${title}</text>`;
  let y = padT;

  svg += `<text x="10" y="${y + 10}" font-size="11" fill="#64748b">Raw lane indices</text>`;
  y += rowH;
  for (const row of rawRows) {
    svg += `<text x="10" y="${y + 10}" font-size="10">lane ${row.laneIndex}</text>`;
    for (let i = 0; i < row.cells.length; i++) {
      const x = padL + i * graph.binSizeM * scale;
      const w = Math.max(1, graph.binSizeM * scale);
      svg += `<rect x="${x}" y="${y}" width="${w}" height="${rowH - 2}" fill="${color(row.cells[i] ? 'observed' : 'missing')}" stroke="#cbd5e1" stroke-width="0.3"/>`;
    }
    y += rowH;
  }

  svg += `<text x="10" y="${y + 10}" font-size="11" fill="#64748b">Fused tracks</text>`;
  y += rowH;
  for (const row of fusedRows) {
    svg += `<text x="10" y="${y + 10}" font-size="10">track ${row.trackId}</text>`;
    for (let i = 0; i < row.cells.length; i++) {
      const x = padL + i * graph.binSizeM * scale;
      const w = Math.max(1, graph.binSizeM * scale);
      svg += `<rect x="${x}" y="${y}" width="${w}" height="${rowH - 2}" fill="${color(row.cells[i] ? 'observed' : 'missing')}" stroke="#cbd5e1" stroke-width="0.3"/>`;
    }
    y += rowH;
  }

  svg += `<line x1="${padL}" y1="${heightPx - 20}" x2="${widthPx - 20}" y2="${heightPx - 20}" stroke="#334155"/>`;
  svg += `<text x="${padL}" y="${heightPx - 5}" font-size="10">0 m</text>`;
  svg += `<text x="${widthPx - 80}" y="${heightPx - 5}" font-size="10">${Math.round(graph.pathLengthM)} m route</text>`;
  svg += '</svg>';
  return svg;
}

function auditSegment(processResult, modelEvents, segmentFile) {
  const chunk = processResult.routeChunks[0];
  const frames = processResult.frames.filter((f) => f.sourceFile === segmentFile || !segmentFile);
  const vehiclePath = frames.map((f) => (f.pose ? {
    ...f.pose,
    logMonoTime: f.logMonoTime,
    frameId: f.frameId,
    sourceFile: f.sourceFile,
  } : null)).filter(Boolean);
  const trajectory = buildReferenceTrajectory(vehiclePath);
  const laneObs = collectLaneObservations(frames, trajectory, {});

  const modelByFrame = new Map(modelEvents.map((e) => [e.modelV2?.frameId ?? e.frameId, e]));

  const obsByLaneForGraph = {};
  for (const o of laneObs) {
    if (!obsByLaneForGraph[o.laneIndex]) obsByLaneForGraph[o.laneIndex] = [];
    obsByLaneForGraph[o.laneIndex].push(o);
  }

  const rawAudit = buildRawObservationAudit(frames, modelByFrame);
  const fusedAudit = buildFusedTrackAudit(chunk, frames, trajectory, laneObs, vehiclePath);
  const lifecycle = inferTrackLifecycle(chunk.laneTracks || [], chunk.framePairAudits || [], frames);
  const frameRouteSMap = buildFrameRouteSMap(frames, trajectory);

  const poseSectionBoundaries = [];
  let lastSection = frames[0]?.poseSectionId;
  for (const f of frames) {
    if (f.poseSectionId !== lastSection) {
      const s = frameRouteSMap.get(f.frameId);
      if (s != null) poseSectionBoundaries.push(s);
      lastSection = f.poseSectionId;
    }
  }

  const cleanupFull = buildCleanedLaneMap({
    fusedLanes: chunk.fusedLaneLines || [],
    tracks: chunk.laneTracks || [],
    frames,
    vehiclePath,
    chunkId: chunk.chunkId,
    passId: 0,
    laneObservations: laneObs,
    enableD12Preservation: false,
    classDGaps: [],
    options: chunk.processingOptions || {},
  });

  const coverageGraph = buildCoverageGraph({
    pathLengthM: trajectory.totalLength,
    binM: BIN_M,
    rawByLaneIndex: obsByLaneForGraph,
    fusedByTrack: fusedAudit.tracks,
    frames,
    frameRouteSMap,
    fused: chunk.fusedLaneLines || [],
    cleaned: cleanupFull.cleaned || [],
    rejectedCleanup: cleanupFull.rejected || [],
    tracks: chunk.laneTracks || [],
    poseSectionBoundaries,
    modelByFrame,
  });

  const rawSpanM = Object.values(rawAudit.rawMappedLengthByLaneIndex).reduce((a, b) => a + b, 0);
  const fusedSpanM = fusedAudit.tracks.reduce((a, t) => a + t.fusedLengthM, 0);

  return {
    segmentFile,
    pathLengthM: Math.round(trajectory.totalLength * 10) / 10,
    frameCount: frames.length,
    poseSectionCount: new Set(frames.map((f) => f.poseSectionId)).size,
    passCount: (chunk.passCoverage || []).length,
    modelV2ObservationCount: rawAudit.modelV2ObservationCount,
    usableLaneObservationCount: rawAudit.usableLaneObservationCount,
    observationSpacingMeanM: rawAudit.frameSpacingMeanM,
    observationSpacingMedianM: rawAudit.frameSpacingMedianM,
    observations: rawAudit.allObservations.map((o) => ({
      frameId: o.frameId,
      laneIndex: o.laneIndex,
      laneProbability: o.laneProbability,
      mappedLengthM: Math.round(o.mappedLengthM * 100) / 100,
      laneTrackId: o.laneTrackId,
    })),
    rawMappedLengthByLaneIndex: rawAudit.rawMappedLengthByLaneIndex,
    fusedTrackCount: fusedAudit.fusedTrackCount,
    fusedTracks: fusedAudit.tracks,
    trackerSummary: fusedAudit.trackerSummary,
    trackLifecycle: lifecycle,
    rejectedCleanupFragments: fusedAudit.rejectedCleanupFragments,
    identityChanges: fusedAudit.identityChanges,
    coverageComparison: {
      rawMappedSpanSumM: Math.round(rawSpanM * 10) / 10,
      fusedLengthSumM: Math.round(fusedSpanM * 10) / 10,
      rawToFusedRatio: rawSpanM > 0 ? Math.round((fusedSpanM / rawSpanM) * 1000) / 1000 : null,
      usableObsPerFrame: frames.length ? rawAudit.usableLaneObservationCount / frames.length : 0,
    },
    coverageGraph,
    coverageGraphSvg: renderCoverageSvg(coverageGraph, segmentFile),
    poseSectionBoundaries,
    chunkBoundaries: [{ chunkId: chunk.chunkId, passIds: (chunk.passCoverage || []).map((p) => p.passId) }],
  };
}

module.exports = {
  auditSegment,
  renderCoverageSvg,
  MIN_LANE_PROB,
  BIN_M,
};
