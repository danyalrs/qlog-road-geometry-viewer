'use strict';

(function initSegment1LaneOrderDiagnostic(global) {
  const SEG1 = 'qlog_f449c_1.bz2';
  const PRIMARY_FRAME_ID = 1803;

  function det2x2(a, b, c, d) {
    return a * d - b * c;
  }

  function resolvePointCoords(point) {
    if (!point) return null;
    if (Number.isFinite(point.localEast) && Number.isFinite(point.localNorth)) {
      return { east: point.localEast, north: point.localNorth };
    }
    if (Number.isFinite(point.east) && Number.isFinite(point.north)) {
      return { east: point.east, north: point.north };
    }
    return null;
  }

  function nearestTrajectoryIndex(trajectory, east, north, sourceFile) {
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

  function roadRelativeLateralM(trajectory, east, north, sourceFile) {
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

  function roadLeftNormal(trajectory, east, north, sourceFile) {
    const { index, points } = nearestTrajectoryIndex(trajectory, east, north, sourceFile);
    if (!points.length) return null;
    const i0 = Math.max(0, index - 1);
    const i1 = Math.min(points.length - 1, index + 1);
    const a = points[i0];
    const b = points[i1];
    const tx = b.east - a.east;
    const ty = b.north - a.north;
    const len = Math.hypot(tx, ty) || 1;
    return { nx: -ty / len, ny: tx / len, ref: points[index] };
  }

  function standaloneDisplayPoint(map, point, mirrorChecked) {
    const VMC = global.ViewerMirrorCoords;
    const c = resolvePointCoords(point);
    if (!c || !VMC?.resolveRoadDisplayCoords) return null;
    return VMC.resolveRoadDisplayCoords(
      c.east,
      c.north,
      point.mirroredLocalEast,
      point.mirroredLocalNorth,
      mirrorChecked !== false,
      {
        trajectory: map.trajectory,
        referencePose: map.referencePose,
        useTrajectoryFallback: false,
      },
    );
  }

  function combinedDisplayPoint(point) {
    return {
      east: point.placedEast ?? point.east,
      north: point.placedNorth ?? point.north,
      method: point.coordinateFrame === 'combinedPlaced' ? 'combinedPlaced' : 'segmentLocalFallback',
    };
  }

  function placementMatrixFromEntry(entry) {
    if (!entry?.applyCanonical) return null;
    const ex = entry.applyCanonical(1, 0);
    const ey = entry.applyCanonical(0, 1);
    const t = entry.applyCanonical(0, 0);
    const a = ex.east - t.east;
    const b = ex.north - t.north;
    const c = ey.east - t.east;
    const d = ey.north - t.north;
    return {
      a, b, c, d,
      tx: t.east,
      ty: t.north,
      determinant: det2x2(a, b, c, d),
      reflectionApplied: entry.reflectionApplied === true,
      displayCorrection: entry.displayCorrection === true,
    };
  }

  function pointsAtFrame(map, frameId, sourceFile) {
    return (map?.pointAccumulated?.points || []).filter((p) => (
      p.sourceFile === (sourceFile || SEG1)
      && (p.frameId === frameId || p.frameIndex === frameId)
    ));
  }

  function laneColour(renderer, pt) {
    if (pt?.groupTrackId != null && renderer?._pointTrackColorCache?.has?.(pt.groupTrackId)) {
      return renderer._pointTrackColorCache.get(pt.groupTrackId);
    }
    if (pt?.side === 'left') return 'rgba(124,58,237,0.9)';
    if (pt?.side === 'right') return 'rgba(8,145,178,0.9)';
    return 'rgba(148,163,184,0.9)';
  }

  function buildLaneTrace(renderer, map, frameId, mode) {
    const mirrorChecked = renderer?._mirrorRoadLateralDisplay !== false;
    const pts = pointsAtFrame(map, frameId);
    const traj = mode === 'combined'
      ? (map.trajectory || []).filter((p) => p.sourceFile === SEG1)
      : map.trajectory;
    const registry = map?.sourceTransformByFile?.[SEG1] ?? null;
    const matrix = placementMatrixFromEntry(registry);
    const VDC = global.ViewerDisplayCorrections;
    const mapWideCorrection = VDC?.isExactDisplayCorrectionActive
      ? VDC.isExactDisplayCorrectionActive(mirrorChecked, map?.sourceQlogSha256)
      : false;
    const pointCorrection = VDC?.isExactDisplayCorrectionActive
      ? VDC.isExactDisplayCorrectionActive(mirrorChecked, pts[0]?.sourceQlogSha256)
      : false;

    return pts.map((p, modelLaneArrayIndex) => {
      const canonical = resolvePointCoords(p);
      const standalone = standaloneDisplayPoint(map, p, mirrorChecked);
      const combined = combinedDisplayPoint(p);
      const display = mode === 'standalone' ? standalone : combined;
      const d = display ? roadRelativeLateralM(traj, display.east, display.north, mode === 'combined' ? SEG1 : null) : null;
      let canvasInput = null;
      let canvasOutput = null;
      if (renderer?._projectRoadGeometryToScreen && display) {
        const projected = renderer._projectRoadGeometryToScreen(
          p.localEast,
          p.localNorth,
          p.mirroredLocalEast,
          p.mirroredLocalNorth,
          p,
        );
        canvasOutput = projected;
        canvasInput = renderer._usesCombinedPlacedFrame(p)
          ? { east: p.placedEast, north: p.placedNorth, field: 'placedEast/placedNorth' }
          : { east: display.east, north: display.north, field: mode === 'standalone' ? 'mirroredDisplay' : 'segmentLocal' };
      }
      return {
        sourceFile: p.sourceFile,
        frameId: p.frameId ?? p.frameIndex,
        modelLaneArrayIndex,
        laneIndex: p.laneIndex,
        groupTrackId: p.groupTrackId ?? null,
        trackId: p.trackId ?? null,
        side: p.side ?? null,
        assignedColour: laneColour(renderer, p),
        coordinateFrame: p.coordinateFrame ?? 'segmentLocal',
        canonicalLocal: canonical,
        mirroredLocal: { east: p.mirroredLocalEast, north: p.mirroredLocalNorth },
        standaloneDisplay: standalone,
        candidateCInput: canonical,
        candidateCOutput: { placedEast: p.placedEast, placedNorth: p.placedNorth, coordinateFrame: p.coordinateFrame },
        candidateCMatrix: matrix,
        rendererSelected: display,
        canvasInput,
        canvasOutput,
        signedLateralM: d,
        mapWideCorrectionActive: mapWideCorrection,
        pointCorrectionActive: pointCorrection,
        usesCombinedPlacedFrame: renderer?._usesCombinedPlacedFrame?.(p) ?? false,
      };
    });
  }

  function drawOverlay(renderer, map, frameId, mode, expectedStandaloneMap) {
    if (!renderer?.ctx || !renderer?.worldToScreen) return;
    const ctx = renderer.ctx;
    const mirrorChecked = renderer._mirrorRoadLateralDisplay !== false;
    const combined = mode === 'combined';
    const pts = pointsAtFrame(map, frameId);
    const traj = combined
      ? (map.trajectory || []).filter((p) => p.sourceFile === SEG1)
      : map.trajectory;
    const refPt = pts[0];
    if (!refPt) return;
    const displayRef = combined
      ? combinedDisplayPoint(refPt)
      : standaloneDisplayPoint(map, refPt, mirrorChecked);
    if (!displayRef) return;
    const left = roadLeftNormal(traj, displayRef.east, displayRef.north, combined ? SEG1 : null);
    if (!left) return;
    const arrowLen = 8 / (renderer.scale || 1);
    const ax = displayRef.east + left.nx * arrowLen;
    const ay = displayRef.north + left.ny * arrowLen;
    const a0 = renderer.worldToScreen(displayRef.east, displayRef.north);
    const a1 = renderer.worldToScreen(ax, ay);
    ctx.save();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a0.x, a0.y);
    ctx.lineTo(a1.x, a1.y);
    ctx.stroke();
    ctx.fillStyle = '#f59e0b';
    ctx.font = '10px monospace';
    ctx.fillText('road-left', a1.x + 4, a1.y - 4);

    for (const p of pts) {
      const current = combined
        ? combinedDisplayPoint(p)
        : standaloneDisplayPoint(map, p, mirrorChecked);
      if (!current) continue;
      const curScreen = renderer._projectRoadGeometryToScreen(
        p.localEast,
        p.localNorth,
        p.mirroredLocalEast,
        p.mirroredLocalNorth,
        p,
      );
      const d = roadRelativeLateralM(traj, current.east, current.north, combined ? SEG1 : null);
      ctx.fillStyle = laneColour(renderer, p);
      ctx.beginPath();
      ctx.arc(curScreen.x, curScreen.y, 4, 0, Math.PI * 2);
      ctx.fill();

      if (combined && expectedStandaloneMap) {
        const standPts = pointsAtFrame(expectedStandaloneMap, frameId);
        const match = standPts.find((s) => s.groupTrackId === p.groupTrackId && s.laneIndex === p.laneIndex);
        if (match) {
          const stand = standaloneDisplayPoint(expectedStandaloneMap, match, mirrorChecked);
          if (stand) {
            const exp = renderer.worldToScreen(stand.east, stand.north);
            ctx.strokeStyle = laneColour(renderer, p);
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(exp.x, exp.y, 6, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }

      const label = `L${p.laneIndex}/G${p.groupTrackId ?? '?'}`;
      ctx.fillStyle = '#0f172a';
      ctx.fillText(label, curScreen.x + 6, curScreen.y - 6);
      if (Number.isFinite(d)) {
        ctx.fillStyle = '#334155';
        ctx.fillText(`${d.toFixed(2)}m`, curScreen.x + 6, curScreen.y + 10);
      }
    }
    ctx.restore();
  }

  function canvasTransformTrace(renderer) {
    const ctx = renderer?.ctx;
    if (!ctx?.getTransform) return null;
    const t = ctx.getTransform();
    const det = det2x2(t.a, t.b, t.c, t.d);
    return {
      a: t.a, b: t.b, c: t.c, d: t.d, e: t.e, f: t.f,
      determinant: det,
      mirrorCheckbox: renderer?._mirrorRoadLateralDisplay !== false,
      coordinateFrame: renderer?.stationaryLocalMap?.combinedCoordinateFrame ?? 'segmentLocal',
      boundaryAnchored: renderer?.stationaryLocalMap?.boundaryAnchoredOrientationActive === true,
    };
  }

  global.Segment1LaneOrderDiagnostic = {
    SEG1,
    PRIMARY_FRAME_ID,
    roadRelativeLateralM,
    buildLaneTrace,
    drawOverlay,
    canvasTransformTrace,
    standaloneDisplayPoint,
    combinedDisplayPoint,
    placementMatrixFromEntry,
  };
}(typeof window !== 'undefined' ? window : globalThis));
