'use strict';

const { config } = require('./config');
const { sha256 } = require('./crypto_util');
const { jcsUtf8Bytes } = require('./jcs');
const { CanonicalMatchTuple, canonicalMatchId } = require('./canonical');
const { directedStepSupport, staticBranchCandidateEdge } = require('./geometry');

function p3Key(k, s) {
  return (k << 16) | s;
}

function singletonState(k, M, meta) {
  const tuple = CanonicalMatchTuple(M[k]);
  const chainHash = sha256(jcsUtf8Bytes({ singleton: true, k, tuple }));
  const overlapStateId = sha256(jcsUtf8Bytes({ meta, k, chainHash }));
  return {
    overlapStateId,
    startIndex: k,
    endIndex: k,
    direction: meta.direction,
    accumulatedSupportedLengthM: 0,
    matchCount: 1,
    memberIndices: [k],
    canonicalMatchIds: [canonicalMatchId(M[k])],
    memberTuples: [tuple],
    chainHash,
    parentOverlapStateId: null,
    directionComponentId: meta.directionComponentId,
    branchId: meta.branchId,
    featureIdLo: meta.featureIdLo,
    featureIdHi: meta.featureIdHi,
    comparisonSpatialFrameId: meta.comparisonSpatialFrameId,
  };
}

function chainTransitionValid(p, k, dir, parentIndices, M) {
  if (!staticBranchCandidateEdge(M[p], M[k], dir)) return false;
  const gap = directedStepSupport(M[p], M[k], dir);
  if (gap > config.maxP3InternalGapM) return false;
  return true;
}

function newOverlapRecord(parent, k, step, M, meta) {
  const tuple = CanonicalMatchTuple(M[k]);
  const chainHash = sha256(jcsUtf8Bytes({ parent: parent.chainHash, k, tuple }));
  const overlapStateId = sha256(jcsUtf8Bytes({ parent: parent.overlapStateId, k, chainHash }));
  return {
    overlapStateId,
    startIndex: parent.startIndex,
    endIndex: k,
    direction: meta.direction,
    accumulatedSupportedLengthM: parent.accumulatedSupportedLengthM + step,
    matchCount: parent.matchCount + 1,
    memberIndices: parent.memberIndices.concat([k]),
    canonicalMatchIds: parent.canonicalMatchIds.concat([canonicalMatchId(M[k])]),
    memberTuples: parent.memberTuples.concat([tuple]),
    chainHash,
    parentOverlapStateId: parent.overlapStateId,
    directionComponentId: meta.directionComponentId,
    branchId: meta.branchId,
    featureIdLo: meta.featureIdLo,
    featureIdHi: meta.featureIdHi,
    comparisonSpatialFrameId: meta.comparisonSpatialFrameId,
  };
}

function betterOverlapState(a, b) {
  if (a.accumulatedSupportedLengthM !== b.accumulatedSupportedLengthM) {
    return a.accumulatedSupportedLengthM > b.accumulatedSupportedLengthM ? a : b;
  }
  if (a.matchCount !== b.matchCount) return a.matchCount > b.matchCount ? a : b;
  return a.overlapStateId < b.overlapStateId ? a : b;
}

function dedupeCapP3(bucket, child) {
  const idx = bucket.findIndex((x) => x.overlapStateId === child.overlapStateId);
  if (idx >= 0) {
    bucket[idx] = betterOverlapState(bucket[idx], child);
  } else if (bucket.length < config.B_overlap) {
    bucket.push(child);
  } else {
    let worst = 0;
    for (let i = 1; i < bucket.length; i++) {
      if (betterOverlapState(bucket[worst], bucket[i]) === bucket[i]) worst = i;
    }
    if (betterOverlapState(child, bucket[worst]) === child) bucket[worst] = child;
  }
}

function chainSatisfiesDensity(state, M) {
  if (state.matchCount < config.minP3MatchCount) return false;
  return state.accumulatedSupportedLengthM >= config.minCrossPassTrajectoryOverlapM;
}

function runP3Branch(M, meta) {
  const dir = meta.direction;
  const n_b = M.length;
  const overlapState = new Map();
  for (let k = 0; k < n_b; k++) {
    overlapState.set(p3Key(k, k), [singletonState(k, M, meta)]);
  }
  for (let k = 1; k < n_b; k++) {
    for (let s = 0; s < k; s++) {
      let bucket = (overlapState.get(p3Key(k, s)) || []).slice();
      for (let p = s; p < k; p++) {
        for (const parent of overlapState.get(p3Key(p, s)) || []) {
          if (!chainTransitionValid(p, k, dir, parent.memberIndices, M)) continue;
          const step = directedStepSupport(M[p], M[k], dir);
          const child = newOverlapRecord(parent, k, step, M, meta);
          dedupeCapP3(bucket, child);
        }
      }
      overlapState.set(p3Key(k, s), bucket);
    }
  }
  const completed = [];
  const seen = new Set();
  for (const bucket of overlapState.values()) {
    for (const state of bucket) {
      if (!chainSatisfiesDensity(state, M)) continue;
      if (seen.has(state.overlapStateId)) continue;
      seen.add(state.overlapStateId);
      completed.push(state);
    }
  }
  if (completed.length === 0) return { ok: false, branchCanonical: null };
  let branchCanonical = completed[0];
  for (let i = 1; i < completed.length; i++) {
    branchCanonical = betterOverlapState(branchCanonical, completed[i]);
  }
  return { ok: true, branchCanonical };
}

module.exports = {
  p3Key,
  singletonState,
  chainTransitionValid,
  newOverlapRecord,
  betterOverlapState,
  dedupeCapP3,
  chainSatisfiesDensity,
  runP3Branch,
};
