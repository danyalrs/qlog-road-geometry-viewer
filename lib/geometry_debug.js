/** Build geometry verification payload for API + browser console. */

function polygonBounds(ring) {
  if (!ring?.length) return null;
  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (const pt of ring) {
    if (!Number.isFinite(pt.east) || !Number.isFinite(pt.north)) continue;
    minE = Math.min(minE, pt.east);
    maxE = Math.max(maxE, pt.east);
    minN = Math.min(minN, pt.north);
    maxN = Math.max(maxN, pt.north);
  }
  if (!Number.isFinite(minE)) return null;
  return { minE, maxE, minN, maxN, widthM: maxE - minE, heightM: maxN - minN };
}

function buildGeometryDebug(result, segments) {
  const chunks = result.routeChunks || [];
  const polygons = [];
  const passCoverage = [];
  const passIds = [];

  for (const chunk of chunks) {
    for (const p of chunk.passCoverage || []) {
      passCoverage.push({ ...p, chunkId: chunk.chunkId });
      passIds.push({ chunkId: chunk.chunkId, passId: p.passId });
    }
    for (const poly of chunk.roadSurfacePolygons || []) {
      const ring = poly.ring || [];
      polygons.push({
        chunkId: chunk.chunkId,
        passId: poly.passId ?? null,
        fragmentIndex: poly.fragmentIndex,
        pointCount: ring.length,
        bounds: polygonBounds(ring),
        stats: poly.stats ? {
          medianWidth: poly.stats.medianWidth,
          maxWidth: poly.stats.maxWidth,
          sRange: poly.stats.sRange,
        } : null,
      });
    }
  }

  const splitEvents = chunks.flatMap((c) => (c.passDiagnostics?.splitEvents || []).map((e) => ({
    ...e,
    chunkId: c.chunkId,
  })));

  return {
    segments: segments || [],
    segmentCount: segments?.length ?? 0,
    chunkCount: chunks.length,
    passCount: passIds.length,
    polygonCount: polygons.length,
    passIds,
    passCoverage,
    polygons,
    splitEvents,
    totalFrames: result.frames?.length ?? 0,
    laneTracking: result.laneTrackingSummary ?? null,
  };
}

module.exports = { buildGeometryDebug, polygonBounds };
