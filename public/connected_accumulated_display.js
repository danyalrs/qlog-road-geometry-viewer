'use strict';

/**
 * Connected accumulated lane observations — viewer-only display experiment.
 * Raw and robust connectors; never mutates production map structures.
 */
(function connectedAccumulatedDisplayModule(global) {
  const CONNECTION_IDENTITY = 'chunkId:passId:groupTrackId';

  const DEFAULTS = {
    maxGapM: 8,
    maxStepM: 14,
    dedupSM: 0.6,
    dedupDM: 0.6,
    robustBinSizeM: 1.0,
    maxLateralStepM: 1.5,
    outlierMadFloorM: 0.75,
    outlierMadMultiplier: 3,
    perFrameDedupM: 0.15,
  };

  const ORDERING_FIELDS = [
    'sourcePointIndex',
    'modelPointIndex',
    'pointIndex',
    'modelX',
    's',
  ];

  function groupConnectionKey(p) {
    return `${p.chunkId}:${p.passId}:${p.groupTrackId}`;
  }

  function safetyKey(p) {
    return `${p.chunkId}:${p.passId}:${p.groupTrackId}:${p.laneIndex ?? 'x'}:${p.side ?? 'x'}`;
  }

  function isFinitePoint(p) {
    return Number.isFinite(p?.localEast)
      && Number.isFinite(p?.localNorth)
      && Number.isFinite(p?.s);
  }

  function isFiniteRobustPoint(p) {
    return Number.isFinite(p?.localEast)
      && Number.isFinite(p?.localNorth)
      && Number.isFinite(p?.s)
      && Number.isFinite(p?.d);
  }

  function compareOrdered(a, b) {
    const ds = (a.s ?? 0) - (b.s ?? 0);
    if (ds !== 0) return ds;
    const df = (a.frameIndex ?? 0) - (b.frameIndex ?? 0);
    if (df !== 0) return df;
    const ta = a.logMonoTime != null ? BigInt(String(a.logMonoTime)) : 0n;
    const tb = b.logMonoTime != null ? BigInt(String(b.logMonoTime)) : 0n;
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  }

  function compareLogMono(a, b) {
    const ta = a != null ? BigInt(String(a)) : 0n;
    const tb = b != null ? BigInt(String(b)) : 0n;
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  }

  function localStepM(a, b) {
    return Math.hypot(
      (b.localEast ?? 0) - (a.localEast ?? 0),
      (b.localNorth ?? 0) - (a.localNorth ?? 0),
    );
  }

  function median(nums) {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function mad(nums, med) {
    if (!nums.length || med == null) return 0;
    return median(nums.map((v) => Math.abs(v - med)));
  }

  function binIndexForS(s, binSize) {
    return Math.floor(s / binSize);
  }

  function dedupeOrdered(sorted, opts) {
    const out = [];
    let deduped = 0;
    for (const p of sorted) {
      const last = out[out.length - 1];
      if (last
        && Math.abs((p.s ?? 0) - (last.s ?? 0)) <= opts.dedupSM
        && Math.abs((p.d ?? 0) - (last.d ?? 0)) <= opts.dedupDM) {
        deduped++;
        if ((p.prob ?? 0) > (last.prob ?? 0)) out[out.length - 1] = p;
        continue;
      }
      out.push(p);
    }
    return { points: out, deduped };
  }

  function makePolyline(points, meta) {
    const ss = points.map((p) => p.s).filter(Number.isFinite);
    return {
      groupId: meta.groupId,
      chunkId: meta.chunkId,
      passId: meta.passId,
      groupTrackId: meta.groupTrackId,
      groupKey: meta.groupKey ?? null,
      laneIndex: meta.laneIndex ?? null,
      side: meta.side ?? null,
      points,
      pointCount: points.length,
      minS: ss.length ? Math.min(...ss) : null,
      maxS: ss.length ? Math.max(...ss) : null,
      mode: meta.mode ?? 'raw',
    };
  }

  function partitionBySafety(points, stats) {
    const bySafety = new Map();
    for (const p of points) {
      const sk = safetyKey(p);
      if (!bySafety.has(sk)) bySafety.set(sk, []);
      bySafety.get(sk).push(p);
    }
    if (bySafety.size > 1) stats.identityRejected += bySafety.size - 1;
    return [...bySafety.values()];
  }

  function splitPolylinesRaw(ordered, meta, opts, stats) {
    const polylines = [];
    if (ordered.length < 2) {
      if (ordered.length === 1) stats.isolatedPointCount++;
      return polylines;
    }

    let run = [ordered[0]];
    for (let i = 1; i < ordered.length; i++) {
      const prev = run[run.length - 1];
      const next = ordered[i];
      const ds = Math.abs((next.s ?? 0) - (prev.s ?? 0));
      const step = localStepM(prev, next);
      const gapSplit = ds > opts.maxGapM;
      const stepSplit = step > opts.maxStepM;
      if (gapSplit || stepSplit) {
        if (gapSplit) stats.gapSplits++;
        if (stepSplit) stats.spatialStepSplits++;
        if (run.length >= 2) polylines.push(makePolyline(run, meta));
        else if (run.length === 1) stats.isolatedPointCount++;
        run = [next];
      } else {
        run.push(next);
      }
    }
    if (run.length >= 2) polylines.push(makePolyline(run, meta));
    else if (run.length === 1) stats.isolatedPointCount++;
    return polylines;
  }

  function splitPolylinesRobust(reps, meta, opts, stats) {
    const polylines = [];
    if (reps.length < 2) {
      if (reps.length === 1) stats.isolatedPointCount++;
      return polylines;
    }

    let run = [reps[0]];
    for (let i = 1; i < reps.length; i++) {
      const prev = run[run.length - 1];
      const next = reps[i];
      const prevPt = prev.point;
      const nextPt = next.point;
      const ds = Math.abs((nextPt.s ?? 0) - (prevPt.s ?? 0));
      const dd = Math.abs((nextPt.d ?? 0) - (prevPt.d ?? 0));
      const step = localStepM(prevPt, nextPt);
      const gapSplit = ds > opts.maxGapM;
      const stepSplit = step > opts.maxStepM;
      const lateralSplit = dd > opts.maxLateralStepM;
      const identitySplit = safetyKey(prevPt) !== safetyKey(nextPt);
      if (prev.binMeta.binIndex != null && next.binMeta.binIndex != null
        && next.binMeta.binIndex - prev.binMeta.binIndex > 1) {
        stats.emptyBinGaps++;
      }

      if (gapSplit || stepSplit || lateralSplit || identitySplit) {
        if (gapSplit) stats.gapSplits++;
        if (stepSplit) stats.spatialStepSplits++;
        if (lateralSplit) stats.lateralStepSplits++;
        if (identitySplit) stats.identitySplits++;
        if (run.length >= 2) polylines.push(makePolyline(run.map((r) => r.point), meta));
        else if (run.length === 1) stats.isolatedPointCount++;
        run = [next];
      } else {
        run.push(next);
      }
    }
    if (run.length >= 2) polylines.push(makePolyline(run.map((r) => r.point), meta));
    else if (run.length === 1) stats.isolatedPointCount++;
    return polylines;
  }

  function compareRepresentatives(a, b) {
    const ds = (a.binMeta.medianS ?? 0) - (b.binMeta.medianS ?? 0);
    if (ds !== 0) return ds;
    const db = (a.binMeta.binIndex ?? 0) - (b.binMeta.binIndex ?? 0);
    if (db !== 0) return db;
    const df = (a.point.frameIndex ?? 0) - (b.point.frameIndex ?? 0);
    if (df !== 0) return df;
    return compareLogMono(a.point.logMonoTime, b.point.logMonoTime);
  }

  function selectRepresentative(candidates, medianS, medianD, opts) {
    const binSize = opts.robustBinSizeM;
    const scored = candidates.map((p, inputIndex) => {
      const ds = (p.s - medianS) / binSize;
      const dd = (p.d - medianD) / binSize;
      return {
        p,
        inputIndex,
        normDist2: ds * ds + dd * dd,
        prob: Number.isFinite(p.prob) ? p.prob : 0,
      };
    });
    scored.sort((a, b) => {
      if (a.normDist2 !== b.normDist2) return a.normDist2 - b.normDist2;
      if (a.prob !== b.prob) return b.prob - a.prob;
      const df = (a.p.frameIndex ?? 0) - (b.p.frameIndex ?? 0);
      if (df !== 0) return df;
      const tl = compareLogMono(a.p.logMonoTime, b.p.logMonoTime);
      if (tl !== 0) return tl;
      return a.inputIndex - b.inputIndex;
    });
    return scored[0];
  }

  function filterBinOutliers(binPoints, stats, opts) {
    if (binPoints.length < 3) return binPoints;
    const ds = binPoints.map((p) => p.d);
    const medianD = median(ds);
    const lateralMadM = mad(ds, medianD);
    const threshold = Math.max(opts.outlierMadFloorM, opts.outlierMadMultiplier * lateralMadM);
    const kept = binPoints.filter((p) => Math.abs(p.d - medianD) <= threshold);
    if (!kept.length) return binPoints;
    stats.outlierExcludedCount += binPoints.length - kept.length;
    return kept;
  }

  function buildBinRepresentatives(binPoints, binIndex, globalIndexBase, stats, opts) {
    const filtered = filterBinOutliers(binPoints, stats, opts);
    const ss = filtered.map((p) => p.s);
    const ds = filtered.map((p) => p.d);
    const medianS = median(ss);
    const medianD = median(ds);
    const distinctFrameCount = new Set(filtered.map((p) => p.frameId)).size;
    const probs = filtered.map((p) => (Number.isFinite(p.prob) ? p.prob : 0));
    const medianProb = median(probs);
    const maxProb = probs.length ? Math.max(...probs) : null;
    const lateralMadM = mad(ds, medianD);
    const selected = selectRepresentative(filtered, medianS, medianD, opts);
    const binMeta = {
      binIndex,
      sourcePointCount: binPoints.length,
      distinctFrameCount,
      medianS,
      medianD,
      lateralMadM,
      medianProb,
      maxProb,
      selectedSourceIndex: selected.inputIndex + globalIndexBase,
      sourceDistanceM: Math.hypot(selected.p.s - medianS, selected.p.d - medianD),
    };
    const point = { ...selected.p, binMeta };
    return { point, binMeta };
  }

  function buildRawConnectedPolylines(points, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const stats = {
      inputPointCount: Array.isArray(points) ? points.length : 0,
      finitePointCount: 0,
      invalidPointCount: 0,
      groupCount: 0,
      polylineCount: 0,
      drawablePolylineCount: 0,
      gapSplits: 0,
      spatialStepSplits: 0,
      lateralStepSplits: 0,
      identitySplits: 0,
      emptyBinGaps: 0,
      dedupedPointCount: 0,
      isolatedPointCount: 0,
      rawPointCount: 0,
      representativePointCount: 0,
      compressionRatio: 0,
      outlierExcludedCount: 0,
      maxGapM: opts.maxGapM,
      maxStepM: opts.maxStepM,
      maxLateralStepM: opts.maxLateralStepM,
      robustBinSizeM: opts.robustBinSizeM,
      connectionIdentity: CONNECTION_IDENTITY,
      identityRejected: 0,
      crossIdentityConnections: 0,
      mode: 'raw',
    };

    if (!Array.isArray(points) || !points.length) return { polylines: [], stats };

    const groups = new Map();
    for (const p of points) {
      if (!isFinitePoint(p)) {
        stats.invalidPointCount++;
        continue;
      }
      stats.finitePointCount++;
      const key = groupConnectionKey(p);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }

    stats.groupCount = groups.size;
    stats.rawPointCount = stats.finitePointCount;
    const polylines = [];
    const metaBase = { mode: 'raw' };

    for (const [groupId, bucket] of groups) {
      const subgroups = partitionBySafety(bucket, stats);
      for (const subgroup of subgroups) {
        if (!subgroup.length) continue;
        const sorted = [...subgroup].sort(compareOrdered);
        const { points: deduped, deduped: dedupRemoved } = dedupeOrdered(sorted, opts);
        stats.dedupedPointCount += dedupRemoved;
        const first = deduped[0];
        const meta = {
          ...metaBase,
          groupId,
          chunkId: first.chunkId,
          passId: first.passId,
          groupTrackId: first.groupTrackId,
          groupKey: first.groupKey ?? null,
          laneIndex: first.laneIndex ?? null,
          side: first.side ?? null,
        };
        polylines.push(...splitPolylinesRaw(deduped, meta, opts, stats));
      }
    }

    stats.representativePointCount = stats.finitePointCount - stats.dedupedPointCount;
    stats.compressionRatio = stats.finitePointCount
      ? stats.representativePointCount / stats.finitePointCount
      : 0;
    stats.polylineCount = polylines.length;
    stats.drawablePolylineCount = polylines.filter((pl) => pl.pointCount >= 2).length;
    return { polylines, stats };
  }

  function buildRobustConnectedPolylines(points, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const stats = {
      inputPointCount: Array.isArray(points) ? points.length : 0,
      finitePointCount: 0,
      invalidPointCount: 0,
      groupCount: 0,
      polylineCount: 0,
      drawablePolylineCount: 0,
      gapSplits: 0,
      spatialStepSplits: 0,
      lateralStepSplits: 0,
      identitySplits: 0,
      emptyBinGaps: 0,
      dedupedPointCount: 0,
      isolatedPointCount: 0,
      rawPointCount: 0,
      representativePointCount: 0,
      compressionRatio: 0,
      outlierExcludedCount: 0,
      maxGapM: opts.maxGapM,
      maxStepM: opts.maxStepM,
      maxLateralStepM: opts.maxLateralStepM,
      robustBinSizeM: opts.robustBinSizeM,
      connectionIdentity: CONNECTION_IDENTITY,
      identityRejected: 0,
      crossIdentityConnections: 0,
      mode: 'robust',
    };

    if (!Array.isArray(points) || !points.length) return { polylines: [], stats };

    const groups = new Map();
    for (const p of points) {
      if (!isFiniteRobustPoint(p)) {
        stats.invalidPointCount++;
        continue;
      }
      stats.finitePointCount++;
      const key = groupConnectionKey(p);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }

    stats.groupCount = groups.size;
    stats.rawPointCount = stats.finitePointCount;
    const polylines = [];
    const metaBase = { mode: 'robust' };
    let representativePointCount = 0;

    for (const [groupId, bucket] of groups) {
      const subgroups = partitionBySafety(bucket, stats);
      for (const subgroup of subgroups) {
        if (!subgroup.length) continue;
        const bins = new Map();
        subgroup.forEach((p, inputIndex) => {
          const bIdx = binIndexForS(p.s, opts.robustBinSizeM);
          if (!bins.has(bIdx)) bins.set(bIdx, []);
          bins.get(bIdx).push({ p, inputIndex });
        });

        const reps = [];
        for (const [binIndex, entries] of bins) {
          const binPoints = entries.map((e) => e.p);
          const globalIndexBase = entries[0]?.inputIndex ?? 0;
          const rep = buildBinRepresentatives(binPoints, binIndex, globalIndexBase, stats, opts);
          reps.push(rep);
        }
        reps.sort(compareRepresentatives);
        representativePointCount += reps.length;

        const first = reps[0]?.point;
        if (!first) continue;
        const meta = {
          ...metaBase,
          groupId,
          chunkId: first.chunkId,
          passId: first.passId,
          groupTrackId: first.groupTrackId,
          groupKey: first.groupKey ?? null,
          laneIndex: first.laneIndex ?? null,
          side: first.side ?? null,
        };
        polylines.push(...splitPolylinesRobust(reps, meta, opts, stats));
      }
    }

    stats.representativePointCount = representativePointCount;
    stats.compressionRatio = stats.finitePointCount
      ? representativePointCount / stats.finitePointCount
      : 0;
    stats.polylineCount = polylines.length;
    stats.drawablePolylineCount = polylines.filter((pl) => pl.pointCount >= 2).length;
    return { polylines, stats };
  }

  function isFinitePerFramePoint(p) {
    return Number.isFinite(p?.localEast) && Number.isFinite(p?.localNorth);
  }

  function resolveOrderingField(point) {
    for (const field of ORDERING_FIELDS) {
      if (point[field] != null && Number.isFinite(point[field])) return field;
    }
    return 's';
  }

  function orderingValue(point, field) {
    if (field === 's') return point.s ?? 0;
    return point[field];
  }

  function perFrameGroupKey(p) {
    const framePart = p.frameId != null ? String(p.frameId) : `frameIndex:${p.frameIndex ?? 'x'}`;
    return `${p.chunkId}:${p.passId}:${p.groupTrackId}:${framePart}`;
  }

  function perFrameSafetyKey(p) {
    const framePart = p.frameId != null ? String(p.frameId) : `frameIndex:${p.frameIndex ?? 'x'}`;
    return `${p.chunkId}:${p.passId}:${p.groupTrackId}:${p.laneIndex ?? 'x'}:${p.side ?? 'x'}:${framePart}`;
  }

  function compareWithinFrame(a, b, field) {
    const va = orderingValue(a.point, field);
    const vb = orderingValue(b.point, field);
    if (va !== vb) return va - vb;
    const ds = (a.point.s ?? 0) - (b.point.s ?? 0);
    if (ds !== 0) return ds;
    const dd = (a.point.d ?? 0) - (b.point.d ?? 0);
    if (dd !== 0) return dd;
    return a.inputIndex - b.inputIndex;
  }

  function dedupePerFrame(entries, opts, stats) {
    const out = [];
    let removed = 0;
    for (const entry of entries) {
      const last = out[out.length - 1];
      if (last && localStepM(last.point, entry.point) <= opts.perFrameDedupM) {
        removed++;
        if ((entry.point.prob ?? 0) > (last.point.prob ?? 0)) out[out.length - 1] = entry;
        continue;
      }
      out.push(entry);
    }
    stats.duplicatePointCount += removed;
    return out;
  }

  function makePerFramePolyline(entries, meta) {
    const points = entries.map((e) => e.point);
    const ss = points.map((p) => p.s).filter(Number.isFinite);
    const first = points[0];
    return {
      groupId: meta.groupId,
      chunkId: meta.chunkId,
      passId: meta.passId,
      groupTrackId: meta.groupTrackId,
      groupKey: meta.groupKey ?? null,
      laneIndex: meta.laneIndex ?? null,
      side: meta.side ?? null,
      frameId: first.frameId ?? null,
      frameIndex: first.frameIndex ?? null,
      logMonoTime: first.logMonoTime ?? null,
      orderingField: meta.orderingField,
      points,
      pointCount: points.length,
      minS: ss.length ? Math.min(...ss) : null,
      maxS: ss.length ? Math.max(...ss) : null,
      mode: 'perFrame',
    };
  }

  function splitPolylinesPerFrame(entries, meta, opts, stats) {
    const polylines = [];
    if (entries.length < 2) {
      if (entries.length === 1) stats.isolatedPointCount++;
      return polylines;
    }
    const field = meta.orderingField;
    let run = [entries[0]];
    for (let i = 1; i < entries.length; i++) {
      const prev = run[run.length - 1];
      const next = entries[i];
      const step = localStepM(prev.point, next.point);
      const prevVal = orderingValue(prev.point, field);
      const nextVal = orderingValue(next.point, field);
      const orderReversal = nextVal < prevVal;
      const stepSplit = step > opts.maxStepM;
      if (stepSplit || orderReversal) {
        if (stepSplit) stats.spatialStepSplits++;
        if (orderReversal) stats.orderingReversals = (stats.orderingReversals ?? 0) + 1;
        if (run.length >= 2) polylines.push(makePerFramePolyline(run, meta));
        else if (run.length === 1) stats.isolatedPointCount++;
        run = [next];
      } else {
        run.push(next);
      }
    }
    if (run.length >= 2) polylines.push(makePerFramePolyline(run, meta));
    else if (run.length === 1) stats.isolatedPointCount++;
    return polylines;
  }

  function buildPerFrameConnectedPolylines(points, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const stats = {
      mode: 'perFrame',
      inputPointCount: Array.isArray(points) ? points.length : 0,
      finitePointCount: 0,
      invalidPointCount: 0,
      identityGroupCount: 0,
      frameGroupCount: 0,
      polylineCount: 0,
      drawablePolylineCount: 0,
      duplicatePointCount: 0,
      spatialStepSplits: 0,
      isolatedPointCount: 0,
      crossFrameConnections: 0,
      mixedIdentityPolylines: 0,
      orderingFieldCounts: {},
      orderingReversals: 0,
      maxStepM: opts.maxStepM,
    };

    if (!Array.isArray(points) || !points.length) return { polylines: [], stats };

    const groups = new Map();
    for (let inputIndex = 0; inputIndex < points.length; inputIndex++) {
      const p = points[inputIndex];
      if (!isFinitePerFramePoint(p)) {
        stats.invalidPointCount++;
        continue;
      }
      stats.finitePointCount++;
      const sk = perFrameSafetyKey(p);
      if (!groups.has(sk)) groups.set(sk, []);
      groups.get(sk).push({ point: p, inputIndex });
    }

    stats.frameGroupCount = groups.size;
    const identityKeys = new Set([...groups.keys()].map((k) => {
      const pt = groups.get(k)[0].point;
      return groupConnectionKey(pt);
    }));
    stats.identityGroupCount = identityKeys.size;

    const polylines = [];
    for (const [groupId, bucket] of groups) {
      const fieldCounts = {};
      for (const entry of bucket) {
        const f = resolveOrderingField(entry.point);
        fieldCounts[f] = (fieldCounts[f] || 0) + 1;
      }
      let orderingField = 's';
      let bestCount = -1;
      for (const [f, c] of Object.entries(fieldCounts)) {
        if (c > bestCount) { bestCount = c; orderingField = f; }
      }
      stats.orderingFieldCounts[orderingField] = (stats.orderingFieldCounts[orderingField] || 0) + 1;

      const sorted = [...bucket].sort((a, b) => compareWithinFrame(a, b, orderingField));
      const deduped = dedupePerFrame(sorted, opts, stats);
      const first = deduped[0]?.point;
      if (!first) continue;
      const meta = {
        groupId,
        chunkId: first.chunkId,
        passId: first.passId,
        groupTrackId: first.groupTrackId,
        groupKey: first.groupKey ?? null,
        laneIndex: first.laneIndex ?? null,
        side: first.side ?? null,
        orderingField,
      };
      polylines.push(...splitPolylinesPerFrame(deduped, meta, opts, stats));
    }

    for (const pl of polylines) {
      const frameIds = new Set(pl.points.map((p) => p.frameId ?? `fi:${p.frameIndex}`));
      if (frameIds.size > 1) {
        stats.mixedIdentityPolylines++;
        stats.crossFrameConnections++;
      }
      if (polylineCrossesLaneIdentity(pl)) stats.mixedIdentityPolylines++;
    }

    stats.polylineCount = polylines.length;
    stats.drawablePolylineCount = polylines.filter((pl) => pl.pointCount >= 2).length;
    return { polylines, stats };
  }

  function frameKeyForPolyline(pl) {
    return pl.frameId != null ? String(pl.frameId) : `frameIndex:${pl.frameIndex ?? 'x'}`;
  }

  function polylineLogMonoTime(pl) {
    const pt = pl.points?.[0];
    return pt?.logMonoTime ?? null;
  }

  function buildPerFramePolylineIndex(polylines) {
    const polylinesByFrameId = new Map();
    const polylinesByFrameIndex = new Map();
    const orderedFrameTimes = [];
    const seen = new Set();
    for (const pl of polylines || []) {
      const fk = frameKeyForPolyline(pl);
      if (!polylinesByFrameId.has(fk)) polylinesByFrameId.set(fk, []);
      polylinesByFrameId.get(fk).push(pl);
      if (pl.frameIndex != null) {
        if (!polylinesByFrameIndex.has(pl.frameIndex)) polylinesByFrameIndex.set(pl.frameIndex, []);
        polylinesByFrameIndex.get(pl.frameIndex).push(pl);
      }
      const mono = polylineLogMonoTime(pl);
      if (mono != null && !seen.has(fk)) {
        seen.add(fk);
        orderedFrameTimes.push({
          frameKey: fk,
          frameId: pl.frameId ?? null,
          frameIndex: pl.frameIndex ?? null,
          logMonoTime: String(mono),
        });
      }
    }
    orderedFrameTimes.sort((a, b) => {
      const cmp = compareLogMono(a.logMonoTime, b.logMonoTime);
      if (cmp !== 0) return cmp;
      return a.frameKey.localeCompare(b.frameKey);
    });
    return { polylinesByFrameId, polylinesByFrameIndex, orderedFrameTimes };
  }

  function selectCurrentFramePolylines(allPolylines, activeFrame) {
    const frameIndex = buildPerFramePolylineIndex(allPolylines);
    if (activeFrame?.frameId != null) {
      const key = String(activeFrame.frameId);
      const polys = frameIndex.polylinesByFrameId.get(key);
      if (polys?.length) {
        return { polylines: polys, selectionMethod: 'frameId', selectedFrameKey: key, frameIndex };
      }
    }
    if (activeFrame?.frameIndex != null) {
      const polys = frameIndex.polylinesByFrameIndex.get(activeFrame.frameIndex);
      if (polys?.length) {
        return {
          polylines: polys,
          selectionMethod: 'frameIndex',
          selectedFrameKey: frameKeyForPolyline(polys[0]),
          frameIndex,
        };
      }
    }
    if (activeFrame?.logMonoTime != null) {
      const activeT = BigInt(String(activeFrame.logMonoTime));
      let best = null;
      for (const entry of frameIndex.orderedFrameTimes) {
        const t = BigInt(entry.logMonoTime);
        if (t <= activeT) best = entry;
        else break;
      }
      if (best) {
        const polys = frameIndex.polylinesByFrameId.get(best.frameKey) || [];
        if (polys.length) {
          return {
            polylines: polys,
            selectionMethod: 'previousByTime',
            selectedFrameKey: best.frameKey,
            frameIndex,
          };
        }
      }
    }
    return { polylines: [], selectionMethod: 'none', selectedFrameKey: null, frameIndex };
  }

  function countCrossFramePolylines(polylines) {
    let n = 0;
    for (const pl of polylines || []) {
      const frames = new Set((pl.points || []).map((p) => p.frameId ?? `fi:${p.frameIndex}`));
      if (frames.size > 1) n++;
    }
    return n;
  }

  function countMixedIdentityPolylines(polylines) {
    let n = 0;
    for (const pl of polylines || []) {
      if (polylineCrossesLaneIdentity(pl)) n++;
      const lanes = new Set((pl.points || []).map((p) => p.laneIndex));
      const sides = new Set((pl.points || []).map((p) => p.side));
      const tracks = new Set((pl.points || []).map((p) => p.groupTrackId));
      if (lanes.size > 1 || sides.size > 1 || tracks.size > 1) n++;
    }
    return n;
  }

  function buildCurrentFrameDisplay(allPolylines, activeFrame, allStats) {
    const selected = selectCurrentFramePolylines(allPolylines, activeFrame);
    const observationCount = selected.polylines.reduce((n, pl) => n + (pl.pointCount || 0), 0);
    const drawable = selected.polylines.filter((pl) => (pl.pointCount || 0) >= 2);
    return {
      polylines: drawable,
      stats: {
        mode: 'currentFrame',
        selectionMethod: selected.selectionMethod,
        selectedFrameId: activeFrame?.frameId ?? null,
        selectedFrameIndex: activeFrame?.frameIndex ?? null,
        selectedFrameKey: selected.selectedFrameKey,
        polylineCount: selected.polylines.length,
        drawablePolylineCount: drawable.length,
        observationCount,
        finitePointCount: allStats?.finitePointCount ?? null,
        inputPointCount: allStats?.inputPointCount ?? null,
        noFrameMessage: selected.selectionMethod === 'none'
          ? 'No modelV2 lane frame available at this playback position'
          : null,
      },
      frameIndex: selected.frameIndex,
    };
  }

  function compareCurrentFrameMetrics(points, activeFrame, options = {}) {
    const perFrame = buildPerFrameConnectedPolylines(points, options);
    const current = buildCurrentFrameDisplay(perFrame.polylines, activeFrame, perFrame.stats);
    const allFrameCounts = new Map();
    for (const pl of perFrame.polylines) {
      const fk = frameKeyForPolyline(pl);
      allFrameCounts.set(fk, (allFrameCounts.get(fk) || 0) + 1);
    }
    const counts = [...allFrameCounts.values()];
    const med = (arr) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    return {
      perFrame,
      current,
      totalModelV2Frames: allFrameCounts.size,
      allPerFramePolylineCount: perFrame.stats.polylineCount,
      currentFramePolylineCounts: counts,
      minCurrentFramePolylines: counts.length ? Math.min(...counts) : 0,
      medianCurrentFramePolylines: med(counts),
      maxCurrentFramePolylines: counts.length ? Math.max(...counts) : 0,
      framesWithZeroDrawable: [...allFrameCounts.keys()].filter((fk) => (allFrameCounts.get(fk) || 0) === 0).length,
      crossFrameConnections: countCrossFramePolylines(current.polylines),
      mixedIdentityPolylines: countMixedIdentityPolylines(current.polylines),
      selfIntersections: countSelfIntersections(current.polylines),
    };
  }

  function evaluateCurrentFrameAcceptance(segmentMetrics) {
    const checks = [];
    const seg = (id) => segmentMetrics[`qlog_f449c_${id}.bz2`];

    checks.push({
      id: 'single_frame_source',
      pass: Object.values(segmentMetrics).every((m) => (m.crossFrameConnections ?? 0) === 0),
    });
    checks.push({
      id: 'no_mixed_identity',
      pass: Object.values(segmentMetrics).every((m) => (m.mixedIdentityPolylines ?? 0) === 0),
    });

    const s13 = seg(13)?.medianCurrentFramePolylineCount ?? seg(13)?.medianCurrentFramePolylines ?? 0;
    checks.push({ id: 'seg13_median_curves', pass: s13 >= 2 && s13 <= 4, median: s13 });
    const s14 = seg(14)?.medianCurrentFramePolylineCount ?? seg(14)?.medianCurrentFramePolylines ?? 0;
    checks.push({ id: 'seg14_median_curves', pass: s14 >= 2 && s14 <= 4, median: s14 });

    const seg99 = seg(99);
    let seg99LaneSeparation = true;
    if (seg99?.mixedIdentityPolylines != null) {
      seg99LaneSeparation = (seg99.mixedIdentityPolylines ?? 0) === 0;
    }
    checks.push({ id: 'seg99_lane_change_separation', pass: seg99LaneSeparation });

    return { passed: checks.every((c) => c.pass), checks };
  }

  function buildConnectedPolylines(points, options = {}) {
    const mode = options.mode === 'raw' ? 'raw'
      : (options.mode === 'robust' ? 'robust' : 'perFrame');
    if (mode === 'raw') return buildRawConnectedPolylines(points, options);
    if (mode === 'robust') return buildRobustConnectedPolylines(points, options);
    return buildPerFrameConnectedPolylines(points, options);
  }

  function filterPointsForCausal(points, elapsedIdx) {
    const elapsed = Math.max(0, Number(elapsedIdx) || 0);
    return (points || []).filter((p) => (p.frameIndex != null ? p.frameIndex <= elapsed : true));
  }

  function polylineCrossesLaneIdentity(polyline) {
    const pts = polyline?.points || [];
    if (pts.length < 2) return false;
    const lane0 = pts[0].laneIndex;
    const side0 = pts[0].side;
    return pts.some((p) => p.laneIndex !== lane0 || p.side !== side0);
  }

  function iterPolylineEdges(polylines) {
    const edges = [];
    for (const pl of polylines || []) {
      const pts = pl.points || [];
      for (let i = 1; i < pts.length; i++) {
        edges.push({ prev: pts[i - 1], next: pts[i], polyline: pl });
      }
    }
    return edges;
  }

  function countZigzagEdges(polylines) {
    let count = 0;
    for (const { prev, next } of iterPolylineEdges(polylines)) {
      const ds = Math.abs((next.s ?? 0) - (prev.s ?? 0));
      const dd = Math.abs((next.d ?? 0) - (prev.d ?? 0));
      if (ds <= 2 && dd > 0.75) count++;
    }
    return count;
  }

  function countDirectionReversals(polylines) {
    let reversals = 0;
    for (const pl of polylines || []) {
      const pts = pl.points || [];
      let lastSign = 0;
      for (let i = 1; i < pts.length; i++) {
        const dd = (pts[i].d ?? 0) - (pts[i - 1].d ?? 0);
        if (dd === 0) continue;
        const sign = dd > 0 ? 1 : -1;
        if (lastSign !== 0 && sign !== lastSign) reversals++;
        lastSign = sign;
      }
    }
    return reversals;
  }

  function lateralJumps(polylines) {
    const jumps = [];
    for (const { prev, next } of iterPolylineEdges(polylines)) {
      jumps.push(Math.abs((next.d ?? 0) - (prev.d ?? 0)));
    }
    return jumps;
  }

  function percentile(arr, p) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
    return s[idx];
  }

  function totalDrawnLengthM(polylines) {
    let len = 0;
    for (const { prev, next } of iterPolylineEdges(polylines)) {
      len += localStepM(prev, next);
    }
    return len;
  }

  function sourceDistances(polylines) {
    const dists = [];
    for (const pl of polylines || []) {
      for (const p of pl.points || []) {
        if (p.binMeta?.sourceDistanceM != null) dists.push(p.binMeta.sourceDistanceM);
      }
    }
    return dists;
  }

  function maxBridgeLengthM(polylines) {
    let max = 0;
    for (const { prev, next } of iterPolylineEdges(polylines)) {
      max = Math.max(max, localStepM(prev, next));
    }
    return max;
  }

  function segmentsIntersect(a1, a2, b1, b2) {
    function orient(ax, ay, bx, by, cx, cy) {
      return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    }
    const o1 = orient(a1.localEast, a1.localNorth, a2.localEast, a2.localNorth, b1.localEast, b1.localNorth);
    const o2 = orient(a1.localEast, a1.localNorth, a2.localEast, a2.localNorth, b2.localEast, b2.localNorth);
    const o3 = orient(b1.localEast, b1.localNorth, b2.localEast, b2.localNorth, a1.localEast, a1.localNorth);
    const o4 = orient(b1.localEast, b1.localNorth, b2.localEast, b2.localNorth, a2.localEast, a2.localNorth);
    return (o1 === 0 && o2 === 0 && o3 === 0 && o4 === 0)
      ? false
      : (o1 * o2 < 0 && o3 * o4 < 0);
  }

  function countSelfIntersections(polylines) {
    let hits = 0;
    for (const pl of polylines || []) {
      const pts = pl.points || [];
      for (let i = 0; i < pts.length - 1; i++) {
        for (let j = i + 2; j < pts.length - 1; j++) {
          if (i === 0 && j === pts.length - 2) continue;
          if (segmentsIntersect(pts[i], pts[i + 1], pts[j], pts[j + 1])) hits++;
        }
      }
    }
    return hits;
  }

  function spatialEdges(polylines) {
    const edges = [];
    for (const { prev, next } of iterPolylineEdges(polylines)) {
      edges.push(localStepM(prev, next));
    }
    return edges;
  }

  function compareRawPerFrameMetrics(points, options = {}) {
    const raw = buildRawConnectedPolylines(points, options);
    const perFrame = buildPerFrameConnectedPolylines(points, options);
    const rawSpatial = spatialEdges(raw.polylines);
    const pfSpatial = spatialEdges(perFrame.polylines);

    const framePolyCounts = new Map();
    for (const pl of perFrame.polylines) {
      const fk = pl.frameId ?? `fi:${pl.frameIndex}`;
      framePolyCounts.set(fk, (framePolyCounts.get(fk) || 0) + 1);
    }
    const perFrameCounts = [...framePolyCounts.values()];
    const median = (arr) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };

    const row = (stats, polylines, spatial) => ({
      inputObservations: stats.inputPointCount,
      frameGroups: stats.frameGroupCount ?? stats.groupCount ?? 0,
      drawablePolylines: stats.drawablePolylineCount,
      spatialStepSplits: stats.spatialStepSplits,
      duplicatePoints: stats.duplicatePointCount ?? stats.dedupedPointCount ?? 0,
      crossFrameConnections: stats.crossFrameConnections ?? 0,
      mixedIdentityPolylines: stats.mixedIdentityPolylines ?? 0,
      maxSpatialEdge: spatial.length ? Math.max(...spatial) : 0,
      p95SpatialEdge: percentile(spatial, 95),
      zigzagEdgeCount: countZigzagEdges(polylines),
      selfIntersections: countSelfIntersections(polylines),
      totalDrawnLength: totalDrawnLengthM(polylines),
    });

    return {
      raw: row(raw.stats, raw.polylines, rawSpatial),
      perFrame: {
        ...row(perFrame.stats, perFrame.polylines, pfSpatial),
        representedFrames: framePolyCounts.size,
        minPolylinesPerFrame: perFrameCounts.length ? Math.min(...perFrameCounts) : 0,
        medianPolylinesPerFrame: median(perFrameCounts),
        maxPolylinesPerFrame: perFrameCounts.length ? Math.max(...perFrameCounts) : 0,
        orderingFieldCounts: perFrame.stats.orderingFieldCounts,
        polylinesWithMultipleFrames: perFrame.polylines.filter((pl) => {
          const ids = new Set(pl.points.map((p) => p.frameId ?? `fi:${p.frameIndex}`));
          return ids.size > 1;
        }).length,
      },
      rawPolylines: raw.polylines,
      perFramePolylines: perFrame.polylines,
    };
  }

  function evaluatePerFrameAcceptance(comparisons) {
    const checks = [];
    const seg = (id) => comparisons[`qlog_f449c_${id}.bz2`];

    const cross = Object.values(comparisons).every((c) => (c.perFrame?.crossFrameConnections ?? 0) === 0
      && (c.perFrame?.mixedIdentityPolylines ?? 0) === 0
      && (c.perFrame?.polylinesWithMultipleFrames ?? 0) === 0);
    checks.push({ id: 'no_cross_frame', pass: cross });

    function zigDrop(id, label, minPct) {
      const raw = seg(id)?.raw?.zigzagEdgeCount ?? 0;
      const pf = seg(id)?.perFrame?.zigzagEdgeCount ?? 0;
      const reduction = raw > 0 ? (raw - pf) / raw : (pf === 0 ? 1 : 0);
      checks.push({
        id: label,
        pass: raw === 0 ? pf === 0 : reduction >= minPct,
        raw,
        perFrame: pf,
        reductionPct: +(reduction * 100).toFixed(1),
      });
    }

    zigDrop(13, 'seg13_zigzag_reduction_90pct', 0.9);
    zigDrop(95, 'seg95_zigzag_reduction_90pct', 0.9);

    const s14raw = seg(14)?.raw?.zigzagEdgeCount ?? 0;
    const s14pf = seg(14)?.perFrame?.zigzagEdgeCount ?? 0;
    checks.push({ id: 'seg14_remains_clean', pass: s14pf <= s14raw * 1.1, raw: s14raw, perFrame: s14pf });

    const selfHits = Object.values(comparisons).every((c) => (c.perFrame?.selfIntersections ?? 0) === 0);
    checks.push({ id: 'no_self_intersections', pass: selfHits });

    const maxEdge = Math.max(...Object.values(comparisons).map((c) => c.perFrame?.maxSpatialEdge ?? 0), 0);
    checks.push({ id: 'no_spatial_edge_over_14m', pass: maxEdge <= 14 + 1e-6, maxSpatialEdge: maxEdge });

    return { passed: checks.every((c) => c.pass), checks };
  }

  function compareModeMetrics(points, options = {}) {
    const raw = buildRawConnectedPolylines(points, options);
    const robust = buildRobustConnectedPolylines(points, options);
    const rawJumps = lateralJumps(raw.polylines);
    const robustJumps = lateralJumps(robust.polylines);
    const rawSource = sourceDistances(raw.polylines);
    const robustSource = sourceDistances(robust.polylines);
    const row = (stats, polylines, jumps, srcDists) => ({
      inputObservations: stats.inputPointCount,
      representativePoints: stats.representativePointCount,
      polylineCount: stats.polylineCount,
      gapSplits: stats.gapSplits,
      spatialStepSplits: stats.spatialStepSplits,
      lateralStepSplits: stats.lateralStepSplits ?? 0,
      outliersExcluded: stats.outlierExcludedCount ?? 0,
      maxLateralJump: jumps.length ? Math.max(...jumps) : 0,
      p95LateralJump: percentile(jumps, 95),
      zigzagEdgeCount: countZigzagEdges(polylines),
      directionReversals: countDirectionReversals(polylines),
      totalDrawnLength: totalDrawnLengthM(polylines),
      medianSourceDistance: percentile(srcDists, 50),
      p95SourceDistance: percentile(srcDists, 95),
      maxBridgeLengthM: maxBridgeLengthM(polylines),
      selfIntersections: countSelfIntersections(polylines),
    });
    return {
      raw: row(raw.stats, raw.polylines, rawJumps, rawSource),
      robust: row(robust.stats, robust.polylines, robustJumps, robustSource),
      rawPolylines: raw.polylines,
      robustPolylines: robust.polylines,
    };
  }

  function traceSmallestRobustGap(polylines) {
    let best = null;
    for (const pl of polylines || []) {
      const pts = pl.points || [];
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1];
        const next = pts[i];
        const ds = Math.abs((next.s ?? 0) - (prev.s ?? 0));
        const dd = Math.abs((next.d ?? 0) - (prev.d ?? 0));
        const step = localStepM(prev, next);
        const gap = { polyline: pl, index: i, prev, next, ds, dd, step };
        if (!best || ds < best.ds) best = gap;
      }
    }
    return best;
  }

  function classifyRobustSplit(prev, next, opts = DEFAULTS) {
    if (safetyKey(prev) !== safetyKey(next)) return 'identity change';
    const ds = Math.abs((next.s ?? 0) - (prev.s ?? 0));
    const dd = Math.abs((next.d ?? 0) - (prev.d ?? 0));
    const step = localStepM(prev, next);
    if (ds > opts.maxGapM) return 'along-track gap';
    if (step > opts.maxStepM) return 'spatial step';
    if (dd > opts.maxLateralStepM) return 'lateral step';
    if (prev.binMeta?.binIndex != null && next.binMeta?.binIndex != null
      && next.binMeta.binIndex - prev.binMeta.binIndex > 1) return 'empty bin interval';
    return 'input polyline boundary';
  }

  const api = {
    CONNECTION_IDENTITY,
    DEFAULTS,
    buildRawConnectedPolylines,
    buildRobustConnectedPolylines,
    buildPerFrameConnectedPolylines,
    buildConnectedPolylines,
    buildPerFramePolylineIndex,
    selectCurrentFramePolylines,
    buildCurrentFrameDisplay,
    compareCurrentFrameMetrics,
    evaluateCurrentFrameAcceptance,
    frameKeyForPolyline,
    filterPointsForCausal,
    polylineCrossesLaneIdentity,
    groupConnectionKey,
    safetyKey,
    perFrameGroupKey,
    perFrameSafetyKey,
    resolveOrderingField,
    ORDERING_FIELDS,
    compareOrdered,
    isFinitePoint,
    countZigzagEdges,
    countDirectionReversals,
    compareModeMetrics,
    compareRawPerFrameMetrics,
    evaluatePerFrameAcceptance,
    countCrossFramePolylines,
    countMixedIdentityPolylines,
    traceSmallestRobustGap,
    classifyRobustSplit,
    binIndexForS,
    maxBridgeLengthM,
    countSelfIntersections,
    spatialEdges,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.ConnectedAccumulatedDisplay = api;
}(typeof window !== 'undefined' ? window : globalThis));
