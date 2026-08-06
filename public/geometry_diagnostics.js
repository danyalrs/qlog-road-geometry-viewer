/** Browser geometry diagnostics — mirrors lib/geometry_diagnostics.js */
(function (root) {
  const STAGE7_REPAIR_TARGETS = [
    { id: 'DC-009', physicalBoundaryId: 'PB1', routeS0: 554.04, routeS1: 567.35 },
    { id: 'DC-010', physicalBoundaryId: 'PB1', routeS0: 572.04, routeS1: 590.04 },
    { id: 'DC-011', physicalBoundaryId: 'PB1', routeS0: 609.53, routeS1: 621.53 },
    { id: 'DC-012', physicalBoundaryId: 'PB1', routeS0: 630.57, routeS1: 646.89 },
  ];
  const RENDERER_MAX_INTRA_GAP_M = 15;

  function dist2d(a, b) {
    return Math.hypot((a.east ?? 0) - (b.east ?? 0), (a.north ?? 0) - (b.north ?? 0));
  }

  function enumeratePhysicalGaps(cleanedRuns) {
    const byPb = new Map();
    for (const run of cleanedRuns || []) {
      if (!byPb.has(run.physicalBoundaryId)) byPb.set(run.physicalBoundaryId, []);
      byPb.get(run.physicalBoundaryId).push(run);
    }
    const gaps = [];
    for (const [pb, runs] of byPb.entries()) {
      runs.sort((a, b) => a.sMin - b.sMin);
      for (let i = 0; i < runs.length - 1; i++) {
        const startS = runs[i].sMax;
        const endS = runs[i + 1].sMin;
        const along = endS - startS;
        if (along <= 0.05) continue;
        gaps.push({
          physicalBoundaryId: pb,
          routeS0: startS,
          routeS1: endS,
          alongTrackGapM: along,
          physicalGapKey: `${pb}|${startS.toFixed(2)}|${endS.toFixed(2)}`,
        });
      }
    }
    return gaps;
  }

  function gapOpenAtInterval(runs, startS, endS, tol = 1.0) {
    let s = startS;
    while (s < endS - tol) {
      const run = runs.find((r) => r.sMin <= s + tol && r.sMax > s + tol);
      if (!run) return true;
      s = run.sMax;
    }
    return false;
  }

  function pbGapCounts(gaps) {
    const counts = { PB0: 0, PB1: 0, PB2: 0 };
    for (const g of gaps) {
      if (counts[g.physicalBoundaryId] != null) counts[g.physicalBoundaryId] += 1;
    }
    return counts;
  }

  function findJumpAcrossInterval(run, s0, s1) {
    if (!run?.points?.length || !run.sdPoints?.length) return null;
    const pts = run.points;
    const sd = run.sdPoints;
    for (let i = 0; i < sd.length - 1; i++) {
      const a = sd[i].s;
      const b = sd[i + 1].s;
      if (a <= s0 + 0.5 && b >= s1 - 0.5) {
        const jumpM = dist2d(pts[i], pts[i + 1]);
        return {
          pointBefore: { east: pts[i].east, north: pts[i].north, s: a },
          pointAfter: { east: pts[i + 1].east, north: pts[i + 1].north, s: b },
          jumpM,
          renderedContinuity: jumpM <= RENDERER_MAX_INTRA_GAP_M,
          structuralOnly: jumpM > RENDERER_MAX_INTRA_GAP_M,
        };
      }
    }
    return null;
  }

  function analyzeRepairTarget(target, cleanedRuns, laneFragments) {
    const runs = (cleanedRuns || []).filter((r) => r.physicalBoundaryId === target.physicalBoundaryId)
      .sort((a, b) => a.sMin - b.sMin);
    const open = gapOpenAtInterval(runs, target.routeS0, target.routeS1);
    const mergedRun = runs.find((r) => r.sMin <= target.routeS0 + 1 && r.sMax >= target.routeS1 - 1);
    const preRun = runs.find((r) => Math.abs(r.sMax - target.routeS0) < 2);
    const postRun = runs.find((r) => Math.abs(r.sMin - target.routeS1) < 2);
    const preEnd = preRun?.points?.[preRun.points.length - 1];
    const postStart = postRun?.points?.[0];

    let jump = null;
    if (preEnd && postStart && open) {
      const jumpM = dist2d(preEnd, postStart);
      jump = {
        pointBefore: { east: preEnd.east, north: preEnd.north },
        pointAfter: { east: postStart.east, north: postStart.north },
        jumpM,
        renderedContinuity: jumpM <= RENDERER_MAX_INTRA_GAP_M,
        structuralOnly: jumpM > RENDERER_MAX_INTRA_GAP_M,
      };
    } else if (mergedRun) {
      jump = findJumpAcrossInterval(mergedRun, target.routeS0, target.routeS1);
    }

    const frags = (laneFragments || []).filter((f) =>
      f.physicalBoundaryId === target.physicalBoundaryId
      && f.sMax > target.routeS0 - 5
      && f.sMin < target.routeS1 + 5);

    return {
      id: target.id,
      routeSInterval: [target.routeS0, target.routeS1],
      physicallyOpen: open,
      structurallyRepaired: !open,
      fragmentCountNearGap: frags.length,
      coordinateJump: jump,
      verdict: open
        ? 'open'
        : (jump?.renderedContinuity ? 'rendered_continuity' : 'structural_only'),
    };
  }

  function buildLaneDiagnostics(processedData, stationaryMap, options = {}) {
    const chunk = processedData?.routeChunks?.[0];
    const fusedFragmentCount = chunk?.fusedLaneLines?.length ?? 0;
    const cleanedRuns = stationaryMap?.laneCleanup?.cleaned ?? [];
    const laneFragments = stationaryMap?.laneFragments ?? [];
    const gaps = enumeratePhysicalGaps(cleanedRuns);
    const stage7Enabled = processedData?.processingOptions?.positiveBoundaryContinuityBridgeEnabled === true
      || (options.positiveBoundaryContinuityBridgeEnabled === true);
    const stage8Enabled = processedData?.processingOptions?.visibleGapReconstructionEnabled === true
      || (options.visibleGapReconstructionEnabled === true);
    const repairAnalysis = STAGE7_REPAIR_TARGETS.map((t) =>
      analyzeRepairTarget(t, cleanedRuns, laneFragments));
    const acceptedRepairs = repairAnalysis.filter((r) => r.structurallyRepaired).map((r) => r.id);
    const structuralOnly = repairAnalysis
      .filter((r) => r.structurallyRepaired && r.verdict === 'structural_only').map((r) => r.id);
    const renderedContinuity = repairAnalysis
      .filter((r) => r.structurallyRepaired && r.verdict === 'rendered_continuity').map((r) => r.id);

    return {
      laneChecksum: stationaryMap?.laneChecksum ?? null,
      processingVersion: processedData?.processingVersion ?? null,
      fusedFragmentCount,
      cleanedRunCount: cleanedRuns.length || stationaryMap?.laneFragmentCount || 0,
      laneFragmentCount: stationaryMap?.laneFragmentCount ?? laneFragments.length,
      stableDisconnectionCount: gaps.length,
      pbGapCounts: pbGapCounts(gaps),
      roadSurfaceChecksum: (typeof SegmentLocalMap !== 'undefined'
        ? SegmentLocalMap.computeRoadPolygonChecksum(chunk?.roadSurfacePolygons || [])
        : stationaryMap?.roadSurfaceChecksum ?? null),
      stage7RepairFlag: stage7Enabled,
      stage8ReconstructionFlag: stage8Enabled,
      visibleGapReconstructionEnabled: stage8Enabled,
      acceptedRepairedGapIds: acceptedRepairs,
      structuralOnlyRepairedGapIds: structuralOnly,
      renderedContinuityRepairedGapIds: renderedContinuity,
      repairAnalysis,
      openPhysicalGaps: gaps,
      rendererMaxIntraGapM: RENDERER_MAX_INTRA_GAP_M,
      structuralBridgeSegments: repairAnalysis
        .filter((r) => r.coordinateJump && r.structurallyRepaired)
        .map((r) => ({ id: r.id, ...r.coordinateJump })),
      geometrySource: stationaryMap?.geometrySource ?? options.geometrySource ?? 'cleaned',
      cacheKey: stationaryMap?.cacheKey ?? null,
      cacheState: stationaryMap?.cacheState ?? null,
      apiLaneChecksum: processedData?.laneDiagnostics?.laneChecksum ?? null,
      apiCacheHit: processedData?.cacheHit ?? null,
      continuityVerdict: structuralOnly.length && renderedContinuity.length
        ? 'mixed'
        : structuralOnly.length
          ? 'A_structural_only'
          : renderedContinuity.length
            ? 'B_rendered_continuity'
            : 'none_repaired',
    };
  }

  root.GeometryDiagnostics = {
    STAGE7_REPAIR_TARGETS,
    RENDERER_MAX_INTRA_GAP_M,
    buildLaneDiagnostics,
    enumeratePhysicalGaps,
  };
}(typeof window !== 'undefined' ? window : globalThis));
