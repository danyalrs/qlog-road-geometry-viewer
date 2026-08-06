/**
 * Stage 20 Amendment A — acceptance audit counters for v1 artifacts.
 */
const fs = require('fs');
const path = require('path');
const {
  validateV1RunRecord,
  detectParentTrackIdConflicts,
  validateArtifactEnvelope,
} = require('./stage20_amendment_a_validation');
const {
  evaluateCrossPassFromArtifacts,
  discoverCrossSegmentKeyCollisions,
  isSamePass,
  evaluateCrossPassPair,
} = require('./stage20_amendment_a_cross_pass');
const { loadStage16ProjectedObservations } = require('./stage17_divider_association');
const { loadStage17Tracks } = require('./stage18_stage17_loader');
const { CROSS_PASS_STATES } = require('./stage20_amendment_a_schema');

function pct(n, total) {
  return total ? Number(((n / total) * 100).toFixed(2)) : 0;
}

function featurePairId(runA, runB) {
  return [runA.parentTrackId, runB.parentTrackId].sort().join('|');
}

function evidenceUnitKey(run) {
  return `${run.parentTrackId}|${run.chunkId}|${run.poseSectionId}`;
}

function auditV1Artifact(root, options = {}) {
  const runsPath = path.join(root, options.runsPath || 'lane_divider_supported_runs_v1.json');
  const tracksPath = path.join(root, options.tracksPath || 'lane_divider_tracks_v0.json');
  const stage16Path = path.join(root, options.stage16Path || 'projected_lane_observations_v0.json');

  const artifact = JSON.parse(fs.readFileSync(runsPath, 'utf8'));
  const tracks = loadStage17Tracks(tracksPath).tracks;
  const trackById = new Map(tracks.map((t) => [t.trackId, t]));
  const stage16 = loadStage16ProjectedObservations(stage16Path);
  const { observationId } = require('./stage17_divider_association');
  const obMap = new Map(stage16.projectedObservations.map((o) => [observationId(o), o]));

  const runs = artifact.supportedRuns || [];
  const total = runs.length;

  const coverage = {
    segmentId: 0,
    chunkId: 0,
    temporalPassId: 0,
    poseSectionId: 0,
    trackIndex: 0,
    dividerCorridorId: 0,
    parentTrackIdResolved: 0,
    parentTrackIdUnresolved: 0,
  };

  let crossBoundarySupportedRuns = 0;
  const recordErrors = [];
  for (const run of runs) {
    if (Number.isInteger(run.segmentId)) coverage.segmentId++;
    if (Number.isInteger(run.chunkId)) coverage.chunkId++;
    if (Number.isInteger(run.temporalPassId)) coverage.temporalPassId++;
    if (Number.isInteger(run.poseSectionId)) coverage.poseSectionId++;
    if (Number.isInteger(run.trackIndex)) coverage.trackIndex++;
    if (run.dividerCorridorId) coverage.dividerCorridorId++;
    if (trackById.has(run.parentTrackId)) coverage.parentTrackIdResolved++;
    else coverage.parentTrackIdUnresolved++;
    for (const obsId of run.observationIds || []) {
      const ob = obMap.get(obsId);
      if (!ob) continue;
      if (ob.chunkId !== run.chunkId || ob.temporalPassId !== run.temporalPassId
        || ob.poseSectionId !== run.poseSectionId || ob.segmentId !== run.segmentId) {
        crossBoundarySupportedRuns++;
        break;
      }
    }
    const err = validateV1RunRecord(run, trackById, obMap);
    if (err) recordErrors.push({ dividerRunId: run.dividerRunId, ...err });
  }

  const parentConflicts = detectParentTrackIdConflicts(runs);
  const envelopeErrors = validateArtifactEnvelope(artifact);

  const dividerRunIds = runs.map((r) => r.dividerRunId);
  const duplicatedRuns = dividerRunIds.length - new Set(dividerRunIds).size;

  const evidenceUnits = runs.map(evidenceUnitKey);
  const duplicatedEvidenceUnits = evidenceUnits.length - new Set(evidenceUnits).size;

  let samePassMisclassified = 0;
  let crossChunkStructural = 0;
  let crossPoseStructural = 0;
  let selfPairs = 0;
  const featurePairs = new Set();
  let duplicatedFeaturePairs = 0;

  const crossPass = evaluateCrossPassFromArtifacts(artifact, null);
  const keyCollisions = discoverCrossSegmentKeyCollisions(runs);

  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i];
      const b = runs[j];
      if (isSamePass(a, b)) {
        const r = evaluateCrossPassPair(a, b);
        if (r.state !== CROSS_PASS_STATES.UNAVAILABLE || r.code !== 'A-XPS-001') samePassMisclassified++;
      }
      if (a.segmentId === b.segmentId && a.chunkId !== b.chunkId && a.temporalPassId === b.temporalPassId) {
        const r = evaluateCrossPassPair(a, b);
        if (r.state === CROSS_PASS_STATES.STRUCTURAL_CANDIDATE || r.state === CROSS_PASS_STATES.GENUINE) crossChunkStructural++;
      }
      if (a.segmentId === b.segmentId && a.poseSectionId !== b.poseSectionId) {
        const r = evaluateCrossPassPair(a, b);
        if (r.state === CROSS_PASS_STATES.STRUCTURAL_CANDIDATE || r.state === CROSS_PASS_STATES.GENUINE) crossPoseStructural++;
      }
      if (a.dividerRunId === b.dividerRunId) selfPairs++;
      const fp = featurePairId(a, b);
      if (featurePairs.has(fp)) duplicatedFeaturePairs++;
      featurePairs.add(fp);
    }
  }

  const coveragePct = Object.fromEntries(
    Object.entries(coverage).map(([k, v]) => [k, { count: v, pct: pct(v, total) }]),
  );

  return {
    totalRuns: total,
    coverage: coveragePct,
    parentTrackIdentityConflicts: parentConflicts.length,
    memberObservationIdentityConflicts: recordErrors.length,
    recordErrors,
    envelopeErrors,
    crossBoundarySupportedRuns,
    duplicatedSupportedRuns: duplicatedRuns,
    duplicatedEvidenceUnits,
    duplicatedFeaturePairs,
    selfPairs,
    samePassMisclassifiedAsCrossPass: samePassMisclassified,
    crossChunkStructuralPairs: crossChunkStructural,
    crossPoseSectionStructuralPairs: crossPoseStructural,
    evidenceStates: {
      ...crossPass.counts,
      crossSegmentKeyCollisions: keyCollisions.length,
      validatedCorridorLinkages: 0,
      validatedTraversalLinkages: crossPass.counts.genuine,
    },
    crossSegmentKeyCollisions: keyCollisions,
    linkageRecordsAutoGenerated: 0,
  };
}

module.exports = {
  auditV1Artifact,
  featurePairId,
  evidenceUnitKey,
};
