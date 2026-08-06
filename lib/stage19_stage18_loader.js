/**
 * Stage 19 — read-only loader for approved Stage 18 outputs and upstream context.
 */
const fs = require('fs');
const path = require('path');
const { buildStage18InputContext } = require('./stage18_stage17_loader');
const { buildStage18FromContext } = require('./stage18_lane_interval_audit');

const DEFAULT_INTERVALS_PATH = 'lane_intervals_v0.json';
const DEFAULT_COUNTS_PATH = 'lane_count_assessments_v0.json';
const DEFAULT_STAGE18_AUDIT_PATH = 'audit_stage18_lane_interval_assessment.json';

function loadJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function buildStage19InputContext(root, options = {}) {
  const stage18Context = buildStage18InputContext(root, options);
  const intervalsPath = path.join(root, options.intervalsPath || DEFAULT_INTERVALS_PATH);
  const countsPath = path.join(root, options.countsPath || DEFAULT_COUNTS_PATH);
  const audit18Path = path.join(root, options.stage18AuditPath || DEFAULT_STAGE18_AUDIT_PATH);

  const intervalsEnvelope = loadJsonIfExists(intervalsPath);
  const countsEnvelope = loadJsonIfExists(countsPath);
  const stage18Audit = loadJsonIfExists(audit18Path);

  const built = buildStage18FromContext(stage18Context);

  const observationToTrack = new Map();
  for (const track of stage18Context.tracks) {
    for (const oid of track.observationIds || []) {
      observationToTrack.set(oid, track.trackId);
    }
  }

  return {
    ...stage18Context,
    intervalsEnvelope,
    countsEnvelope,
    stage18Audit,
    acceptedIntervals: intervalsEnvelope?.intervals || built.acceptedIntervals || [],
    countAssessments: countsEnvelope?.assessments || built.countAssessments || [],
    observationToTrack,
    builtStage18: built,
  };
}

module.exports = {
  DEFAULT_INTERVALS_PATH,
  DEFAULT_COUNTS_PATH,
  DEFAULT_STAGE18_AUDIT_PATH,
  buildStage19InputContext,
};
