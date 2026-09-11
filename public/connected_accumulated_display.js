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

  /** Along-track heading in (s,d) — stable for lane following; ignores EN jitter. */
  function alongTrackHeadingDeg(a, b) {
    return Math.atan2((b.d ?? 0) - (a.d ?? 0), (b.s ?? 0) - (a.s ?? 0)) * (180 / Math.PI);
  }

  function absHeadingDiffDeg(a, b) {
    let d = a - b;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return Math.abs(d);
  }

  function splitPolylinesRobust(reps, meta, opts, stats) {
    const polylines = [];
    if (reps.length < 2) {
      if (reps.length === 1) stats.isolatedPointCount++;
      return polylines;
    }

    let run = [reps[0]];
    let prevHeading = null;
    const minHeadingStepM = Number.isFinite(opts.minHeadingStepM) ? opts.minHeadingStepM : 1.0;
    for (let i = 1; i < reps.length; i++) {
      const prev = run[run.length - 1];
      const next = reps[i];
      const prevPt = prev.point;
      const nextPt = next.point;
      const ds = Math.abs((nextPt.s ?? 0) - (prevPt.s ?? 0));
      const dd = Math.abs((nextPt.d ?? 0) - (prevPt.d ?? 0));
      const step = localStepM(prevPt, nextPt);
      const stepHeading = alongTrackHeadingDeg(prevPt, nextPt);
      const gapSplit = ds > opts.maxGapM;
      const stepSplit = step > opts.maxStepM;
      const lateralSplit = dd > opts.maxLateralStepM;
      const identitySplit = safetyKey(prevPt) !== safetyKey(nextPt);
      const headingEligible = ds >= minHeadingStepM;
      const headingSplit = Number.isFinite(opts.maxHeadingDiffDeg)
        && headingEligible
        && prevHeading != null
        && absHeadingDiffDeg(stepHeading, prevHeading) > opts.maxHeadingDiffDeg;
      if (prev.binMeta.binIndex != null && next.binMeta.binIndex != null
        && next.binMeta.binIndex - prev.binMeta.binIndex > 1) {
        stats.emptyBinGaps++;
      }

      if (gapSplit || stepSplit || lateralSplit || identitySplit || headingSplit) {
        if (gapSplit) stats.gapSplits++;
        if (stepSplit) stats.spatialStepSplits++;
        if (lateralSplit) stats.lateralStepSplits++;
        if (identitySplit) stats.identitySplits++;
        if (headingSplit) stats.headingSplits = (stats.headingSplits || 0) + 1;
        if (run.length >= 2) polylines.push(makePolyline(run.map((r) => r.point), meta));
        else if (run.length === 1) stats.isolatedPointCount++;
        run = [next];
        prevHeading = null;
      } else {
        run.push(next);
        if (headingEligible) prevHeading = stepHeading;
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
      headingSplits: 0,
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

  /**
   * Representative lane lines from trusted All per-frame curves.
   * Reuses buildRobustConnectedPolylines (bin-median path) but only admits
   * points that already form valid per-frame polylines — never fused lines.
   */
  function enrichRepresentativePolyline(pl) {
    const pts = pl.points || [];
    const supports = [];
    const spreads = [];
    for (const p of pts) {
      const bm = p.binMeta;
      if (!bm) continue;
      if (Number.isFinite(bm.distinctFrameCount)) supports.push(bm.distinctFrameCount);
      if (Number.isFinite(bm.lateralMadM)) spreads.push(bm.lateralMadM);
    }
    const supportCount = supports.length ? Math.max(...supports) : 0;
    const meanSupport = supports.length
      ? supports.reduce((a, b) => a + b, 0) / supports.length
      : 0;
    const lateralSpread = spreads.length ? Math.max(...spreads) : 0;
    return {
      ...pl,
      mode: 'representativeFromPerFrame',
      sourceStage: 'perFrame→robust',
      supportCount,
      meanSupport,
      lateralSpread,
    };
  }

  function buildRepresentativeLaneLinesLegacyFromPerFrame(perFramePolylines, options = {}) {
    const opts = {
      ...DEFAULTS,
      minSourceCurvePoints: 3,
      minSourceCurveLengthM: 2.0,
      minSupportFramesPerBin: 1,
      minPolylineSupportFrames: 2,
      minPolylinePoints: 3,
      maxHeadingDiffDeg: 60,
      minHeadingStepM: 2.0,
      ...options,
    };
    const source = Array.isArray(perFramePolylines) ? perFramePolylines : [];
    let rejectedCurveCount = 0;
    const acceptedCurves = [];
    for (const pl of source) {
      const pts = pl?.points || [];
      if (pts.length < opts.minSourceCurvePoints) {
        rejectedCurveCount += 1;
        continue;
      }
      let lengthM = 0;
      for (let i = 1; i < pts.length; i++) lengthM += localStepM(pts[i - 1], pts[i]);
      if (!(lengthM >= opts.minSourceCurveLengthM)) {
        rejectedCurveCount += 1;
        continue;
      }
      if (!Number.isFinite(pts[0]?.s) || !Number.isFinite(pts[0]?.d)) {
        // Per-frame curves without s/d cannot enter the robust bin path.
        rejectedCurveCount += 1;
        continue;
      }
      acceptedCurves.push(pl);
    }

    const flat = [];
    const sourceFrames = new Set();
    for (const pl of acceptedCurves) {
      for (const p of pl.points || []) {
        if (!isFiniteRobustPoint(p)) continue;
        if (p.frameId != null) sourceFrames.add(p.frameId);
        flat.push({
          ...p,
          sourceCurveGroupId: pl.groupId ?? null,
          sourceCurveFrameId: pl.frameId ?? p.frameId ?? null,
        });
      }
    }

    const robust = buildRobustConnectedPolylines(flat, opts);
    let weakRejected = 0;
    const enriched = [];
    for (const pl of robust.polylines || []) {
      const e = enrichRepresentativePolyline(pl);
      if ((e.points || []).length < opts.minPolylinePoints
        || e.supportCount < opts.minPolylineSupportFrames) {
        weakRejected += 1;
        continue;
      }
      enriched.push(e);
    }

    const supportCounts = [];
    const lateralSpreads = [];
    for (const pl of enriched) {
      if (Number.isFinite(pl.supportCount)) supportCounts.push(pl.supportCount);
      if (Number.isFinite(pl.lateralSpread)) lateralSpreads.push(pl.lateralSpread);
    }
    const rangeOf = (arr) => {
      if (!arr.length) return { min: null, max: null };
      return { min: Math.min(...arr), max: Math.max(...arr) };
    };

    const stats = {
      ...robust.stats,
      mode: 'representativeFromPerFrame',
      candidateActive: true,
      sourceCurveCount: source.length,
      acceptedSourceCurveCount: acceptedCurves.length,
      rejectedCurveCount: rejectedCurveCount + weakRejected,
      weakPolylineRejectedCount: weakRejected,
      sourceFrameCount: sourceFrames.size,
      representativeLineCount: enriched.length,
      splitReasonCounts: {
        alongTrackGap: robust.stats.gapSplits || 0,
        spatialStep: robust.stats.spatialStepSplits || 0,
        lateralStep: robust.stats.lateralStepSplits || 0,
        identity: robust.stats.identitySplits || 0,
        emptyBinInterval: robust.stats.emptyBinGaps || 0,
        incompatibleHeading: robust.stats.headingSplits || 0,
      },
      supportRange: rangeOf(supportCounts),
      lateralSpreadRange: rangeOf(lateralSpreads),
      reusedStage: 'buildRobustConnectedPolylines',
      maxHeadingDiffDeg: opts.maxHeadingDiffDeg,
      minHeadingStepM: opts.minHeadingStepM,
    };

    return { polylines: enriched, stats };
  }

  const CURVE_ASSOC_DEFAULTS = {
    // Admission of source per-frame curves.
    minSourceCurvePoints: 3,
    minSourceCurveLengthM: 2.0,
    // Association of complete curves into physical-lane clusters.
    assocSampleM: 2.0,
    minAssocOverlapM: 3.0,
    clusterLateralTolM: 2.5,
    clusterHeadingTolDeg: 70,
    // Shared along-track station fitting.
    stationSpacingM: 1.0,
    minSupportFramesPerBin: 2,
    outlierMadFloorM: 0.75,
    outlierMadMultiplier: 3,
    smoothRadiusStations: 3,
    trustedModelXM: 80,
    // Continuity / splitting on the fitted representative path.
    maxSupportedGapM: 8,
    maxStepM: 7,
    maxLateralStepM: 100,
    driftPersistM: 60,
    maxHeadingDiffDeg: 60,
    minHeadingStepM: 2.0,
    // Output acceptance.
    minPolylinePoints: 3,
    minPolylineSupportFrames: 2,
    minPolylineCoverageM: 2.0,
  };

  function sortCurvePointsByS(curve) {
    const pts = (curve?.points || []).filter((p) => isFiniteRobustPoint(p)
      && Number.isFinite(p.localEast) && Number.isFinite(p.localNorth));
    pts.sort((a, b) => (a.s - b.s) || ((a.frameIndex ?? 0) - (b.frameIndex ?? 0)));
    return pts;
  }

  function enrichCurveForAssociation(pl) {
    const pts = sortCurvePointsByS(pl);
    if (pts.length < 2) return null;
    return {
      pl,
      pts,
      chunkId: pl.chunkId,
      passId: pl.passId,
      groupTrackId: pl.groupTrackId,
      laneIndex: pl.laneIndex ?? null,
      side: pl.side ?? null,
      groupId: pl.groupId ?? null,
      frameId: pl.frameId ?? pl.frameIndex ?? null,
      frameIndex: pl.frameIndex ?? null,
      logMonoTime: pl.logMonoTime ?? null,
      minS: pts[0].s,
      maxS: pts[pts.length - 1].s,
    };
  }

  function interpCurvePointAtS(curve, s0) {
    const pts = curve.pts;
    if (!pts.length) return null;
    if (s0 < pts[0].s - 1e-9 || s0 > pts[pts.length - 1].s + 1e-9) return null;
    if (pts.length === 1 || s0 <= pts[0].s + 1e-9) return pts[0];
    if (s0 >= pts[pts.length - 1].s - 1e-9) return pts[pts.length - 1];
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].s <= s0) lo = mid;
      else hi = mid;
    }
    const a = pts[lo];
    const b = pts[hi];
    if (b.s - a.s < 1e-9) return a;
    const t = (s0 - a.s) / (b.s - a.s);
    const out = { ...a };
    const lerp = (x, y) => (x ?? 0) + ((y ?? 0) - (x ?? 0)) * t;
    out.s = s0;
    out.d = lerp(a.d, b.d);
    out.localEast = lerp(a.localEast, b.localEast);
    out.localNorth = lerp(a.localNorth, b.localNorth);
    if (Number.isFinite(a.modelX) && Number.isFinite(b.modelX)) {
      out.modelX = lerp(a.modelX, b.modelX);
    }
    if (Number.isFinite(a.mirroredLocalEast) && Number.isFinite(b.mirroredLocalEast)) {
      out.mirroredLocalEast = lerp(a.mirroredLocalEast, b.mirroredLocalEast);
    }
    if (Number.isFinite(a.mirroredLocalNorth) && Number.isFinite(b.mirroredLocalNorth)) {
      out.mirroredLocalNorth = lerp(a.mirroredLocalNorth, b.mirroredLocalNorth);
    }
    return out;
  }

  function meanHeadingDeg(points) {
    if (!points || points.length < 2) return null;
    const last = points[points.length - 1];
    const first = points[0];
    let deg = Math.atan2(
      (last.localNorth ?? 0) - (first.localNorth ?? 0),
      (last.localEast ?? 0) - (first.localEast ?? 0),
    ) * (180 / Math.PI);
    while (deg > 180) deg -= 360;
    while (deg < -180) deg += 360;
    return deg;
  }

  function curveSeparationToCluster(curve, cluster, opts) {
    // Robust median |d_curve - d_clusterMedian| over overlapping stations.
    const overlapMin = Math.max(curve.minS, cluster.minS);
    const overlapMax = Math.min(curve.maxS, cluster.maxS);
    const span = overlapMax - overlapMin;
    if (span < opts.minAssocOverlapM) return null;
    const diffs = [];
    let coverM = 0;
    for (let s0 = overlapMin + opts.assocSampleM / 2; s0 <= overlapMax; s0 += opts.assocSampleM) {
      const vCurve = interpCurvePointAtS(curve, s0);
      if (!vCurve) continue;
      const clusterDs = [];
      for (const m of cluster.curves) {
        const v = interpCurvePointAtS(m, s0);
        if (v) clusterDs.push(v.d);
      }
      if (!clusterDs.length) continue;
      const med = median(clusterDs);
      if (med == null) continue;
      diffs.push(Math.abs(vCurve.d - med));
      coverM += opts.assocSampleM;
    }
    if (coverM < opts.minAssocOverlapM || diffs.length < 2) return null;
    return { sep: median(diffs), coverM };
  }

  function buildPhysicalLaneClusters(acceptedCurves, opts) {
    // Seed by the map's physical-boundary identity (chunkId:passId:groupTrackId),
    // which is stable across frames within a pass (constant laneIndex/side and a
    // distinct lateral band). Whole-curve geometric separation is NOT used as the
    // primary key because far-field modelV2 noise can shift two observations of
    // the same painted line by metres. Within each seed, curves are grouped into
    // contiguous along-track strands so spatial revisits under one key never
    // bridge disjoint sections. Never joins across chunkId/passId.
    const byKey = new Map();
    for (const curve of acceptedCurves) {
      const key = `${curve.chunkId}:${curve.passId}:${curve.groupTrackId ?? 'x'}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(curve);
    }
    const clusters = [];
    for (const [, group] of byKey) {
      const ordered = [...group].sort((a, b) => (a.minS ?? 0) - (b.minS ?? 0));
      const strands = [];
      for (const curve of ordered) {
        // Try to attach to an existing strand whose forward tip is reachable
        // (overlap or gap <= maxSupportedGapM) and whose heading is compatible.
        let bestStrand = null;
        for (const strand of strands) {
          if (curve.minS > strand.maxS + opts.maxSupportedGapM) continue;
          const hCurve = meanHeadingDeg(curve.pts);
          const hStrand = strand.headingDeg;
          if (hCurve != null && hStrand != null
            && absHeadingDiffDeg(hCurve, hStrand) > opts.clusterHeadingTolDeg) continue;
          bestStrand = strand;
          break;
        }
        if (bestStrand) {
          bestStrand.curves.push(curve);
          bestStrand.maxS = Math.max(bestStrand.maxS, curve.maxS);
          bestStrand.minS = Math.min(bestStrand.minS, curve.minS);
        } else {
          strands.push({
            chunkId: curve.chunkId,
            passId: curve.passId,
            groupTrackId: curve.groupTrackId,
            laneIndex: curve.laneIndex,
            side: curve.side,
            groupId: curve.groupId,
            curves: [curve],
            minS: curve.minS,
            maxS: curve.maxS,
            headingDeg: meanHeadingDeg(curve.pts),
          });
        }
      }
      for (const s of strands) {
        clusters.push(s);
      }
    }
    return clusters;
  }

  function fitClusterStations(cluster, opts, counters) {
    const spacing = opts.stationSpacingM;
    const start = Math.floor(cluster.minS / spacing) * spacing + spacing / 2;
    const stations = [];
    for (let s0 = start; s0 <= cluster.maxS + spacing / 2; s0 += spacing) {
      const samples = [];
      for (const curve of cluster.curves) {
        const v = interpCurvePointAtS(curve, s0);
        if (!v) continue;
        // Trusted near-field gate: modelV2 lane curves are reliable only within
        // a limited look-ahead from the ego. Far-field extrapolation diverges
        // and would pull the station median away from the physical painted line.
        if (opts.trustedModelXM > 0
          && Number.isFinite(v.modelX) && v.modelX > opts.trustedModelXM) continue;
        samples.push({ curve, v });
      }
      if (samples.length < opts.minSupportFramesPerBin) continue;
      // Bimodal-station guard (purity method only): when the supporting samples
      // at one station split into laterally separated modes, no median is placed
      // between the modes. The station is left unverified so the run either
      // bridges a tiny gap, splits, or ends — never averages across modes.
      if (opts.purityBimodalCheck) {
        const dVals = samples.map((s) => s.v.d).filter(Number.isFinite).sort((a, b) => a - b);
        if (dVals.length >= 2) {
          const spread = dVals[dVals.length - 1] - dVals[0];
          let maxGap = 0;
          for (let k = 1; k < dVals.length; k++) maxGap = Math.max(maxGap, dVals[k] - dVals[k - 1]);
          if (spread > (opts.purityBimodalSpreadM ?? 3.5)
            && maxGap > (opts.purityBimodalGapM ?? 2.0)) {
            if (counters) counters.bimodalStation = (counters.bimodalStation || 0) + 1;
            continue;
          }
        }
      }
      // Robust lateral estimate per station across supporting curves/frames.
      // Median is used directly over every supporting sample: with the repeated
      // per-frame coverage (~2-3 curves/station) a minority of far-field
      // outliers cannot pull the median. A MAD-filter keep-set would switch its
      // membership between adjacent stations and fragment the representative.
      const ds = samples.map((s) => s.v.d);
      const medianD = median(ds);
      const lateralMadM = ds.length >= 2 ? mad(ds, medianD) : 0;
      const frameSet = new Set();
      const curveSet = new Set();
      const frameIdSet = new Set();
      const keptE = [];
      const keptN = [];
      const keptMirrorE = [];
      const keptMirrorN = [];
      for (const s of samples) {
        const fid = s.curve.frameId != null ? s.curve.frameId : `fi:${s.curve.frameIndex ?? 'x'}`;
        frameSet.add(fid);
        frameIdSet.add(s.curve.frameId);
        curveSet.add(s.curve.groupId ?? `${s.curve.chunkId}:${s.curve.passId}:${s.curve.frameId}`);
        keptE.push(s.v.localEast);
        keptN.push(s.v.localNorth);
        if (Number.isFinite(s.v.mirroredLocalEast)) keptMirrorE.push(s.v.mirroredLocalEast);
        if (Number.isFinite(s.v.mirroredLocalNorth)) keptMirrorN.push(s.v.mirroredLocalNorth);
      }
      stations.push({
        s: s0,
        medianD,
        lateralMadM,
        distinctFrameCount: frameSet.size,
        distinctCurveCount: curveSet.size,
        frameIdSet,
        kept: samples,
        curveIds: [...curveSet],
        medianEast: median(keptE),
        medianNorth: median(keptN),
        medianMirrorEast: keptMirrorE.length ? median(keptMirrorE) : undefined,
        medianMirrorNorth: keptMirrorN.length ? median(keptMirrorN) : undefined,
      });
    }
    return stations;
  }

  function pickStationRepresentative(station, opts) {
    // Synthetic robust vertex: coordinate-wise median of the inlier supporting
    // samples at this station. This is not an arbitrary single-frame sample, so
    // far-field per-frame noise cannot pull the representative from its support.
    if (!station || !station.kept?.length) return null;
    if (!Number.isFinite(station.medianEast) || !Number.isFinite(station.medianNorth)) return null;
    const v = {
      localEast: station.medianEast,
      localNorth: station.medianNorth,
      s: station.s,
      d: station.medianD,
    };
    if (Number.isFinite(station.medianMirrorEast)) v.mirroredLocalEast = station.medianMirrorEast;
    if (Number.isFinite(station.medianMirrorNorth)) v.mirroredLocalNorth = station.medianMirrorNorth;
    v.binMeta = {
      binIndex: Math.round(station.s / opts.stationSpacingM),
      distinctFrameCount: station.distinctFrameCount,
      distinctCurveCount: station.distinctCurveCount,
      lateralMadM: station.lateralMadM,
      medianS: station.s,
      medianD: station.medianD,
      sourceCurveIds: station.curveIds || [],
      sourceFrameIds: station.frameIdSet ? [...station.frameIdSet] : [],
    };
    return v;
  }

  function smoothRepresentativePath(reps, opts) {
    // Light median smoothing along the fitted representative path. Operating in
    // (s,d) space keeps real road curvature while removing per-station noise.
    const radius = Math.max(0, Math.floor(opts.smoothRadiusStations || 0));
    if (radius <= 0 || reps.length < 2 * radius + 1) return reps;
    const ds = reps.map((r) => r.d);
    const smoothedD = ds.map((_, i) => {
      const lo = Math.max(0, i - radius);
      const hi = Math.min(ds.length - 1, i + radius);
      return median(ds.slice(lo, hi + 1));
    });
    return reps.map((r, i) => ({ ...r, d: smoothedD[i] }));
  }

  function assembleRepresentativePolylines(cluster, stations, opts, metaBase, splitCounts) {
    // Supported station mask (>= minSupportFramesPerBin frames).
    const supported = stations.map((st) => st.distinctFrameCount >= opts.minSupportFramesPerBin);

    // Build runs of supported stations, bridging only small unsupported gaps
    // (<= maxSupportedGapM) so genuine support loss splits the logical lane.
    const runs = [];
    let cur = [];
    for (let i = 0; i < stations.length; i++) {
      if (!supported[i]) continue;
      if (cur.length) {
        const gapM = stations[i].s - stations[cur[cur.length - 1]].s;
        if (gapM > opts.maxSupportedGapM) {
          if (splitCounts) splitCounts.alongTrackGap = (splitCounts.alongTrackGap || 0) + 1;
          runs.push(cur);
          cur = [];
        }
      }
      cur.push(i);
    }
    if (cur.length) runs.push(cur);

    const polylines = [];
    for (const run of runs) {
      const reps = run.map((idx) => pickStationRepresentative(stations[idx], opts)).filter(Boolean);
      if (reps.length < opts.minPolylinePoints) continue;
      const smoothed = smoothRepresentativePath(reps, opts);

      // Split the run on geometry incompatibility along the fitted path.
      const pieces = splitRepresentativeRun(smoothed, metaBase, opts, splitCounts);
      for (const piece of pieces) {
        if ((piece.points || []).length < opts.minPolylinePoints) continue;
        const supports = (piece.points || []).map((p) => p.binMeta?.distinctFrameCount ?? 0);
        const maxSupport = supports.length ? Math.max(...supports) : 0;
        if (maxSupport < opts.minPolylineSupportFrames) continue;
        const ss = (piece.points || []).map((p) => p.s).filter(Number.isFinite);
        const span = ss.length ? Math.max(...ss) - Math.min(...ss) : 0;
        if (span < opts.minPolylineCoverageM && (piece.points || []).length < 3) continue;
        polylines.push(piece);
      }
    }
    return polylines;
  }

  function splitRepresentativeRun(reps, metaBase, opts, splitCounts) {
    // Split the fitted path only on genuine discontinuities:
    //  - support disappeared (along-track gap > maxSupportedGapM)
    //  - an unreasonably large spatial step
    //  - a PERSISTENT lateral drift away from the run's established level
    //    (geometry/topology change) — never a single-station far-field spike
    //  - an incompatible heading change
    const polylines = [];
    if (!reps.length) return polylines;
    const spacing = Math.max(1e-3, opts.stationSpacingM || 1);
    const driftPersistStations = Math.max(4, Math.round((opts.driftPersistM ?? 15) / spacing));
    const lateralTol = Number.isFinite(opts.maxLateralStepM) ? opts.maxLateralStepM : 3.0;
    let run = [reps[0]];
    let prevHeading = null;
    const minHeadingStepM = Number.isFinite(opts.minHeadingStepM) ? opts.minHeadingStepM : 2.0;
    const bump = (key) => {
      if (splitCounts) splitCounts[key] = (splitCounts[key] || 0) + 1;
    };
    for (let i = 1; i < reps.length; i++) {
      const prev = run[run.length - 1];
      const next = reps[i];
      const ds = Math.abs((next.s ?? 0) - (prev.s ?? 0));
      const step = localStepM(prev, next);
      const stepHeading = alongTrackHeadingDeg(prev, next);
      const gapSplit = ds > opts.maxSupportedGapM;
      const stepSplit = step > opts.maxStepM;
      // Persistent drift: once the run has enough established length, compare the
      // current median-d level to the run's baseline level. Only split when the
      // deviation exceeds the lateral tolerance AND has persisted for several
      // stations, meaning the path has truly moved to another level (identity /
      // topology / lane change), not a momentary outlier.
      let driftSplit = false;
      if (run.length >= driftPersistStations && i + 1 < reps.length) {
        const baseline = median(run.slice(0, driftPersistStations).map((r) => r.d));
        const current = median(run.slice(-driftPersistStations).map((r) => r.d));
        const lookahead = median(reps.slice(i + 1, Math.min(reps.length, i + 1 + driftPersistStations)).map((r) => r.d));
        if (baseline != null && current != null && lookahead != null) {
          const movedToNewLevel = Math.abs(lookahead - current) <= lateralTol
            && Math.abs(current - baseline) > lateralTol;
          if (movedToNewLevel) driftSplit = true;
        }
      }
      const headingEligible = ds >= minHeadingStepM;
      const headingSplit = Number.isFinite(opts.maxHeadingDiffDeg)
        && headingEligible
        && prevHeading != null
        && absHeadingDiffDeg(stepHeading, prevHeading) > opts.maxHeadingDiffDeg;
      if (gapSplit || stepSplit || driftSplit || headingSplit) {
        if (gapSplit) bump('alongTrackGap');
        else if (stepSplit) bump('spatialStep');
        else if (driftSplit) bump('lateralStep');
        else bump('incompatibleHeading');
        if (run.length >= 2) polylines.push(makePolylineFromReps(run, metaBase));
        run = [next];
        prevHeading = null;
      } else {
        run.push(next);
        if (headingEligible) prevHeading = stepHeading;
      }
    }
    if (run.length >= 2) polylines.push(makePolylineFromReps(run, metaBase));
    else if (run.length === 1) polylines.push(makePolylineFromReps(run, metaBase));
    return polylines;
  }

  function makePolylineFromReps(reps, metaBase) {
    const points = reps.map((r) => r);
    const ss = points.map((p) => p.s).filter(Number.isFinite);
    const frameSet = new Set();
    const curveSet = new Set();
    const frameIdSet = new Set();
    const supports = [];
    const spreads = [];
    for (const p of points) {
      if (p.frameId != null) frameSet.add(p.frameId);
      if (p.sourceCurveGroupId != null) curveSet.add(p.sourceCurveGroupId);
      const bm = p.binMeta;
      if (bm) {
        if (Number.isFinite(bm.distinctFrameCount)) supports.push(bm.distinctFrameCount);
        if (Number.isFinite(bm.lateralMadM)) spreads.push(bm.lateralMadM);
        // Provenance survives resampling/fitting via binMeta: every station bin
        // retains its supporting source curve/frame ids (req: purity provenance).
        for (const cid of (bm.sourceCurveIds || [])) {
          if (cid != null) curveSet.add(cid);
        }
        for (const fid of (bm.sourceFrameIds || [])) {
          if (fid != null) {
            frameSet.add(fid);
            frameIdSet.add(fid);
          }
        }
      }
    }
    const first = points[0] || {};
    const pl = makePolyline(points, {
      ...metaBase,
      groupId: metaBase.groupId,
    });
    pl.frameId = first.frameId ?? null;
    pl.frameIndex = first.frameIndex ?? null;
    pl.logMonoTime = first.logMonoTime ?? null;
    pl.mode = 'representativeFromPerFrame';
    pl.sourceStage = 'perFrame→curveAssociation';
    pl.supportCount = supports.length ? Math.max(...supports) : 0;
    pl.meanSupport = supports.length
      ? supports.reduce((a, b) => a + b, 0) / supports.length
      : 0;
    pl.minSupport = supports.length ? Math.min(...supports) : 0;
    pl.lateralSpread = spreads.length ? Math.max(...spreads) : 0;
    pl.distinctFrameIds = [...frameSet];
    pl.distinctCurveIds = [...curveSet].sort();
    pl.distinctFrameIdList = [...frameIdSet].sort();
    pl.supportCurveCount = curveSet.size;
    pl.supportFrameCount = frameSet.size;
    pl.verificationState = pl.minSupport >= 2 ? 'verified' : 'unverified';
    pl.coverageM = ss.length ? Math.max(...ss) - Math.min(...ss) : 0;
    return pl;
  }

  /**
   * Representative lane lines from trusted All per-frame curves.
   *
   * Corrected method: associate COMPLETE per-frame curves into physical-lane
   * clusters (geometry-first; no colour identity, no unsafe transitive merge),
   * then resample supporting curves onto shared along-track stations and take a
   * robust lateral median per station. Source curves are never reduced to raw
   * native points before association, so repeated observations genuinely merge
   * into a few logical lanes instead of degrading to ~1 output per source curve.
   */
  function buildRepresentativeLaneLinesFromPerFrame(perFramePolylines, options = {}) {
    const opts = { ...DEFAULTS, ...CURVE_ASSOC_DEFAULTS, ...options };
    const source = Array.isArray(perFramePolylines) ? perFramePolylines : [];
    const rejected = [];
    const acceptedCurves = [];
    for (const pl of source) {
      const pts = pl?.points || [];
      if (pts.length < opts.minSourceCurvePoints) {
        rejected.push({ reason: 'tooFewPoints', curve: pl });
        continue;
      }
      let lengthM = 0;
      for (let i = 1; i < pts.length; i++) lengthM += localStepM(pts[i - 1], pts[i]);
      if (!(lengthM >= opts.minSourceCurveLengthM)) {
        rejected.push({ reason: 'tooShort', curve: pl });
        continue;
      }
      if (!Number.isFinite(pts[0]?.s) || !Number.isFinite(pts[0]?.d)) {
        rejected.push({ reason: 'noSd', curve: pl });
        continue;
      }
      const enriched = enrichCurveForAssociation(pl);
      if (!enriched) {
        rejected.push({ reason: 'notResamplable', curve: pl });
        continue;
      }
      acceptedCurves.push(enriched);
    }

    const sourceFrames = new Set(acceptedCurves.map((c) => c.frameId).filter((x) => x != null));
    const clusters = buildPhysicalLaneClusters(acceptedCurves, opts);

    const splitReasons = {
      alongTrackGap: 0,
      spatialStep: 0,
      lateralStep: 0,
      identity: 0,
      emptyBinInterval: 0,
      incompatibleHeading: 0,
    };
    const output = [];
    const logicalLanes = [];
    let weakRejected = 0;
    const allSupports = [];
    const allSpreads = [];

    for (const cluster of clusters) {
      const stations = fitClusterStations(cluster, opts);
      if (!stations.length) {
        weakRejected += 1;
        continue;
      }
      const laneId = `${cluster.chunkId}:${cluster.passId}:${cluster.groupTrackId ?? 'x'}`
        + `:${cluster.laneIndex ?? 'x'}:${cluster.side ?? 'x'}`;
      const metaBase = {
        groupId: laneId,
        chunkId: cluster.chunkId,
        passId: cluster.passId,
        groupTrackId: cluster.groupTrackId,
        laneIndex: cluster.laneIndex,
        side: cluster.side,
        logicalLaneId: laneId,
      };
      const polylines = assembleRepresentativePolylines(cluster, stations, opts, metaBase, splitReasons);
      const laneEntries = [];
      for (const pl of polylines) {
        pl.groupId = laneId;
        pl.logicalLaneId = laneId;
        if (Number.isFinite(pl.supportCount)) allSupports.push(pl.supportCount);
        if (Number.isFinite(pl.lateralSpread)) allSpreads.push(pl.lateralSpread);
        laneEntries.push({
          logicalLaneId: laneId,
          chunkId: cluster.chunkId,
          passId: cluster.passId,
          groupTrackId: cluster.groupTrackId,
          laneIndex: cluster.laneIndex,
          side: cluster.side,
          supportCount: pl.supportCount,
          coverageM: pl.coverageM,
          pointCount: (pl.points || []).length,
        });
        output.push(pl);
      }
      if (laneEntries.length) {
        logicalLanes.push({
          logicalLaneId: laneId,
          chunkId: cluster.chunkId,
          passId: cluster.passId,
          groupTrackId: cluster.groupTrackId,
          laneIndex: cluster.laneIndex,
          side: cluster.side,
          fragments: laneEntries.length,
          totalCoverageM: laneEntries.reduce((a, b) => a + (b.coverageM ?? 0), 0),
          maxSupport: Math.max(...laneEntries.map((e) => e.supportCount ?? 0)),
          sourceCurveCount: cluster.curves.length,
          supportedStationCount: stations.filter((s) => s.distinctFrameCount >= opts.minSupportFramesPerBin).length,
        });
      } else {
        weakRejected += 1;
      }
    }

    const rangeOf = (arr) => {
      if (!arr.length) return { min: null, max: null };
      return { min: Math.min(...arr), max: Math.max(...arr) };
    };
    const totalSupportedStations = output.reduce(
      (acc, pl) => acc + (pl.points || []).filter((p) => (p.binMeta?.distinctFrameCount ?? 0) >= opts.minSupportFramesPerBin).length,
      0,
    );
    const medianOf = (arr) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const allCoverage = output.map((p) => p.coverageM ?? 0);
    const supportedCoverageM = output.reduce((acc, pl) => {
      const pts = (pl.points || []).filter((p) => (p.binMeta?.distinctFrameCount ?? 0) >= opts.minSupportFramesPerBin);
      const ss = pts.map((p) => p.s).filter(Number.isFinite);
      return acc + (ss.length ? Math.max(...ss) - Math.min(...ss) : 0);
    }, 0);

    const stats = {
      mode: 'representativeFromPerFrame',
      candidateActive: true,
      method: 'curveAssociation',
      sourceCurveCount: source.length,
      acceptedSourceCurveCount: acceptedCurves.length,
      rejectedCurveCount: rejected.length + weakRejected,
      admissionRejectedCount: rejected.length,
      weakPolylineRejectedCount: weakRejected,
      sourceFrameCount: sourceFrames.size,
      representativeLineCount: output.length,
      physicalClusterCount: clusters.length,
      logicalLaneCount: logicalLanes.length,
      reductionRatio: output.length ? Number((source.length / output.length).toFixed(3)) : null,
      medianSupportFrames: medianOf(allSupports),
      totalSupportedCoverageM: Number(supportedCoverageM.toFixed(3)),
      coveragePerLane: logicalLanes.map((l) => ({
        logicalLaneId: l.logicalLaneId,
        fragments: l.fragments,
        coverageM: Number(l.totalCoverageM.toFixed(3)),
        sourceCurves: l.sourceCurveCount,
        supportFrames: l.maxSupport,
      })),
      splitReasonCounts: splitReasons,
      supportRange: rangeOf(allSupports),
      lateralSpreadRange: rangeOf(allSpreads),
      reusedStage: 'curveAssociationStationFit',
      maxHeadingDiffDeg: opts.maxHeadingDiffDeg,
      minHeadingStepM: opts.minHeadingStepM,
      stationSpacingM: opts.stationSpacingM,
      maxSupportedGapM: opts.maxSupportedGapM,
    };

    return { polylines: output, stats, logicalLanes };
  }

  const PURITY_ASSOC_DEFAULTS = {
    // Purity candidate: geometric subclustering inside one seed identity.
    // All thresholds are lateral/heading quantities in physical units, derived
    // from the Seg0/1/2/99 separation study (see purity report): repeated
    // observations of one painted line agree within ~1 m laterally near-field,
    // while incompatible physical corridors differ by 5 m or more.
    purityMinOverlapM: 3.0, // min shared s-interval for pairwise curve evidence
    purityAssocSampleM: 2.0, // sampling step for pairwise lateral comparison
    purityMedianLateralTolM: 2.0, // median |dA-dB| over trusted overlap
    purityP90LateralTolM: 3.0, // upper-percentile |dA-dB| over trusted overlap
    purityHeadingTolDeg: 45, // pairwise heading agreement over overlap
    purityGapBridgeM: 8, // max end-to-end s-gap for strand continuity
    purityTipTolM: 2.0, // endpoint lateral slack beyond the along-track gap
    purityBimodalCheck: true, // enable bimodal-station guard in fitting
    purityBimodalSpreadM: 8.0, // station lateral range treated as multi-mode
    purityBimodalGapM: 3.0, // largest internal sorted gap defining two modes
    purityBimodalPersistM: 30, // s-length a bimodal run must persist to split
    purityModeMadM: 2.5, // pooled per-mode MAD required of a true two-line run
    purityMaxFoldApex: 0, // allowed concentrated fold apexes per output line
    purityFoldTurnDeg: 150, // turn angle (0=straight,180=hairpin) of an apex
    purityFoldArmM: 2.0, // min incident arm length for an apex to count
    purityMaxCorridorM: 3.0, // max rep-point distance to trusted support
    purityOverlapDtolM: 3.0, // median-d incompatibility for shared-identity overlap
  };

  const PURITY_REVISIT_DEFAULTS = {
    // Revisit candidate (representativeMethod=purityRevisit): the purity method
    // plus a temporal-visit split and a combined self-fold/revisit gate.
    // Candidate thresholds from the Seg99 diagnosis: false fold turn 388 /
    // ratio 0.353; accepted Seg0/1/2 max turn <= 186 / ratio >= 0.801. A large
    // frame gap NEVER splits on its own — it must combine with fold evidence.
    purityRevisitWindowM: 25, // sliding path window for cumulative turn
    purityRevisitTurnDeg: 270, // cumulative absolute turn in a window to flag
    purityRevisitChordRatio: 0.6, // chord/path ratio below which a window is folded
    purityRevisitNearM: 3.0, // near-self-approach distance
    purityRevisitNearSepM: 5.0, // min s separation for a meaningful near-approach
    purityRevisitMinGap: 20, // min frame-index gap treated as a visit boundary
    purityRevisitGapFactor: 5, // visit boundary = factor x median frame spacing
    purityRevisitMinOverlapM: 10.0, // min s-overlap for pre-fit visit merge test
    purityRevisitMinKeepM: 50, // below this coverage a folded line is rejected
    purityRevisitPreSplit: false, // opt-in pre-fit visit split (unsafe default, see note)
  };

  function enrichedCurveTrustedPoints(curve, opts) {
    // Near-field portion of one association curve. modelX is look-ahead from
    // the ego at capture; far-field (> trustedModelXM) diverges and must not
    // decide physical-lane purity. Points without modelX stay trusted.
    const out = [];
    for (const p of curve.pts || []) {
      if (opts.trustedModelXM > 0
        && Number.isFinite(p.modelX) && p.modelX > opts.trustedModelXM) continue;
      if (!Number.isFinite(p.s) || !Number.isFinite(p.d)) continue;
      if (!Number.isFinite(p.localEast) || !Number.isFinite(p.localNorth)) continue;
      out.push(p);
    }
    return out;
  }

  function purityPairwiseEvidence(a, b, opts) {
    // Geometric compatibility evidence between two curves of one seed group.
    // Uses ONLY trusted near-field samples. Returns null when the curves share
    // no usable interval (no evidence -> never merge).
    const overlapMin = Math.max(a.minS, b.minS);
    const overlapMax = Math.min(a.maxS, b.maxS);
    const span = overlapMax - overlapMin;
    if (span >= (opts.purityMinOverlapM ?? 3.0)) {
      const step = Math.max(0.5, opts.purityAssocSampleM ?? 2.0);
      const diffs = [];
      let coverM = 0;
      for (let s0 = overlapMin + step / 2; s0 <= overlapMax; s0 += step) {
        const va = interpCurvePointAtS(a, s0);
        const vb = interpCurvePointAtS(b, s0);
        if (!va || !vb) continue;
        const trustedA = !(opts.trustedModelXM > 0
          && Number.isFinite(va.modelX) && va.modelX > opts.trustedModelXM);
        const trustedB = !(opts.trustedModelXM > 0
          && Number.isFinite(vb.modelX) && vb.modelX > opts.trustedModelXM);
        if (!trustedA || !trustedB) continue;
        if (!Number.isFinite(va.d) || !Number.isFinite(vb.d)) continue;
        diffs.push(Math.abs(va.d - vb.d));
        coverM += step;
      }
      if (coverM < (opts.purityMinOverlapM ?? 3.0) || diffs.length < 2) return null;
      const sorted = [...diffs].sort((x, y) => x - y);
      const med = median(sorted);
      const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
      const hA = meanHeadingDeg(a.pts);
      const hB = meanHeadingDeg(b.pts);
      const headDiff = (hA != null && hB != null) ? absHeadingDiffDeg(hA, hB) : 0;
      return { kind: 'overlap', medDiff: med, p90Diff: p90, coverM, headDiff };
    }
    // End-to-end strand continuity: small along-track gap, spatially continuous
    // tips, compatible heading. Equal/overlapping s is handled above; a large
    // s separation is a strand boundary (revisit) and never merges here.
    const gapAB = a.minS - b.maxS;
    const gapBA = b.minS - a.maxS;
    const gap = gapAB >= 0 ? gapAB : (gapBA >= 0 ? gapBA : -1);
    if (gap < 0 || gap > (opts.purityGapBridgeM ?? 8)) return null;
    const tipA = gapAB >= 0 ? a.pts[0] : a.pts[a.pts.length - 1];
    const tipB = gapAB >= 0 ? b.pts[b.pts.length - 1] : b.pts[0];
    if (!tipA || !tipB) return null;
    const tipDistM = localStepM(tipA, tipB);
    const hA = meanHeadingDeg(a.pts);
    const hB = meanHeadingDeg(b.pts);
    const headDiff = (hA != null && hB != null) ? absHeadingDiffDeg(hA, hB) : 0;
    return { kind: 'touch', gapM: gap, tipDistM, headDiff };
  }

  function purityCurvesCompatible(a, b, opts) {
    const ev = purityPairwiseEvidence(a, b, opts);
    if (!ev) return false;
    if (ev.headDiff > (opts.purityHeadingTolDeg ?? 45)) return false;
    if (ev.kind === 'overlap') {
      return ev.medDiff <= (opts.purityMedianLateralTolM ?? 2.0)
        && ev.p90Diff <= (opts.purityP90LateralTolM ?? 3.0);
    }
    return ev.tipDistM <= ev.gapM + (opts.purityTipTolM ?? 2.0);
  }

  function splitSeedIntoPureSubclusters(seedCurves, opts, counters) {
    // Strand formation is EXACTLY the corrected method's rule (along-track gap
    // + whole-curve heading), so pure seeds cluster bit-for-bit identically and
    // Seg0/Seg1 behaviour is preserved. Purity acts only as a splitter: a
    // strand is divided only on a PERSISTENT run of stations where trusted
    // samples form two laterally separated, internally tight modes
    // (corridor-scale evidence; lane-scale relabelling inside one seed is
    // reported as a limitation, not thresholded). No unsafe transitive merge:
    // a curve joins a mode only by direct compatibility with that mode level.
    // Deterministic: minS order, first-fit, sorted-gap mode threshold.
    const ordered = [...seedCurves].sort((a, b) => (a.minS ?? 0) - (b.minS ?? 0));
    const strands = [];
    for (const curve of ordered) {
      let bestStrand = null;
      for (const strand of strands) {
        if (curve.minS > strand.maxS + opts.maxSupportedGapM) continue;
        const hCurve = meanHeadingDeg(curve.pts);
        const hStrand = strand.headingDeg;
        if (hCurve != null && hStrand != null
          && absHeadingDiffDeg(hCurve, hStrand) > opts.clusterHeadingTolDeg) continue;
        bestStrand = strand;
        break;
      }
      if (bestStrand) {
        bestStrand.curves.push(curve);
        bestStrand.maxS = Math.max(bestStrand.maxS, curve.maxS);
        bestStrand.minS = Math.min(bestStrand.minS, curve.minS);
      } else {
        strands.push({
          chunkId: curve.chunkId,
          passId: curve.passId,
          groupTrackId: curve.groupTrackId,
          laneIndex: curve.laneIndex,
          side: curve.side,
          groupId: curve.groupId,
          curves: [curve],
          minS: curve.minS,
          maxS: curve.maxS,
          headingDeg: meanHeadingDeg(curve.pts),
        });
      }
    }
    const subs = [];
    for (const strand of strands) {
      // Pre-fit visit separation is available but OFF by default: focused
      // evidence shows raw/median union folding false-positives on Seg2's
      // genuine loop (union turn 1175-1212) more than on the Seg99 fold (699).
      // The safe discriminator is the fitted post-fit gate below.
      const revisitStrands = (opts.purityRevisit && opts.purityRevisitPreSplit)
        ? puritySplitStrandByVisitGroups(strand, opts, counters)
        : [strand];
      for (const rs of revisitStrands) {
        const split = puritySplitStrandByPersistentModes(rs, opts, counters);
        split.forEach((sub) => subs.push(sub));
      }
    }
    if (counters) counters.puritySubcluster = (counters.puritySubcluster || 0) + subs.length;
    return subs;
  }

  function purityStrandStationModes(strand, opts) {
    // Per-station trusted lateral samples with sorted-gap mode analysis.
    const step = Math.max(0.5, opts.purityAssocSampleM ?? 2.0);
    const stations = [];
    for (let s0 = strand.minS + step / 2; s0 <= strand.maxS; s0 += step) {
      const ds = [];
      const owners = [];
      for (const curve of strand.curves) {
        const v = interpCurvePointAtS(curve, s0);
        if (!v || !Number.isFinite(v.d)) continue;
        if (opts.trustedModelXM > 0
          && Number.isFinite(v.modelX) && v.modelX > opts.trustedModelXM) continue;
        ds.push({ d: v.d, curve });
        owners.push(curve);
      }
      if (ds.length < 2) continue;
      const sorted = ds.map((x) => x.d).sort((a, b) => a - b);
      const range = sorted[sorted.length - 1] - sorted[0];
      let maxGap = 0;
      let gapMid = null;
      for (let k = 1; k < sorted.length; k++) {
        const g = sorted[k] - sorted[k - 1];
        if (g > maxGap) {
          maxGap = g;
          gapMid = (sorted[k] + sorted[k - 1]) / 2;
        }
      }
      stations.push({
        s: s0,
        range,
        maxGap,
        gapMid,
        bimodal: range > (opts.purityBimodalSpreadM ?? 8.0)
          && maxGap > (opts.purityBimodalGapM ?? 3.0),
      });
    }
    return stations;
  }

  function puritySplitStrandByPersistentModes(strand, opts, counters) {
    const stations = purityStrandStationModes(strand, opts);
    // Runs of consecutive bimodal stations; a run qualifies only if it
    // persists over purityBimodalPersistM metres of s.
    const persist = Math.max(2, Math.round((opts.purityBimodalPersistM ?? 30)
      / Math.max(0.5, opts.purityAssocSampleM ?? 2.0)));
    let bestRun = null;
    let runStart = -1;
    for (let i = 0; i <= stations.length; i++) {
      const on = i < stations.length && stations[i].bimodal;
      if (on && runStart < 0) runStart = i;
      if (!on && runStart >= 0) {
        const len = i - runStart;
        if (!bestRun || len > bestRun.len) bestRun = { start: runStart, len };
        runStart = -1;
      }
    }
    const base = {
      chunkId: strand.chunkId,
      passId: strand.passId,
      groupTrackId: strand.groupTrackId,
      laneIndex: strand.laneIndex,
      side: strand.side,
      groupId: strand.groupId,
      minS: strand.minS,
      maxS: strand.maxS,
      headingDeg: strand.headingDeg,
    };
    if (!bestRun || bestRun.len < persist) return [{ ...base, curves: strand.curves }];
    // Mode threshold: median of the run's per-station gap midpoints.
    const mids = stations.slice(bestRun.start, bestRun.start + bestRun.len)
      .map((st) => st.gapMid).filter(Number.isFinite).sort((a, b) => a - b);
    if (!mids.length) return [{ ...base, curves: strand.curves }];
    const T = mids[Math.floor(mids.length / 2)];
    // Assign curves by their mean trusted offset over the run; verify both
    // modes are internally tight (pooled MAD) and multi-curve.
    const lo = [];
    const hi = [];
    const loSamples = [];
    const hiSamples = [];
    for (const curve of strand.curves) {
      const vals = [];
      for (let i = bestRun.start; i < bestRun.start + bestRun.len; i++) {
        const v = interpCurvePointAtS(curve, stations[i].s);
        if (!v || !Number.isFinite(v.d)) continue;
        if (opts.trustedModelXM > 0
          && Number.isFinite(v.modelX) && v.modelX > opts.trustedModelXM) continue;
        vals.push(v.d);
      }
      if (!vals.length) continue;
      const m = median(vals);
      if (m < T) {
        lo.push(curve);
        for (const x of vals) loSamples.push(x);
      } else {
        hi.push(curve);
        for (const x of vals) hiSamples.push(x);
      }
    }
    const madOf = (arr) => {
      if (arr.length < 2) return Infinity;
      const m = median([...arr].sort((a, b) => a - b));
      return mad(arr, m);
    };
    if (lo.length < 1 || hi.length < 1
      || madOf(loSamples) > (opts.purityModeMadM ?? 2.5)
      || madOf(hiSamples) > (opts.purityModeMadM ?? 2.5)) {
      return [{ ...base, curves: strand.curves }];
    }
    if (counters) counters.purityModeSplit = (counters.purityModeSplit || 0) + 1;
    const mk = (curves) => ({
      ...base,
      curves,
      minS: Math.min(...curves.map((c) => c.minS)),
      maxS: Math.max(...curves.map((c) => c.maxS)),
      headingDeg: meanHeadingDeg(curves[0].pts),
    });
    return [mk(lo), mk(hi)];
  }

  function purityVisitOrder(curve) {
    // Prefer the capture-time identity (frameId) over the dense array index so
    // a real revisit gap is not hidden by index compaction.
    if (Number.isFinite(curve.frameId)) return curve.frameId;
    if (Number.isFinite(curve.logMonoTime)) return Number(curve.logMonoTime);
    if (Number.isFinite(curve.frameIndex)) return curve.frameIndex;
    return null;
  }

  function purityVisitGapThreshold(times, opts) {
    // A frame gap is only a candidate visit boundary when it greatly exceeds
    // the strand's own typical frame spacing. Never a fixed absolute alone.
    // The typical spacing drops the single largest gap so a two-group line does
    // not use its own revisit gap as the baseline.
    const gaps = [];
    for (let i = 1; i < times.length; i++) {
      const g = times[i] - times[i - 1];
      if (g > 0) gaps.push(g);
    }
    gaps.sort((a, b) => a - b);
    let typical = 1;
    if (gaps.length >= 3) {
      const trimmed = gaps.slice(0, gaps.length - 1);
      typical = trimmed[Math.floor(trimmed.length / 2)];
    } else if (gaps.length >= 1) {
      typical = 1;
    }
    return Math.max(opts.purityRevisitMinGap ?? 20,
      (opts.purityRevisitGapFactor ?? 5) * Math.max(1, typical));
  }

  function purityHasTemporalRevisit(frameIds, opts) {
    const f = [...new Set((frameIds || []).filter(Number.isFinite))].sort((a, b) => a - b);
    if (f.length < 2) return false;
    return Math.max(...f.slice(1).map((v, i) => v - f[i])) > purityVisitGapThreshold(f, opts);
  }

  function puritySelfFoldMetrics(points, opts) {
    // Combined self-fold metrics on a placed-coordinate sequence:
    //  - max cumulative absolute turn inside a sliding path window
    //  - chord/path ratio of the whole sequence
    //  - non-adjacent near-self-approaches with an s-separation
    const pts = (points || []).filter((p) => Number.isFinite(p.localEast)
      && Number.isFinite(p.localNorth));
    if (pts.length < 3) return { maxTurnWindowDeg: 0, chordPathRatio: 1, nearApproach: 0, nearSep: [] };
    const dist = [0];
    for (let i = 1; i < pts.length; i++) {
      dist.push(dist[i - 1] + Math.hypot(pts[i].localEast - pts[i - 1].localEast,
        pts[i].localNorth - pts[i - 1].localNorth));
    }
    const turn = [];
    for (let i = 1; i + 1 < pts.length; i++) {
      turn.push(purityTurnDeg(pts[i - 1], pts[i], pts[i + 1]));
    }
    const windowM = opts.purityRevisitWindowM ?? 25;
    let maxTurnWindow = 0;
    for (let i = 0; i < pts.length; i++) {
      let sum = 0;
      for (let k = i + 1; k < pts.length && dist[k] - dist[i] <= windowM; k++) {
        sum += turn[k - 1] || 0;
        if (sum > maxTurnWindow) maxTurnWindow = sum;
      }
    }
    const pathLen = dist[dist.length - 1];
    const chord = Math.hypot(pts[pts.length - 1].localEast - pts[0].localEast,
      pts[pts.length - 1].localNorth - pts[0].localNorth);
    const ratio = pathLen > 1e-9 ? chord / pathLen : 1;
    let nearApproach = 0;
    const nearSep = [];
    for (let i = 0; i < pts.length; i++) {
      for (let j = 0; j < pts.length - 1; j++) {
        if (Math.abs(j - i) <= 8 || Math.abs(j + 1 - i) <= 8) continue;
        const dx = pts[j + 1].localEast - pts[j].localEast;
        const dy = pts[j + 1].localNorth - pts[j].localNorth;
        const L2 = dx * dx + dy * dy || 1e-12;
        const t = Math.max(0, Math.min(1, ((pts[i].localEast - pts[j].localEast) * dx
          + (pts[i].localNorth - pts[j].localNorth) * dy) / L2));
        const dd = Math.hypot(pts[i].localEast - (pts[j].localEast + t * dx),
          pts[i].localNorth - (pts[j].localNorth + t * dy));
        if (dd < (opts.purityRevisitNearM ?? 3.0)) {
          const ds = Math.abs((pts[j].s ?? 0) - (pts[i].s ?? 0));
          if (ds > (opts.purityRevisitNearSepM ?? 5.0)) {
            nearApproach += 1;
            if (nearSep.length < 8) nearSep.push(Number(ds.toFixed(1)));
          }
        }
      }
    }
    return { maxTurnWindowDeg: maxTurnWindow, chordPathRatio: ratio, nearApproach, nearSep };
  }

  function purityFoldTrigger(m, opts, temporalRevisit) {
    // Combined trigger only: never a single threshold. Requires strong
    // cumulative folding AND a low chord/path ratio, plus corroboration from a
    // non-adjacent near-self-approach or an incompatible temporal revisit.
    return m.maxTurnWindowDeg > (opts.purityRevisitTurnDeg ?? 270)
      && m.chordPathRatio < (opts.purityRevisitChordRatio ?? 0.6)
      && (m.nearApproach > 0 || temporalRevisit === true);
  }

  function puritySplitStrandByVisitGroups(strand, opts, counters) {
    // Pre-fit association correction: separate temporally distinct revisit
    // groups before station resampling, but ONLY when the union shows fold
    // evidence. A large frame gap alone never splits compatible repeats.
    const withTime = strand.curves
      .map((c) => ({ c, t: purityVisitOrder(c) }))
      .filter((x) => x.t != null);
    if (withTime.length < 2) return [strand];
    withTime.sort((a, b) => a.t - b.t);
    const times = withTime.map((x) => x.t);
    const thr = purityVisitGapThreshold(times, opts);
    const groups = [];
    let cur = [withTime[0].c];
    for (let i = 1; i < withTime.length; i++) {
      if (times[i] - times[i - 1] > thr) {
        groups.push(cur);
        cur = [];
      }
      cur.push(withTime[i].c);
    }
    groups.push(cur);
    if (groups.length < 2) return [strand];
    // Fold evidence on the union of trusted samples ordered by station.
    const combined = [];
    for (const c of strand.curves) {
      for (const p of enrichedCurveTrustedPoints(c, opts)) {
        if (Number.isFinite(p.s)) combined.push(p);
      }
    }
    combined.sort((a, b) => a.s - b.s);
    const m = puritySelfFoldMetrics(combined, opts);
    if (!purityFoldTrigger(m, opts, true)) return [strand];
    if (counters) counters.purityRevisitSplit = (counters.purityRevisitSplit || 0) + 1;
    return groups.map((g) => ({
      chunkId: strand.chunkId,
      passId: strand.passId,
      groupTrackId: strand.groupTrackId,
      laneIndex: strand.laneIndex,
      side: strand.side,
      groupId: strand.groupId,
      curves: g,
      minS: Math.min(...g.map((c) => c.minS)),
      maxS: Math.max(...g.map((c) => c.maxS)),
      headingDeg: meanHeadingDeg(g[0].pts),
    }));
  }

  function purityLineFrameOrder(p) {
    const fids = (p.binMeta?.sourceFrameIds || []).filter(Number.isFinite);
    if (fids.length) return Math.min(...fids);
    if (Number.isFinite(p.frameIndex)) return p.frameIndex;
    if (Number.isFinite(p.frameId)) return p.frameId;
    return null;
  }

  function puritySplitLineAtVisitBoundary(pl, opts) {
    // Post-fit split at a proven temporal visit boundary. The boundary is
    // decided from the line's frame-level provenance (one entry per capture,
    // where the revisit gap is visible), then the point sequence is cut where
    // its per-point frame order crosses that boundary. Returns [pl] unchanged
    // when no safe split exists.
    const pts = pl.points || [];
    if (pts.length < 2 * opts.minPolylinePoints) return [pl];
    const times = pts.map(purityLineFrameOrder);
    if (times.some((t) => t == null)) return [pl];
    const frameIds = [...new Set((pl.distinctFrameIds || []).filter(Number.isFinite))]
      .sort((a, b) => a - b);
    const src = frameIds.length >= 2 ? frameIds
      : [...new Set(times)].sort((a, b) => a - b);
    if (src.length < 2) return [pl];
    const thr = purityVisitGapThreshold(src, opts);
    let best = -1;
    let bi = -1;
    for (let i = 1; i < src.length; i++) {
      const g = src[i] - src[i - 1];
      if (g > best) { best = g; bi = i; }
    }
    if (best <= thr) return [pl];
    const boundary = (src[bi - 1] + src[bi]) / 2;
    let splitAt = -1;
    for (let i = 1; i < times.length; i++) {
      if (times[i - 1] < boundary && times[i] >= boundary) { splitAt = i; break; }
    }
    if (splitAt < 0) {
      let bj = -1;
      let bg = -1;
      for (let i = 1; i < times.length; i++) {
        const g = Math.abs(times[i] - times[i - 1]);
        if (g > bg) { bg = g; bj = i; }
      }
      if (bj >= 0 && bg > thr) splitAt = bj;
    }
    if (splitAt < 0) return [pl];
    const a = pts.slice(0, splitAt);
    const b = pts.slice(splitAt);
    if (a.length < opts.minPolylinePoints || b.length < opts.minPolylinePoints) return [pl];
    const metaBase = {
      groupId: pl.groupId,
      chunkId: pl.chunkId,
      passId: pl.passId,
      groupTrackId: pl.groupTrackId,
      laneIndex: pl.laneIndex,
      side: pl.side,
      logicalLaneId: pl.logicalLaneId,
    };
    return [makePolylineFromReps(a, metaBase), makePolylineFromReps(b, metaBase)];
  }

  function purityTurnDeg(a, b, c) {
    // 0 = straight, 180 = hairpin reversal.
    const v1x = (a.localEast ?? 0) - (b.localEast ?? 0);
    const v1y = (a.localNorth ?? 0) - (b.localNorth ?? 0);
    const v2x = (c.localEast ?? 0) - (b.localEast ?? 0);
    const v2y = (c.localNorth ?? 0) - (b.localNorth ?? 0);
    const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (!(m > 1e-9)) return 0;
    const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / m));
    return 180 - Math.acos(cos) * (180 / Math.PI);
  }

  function purityLineDiagnostics(pl, cluster, opts, allCurves) {
    // Cumulative geometry diagnostics for one fitted representative line.
    const pts = pl.points || [];
    let foldApex = 0;
    let cumTurn = 0;
    let worstTurn = 0;
    for (let k = 1; k + 1 < pts.length; k++) {
      const armL = localStepM(pts[k - 1], pts[k]);
      const armR = localStepM(pts[k], pts[k + 1]);
      const t = purityTurnDeg(pts[k - 1], pts[k], pts[k + 1]);
      cumTurn += t;
      if (t > worstTurn) worstTurn = t;
      if (t > (opts.purityFoldTurnDeg ?? 150)
        && armL >= (opts.purityFoldArmM ?? 2.0)
        && armR >= (opts.purityFoldArmM ?? 2.0)) foldApex += 1;
    }
    // Chord deviation: max distance of vertices from the endpoint chord.
    let chordDev = 0;
    if (pts.length >= 3) {
      const A = pts[0];
      const B = pts[pts.length - 1];
      const dx = (B.localEast ?? 0) - (A.localEast ?? 0);
      const dy = (B.localNorth ?? 0) - (A.localNorth ?? 0);
      const len = Math.hypot(dx, dy) || 1e-9;
      for (const p of pts) {
        const dev = Math.abs(dy * ((p.localEast ?? 0) - (A.localEast ?? 0))
          - dx * ((p.localNorth ?? 0) - (A.localNorth ?? 0))) / len;
        if (dev > chordDev) chordDev = dev;
      }
    }
    // Corridor distance: max rep-point distance to trusted supporting
    // samples. Measured against ALL accepted curves (not just the line's own
    // cluster) so a self-consistent but off-corridor median cannot hide.
    // Point-to-sample distance (conservative on loops: on a self-adjacent
    // road the nearest sample may sit on a neighbouring arm; a same-station
    // interpolated variant is stricter but rejects supported loop-following
    // tracks across bridged s-gaps — recorded as future work).
    let corridorMax = 0;
    const support = [];
    for (const curve of (allCurves || cluster.curves || [])) {
      for (const p of enrichedCurveTrustedPoints(curve, opts)) support.push(p);
    }
    if (support.length) {
      for (const p of pts) {
        let best = Infinity;
        for (const q of support) {
          const dd = Math.hypot((q.localEast ?? 0) - (p.localEast ?? 0),
            (q.localNorth ?? 0) - (p.localNorth ?? 0));
          if (dd < best) best = dd;
        }
        if (best > corridorMax) corridorMax = best;
      }
    }
    const ds = pts.map((p) => p.d).filter(Number.isFinite);
    return {
      foldApex,
      cumTurnDeg: cumTurn,
      worstTurnDeg: worstTurn,
      chordDevM: chordDev,
      corridorMaxM: support.length ? corridorMax : null,
      medianD: ds.length ? median(ds) : null,
      minS: pts.length ? Math.min(...pts.map((p) => p.s).filter(Number.isFinite)) : null,
      maxS: pts.length ? Math.max(...pts.map((p) => p.s).filter(Number.isFinite)) : null,
    };
  }

  function puritySweepSharedIdentity(output, opts, counters) {
    // Same-identity overlap gate: two outputs sharing chunk:pass:groupTrackId
    // with overlapping s but incompatible median d cannot both be verified.
    // Rejects the weaker (support, then coverage, then point count), iterates
    // to a fixed point. Returns the surviving lines.
    let lines = [...output];
    for (;;) {
      let removed = null;
      for (let i = 0; i < lines.length && !removed; i++) {
        for (let j = i + 1; j < lines.length && !removed; j++) {
          const A = lines[i];
          const B = lines[j];
          if (A.chunkId !== B.chunkId || A.passId !== B.passId) continue;
          if ((A.groupTrackId ?? 'x') !== (B.groupTrackId ?? 'x')) continue;
          const dA = A.purityFlags;
          const dB = B.purityFlags;
          if (!dA || !dB || dA.minS == null || dB.minS == null) continue;
          const overlap = Math.min(dA.maxS, dB.maxS) - Math.max(dA.minS, dB.minS);
          if (!(overlap > 0)) continue;
          if (dA.medianD == null || dB.medianD == null) continue;
          if (Math.abs(dA.medianD - dB.medianD) <= (opts.purityOverlapDtolM ?? 3.0)) continue;
          const score = (pl) => [
            pl.supportFrameCount ?? pl.supportCount ?? 0,
            pl.coverageM ?? 0,
            (pl.points || []).length,
          ];
          const sa = score(A);
          const sb = score(B);
          let weaker = null;
          for (let k = 0; k < 3; k++) {
            if (sb[k] !== sa[k]) {
              weaker = sb[k] < sa[k] ? B : A;
              break;
            }
          }
          // Full tie: both corridors are equally evidenced — keep both and
          // let the visual review decide; never arbitrarily delete one.
          if (!weaker) continue;
          removed = weaker;
        }
      }
      if (!removed) break;
      removed.purityRejected = 'sharedIdentityOverlap';
      if (counters) counters.purityRejectedOverlap = (counters.purityRejectedOverlap || 0) + 1;
      lines = lines.filter((pl) => pl !== removed);
    }
    return lines;
  }

  /**
   * Purity-candidate representative lane lines (representativeMethod=purity).
   *
   * Same admission and station fitting as the corrected curve-association
   * method, plus, per seed identity (chunk:pass:groupTrackId):
   *  1. complete-link geometric subclustering on trusted near-field samples
   *     (groupTrackId/laneIndex/side/colour are evidence only, never identity);
   *  2. bimodal-station guard: no median is placed between separated modes;
   *  3. cumulative output gates (fold apexes, support-corridor distance,
   *     same-identity overlap sweep).
   * Hard boundaries (chunk, pass, direction via heading, revisit strands) are
   * never crossed: pairs without a usable shared interval never merge.
   */
  function buildRepresentativeLaneLinesPurityInternal(perFramePolylines, options, revisitMode) {
    const opts = { ...DEFAULTS, ...CURVE_ASSOC_DEFAULTS, ...PURITY_ASSOC_DEFAULTS,
      ...(revisitMode ? PURITY_REVISIT_DEFAULTS : {}), ...options, purityRevisit: !!revisitMode };
    const source = Array.isArray(perFramePolylines) ? perFramePolylines : [];
    const rejected = [];
    const acceptedCurves = [];
    for (const pl of source) {
      const pts = pl?.points || [];
      if (pts.length < opts.minSourceCurvePoints) {
        rejected.push({ reason: 'tooFewPoints', curve: pl });
        continue;
      }
      let lengthM = 0;
      for (let i = 1; i < pts.length; i++) lengthM += localStepM(pts[i - 1], pts[i]);
      if (!(lengthM >= opts.minSourceCurveLengthM)) {
        rejected.push({ reason: 'tooShort', curve: pl });
        continue;
      }
      if (!Number.isFinite(pts[0]?.s) || !Number.isFinite(pts[0]?.d)) {
        rejected.push({ reason: 'noSd', curve: pl });
        continue;
      }
      const enriched = enrichCurveForAssociation(pl);
      if (!enriched) {
        rejected.push({ reason: 'notResamplable', curve: pl });
        continue;
      }
      acceptedCurves.push(enriched);
    }

    const sourceFrames = new Set(acceptedCurves.map((c) => c.frameId).filter((x) => x != null));
    const counters = {};
    // Seed exactly as the corrected method, then purity-split each seed.
    const byKey = new Map();
    for (const curve of acceptedCurves) {
      const key = `${curve.chunkId}:${curve.passId}:${curve.groupTrackId ?? 'x'}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(curve);
    }
    const clusters = [];
    let seedCount = 0;
    for (const [, seedCurves] of byKey) {
      seedCount += 1;
      const subs = splitSeedIntoPureSubclusters(seedCurves, opts, counters);
      subs.forEach((sub, subIndex) => {
        sub.puritySubIndex = subIndex;
        sub.seedSize = seedCurves.length;
        sub.seedSplit = subs.length > 1;
        clusters.push(sub);
      });
    }

    const splitReasons = {
      alongTrackGap: 0,
      spatialStep: 0,
      lateralStep: 0,
      identity: 0,
      emptyBinInterval: 0,
      incompatibleHeading: 0,
      bimodalStation: 0,
    };
    const output = [];
    const purityRejected = [];
    const logicalLanes = [];
    let weakRejected = 0;
    const allSupports = [];
    const allSpreads = [];

    for (const cluster of clusters) {
      const stations = fitClusterStations(cluster, opts, splitReasons);
      if (!stations.length) {
        weakRejected += 1;
        continue;
      }
      const laneBase = `${cluster.chunkId}:${cluster.passId}:${cluster.groupTrackId ?? 'x'}`
        + `:${cluster.laneIndex ?? 'x'}:${cluster.side ?? 'x'}`;
      // Stable lane id: base identity is preserved when the seed stays pure;
      // split seeds get a deterministic subcluster suffix (never colour-based).
      const laneId = cluster.seedSplit ? `${laneBase}:u${cluster.puritySubIndex}` : laneBase;
      const metaBase = {
        groupId: laneId,
        chunkId: cluster.chunkId,
        passId: cluster.passId,
        groupTrackId: cluster.groupTrackId,
        laneIndex: cluster.laneIndex,
        side: cluster.side,
        logicalLaneId: laneId,
      };
      const polylines = assembleRepresentativePolylines(cluster, stations, opts, metaBase, splitReasons);
      const laneEntries = [];
      for (const pl of polylines) {
        pl.groupId = laneId;
        pl.logicalLaneId = laneId;
        pl.puritySubIndex = cluster.puritySubIndex;
        pl.purityFlags = purityLineDiagnostics(pl, cluster, opts, acceptedCurves);
        if (opts.purityRevisit) {
          const fold = puritySelfFoldMetrics(pl.points, opts);
          const temporal = purityHasTemporalRevisit(pl.distinctFrameIds || [], opts);
          pl.purityFlags.maxTurnWindowDeg = fold.maxTurnWindowDeg;
          pl.purityFlags.chordPathRatio = fold.chordPathRatio;
          pl.purityFlags.nearApproach = fold.nearApproach;
          pl.purityFlags.temporalRevisit = temporal;
          if (purityFoldTrigger(fold, opts, temporal)) {
            const pieces = puritySplitLineAtVisitBoundary(pl, opts);
            if (pieces.length > 1) {
              counters.purityRevisitPostSplit = (counters.purityRevisitPostSplit || 0) + 1;
              for (const piece of pieces) {
                piece.groupId = laneId;
                piece.logicalLaneId = laneId;
                piece.puritySubIndex = cluster.puritySubIndex;
                piece.puritySplitFrom = 'selfFold';
                piece.purityFlags = purityLineDiagnostics(piece, cluster, opts, acceptedCurves);
                if (Number.isFinite(piece.supportCount)) allSupports.push(piece.supportCount);
                if (Number.isFinite(piece.lateralSpread)) allSpreads.push(piece.lateralSpread);
                laneEntries.push({
                  logicalLaneId: laneId,
                  chunkId: cluster.chunkId,
                  passId: cluster.passId,
                  groupTrackId: cluster.groupTrackId,
                  laneIndex: cluster.laneIndex,
                  side: cluster.side,
                  supportCount: piece.supportCount,
                  coverageM: piece.coverageM,
                  pointCount: (piece.points || []).length,
                });
                output.push(piece);
              }
              continue;
            }
            if ((pl.coverageM ?? 0) < (opts.purityRevisitMinKeepM ?? 50)) {
              pl.purityRejected = 'selfFold';
              purityRejected.push(pl);
              counters.purityRejectedSelfFold = (counters.purityRejectedSelfFold || 0) + 1;
              continue;
            }
            // Long supported lane: never delete it for one local window.
            pl.purityFlagged = 'selfFold';
          }
        }
        // Cumulative gates: folded-back medians and off-corridor medians are
        // rejected with reasons, never silently kept.
        if (pl.purityFlags.foldApex > (opts.purityMaxFoldApex ?? 0)) {
          pl.purityRejected = 'foldApex';
          purityRejected.push(pl);
          counters.purityRejectedFold = (counters.purityRejectedFold || 0) + 1;
          continue;
        }
        if (pl.purityFlags.corridorMaxM != null
          && pl.purityFlags.corridorMaxM > (opts.purityMaxCorridorM ?? 3.0)) {
          pl.purityRejected = 'offCorridor';
          purityRejected.push(pl);
          counters.purityRejectedCorridor = (counters.purityRejectedCorridor || 0) + 1;
          continue;
        }
        if (Number.isFinite(pl.supportCount)) allSupports.push(pl.supportCount);
        if (Number.isFinite(pl.lateralSpread)) allSpreads.push(pl.lateralSpread);
        laneEntries.push({
          logicalLaneId: laneId,
          chunkId: cluster.chunkId,
          passId: cluster.passId,
          groupTrackId: cluster.groupTrackId,
          laneIndex: cluster.laneIndex,
          side: cluster.side,
          supportCount: pl.supportCount,
          coverageM: pl.coverageM,
          pointCount: (pl.points || []).length,
        });
        output.push(pl);
      }
      if (laneEntries.length) {
        logicalLanes.push({
          logicalLaneId: laneId,
          chunkId: cluster.chunkId,
          passId: cluster.passId,
          groupTrackId: cluster.groupTrackId,
          laneIndex: cluster.laneIndex,
          side: cluster.side,
          fragments: laneEntries.length,
          totalCoverageM: laneEntries.reduce((a, b) => a + (b.coverageM ?? 0), 0),
          maxSupport: Math.max(...laneEntries.map((e) => e.supportCount ?? 0)),
          sourceCurveCount: cluster.curves.length,
          supportedStationCount: stations.filter((s) => s.distinctFrameCount >= opts.minSupportFramesPerBin).length,
        });
      } else {
        weakRejected += 1;
      }
    }

    const survivors = puritySweepSharedIdentity(output, opts, counters);
    const sweepRejected = output.filter((pl) => pl.purityRejected === 'sharedIdentityOverlap');

    const rangeOf = (arr) => {
      if (!arr.length) return { min: null, max: null };
      return { min: Math.min(...arr), max: Math.max(...arr) };
    };
    const medianOf = (arr) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const supportedCoverageM = survivors.reduce((acc, pl) => {
      const pts = (pl.points || []).filter((p) => (p.binMeta?.distinctFrameCount ?? 0) >= opts.minSupportFramesPerBin);
      const ss = pts.map((p) => p.s).filter(Number.isFinite);
      return acc + (ss.length ? Math.max(...ss) - Math.min(...ss) : 0);
    }, 0);

    const stats = {
      mode: 'representativeFromPerFrame',
      candidateActive: true,
      method: revisitMode ? 'purityRevisit' : 'purity',
      sourceCurveCount: source.length,
      acceptedSourceCurveCount: acceptedCurves.length,
      rejectedCurveCount: rejected.length + weakRejected
        + (counters.purityRejectedFold || 0)
        + (counters.purityRejectedCorridor || 0)
        + (counters.purityRejectedOverlap || 0),
      admissionRejectedCount: rejected.length,
      weakPolylineRejectedCount: weakRejected,
      sourceFrameCount: sourceFrames.size,
      representativeLineCount: survivors.length,
      physicalClusterCount: clusters.length,
      puritySeedCount: seedCount,
      logicalLaneCount: logicalLanes.length,
      reductionRatio: survivors.length ? Number((source.length / survivors.length).toFixed(3)) : null,
      medianSupportFrames: medianOf(allSupports),
      totalSupportedCoverageM: Number(supportedCoverageM.toFixed(3)),
      coveragePerLane: logicalLanes.map((l) => ({
        logicalLaneId: l.logicalLaneId,
        fragments: l.fragments,
        coverageM: Number(l.totalCoverageM.toFixed(3)),
        sourceCurves: l.sourceCurveCount,
        supportFrames: l.maxSupport,
      })),
      splitReasonCounts: splitReasons,
      purityPairRejectCount: counters.purityPairReject || 0,
      puritySubclusterCount: counters.puritySubcluster || 0,
      purityBimodalSkipped: splitReasons.bimodalStation || 0,
      purityRejectedFold: counters.purityRejectedFold || 0,
      purityRejectedCorridor: counters.purityRejectedCorridor || 0,
      purityRejectedOverlap: counters.purityRejectedOverlap || 0,
      purityRevisitSplit: counters.purityRevisitSplit || 0,
      purityRevisitPostSplit: counters.purityRevisitPostSplit || 0,
      purityRejectedSelfFold: counters.purityRejectedSelfFold || 0,
      purityRejectedLines: [...purityRejected, ...sweepRejected].map((pl) => ({
        logicalLaneId: pl.logicalLaneId,
        reason: pl.purityRejected,
        foldApex: pl.purityFlags?.foldApex ?? null,
        corridorMaxM: pl.purityFlags?.corridorMaxM ?? null,
        maxTurnWindowDeg: pl.purityFlags?.maxTurnWindowDeg ?? null,
        chordPathRatio: pl.purityFlags?.chordPathRatio ?? null,
        nearApproach: pl.purityFlags?.nearApproach ?? null,
        temporalRevisit: pl.purityFlags?.temporalRevisit ?? null,
        coverageM: pl.coverageM ?? null,
      })),
      purityMaxTurnWindowDeg: survivors.length
        ? Number(Math.max(...survivors.map((p) => p.purityFlags?.maxTurnWindowDeg ?? 0)).toFixed(1)) : 0,
      purityMinChordPathRatio: survivors.length
        ? Number(Math.min(...survivors.map((p) => p.purityFlags?.chordPathRatio ?? 1)).toFixed(3)) : 1,
      supportRange: rangeOf(allSupports),
      lateralSpreadRange: rangeOf(allSpreads),
      reusedStage: 'puritySubclusterStationFit',
      maxHeadingDiffDeg: opts.maxHeadingDiffDeg,
      minHeadingStepM: opts.minHeadingStepM,
      stationSpacingM: opts.stationSpacingM,
      maxSupportedGapM: opts.maxSupportedGapM,
    };

    return { polylines: survivors, stats, logicalLanes };
  }

  function buildRepresentativeLaneLinesPurityFromPerFrame(perFramePolylines, options = {}) {
    return buildRepresentativeLaneLinesPurityInternal(perFramePolylines, options, false);
  }

  function buildRepresentativeLaneLinesPurityRevisitFromPerFrame(perFramePolylines, options = {}) {
    return buildRepresentativeLaneLinesPurityInternal(perFramePolylines, options, true);
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
    buildRepresentativeLaneLinesLegacyFromPerFrame,
    buildRepresentativeLaneLinesFromPerFrame,
    buildRepresentativeLaneLinesPurityFromPerFrame,
    buildRepresentativeLaneLinesPurityRevisitFromPerFrame,
    analyzeRepresentativeSelfFold: (points, options = {}) => {
      const opts = { ...DEFAULTS, ...CURVE_ASSOC_DEFAULTS, ...PURITY_ASSOC_DEFAULTS,
        ...PURITY_REVISIT_DEFAULTS, ...options };
      const m = puritySelfFoldMetrics(points, opts);
      const frameIds = options.frameIds
        || (points || []).map((p) => p.frameId).filter(Number.isFinite);
      const temporal = purityHasTemporalRevisit(frameIds, opts);
      return { ...m, temporalRevisit: temporal, trigger: purityFoldTrigger(m, opts, temporal) };
    },
    splitRepresentativeAtVisitBoundary: (polyline, options = {}) => {
      const opts = { ...DEFAULTS, ...CURVE_ASSOC_DEFAULTS, ...PURITY_ASSOC_DEFAULTS,
        ...PURITY_REVISIT_DEFAULTS, ...options };
      return puritySplitLineAtVisitBoundary(polyline, opts);
    },
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
