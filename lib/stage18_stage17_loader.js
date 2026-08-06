/**
 * Stage 18 — read-only loader for approved Stage 17 outputs and Stage 16 observations.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { observationId, loadStage16ProjectedObservations } = require('./stage17_divider_association');
const { ASSOCIATION_OUTCOMES } = require('./stage17_tracking_schema');

const DEFAULT_TRACKS_PATH = 'lane_divider_tracks_v0.json';
const DEFAULT_RUNS_PATH = 'lane_divider_supported_runs_v0.json';
const DEFAULT_STAGE17_AUDIT_PATH = 'audit_stage17_lane_divider_tracking.json';

function loadStage17Tracks(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {
    envelope: data,
    tracks: data.tracks || [],
    trackCount: data.trackCount ?? (data.tracks || []).length,
  };
}

function loadStage17SupportedRuns(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {
    envelope: data,
    supportedRuns: data.supportedRuns || [],
    gaps: data.gaps || [],
    supportedRunCount: data.supportedRunCount ?? (data.supportedRuns || []).length,
    gapCount: data.gapCount ?? (data.gaps || []).length,
  };
}

function loadRejectedAmbiguousObservationIds(auditPath) {
  if (!fs.existsSync(auditPath)) return new Set();
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  const ids = new Set();
  for (const entry of audit.ambiguousObservationReport || []) {
    if (entry.observationId) ids.add(entry.observationId);
  }
  if (audit.outcomes) {
    for (const o of audit.outcomes) {
      if (o.primaryOutcome === ASSOCIATION_OUTCOMES.REJECTED_AMBIGUOUS) ids.add(o.observationId);
    }
  }
  return ids;
}

function buildStage18InputContext(root, options = {}) {
  const tracksPath = path.join(root, options.tracksPath || DEFAULT_TRACKS_PATH);
  const runsPath = path.join(root, options.runsPath || DEFAULT_RUNS_PATH);
  const stage16Path = path.join(root, options.stage16Path || 'projected_lane_observations_v0.json');
  const audit17Path = path.join(root, options.stage17AuditPath || DEFAULT_STAGE17_AUDIT_PATH);

  const tracksLoaded = loadStage17Tracks(tracksPath);
  const runsLoaded = loadStage17SupportedRuns(runsPath);
  const stage16Loaded = loadStage16ProjectedObservations(stage16Path);
  const rejectedAmbiguous = loadRejectedAmbiguousObservationIds(audit17Path);

  const trackById = new Map(tracksLoaded.tracks.map((t) => [t.trackId, t]));
  const observationById = new Map(stage16Loaded.projectedObservations.map((o) => [observationId(o), o]));
  const gapById = new Map(runsLoaded.gaps.map((g) => [g.gapId, g]));

  const runsByParent = new Map();
  for (const r of runsLoaded.supportedRuns) {
    if (!runsByParent.has(r.parentTrackId)) runsByParent.set(r.parentTrackId, []);
    runsByParent.get(r.parentTrackId).push(r);
  }
  for (const arr of runsByParent.values()) {
    arr.sort((a, b) => a.dividerRunId.localeCompare(b.dividerRunId));
  }

  return {
    tracks: tracksLoaded.tracks,
    supportedRuns: runsLoaded.supportedRuns,
    gaps: runsLoaded.gaps,
    trackById,
    observationById,
    gapById,
    runsByParent,
    rejectedAmbiguousObservationIds: rejectedAmbiguous,
    stage16Envelope: stage16Loaded.envelope,
    stage16Checksum: stage16Loaded.checksum,
    stage17TracksEnvelope: tracksLoaded.envelope,
    stage17RunsEnvelope: runsLoaded.envelope,
    supportedRunCount: runsLoaded.supportedRunCount,
    gapCount: runsLoaded.gapCount,
    trackCount: tracksLoaded.trackCount,
  };
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

module.exports = {
  DEFAULT_TRACKS_PATH,
  DEFAULT_RUNS_PATH,
  DEFAULT_STAGE17_AUDIT_PATH,
  loadStage17Tracks,
  loadStage17SupportedRuns,
  loadRejectedAmbiguousObservationIds,
  buildStage18InputContext,
  sha256File,
};
