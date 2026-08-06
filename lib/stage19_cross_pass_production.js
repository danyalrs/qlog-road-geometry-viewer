'use strict';

const { config } = require('./stage19_spec/config');
const { measuredConflictForGroup } = require('./stage19_spec/conflict');
const { runHeadingBranch } = require('./stage19_spec/heading');
const { wrappedAbs } = require('./stage19_spec/geometry');

function buildCrossPassCandidates(context, matches) {
  const candidates = [];
  const insufficient = [];
  const runsByParent = new Map();

  for (const run of context.supportedRuns || []) {
    const key = `${run.parentTrackId}|${run.chunkId}|${run.poseSectionId ?? 0}`;
    if (!runsByParent.has(key)) runsByParent.set(key, []);
    runsByParent.get(key).push(run);
  }

  const matchesByRun = new Map();
  for (const m of matches) {
    for (const run of context.supportedRuns || []) {
      if ((run.observationIds || []).includes(m.observationId)) {
        if (!matchesByRun.has(run.dividerRunId)) matchesByRun.set(run.dividerRunId, []);
        matchesByRun.get(run.dividerRunId).push(m);
      }
    }
  }

  for (const [, runs] of runsByParent) {
    const passGroups = new Map();
    for (const run of runs) {
      if (!passGroups.has(run.temporalPassId)) passGroups.set(run.temporalPassId, []);
      passGroups.get(run.temporalPassId).push(run);
    }
    const passes = [...passGroups.keys()].sort((a, b) => a - b);
    if (passes.length < 2) continue;

    for (let i = 0; i < passes.length; i++) {
      for (let j = i + 1; j < passes.length; j++) {
        const passLo = passes[i];
        const passHi = passes[j];
        const runLo = passGroups.get(passLo)[0];
        const runHi = passGroups.get(passHi)[0];
        const mLo = matchesByRun.get(runLo.dividerRunId) || [];
        const mHi = matchesByRun.get(runHi.dividerRunId) || [];
        if (!mLo.length || !mHi.length) {
          insufficient.push({
            reason: 'insufficient_cross_pass_evidence',
            parentTrackId: runLo.parentTrackId,
            passLo,
            passHi,
          });
          continue;
        }
        const evidenceUnitKeyLo = `${runLo.chunkId}:${passLo}`;
        const evidenceUnitKeyHi = `${runHi.chunkId}:${passHi}`;
        if (evidenceUnitKeyLo === evidenceUnitKeyHi) continue;

        const overlapM = Math.min(runLo.routeSpanM ?? 0, runHi.routeSpanM ?? 0);
        if (overlapM < config.minCrossPassTrajectoryOverlapM) {
          insufficient.push({
            reason: 'insufficient_cross_pass_evidence',
            parentTrackId: runLo.parentTrackId,
            overlapM,
          });
          continue;
        }

        candidates.push({
          featurePairId: `cp:${runLo.parentTrackId}:${passLo}:${passHi}`,
          evidenceUnitKeyLo,
          evidenceUnitKeyHi,
          temporalPassIdLo: String(passLo),
          temporalPassIdHi: String(passHi),
          parentTrackId: runLo.parentTrackId,
          leftDividerRunId: runLo.dividerRunId,
          rightDividerRunId: runHi.dividerRunId,
          overlapM,
          matchIdsLo: mLo.map((x) => x.observationId),
          matchIdsHi: mHi.map((x) => x.observationId),
        });
      }
    }
  }

  return { candidates, insufficient };
}

function buildCrossPassRecords(candidates) {
  return candidates.map((c) => ({
    featurePairId: c.featurePairId,
    evidenceUnitKey: c.evidenceUnitKeyLo,
    overlapM: c.overlapM ?? 0,
    headingDiffDeg: 0,
    _meta: {
      evidenceUnitKeyHi: c.evidenceUnitKeyHi,
      temporalPassIdLo: c.temporalPassIdLo,
      temporalPassIdHi: c.temporalPassIdHi,
      parentTrackId: c.parentTrackId,
    },
  }));
}

function buildHeadingForCandidates(candidates, matches) {
  const matchById = new Map(matches.map((m) => [m.observationId, m]));
  const results = [];
  const headingByPairId = new Map();

  for (const c of candidates) {
    const branchLo = c.matchIdsLo.map((id) => matchById.get(id)).filter(Boolean).sort((a, b) => a.sLoUm - b.sLoUm);
    const branchHi = c.matchIdsHi.map((id) => matchById.get(id)).filter(Boolean).sort((a, b) => a.sLoUm - b.sLoUm);
    const estimates = [];
    if (branchLo.length) {
      const hrLo = runHeadingBranch(branchLo, 0);
      for (const e of hrLo.estimates) {
        estimates.push({
          ...e,
          evidenceUnitKey: c.evidenceUnitKeyLo,
          featurePairId: c.featurePairId,
          coordinateFrame: 'vehicle_heading_deg',
        });
      }
    }
    if (branchHi.length) {
      const hrHi = runHeadingBranch(branchHi, 1);
      for (const e of hrHi.estimates) {
        estimates.push({
          ...e,
          evidenceUnitKey: c.evidenceUnitKeyHi,
          featurePairId: c.featurePairId,
          coordinateFrame: 'vehicle_heading_deg',
        });
      }
    }
    const entry = {
      featurePairId: c.featurePairId,
      estimates,
      qualifying: estimates.filter((e) => e.meanResultant >= config.minHeadingResultant),
    };
    results.push(entry);
    headingByPairId.set(c.featurePairId, entry);
  }
  return { results, headingByPairId };
}

function detectProductionConflicts(candidates, headingByPairId) {
  const conflicts = [];
  const insufficient = [];

  for (const c of candidates) {
    if (c.temporalPassIdLo != null && c.temporalPassIdHi != null && c.temporalPassIdLo === c.temporalPassIdHi) {
      insufficient.push({ featurePairId: c.featurePairId, reason: 'same_pass_rejected' });
      continue;
    }
    if (c.evidenceUnitKeyLo && c.evidenceUnitKeyHi && c.evidenceUnitKeyLo === c.evidenceUnitKeyHi) {
      insufficient.push({ featurePairId: c.featurePairId, reason: 'repeated_evidence_unit' });
      continue;
    }
    const pairRecords = [
      { featurePairId: c.featurePairId, evidenceUnitKey: c.evidenceUnitKeyLo },
      { featurePairId: `${c.featurePairId}:hi`, evidenceUnitKey: c.evidenceUnitKeyHi },
    ];
    const hr = headingByPairId.get(c.featurePairId);
    if (!hr || hr.estimates.length < 2) {
      insufficient.push({ featurePairId: c.featurePairId, reason: 'insufficient_cross_pass_evidence' });
      continue;
    }
    const headingMap = new Map([
      [c.featurePairId, {
        estimates: hr.estimates.filter((e) => e.evidenceUnitKey === c.evidenceUnitKeyLo),
        qualifying: [],
      }],
      [`${c.featurePairId}:hi`, {
        estimates: hr.estimates.filter((e) => e.evidenceUnitKey === c.evidenceUnitKeyHi),
        qualifying: [],
      }],
    ]);
    const estLo = headingMap.get(c.featurePairId)?.estimates[0];
    const estHi = headingMap.get(`${c.featurePairId}:hi`)?.estimates[0];
    if (!estLo || !estHi) {
      insufficient.push({ featurePairId: c.featurePairId, reason: 'insufficient_cross_pass_evidence' });
      continue;
    }
    if (measuredConflictForGroup(pairRecords, headingMap)) {
      conflicts.push({
        featurePairId: c.featurePairId,
        meanLo: estLo.mean,
        meanHi: estHi.mean,
        headingDiffDeg: wrappedAbs(estLo.mean - estHi.mean),
      });
    }
  }
  return { conflicts, insufficient };
}

module.exports = {
  buildCrossPassCandidates,
  buildCrossPassRecords,
  buildHeadingForCandidates,
  detectProductionConflicts,
};
