'use strict';

/**
 * Shared Candidate C source-to-combined coordinate transform registry.
 * One transform per source file; layer-independent placement contract.
 */

const VDC = require('./viewer_display_corrections');

const OUTPUT_FRAME = 'combinedPlaced';
const NUMERIC_TOLERANCE_M = 1e-6;

function toSourceLocal(point, origin, headingRad) {
  const de = point.east - origin.east;
  const dn = point.north - origin.north;
  const cos = Math.cos(-headingRad);
  const sin = Math.sin(-headingRad);
  return {
    east: de * cos - dn * sin,
    north: de * sin + dn * cos,
  };
}

function headingRadForChunk(points) {
  if (points.length >= 2) {
    const a = points[0];
    const b = points[1];
    return Math.atan2(b.north - a.north, b.east - a.east);
  }
  const h = points[0]?.poseHeadingDeg;
  if (Number.isFinite(h)) return (h * Math.PI) / 180;
  return 0;
}

function resolvePointCoords(point) {
  if (Number.isFinite(point?.localEast) && Number.isFinite(point?.localNorth)) {
    return { east: point.localEast, north: point.localNorth };
  }
  const east = point?.east;
  const north = point?.north;
  if (!Number.isFinite(east) || !Number.isFinite(north)) return null;
  return { east, north };
}

function finalizePlacedPoint(point, placed) {
  const e = placed.east;
  const n = placed.north;
  const coords = resolvePointCoords(point);
  const sourceCanonicalLocalEast = Number.isFinite(point?.sourceCanonicalLocalEast)
    ? point.sourceCanonicalLocalEast
    : (coords ? coords.east : undefined);
  const sourceCanonicalLocalNorth = Number.isFinite(point?.sourceCanonicalLocalNorth)
    ? point.sourceCanonicalLocalNorth
    : (coords ? coords.north : undefined);
  const sourceMirroredLocalEast = Number.isFinite(point?.sourceMirroredLocalEast)
    ? point.sourceMirroredLocalEast
    : (Number.isFinite(point?.mirroredLocalEast) ? point.mirroredLocalEast
      : (Number.isFinite(point?.mirroredEast) ? point.mirroredEast : undefined));
  const sourceMirroredLocalNorth = Number.isFinite(point?.sourceMirroredLocalNorth)
    ? point.sourceMirroredLocalNorth
    : (Number.isFinite(point?.mirroredLocalNorth) ? point.mirroredLocalNorth
      : (Number.isFinite(point?.mirroredNorth) ? point.mirroredNorth : undefined));
  return {
    ...point,
    sourceCanonicalLocalEast,
    sourceCanonicalLocalNorth,
    sourceMirroredLocalEast,
    sourceMirroredLocalNorth,
    placedEast: e,
    placedNorth: n,
    east: e,
    north: n,
    localEast: e,
    localNorth: n,
    mirroredEast: e,
    mirroredNorth: n,
    mirroredLocalEast: e,
    mirroredLocalNorth: n,
    coordinateFrame: OUTPUT_FRAME,
  };
}

function buildIdentityTransformEntry(sourceFile, sourceQlogSha256) {
  return {
    sourceFile,
    sourceQlogSha256: sourceQlogSha256 ?? null,
    displayCorrection: false,
    reflectionApplied: false,
    rotationRad: 0,
    translationEast: 0,
    translationNorth: 0,
    placementResidualM: 0,
    outputFrame: OUTPUT_FRAME,
    identity: true,
    applyCanonical: (east, north) => ({ east, north }),
  };
}

function buildCorrectedTransformEntry({
  sourceFile,
  sourceQlogSha256,
  origin,
  headingRad,
  fit,
  mirrorChecked,
}) {
  const displayCorrection = VDC.isExactDisplayCorrectionActive(mirrorChecked, sourceQlogSha256);
  const applyCanonical = (east, north) => {
    const local = toSourceLocal({ east, north }, origin, headingRad);
    const corrected = displayCorrection
      ? VDC.transformDisplayPoint(local.east, local.north)
      : local;
    return fit.apply(corrected);
  };
  const probe = applyCanonical(origin.east, origin.north);
  return {
    sourceFile,
    sourceQlogSha256: sourceQlogSha256 ?? null,
    displayCorrection,
    reflectionApplied: displayCorrection,
    rotationRad: (fit.rotationDeg ?? 0) * (Math.PI / 180),
    translationEast: probe.east - origin.east,
    translationNorth: probe.north - origin.north,
    placementResidualM: fit.residualM ?? 0,
    outputFrame: OUTPUT_FRAME,
    identity: false,
    applyCanonical,
  };
}

function transformSourcePointToCombined({ east, north, sourceFile, sourceQlogSha256 }, registry) {
  if (!Number.isFinite(east) || !Number.isFinite(north)) {
    return {
      east,
      north,
      coordinateFrame: 'invalid',
      diagnostic: 'nonFiniteInput',
    };
  }
  const entry = registry?.[sourceFile];
  if (!entry) {
    return {
      east,
      north,
      coordinateFrame: 'unplaced',
      diagnostic: 'missingSourceTransform',
      sourceFile,
      sourceQlogSha256: sourceQlogSha256 ?? null,
    };
  }
  const placed = entry.applyCanonical(east, north);
  return {
    east: placed.east,
    north: placed.north,
    coordinateFrame: OUTPUT_FRAME,
    sourceFile,
    sourceQlogSha256: entry.sourceQlogSha256 ?? sourceQlogSha256 ?? null,
  };
}

function inferSourceFile(point, timeline, hintSourceFile = null) {
  if (point?.sourceFile) return point.sourceFile;
  if (hintSourceFile) return hintSourceFile;
  const idx = point?.timelineIndex ?? point?.frameIndex ?? point?.sourceFrameIndex;
  if (Number.isFinite(idx) && timeline?.[idx]?.sourceFile) return timeline[idx].sourceFile;
  if (point?.segmentId && String(point.segmentId).includes('.bz2')) return point.segmentId;
  return null;
}

function transformMapPoint(point, registry, timeline, hintSourceFile = null) {
  if (!point) return point;
  if (point.coordinateFrame === OUTPUT_FRAME) return point;
  const coords = resolvePointCoords(point);
  if (!coords) return point;
  const sourceFile = inferSourceFile(point, timeline, hintSourceFile);
  if (!sourceFile) {
    return {
      ...point,
      placementDiagnostic: 'missingSourceProvenance',
    };
  }
  const placed = transformSourcePointToCombined({
    east: coords.east,
    north: coords.north,
    sourceFile,
    sourceQlogSha256: point.sourceQlogSha256,
  }, registry);
  if (placed.coordinateFrame !== OUTPUT_FRAME) return { ...point, ...placed };
  return finalizePlacedPoint({ ...point, sourceFile }, placed);
}

function transformPointList(points, registry, timeline, hintSourceFile = null) {
  return (points || []).map((pt) => transformMapPoint(pt, registry, timeline, hintSourceFile));
}

function transformFragmentList(fragments, registry, timeline) {
  return (fragments || []).map((frag) => {
    const hint = timeline?.[frag.sourceFrameIndex]?.sourceFile ?? frag.sourceFile ?? null;
    return {
      ...frag,
      sourceFile: hint ?? frag.sourceFile ?? null,
      points: transformPointList(frag.points, registry, timeline, hint),
    };
  });
}

function transformPolygonList(polygons, registry, timeline) {
  return (polygons || []).map((poly) => ({
    ...poly,
    ring: transformPointList(poly.ring, registry, timeline, poly.sourceFile ?? null),
  }));
}

function transformPolylineChains(polylines, registry, timeline, hintSourceFile = null) {
  return (polylines || []).map((poly) => transformPointList(poly, registry, timeline, hintSourceFile));
}

function transformFittedPolylineShape(fittedPolyline, registry, timeline, hintSourceFile = null) {
  if (!fittedPolyline) return fittedPolyline;
  if (!Array.isArray(fittedPolyline)) return fittedPolyline;
  if (!fittedPolyline.length) return fittedPolyline;
  if (typeof fittedPolyline[0]?.east === 'number') {
    return transformPointList(fittedPolyline, registry, timeline, hintSourceFile);
  }
  if (Array.isArray(fittedPolyline[0])) {
    return transformPolylineChains(fittedPolyline, registry, timeline, hintSourceFile);
  }
  return fittedPolyline;
}

function transformFittedPolylines(fittedPolylines, registry, timeline) {
  if (!fittedPolylines?.results?.length) return fittedPolylines;
  return {
    ...fittedPolylines,
    results: fittedPolylines.results.map((result) => {
      const hint = result.sourceFile ?? null;
      return {
        ...result,
        fittedPolyline: transformFittedPolylineShape(result.fittedPolyline, registry, timeline, hint),
        segments: (result.segments || []).map((seg) => ({
          ...seg,
          fittedPolyline: transformFittedPolylineShape(seg.fittedPolyline, registry, timeline, hint),
          gapMarkers: transformPointList(seg.gapMarkers, registry, timeline, hint),
        })),
      };
    }),
  };
}

function transformHybridBoundaries(hybrid, registry, timeline) {
  if (!hybrid?.boundaries?.length) return hybrid;
  return {
    ...hybrid,
    boundaries: hybrid.boundaries.map((boundary) => {
      const hint = boundary.sourceFile
        ?? (Number.isFinite(boundary.startFrameIndex) ? timeline?.[boundary.startFrameIndex]?.sourceFile : null)
        ?? boundary.polylines?.[0]?.[0]?.sourceFile
        ?? boundary.points?.[0]?.sourceFile
        ?? null;
      return {
        ...boundary,
        coordinateFrame: OUTPUT_FRAME,
        points: transformPointList(boundary.points, registry, timeline, hint),
        polylines: transformPolylineChains(boundary.polylines, registry, timeline, hint),
        mirroredPolylines: transformPolylineChains(boundary.mirroredPolylines, registry, timeline, hint),
        gapMarkers: transformPointList(boundary.gapMarkers, registry, timeline, hint),
      };
    }),
  };
}

function transformConstructedFragments(constructed, registry, timeline) {
  if (!constructed?.fragments?.length) return constructed;
  return {
    ...constructed,
    fragments: constructed.fragments.map((frag) => ({
      ...frag,
      points: transformPointList(frag.points, registry, timeline, frag.sourceFile ?? null),
    })),
  };
}

function transformJoinedPolylines(joined, registry, timeline) {
  if (!joined?.polylines?.length) return joined;
  return {
    ...joined,
    polylines: joined.polylines.map((poly) => ({
      ...poly,
      points: transformPointList(poly.points, registry, timeline, poly.sourceFile ?? null),
    })),
  };
}

function applySourceTransformsToMap(map, registry, timeline) {
  if (!map || !registry) return map;
  map.trajectory = transformPointList(map.trajectory, registry, timeline);
  map.laneFragments = transformFragmentList(map.laneFragments, registry, timeline);
  map.edgeFragments = transformFragmentList(map.edgeFragments, registry, timeline);
  map.roadSurfacePolygons = transformPolygonList(map.roadSurfacePolygons, registry, timeline);

  if (map.pointAccumulated) {
    const pa = map.pointAccumulated;
    map.pointAccumulated = {
      ...pa,
      points: transformPointList(pa.points, registry, timeline),
      rejected: transformPointList(pa.rejected, registry, timeline),
      constructedFragments: transformConstructedFragments(pa.constructedFragments, registry, timeline),
      joinedPolylines: transformJoinedPolylines(pa.joinedPolylines, registry, timeline),
      fittedPolylines: transformFittedPolylines(pa.fittedPolylines, registry, timeline),
      hybridFittedBoundaries: transformHybridBoundaries(pa.hybridFittedBoundaries, registry, timeline),
    };
  }

  map.sourceTransformByFile = registry;
  map.combinedCoordinateFrame = OUTPUT_FRAME;
  return map;
}

function transformsAgree(registry, sourceFile, east, north, toleranceM = NUMERIC_TOLERANCE_M) {
  const a = transformSourcePointToCombined({ east, north, sourceFile }, registry);
  const b = registry?.[sourceFile]?.applyCanonical(east, north);
  if (!b) return false;
  return Math.hypot(a.east - b.east, a.north - b.north) <= toleranceM;
}

function roadAndLanePlacedAgreement(roadEast, roadNorth, laneEast, laneNorth, toleranceM = 0.05) {
  return Math.hypot(roadEast - laneEast, roadNorth - laneNorth) <= toleranceM;
}

module.exports = {
  OUTPUT_FRAME,
  NUMERIC_TOLERANCE_M,
  toSourceLocal,
  headingRadForChunk,
  finalizePlacedPoint,
  buildIdentityTransformEntry,
  buildCorrectedTransformEntry,
  transformSourcePointToCombined,
  inferSourceFile,
  transformMapPoint,
  applySourceTransformsToMap,
  transformsAgree,
  roadAndLanePlacedAgreement,
};
