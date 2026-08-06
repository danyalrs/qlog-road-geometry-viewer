'use strict';

/**
 * Default /api/process and loadSegment pipeline options.
 * Pre-Stage-7/8 visual baseline: Stage 7+8 features opt-in only.
 */
const DEFAULT_PROCESS_OPTIONS = {
  pipelineMode: 'C',
  trackerContinuityBridgeEnabled: true,
  bimodalClusterSelection: true,
  positiveBoundaryContinuityBridgeEnabled: false,
  visibleGapReconstructionEnabled: false,
};

function normalizeProcessOptions(options = {}) {
  const merged = { ...DEFAULT_PROCESS_OPTIONS, ...options };
  return {
    ...merged,
    positiveBoundaryContinuityBridgeEnabled: merged.positiveBoundaryContinuityBridgeEnabled === true,
    visibleGapReconstructionEnabled: merged.visibleGapReconstructionEnabled === true,
  };
}

function resolveCleanupOptions(processedData = {}) {
  const po = processedData.processingOptions || {};
  return {
    positiveBoundaryContinuityBridgeEnabled: po.positiveBoundaryContinuityBridgeEnabled === true,
    visibleGapReconstructionEnabled: po.visibleGapReconstructionEnabled === true,
  };
}

function buildProcessingOptionsSnapshot(opts) {
  return {
    positiveBoundaryContinuityBridgeEnabled: opts.positiveBoundaryContinuityBridgeEnabled === true,
    visibleGapReconstructionEnabled: opts.visibleGapReconstructionEnabled === true,
    bimodalClusterSelection: opts.bimodalClusterSelection !== false,
    trackerContinuityBridgeEnabled: opts.trackerContinuityBridgeEnabled !== false,
    pipelineMode: opts.pipelineMode || 'C',
  };
}

module.exports = {
  DEFAULT_PROCESS_OPTIONS,
  normalizeProcessOptions,
  resolveCleanupOptions,
  buildProcessingOptionsSnapshot,
};
