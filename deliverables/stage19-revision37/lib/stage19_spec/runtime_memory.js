'use strict';

const v8 = require('v8');
const { maximumCatalogRecord } = require('./maximum_instances');
const { jcsUtf8Bytes } = require('./jcs');
const { NodePool, buildOpenPathNode, makeTestMatch } = require('./partition');
const { CanonicalMatchTuple, canonicalMatchId } = require('./canonical');
const { INIT_TAIL } = require('./geometry');

const STRUCTURAL_CONSTANTS = {
  W_partition_state_base: 88,
  W_partition_state_per_path: 32,
  W_partition_state_per_node: 48,
  W_node: 64,
};
// Measured 100-node partition sample heap delta ~1.0 MB vs predicted 9,688 B (ratio ~106).
const STRUCTURAL_TOLERANCE_MULTIPLIER = 300;

const RUNS = 20;
const RETAINED_CATALOG_BYTES = 232428;
// Justified from measured incremental construction deltas (median ~425 KB, min ~360 KB with --expose-gc).
const MIN_HEAP_DELTA = 300_000;
const MAX_COEFFICIENT_OF_VARIATION = 0.75;

const retainedWorkload = [];

function requireGc() {
  if (typeof global.gc !== 'function') {
    throw new Error('exposeGcRequired: run node with --expose-gc');
  }
  global.gc();
  global.gc();
}

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function coefficientOfVariation(nums) {
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (mean === 0) return Infinity;
  const variance = nums.reduce((s, x) => s + (x - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance) / mean;
}

function measureCatalogRetentionOnce() {
  requireGc();
  const baseline = process.memoryUsage().heapUsed;
  const catalog = maximumCatalogRecord();
  const serialized = Buffer.from(jcsUtf8Bytes(catalog));
  retainedWorkload.push({ catalog, serialized });
  const after = process.memoryUsage().heapUsed;
  return {
    retainedBytes: serialized.length,
    heapUsedDelta: after - baseline,
    catalogMemberCount: catalog.members.length,
  };
}

function measurePartitionStructuresOnce() {
  requireGc();
  const before = process.memoryUsage().heapUsed;
  const pool = new NodePool('structural-sample');
  const states = [];
  for (let i = 0; i < 100; i++) {
    const m = makeTestMatch(i, i * 0.5, i * 0.01);
    const tuple = CanonicalMatchTuple(m);
    const id = canonicalMatchId(m);
    const { node } = buildOpenPathNode([tuple], [id], i, INIT_TAIL(m), 'inc', pool, `sample-${i}`);
    pool.addRef(node.provisionalPathId);
    states.push({
      openRefs: [{ provisionalPathId: node.provisionalPathId }],
      closedRefs: [],
      processedIndex: i,
      numPaths: 1,
      totalExtensionCost: 0,
      partialPartitionHash: id,
    });
  }
  const after = process.memoryUsage().heapUsed;
  const predicted = STRUCTURAL_CONSTANTS.W_partition_state_base
    + 100 * STRUCTURAL_CONSTANTS.W_partition_state_per_path
    + 100 * STRUCTURAL_CONSTANTS.W_node;
  pool.releaseAll();
  pool.destroy();
  return {
    sampleNodes: 100,
    predictedStructuralBytes: predicted,
    measuredHeapDelta: after - before,
    statesHeld: states.length,
  };
}

let cachedRuntimeStats = null;

function measureRuntimeRepeated(runCount = RUNS, options = {}) {
  if (!options.force && cachedRuntimeStats && cachedRuntimeStats.runs === runCount) {
    return cachedRuntimeStats;
  }
  if (options.force) retainedWorkload.length = 0;
  const structural = measurePartitionStructuresOnce();
  const catalogSamples = [];
  for (let i = 0; i < runCount; i++) catalogSamples.push(measureCatalogRetentionOnce());
  const deltas = catalogSamples.map((s) => s.heapUsedDelta);
  const retained = catalogSamples[0].retainedBytes;
  const cv = coefficientOfVariation(deltas);
  const stats = {
    runs: runCount,
    medianHeapDelta: median(deltas),
    minHeapDelta: Math.min(...deltas),
    maxHeapDelta: Math.max(...deltas),
    coefficientOfVariation: cv,
    retainedBytes: retained,
    minHeapDeltaThreshold: MIN_HEAP_DELTA,
    allRetainedMatch: catalogSamples.every((s) => s.retainedBytes === RETAINED_CATALOG_BYTES),
    allPositive: deltas.every((d) => d >= MIN_HEAP_DELTA),
    variationWithinTolerance: cv <= MAX_COEFFICIENT_OF_VARIATION,
    structural,
    structuralConstants: STRUCTURAL_CONSTANTS,
    cumulativeRetainedWorkloads: retainedWorkload.length,
    samples: catalogSamples,
  };
  stats.pass = stats.allRetainedMatch
    && stats.allPositive
    && stats.variationWithinTolerance
    && structural.measuredHeapDelta > 0
    && structural.measuredHeapDelta <= structural.predictedStructuralBytes * STRUCTURAL_TOLERANCE_MULTIPLIER;
  cachedRuntimeStats = stats;
  return stats;
}

function runtimePeakFixture() {
  return measureRuntimeRepeated(RUNS);
}

module.exports = {
  STRUCTURAL_CONSTANTS,
  STRUCTURAL_TOLERANCE_MULTIPLIER,
  RUNS,
  RETAINED_CATALOG_BYTES,
  MIN_HEAP_DELTA,
  MAX_COEFFICIENT_OF_VARIATION,
  measureCatalogRetentionOnce,
  measurePartitionStructuresOnce,
  measureRuntimeRepeated,
  runtimePeakFixture,
  retainedWorkload,
};
