'use strict';

const crypto = require('crypto');
const {
  SPLIT_SEED,
  SPLIT_CALIBRATION_MAX_FRACTION,
  SPLIT_VALIDATION_MIN_FRACTION,
} = require('./stage20_b_motion_review_constants');

function clusterHash(clusterId) {
  return crypto.createHash('sha256').update(`${SPLIT_SEED}::${clusterId}`).digest('hex');
}

function buildObservationClusters(pairs) {
  const parent = new Map();

  function find(x) {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
    return parent.get(x);
  }

  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  }

  for (const pair of pairs) {
    union(pair.observationIdA, pair.observationIdB);
    if (pair.parentTrackId) union(`track:${pair.parentTrackId}`, pair.observationIdA);
  }

  const clusters = new Map();
  for (const pair of pairs) {
    const root = find(pair.observationIdA);
    if (!clusters.has(root)) {
      clusters.set(root, {
        clusterId: root,
        pairIds: [],
        parentTrackIds: new Set(),
        observationIds: new Set(),
      });
    }
    const cluster = clusters.get(root);
    cluster.pairIds.push(pair.reviewPairId);
    cluster.observationIds.add(pair.observationIdA);
    cluster.observationIds.add(pair.observationIdB);
    if (pair.parentTrackId) cluster.parentTrackIds.add(pair.parentTrackId);
  }

  return [...clusters.values()].map((c) => ({
    clusterId: c.clusterId,
    pairIds: c.pairIds.sort(),
    parentTrackIds: [...c.parentTrackIds].sort(),
    observationIds: [...c.observationIds].sort(),
    pairCount: c.pairIds.length,
    sortKey: clusterHash(c.clusterId),
  })).sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.clusterId.localeCompare(b.clusterId));
}

function assignCalibrationValidationSplit(pairs) {
  const pairById = new Map(pairs.map((p) => [p.reviewPairId, p]));
  const clusters = buildObservationClusters(pairs);
  const totalPairs = pairs.length;
  const calibrationTargetMax = Math.floor(totalPairs * SPLIT_CALIBRATION_MAX_FRACTION);
  const validationTargetMin = Math.ceil(totalPairs * SPLIT_VALIDATION_MIN_FRACTION);

  const calibrationPairIds = new Set();
  const validationPairIds = new Set();
  const clusterAssignments = [];

  let calibrationCount = 0;
  for (const cluster of clusters) {
    const wouldExceed = calibrationCount + cluster.pairCount > calibrationTargetMax;
    const mustFillValidation = (totalPairs - calibrationCount - cluster.pairCount) < validationTargetMin;
    const assignTo = (wouldExceed && !mustFillValidation) || calibrationCount >= calibrationTargetMax
      ? 'validation'
      : 'calibration';

    for (const pid of cluster.pairIds) {
      if (assignTo === 'calibration') {
        calibrationPairIds.add(pid);
        calibrationCount += 1;
      } else {
        validationPairIds.add(pid);
      }
    }

    clusterAssignments.push({
      clusterId: cluster.clusterId,
      assignment: assignTo,
      pairCount: cluster.pairCount,
      pairIds: cluster.pairIds,
      parentTrackIds: cluster.parentTrackIds,
      sortKey: cluster.sortKey,
    });
  }

  const displacementCoverage = (ids) => coverageBuckets([...ids].map((id) => pairById.get(id)));
  const speedCoverage = (ids) => speedBuckets([...ids].map((id) => pairById.get(id)));
  const timeGapCoverage = (ids) => timeGapBuckets([...ids].map((id) => pairById.get(id)));

  return {
    seed: SPLIT_SEED,
    calibrationMaxFraction: SPLIT_CALIBRATION_MAX_FRACTION,
    validationMinFraction: SPLIT_VALIDATION_MIN_FRACTION,
    totalPairs,
    calibrationPairCount: calibrationPairIds.size,
    validationPairCount: validationPairIds.size,
    calibrationPairIds: [...calibrationPairIds].sort(),
    validationPairIds: [...validationPairIds].sort(),
    clusterAssignments,
    coverage: {
      calibration: {
        displacement: displacementCoverage(calibrationPairIds),
        speed: speedCoverage(calibrationPairIds),
        timeGap: timeGapCoverage(calibrationPairIds),
      },
      validation: {
        displacement: displacementCoverage(validationPairIds),
        speed: speedCoverage(validationPairIds),
        timeGap: timeGapCoverage(validationPairIds),
      },
    },
    labelIndependent: true,
  };
}

function displacementBucket(spatialM) {
  if (spatialM == null) return 'unknown';
  if (spatialM < 12) return 'lt_12m';
  if (spatialM < 35) return '12_35m';
  return 'gt_35m';
}

function speedBucket(speedMps) {
  if (speedMps == null) return 'unknown';
  if (speedMps < 0.5) return 'stationary';
  if (speedMps < 5) return 'low';
  if (speedMps <= 20) return 'normal';
  return 'high';
}

function timeGapBucket(deltaTimeS) {
  if (deltaTimeS == null) return 'unknown';
  if (deltaTimeS < 2) return 'lt_2s';
  if (deltaTimeS <= 4) return '2_4s';
  return 'gt_4s';
}

function coverageBuckets(pairList) {
  const counts = {};
  for (const p of pairList) {
    if (!p) continue;
    const b = displacementBucket(p.spatialM);
    counts[b] = (counts[b] || 0) + 1;
  }
  return counts;
}

function speedBuckets(pairList) {
  const counts = {};
  for (const p of pairList) {
    if (!p) continue;
    const b = speedBucket(p.speedMps);
    counts[b] = (counts[b] || 0) + 1;
  }
  return counts;
}

function timeGapBuckets(pairList) {
  const counts = {};
  for (const p of pairList) {
    if (!p) continue;
    const b = timeGapBucket(p.deltaTimeS);
    counts[b] = (counts[b] || 0) + 1;
  }
  return counts;
}

function verifyNoClusterLeakage(split) {
  const pairToCluster = new Map();
  for (const ca of split.clusterAssignments) {
    for (const pid of ca.pairIds || []) {
      pairToCluster.set(pid, ca.clusterId);
    }
  }
  const calibrationClusters = new Set(
    split.clusterAssignments.filter((c) => c.assignment === 'calibration').map((c) => c.clusterId),
  );
  const validationClusters = new Set(
    split.clusterAssignments.filter((c) => c.assignment === 'validation').map((c) => c.clusterId),
  );
  for (const cid of calibrationClusters) {
    if (validationClusters.has(cid)) return false;
  }
  return true;
}

module.exports = {
  buildObservationClusters,
  assignCalibrationValidationSplit,
  verifyNoClusterLeakage,
  displacementBucket,
  speedBucket,
  timeGapBucket,
};
