'use strict';

const { config } = require('./config');
const { sha256 } = require('./crypto_util');
const {
  headingDeg,
  tangentLoDeg,
  sLoM,
  sHiM,
  staticBranchCandidateEdge,
  wrappedAbs,
} = require('./geometry');

function headingStateKey(h) {
  return `${h.headingBin}|${h.tangentBin}|${h.lengthBucket}|${h.evidenceUnitKey}`;
}

function headingBucket(lengthM) {
  return Math.min(config.B_heading - 1, Math.floor(lengthM / config.minHeadingEvaluationLengthM));
}

function headingTerminalKey(h) {
  return `${h.headingBin}|${h.tangentBin}|${h.lengthBucket}`;
}

function betterHeadingState(a, b) {
  if (a.meanResultant !== b.meanResultant) return a.meanResultant > b.meanResultant ? a : b;
  if (a.totalLengthM !== b.totalLengthM) return a.totalLengthM > b.totalLengthM ? a : b;
  return a.stateHash < b.stateHash ? a : b;
}

class HeadingStatePool {
  retain(indices) {
    return indices.slice();
  }

  extend(prev, i) {
    return prev.concat([i]);
  }
}

function runHeadingBranch(branchMatches, branchId) {
  const M = branchMatches;
  const dp = new Map();
  const terminal = new Map();
  const pool = new HeadingStatePool();
  for (let i = 0; i < M.length; i++) {
    const m = M[i];
    const len = Math.max(0, sHiM(m) - sLoM(m));
    if (len < config.minHeadingEvaluationLengthM) continue;
    const h0 = {
      headingBin: Math.round(headingDeg(m) / config.headingTangentQuantizeDeg),
      tangentBin: Math.round(tangentLoDeg(m) / config.headingTangentQuantizeDeg),
      lengthBucket: headingBucket(len),
      evidenceUnitKey: m.evidenceUnitKey,
      meanResultant: 1,
      totalLengthM: len,
      stateHash: sha256(`${i}|${branchId}`),
      retainedIds: pool.retain([i]),
    };
    const k0 = headingStateKey(h0);
    const prev = dp.get(k0);
    dp.set(k0, prev ? betterHeadingState(prev, h0) : h0);
    for (const [, h] of dp.entries()) {
      if (h === h0) continue;
      const tailIdx = h.retainedIds[h.retainedIds.length - 1];
      if (!staticBranchCandidateEdge(M[tailIdx], m, 'inc')) continue;
      const merged = {
        headingBin: Math.round(
          (headingDeg(m) + h.headingBin * config.headingTangentQuantizeDeg) / 2
            / config.headingTangentQuantizeDeg,
        ),
        tangentBin: h.tangentBin,
        lengthBucket: headingBucket(h.totalLengthM + len),
        evidenceUnitKey: h.evidenceUnitKey,
        meanResultant: h.meanResultant + 1,
        totalLengthM: h.totalLengthM + len,
        stateHash: sha256(`${h.stateHash}|${i}`),
        retainedIds: pool.extend(h.retainedIds, i),
      };
      const km = headingStateKey(merged);
      const p2 = dp.get(km);
      dp.set(km, p2 ? betterHeadingState(p2, merged) : merged);
    }
    for (const h of dp.values()) {
      const tk = headingTerminalKey(h);
      const tprev = terminal.get(tk);
      terminal.set(tk, tprev ? betterHeadingState(tprev, h) : h);
    }
  }
  const estimates = [];
  for (const h of terminal.values()) {
    estimates.push({
      mean: h.headingBin * config.headingTangentQuantizeDeg,
      meanResultant: h.meanResultant,
      evidenceUnitKey: h.evidenceUnitKey,
      featurePairId: M[h.retainedIds[0]].featurePairId,
    });
  }
  const qualifying = estimates.filter((e) => e.meanResultant >= config.minHeadingResultant);
  return { estimates, qualifying, pool };
}

module.exports = {
  headingStateKey,
  headingBucket,
  headingTerminalKey,
  betterHeadingState,
  HeadingStatePool,
  runHeadingBranch,
};
