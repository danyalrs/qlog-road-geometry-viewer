/**
 * Stage 20 Amendment A — v1 supported-runs artifact builder.
 */
const path = require('path');
const fs = require('fs');
const { FROZEN_ROAD_SURFACE_VERSION } = require('./stage15_lane_counting_design');
const { fuseAllTracks } = require('./stage17_supported_run_fusion');
const { associateProjectedObservations, loadStage16ProjectedObservations } = require('./stage17_divider_association');
const {
  SUPPORTED_RUNS_V1_SCHEMA_VERSION,
  SUPPORTED_RUNS_V1_PROCESSING_VERSION,
  AMENDMENT_A_IMPLEMENTATION_CHECKPOINT,
} = require('./stage20_amendment_a_version');
const { contentHashSha256, sortRuns, sortGaps, canonicalJson } = require('./stage20_amendment_a_serialization');
const {
  validateV1RunRecord,
  validateArtifactEnvelope,
  detectParentTrackIdConflicts,
} = require('./stage20_amendment_a_validation');

function buildV1SupportedRunsArtifact(root, options = {}) {
  const stage16Path = path.join(root, options.stage16Path || 'projected_lane_observations_v0.json');
  const tracksPath = path.join(root, options.tracksPath || 'lane_divider_tracks_v0.json');

  const loaded = loadStage16ProjectedObservations(stage16Path);
  const obMap = new Map(loaded.projectedObservations.map((o) => {
    const { observationId } = require('./stage17_divider_association');
    return [observationId(o), o];
  }));

  let tracks;
  if (options.tracks) {
    tracks = options.tracks;
  } else if (fs.existsSync(tracksPath)) {
    tracks = JSON.parse(fs.readFileSync(tracksPath, 'utf8')).tracks || [];
  } else {
    const assoc = associateProjectedObservations(loaded.projectedObservations);
    tracks = assoc.tracks;
  }

  const trackById = new Map(tracks.map((t) => [t.trackId, t]));
  const fusion = fuseAllTracks(tracks, loaded.projectedObservations, {
    ...options,
    amendmentA: true,
    createdAt: options.createdAt || new Date().toISOString(),
  });

  const supportedRuns = sortRuns(fusion.supportedRuns);
  const gaps = sortGaps(fusion.gaps);
  const recordErrors = [];
  for (const run of supportedRuns) {
    const err = validateV1RunRecord(run, trackById, obMap);
    if (err) recordErrors.push({ dividerRunId: run.dividerRunId, ...err });
  }

  const parentConflicts = detectParentTrackIdConflicts(supportedRuns);
  const rejectedEmission = fusion.rejectedRuns || [];

  const contentPayload = { supportedRuns, gaps };
  const artifact = {
    schemaVersion: SUPPORTED_RUNS_V1_SCHEMA_VERSION,
    processingVersion: SUPPORTED_RUNS_V1_PROCESSING_VERSION,
    implementationCheckpoint: AMENDMENT_A_IMPLEMENTATION_CHECKPOINT,
    frozenBaselineVersion: FROZEN_ROAD_SURFACE_VERSION,
    stage16InputChecksum: loaded.checksum,
    tracksInputChecksum: options.tracksInputChecksum || (fs.existsSync(tracksPath) ? sha256File(tracksPath) : null),
    supportedRunCount: supportedRuns.length,
    gapCount: gaps.length,
    rejectedRunCount: rejectedEmission.length,
    supportedRuns,
    gaps,
    provenance: {
      pipelineStage: 'stage17_supported_run_fusion',
      amendment: 'stage20_amendment_a',
      normativePropagationPoint: 'flushRun',
      sourceTrackArtifact: path.basename(tracksPath),
      createdAt: options.createdAt || new Date().toISOString(),
    },
    contentHashSha256: contentHashSha256(contentPayload),
  };

  const envelopeErrors = validateArtifactEnvelope(artifact);
  return {
    artifact,
    validation: {
      recordErrors,
      parentConflicts,
      envelopeErrors,
      rejectedEmission,
      valid: recordErrors.length === 0 && parentConflicts.length === 0 && envelopeErrors.length === 0,
    },
    tracks,
    observations: loaded.projectedObservations,
  };
}

function sha256File(filePath) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeV1Artifact(root, outPath, options = {}) {
  const built = buildV1SupportedRunsArtifact(root, options);
  const target = path.isAbsolute(outPath) ? outPath : path.join(root, outPath);
  fs.writeFileSync(target, canonicalJson(built.artifact));
  return { ...built, outPath: target };
}

module.exports = {
  buildV1SupportedRunsArtifact,
  writeV1Artifact,
};
