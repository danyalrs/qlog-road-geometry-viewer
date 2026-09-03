'use strict';

/**
 * Combined-map orientation candidates (display-only).
 * Candidate B (per-source post-placement reflection) is rejected.
 * Candidate C applies source-local correction then boundary-anchored rigid placement.
 */

const crypto = (typeof process !== 'undefined' && process.versions?.node && typeof require !== 'undefined')
  ? require('crypto')
  : null;
const VDC = require('./viewer_display_corrections');
const VMC = require('./viewer_mirror_coords');
const CRB = require('./combined_route_boundary_bridge');
const CST = require('./combined_source_transform');

const CANDIDATE_QUERY_PARAM = 'combinedOrientationCandidate';
const CANDIDATE_BOUNDARY_ANCHORED = 'boundaryAnchored';
const CANDIDATE_A_DIAGNOSTIC = 'commonTransformNoSeg0Correction';

const BASELINE_SEAM_TOLERANCE_M = 0.5;
const BASELINE_TANGENT_TOLERANCE_DEG = 2;
const MAX_FIT_RESIDUAL_M = 0.5;

function parseCombinedOrientationCandidate(search) {
  const raw = typeof search === 'string'
    ? new URLSearchParams(search).get(CANDIDATE_QUERY_PARAM)
    : search?.get?.(CANDIDATE_QUERY_PARAM);
  if (!raw) return null;
  const v = String(raw).trim();
  if (v === CANDIDATE_BOUNDARY_ANCHORED || v === CANDIDATE_A_DIAGNOSTIC) return v;
  return null;
}

function buildSourceSha256Lookup(fileAudits) {
  const lookup = {};
  for (const audit of fileAudits || []) {
    const sha = typeof audit?.sha256 === 'string' ? audit.sha256.toLowerCase() : null;
    if (audit?.filename && sha) lookup[audit.filename] = sha;
  }
  return lookup;
}

function annotateTrajectorySources(trajectory, timeline) {
  return (trajectory || []).map((p) => ({
    ...p,
    sourceFile: p.sourceFile ?? timeline?.[p.timelineIndex]?.sourceFile ?? null,
  }));
}

function withAnnotatedTrajectory(map, processedData) {
  if (!map) return map;
  const trajectory = annotateTrajectorySources(map.trajectory, processedData?.timeline);
  return { ...map, trajectory };
}

function uniqueSourceFiles(trajectory) {
  const files = [];
  const seen = new Set();
  for (const p of trajectory || []) {
    if (!p?.sourceFile || seen.has(p.sourceFile)) continue;
    seen.add(p.sourceFile);
    files.push(p.sourceFile);
  }
  return files;
}

function isMultiSourceMap(map) {
  return uniqueSourceFiles(map?.trajectory).length > 1;
}

function splitTrajectoryBySource(trajectory) {
  const chunks = [];
  let current = null;
  for (const p of trajectory || []) {
    const sf = p.sourceFile ?? null;
    if (!current || current.sourceFile !== sf) {
      if (current) chunks.push(current);
      current = { sourceFile: sf, points: [] };
    }
    current.points.push(p);
  }
  if (current) chunks.push(current);
  return chunks;
}

function tangentRadAtEnd(points) {
  const n = points.length;
  if (n < 2) return 0;
  const a = points[n - 2];
  const b = points[n - 1];
  return Math.atan2(b.north - a.north, b.east - a.east);
}

function tangentRadAtStart(points) {
  if (points.length < 2) return 0;
  const a = points[0];
  const b = points[1];
  return Math.atan2(b.north - a.north, b.east - a.east);
}

function normalizeAngleRad(a) {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

function seamBetweenChunks(endChunk, startChunk) {
  const end = endChunk.points[endChunk.points.length - 1];
  const start = startChunk.points[0];
  const distanceM = Math.hypot(end.east - start.east, end.north - start.north);
  const tanA = tangentRadAtEnd(endChunk.points);
  const tanB = tangentRadAtStart(startChunk.points);
  const tangentDeltaRad = normalizeAngleRad(tanB - tanA);
  return {
    fromSource: endChunk.sourceFile,
    toSource: startChunk.sourceFile,
    endPosition: { east: end.east, north: end.north },
    startPosition: { east: start.east, north: start.north },
    seamDistanceM: distanceM,
    tangentDeltaRad,
    tangentDeltaDeg: tangentDeltaRad * (180 / Math.PI),
  };
}

function measureBoundaryMetrics(trajectory, timeline) {
  const annotated = annotateTrajectorySources(trajectory, timeline);
  const chunks = splitTrajectoryBySource(annotated);
  const seams = [];
  for (let i = 0; i < chunks.length - 1; i++) {
    seams.push(seamBetweenChunks(chunks[i], chunks[i + 1]));
  }
  const chunkBounds = chunks.map((c) => ({
    sourceFile: c.sourceFile,
    start: { east: c.points[0].east, north: c.points[0].north },
    end: { east: c.points[c.points.length - 1].east, north: c.points[c.points.length - 1].north },
    pointCount: c.points.length,
  }));
  return { chunks: chunkBounds, seams };
}

function fromSourceLocal(local, origin, headingRad) {
  const cos = Math.cos(headingRad);
  const sin = Math.sin(headingRad);
  return {
    east: origin.east + local.east * cos - local.north * sin,
    north: origin.north + local.east * sin + local.north * cos,
  };
}

function solveRigidFromTwoAnchors(srcA, srcB, dstA, dstB) {
  const vsx = srcB.east - srcA.east;
  const vsy = srcB.north - srcA.north;
  const vdx = dstB.east - dstA.east;
  const vdy = dstB.north - dstA.north;
  const ls = Math.hypot(vsx, vsy);
  const ld = Math.hypot(vdx, vdy);
  if (ls < 1e-9 || ld < 1e-9) {
    return {
      apply: (p) => ({ east: p.east + (dstA.east - srcA.east), north: p.north + (dstA.north - srcA.north) }),
      rotationDeg: 0,
      scale: 1,
      residualM: Math.hypot(dstA.east - srcA.east, dstA.north - srcA.north),
      degenerate: true,
    };
  }
  const ang = Math.atan2(vdy, vdx) - Math.atan2(vsy, vsx);
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const apply = (p) => ({
    east: dstA.east + cos * (p.east - srcA.east) - sin * (p.north - srcA.north),
    north: dstA.north + sin * (p.east - srcA.east) + cos * (p.north - srcA.north),
  });
  const fittedEnd = apply(srcB);
  const residualM = Math.hypot(fittedEnd.east - dstB.east, fittedEnd.north - dstB.north);
  return { apply, rotationDeg: ang * (180 / Math.PI), scale: ld / ls, residualM, degenerate: false };
}

function solveRigidLeastSquares(srcPts, dstPts) {
  if (!srcPts.length || srcPts.length !== dstPts.length) {
    return { apply: (p) => p, rotationDeg: 0, residualM: Infinity, degenerate: true };
  }
  if (srcPts.length === 2) {
    return solveRigidFromTwoAnchors(srcPts[0], srcPts[1], dstPts[0], dstPts[1]);
  }
  let srcCx = 0;
  let srcCy = 0;
  let dstCx = 0;
  let dstCy = 0;
  for (let i = 0; i < srcPts.length; i++) {
    srcCx += srcPts[i].east;
    srcCy += srcPts[i].north;
    dstCx += dstPts[i].east;
    dstCy += dstPts[i].north;
  }
  srcCx /= srcPts.length;
  srcCy /= srcPts.length;
  dstCx /= dstPts.length;
  dstCy /= dstPts.length;
  let h11 = 0;
  let h12 = 0;
  let h21 = 0;
  let h22 = 0;
  for (let i = 0; i < srcPts.length; i++) {
    const sx = srcPts[i].east - srcCx;
    const sy = srcPts[i].north - srcCy;
    const dx = dstPts[i].east - dstCx;
    const dy = dstPts[i].north - dstCy;
    h11 += sx * dx;
    h12 += sx * dy;
    h21 += sy * dx;
    h22 += sy * dy;
  }
  const det = h11 * h22 - h12 * h21;
  const trace = h11 + h22;
  const ang = Math.atan2(h21 - h12, trace);
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const apply = (p) => {
    const sx = p.east - srcCx;
    const sy = p.north - srcCy;
    return {
      east: dstCx + cos * sx - sin * sy,
      north: dstCy + sin * sx + cos * sy,
    };
  };
  let residualSum = 0;
  for (let i = 0; i < srcPts.length; i++) {
    const fitted = apply(srcPts[i]);
    residualSum += Math.hypot(fitted.east - dstPts[i].east, fitted.north - dstPts[i].north);
  }
  return {
    apply,
    rotationDeg: ang * (180 / Math.PI),
    residualM: residualSum / srcPts.length,
    degenerate: !Number.isFinite(det) || Math.abs(det) < 1e-12,
  };
}

function applyCorrectionInSourceLocal(points, origin, headingRad, transformDisplayPoint) {
  return points.map((p) => {
    const local = CST.toSourceLocal(p, origin, headingRad);
    const corrected = transformDisplayPoint(local.east, local.north);
    return {
      ...p,
      east: corrected.east,
      north: corrected.north,
      _correctedLocal: corrected,
      _baseline: { east: p.east, north: p.north },
    };
  });
}

function simulateCandidateBPostPlacementReflection(trajectory, shaByFile, mirrorChecked = true, timeline = null) {
  const annotated = annotateTrajectorySources(trajectory, timeline);
  const transformed = annotated.map((p) => {
    const sha = shaByFile[p.sourceFile];
    if (VDC.isExactDisplayCorrectionActive(mirrorChecked, sha)) {
      const t = VDC.transformDisplayPoint(p.east, p.north);
      return { ...p, east: t.east, north: t.north };
    }
    return { ...p };
  });
  return {
    trajectory: transformed,
    metrics: measureBoundaryMetrics(transformed, timeline),
    firstPerSourceTransformLocation: 'public/render.js::_segmentDisplayToScreen per sourceFile',
  };
}

function signedTurnSequence(points) {
  const turns = [];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    turns.push(
      (b.east - a.east) * (c.north - b.north)
      - (b.north - a.north) * (c.east - b.east),
    );
  }
  return turns;
}

function dominantTurnSign(turns) {
  let pos = 0;
  let neg = 0;
  for (const t of turns) {
    if (t > 1e-6) pos += 1;
    else if (t < -1e-6) neg += 1;
  }
  if (pos > neg) return 'left';
  if (neg > pos) return 'right';
  return 'straight';
}

function evaluateCandidateADisplay(trajectory, mirrorChecked = true, timeline = null) {
  const annotated = annotateTrajectorySources(trajectory, timeline);
  const display = annotated.map((p) => (
    mirrorChecked
      ? VMC.resolveRoadDisplayCoords(p.east, p.north, null, null, true, { useTrajectoryFallback: false })
      : { east: p.east, north: p.north }
  ));
  return {
    trajectoryDisplay: display,
    metrics: measureBoundaryMetrics(annotated, timeline),
    signedTurns: signedTurnSequence(display),
    mapWideSeg0Correction: false,
    note: 'Multi-source map rendered with one common transform; Segment 0 exact correction disabled.',
  };
}

function nearestTrajectorySource(trajectory, east, north) {
  let best = null;
  let bestD = Infinity;
  for (const p of trajectory || []) {
    const d = Math.hypot(p.east - east, p.north - north);
    if (d < bestD) {
      bestD = d;
      best = p.sourceFile;
    }
  }
  return best;
}

function boundaryCrossingsAreBridged(trajectory, maxStepM) {
  return CRB.boundaryCrossingsAreBridged(trajectory, maxStepM);
}

function trajectoryIsContinuous(trajectory, maxStepM = CRB.CONTINUITY_MAX_STEP_M) {
  return CRB.boundaryCrossingsAreBridged(trajectory, maxStepM);
}

function maxConsecutiveTrajectoryGapM(trajectory) {
  return CRB.maxConsecutiveTrajectoryGapM(trajectory);
}

function seamsMatchBaseline() {
  return false;
}

function seamWorseThanBaseline(candidateSeam, baselineSeam, marginM = 1) {
  return candidateSeam.seamDistanceM > baselineSeam.seamDistanceM + marginM;
}

function buildSourceTransformRegistry(chunks, shaByFile, mirrorChecked) {
  const registry = {};
  for (const chunk of chunks) {
    const sha = shaByFile[chunk.sourceFile];
    const needsCorrection = VDC.isExactDisplayCorrectionActive(mirrorChecked, sha);
    if (!needsCorrection) {
      registry[chunk.sourceFile] = CST.buildIdentityTransformEntry(chunk.sourceFile, sha);
      continue;
    }

    const baselineStart = chunk.points[0];
    const baselineEnd = chunk.points[chunk.points.length - 1];
    const headingRad = CST.headingRadForChunk(chunk.points);
    const origin = baselineStart;

    const correctedLocal = chunk.points.map((p) => {
      const local = CST.toSourceLocal(p, origin, headingRad);
      return VDC.transformDisplayPoint(local.east, local.north);
    });

    const anchorSrc = [correctedLocal[0], correctedLocal[correctedLocal.length - 1]];
    const anchorDst = [
      { east: baselineStart.east, north: baselineStart.north },
      { east: baselineEnd.east, north: baselineEnd.north },
    ];
    const fit = solveRigidFromTwoAnchors(anchorSrc[0], anchorSrc[1], anchorDst[0], anchorDst[1]);

    const anchorSamples = [];
    const step = Math.max(1, Math.floor(chunk.points.length / 5));
    for (let i = 0; i < chunk.points.length; i += step) {
      anchorSamples.push({
        src: correctedLocal[i],
        dst: { east: chunk.points[i].east, north: chunk.points[i].north },
      });
    }
    const lsFit = anchorSamples.length > 2
      ? solveRigidLeastSquares(anchorSamples.map((s) => s.src), anchorSamples.map((s) => s.dst))
      : fit;
    const finalFit = lsFit.residualM <= fit.residualM ? lsFit : fit;

    if (finalFit.residualM > MAX_FIT_RESIDUAL_M) {
      registry[chunk.sourceFile] = CST.buildIdentityTransformEntry(chunk.sourceFile, sha);
      registry[chunk.sourceFile].rejected = true;
      registry[chunk.sourceFile].reason = 'fitResidualExceedsBaselineContract';
      continue;
    }

    registry[chunk.sourceFile] = CST.buildCorrectedTransformEntry({
      sourceFile: chunk.sourceFile,
      sourceQlogSha256: sha,
      origin,
      headingRad,
      fit: finalFit,
      mirrorChecked,
    });
  }
  return registry;
}

function placementsFromRegistry(registry) {
  return Object.values(registry || {}).map((entry) => ({
    sourceFile: entry.sourceFile,
    corrected: !entry.identity,
    rejected: !!entry.rejected,
    residualM: entry.placementResidualM ?? 0,
    rotationDeg: (entry.rotationRad ?? 0) * (180 / Math.PI),
    reason: entry.reason ?? null,
    transformOrder: entry.identity
      ? ['combinedBaselineIdentity']
      : [
        'canonicalSourceLocalGeometry',
        'sourceHashCorrectionInLocalFrame',
        'boundaryAnchoredRotation',
        'boundaryAnchoredTranslation',
        'combinedPlaced',
      ],
  }));
}

function applyBoundaryAnchoredOrientation(map, processedData, options = {}) {
  const workingMap = withAnnotatedTrajectory(map, processedData);
  if (!workingMap || !isMultiSourceMap(workingMap)) return map;
  const mirrorChecked = options.mirrorChecked !== false;
  const shaByFile = buildSourceSha256Lookup(processedData?.fileAudits);
  const baselineTrajectory = (workingMap.trajectory || []).map((p) => ({ ...p }));
  const baselineMetrics = measureBoundaryMetrics(baselineTrajectory, processedData?.timeline);
  const chunks = splitTrajectoryBySource(baselineTrajectory);
  const sourceTransformByFile = buildSourceTransformRegistry(chunks, shaByFile, mirrorChecked);
  const placements = placementsFromRegistry(sourceTransformByFile);

  const out = {
    ...workingMap,
    trajectory: baselineTrajectory.map((p) => ({ ...p })),
    laneFragments: (map.laneFragments || []).map((f) => ({ ...f, points: (f.points || []).map((pt) => ({ ...pt })) })),
    edgeFragments: (map.edgeFragments || []).map((f) => ({ ...f, points: (f.points || []).map((pt) => ({ ...pt })) })),
    roadSurfacePolygons: (map.roadSurfacePolygons || []).map((poly) => ({
      ...poly,
      ring: (poly.ring || []).map((pt) => ({ ...pt })),
    })),
    pointAccumulated: map.pointAccumulated ? {
      ...map.pointAccumulated,
      points: (map.pointAccumulated.points || []).map((p) => ({ ...p })),
    } : map.pointAccumulated,
  };

  CST.applySourceTransformsToMap(out, sourceTransformByFile, processedData?.timeline);

  const bridged = CRB.applyCombinedRouteBoundaryBridges(out, processedData, options);
  const finalMetrics = measureBoundaryMetrics(bridged.trajectory, processedData?.timeline);
  bridged.boundaryAnchoredOrientationActive = true;
  bridged.combinedOrientationCandidate = CANDIDATE_BOUNDARY_ANCHORED;
  bridged.sourceSha256ByFile = shaByFile;
  bridged.sourceFiles = uniqueSourceFiles(bridged.trajectory);
  bridged.isMultiSource = true;
  bridged.boundaryAnchoredPlacements = placements;
  bridged.sourceTransformByFile = sourceTransformByFile;
  bridged.combinedCoordinateFrame = CST.OUTPUT_FRAME;
  bridged.boundaryAnchoredMetrics = {
    baseline: baselineMetrics,
    final: finalMetrics,
    maxConsecutiveGapM: bridged.combinedRouteContinuity?.maxConsecutiveGapM,
    centerlineContinuous: trajectoryIsContinuous(bridged.trajectory),
  };
  bridged.suppressMapWideDisplayCorrection = true;
  bridged.boundaryGapDiagnosis = CRB.buildBoundaryGapDiagnosis(map, processedData);
  return bridged;
}

function checksumTrajectory(trajectory) {
  const payload = JSON.stringify(
    (trajectory || []).map((p) => [p.east, p.north, p.sourceFile]),
  );
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function buildRejectedCandidateBReport(trajectory, shaByFile, timeline = null) {
  const annotated = annotateTrajectorySources(trajectory, timeline);
  const baseline = measureBoundaryMetrics(annotated, timeline);
  const rejected = simulateCandidateBPostPlacementReflection(annotated, shaByFile, true, timeline);
  const displacement = [];
  for (let i = 0; i < annotated.length; i++) {
    const b = annotated[i];
    const r = rejected.trajectory[i];
    const d = Math.hypot(r.east - b.east, r.north - b.north);
    if (d > 1e-6) {
      displacement.push({
        sourceFile: b.sourceFile,
        timelineIndex: b.timelineIndex,
        displacementM: d,
      });
    }
  }
  return {
    verdict: 'Candidate B rejected: correct handedness, broken route continuity.',
    note: 'A dashed connector must not count as continuity.',
    baselineBoundaries: baseline,
    rejectedBoundaries: rejected.metrics,
    seamDistanceAfterCandidateBM: rejected.metrics.seams.map((s) => s.seamDistanceM),
    tangentDeltaAfterCandidateBDeg: rejected.metrics.seams.map((s) => s.tangentDeltaDeg),
    displacementIntroducedByPerSourceReflection: displacement,
    firstDifferentTransformLocation: rejected.firstPerSourceTransformLocation,
    artificialConnectorRequired: rejected.metrics.seams.some((s, i) => (
      baseline.seams[i] && seamWorseThanBaseline(s, baseline.seams[i])
    )),
  };
}

function buildContinuousBaselineReport(map, processedData) {
  const shaByFile = buildSourceSha256Lookup(processedData?.fileAudits);
  const trajectory = annotateTrajectorySources(map.trajectory, processedData?.timeline);
  const metrics = measureBoundaryMetrics(trajectory, processedData?.timeline);
  const seg2File = Object.keys(shaByFile).find((f) => /_2\.bz2$/i.test(f)) ?? null;
  const seg2Points = seg2File
    ? trajectory.filter((p) => p.sourceFile === seg2File)
    : [];
  return {
    selection: uniqueSourceFiles(trajectory).map((f) => Number((f.match(/_(\d+)\./) || [])[1])).filter((n) => Number.isFinite(n)),
    seamDistancesM: metrics.seams.map((s) => s.seamDistanceM),
    tangentDeltaDeg: metrics.seams.map((s) => s.tangentDeltaDeg),
    regressionLimits: {
      seamDistanceM: metrics.seams.map((s) => s.seamDistanceM),
      tangentDeltaDeg: metrics.seams.map((s) => s.tangentDeltaDeg),
      seamToleranceM: BASELINE_SEAM_TOLERANCE_M,
      tangentToleranceDeg: BASELINE_TANGENT_TOLERANCE_DEG,
    },
    ribbonContinuity: false,
    trajectoryContinuity: false,
    sourceBoundarySeamDistancesM: metrics.seams.map((s) => s.seamDistanceM),
    maxConsecutiveGapM: CRB.maxConsecutiveTrajectoryGapM(trajectory),
    trajectoryChecksum: checksumTrajectory(trajectory),
    roadInputChecksum: map.roadSurfaceChecksum ?? null,
    mapChecksum: map.checksum ?? null,
    perSourceSignedTurn: seg2Points.length >= 3
      ? dominantTurnSign(signedTurnSequence(seg2Points))
      : null,
    sourceQlogSha256: map.sourceQlogSha256 ?? null,
    mapWideCorrectionActive: VDC.isExactDisplayCorrectionActive(true, map.sourceQlogSha256),
  };
}

module.exports = {
  CANDIDATE_QUERY_PARAM,
  CANDIDATE_BOUNDARY_ANCHORED,
  CANDIDATE_A_DIAGNOSTIC,
  BASELINE_SEAM_TOLERANCE_M,
  BASELINE_TANGENT_TOLERANCE_DEG,
  MAX_FIT_RESIDUAL_M,
  parseCombinedOrientationCandidate,
  buildSourceSha256Lookup,
  annotateTrajectorySources,
  withAnnotatedTrajectory,
  uniqueSourceFiles,
  isMultiSourceMap,
  splitTrajectoryBySource,
  measureBoundaryMetrics,
  simulateCandidateBPostPlacementReflection,
  evaluateCandidateADisplay,
  applyBoundaryAnchoredOrientation,
  buildRejectedCandidateBReport,
  buildContinuousBaselineReport,
  buildSourceTransformRegistry,
  signedTurnSequence,
  dominantTurnSign,
  solveRigidFromTwoAnchors,
  solveRigidLeastSquares,
  boundaryCrossingsAreBridged,
  trajectoryIsContinuous,
  maxConsecutiveTrajectoryGapM,
  seamWorseThanBaseline,
};
