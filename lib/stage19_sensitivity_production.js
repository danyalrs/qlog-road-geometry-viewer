'use strict';

const { config } = require('./stage19_spec/config');
const { isPngSignature } = require('./stage19_bev_png');
const { validateAgainstSchema } = require('./stage19_schema_validate');

/**
 * Sensitivity authority: only baseline config values from normative config.js.
 * Revision 37 does not authorize alternate ranges — baseline recording only.
 */
const SENSITIVITY_AUTHORITY = [
  { parameter: 'maxCrossPassHeadingDiffDeg', source: 'lib/stage19_spec/config.js#maxCrossPassHeadingDiffDeg' },
  { parameter: 'minCrossPassTrajectoryOverlapM', source: 'lib/stage19_spec/config.js#minCrossPassTrajectoryOverlapM' },
  { parameter: 'minHeadingResultant', source: 'lib/stage19_spec/config.js#minHeadingResultant' },
  { parameter: 'maxLocalHeadingDeltaDeg', source: 'lib/stage19_spec/config.js#maxLocalHeadingDeltaDeg' },
  { parameter: 'minCorroboratingEvidenceUnits', source: 'lib/stage19_spec/config.js#minCorroboratingEvidenceUnits' },
  { parameter: 'minP3MatchCount', source: 'lib/stage19_spec/config.js#minP3MatchCount' },
  { parameter: 'B_partition', source: 'lib/stage19_spec/config.js#B_partition' },
];

function authorizedValue(parameter) {
  if (!(parameter in config)) throw new Error(`unauthorized_sensitivity_parameter:${parameter}`);
  return config[parameter];
}

function runStage19SensitivitySweep(inputContext, baselineBundle, options = {}) {
  const { buildMatchRecords } = require('./stage19_match_builder');
  const { runProductionPartition } = require('./stage19_partition_production');
  const { buildCrossPassCandidates, buildHeadingForCandidates, detectProductionConflicts } = require('./stage19_cross_pass_production');
  const { assessIntervalProduction } = require('./stage19_interval_evidence');

  const baseline = {
    crossPassCount: baselineBundle.crossPassCount,
    conflictCount: baselineBundle.conflicts.length,
    insufficientCount: baselineBundle.insufficientCrossPassCount,
    assessmentStatusCounts: baselineBundle.assessmentStatusCounts,
    partitionFailed: baselineBundle.partitionStats?.failedPartitions ?? 0,
    multiObservationChains: baselineBundle.partitionStats?.multiObservationChains ?? 0,
  };

  const rows = [];
  for (const entry of SENSITIVITY_AUTHORITY) {
    const value = authorizedValue(entry.parameter);
    const { matches } = buildMatchRecords(inputContext);
    const partition = runProductionPartition(matches);
    const crossPass = buildCrossPassCandidates(inputContext, matches);
    const { headingByPairId } = buildHeadingForCandidates(crossPass.candidates, matches);
    const { conflicts, insufficient } = detectProductionConflicts(crossPass.candidates, headingByPairId);

    const assessmentStatusCounts = {};
    for (const interval of inputContext.acceptedIntervals || []) {
      const a = assessIntervalProduction(interval, {
        context: inputContext,
        partitionResults: partition.partitionResults,
        failedObservations: partition.failedObservations,
        crossPass,
        conflicts,
        insufficientCrossPass: [...crossPass.insufficient, ...insufficient],
        bevArtifacts: options.bevArtifactLoad || { entries: [] },
      }, baselineBundle.runId);
      assessmentStatusCounts[a.status] = (assessmentStatusCounts[a.status] || 0) + 1;
    }

    rows.push({
      parameter: entry.parameter,
      value,
      authoritySource: entry.source,
      crossPassCount: crossPass.candidates.length,
      conflictCount: conflicts.length,
      insufficientCount: crossPass.insufficient.length + insufficient.length,
      partitionFailed: partition.stats.failedPartitions,
      multiObservationChains: partition.stats.multiObservationChains,
      assessmentStatusCounts,
      deltaFromBaseline: {
        crossPassCount: crossPass.candidates.length - baseline.crossPassCount,
        conflictCount: conflicts.length - baseline.conflictCount,
        insufficientCount: (crossPass.insufficient.length + insufficient.length) - baseline.insufficientCount,
        partitionFailed: partition.stats.failedPartitions - baseline.partitionFailed,
      },
    });
  }

  return {
    schemaVersion: 'stage19_sensitivity_v0',
    authorityNote: 'Revision 37 authorizes baseline config constants only; no alternate parameter ranges are defined.',
    empiricalLimitation: 'Dataset has 0 cross-pass candidates and 0 multi-observation chains; sensitivity rows record baseline outcomes only.',
    baseline,
    parameterCount: SENSITIVITY_AUTHORITY.length,
    rowCount: rows.length,
    rows,
  };
}

module.exports = {
  SENSITIVITY_AUTHORITY,
  authorizedValue,
  runStage19SensitivitySweep,
};
