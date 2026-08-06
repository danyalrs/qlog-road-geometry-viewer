'use strict';

const { promotionDecision } = require('./stage19_spec/semantic');
const { bevEntriesForInterval } = require('./stage19_bev_production');

function observationInInterval(obsId, interval, context) {
  const seg = parseInt(obsId.split(':')[0], 10);
  const intervalSeg = parseInt(String(interval.leftParentTrackId || '').split(':')[2], 10);
  const segs = interval.sourceSegmentIds || (Number.isFinite(intervalSeg) ? [intervalSeg] : []);
  if (segs.length && !segs.includes(seg)) return false;
  const ob = context.observationById.get(obsId);
  if (!ob) return false;
  if (interval.chunkId != null && ob.chunkId !== interval.chunkId) return false;
  if (interval.temporalPassId != null && ob.temporalPassId !== interval.temporalPassId) return false;
  if (interval.poseSectionId != null && ob.poseSectionId !== interval.poseSectionId) return false;
  const s = ob.projectedRoutePoints?.[0]?.s;
  if (Number.isFinite(s) && Number.isFinite(interval.routeSStart) && Number.isFinite(interval.routeSEnd)) {
    if (s < interval.routeSStart - 1 || s > interval.routeSEnd + 1) return false;
  }
  return true;
}

function partitionResultsForInterval(partitionResults, interval, context) {
  return partitionResults.filter((pr) =>
    pr.observationIds.some((oid) => observationInInterval(oid, interval, context))
    || pr.featurePairId === interval.leftParentTrackId
    || pr.featurePairId === interval.rightParentTrackId,
  );
}

function crossPassForInterval(candidates, conflicts, insufficient, interval) {
  const related = candidates.filter((c) =>
    c.parentTrackId === interval.leftParentTrackId
    || c.parentTrackId === interval.rightParentTrackId,
  );
  const relatedConflicts = conflicts.filter((c) =>
    related.some((r) => r.featurePairId === c.featurePairId),
  );
  const relatedInsufficient = insufficient.filter((i) =>
    i.parentTrackId === interval.leftParentTrackId
    || i.parentTrackId === interval.rightParentTrackId,
  );
  return { related, relatedConflicts, relatedInsufficient };
}

function assessIntervalProduction(interval, evidence, runId) {
  const {
    partitionResults,
    failedObservations,
    crossPass,
    conflicts,
    insufficientCrossPass,
    bevArtifacts,
  } = evidence;

  const ivPartitions = partitionResultsForInterval(partitionResults, interval, evidence.context);
  const ivFailed = ivPartitions.filter((p) => !p.ok);
  const ivFailedObs = [...failedObservations].filter((oid) => observationInInterval(oid, interval, evidence.context));
  const { related, relatedConflicts, relatedInsufficient } = crossPassForInterval(
    crossPass.candidates,
    conflicts,
    insufficientCrossPass,
    interval,
  );
  const ivBev = bevEntriesForInterval(bevArtifacts, interval.laneIntervalId);
  const bevPass = ivBev.some((e) => e.layerValidation?.pass);

  if (ivFailedObs.length > 0 || ivFailed.some((p) =>
    p.outcome === 'partition_failed'
    || p.outcome === 'partition_rejected'
    || p.failure?.code === 'overflow',
  )) {
    return {
      schemaVersion: 'stage19_assessment_v0',
      runId,
      intervalId: interval.laneIntervalId,
      status: 'failed',
      promotion: promotionDecision('failed', {
        failureReason: 'partition_failure',
        failureDetail: {
          failedObservationCount: ivFailedObs.length,
          failedChainCount: ivFailed.length,
          codes: [...new Set(ivFailed.map((p) => p.failure?.code).filter(Boolean))],
        },
      }),
      partition: {
        numPaths: 1,
        totalExtensionCost: 0,
      },
      failureReason: 'partition_failure',
      failureDetail: {
        failedObservationCount: ivFailedObs.length,
        failedChainCount: ivFailed.length,
      },
    };
  }

  if (relatedConflicts.length > 0) {
    return {
      schemaVersion: 'stage19_assessment_v0',
      runId,
      intervalId: interval.laneIntervalId,
      status: 'conflict',
      promotion: promotionDecision('conflict', { crossPassConflict: relatedConflicts[0] }),
      partition: { numPaths: 2, totalExtensionCost: 0 },
      crossPassConflict: relatedConflicts[0],
    };
  }

  if (related.length === 0 || relatedInsufficient.length > 0) {
    return {
      schemaVersion: 'stage19_assessment_v0',
      runId,
      intervalId: interval.laneIntervalId,
      status: 'insufficient_evidence',
      promotion: promotionDecision('insufficient_evidence', {
        insufficientEvidence: {
          reason: 'insufficient_cross_pass_evidence',
          candidateCount: related.length,
          insufficientCount: relatedInsufficient.length,
        },
      }),
      partition: { numPaths: 1, totalExtensionCost: 0 },
      insufficientEvidence: {
        reason: 'insufficient_cross_pass_evidence',
        detail: relatedInsufficient[0] || { no_valid_cross_pass_candidates_in_dataset: true },
      },
    };
  }

  if (!bevPass) {
    return {
      schemaVersion: 'stage19_assessment_v0',
      runId,
      intervalId: interval.laneIntervalId,
      status: 'accepted_with_caveats',
      promotion: promotionDecision('accepted_with_caveats', { caveats: ['bev_evidence_missing_for_interval'] }),
      partition: {
        numPaths: Math.max(1, ...ivPartitions.map((p) => p.numPaths || 1)),
        totalExtensionCost: ivPartitions.reduce((s, p) => s + (p.totalExtensionCost || 0), 0),
      },
      caveats: ['bev_evidence_missing_for_interval'],
    };
  }

  const caveats = [];
  if (ivPartitions.some((p) => p.outcome === 'single_observation')) {
    caveats.push('single_observation_chains_only');
  }

  if (caveats.length > 0) {
    return {
      schemaVersion: 'stage19_assessment_v0',
      runId,
      intervalId: interval.laneIntervalId,
      status: 'accepted_with_caveats',
      promotion: promotionDecision('accepted_with_caveats', { caveats }),
      partition: {
        numPaths: Math.max(1, ...ivPartitions.map((p) => p.numPaths || 1)),
        totalExtensionCost: ivPartitions.reduce((s, p) => s + (p.totalExtensionCost || 0), 0),
      },
      caveats,
    };
  }

  return {
    schemaVersion: 'stage19_assessment_v0',
    runId,
    intervalId: interval.laneIntervalId,
    status: 'accepted',
    promotion: promotionDecision('accepted', {}),
    partition: {
      numPaths: Math.max(1, ...ivPartitions.map((p) => p.numPaths || 1)),
      totalExtensionCost: ivPartitions.reduce((s, p) => s + (p.totalExtensionCost || 0), 0),
    },
  };
}

module.exports = {
  observationInInterval,
  partitionResultsForInterval,
  crossPassForInterval,
  assessIntervalProduction,
};
