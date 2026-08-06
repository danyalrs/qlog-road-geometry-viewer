'use strict';

const { config } = require('./config');
const { jcsUtf8Bytes } = require('./jcs');

function maximumCatalogRecord() {
  const members = [];
  for (let i = 0; i < config.N_obs; i++) {
    members.push({
      memberMatchId: `m-${String(i).padStart(4, '0')}`,
      branchId: i % config.O_max,
    });
  }
  return { schemaVersion: 'stage19_catalog_v0', runId: 'run-max', members };
}

function maximumManifestRecord(runId) {
  return {
    schemaVersion: 'stage19_manifest_v0',
    runId,
    files: Array.from({ length: 9 }, (_, i) => ({
      path: `f${i}.json`,
      sha256: 'a'.repeat(64),
      bytes: 1,
    })),
    createdAt: '2026-07-24T00:00:00.000Z',
    processingVersion: config.processingVersion,
  };
}

function maximumCommitRecord() {
  return {
    schemaVersion: 'stage19_commit_v0',
    runId: 'run-max',
    manifestSha256: 'b'.repeat(64),
    publishedAt: '2026-07-24T00:00:00.000Z',
  };
}

function maximumExclusionsRecord() {
  return {
    schemaVersion: 'stage19_exclusions_v0',
    runId: 'run-max',
    excluded: Array.from({ length: 136 }, (_, i) => ({ gapId: `g-${i}`, reason: 'gap' })),
  };
}

function maximumUnassociatedRecord() {
  return {
    schemaVersion: 'stage19_unassociated_v0',
    runId: 'run-max',
    unassociated: Array.from({ length: 100 }, (_, i) => ({ matchId: `u-${i}` })),
  };
}

function maximumCrossPassRecord() {
  return {
    schemaVersion: 'stage19_cross_pass_v0',
    runId: 'run-max',
    pairs: Array.from({ length: config.P_cp }, (_, i) => ({
      featurePairId: `fp-${i}`,
      evidenceUnitKey: `eu-${i}`,
      overlapM: config.minCrossPassTrajectoryOverlapM + i * 0.01,
      headingDiffDeg: i % 20,
    })),
  };
}

function maximumHeadingRecord() {
  return {
    schemaVersion: 'stage19_heading_v0',
    runId: 'run-max',
    results: Array.from({ length: config.P_cp }, (_, i) => ({
      featurePairId: `fp-${i}`,
      estimates: [{
        mean: 5,
        meanResultant: 2,
        evidenceUnitKey: `eu-${i}`,
        featurePairId: `fp-${i}`,
      }],
      qualifying: [],
    })),
  };
}

function maximumBevRecord() {
  return {
    schemaVersion: 'stage19_bev_v0',
    runId: 'run-max',
    images: [{
      imageId: 'img-0',
      featurePairId: 'fp-0',
      widthPx: 64,
      heightPx: 64,
      mime: 'image/png',
      sha256: 'c'.repeat(64),
      bytes: 4096,
      payloadPath: 'payloads/img-0.png',
    }],
  };
}

function maximumAssessmentRecord() {
  return {
    schemaVersion: 'stage19_assessment_v0',
    runId: 'run-max',
    intervalId: 'iv-0',
    status: 'accepted',
    promotion: 'promote',
    partition: { numPaths: 8, totalExtensionCost: 1.23 },
  };
}

function maximumPromotionRecord() {
  return {
    schemaVersion: 'stage19_promotion_v0',
    runId: 'run-max',
    decisions: Array.from({ length: 5 }, (_, i) => ({
      intervalId: `iv-${i}`,
      status: 'accepted',
      promotion: 'promote',
    })),
  };
}

const constructors = {
  catalog: maximumCatalogRecord,
  manifest: () => maximumManifestRecord('run-max'),
  commit: maximumCommitRecord,
  exclusions: maximumExclusionsRecord,
  unassociated: maximumUnassociatedRecord,
  cross_pass: maximumCrossPassRecord,
  heading: maximumHeadingRecord,
  bev: maximumBevRecord,
  assessment: maximumAssessmentRecord,
  promotion: maximumPromotionRecord,
};

const NORMATIVE_BYTE_TABLE = {
  catalog: { utf8Bytes: 232428, memberCount: 5809 },
  manifest: { utf8Bytes: 1117, memberCount: 9 },
  commit: { utf8Bytes: 180, memberCount: 1 },
  exclusions: { utf8Bytes: 4450, memberCount: 136 },
  unassociated: { utf8Bytes: 1968, memberCount: 100 },
  cross_pass: { utf8Bytes: 68124, memberCount: 742 },
  heading: { utf8Bytes: 102134, memberCount: 742 },
  bev: { utf8Bytes: 276, memberCount: 1 },
  assessment: { utf8Bytes: 174, memberCount: 1 },
  promotion: { utf8Bytes: 392, memberCount: 5 },
};

function countMembers(instance) {
  if (instance.members) return instance.members.length;
  if (instance.pairs) return instance.pairs.length;
  if (instance.results) return instance.results.length;
  if (instance.files) return instance.files.length;
  if (instance.decisions) return instance.decisions.length;
  if (instance.excluded) return instance.excluded.length;
  if (instance.unassociated) return instance.unassociated.length;
  if (instance.images) return instance.images.length;
  return 1;
}

function measureAllMaximumInstances() {
  const out = {};
  for (const [name, fn] of Object.entries(constructors)) {
    const instance = fn();
    const bytes = jcsUtf8Bytes(instance);
    out[name] = { utf8Bytes: bytes.length, memberCount: countMembers(instance) };
  }
  return out;
}

function verifyMaximumInstancesAgainstNormativeTable() {
  const measured = measureAllMaximumInstances();
  const results = [];
  for (const [name, expected] of Object.entries(NORMATIVE_BYTE_TABLE)) {
    const actual = measured[name];
    results.push({
      name,
      pass: actual.utf8Bytes === expected.utf8Bytes && actual.memberCount === expected.memberCount,
      expected,
      actual,
    });
  }
  return {
    allPass: results.every((r) => r.pass),
    results,
    table: NORMATIVE_BYTE_TABLE,
  };
}

module.exports = {
  maximumCatalogRecord,
  maximumManifestRecord,
  maximumCommitRecord,
  maximumExclusionsRecord,
  maximumUnassociatedRecord,
  maximumCrossPassRecord,
  maximumHeadingRecord,
  maximumBevRecord,
  maximumAssessmentRecord,
  maximumPromotionRecord,
  constructors,
  NORMATIVE_BYTE_TABLE,
  countMembers,
  measureAllMaximumInstances,
  verifyMaximumInstancesAgainstNormativeTable,
};
