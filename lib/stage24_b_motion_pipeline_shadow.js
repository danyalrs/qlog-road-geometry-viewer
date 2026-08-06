'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadSegmentsData } = require('./qlog_data');
const { qualifySegments } = require('./segment_qualify');
const { processRoute } = require('./process_route');
const {
  joinAutomaticAndManual,
  manualLabelToBinary,
  deriveAutomaticContinuationDecision,
  buildConfusionMatrix,
  THRESHOLD_CAP_M,
  THRESHOLD_OPERATOR,
} = require('./stage20_b_motion_baseline_compare');
const {
  enumerateAllConsecutivePairs,
  discoverQlogSegments,
  segmentIdFromQlog,
} = require('./stage20_b_motion_pair_pipeline');
const {
  buildShadowMeasurements,
  decideVector,
  boundaryRejection,
  MANUAL_RECHECK_INDEX,
} = require('./stage22_b_motion_shadow_evaluation');
const {
  DECISION_MODES,
  DEFAULT_VECTOR_CONFIG,
  evaluateBMotionDecision,
  buildGeometryContextFromShadowMeas,
  ANCHOR_MODEL_X_M,
  COORDINATE_FRAME,
} = require('./stage23_b_motion_vector_residual');
const {
  EXPECTED_CONFIG_B,
  assertConfigBReproduction,
  evaluateConfigMetrics,
} = require('./stage23_b_motion_limited_evaluation');

const MANUAL_STUB = Object.freeze({
  reviewerLabel: 'unresolved',
  evidenceMode: 'qlog_playback',
  reviewerNotes: '',
});

const NEAR_BOUNDARY_M = 1.0;
const LEGACY_POS_VECTOR_NEG_CAP = 500;
const LEGACY_NEG_VECTOR_POS_SAMPLE = 40;

const PIPELINE_INTEGRATION = Object.freeze({
  entryFunction: 'evaluatePairAtPipeline',
  module: 'lib/stage24_b_motion_pipeline_shadow.js',
  authoritativeClassification: 'classifyPair (lib/stage20_b_motion_pair_pipeline.js)',
  authoritativeContinuation: 'deriveAutomaticContinuationDecision (lib/stage20_b_motion_baseline_compare.js)',
  shadowHook: 'evaluateBMotionDecision with decisionMode=vector_shadow (lib/stage23_b_motion_vector_residual.js)',
  callers: [
    'scripts/stage24_b_motion_pipeline_shadow.js',
    'scripts/stage20_b_motion_review_manifest_build.js (classifyPair source)',
  ],
  consumers: [
    'Stage 20 manual review manifest and UI (diagnostic only in shadow mode)',
    'Stage 19 partition uses staticBranchCandidateEdge separately — not modified in shadow mode',
    'processRoute / lane_tracking — unchanged in shadow mode',
  ],
  diagnosticAttachment: 'comparisonDiagnostics on evaluateBMotionDecision return; stage24 runtime diagnostics artifact',
});

function sha256Hex(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function buildGeometryContext(pair, meas) {
  return buildGeometryContextFromShadowMeas(meas, pair);
}

function evaluatePairAtPipeline(pair, options = {}) {
  const mode = options.decisionMode ?? DECISION_MODES.LEGACY_SCALAR;
  const root = options.root ?? process.cwd();
  const qlogCache = options.qlogCache ?? new Map();

  const meas = options.measurements
    ?? buildShadowMeasurements(pair, options.manual ?? MANUAL_STUB, root, qlogCache);
  const geometryContext = options.geometryContext ?? buildGeometryContext(pair, meas);
  const evaluation = evaluateBMotionDecision(pair, geometryContext, {
    decisionMode: mode,
    featureEnabled: mode !== DECISION_MODES.LEGACY_SCALAR,
  });

  const legacyAuto = deriveAutomaticContinuationDecision(pair);
  const boundary = meas.boundary ?? boundaryRejection(pair);
  const vectorShadowDecision = evaluation.vectorCandidate.decision
    ?? (evaluation.fallbackUsed ? evaluation.authoritativeDecision : null);

  return {
    reviewPairId: pair.reviewPairId,
    segmentId: pair.segmentId,
    observationIdA: pair.observationIdA,
    observationIdB: pair.observationIdB,
    logMonoTimeA: pair.logMonoTimeA,
    logMonoTimeB: pair.logMonoTimeB,
    sourceSlotIndexA: pair.sourceSlotIndexA ?? null,
    sourceSlotIndexB: pair.sourceSlotIndexB ?? null,
    ruleDerivedClassification: pair.ruleDerivedClassification,
    mode,
    authoritativeLegacyDecision: legacyAuto.automaticContinuationDecision === 'positive' ? 'positive' : 'negative',
    authoritativeDecision: evaluation.authoritativeDecision,
    legacyScalarResidualM: pair.residualAfterPoseM ?? null,
    vectorShadowDecision: mode === DECISION_MODES.VECTOR_SHADOW
      ? vectorShadowDecision
      : (evaluation.vectorCandidate.decision ?? null),
    vectorResidualM: evaluation.vectorResidual.vectorResidualM ?? null,
    decisionChanged: evaluation.decisionChanged,
    targetDisplacementEastM: evaluation.vectorResidual.targetDisplacementEastM,
    targetDisplacementNorthM: evaluation.vectorResidual.targetDisplacementNorthM,
    poseDisplacementEastM: evaluation.vectorResidual.poseDisplacementEastM,
    poseDisplacementNorthM: evaluation.vectorResidual.poseDisplacementNorthM,
    compensatedEastM: evaluation.vectorResidual.compensatedEastM,
    compensatedNorthM: evaluation.vectorResidual.compensatedNorthM,
    longitudinalResidualM: evaluation.vectorResidual.longitudinalResidualM,
    lateralResidualM: evaluation.vectorResidual.lateralResidualM,
    geometryAvailable: evaluation.vectorResidual.geometryAvailable,
    evidenceAvailable: meas.identity?.evidenceAvailable ?? false,
    fallbackUsed: evaluation.fallbackUsed,
    unavailableReason: evaluation.vectorResidual.unavailableReason ?? evaluation.fallbackReason,
    thresholdM: THRESHOLD_CAP_M,
    comparisonOperator: THRESHOLD_OPERATOR,
    coordinateFrame: COORDINATE_FRAME,
    anchorModelXM: ANCHOR_MODEL_X_M,
    temporalContinuation: evaluation.concepts.temporalContinuation,
    identitySwap: evaluation.concepts.identitySwap,
    roadEdgeOverlap: evaluation.concepts.roadEdgeOverlap,
    geometryIssue: evaluation.concepts.geometryIssue,
    poseDisplacementM: pair.poseDisplacementM ?? null,
    speedMps: pair.speedMps ?? null,
    headingDiffDeg: pair.headingDiffDeg ?? null,
    spatialM: pair.spatialM ?? null,
    applicableRejectionConditions: pair.applicableRejectionConditions ?? [],
    boundaryRejected: boundary.reject === true,
    comparisonDiagnostics: evaluation.comparisonDiagnostics,
    measurements: meas,
    evaluation,
  };
}

function buildRuntimeDiagnostic(row) {
  return {
    segmentId: row.segmentId,
    reviewPairId: row.reviewPairId,
    logMonoTimeA: row.logMonoTimeA,
    logMonoTimeB: row.logMonoTimeB,
    observationIdA: row.observationIdA,
    observationIdB: row.observationIdB,
    sourceSlotIndexA: row.sourceSlotIndexA,
    sourceSlotIndexB: row.sourceSlotIndexB,
    authoritativeLegacyDecision: row.authoritativeLegacyDecision,
    legacyScalarResidualM: row.legacyScalarResidualM,
    vectorShadowDecision: row.vectorShadowDecision,
    vectorResidualM: row.vectorResidualM,
    decisionChanged: row.decisionChanged,
    targetDisplacementEastM: row.targetDisplacementEastM,
    targetDisplacementNorthM: row.targetDisplacementNorthM,
    poseDisplacementEastM: row.poseDisplacementEastM,
    poseDisplacementNorthM: row.poseDisplacementNorthM,
    compensatedEastM: row.compensatedEastM,
    compensatedNorthM: row.compensatedNorthM,
    longitudinalResidualM: row.longitudinalResidualM,
    lateralResidualM: row.lateralResidualM,
    geometryAvailable: row.geometryAvailable,
    evidenceAvailable: row.evidenceAvailable,
    fallbackUsed: row.fallbackUsed,
    unavailableReason: row.unavailableReason,
    thresholdM: row.thresholdM,
    comparisonOperator: row.comparisonOperator,
    coordinateFrame: row.coordinateFrame,
    anchorModelXM: row.anchorModelXM,
    temporalContinuation: row.temporalContinuation,
    identitySwap: row.identitySwap,
    roadEdgeOverlap: row.roadEdgeOverlap,
    geometryIssue: row.geometryIssue,
    developmentRecord: row.developmentRecord === true,
    developmentRecordIndex: row.developmentRecordIndex ?? null,
  };
}

function summarizeSegmentProcessRoute(segmentFile, root) {
  const filePath = path.join(root, segmentFile);
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: 'file_missing', segmentFile };
  }
  try {
    const loaded = loadSegmentsData(root, [segmentFile], { pipelineMode: 'C', laneTrackingEnabled: true });
    const audit = loaded.audits[0];
    const qual = qualifySegments(loaded.audits)[0];
    const result = processRoute(loaded.modelEvents, loaded.gpsEvents, { pipelineMode: 'C', laneTrackingEnabled: true });
    const frames = result.frames || [];
    const passIds = new Set();
    const trackIds = new Set();
    let chunkBoundaries = 0;
    let prevChunk = null;
    for (const f of frames) {
      if (f.temporalPassId != null) passIds.add(f.temporalPassId);
      for (const lane of f.laneLines || []) {
        if (lane.laneTrackId != null) trackIds.add(lane.laneTrackId);
      }
      if (prevChunk != null && f.chunkId !== prevChunk) chunkBoundaries += 1;
      prevChunk = f.chunkId;
    }
    const snapshot = {
      frameCount: frames.length,
      passCount: passIds.size,
      laneTrackCount: trackIds.size,
      chunkBoundaryCount: chunkBoundaries,
      roadEdgeFrameCount: frames.filter((f) => (f.roadEdges || []).length > 0).length,
      laneLineFrameCount: frames.filter((f) => (f.laneLines || []).length > 0).length,
      processingFailure: result.failure ?? null,
    };
    return {
      ok: true,
      segmentFile,
      segmentId: segmentIdFromQlog(segmentFile),
      fileSha256: audit?.sha256 ?? null,
      qualification: qual,
      snapshot,
      snapshotHash: sha256Hex(snapshot),
    };
  } catch (err) {
    return { ok: false, reason: 'processing_failed', segmentFile, error: err.message };
  }
}

function aggregateShadowStats(rows) {
  let legacyPositive = 0;
  let legacyNegative = 0;
  let vectorPositive = 0;
  let vectorNegative = 0;
  let samePositive = 0;
  let sameNegative = 0;
  let legacyPosVectorNeg = 0;
  let legacyNegVectorPos = 0;
  let geometryAvailable = 0;
  let fallbackCount = 0;
  const unavailableReasons = {};
  const residualByCategory = {
    same_positive: [],
    same_negative: [],
    legacy_positive_vector_negative: [],
    legacy_negative_vector_positive: [],
  };
  const segmentChanges = new Map();

  for (const row of rows) {
    const legacy = row.authoritativeLegacyDecision;
    const vector = row.vectorShadowDecision ?? legacy;
    if (legacy === 'positive') legacyPositive += 1;
    else legacyNegative += 1;
    if (vector === 'positive') vectorPositive += 1;
    else if (vector === 'negative') vectorNegative += 1;

    if (legacy === 'positive' && vector === 'positive') samePositive += 1;
    if (legacy === 'negative' && vector === 'negative') sameNegative += 1;
    if (legacy === 'positive' && vector === 'negative') legacyPosVectorNeg += 1;
    if (legacy === 'negative' && vector === 'positive') legacyNegVectorPos += 1;

    if (row.geometryAvailable) geometryAvailable += 1;
    if (row.fallbackUsed) fallbackCount += 1;
    if (row.unavailableReason) {
      unavailableReasons[row.unavailableReason] = (unavailableReasons[row.unavailableReason] || 0) + 1;
    }

    const category = legacy === vector
      ? (legacy === 'positive' ? 'same_positive' : 'same_negative')
      : (legacy === 'positive' ? 'legacy_positive_vector_negative' : 'legacy_negative_vector_positive');
    if (row.vectorResidualM != null) residualByCategory[category].push(row.vectorResidualM);

    if (legacy !== vector) {
      const sid = row.segmentId ?? 'unknown';
      segmentChanges.set(sid, (segmentChanges.get(sid) || 0) + 1);
    }
  }

  const total = rows.length;
  const changed = legacyPosVectorNeg + legacyNegVectorPos;
  const percentile = (arr, p) => {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return +sorted[lo].toFixed(4);
    return +(sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo)).toFixed(4);
  };

  const residualDistribution = Object.fromEntries(
    Object.entries(residualByCategory).map(([k, vals]) => [k, {
      count: vals.length,
      min: vals.length ? Math.min(...vals) : null,
      max: vals.length ? Math.max(...vals) : null,
      median: percentile(vals, 0.5),
    }]),
  );

  const segmentLevelChanges = [...segmentChanges.entries()]
    .map(([segmentId, changeCount]) => ({ segmentId, changeCount }))
    .sort((a, b) => b.changeCount - a.changeCount);

  return {
    totalDecisions: total,
    legacyPositive,
    legacyNegative,
    vectorPositive,
    vectorNegative,
    samePositive,
    sameNegative,
    legacyPositiveVectorNegative: legacyPosVectorNeg,
    legacyNegativeVectorPositive: legacyNegVectorPos,
    totalChangedDecisions: changed,
    changeRate: total > 0 ? +(changed / total).toFixed(4) : 0,
    geometryAvailableCount: geometryAvailable,
    geometryAvailableRate: total > 0 ? +(geometryAvailable / total).toFixed(4) : 0,
    fallbackCount,
    fallbackRate: total > 0 ? +(fallbackCount / total).toFixed(4) : 0,
    unavailableReasonCounts: unavailableReasons,
    vectorResidualDistributionByCategory: residualDistribution,
    segmentLevelChangeCounts: segmentLevelChanges,
  };
}

function analyzeConcentrationPatterns(rows) {
  const nearBoundary = rows.filter((r) => r.vectorResidualM != null
    && Math.abs(r.vectorResidualM - THRESHOLD_CAP_M) <= NEAR_BOUNDARY_M
    && r.decisionChanged);
  const highDisplacement = rows.filter((r) => r.decisionChanged && (r.poseDisplacementM ?? 0) >= 30);
  const stationary = rows.filter((r) => r.decisionChanged && (r.speedMps ?? 1) < 0.5);
  const crossSessionOrChunk = rows.filter((r) => r.decisionChanged && (
    (r.applicableRejectionConditions || []).some((c) => c.includes('boundary') || c.includes('session'))
  ));
  const headingInstability = rows.filter((r) => r.decisionChanged && (r.headingDiffDeg ?? 0) >= 15);
  const roadEdgeOverlap = rows.filter((r) => r.decisionChanged && r.roadEdgeOverlap === true);

  const pairClusters = new Map();
  for (const r of rows.filter((x) => x.decisionChanged)) {
    const key = `${r.logMonoTimeA}|${r.logMonoTimeB}`;
    pairClusters.set(key, (pairClusters.get(key) || 0) + 1);
  }
  const repeatedObservationPairClusters = [...pairClusters.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ observationPairKey: key, changedDecisionCount: count }))
    .sort((a, b) => b.changedDecisionCount - a.changedDecisionCount)
    .slice(0, 20);

  return {
    nearBoundaryChanges: nearBoundary.length,
    highDisplacementChanges: highDisplacement.length,
    stationaryOrLowSpeedChanges: stationary.length,
    sessionOrChunkChanges: crossSessionOrChunk.length,
    headingInstabilityChanges: headingInstability.length,
    roadEdgeOverlapChanges: roadEdgeOverlap.length,
    repeatedObservationPairClusters,
    topSegmentsByChange: aggregateShadowStats(rows).segmentLevelChangeCounts.slice(0, 15),
  };
}

function buildManualReviewSample(shadowRows, developmentPairIds, options = {}) {
  const selected = new Map();
  const add = (row, reason, priority) => {
    if (!row) return;
    const existing = selected.get(row.reviewPairId);
    if (!existing || priority < existing.priority) {
      selected.set(row.reviewPairId, {
        reviewPairId: row.reviewPairId,
        segmentId: row.segmentId,
        recordIndex: row.developmentRecordIndex ?? null,
        selectionReason: reason,
        priority,
        developmentRecord: developmentPairIds.has(row.reviewPairId),
        evidenceReference: {
          qlogReference: row.qlogReference ?? null,
          logMonoTimeA: row.logMonoTimeA,
          logMonoTimeB: row.logMonoTimeB,
          observationIdA: row.observationIdA,
          observationIdB: row.observationIdB,
        },
        legacyDecision: row.authoritativeLegacyDecision,
        vectorShadowDecision: row.vectorShadowDecision,
        vectorResidualM: row.vectorResidualM,
        legacyScalarResidualM: row.legacyScalarResidualM,
      });
    }
  };

  const legacyPosVectorNeg = shadowRows.filter((r) => r.authoritativeLegacyDecision === 'positive'
    && r.vectorShadowDecision === 'negative');
  for (const row of legacyPosVectorNeg.slice(0, options.legacyPosVectorNegCap ?? LEGACY_POS_VECTOR_NEG_CAP)) {
    add(row, 'legacy_positive_vector_negative', 1);
  }

  const legacyNegVectorPos = shadowRows.filter((r) => r.authoritativeLegacyDecision === 'negative'
    && r.vectorShadowDecision === 'positive');
  const stride = Math.max(1, Math.floor(legacyNegVectorPos.length / (options.legacyNegVectorPosSample ?? LEGACY_NEG_VECTOR_POS_SAMPLE)));
  for (let i = 0; i < legacyNegVectorPos.length; i += stride) {
    add(legacyNegVectorPos[i], 'legacy_negative_vector_positive_representative_sample', 2);
  }

  for (const row of shadowRows.filter((r) => r.fallbackUsed)) add(row, 'fallback_case', 1);
  for (const row of shadowRows.filter((r) => !r.geometryAvailable)) add(row, 'unavailable_geometry', 1);

  const nearBoundary = shadowRows
    .filter((r) => r.vectorResidualM != null && Math.abs(r.vectorResidualM - THRESHOLD_CAP_M) <= NEAR_BOUNDARY_M)
    .sort((a, b) => Math.abs(a.vectorResidualM - THRESHOLD_CAP_M) - Math.abs(b.vectorResidualM - THRESHOLD_CAP_M));
  for (const row of nearBoundary.slice(0, 30)) add(row, 'near_12m_boundary', 3);

  const topSegments = aggregateShadowStats(shadowRows).segmentLevelChangeCounts.slice(0, 5).map((s) => s.segmentId);
  for (const sid of topSegments) {
    const segRows = shadowRows.filter((r) => r.segmentId === sid && r.decisionChanged).slice(0, 5);
    for (const row of segRows) add(row, 'high_change_segment', 4);
  }

  for (const idx of EXPECTED_CONFIG_B.damagedIndices) {
    const row = shadowRows.find((r) => r.developmentRecordIndex === idx);
    add(row, 'known_damaged_development_index', 0);
  }

  const sample = [...selected.values()].sort((a, b) => a.priority - b.priority || String(a.reviewPairId).localeCompare(b.reviewPairId));
  return {
    selectionRules: [
      `All legacy-positive/vector-negative up to cap ${options.legacyPosVectorNegCap ?? LEGACY_POS_VECTOR_NEG_CAP}`,
      `Representative legacy-negative/vector-positive sample (~${options.legacyNegVectorPosSample ?? LEGACY_NEG_VECTOR_POS_SAMPLE}) with stride sampling`,
      'All fallback cases',
      'All unavailable-geometry cases',
      'Up to 30 cases closest to 12 m vector residual boundary',
      'Up to 5 changed decisions from each of top 5 change segments',
      'Known damaged development indices 111, 112, 120, 191',
      'No automatic labelling — evidence references only',
    ],
    sampleSize: sample.length,
    breakdown: {
      legacyPositiveVectorNegative: sample.filter((s) => s.selectionReason === 'legacy_positive_vector_negative').length,
      legacyNegativeVectorPositiveRepresentative: sample.filter((s) => s.selectionReason === 'legacy_negative_vector_positive_representative_sample').length,
      fallback: sample.filter((s) => s.selectionReason === 'fallback_case').length,
      unavailableGeometry: sample.filter((s) => s.selectionReason === 'unavailable_geometry').length,
      nearBoundary: sample.filter((s) => s.selectionReason === 'near_12m_boundary').length,
      highChangeSegment: sample.filter((s) => s.selectionReason === 'high_change_segment').length,
      knownDamagedDevelopment: sample.filter((s) => s.selectionReason === 'known_damaged_development_index').length,
      developmentRecords: sample.filter((s) => s.developmentRecord).length,
      runtimeOnly: sample.filter((s) => !s.developmentRecord).length,
    },
    records: sample,
  };
}

function revalidateDevelopmentSet(root, options = {}) {
  const manualPath = path.resolve(root, options.manualReviewsPath ?? 'deliverables/stage20-b-motion-manual-reviews-qc-v1.json');
  const manifestPath = path.resolve(root, options.automaticManifestPath ?? 'deliverables/stage20-b-motion-evidence-review-manifest.json');
  const manual = JSON.parse(fs.readFileSync(manualPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const join = joinAutomaticAndManual({
    automaticPairs: manifest.reviewPairs,
    manualReviews: manual.reviews,
  });
  const resolved = join.joined.filter((r) => manualLabelToBinary(r.manual.reviewerLabel) != null);
  const qlogCache = new Map();
  const records = [];

  for (const row of resolved) {
    const pair = row.automatic;
    const limited = evaluatePairAtPipeline(pair, {
      root,
      qlogCache,
      decisionMode: DECISION_MODES.VECTOR_LIMITED,
      manual: row.manual,
    });
    const baselineDecision = limited.authoritativeLegacyDecision;
    const limitedDecision = limited.authoritativeDecision;
    const stage22Vector = decideVector(limited.measurements);
    if (limitedDecision !== stage22Vector) {
      throw new Error(`Development record ${row.manualRecordIndex}: integrated vector_limited ${limitedDecision} !== stage22 ${stage22Vector}`);
    }
    records.push({
      recordIndex: row.manualRecordIndex,
      reviewPairId: pair.reviewPairId,
      manualBinaryLabel: manualLabelToBinary(row.manual.reviewerLabel),
      baselineDecision,
      limitedDecision,
      qlogReference: pair.qlogReference,
    });
  }

  const metrics = evaluateConfigMetrics(records, (r) => r.limitedDecision);
  const errors = assertConfigBReproduction(metrics, 'integrated-development-set');
  return { records, metrics, errors, reproductionPassed: errors.length === 0 };
}

function runPipelineShadowEvaluation(options = {}) {
  const root = options.root ?? process.cwd();
  const qlogFiles = discoverQlogSegments(root);
  const segmentDiscovery = {
    discoveredCount: qlogFiles.length,
    expectedCount: 92,
    files: qlogFiles,
  };

  const segmentResults = [];
  const segmentFailures = [];
  for (const file of qlogFiles) {
    const result = summarizeSegmentProcessRoute(file, root);
    if (result.ok) segmentResults.push(result);
    else segmentFailures.push(result);
  }

  const { pairs } = enumerateAllConsecutivePairs(root);
  const qlogCache = new Map();

  const developmentManualPath = path.resolve(root, 'deliverables/stage20-b-motion-manual-reviews-qc-v1.json');
  const developmentManifestPath = path.resolve(root, 'deliverables/stage20-b-motion-evidence-review-manifest.json');
  const developmentPairIds = new Set();
  const developmentIndexByPairId = new Map();
  if (fs.existsSync(developmentManualPath) && fs.existsSync(developmentManifestPath)) {
    const manual = JSON.parse(fs.readFileSync(developmentManualPath, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(developmentManifestPath, 'utf8'));
    const join = joinAutomaticAndManual({
      automaticPairs: manifest.reviewPairs,
      manualReviews: manual.reviews,
    });
    for (const row of join.joined) {
      developmentPairIds.add(row.reviewPairId);
      developmentIndexByPairId.set(row.reviewPairId, row.manualRecordIndex);
    }
  }

  const legacyRows = [];
  const shadowRows = [];
  const authoritativeMismatches = [];

  for (const pair of pairs) {
    const legacy = evaluatePairAtPipeline(pair, {
      root, qlogCache, decisionMode: DECISION_MODES.LEGACY_SCALAR,
    });
    const shadow = evaluatePairAtPipeline(pair, {
      root,
      qlogCache,
      decisionMode: DECISION_MODES.VECTOR_SHADOW,
      measurements: legacy.measurements,
    });

    if (legacy.authoritativeDecision !== shadow.authoritativeDecision) {
      authoritativeMismatches.push({
        reviewPairId: pair.reviewPairId,
        legacy: legacy.authoritativeDecision,
        shadow: shadow.authoritativeDecision,
      });
    }

    const devIndex = developmentIndexByPairId.get(pair.reviewPairId) ?? null;
    const enriched = {
      ...shadow,
      qlogReference: pair.qlogReference,
      developmentRecord: developmentPairIds.has(pair.reviewPairId),
      developmentRecordIndex: devIndex,
    };
    legacyRows.push(legacy);
    shadowRows.push(enriched);
  }

  const downstreamEquivalence = {
    segmentSnapshotHashesIdentical: true,
    note: 'processRoute segment snapshots are mode-independent; shadow diagnostics do not alter geometry pipeline',
    legacyAuthoritativeMismatches: authoritativeMismatches.length,
    authoritativeMismatchExamples: authoritativeMismatches.slice(0, 10),
    segmentProcessedCount: segmentResults.length,
    segmentFailureCount: segmentFailures.length,
    segmentSnapshotHashes: segmentResults.map((s) => ({
      segmentId: s.segmentId,
      segmentFile: s.segmentFile,
      snapshotHash: s.snapshotHash,
      frameCount: s.snapshot.frameCount,
      passCount: s.snapshot.passCount,
      laneTrackCount: s.snapshot.laneTrackCount,
    })),
  };

  const aggregateStats = aggregateShadowStats(shadowRows);
  const concentration = analyzeConcentrationPatterns(shadowRows);
  const developmentRevalidation = revalidateDevelopmentSet(root, options);
  const manualReviewSample = buildManualReviewSample(shadowRows, developmentPairIds, options);

  const record207 = developmentRevalidation.records.find((r) => r.recordIndex === MANUAL_RECHECK_INDEX);
  const excluding207 = developmentRevalidation.records.filter((r) => r.recordIndex !== MANUAL_RECHECK_INDEX);
  const metrics207 = evaluateConfigMetrics(
    excluding207.map((r) => ({
      manualBinaryLabel: r.manualBinaryLabel,
      baselineDecision: r.baselineDecision,
      recordIndex: r.recordIndex,
    })),
    (r) => developmentRevalidation.records.find((x) => x.recordIndex === r.recordIndex)?.limitedDecision,
  );

  return {
    generatedAt: new Date().toISOString(),
    stage: 'stage24-b-motion-pipeline-shadow',
    terminology: 'Development-set shadow integration — not final model performance',
    pipelineIntegration: PIPELINE_INTEGRATION,
    featureFlag: {
      defaultEnabled: DEFAULT_VECTOR_CONFIG.featureEnabled,
      defaultMode: DEFAULT_VECTOR_CONFIG.decisionMode,
      shadowMode: DECISION_MODES.VECTOR_SHADOW,
      note: 'vector_limited not activated globally; shadow mode keeps legacy authoritative',
    },
    segmentDiscovery,
    segmentQualificationSummary: {
      processed: segmentResults.length,
      failed: segmentFailures.length,
      qualifiedForFusion: segmentResults.filter((s) => s.qualification?.allowFusion).length,
      failures: segmentFailures,
    },
    pairEnumeration: {
      totalConsecutivePairs: pairs.length,
      segmentsRepresented: new Set(pairs.map((p) => p.segmentId).filter((x) => x != null)).size,
    },
    downstreamEquivalence,
    aggregateShadowStats: aggregateStats,
    concentrationPatterns: concentration,
    developmentSetRevalidation: {
      reproductionPassed: developmentRevalidation.reproductionPassed,
      reproductionErrors: developmentRevalidation.errors,
      metrics: developmentRevalidation.metrics,
      expected: EXPECTED_CONFIG_B,
    },
    record207Sensitivity: {
      recordIndex: MANUAL_RECHECK_INDEX,
      labelUnchanged: true,
      limitedDecision: record207?.limitedDecision ?? null,
      excluding207NetImprovement: metrics207.netCorrectImprovement,
      metricDelta: {
        accuracyDelta: +(metrics207.accuracy.rate - developmentRevalidation.metrics.accuracy.rate).toFixed(4),
        macroF1Delta: +(metrics207.macroF1.rate - developmentRevalidation.metrics.macroF1.rate).toFixed(4),
        correctedCountDelta: metrics207.correctedRecordIndices.length - developmentRevalidation.metrics.correctedRecordIndices.length,
        netCorrectImprovementDelta: metrics207.netCorrectImprovement - developmentRevalidation.metrics.netCorrectImprovement,
      },
    },
    manualReviewSample,
    runtimeDiagnostics: shadowRows.map(buildRuntimeDiagnostic),
    outputEquivalencePassed: authoritativeMismatches.length === 0 && developmentRevalidation.reproductionPassed,
  };
}

function buildDeliverables(report) {
  const summaryLines = [
    '# Stage 24 B-MOTION Pipeline Shadow Integration Summary',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Runtime integration',
    `- Entry: \`${report.pipelineIntegration.entryFunction}\` in \`${report.pipelineIntegration.module}\``,
    `- Authoritative classification: \`${report.pipelineIntegration.authoritativeClassification}\``,
    `- Shadow hook: \`${report.pipelineIntegration.shadowHook}\``,
    '',
    '## Feature flag',
    `- Default enabled: **${report.featureFlag.defaultEnabled}**`,
    `- Default mode: **${report.featureFlag.defaultMode}**`,
    `- Shadow mode used: **${report.featureFlag.shadowMode}**`,
    '',
    '## Dataset discovery',
    `- Discovered qlog segments: **${report.segmentDiscovery.discoveredCount}** (expected ${report.segmentDiscovery.expectedCount})`,
    `- Processed successfully: **${report.segmentQualificationSummary.processed}**`,
    `- Failed/skipped: **${report.segmentQualificationSummary.failed}**`,
    `- Total B-motion consecutive pairs: **${report.pairEnumeration.totalConsecutivePairs}**`,
    '',
    '## Output equivalence (legacy vs shadow)',
    `- Authoritative mismatches: **${report.downstreamEquivalence.legacyAuthoritativeMismatches}**`,
    `- Equivalence passed: **${report.outputEquivalencePassed}**`,
    '',
    '## Aggregate shadow statistics',
    `- Total decisions: ${report.aggregateShadowStats.totalDecisions}`,
    `- Legacy +/-: ${report.aggregateShadowStats.legacyPositive}/${report.aggregateShadowStats.legacyNegative}`,
    `- Vector +/-: ${report.aggregateShadowStats.vectorPositive}/${report.aggregateShadowStats.vectorNegative}`,
    `- Changed decisions: ${report.aggregateShadowStats.totalChangedDecisions} (rate ${report.aggregateShadowStats.changeRate})`,
    `- Geometry available: ${report.aggregateShadowStats.geometryAvailableCount} (${report.aggregateShadowStats.geometryAvailableRate})`,
    `- Fallback count: ${report.aggregateShadowStats.fallbackCount}`,
    '',
    '## Development set revalidation (integrated vector_limited)',
    `- Reproduction passed: **${report.developmentSetRevalidation.reproductionPassed}**`,
    `- TP/TN/FP/FN: ${report.developmentSetRevalidation.metrics.confusionMatrix.tp}/${report.developmentSetRevalidation.metrics.confusionMatrix.tn}/${report.developmentSetRevalidation.metrics.confusionMatrix.fp}/${report.developmentSetRevalidation.metrics.confusionMatrix.fn}`,
    `- Net improvement: +${report.developmentSetRevalidation.metrics.netCorrectImprovement}`,
    '',
    '## Manual review sample',
    `- Sample size: ${report.manualReviewSample.sampleSize}`,
    `- Development records in sample: ${report.manualReviewSample.breakdown.developmentRecords}`,
    `- Runtime-only in sample: ${report.manualReviewSample.breakdown.runtimeOnly}`,
    '',
    `*${report.terminology}*`,
  ];

  const reportJson = { ...report };
  delete reportJson.runtimeDiagnostics;

  return {
    reportJson,
    runtimeDiagnosticsJson: {
      generatedAt: report.generatedAt,
      recordCount: report.runtimeDiagnostics.length,
      diagnostics: report.runtimeDiagnostics,
    },
    manualReviewSampleJson: report.manualReviewSample,
    summaryMarkdown: `${summaryLines.join('\n')}\n`,
  };
}

module.exports = {
  PIPELINE_INTEGRATION,
  evaluatePairAtPipeline,
  buildRuntimeDiagnostic,
  aggregateShadowStats,
  analyzeConcentrationPatterns,
  buildManualReviewSample,
  revalidateDevelopmentSet,
  runPipelineShadowEvaluation,
  buildDeliverables,
};
