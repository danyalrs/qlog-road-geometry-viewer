/**
 * Multi-factor assessment for spatial-revisit and self-intersection pass splits.
 * Distinguishes genuine movement revisits/crossings from sparse GPS chord artifacts.
 */
const { dist2d, timeGapSec } = require('./chunking');
const { normalizeDeg } = require('./alignment');

function bearingDeg(a, b) {
  const de = b.east - a.east;
  const dn = b.north - a.north;
  if (Math.hypot(de, dn) < 1e-6) return 0;
  return (Math.atan2(de, dn) * 180) / Math.PI;
}

function bearingDelta(a, b) {
  const ba = normalizeDeg(a ?? 0);
  const bb = normalizeDeg(b ?? 0);
  let d = Math.abs(bb - ba);
  if (d > 180) d = 360 - d;
  return d;
}

function alongTrackDistance(points, fromIdx, toIdx) {
  if (!points?.length || fromIdx < 0 || toIdx <= fromIdx) return 0;
  let d = 0;
  for (let k = fromIdx + 1; k <= toIdx; k++) {
    d += dist2d(points[k - 1], points[k]);
  }
  return d;
}

function localTangentBearing(points, index) {
  if (!points?.length) return 0;
  if (index <= 0) return bearingDeg(points[0], points[1] ?? points[0]);
  if (index >= points.length - 1) {
    return bearingDeg(points[index - 1], points[index]);
  }
  return bearingDeg(points[index - 1], points[index + 1]);
}

function acuteCrossingAngleDeg(bearingA, bearingB) {
  const d = bearingDelta(bearingA, bearingB);
  return d > 90 ? 180 - d : d;
}

function integratedHeadingChangeDeg(points, fromIdx, toIdx) {
  let total = 0;
  const end = Math.min(toIdx, points.length - 1);
  for (let k = fromIdx + 1; k <= end; k++) {
    total += bearingDelta(points[k - 1].headingDeg, points[k].headingDeg);
  }
  return total;
}

/**
 * Assess whether a self-intersection between new segment (prev→cur) and earlier chord is genuine.
 */
function assessSelfIntersectionCrossing(prev, cur, b1, b2, pathPoints, hitIndex, options = {}) {
  const alongTrackFromHitToEndM = alongTrackDistance(pathPoints, hitIndex, pathPoints.length - 1);
  const newSegBearing = bearingDeg(prev, cur);
  const oldSegBearing = bearingDeg(b1, b2);
  const crossingAngleDeg = acuteCrossingAngleDeg(newSegBearing, oldSegBearing);

  const headingAtPrev = prev.headingDeg ?? bearingDeg(pathPoints[pathPoints.length - 2] ?? prev, prev);
  const headingAtCur = cur.headingDeg ?? newSegBearing;
  const headingContinuityDeg = bearingDelta(headingAtPrev, headingAtCur);

  const tangentAtHitDeg = localTangentBearing(pathPoints, hitIndex);
  const approachBearingDeg = newSegBearing;
  const tangentDisagreementDeg = bearingDelta(tangentAtHitDeg, approachBearingDeg);

  const minAlongTrackSepM = options.selfIntersectionMinAlongTrackSepM ?? 45;
  const minCrossingAngleDeg = options.selfIntersectionMinCrossingAngleDeg ?? 35;
  const maxHeadingContinuityForChordDeg = options.selfIntersectionMaxHeadingContinuityForChordDeg ?? 45;
  const maxTangentDisagreementForChordDeg = options.selfIntersectionMaxTangentDisagreementForChordDeg ?? 60;
  const maxSegTangentAlignForChordDeg = options.selfIntersectionMaxSegTangentAlignForChordDeg ?? 30;

  const oldSegAlignDeg = bearingDelta(oldSegBearing, localTangentBearing(pathPoints, hitIndex));
  const newSegAlignDeg = bearingDelta(newSegBearing, headingAtCur);
  const bothSegmentsForwardAligned = oldSegAlignDeg < maxSegTangentAlignForChordDeg
    && newSegAlignDeg < maxSegTangentAlignForChordDeg;

  const isCurveChord = alongTrackFromHitToEndM >= minAlongTrackSepM && (
    (bothSegmentsForwardAligned && headingContinuityDeg < maxHeadingContinuityForChordDeg)
    || (crossingAngleDeg < minCrossingAngleDeg
      && headingContinuityDeg < maxHeadingContinuityForChordDeg
      && tangentDisagreementDeg < maxTangentDisagreementForChordDeg)
  );

  const isGenuineCrossing = crossingAngleDeg >= minCrossingAngleDeg && !isCurveChord;

  return {
    alongTrackFromHitToEndM,
    crossingAngleDeg,
    headingContinuityDeg,
    tangentDisagreementDeg,
    oldSegAlignDeg,
    newSegAlignDeg,
    bothSegmentsForwardAligned,
    tangentAtHitDeg,
    approachBearingDeg,
    isGenuineCrossing,
    isCurveChord,
    verdict: isGenuineCrossing ? 'genuineCrossing' : (isCurveChord ? 'curveChordArtifact' : 'ambiguous'),
  };
}

/**
 * Assess whether a spatial revisit (current near earlier point after travel) is genuine.
 */
function assessSpatialRevisit(earlier, current, pathPoints, revisitIndex, travelSinceM, revisitDistM, options = {}) {
  const timeSepSec = timeGapSec(earlier, current);
  const travelToEuclid = revisitDistM > 0.01 ? travelSinceM / revisitDistM : Infinity;

  const headingDeltaDeg = bearingDelta(earlier.headingDeg, current.headingDeg);
  const earlierTangentDeg = localTangentBearing(pathPoints, revisitIndex);
  const returnBearingDeg = bearingDeg(earlier, current);
  const approachBearingDeg = pathPoints.length >= 2
    ? bearingDeg(pathPoints[pathPoints.length - 1], current)
    : returnBearingDeg;

  const tangentAlignmentDeg = bearingDelta(earlierTangentDeg, returnBearingDeg);
  const approachVsEarlierHeadingDeg = bearingDelta(earlier.headingDeg ?? earlierTangentDeg, approachBearingDeg);
  const pathHeadingAccumDeg = integratedHeadingChangeDeg(pathPoints, revisitIndex, pathPoints.length - 1)
    + bearingDelta(pathPoints[pathPoints.length - 1].headingDeg, current.headingDeg);

  const ratioMax = options.spatialRevisitMaxTravelToEuclideanRatio ?? 50;
  const minHeadingDeltaForGenuineDeg = options.spatialRevisitMinHeadingDeltaForGenuineDeg ?? 60;
  const minTangentMisalignmentForGenuineDeg = options.spatialRevisitMinTangentMisalignmentForGenuineDeg ?? 90;
  const maxTimeSepForLoopSec = options.spatialRevisitMaxTimeSepForLoopSec ?? 600;
  const minLoopHeadingAccumDeg = options.spatialRevisitMinLoopHeadingAccumDeg ?? 150;

  const oppositeDirectionReturn = headingDeltaDeg >= 120;
  const sameRoadReturn = headingDeltaDeg >= minHeadingDeltaForGenuineDeg
    && tangentAlignmentDeg >= minTangentMisalignmentForGenuineDeg;
  const compactLoopClosure = travelToEuclid <= ratioMax
    && headingDeltaDeg >= 45
    && timeSepSec <= maxTimeSepForLoopSec;
  const moderateRatioWithHeadingChange = travelToEuclid <= ratioMax
    && headingDeltaDeg >= minHeadingDeltaForGenuineDeg;
  const loopClosure = revisitDistM < (options.revisitDistM ?? 8)
    && travelSinceM >= (options.revisitMinTravelM ?? 25)
    && pathHeadingAccumDeg >= minLoopHeadingAccumDeg
    && (tangentAlignmentDeg >= 55 || headingDeltaDeg <= 30)
    && (revisitDistM < 1 || travelToEuclid <= ratioMax * 2);
  const exactLoopClosure = revisitDistM < 1
    && travelSinceM >= (options.revisitMinTravelM ?? 25)
    && pathHeadingAccumDeg >= minLoopHeadingAccumDeg
    && headingDeltaDeg <= 30;

  const isGenuineRevisitCandidate = oppositeDirectionReturn
    || sameRoadReturn
    || compactLoopClosure
    || moderateRatioWithHeadingChange
    || loopClosure
    || exactLoopClosure;

  const isCurveArtifact = (travelToEuclid > ratioMax
      && headingDeltaDeg < minHeadingDeltaForGenuineDeg
      && tangentAlignmentDeg < 70
      && approachVsEarlierHeadingDeg < 90
      && pathHeadingAccumDeg < minLoopHeadingAccumDeg)
    || (travelToEuclid > ratioMax
      && tangentAlignmentDeg < 45
      && approachVsEarlierHeadingDeg >= 90
      && headingDeltaDeg < 120)
    || (travelToEuclid > ratioMax * 2
      && tangentAlignmentDeg < 70
      && pathHeadingAccumDeg >= minLoopHeadingAccumDeg
      && headingDeltaDeg > 45
      && headingDeltaDeg < 120);

  const isGenuineRevisit = isGenuineRevisitCandidate && !isCurveArtifact;

  return {
    travelSinceM,
    revisitDistM,
    travelToEuclid,
    timeSepSec,
    headingDeltaDeg,
    tangentAlignmentDeg,
    approachVsEarlierHeadingDeg,
    pathHeadingAccumDeg,
    earlierTangentDeg,
    returnBearingDeg,
    approachBearingDeg,
    isGenuineRevisit,
    isCurveArtifact,
    verdict: isGenuineRevisit ? 'genuineRevisit' : (isCurveArtifact ? 'curveChordArtifact' : 'ambiguous'),
  };
}

module.exports = {
  localTangentBearing,
  acuteCrossingAngleDeg,
  integratedHeadingChangeDeg,
  assessSelfIntersectionCrossing,
  assessSpatialRevisit,
};
