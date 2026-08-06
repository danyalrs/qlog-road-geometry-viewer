/**
 * Monotonic trajectory pass detection — split loops, reversals and revisits.
 */

const { dist2d, timeGapSec } = require('./chunking');
const { normalizeDeg } = require('./alignment');
const { annotatePathWithMovement, allowsReversalSplit } = require('./movement_state');
const {
  assessSelfIntersectionCrossing,
  assessSpatialRevisit,
} = require('./pass_revisit_assess');

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

function segmentDirection(a, b) {
  const len = dist2d(a, b);
  if (len < 1e-6) return { de: 0, dn: 0, len: 0 };
  return { de: (b.east - a.east) / len, dn: (b.north - a.north) / len, len };
}

function countSelfIntersections(points, minSep = 3) {
  let count = 0;
  const events = [];
  for (let i = 1; i < points.length; i++) {
    const a1 = points[i - 1];
    const a2 = points[i];
    for (let j = i + minSep; j < points.length; j++) {
      const b1 = points[j - 1];
      const b2 = points[j];
      if (segmentsIntersect(a1, a2, b1, b2)) {
        count++;
        events.push({ segA: i - 1, segB: j - 1 });
      }
    }
  }
  return { count, events };
}

function segmentsIntersect(a1, a2, b1, b2) {
  const cross = (o, a, b) => (a.east - o.east) * (b.north - o.north) - (a.north - o.north) * (b.east - o.east);
  const d1 = cross(a1, a2, b1);
  const d2 = cross(a1, a2, b2);
  const d3 = cross(b1, b2, a1);
  const d4 = cross(b1, b2, a2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function minNonAdjacentDistance(points, minIndexSep = 3) {
  let min = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + minIndexSep; j < points.length; j++) {
      min = Math.min(min, dist2d(points[i], points[j]));
    }
  }
  return min === Infinity ? 0 : min;
}

function alongTrackDistance(points, fromIdx, toIdx) {
  if (!points?.length || fromIdx < 0 || toIdx <= fromIdx) return 0;
  let d = 0;
  for (let k = fromIdx + 1; k <= toIdx; k++) {
    d += dist2d(points[k - 1], points[k]);
  }
  return d;
}

function segmentIntersectsPath(a1, a2, points, minIndexSep = 2, options = {}) {
  for (let j = 1; j < points.length - minIndexSep; j++) {
    const b1 = points[j - 1];
    const b2 = points[j];
    if (segmentsIntersect(a1, a2, b1, b2)) {
      const assessment = assessSelfIntersectionCrossing(
        a1, a2, b1, b2, points, j - 1, options
      );
      if (assessment.isGenuineCrossing) {
        return { intersects: true, segB: j - 1, assessment };
      }
      if (assessment.isCurveChord) {
        return {
          intersects: false,
          suppressed: true,
          reason: 'chordSelfIntersection',
          segB: j - 1,
          assessment,
          alongTrackFromHitToEndM: assessment.alongTrackFromHitToEndM,
        };
      }
      return { intersects: true, segB: j - 1, assessment };
    }
  }
  return { intersects: false };
}

function detectPasses(vehiclePath, options = {}) {
  const reversalDot = options.reversalDotThreshold ?? -0.3;
  const sharpTurnDeg = options.sharpTurnDeg ?? 90;
  const sharpTurnDistM = options.sharpTurnDistM ?? 15;
  const sharpTurnMinStepM = options.sharpTurnMinStepM ?? 2.0;
  const revisitDistM = options.revisitDistM ?? 8;
  const revisitMinSep = options.revisitMinSep ?? 5;
  const revisitMinTravelM = options.revisitMinTravelM ?? 25;
  const sToleranceM = options.sToleranceM ?? 2;
  const suspiciousLoopEndDistM = options.suspiciousLoopEndDistM ?? 25;
  const minPassPoints = options.minPassPoints ?? 2;
  const minDisplacementForReversalM = options.minDisplacementForReversalM ?? 5.0;
  const spatialRevisitMaxTravelToEuclideanRatio = options.spatialRevisitMaxTravelToEuclideanRatio ?? 50;

  if (!vehiclePath?.length) return { passes: [], diagnostics: {} };

  const annotatedPath = annotatePathWithMovement(vehiclePath, options.movementState || options);

  const passes = [];
  let current = [];
  let passId = 0;
  let localS = 0;
  const splitEvents = [];
  const suppressedSplitEvents = [];

  const pushPoint = (pt, meta) => {
    current.push({
      ...pt,
      passId,
      temporalIndex: current.length,
      localAlongTrackS: localS,
      ...meta,
    });
  };

  for (let i = 0; i < annotatedPath.length; i++) {
    const pt = { ...annotatedPath[i] };
    let split = null;

    if (current.length) {
      const prev = current[current.length - 1];
      const step = dist2d(prev, pt);
      const dir = segmentDirection(prev, pt);
      const prevDir = current.length >= 2
        ? segmentDirection(current[current.length - 2], prev)
        : dir;

      const dot = prevDir.de * dir.de + prevDir.dn * dir.dn;
      const hd = bearingDelta(bearingDeg(prev, pt), prev.headingDeg ?? bearingDeg(prev, pt));
      const tg = timeGapSec(prev, pt);
      const movementState = pt.movementState ?? 'uncertain';

      if (step > 0.5 && dot < reversalDot && allowsReversalSplit(pt, prev, { ...options, minDisplacementForReversalM })) {
        split = { reason: 'directionReversal', dot, i, movementState };
      } else if (step > 0.5 && dot < reversalDot) {
        suppressedSplitEvents.push({
          reason: 'suppressedDirectionReversal',
          wouldBeReason: 'directionReversal',
          dot,
          i,
          movementState,
          step,
          frameId: pt.frameId,
          logMonoTime: pt.logMonoTime,
        });
      } else if (step >= sharpTurnMinStepM && step < sharpTurnDistM && hd > sharpTurnDeg && movementState === 'moving') {
        split = { reason: 'sharpHeadingChange', headingDelta: hd, dist: step, i };
      } else if (localS + step < localS - sToleranceM) {
        split = { reason: 'sDecreases', i };
      }

      if (!split && step > 0.3 && movementState === 'moving') {
        const ix = segmentIntersectsPath(prev, pt, current, 3, options);
        if (ix.intersects) {
          split = { reason: 'selfIntersection', segB: ix.segB, i };
        } else if (ix.suppressed) {
          suppressedSplitEvents.push({
            reason: 'suppressedChordSelfIntersection',
            wouldBeReason: 'selfIntersection',
            segB: ix.segB,
            alongTrackFromHitToEndM: ix.assessment?.alongTrackFromHitToEndM,
            crossingAngleDeg: ix.assessment?.crossingAngleDeg,
            headingContinuityDeg: ix.assessment?.headingContinuityDeg,
            tangentDisagreementDeg: ix.assessment?.tangentDisagreementDeg,
            oldSegAlignDeg: ix.assessment?.oldSegAlignDeg,
            newSegAlignDeg: ix.assessment?.newSegAlignDeg,
            bothSegmentsForwardAligned: ix.assessment?.bothSegmentsForwardAligned,
            i,
            movementState,
            frameId: pt.frameId,
            logMonoTime: pt.logMonoTime,
          });
        }
      }

      if (!split && current.length >= revisitMinSep && step > 0.3 && movementState === 'moving') {
        for (let j = 0; j < current.length - revisitMinSep; j++) {
          const revisitDist = dist2d(current[j], pt);
          if (revisitDist < revisitDistM) {
            let travelSince = 0;
            for (let k = j + 1; k < current.length; k++) travelSince += dist2d(current[k - 1], current[k]);
            travelSince += step;
            if (travelSince >= revisitMinTravelM) {
              const assessment = assessSpatialRevisit(
                current[j], pt, current, j, travelSince, revisitDist, options
              );
              if (assessment.isGenuineRevisit) {
                split = {
                  reason: 'spatialRevisit',
                  dist: revisitDist,
                  revisitIndex: j,
                  travelSince,
                  travelToEuclid: assessment.travelToEuclid,
                  headingDeltaDeg: assessment.headingDeltaDeg,
                  timeSepSec: assessment.timeSepSec,
                  i,
                };
                break;
              }
              if (assessment.isCurveArtifact) {
                suppressedSplitEvents.push({
                  reason: 'suppressedCurveSpatialRevisit',
                  wouldBeReason: 'spatialRevisit',
                  revisitIndex: j,
                  dist: revisitDist,
                  travelSince,
                  travelToEuclid: assessment.travelToEuclid,
                  headingDeltaDeg: assessment.headingDeltaDeg,
                  tangentAlignmentDeg: assessment.tangentAlignmentDeg,
                  pathHeadingAccumDeg: assessment.pathHeadingAccumDeg,
                  timeSepSec: assessment.timeSepSec,
                  i,
                  movementState,
                  frameId: pt.frameId,
                  logMonoTime: pt.logMonoTime,
                });
              }
            }
          }
        }
      }

      if (!split && BigInt(pt.logMonoTime) < BigInt(prev.logMonoTime)) {
        split = { reason: 'backwardTime', i };
      }

      if (split) {
        splitEvents.push({ passId, ...split, frameId: pt.frameId, logMonoTime: pt.logMonoTime });
        if (current.length >= minPassPoints) {
          passes.push(finalizePass(passId, current, options));
        }
        passId++;
        current = [];
        localS = 0;
      }

      localS += step;
    }

    pushPoint(pt, { headingDelta: i > 0 ? bearingDelta(bearingDeg(annotatedPath[i - 1], pt), annotatedPath[i - 1].headingDeg) : 0 });
  }

  if (current.length >= 1) {
    passes.push(finalizePass(passId, current, options));
  }

  const allPoints = passes.flatMap((p) => p.points);
  const startEnd = passes.length === 1 && allPoints.length >= 2
    ? dist2d(allPoints[0], allPoints[allPoints.length - 1])
    : null;

  const diagnostics = {
    passCount: passes.length,
    splitEvents,
    suppressedSplitEvents,
    suppressedReversalCount: suppressedSplitEvents.length,
    suppressedStationarySplits: suppressedSplitEvents.filter((e) => e.reason === 'suppressedDirectionReversal').length,
    directionReversals: splitEvents.filter((e) => e.reason === 'directionReversal').length,
    selfIntersectionSplits: splitEvents.filter((e) => e.reason === 'selfIntersection').length,
    selfIntersections: passes.reduce((n, p) => n + (p.selfIntersections?.count ?? 0), 0),
    minNonAdjacentDistM: passes.length ? Math.min(...passes.map((p) => p.minNonAdjacentDistM ?? Infinity)) : 0,
    suspiciousLoop: startEnd != null && startEnd < suspiciousLoopEndDistM && (passes[0]?.pathLengthM ?? 0) > 50,
    startEndDisplacementM: startEnd,
  };

  return { passes, diagnostics };
}

function finalizePass(passId, points, options) {
  let pathLengthM = 0;
  for (let i = 1; i < points.length; i++) pathLengthM += dist2d(points[i - 1], points[i]);
  const selfIx = countSelfIntersections(points);
  const gpsSpeeds = points.map((p) => p.speed ?? 0).filter((s) => s > 0);
  const avgGpsSpeed = gpsSpeeds.length ? gpsSpeeds.reduce((a, b) => a + b, 0) / gpsSpeeds.length : 0;
  const impliedSpeed = pathLengthM / Math.max(
    timeGapSec(points[0], points[points.length - 1]),
    0.1
  );

  const suspiciousGps = pathLengthM > 30
    && dist2d(points[0], points[points.length - 1]) < (options.suspiciousLoopEndDistM ?? 25)
    && impliedSpeed > 0
    && avgGpsSpeed > 0
    && Math.abs(impliedSpeed - avgGpsSpeed) / avgGpsSpeed > 0.5;

  return {
    passId,
    points,
    pathLengthM,
    frameCount: points.length,
    startLogMonoTime: points[0].logMonoTime,
    endLogMonoTime: points[points.length - 1].logMonoTime,
    start: { east: points[0].east, north: points[0].north },
    end: { east: points[points.length - 1].east, north: points[points.length - 1].north },
    selfIntersections: selfIx,
    minNonAdjacentDistM: minNonAdjacentDistance(points),
    suspiciousGps,
    trusted: !suspiciousGps,
  };
}

function assignFramesToPasses(frames, passes) {
  const byTime = passes.map((p) => ({
    passId: p.passId,
    t0: BigInt(p.startLogMonoTime),
    t1: BigInt(p.endLogMonoTime),
    points: p.points,
  }));

  return frames.map((frame, temporalIndex) => {
    const t = BigInt(frame.logMonoTime);
    let passId = 0;
    for (const p of byTime) {
      if (t >= p.t0 && t <= p.t1) { passId = p.passId; break; }
    }
    const pass = passes.find((p) => p.passId === passId);
    return { ...frame, passId, temporalIndex, sessionId: frame.sessionId, chunkId: frame.chunkId };
  });
}

module.exports = {
  detectPasses,
  assignFramesToPasses,
  countSelfIntersections,
  segmentIntersectsPath,
  alongTrackDistance,
  minNonAdjacentDistance,
  bearingDeg,
  bearingDelta,
  segmentsIntersect,
};
