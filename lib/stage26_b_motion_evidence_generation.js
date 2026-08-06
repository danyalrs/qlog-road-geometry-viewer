'use strict';

const fs = require('fs');
const path = require('path');
const { processRoute, buildTimeline } = require('./process_route');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const {
  serializePlaybackFrame,
  resolvePairTargetMapping,
  formatPairIdentity,
  buildDrawPlan,
  parseObservationEndpoint,
} = require('./stage20_b_motion_review_playback');
const { anchorPointOnLane } = require('./stage22_b_motion_shadow_evaluation');
const { ANCHOR_MODEL_X_M } = require('./stage23_b_motion_vector_residual');

const segmentCache = new Map();

function findNearestFrameIndex(timeline, logMonoTime) {
  if (!timeline?.length || logMonoTime == null) return null;
  const target = BigInt(logMonoTime);
  let best = 0;
  let bestDiff = null;
  for (let i = 0; i < timeline.length; i++) {
    const t = BigInt(timeline[i].logMonoTime);
    const diff = t > target ? t - target : target - t;
    if (bestDiff == null || diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

function processQlogSegment(root, qlogReference) {
  const cacheKey = `${root}|${qlogReference}`;
  if (segmentCache.has(cacheKey)) return segmentCache.get(cacheKey);
  const filePath = path.join(root, qlogReference);
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: 'qlog_not_in_workspace', qlogReference };
  }
  try {
    const modelEvents = extractModel(filePath).map((e) => ({ ...e, sourceFile: qlogReference }));
    const gpsEvents = extractGps(filePath).map((e) => ({ ...e, sourceFile: qlogReference }));
    const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
    const timeline = buildTimeline(result.frames);
    const payload = {
      ok: true,
      qlogReference,
      frameCount: result.frames?.length || 0,
      timeline: (timeline || []).map((f, i) => ({
        index: i,
        logMonoTime: String(f.logMonoTime),
        chunkId: f.chunkId,
        passId: f.passId ?? f.temporalPassId,
      })),
      frames: (result.frames || []).map((f, i) => {
        const serialized = serializePlaybackFrame(f, i);
        if (f.pose) {
          serialized.pose = {
            east: f.pose.east,
            north: f.pose.north,
            headingDeg: f.pose.headingDeg,
            speed: f.pose.speed,
          };
        }
        return serialized;
      }),
    };
    segmentCache.set(cacheKey, payload);
    return payload;
  } catch (err) {
    return { ok: false, reason: 'qlog_processing_failed', qlogReference, error: err.message };
  }
}

function generateEvidencePackage(root, manifestRecord, runtimeDiag) {
  const ve = manifestRecord.visualEvidence || {};
  const frameA = ve.frameA || {};
  const frameB = ve.frameB || {};
  const qlogReference = frameA.qlogReference || (manifestRecord.segmentId != null ? `qlog_f449c_${manifestRecord.segmentId}.bz2` : null);
  const issues = [];

  if (!qlogReference) issues.push('missing_qlog_reference');
  const pair = {
    reviewPairId: manifestRecord.reviewPairId,
    observationIdA: frameA.observationId,
    observationIdB: frameB.observationId,
    segmentId: manifestRecord.segmentId,
    logMonoTimeA: frameA.logMonoTime,
    logMonoTimeB: frameB.logMonoTime,
  };

  const parsedA = parseObservationEndpoint(frameA.observationId);
  const parsedB = parseObservationEndpoint(frameB.observationId);
  if (!parsedA || !parsedB) issues.push('observation_id_unparseable');
  if (parsedA && parsedB && BigInt(parsedB.logMonoTime) <= BigInt(parsedA.logMonoTime)) {
    issues.push('frame_b_not_later_than_frame_a');
  }

  const qlog = qlogReference ? processQlogSegment(root, qlogReference) : { ok: false, reason: 'missing_qlog_reference' };
  if (!qlog.ok) {
    return {
      ok: false,
      evidenceAvailable: false,
      issues: [...issues, qlog.reason || 'qlog_load_failed'],
      qlogReference,
      pair,
    };
  }

  const idxA = findNearestFrameIndex(qlog.timeline, frameA.logMonoTime);
  const idxB = findNearestFrameIndex(qlog.timeline, frameB.logMonoTime);
  if (idxA == null || idxB == null) issues.push('frame_timestamps_not_found');

  const payload = {
    frames: qlog.frames,
    suggestedFrameIndexA: idxA,
    suggestedFrameIndexB: idxB,
  };
  const mapping = resolvePairTargetMapping(pair, payload);
  if (!mapping.ok) issues.push(...mapping.issues.map((i) => i.error));

  const frameDataA = qlog.frames[idxA];
  const frameDataB = qlog.frames[idxB];
  const drawA = frameDataA ? buildDrawPlan(frameDataA, 640, 480, { targetLaneIndex: parsedA?.sourceSlotIndex }) : null;
  const drawB = frameDataB ? buildDrawPlan(frameDataB, 640, 480, { targetLaneIndex: parsedB?.sourceSlotIndex }) : null;

  const laneA = frameDataA?.laneLines?.find((l) => l.laneIndex === parsedA?.sourceSlotIndex);
  const laneB = frameDataB?.laneLines?.find((l) => l.laneIndex === parsedB?.sourceSlotIndex);
  const anchorA = laneA ? anchorPointOnLane({ laneIndex: laneA.laneIndex, points: laneA.points }) : { available: false };
  const anchorB = laneB ? anchorPointOnLane({ laneIndex: laneB.laneIndex, points: laneB.points }) : { available: false };

  const poseA = frameDataA?.pose;
  const poseB = frameDataB?.pose;
  const vectors = runtimeDiag ? {
    targetDisplacementEastM: runtimeDiag.targetDisplacementEastM,
    targetDisplacementNorthM: runtimeDiag.targetDisplacementNorthM,
    poseDisplacementEastM: runtimeDiag.poseDisplacementEastM,
    poseDisplacementNorthM: runtimeDiag.poseDisplacementNorthM,
    compensatedEastM: runtimeDiag.compensatedEastM,
    compensatedNorthM: runtimeDiag.compensatedNorthM,
    legacyScalarResidualM: runtimeDiag.legacyScalarResidualM,
    vectorResidualM: runtimeDiag.vectorResidualM,
    legacyDecision: runtimeDiag.authoritativeLegacyDecision,
    vectorDecision: runtimeDiag.vectorShadowDecision,
  } : null;

  const ok = issues.length === 0 && mapping.ok && drawA?.hasDrawable && drawB?.hasDrawable;

  return {
    ok,
    evidenceAvailable: ok,
    issues,
    qlogReference,
    pair,
    frameCorrespondence: {
      segmentId: manifestRecord.segmentId,
      logMonoTimeA: frameA.logMonoTime,
      logMonoTimeB: frameB.logMonoTime,
      observationIdA: frameA.observationId,
      observationIdB: frameB.observationId,
      sourceSlotIndexA: parsedA?.sourceSlotIndex ?? null,
      sourceSlotIndexB: parsedB?.sourceSlotIndex ?? null,
      frameIndexA: idxA,
      frameIndexB: idxB,
      frameBIsLater: parsedA && parsedB ? BigInt(parsedB.logMonoTime) > BigInt(parsedA.logMonoTime) : null,
      nearestFrameLogMonoTimeA: frameDataA?.logMonoTime ?? null,
      nearestFrameLogMonoTimeB: frameDataB?.logMonoTime ?? null,
    },
    visualization: {
      frameA: {
        drawPlan: drawA,
        anchor: anchorA.available ? { east: anchorA.east, north: anchorA.north, modelXM: ANCHOR_MODEL_X_M } : null,
        targetLaneIndex: parsedA?.sourceSlotIndex,
        sourceSlotIndexMetadataOnly: true,
      },
      frameB: {
        drawPlan: drawB,
        anchor: anchorB.available ? { east: anchorB.east, north: anchorB.north, modelXM: ANCHOR_MODEL_X_M } : null,
        targetLaneIndex: parsedB?.sourceSlotIndex,
        sourceSlotIndexMetadataOnly: true,
      },
      roadEdgesSeparateLayer: true,
      identityDisclaimer: 'sourceSlotIndex is metadata only; do not infer physical divider identity from array index',
    },
    vectors,
    mapping,
  };
}

function clearSegmentCache() {
  segmentCache.clear();
}

module.exports = {
  ANCHOR_MODEL_X_M,
  findNearestFrameIndex,
  processQlogSegment,
  generateEvidencePackage,
  clearSegmentCache,
};
