/**
 * Stage 17 — temporal divider association over Stage 16 projected observations (read-only input).
 */
const crypto = require('crypto');
const { hungarianAssign } = require('./hungarian');
const {
  ASSOCIATION_OUTCOMES,
  TRACK_BIRTH_REASONS,
  DEFAULT_ASSOCIATION_ASSESSMENT,
  ASSOCIATION_MODEL_DOCS,
  AMBIGUITY_SEMANTICS,
} = require('./stage17_tracking_schema');
const { PROJECTION_STATUSES } = require('./stage16_projection_schema');

function observationId(ob) {
  return `${ob.segmentId}:${ob.chunkId}:${ob.logMonoTime}:${ob.sourceSlotIndex}`;
}

function timeGapSec(a, b) {
  return Math.abs(Number(BigInt(b) - BigInt(a))) / 1e9;
}

function compareObservations(a, b) {
  const ta = BigInt(a.logMonoTime);
  const tb = BigInt(b.logMonoTime);
  if (ta < tb) return -1;
  if (ta > tb) return 1;
  if (a.segmentId !== b.segmentId) return a.segmentId - b.segmentId;
  return a.sourceSlotIndex - b.sourceSlotIndex;
}

function boundaryKey(ob) {
  return `${ob.chunkId}:${ob.temporalPassId}:${ob.poseSectionId}`;
}

function isEligibleObservation(ob) {
  if (ob.projectionStatus !== PROJECTION_STATUSES.PROJECTED) {
    return { eligible: false, reason: 'not_projected' };
  }
  if (ob.temporalPassId == null || ob.poseSectionId == null) {
    return { eligible: false, reason: 'missing_pass_or_section' };
  }
  if (!ob.provenance?.pipelineStage) {
    return { eligible: false, reason: 'incomplete_provenance' };
  }
  const pts = (ob.projectedRoutePoints || []).filter((p) => Number.isFinite(p.s) && Number.isFinite(p.d));
  if (pts.length < 2) return { eligible: false, reason: 'insufficient_points' };
  return { eligible: true, points: pts };
}

function sampleDProfile(points, stepM = 5) {
  if (!points.length) return [];
  const sMin = Math.min(...points.map((p) => p.s));
  const sMax = Math.max(...points.map((p) => p.s));
  const sorted = [...points].sort((a, b) => a.s - b.s);
  const samples = [];
  for (let s = sMin; s <= sMax; s += stepM) {
    let best = null;
    let bestDist = Infinity;
    for (const p of sorted) {
      const ds = Math.abs(p.s - s);
      if (ds < bestDist) { bestDist = ds; best = p; }
    }
    if (best) samples.push({ s, d: best.d });
  }
  return samples;
}

function buildObservationFeature(ob, options = {}) {
  const step = options.sampleSStepM ?? DEFAULT_ASSOCIATION_ASSESSMENT.sampleSStepM;
  const elig = isEligibleObservation(ob);
  if (!elig.eligible) return { observationId: observationId(ob), eligible: false, reason: elig.reason };
  const pts = elig.points;
  const sVals = pts.map((p) => p.s);
  const dVals = pts.map((p) => p.d);
  const profile = sampleDProfile(pts, step);
  return {
    observationId: observationId(ob),
    eligible: true,
    segmentId: ob.segmentId,
    chunkId: ob.chunkId,
    logMonoTime: ob.logMonoTime,
    sourceSlotIndex: ob.sourceSlotIndex,
    inferredSlotRole: ob.inferredSlotRole,
    temporalPassId: ob.temporalPassId,
    poseSectionId: ob.poseSectionId,
    laneLineProb: ob.laneLineProb,
    laneLineStd: ob.laneLineStd,
    headingDeg: ob.poseRecord?.headingDeg ?? null,
    sMin: Math.min(...sVals),
    sMax: Math.max(...sVals),
    sSpan: Math.max(...sVals) - Math.min(...sVals),
    meanD: dVals.reduce((a, b) => a + b, 0) / dVals.length,
    medianD: [...dVals].sort((a, b) => a - b)[Math.floor(dVals.length / 2)],
    dProfile: profile,
    pointCount: pts.length,
    sourceObservation: ob,
  };
}

function profileOverlapRmse(a, b) {
  const mapB = new Map(b.map((p) => [p.s, p.d]));
  let sum = 0;
  let n = 0;
  for (const p of a) {
    if (!mapB.has(p.s)) continue;
    const diff = p.d - mapB.get(p.s);
    sum += diff * diff;
    n++;
  }
  if (!n) return null;
  return Math.sqrt(sum / n);
}

function routeSOverlapM(a, b) {
  const lo = Math.max(a.sMin, b.sMin);
  const hi = Math.min(a.sMax, b.sMax);
  return Math.max(0, hi - lo);
}

function computeAssociationCost(trackState, feat, options = {}) {
  const o = { ...DEFAULT_ASSOCIATION_ASSESSMENT, ...options };
  const detail = {
    trackId: trackState.trackId,
    observationId: feat.observationId,
    valid: false,
    cost: Infinity,
    rejection: null,
    terms: {},
  };

  if (trackState.temporalPassId !== feat.temporalPassId || trackState.poseSectionId !== feat.poseSectionId) {
    detail.rejection = 'pass_or_section_boundary';
    return detail;
  }
  if (trackState.chunkId !== feat.chunkId) {
    detail.rejection = 'chunk_boundary_unsupported';
    return detail;
  }

  const dt = timeGapSec(trackState.lastLogMonoTime, feat.logMonoTime);
  detail.terms.timeGapSec = dt;
  if (dt > o.maxTimeGapSec) {
    detail.rejection = 'excessive_time_gap';
    return detail;
  }

  const headingA = trackState.headingDeg ?? 0;
  const headingB = feat.headingDeg ?? headingA;
  let hd = Math.abs(headingA - headingB);
  if (hd > 180) hd = 360 - hd;
  detail.terms.headingDiffDeg = hd;
  if (hd > o.maxHeadingDiffDeg) {
    detail.rejection = 'heading_mismatch';
    return detail;
  }

  const overlap = routeSOverlapM(trackState, feat);
  const sGap = Math.max(0, Math.max(feat.sMin - trackState.sMax, trackState.sMin - feat.sMax));
  detail.terms.routeSOverlapM = overlap;
  detail.terms.routeSGapM = sGap;
  if (overlap < o.minRouteSOverlapM && sGap > o.maxRouteSGapM) {
    detail.rejection = 'route_s_discontinuity';
    return detail;
  }

  const lateralJump = Math.abs(feat.meanD - trackState.meanD);
  detail.terms.lateralJumpM = lateralJump;
  if (lateralJump > o.maxLateralJumpM) {
    detail.rejection = 'lateral_jump';
    return detail;
  }

  if ((feat.laneLineProb ?? 1) < o.minConfidence) {
    detail.rejection = 'insufficient_confidence';
    return detail;
  }
  if (feat.laneLineStd != null && feat.laneLineStd > o.maxUncertaintyM) {
    detail.rejection = 'excessive_uncertainty';
    return detail;
  }

  const shapeRmse = profileOverlapRmse(trackState.dProfile, feat.dProfile);
  detail.terms.shapeRmseM = shapeRmse ?? lateralJump;
  const rolePenalty = trackState.inferredSlotRole && feat.inferredSlotRole
    && trackState.inferredSlotRole !== feat.inferredSlotRole ? o.roleMismatchPenalty : 0;
  detail.terms.roleMismatchPenalty = rolePenalty;

  const cost = lateralJump * o.lateralCostWeight
    + (shapeRmse ?? lateralJump) * o.shapeCostWeight
    + dt * o.timeCostWeight
    + hd * o.headingCostWeight
    + ((feat.laneLineStd ?? 0) + (trackState.uncertainty ?? 0)) * o.uncertaintyCostWeight
    + rolePenalty;

  detail.cost = cost;
  detail.valid = cost < o.maxAssociationCost;
  if (!detail.valid) detail.rejection = 'cost_above_threshold';
  return detail;
}

/** Local second-lowest valid cost among remaining active tracks (prototype ambiguity). */
function detectAmbiguity(costs, options = {}) {
  const o = { ...DEFAULT_ASSOCIATION_ASSESSMENT, ...options };
  const valid = costs.filter((c) => c.valid).sort((a, b) => a.cost - b.cost);
  if (valid.length < 2) return { ambiguous: false, definition: AMBIGUITY_SEMANTICS.definition };
  const ratio = valid[1].cost / valid[0].cost;
  return {
    ambiguous: ratio < o.ambiguousCostRatio,
    best: valid[0],
    second: valid[1],
    ratio,
    costMargin: valid[1].cost - valid[0].cost,
    definition: AMBIGUITY_SEMANTICS.definition,
  };
}

function detectRowAmbiguity(detailRow, assignedColIdx, options = {}) {
  const amb = detectAmbiguity(detailRow, options);
  const assignedIsBest = amb.best && detailRow[assignedColIdx]?.trackId === amb.best.trackId;
  return { ...amb, ambiguous: amb.ambiguous && assignedIsBest };
}

function dominantRejectionFamily(rejections) {
  const counts = {};
  for (const r of rejections) if (r) counts[r] = (counts[r] || 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || 'unknown';
}

function birthReasonForUnmatched(detailRow) {
  const invalid = detailRow.filter((d) => !d.valid);
  if (!invalid.length) return TRACK_BIRTH_REASONS.HUNGARIAN_UNMATCHED_COMPETITION;
  const family = dominantRejectionFamily(invalid.map((d) => d.rejection));
  const map = {
    excessive_time_gap: TRACK_BIRTH_REASONS.TEMPORAL_GATE_FAILED,
    lateral_jump: TRACK_BIRTH_REASONS.LATERAL_GATE_FAILED,
    heading_mismatch: TRACK_BIRTH_REASONS.HEADING_GATE_FAILED,
    route_s_discontinuity: TRACK_BIRTH_REASONS.INSUFFICIENT_ROUTE_S_OVERLAP,
    cost_above_threshold: TRACK_BIRTH_REASONS.ALL_CANDIDATES_EXCEEDED_TOTAL_COST,
    chunk_boundary_unsupported: TRACK_BIRTH_REASONS.CHUNK_BOUNDARY_RESTART,
    pass_or_section_boundary: TRACK_BIRTH_REASONS.BOUNDARY_RESTART,
  };
  return map[family] || TRACK_BIRTH_REASONS.ALL_CANDIDATES_GATE_FAILED_NEW_HYPOTHESIS;
}

function groupObservationsByBoundary(observations) {
  const groups = new Map();
  for (const ob of observations) {
    const key = boundaryKey(ob);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ob);
  }
  for (const arr of groups.values()) arr.sort(compareObservations);
  return groups;
}

function associateGroup(observations, groupKey, options = {}) {
  const o = { ...DEFAULT_ASSOCIATION_ASSESSMENT, ...options };
  const [chunkId, temporalPassId, poseSectionId] = groupKey.split(':').map((x) => parseInt(x, 10));
  const features = observations.map((ob) => buildObservationFeature(ob, o));
  const frames = [];
  const frameMap = new Map();
  for (const f of features) {
    if (!frameMap.has(f.logMonoTime)) {
      frameMap.set(f.logMonoTime, []);
      frames.push(f.logMonoTime);
    }
    if (f.eligible) frameMap.get(f.logMonoTime).push(f);
  }
  frames.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));

  const tracks = new Map();
  const activeTracks = new Map();
  let nextTrackIndex = 0;
  const outcomes = [];
  const associationDecisions = [];

  const makeTrackId = (idx) => `${chunkId}:${temporalPassId}:${poseSectionId}:${idx}`;

  for (const t of frames) {
    const frameFeats = frameMap.get(t) || [];
    if (!frameFeats.length) continue;

    if (!activeTracks.size) {
      for (const feat of frameFeats) {
        const tid = makeTrackId(nextTrackIndex);
        const trackIndex = nextTrackIndex++;
        const track = {
          trackId: tid,
          trackIndex,
          chunkId,
          temporalPassId,
          poseSectionId,
          observationIds: [feat.observationId],
          segmentIds: [feat.segmentId],
          frameTimes: [feat.logMonoTime],
          slotRoleHistory: [{ slot: feat.sourceSlotIndex, role: feat.inferredSlotRole, time: feat.logMonoTime }],
          lastLogMonoTime: feat.logMonoTime,
          sMin: feat.sMin,
          sMax: feat.sMax,
          meanD: feat.meanD,
          dProfile: feat.dProfile,
          headingDeg: feat.headingDeg,
          inferredSlotRole: feat.inferredSlotRole,
          uncertainty: feat.laneLineStd ?? 0,
          confidence: feat.laneLineProb ?? 1,
          missedFrames: 0,
          associationDecisions: [],
        };
        tracks.set(tid, track);
        activeTracks.set(tid, track);
        outcomes.push({
          observationId: feat.observationId,
          primaryOutcome: ASSOCIATION_OUTCOMES.NEW_TRACK,
          trackId: tid,
          birthReason: TRACK_BIRTH_REASONS.FIRST_OBSERVATION_IN_GROUP,
          reasons: ['first_observation_in_group'],
          candidateScores: [],
        });
        associationDecisions.push({ observationId: feat.observationId, trackId: tid, outcome: ASSOCIATION_OUTCOMES.NEW_TRACK, cost: 0 });
      }
      continue;
    }

    const activeList = [...activeTracks.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const nFeat = frameFeats.length;
    const nActive = activeList.length;
    const costMatrix = [];
    const detailMatrix = [];

    for (let i = 0; i < nFeat; i++) {
      const row = [];
      const drow = [];
      for (let j = 0; j < nActive; j++) {
        const d = computeAssociationCost(activeList[j][1], frameFeats[i], o);
        row.push(d.valid ? d.cost : Infinity);
        drow.push(d);
      }
      costMatrix.push(row);
      detailMatrix.push(drow);
    }

    const { assignments } = hungarianAssign(costMatrix, o.maxAssociationCost);
    const matchedTracks = new Set();
    const matchedFeats = new Set();

    for (const [fi, { colIdx, cost }] of assignments.entries()) {
      const feat = frameFeats[fi];
      const [trackId, track] = activeList[colIdx];
      const detail = detailMatrix[fi][colIdx];
      const amb = detectAmbiguity(detailMatrix[fi].filter((_, j) => !matchedTracks.has(activeList[j][0])), o);

      if (amb.ambiguous && amb.best?.trackId === trackId) {
        outcomes.push({
          observationId: feat.observationId,
          primaryOutcome: ASSOCIATION_OUTCOMES.REJECTED_AMBIGUOUS,
          trackId: null,
          reasons: ['ambiguous_equal_cost_candidates'],
          candidateScores: detailMatrix[fi].map((d) => ({ trackId: d.trackId, cost: d.cost, valid: d.valid })),
          ambiguity: { ratio: amb.ratio, costMargin: amb.costMargin, definition: amb.definition },
        });
        associationDecisions.push({ observationId: feat.observationId, trackId: null, outcome: ASSOCIATION_OUTCOMES.REJECTED_AMBIGUOUS, cost, ambiguity: amb });
        matchedFeats.add(fi);
        continue;
      }

      if (!detail.valid) {
        matchedFeats.add(fi);
        continue;
      }

      track.observationIds.push(feat.observationId);
      if (!track.segmentIds.includes(feat.segmentId)) track.segmentIds.push(feat.segmentId);
      track.frameTimes.push(feat.logMonoTime);
      track.slotRoleHistory.push({ slot: feat.sourceSlotIndex, role: feat.inferredSlotRole, time: feat.logMonoTime });
      track.lastLogMonoTime = feat.logMonoTime;
      track.sMin = Math.min(track.sMin, feat.sMin);
      track.sMax = Math.max(track.sMax, feat.sMax);
      track.meanD = (track.meanD * (track.observationIds.length - 1) + feat.meanD) / track.observationIds.length;
      track.dProfile = feat.dProfile;
      track.headingDeg = feat.headingDeg;
      track.inferredSlotRole = feat.inferredSlotRole;
      track.uncertainty = feat.laneLineStd ?? track.uncertainty;
      track.confidence = feat.laneLineProb ?? track.confidence;
      track.missedFrames = 0;
      track.associationDecisions.push({ observationId: feat.observationId, cost, outcome: ASSOCIATION_OUTCOMES.ASSOCIATED });
      matchedTracks.add(trackId);
      matchedFeats.add(fi);
      outcomes.push({
        observationId: feat.observationId,
        primaryOutcome: ASSOCIATION_OUTCOMES.ASSOCIATED,
        trackId,
        reasons: [],
        candidateScores: detailMatrix[fi].map((d) => ({ trackId: d.trackId, cost: d.cost, valid: d.valid, selected: d.trackId === trackId })),
        selectedCost: cost,
      });
      associationDecisions.push({
        observationId: feat.observationId,
        trackId,
        outcome: ASSOCIATION_OUTCOMES.ASSOCIATED,
        cost,
        candidateScores: detailMatrix[fi].map((d) => ({ trackId: d.trackId, cost: d.cost, valid: d.valid })),
      });
    }

    for (let fi = 0; fi < nFeat; fi++) {
      if (matchedFeats.has(fi)) continue;
      const feat = frameFeats[fi];
      const birthReason = birthReasonForUnmatched(detailMatrix[fi]);
      const tid = makeTrackId(nextTrackIndex);
      const trackIndex = nextTrackIndex++;
      const track = {
        trackId: tid,
        trackIndex,
        chunkId,
        temporalPassId,
        poseSectionId,
        observationIds: [feat.observationId],
        segmentIds: [feat.segmentId],
        frameTimes: [feat.logMonoTime],
        slotRoleHistory: [{ slot: feat.sourceSlotIndex, role: feat.inferredSlotRole, time: feat.logMonoTime }],
        lastLogMonoTime: feat.logMonoTime,
        sMin: feat.sMin,
        sMax: feat.sMax,
        meanD: feat.meanD,
        dProfile: feat.dProfile,
        headingDeg: feat.headingDeg,
        inferredSlotRole: feat.inferredSlotRole,
        uncertainty: feat.laneLineStd ?? 0,
        confidence: feat.laneLineProb ?? 1,
        missedFrames: 0,
        associationDecisions: [],
      };
      tracks.set(tid, track);
      activeTracks.set(tid, track);
      outcomes.push({
        observationId: feat.observationId,
        primaryOutcome: ASSOCIATION_OUTCOMES.NEW_TRACK,
        trackId: tid,
        birthReason,
        reasons: ['no_valid_candidate'],
        candidateScores: detailMatrix[fi].map((d) => ({ trackId: d.trackId, cost: d.cost, valid: d.valid, rejection: d.rejection })),
        gateFailures: detailMatrix[fi].filter((d) => !d.valid).map((d) => d.rejection),
      });
      associationDecisions.push({ observationId: feat.observationId, trackId: tid, outcome: ASSOCIATION_OUTCOMES.NEW_TRACK, cost: null, birthReason });
    }

    for (const [tid, track] of activeTracks.entries()) {
      if (!matchedTracks.has(tid)) {
        track.missedFrames++;
        if (track.missedFrames > o.maxMissedFrames) activeTracks.delete(tid);
      }
    }
  }

  return { tracks: [...tracks.values()], outcomes, associationDecisions, groupKey };
}

function associateProjectedObservations(observations, options = {}) {
  const eligible = [];
  const ineligible = [];
  for (const ob of observations) {
    const elig = isEligibleObservation(ob);
    if (elig.eligible) eligible.push(ob);
    else ineligible.push({ observationId: observationId(ob), reason: elig.reason });
  }

  const groups = groupObservationsByBoundary(eligible);
  const sortedKeys = [...groups.keys()].sort();
  const allTracks = [];
  const allOutcomes = [];
  const allDecisions = [];

  for (const key of sortedKeys) {
    const result = associateGroup(groups.get(key), key, options);
    allTracks.push(...result.tracks);
    allOutcomes.push(...result.outcomes);
    allDecisions.push(...result.associationDecisions);
  }

  return {
    tracks: allTracks,
    outcomes: allOutcomes,
    associationDecisions: allDecisions,
    ineligible,
    eligibleCount: eligible.length,
    chunkBoundaryAudit: { accepted: [], rejected: [] },
    associationModel: ASSOCIATION_MODEL_DOCS,
    ambiguitySemantics: AMBIGUITY_SEMANTICS,
    assessmentSettings: { ...DEFAULT_ASSOCIATION_ASSESSMENT, ...options },
  };
}

function sha256Observations(observations) {
  const h = crypto.createHash('sha256');
  const ids = observations.map(observationId).sort();
  h.update(ids.join('\n'));
  return h.digest('hex');
}

function loadStage16ProjectedObservations(filePath) {
  const fs = require('fs');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const observations = data.observations || [];
  const projected = observations.filter((o) => o.projectionStatus === PROJECTION_STATUSES.PROJECTED);
  return {
    envelope: data,
    observations,
    projectedObservations: projected,
    checksum: sha256Observations(projected),
  };
}

function classifyUnmatched(feat, detailRow, activeList) {
  return {
    primaryOutcome: ASSOCIATION_OUTCOMES.NEW_TRACK,
    birthReason: birthReasonForUnmatched(detailRow),
    candidateScores: detailRow.map((d) => ({ trackId: d.trackId, cost: d.cost, valid: d.valid, rejection: d.rejection })),
  };
}

module.exports = {
  observationId,
  isEligibleObservation,
  buildObservationFeature,
  computeAssociationCost,
  detectAmbiguity,
  detectRowAmbiguity,
  classifyUnmatched,
  associateProjectedObservations,
  associateGroup,
  groupObservationsByBoundary,
  compareObservations,
  boundaryKey,
  loadStage16ProjectedObservations,
  sha256Observations,
  timeGapSec,
  routeSOverlapM,
  sampleDProfile,
};
