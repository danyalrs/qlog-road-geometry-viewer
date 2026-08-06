'use strict';

const v8 = require('v8');
const { maximumCatalogRecord } = require('./maximum_instances');
const { jcsUtf8Bytes } = require('./jcs');

const STRUCTURAL_CONSTANTS = {
  W_partition_state_base: 88,
  W_partition_state_per_path: 32,
  W_partition_state_per_node: 48,
  W_node: 64,
};

function W_partition_state(n_paths, n_nodes) {
  return STRUCTURAL_CONSTANTS.W_partition_state_base
    + STRUCTURAL_CONSTANTS.W_partition_state_per_path * n_paths
    + STRUCTURAL_CONSTANTS.W_partition_state_per_node * n_nodes;
}

function W_node() {
  return STRUCTURAL_CONSTANTS.W_node;
}

function forceGc() {
  if (typeof global.gc === 'function') global.gc();
}

function measureRuntimePeak_v1() {
  forceGc();
  const baseline = process.memoryUsage();
  const catalog = maximumCatalogRecord();
  const serialized = jcsUtf8Bytes(catalog);
  forceGc();
  const afterConstruct = process.memoryUsage();
  const retained = serialized.length;
  const heapUsedDelta = afterConstruct.heapUsed - baseline.heapUsed;
  const heapTotalDelta = afterConstruct.heapTotal - baseline.heapTotal;
  const externalDelta = afterConstruct.external - baseline.external;
  return {
    baseline,
    afterConstruct,
    retainedBytes: retained,
    heapUsedDelta,
    heapTotalDelta,
    externalDelta,
    catalogMemberCount: catalog.members.length,
  };
}

function measureStructuralSample() {
  const samplePaths = 8;
  const sampleNodes = 100;
  const predicted = W_partition_state(samplePaths, sampleNodes) + samplePaths * W_node();
  const pools = [];
  forceGc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < sampleNodes; i++) {
    pools.push({
      id: `n-${i}`,
      branchId: i % samplePaths,
      payload: new Array(8).fill(i),
    });
  }
  forceGc();
  const after = process.memoryUsage().heapUsed;
  return {
    samplePaths,
    sampleNodes,
    predictedStructuralBytes: predicted,
    measuredHeapDelta: after - before,
  };
}

function runtimePeakFixture() {
  const measurement = measureRuntimePeak_v1();
  const structural = measureStructuralSample();
  const retained = measurement.retainedBytes;
  const heapUsedDelta = measurement.heapUsedDelta;
  const ratio = heapUsedDelta / Math.max(retained, 1);
  const pass = heapUsedDelta > 0
    && retained === 232428
    && ratio >= 0.05
    && ratio <= 100
    && structural.measuredHeapDelta > 0
    && structural.measuredHeapDelta <= structural.predictedStructuralBytes * 50;
  return {
    ...measurement,
    structural,
    structuralConstants: STRUCTURAL_CONSTANTS,
    ratio,
    pass,
    note: 'Measured heap delta compared to retained JCS bytes and structural sample — not analytical 40GB bound',
  };
}

module.exports = {
  STRUCTURAL_CONSTANTS,
  W_partition_state,
  W_node,
  measureRuntimePeak_v1,
  measureStructuralSample,
  runtimePeakFixture,
};
