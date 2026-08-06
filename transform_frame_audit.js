#!/usr/bin/env node
/**
 * Transform and frame-pair audit for temporal-pass split investigation.
 * Usage: node transform_frame_audit.js <segmentId|filename> [--frame <frameId>] [--reason selfIntersection|spatialRevisit]
 */
const fs = require('fs');
const path = require('path');
const { loadSegmentsData } = require('./lib/qlog_data');
const { processRoute } = require('./lib/process_route');
const { qualifySegments } = require('./lib/segment_qualify');
const { interpolateGpsAtTime, enrichGpsHeadings, bearingFromDelta, chooseHeading } = require('./lib/alignment');
const { setLocalCoords } = require('./lib/projection');
const { validateGpsRecord, createRejectionStats } = require('./lib/gps_validate');
const { annotatePathWithMovement } = require('./lib/movement_state');
const { validatePoseTransition } = require('./lib/pose_continuity');
const { detectPasses, bearingDeg, bearingDelta, segmentIntersectsPath } = require('./lib/passes');
const { dist2d, timeGapSec } = require('./lib/chunking');
const { modelToGlobal } = require('./lib/transform');

const ROOT = __dirname;
const DEFAULT_OPTS = {
  minLaneProb: 0.5,
  maxAccuracyM: 50,
  maxModelGpsDeltaNs: 2e9,
  maxForwardM: 120,
  fusionIntervalM: 2,
  minSpeedForGpsBearing: 2,
  pipelineMode: 'C',
  laneTrackingEnabled: true,
  localSupportFilter: true,
};

function segmentsIntersect(a1, a2, b1, b2) {
  const cross = (o, a, b) => (a.east - o.east) * (b.north - o.north) - (a.north - o.north) * (b.east - o.east);
  const d1 = cross(a1, a2, b1);
  const d2 = cross(a1, a2, b2);
  const d3 = cross(b1, b2, a1);
  const d4 = cross(b1, b2, a2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function findSelfIntersectionDetail(prev, cur, pathPoints, minIndexSep = 3) {
  const hits = [];
  for (let j = 1; j < pathPoints.length - minIndexSep; j++) {
    const b1 = pathPoints[j - 1];
    const b2 = pathPoints[j];
    if (segmentsIntersect(prev, cur, b1, b2)) {
      hits.push({
        earlierSegmentIndex: j - 1,
        earlierSegment: {
          from: { frameId: b1.frameId, east: b1.east, north: b1.north, logMonoTime: b1.logMonoTime },
          to: { frameId: b2.frameId, east: b2.east, north: b2.north, logMonoTime: b2.logMonoTime },
        },
        newSegment: {
          from: { frameId: prev.frameId, east: prev.east, north: prev.north, logMonoTime: prev.logMonoTime },
          to: { frameId: cur.frameId, east: cur.east, north: cur.north, logMonoTime: cur.logMonoTime },
        },
      });
    }
  }
  return hits;
}

function alongTrackDistance(points, fromIdx, toIdx, extraStep = 0) {
  let d = 0;
  for (let k = fromIdx + 1; k <= toIdx; k++) d += dist2d(points[k - 1], points[k]);
  return d + extraStep;
}

function buildGpsChain(gpsEvents, filename) {
  const rejectionStats = createRejectionStats();
  const raw = gpsEvents.filter((e) => e.sourceFile === filename)
    .sort((a, b) => (BigInt(a.logMonoTime) < BigInt(b.logMonoTime) ? -1 : 1));
  const preValid = [];
  for (const g of raw) {
    if (validateGpsRecord(g, { maxAccuracyM: 50, maxJumpM: Infinity }, null, rejectionStats)) preValid.push({ ...g });
  }
  const origin = { lat: preValid[0].latitude, lon: preValid[0].longitude };
  setLocalCoords(preValid, origin);
  const valid = [];
  let prev = null;
  for (const g of preValid) {
    const sameFile = prev && prev.sourceFile === g.sourceFile;
    if (validateGpsRecord(g, { maxAccuracyM: 50, maxJumpM: 200 }, sameFile ? prev : null, rejectionStats)) {
      valid.push({ ...g });
      prev = g;
    }
  }
  return { validGps: enrichGpsHeadings(valid, { minSpeedForGpsBearing: 2 }), origin };
}

function frameContext(frames, frameId) {
  return frames.find((f) => f.frameId === frameId) || null;
}

function auditSegment(filename, targetFrameId, expectedReason) {
  const loaded = loadSegmentsData(ROOT, [filename], DEFAULT_OPTS);
  const quals = qualifySegments(loaded.audits);
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
    ...DEFAULT_OPTS,
    segmentQualifications: quals,
    fileAudits: loaded.audits,
  });
  const chunk = result.routeChunks[0];
  const vehiclePath = annotatePathWithMovement(chunk?.vehiclePath || []);
  const { passes, diagnostics } = detectPasses(chunk?.vehiclePath || [], DEFAULT_OPTS);
  const split = (diagnostics.splitEvents || []).find((e) => e.frameId === targetFrameId)
    || diagnostics.splitEvents?.[0];

  const idx = vehiclePath.findIndex((p) => p.frameId === targetFrameId);
  const prev = idx > 0 ? vehiclePath[idx - 1] : null;
  const cur = idx >= 0 ? vehiclePath[idx] : null;

  const { validGps, origin } = buildGpsChain(loaded.gpsEvents, filename);
  const gpsAtModel = cur ? interpolateGpsAtTime(validGps, cur.logMonoTime, DEFAULT_OPTS.maxModelGpsDeltaNs) : null;
  const gpsAtPrev = prev ? interpolateGpsAtTime(validGps, prev.logMonoTime, DEFAULT_OPTS.maxModelGpsDeltaNs) : null;

  const poseCheck = prev && cur ? validatePoseTransition(prev, cur, {}) : null;
  const step = prev && cur ? dist2d(prev, cur) : null;
  const dt = prev && cur ? timeGapSec(prev, cur) : null;
  const implied = step != null && dt ? step / Math.max(dt, 0.001) : null;
  const de = prev && cur ? cur.east - prev.east : 0;
  const dn = prev && cur ? cur.north - prev.north : 0;
  const motionBearing = bearingFromDelta(de, dn);
  const motionDisagreement = motionBearing != null && cur
    ? bearingDelta(motionBearing, cur.headingDeg ?? motionBearing)
    : null;

  const pathBeforeSplit = idx > 0 ? vehiclePath.slice(0, idx) : [];
  const intersectionHits = prev && cur ? findSelfIntersectionDetail(prev, cur, pathBeforeSplit, 3) : [];

  let revisitDetail = null;
  if (split?.reason === 'spatialRevisit' && cur) {
    const j = split.revisitIndex;
    const earlier = pathBeforeSplit[j];
    const travelSince = alongTrackDistance(vehiclePath, j, idx - 1, step);
    revisitDetail = {
      revisitIndex: j,
      earlierPoint: earlier ? {
        frameId: earlier.frameId,
        logMonoTime: earlier.logMonoTime,
        east: earlier.east,
        north: earlier.north,
        movementState: earlier.movementState,
        headingDeg: earlier.headingDeg,
        speed: earlier.speed,
      } : null,
      currentPoint: {
        frameId: cur.frameId,
        logMonoTime: cur.logMonoTime,
        east: cur.east,
        north: cur.north,
        movementState: cur.movementState,
        headingDeg: cur.headingDeg,
        speed: cur.speed,
      },
      euclideanSeparationM: earlier ? dist2d(earlier, cur) : null,
      alongTrajectoryTravelM: travelSince,
      timeSeparationSec: earlier ? timeGapSec(earlier, cur) : null,
      earlierMotionBearing: earlier && cur ? bearingDeg(earlier, cur) : null,
      earlierHeadingDelta: earlier && cur ? bearingDelta(earlier.headingDeg, bearingDeg(earlier, cur)) : null,
    };
  }

  const curFrame = cur ? frameContext(chunk.frames, cur.frameId) : null;
  const prevFrame = prev ? frameContext(chunk.frames, prev.frameId) : null;

  const transformChain = {
    coordinateAxes: { x: 'forward (m)', y: 'left (m)', z: 'up (m)' },
    yawConvention: 'bearing θ clockwise from north (degrees)',
    rotationFormula: {
      east: 'vehicleEast + x*sin(θ) - y*cos(θ)',
      north: 'vehicleNorth + x*cos(θ) + y*sin(θ)',
    },
    translationOrigin: origin,
    headingFallbackOrder: ['gps bearing when speed>=2 & accuracy ok', 'motion bearing', 'gps_fallback', 'default 0'],
    behindVehiclePolicy: 'model points with x < -5 m excluded from transformXyztLine',
    modelPoseAlignment: 'interpolateGpsAtTime(model.logMonoTime) with maxModelGpsDeltaNs=2e9',
  };

  const classification = classifySplit({
    split,
    intersectionHits,
    revisitDetail,
    step,
    implied,
    poseCheck,
    vehiclePath,
    idx,
  });

  return {
    segment: filename,
    segmentId: parseInt(filename.match(/_(\d+)/)[1], 10),
    processingVersion: require('./lib/version').PROCESSING_VERSION,
    targetFrameId,
    expectedReason,
    splitEvent: split,
    passDiagnostics: diagnostics,
    temporalPassCount: diagnostics.passCount,
    observationPair: {
      previous: prev ? summarizePoint(prev, prevFrame, gpsAtPrev) : null,
      current: cur ? summarizePoint(cur, curFrame, gpsAtModel) : null,
      displacementM: step,
      timeGapSec: dt,
      impliedSpeedMps: implied,
      poseContinuityCheck: poseCheck,
      motionDerivedBearingDeg: motionBearing,
      headingDisagreementDeg: motionDisagreement,
    },
    selfIntersection: split?.reason === 'selfIntersection' ? {
      detectPassesCondition: 'step > 0.3 && movementState === moving && segmentIntersectsPath(prev, cur, currentPass, minIndexSep=3)',
      intersectionCount: intersectionHits.length,
      intersectingSegments: intersectionHits,
      pathPointCountBeforeSplit: pathBeforeSplit.length,
    } : null,
    spatialRevisit: revisitDetail,
    transformedTrajectorySample: vehiclePath.map((p) => ({
      frameId: p.frameId,
      logMonoTime: p.logMonoTime,
      east: p.east,
      north: p.north,
      headingDeg: p.headingDeg,
      movementState: p.movementState,
    })),
    transformChain,
    poseSource: loaded.poseSourceReports?.[0],
    classification,
    whyPoseContinuityDidNotReject: explainPoseContinuity(poseCheck, split),
  };
}

function summarizePoint(pt, frame, gpsInterp) {
  return {
    frameId: pt.frameId,
    logMonoTime: pt.logMonoTime,
    modelTimestamp: frame?.logMonoTime,
    mapPosition: { east: pt.east, north: pt.north },
    headingDeg: pt.headingDeg,
    headingSource: frame?.pose?.headingSource || gpsInterp?.headingSource,
    speedMps: pt.speed,
    movementState: pt.movementState,
    gpsInterpolated: gpsInterp ? {
      logMonoTime: gpsInterp.logMonoTime,
      interpolated: gpsInterp.interpolated,
      east: gpsInterp.east,
      north: gpsInterp.north,
      headingDeg: gpsInterp.headingDeg,
      speed: gpsInterp.speed,
      modelGpsDeltaNs: frame ? Number(BigInt(frame.logMonoTime) - BigInt(gpsInterp.logMonoTime)) : null,
    } : null,
    modelPathPoints: frame?.path?.points?.length ?? 0,
    modelLaneLines: frame?.lanes?.length ?? 0,
  };
}

function explainPoseContinuity(poseCheck, split) {
  if (!poseCheck) return 'No previous observation (first path point).';
  if (poseCheck.ok) {
    return `Transition passed pose continuity (step=${poseCheck.step?.toFixed(2)}m, dt=${poseCheck.dt?.toFixed(2)}s, implied=${poseCheck.impliedSpeed?.toFixed(2)}m/s). Split triggered by separate temporal rule: ${split?.reason}.`;
  }
  return `Pose continuity rejected later transition (${poseCheck.reason}); split at ${split?.reason} occurs on an earlier valid transition.`;
}

function classifySplit({ split, intersectionHits, revisitDetail, step, implied, poseCheck, vehiclePath, idx }) {
  if (!split) return { category: 'none', confidence: 'high' };
  if (split.reason === 'selfIntersection') {
    const sparse = vehiclePath.length <= 35;
    const chordArtifact = intersectionHits.length > 0 && step > 5 && poseCheck?.ok;
    if (chordArtifact && sparse) {
      return {
        category: 'invalid_pass_detection_rule',
        subcategory: 'gps_chord_self_intersection_on_curve',
        confidence: 'high',
        rationale: 'GPS-interpolated vehicle positions at ~0.5 Hz form chord segments that cross on a forward curve; pose continuity valid; not model-path or transform error.',
      };
    }
    return { category: 'investigate', confidence: 'medium' };
  }
  if (split.reason === 'spatialRevisit') {
    const rev = revisitDetail;
    if (rev && rev.euclideanSeparationM < 8 && rev.alongTrajectoryTravelM > 100) {
      return {
        category: 'invalid_pass_detection_rule',
        subcategory: 'sparse_sampling_false_revisit',
        confidence: 'high',
        rationale: `Euclidean revisit ${rev.euclideanSeparationM?.toFixed(1)}m after ${rev.alongTrajectoryTravelM?.toFixed(0)}m travel on ${vehiclePath.length}-point path; vehicle did not physically return.`,
      };
    }
    return { category: 'genuine_physical_revisit', confidence: 'low' };
  }
  return { category: 'other', confidence: 'low' };
}

function parseArgs() {
  const args = process.argv.slice(2);
  let file = args[0] || '2';
  if (/^\d+$/.test(file)) file = `qlog_f449c_${file}.bz2`;
  let frameId = null;
  let reason = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--frame' && args[i + 1]) frameId = parseInt(args[++i], 10);
    if (args[i] === '--reason' && args[i + 1]) reason = args[++i];
  }
  if (!frameId && file.includes('_2.')) { frameId = 3123; reason = reason || 'selfIntersection'; }
  if (!frameId && file.includes('_99.')) { frameId = 119803; reason = reason || 'spatialRevisit'; }
  return { file, frameId, reason };
}

function main() {
  const { file, frameId, reason } = parseArgs();
  const report = auditSegment(file, frameId, reason);
  const out = path.join(ROOT, `audit_transform_${file.replace('.bz2', '')}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.error(`\nWrote ${out}`);
}

if (require.main === module) main();
module.exports = { auditSegment, findSelfIntersectionDetail };
