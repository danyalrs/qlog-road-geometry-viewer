/**
 * Stage 20 Amendment A — cross-pass evidence state machine.
 */
const {
  AMENDMENT_A_ERROR_CODES: E,
  CROSS_PASS_STATES,
  MIN_STRUCTURAL_ROUTE_S_OVERLAP_M,
} = require('./stage20_amendment_a_schema');
const { isLegacyV0Artifact, legacyV0Unavailable } = require('./stage20_amendment_a_validation');
const { validateLinkageRecord } = require('./stage20_amendment_a_corridor_linkage');

function routeSOverlapM(runA, runB) {
  const start = Math.max(runA.routeSStart, runB.routeSStart);
  const end = Math.min(runA.routeSEnd, runB.routeSEnd);
  return Math.max(0, end - start);
}

function isSamePass(runA, runB) {
  return runA.segmentId === runB.segmentId
    && runA.chunkId === runB.chunkId
    && runA.temporalPassId === runB.temporalPassId
    && runA.poseSectionId === runB.poseSectionId
    && runA.parentTrackId === runB.parentTrackId;
}

function isComparisonKeyMatch(runA, runB) {
  if (runA.segmentId !== runB.segmentId) return false;
  if (runA.dividerCorridorId !== runB.dividerCorridorId) return false;
  if (runA.parentTrackId === runB.parentTrackId) return false;
  if (runA.temporalPassId === runB.temporalPassId) return false;
  return true;
}

function isCrossSegmentKeyCollision(runA, runB) {
  if (runA.segmentId === runB.segmentId) return false;
  if (runA.dividerCorridorId !== runB.dividerCorridorId) return false;
  if (runA.parentTrackId === runB.parentTrackId) return false;
  if (runA.temporalPassId === runB.temporalPassId) return false;
  return true;
}

function findValidatedLinkage(runA, runB, linkageRecords, runById) {
  for (const record of linkageRecords || []) {
    if (record.validationState !== 'validated') continue;
    const err = validateLinkageRecord(record, runById);
    if (err) continue;
    const ids = new Set(record.endpoints.map((e) => e.dividerRunId));
    if (ids.has(runA.dividerRunId) && ids.has(runB.dividerRunId)) return record;
  }
  return null;
}

function evaluateCrossPassPair(runA, runB, context = {}) {
  const {
    linkageRecords = [],
    traversalLinkageByPair = new Map(),
    runById = new Map(),
    identityBasis = null,
  } = context;

  if (identityBasis === 'poseSectionId') {
    return { state: CROSS_PASS_STATES.UNAVAILABLE, code: E.A_XPS_011, reason: 'pose_section_id_not_corridor_identity' };
  }
  if (identityBasis === 'geometry_overlap') {
    return { state: CROSS_PASS_STATES.UNAVAILABLE, code: E.A_LEG_003, reason: 'geometry_overlap_not_corridor_identity' };
  }

  if (runA.dividerRunId && runB.dividerRunId && runA.dividerRunId === runB.dividerRunId) {
    return { state: CROSS_PASS_STATES.UNAVAILABLE, code: E.A_XPS_002, reason: 'self_pair' };
  }
  if (isSamePass(runA, runB)) {
    return { state: CROSS_PASS_STATES.UNAVAILABLE, code: E.A_XPS_001, reason: 'same_pass' };
  }
  if (runA.parentTrackId === runB.parentTrackId) {
    return { state: CROSS_PASS_STATES.UNAVAILABLE, code: E.A_XPS_002, reason: 'self_pair' };
  }

  if (isCrossSegmentKeyCollision(runA, runB)) {
    const linkage = findValidatedLinkage(runA, runB, linkageRecords, runById);
    if (!linkage) {
      return {
        state: CROSS_PASS_STATES.LINKAGE_HYPOTHESIS,
        code: E.A_XPS_013,
        reason: 'cross_segment_key_collision_unlinked',
        comparisonKeyMatch: false,
      };
    }
    if (linkage.linkageType !== 'cross_segment' || linkage.crossSegmentAlignment?.validationState !== 'validated') {
      return {
        state: CROSS_PASS_STATES.PROVISIONAL,
        code: E.A_XPS_008,
        reason: 'cross_segment_overlap_unverified',
        roadCorridorId: linkage.roadCorridorId,
      };
    }
    const pairKey = [runA.dividerRunId, runB.dividerRunId].sort().join('|');
    const traversal = traversalLinkageByPair.get(pairKey);
    if (!traversal?.validated) {
      return {
        state: CROSS_PASS_STATES.PROVISIONAL,
        code: E.A_XPS_007,
        roadCorridorId: linkage.roadCorridorId,
      };
    }
    return { state: CROSS_PASS_STATES.GENUINE, roadCorridorId: linkage.roadCorridorId };
  }

  if (runA.segmentId === runB.segmentId && runA.chunkId !== runB.chunkId && runA.temporalPassId === runB.temporalPassId) {
    return { state: CROSS_PASS_STATES.UNAVAILABLE, code: E.A_XPS_003, reason: 'cross_chunk_same_pass' };
  }
  if (runA.segmentId === runB.segmentId && runA.poseSectionId !== runB.poseSectionId) {
    return { state: CROSS_PASS_STATES.UNAVAILABLE, code: E.A_XPS_004, reason: 'cross_pose_section' };
  }
  if (runA.segmentId !== runB.segmentId && runA.chunkId === runB.chunkId && runA.dividerCorridorId !== runB.dividerCorridorId) {
    return { state: CROSS_PASS_STATES.UNAVAILABLE, code: E.A_XPS_010, reason: 'cross_segment_chunk_comparison' };
  }

  const linkage = findValidatedLinkage(runA, runB, linkageRecords, runById);

  if (isComparisonKeyMatch(runA, runB) && !linkage) {
    return {
      state: CROSS_PASS_STATES.LINKAGE_HYPOTHESIS,
      code: E.A_XPS_012,
      reason: 'comparison_key_not_corridor_identity',
      comparisonKeyMatch: true,
    };
  }

  if (!linkage) {
    return { state: CROSS_PASS_STATES.UNAVAILABLE, code: E.A_XPS_009, reason: 'corridor_identity_unavailable' };
  }

  const corridorLinked = {
    state: CROSS_PASS_STATES.CORRIDOR_LINKED,
    roadCorridorId: linkage.roadCorridorId,
    corridorLinkageId: linkage.corridorLinkageId,
  };

  if (linkage.linkageType === 'same_segment') {
    const overlap = routeSOverlapM(runA, runB);
    if (overlap < MIN_STRUCTURAL_ROUTE_S_OVERLAP_M) {
      return { ...corridorLinked, state: CROSS_PASS_STATES.PROVISIONAL, code: E.A_XPS_007, overlapM: overlap };
    }
    const pairKey = [runA.dividerRunId, runB.dividerRunId].sort().join('|');
    const traversal = traversalLinkageByPair.get(pairKey);
    const structural = {
      state: CROSS_PASS_STATES.STRUCTURAL_CANDIDATE,
      roadCorridorId: linkage.roadCorridorId,
      corridorLinkageId: linkage.corridorLinkageId,
      overlapM: overlap,
    };
    if (!traversal?.validated) {
      return { ...structural, state: CROSS_PASS_STATES.PROVISIONAL, code: E.A_XPS_007, overlapM: overlap };
    }
    return {
      state: CROSS_PASS_STATES.GENUINE,
      roadCorridorId: linkage.roadCorridorId,
      overlapM: overlap,
      traversalLinkageId: traversal.traversalLinkageId,
    };
  }

  if (linkage.linkageType === 'cross_segment') {
    if (linkage.crossSegmentAlignment?.validationState !== 'validated') {
      return { ...corridorLinked, state: CROSS_PASS_STATES.PROVISIONAL, code: E.A_XPS_008 };
    }
    const overlap = routeSOverlapM(runA, runB);
    const structural = {
      state: CROSS_PASS_STATES.STRUCTURAL_CANDIDATE,
      roadCorridorId: linkage.roadCorridorId,
      overlapM: overlap,
    };
    const pairKey = [runA.dividerRunId, runB.dividerRunId].sort().join('|');
    const traversal = traversalLinkageByPair.get(pairKey);
    if (!traversal?.validated) {
      return { ...structural, state: CROSS_PASS_STATES.PROVISIONAL, code: E.A_XPS_007 };
    }
    return { state: CROSS_PASS_STATES.GENUINE, roadCorridorId: linkage.roadCorridorId, overlapM: overlap };
  }

  return corridorLinked;
}

function evaluateCrossPassFromArtifacts(runsArtifact, linkageArtifact, options = {}) {
  if (isLegacyV0Artifact(runsArtifact)) return legacyV0Unavailable();

  const runs = runsArtifact.supportedRuns || [];
  const runById = new Map(runs.map((r) => [r.dividerRunId, r]));
  const linkageRecords = linkageArtifact?.linkageRecords || [];
  const pairs = [];
  const counts = {
    comparisonKeyMatch: 0,
    linkageHypothesis: 0,
    corridorLinked: 0,
    structural: 0,
    provisional: 0,
    genuine: 0,
    unavailable: 0,
  };

  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const result = evaluateCrossPassPair(runs[i], runs[j], {
        linkageRecords,
        traversalLinkageByPair: options.traversalLinkageByPair || new Map(),
        runById,
      });
      pairs.push({ runA: runs[i].dividerRunId, runB: runs[j].dividerRunId, ...result });
      switch (result.state) {
        case CROSS_PASS_STATES.COMPARISON_KEY_MATCH: counts.comparisonKeyMatch++; break;
        case CROSS_PASS_STATES.LINKAGE_HYPOTHESIS:
          counts.linkageHypothesis++;
          if (result.comparisonKeyMatch) counts.comparisonKeyMatch++;
          break;
        case CROSS_PASS_STATES.CORRIDOR_LINKED: counts.corridorLinked++; break;
        case CROSS_PASS_STATES.STRUCTURAL_CANDIDATE: counts.structural++; break;
        case CROSS_PASS_STATES.PROVISIONAL: counts.provisional++; break;
        case CROSS_PASS_STATES.GENUINE: counts.genuine++; break;
        default: counts.unavailable++; break;
      }
    }
  }

  return { available: true, pairs, counts };
}

function discoverComparisonKeyMatches(runs) {
  const matches = [];
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      if (isComparisonKeyMatch(runs[i], runs[j])) {
        matches.push({ runA: runs[i].dividerRunId, runB: runs[j].dividerRunId });
      }
    }
  }
  return matches;
}

function discoverCrossSegmentKeyCollisions(runs) {
  const collisions = [];
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      if (isCrossSegmentKeyCollision(runs[i], runs[j])) {
        collisions.push({ runA: runs[i].dividerRunId, runB: runs[j].dividerRunId, key: runs[i].dividerCorridorId });
      }
    }
  }
  return collisions;
}

module.exports = {
  routeSOverlapM,
  isSamePass,
  isComparisonKeyMatch,
  isCrossSegmentKeyCollision,
  evaluateCrossPassPair,
  evaluateCrossPassFromArtifacts,
  discoverComparisonKeyMatches,
  discoverCrossSegmentKeyCollisions,
};
