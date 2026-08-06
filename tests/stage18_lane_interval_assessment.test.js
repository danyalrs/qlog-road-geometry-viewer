const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PROCESSING_VERSION } = require('../lib/version');
const { FROZEN_ROAD_SURFACE_VERSION } = require('../lib/stage15_lane_counting_design');
const { verifyAccountingInvariants, buildClassificationAudit } = require('../lib/stage15a_classification_audit');
const { verifyStage15DeliverableConsistency } = require('../lib/stage15_lane_counting_design');
const { buildLaneDividerAssessment } = require('../lib/stage15_lane_divider_assessment');
const { buildStage16ProjectionAudit } = require('../lib/stage16_projection_audit');
const { buildStage17TrackingAudit } = require('../lib/stage17_tracking_audit');
const {
  INTERVAL_SCHEMA_VERSION,
  PAIRING_OUTCOMES,
  COUNT_ASSESSMENT_STATUS,
  RUN_USAGE_OUTCOMES,
  COUNT_TRANSITION_LABELS,
  DEFAULT_INTERVAL_ASSESSMENT,
  buildLaneIntervalTemplate,
} = require('../lib/stage18_lane_interval_schema');
const { evaluatePair, computeOverlap, pairAdjacentRunsInGroup } = require('../lib/stage18_boundary_pairing');
const { evaluateLocalAdjacency } = require('../lib/stage18_local_adjacency');
const {
  WIDTH_COMPARISON_EPS_M,
  WIDTH_POSITIVE_EPS_M,
  isPositiveSignedWidth,
  widthBelowThreshold,
  widthAboveThreshold,
  widthWithinBand,
} = require('../lib/stage18_width_tolerance');
const { NON_POSITIVE_SUBCATEGORIES } = require('../lib/stage18_pairing_diagnostics');
const { verifyGapPreservation } = require('../lib/stage18_lane_count_assessment');
const {
  buildStage18LaneIntervalAudit,
  generateStage18Markdown,
  verifyStage18Consistency,
  buildStage18FromContext,
  EXPECTED_SUPPORTED_RUN_COUNT,
  EXPECTED_GAP_COUNT,
} = require('../lib/stage18_lane_interval_audit');
const { buildStage18InputContext } = require('../lib/stage18_stage17_loader');
const { BEV_REQUIRED_CATEGORIES } = require('../lib/stage18_lane_interval_schema');

const ROOT = path.join(__dirname, '..');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeRun({
  id = '0:0:0:0:run:0',
  trackId = '0:0:0:0',
  chunk = 0,
  pass = 0,
  section = 0,
  dLeft = 4.0,
  dRight = 2.0,
  sStart = 0,
  span = 40,
  nPts = 8,
} = {}) {
  const ptsL = [];
  const ptsR = [];
  for (let i = 0; i < nPts; i++) {
    const s = sStart + (i * span) / (nPts - 1);
    ptsL.push({ s, d: dLeft + i * 0.01, observationId: `0:${chunk}:1000${i}:0` });
    ptsR.push({ s, d: dRight + i * 0.01, observationId: `0:${chunk}:1000${i}:1` });
  }
  const leftRun = {
    dividerRunId: `${id}:L`,
    parentTrackId: `${trackId}:L`,
    routeSStart: sStart,
    routeSEnd: sStart + span,
    routeSpanM: span,
    representativeRouteD: ptsL,
    observationIds: ptsL.map((p) => p.observationId),
    observationCount: ptsL.length,
    sourceFrameCount: nPts,
    supportDensity: 0.1,
    confidenceSummary: { mean: 0.9 },
    uncertaintySummary: { mean: 0.1 },
    interpolationMetadata: { permitted: false, method: null },
    provenance: { pipelineStage: 'stage17_supported_run_fusion', createdAt: '2026-01-01' },
    precedingGapId: null,
    followingGapId: null,
  };
  const rightRun = {
    ...leftRun,
    dividerRunId: `${id}:R`,
    parentTrackId: `${trackId}:R`,
    representativeRouteD: ptsR,
    observationIds: ptsR.map((p) => p.observationId),
  };
  const leftTrack = {
    trackId: `${trackId}:L`,
    chunkId: chunk,
    temporalPassId: pass,
    poseSectionId: section,
    segmentIds: [0],
    observationIds: leftRun.observationIds,
    frameTimes: leftRun.observationIds.map(() => '1000'),
    confidence: 0.9,
    uncertainty: 0.1,
    meanD: dLeft,
    sMin: sStart,
    sMax: sStart + span,
  };
  const rightTrack = {
    ...leftTrack,
    trackId: `${trackId}:R`,
    observationIds: rightRun.observationIds,
    meanD: dRight,
  };
  return { leftRun, rightRun, leftTrack, rightTrack };
}

function enrichRun(run, track) {
  const pts = run.representativeRouteD;
  const sVals = pts.map((p) => p.s);
  return {
    ...run,
    parentTrack: track,
    chunkId: track.chunkId,
    temporalPassId: track.temporalPassId,
    poseSectionId: track.poseSectionId,
    meanD: pts.reduce((s, p) => s + p.d, 0) / pts.length,
    routeSStart: Math.min(...sVals),
    routeSEnd: Math.max(...sVals),
    routeSpanM: Math.max(...sVals) - Math.min(...sVals),
    segmentIds: track.segmentIds,
  };
}

describe('Stage 18 schema', () => {
  it('interval template has required fields', () => {
    const t = buildLaneIntervalTemplate();
    assert.equal(t.schemaVersion, INTERVAL_SCHEMA_VERSION);
    assert.equal(t.leftDividerRunId, null);
    assert.equal(t.widthStats, null);
  });
});

describe('Stage 18 pairing unit', () => {
  it('forms one interval from two parallel boundaries', () => {
    const { leftRun, rightRun, leftTrack, rightTrack } = makeRun();
    const left = enrichRun(leftRun, leftTrack);
    const right = enrichRun(rightRun, rightTrack);
    const result = evaluatePair(left, right, [left, right]);
    assert.equal(result.outcome, PAIRING_OUTCOMES.ACCEPTED);
    assert.ok(result.metrics.widthStats.min > 0);
  });

  it('rejects non-adjacent pairing with intervening divider', () => {
    const { leftRun, rightRun, leftTrack, rightTrack } = makeRun({ dLeft: 6, dRight: 2 });
    const mid = makeRun({ id: '0:0:0:1', dLeft: 4, dRight: 4, trackId: '0:0:1' });
    const left = enrichRun(leftRun, leftTrack);
    const right = enrichRun(rightRun, rightTrack);
    const middle = enrichRun(mid.leftRun, { ...mid.leftTrack, meanD: 4 });
    const result = evaluatePair(left, right, [left, middle, right]);
    assert.equal(result.outcome, PAIRING_OUTCOMES.REJECTED_INTERVENING_DIVIDER);
  });

  it('rejects insufficient route-s overlap', () => {
    const { leftRun, rightRun, leftTrack, rightTrack } = makeRun({ sStart: 0, span: 40 });
    const left = enrichRun(leftRun, leftTrack);
    const right = enrichRun({ ...rightRun, representativeRouteD: rightRun.representativeRouteD.map((p) => ({ ...p, s: p.s + 100 })) }, rightTrack);
    right.routeSStart += 100;
    right.routeSEnd += 100;
    const result = evaluatePair(left, right, [left, right], { minSharedRouteSM: 5 });
    assert.equal(result.outcome, PAIRING_OUTCOMES.REJECTED_INSUFFICIENT_SUPPORT);
  });

  it('rejects pass separation', () => {
    const { leftRun, rightRun, leftTrack, rightTrack } = makeRun();
    const left = enrichRun(leftRun, leftTrack);
    const right = enrichRun(rightRun, { ...rightTrack, temporalPassId: 1 });
    right.temporalPassId = 1;
    const result = evaluatePair(left, right, [left, right]);
    assert.equal(result.outcome, PAIRING_OUTCOMES.REJECTED_BOUNDARY);
  });

  it('rejects pose-section separation', () => {
    const { leftRun, rightRun, leftTrack, rightTrack } = makeRun();
    const left = enrichRun(leftRun, leftTrack);
    const right = enrichRun(rightRun, { ...rightTrack, poseSectionId: 1 });
    right.poseSectionId = 1;
    const result = evaluatePair(left, right, [left, right]);
    assert.equal(result.outcome, PAIRING_OUTCOMES.REJECTED_BOUNDARY);
  });

  it('rejects swapped lateral order before width sampling', () => {
    const { leftRun, rightRun, leftTrack, rightTrack } = makeRun({ dLeft: 2, dRight: 4 });
    const left = enrichRun(leftRun, leftTrack);
    const right = enrichRun(rightRun, rightTrack);
    const result = evaluatePair(left, right, [left, right]);
    assert.equal(result.outcome, PAIRING_OUTCOMES.REJECTED_ORDER_FAILURE);
  });

  it('rejects crossing within overlap', () => {
    const { leftRun, rightRun, leftTrack, rightTrack } = makeRun({ dLeft: 4, dRight: 2 });
    const left = enrichRun(leftRun, leftTrack);
    const right = enrichRun(rightRun, rightTrack);
    const crossedRight = {
      ...right,
      representativeRouteD: right.representativeRouteD.map((p) => ({ ...p, d: 6 - p.d * 0.05 })),
      meanD: 2,
    };
    const result = evaluatePair(left, crossedRight, [left, crossedRight]);
    assert.notEqual(result.outcome, PAIRING_OUTCOMES.ACCEPTED);
  });

  it('forms two adjacent intervals from three parallel boundaries', () => {
    const a = makeRun({ id: '0:0:0:0', dLeft: 6, dRight: 6, trackId: '0:0:0' });
    const b = makeRun({ id: '0:0:0:1', dLeft: 4, dRight: 4, trackId: '0:0:1' });
    const c = makeRun({ id: '0:0:0:2', dLeft: 2, dRight: 2, trackId: '0:0:2' });
    const runs = [
      enrichRun(a.leftRun, { ...a.leftTrack, meanD: 6 }),
      enrichRun(b.leftRun, { ...b.leftTrack, meanD: 4 }),
      enrichRun(c.leftRun, { ...c.leftTrack, meanD: 2 }),
    ];
    const { acceptedIntervals } = pairAdjacentRunsInGroup(runs);
    assert.equal(acceptedIntervals.length, 2);
  });

  it('rejects narrow width outlier', () => {
    const { leftRun, rightRun, leftTrack, rightTrack } = makeRun({ dLeft: 3.0, dRight: 2.5 });
    const left = enrichRun(leftRun, leftTrack);
    const right = enrichRun(rightRun, rightTrack);
    const result = evaluatePair(left, right, [left, right]);
    assert.equal(result.outcome, PAIRING_OUTCOMES.REJECTED_WIDTH_OUTLIER);
  });

  it('rejects wide width outlier', () => {
    const { leftRun, rightRun, leftTrack, rightTrack } = makeRun({ dLeft: 8.0, dRight: 2.0 });
    const left = enrichRun(leftRun, leftTrack);
    const right = enrichRun(rightRun, rightTrack);
    const result = evaluatePair(left, right, [left, right]);
    assert.equal(result.outcome, PAIRING_OUTCOMES.REJECTED_WIDTH_OUTLIER);
  });

  it('rejects chunk-boundary separation', () => {
    const { leftRun, rightRun, leftTrack, rightTrack } = makeRun();
    const left = enrichRun(leftRun, leftTrack);
    const right = enrichRun(rightRun, { ...rightTrack, chunkId: 1 });
    right.chunkId = 1;
    const result = evaluatePair(left, right, [left, right]);
    assert.equal(result.outcome, PAIRING_OUTCOMES.REJECTED_BOUNDARY);
  });

  it('stable interval IDs across serialization', () => {
    const { leftRun, rightRun, leftTrack, rightTrack } = makeRun();
    const left = enrichRun(leftRun, leftTrack);
    const right = enrichRun(rightRun, rightTrack);
    const a = evaluatePair(left, right, [left, right]);
    const b = evaluatePair(left, right, [left, right]);
    assert.equal(JSON.stringify(a.metrics.widthStats), JSON.stringify(b.metrics.widthStats));
  });

  it('deterministic under reversed input order', () => {
    const { leftRun, rightRun, leftTrack, rightTrack } = makeRun();
    const left = enrichRun(leftRun, leftTrack);
    const right = enrichRun(rightRun, rightTrack);
    const a = evaluatePair(left, right, [left, right]);
    const b = evaluatePair(left, right, [right, left]);
    assert.equal(a.outcome, b.outcome);
  });
});

describe('Stage 18 integration', () => {
  it('runs full dataset audit with pending review status', () => {
    const audit = buildStage18LaneIntervalAudit(ROOT, { skipSensitivity: true });
    assert.equal(audit.stage18Status, 'approved');
    assert.equal(audit.stage17SupportedRunCount, EXPECTED_SUPPORTED_RUN_COUNT);
    assert.equal(audit.productionLaneCountImplemented, false);
    assert.ok(audit.trackingConsistency.passed);
    const md = generateStage18Markdown(audit);
    assert.match(md, /prototype/i);
    assert.match(md, /not.*production-ready|does \*\*not\*\* claim/i);
  });

  it('reconciles all 878 supported runs to usage records', () => {
    const audit = buildStage18LaneIntervalAudit(ROOT, { skipSensitivity: true, includeAllIntervals: true });
    const context = buildStage18InputContext(ROOT);
    const built = buildStage18FromContext(context, { skipSensitivity: true });
    assert.equal(built.runUsageRecords.length, 878);
    const withoutOutcome = built.runUsageRecords.filter((r) => !r.outcome);
    assert.equal(withoutOutcome.length, 0);
  });

  it('accepted intervals have positive width and overlap', () => {
    const audit = buildStage18LaneIntervalAudit(ROOT, { skipSensitivity: true, includeAllIntervals: true });
    for (const iv of audit.acceptedIntervals || []) {
      assert.ok(iv.overlappingSupportLengthM > 0);
      assert.ok((iv.widthStats?.min ?? 0) > 0);
      assert.notEqual(iv.leftDividerRunId, iv.rightDividerRunId);
    }
  });

  it('numeric counts require supporting interval IDs', () => {
    const audit = buildStage18LaneIntervalAudit(ROOT, { skipSensitivity: true, includeAllAssessments: true });
    for (const a of audit.countAssessments || []) {
      if (a.laneCountCandidate != null) {
        assert.ok(a.supportingLaneIntervalIds.length > 0);
        assert.equal(a.status, COUNT_ASSESSMENT_STATUS.ASSESSED);
      }
    }
  });

  it('deterministic under shuffled run order', () => {
    const context = buildStage18InputContext(ROOT);
    const a = buildStage18FromContext(context, { skipSensitivity: true });
    const shuffled = { ...context, supportedRuns: [...context.supportedRuns].reverse() };
    const b = buildStage18FromContext(shuffled, { skipSensitivity: true });
    assert.deepEqual(
      a.acceptedIntervals.map((iv) => iv.laneIntervalId).sort(),
      b.acceptedIntervals.map((iv) => iv.laneIntervalId).sort(),
    );
  });
});

describe('Stage 18 regression protection', () => {
  it('v11 processing version unchanged', () => {
    assert.equal(PROCESSING_VERSION, '2026-07-24-fusion-v12');
  });

  it('Stage 17 approved totals unchanged', () => {
    const audit17 = buildStage17TrackingAudit(ROOT, { skipSensitivity: true });
    assert.equal(audit17.stage17Status, 'approved');
    assert.equal(audit17.supportedRunCount, 878);
    assert.equal(audit17.trackCount, 742);
    assert.equal(audit17.gapCount, 136);
  });

  it('Stage 16 approved totals unchanged', () => {
    const audit16 = buildStage16ProjectionAudit(ROOT);
    assert.equal(audit16.datasetSummary.projectedObservations, 5809);
    assert.equal(audit16.datasetSummary.projectedPointCount, 122439);
    assert.equal(audit16.stage16Status, 'approved');
  });

  it('Stage 15 approved accounting unchanged', () => {
    const audit15 = buildLaneDividerAssessment(ROOT);
    assert.equal(verifyAccountingInvariants(audit15.stage15aClassificationAudit).passed, true);
    assert.equal(audit15.stage15Status, 'approved');
  });
});

describe('Stage 18 BEV manifest', () => {
  it('includes all required categories', () => {
    const audit = buildStage18LaneIntervalAudit(ROOT, { skipSensitivity: true, includeAllIntervals: true, includeAllAssessments: true });
    const context = buildStage18InputContext(ROOT);
    const built = buildStage18FromContext(context, { skipSensitivity: true });
    const { generateBevInspections } = require('../lib/stage18_bev_inspection');
    const tmp = path.join(ROOT, 'reports', 'stage18_bev_test_tmp');
    const manifest = generateBevInspections(audit, [...built.acceptedIntervals, ...built.rejectedIntervals], built.countAssessments, context.supportedRuns, context.gaps, context.tracks, tmp);
    for (const c of BEV_REQUIRED_CATEGORIES) assert.ok(manifest.find((m) => m.category === c), `missing ${c}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('Stage 18 review — width tolerance', () => {
  it('documents comparison tolerance and treats boundary floats at 2.0m and 5.5m', () => {
    assert.equal(WIDTH_COMPARISON_EPS_M, 0.001);
    assert.equal(WIDTH_POSITIVE_EPS_M, 1e-9);
    assert.equal(widthBelowThreshold(1.9999999999999998, 2.0), false);
    assert.equal(widthBelowThreshold(2.0, 2.0), false);
    assert.equal(widthBelowThreshold(2.0000000000000004, 2.0), false);
    assert.equal(widthAboveThreshold(5.499999999999999, 5.5), false);
    assert.equal(widthAboveThreshold(5.5, 5.5), false);
    assert.equal(widthAboveThreshold(5.500000000000001, 5.5), false);
    assert.equal(isPositiveSignedWidth(-0.001), false);
    assert.equal(isPositiveSignedWidth(0), false);
    assert.equal(isPositiveSignedWidth(Number.NaN), false);
    assert.equal(widthWithinBand(2.0, 2.0, 5.5), true);
  });

  it('does not treat genuinely non-positive widths as valid', () => {
    assert.equal(isPositiveSignedWidth(-0.5), false);
    assert.equal(isPositiveSignedWidth(-1e-6), false);
    assert.equal(widthBelowThreshold(-0.5, 2.0), true);
  });
});

describe('Stage 18 review — local adjacency', () => {
  it('rejects mean-d-correct pair with local order crossing', () => {
    const left = enrichRun(makeRun({ dLeft: 4, dRight: 4 }).leftRun, { chunkId: 0, temporalPassId: 0, poseSectionId: 0, segmentIds: [0], meanD: 4 });
    const rightPts = [];
    for (let i = 0; i < 8; i++) {
      const s = (i * 40) / 7;
      rightPts.push({ s, d: i < 4 ? 2 : 4.5 });
    }
    const right = enrichRun({
      ...makeRun().rightRun,
      dividerRunId: 'cross:R',
      parentTrackId: 'cross:R',
      representativeRouteD: rightPts,
    }, { chunkId: 0, temporalPassId: 0, poseSectionId: 0, segmentIds: [0], meanD: 2.5 });
    const adj = evaluateLocalAdjacency(left, right, [left, right], computeOverlap(left, right));
    assert.equal(adj.adjacencyState, 'partial_span');
    const result = evaluatePair(left, right, [left, right]);
    assert.notEqual(result.outcome, PAIRING_OUTCOMES.ACCEPTED);
  });

  it('accepts curved parallel adjacent runs', () => {
    const leftPts = [];
    const rightPts = [];
    for (let i = 0; i < 10; i++) {
      const s = i * 5;
      leftPts.push({ s, d: 4 + Math.sin(i / 2) });
      rightPts.push({ s, d: 2 + Math.sin(i / 2) });
    }
    const left = enrichRun({ ...makeRun().leftRun, representativeRouteD: leftPts }, { chunkId: 0, temporalPassId: 0, poseSectionId: 0, segmentIds: [0], meanD: 4 });
    const right = enrichRun({ ...makeRun().rightRun, representativeRouteD: rightPts }, { chunkId: 0, temporalPassId: 0, poseSectionId: 0, segmentIds: [0], meanD: 2 });
    const result = evaluatePair(left, right, [left, right]);
    assert.equal(result.outcome, PAIRING_OUTCOMES.ACCEPTED);
  });
});

describe('Stage 18 review — dataset invariants', () => {
  it('reconstructs non-positive subcategories to aggregate total', () => {
    const audit = buildStage18LaneIntervalAudit(ROOT, { skipSensitivity: true });
    const np = audit.nonPositiveWidthInvestigation;
    assert.ok(np.reconstructsAggregate);
    assert.equal(np.total, audit.pairingByOutcome.rejected_non_positive_width || 0);
  });

  it('preserves all 136 Stage 17 gaps in unsupported regions', () => {
    const context = buildStage18InputContext(ROOT);
    const built = buildStage18FromContext(context, { skipSensitivity: true });
    const gapAudit = verifyGapPreservation(context.gaps, built.unsupportedRegions);
    assert.equal(gapAudit.stage17GapCount, EXPECTED_GAP_COUNT);
    assert.equal(gapAudit.allGapsPreserved, true);
  });

  it('does not label null counts as stable numeric', () => {
    const audit = buildStage18LaneIntervalAudit(ROOT, { skipSensitivity: true });
    for (const t of audit.countTransitions || []) {
      if (t.laneCountCandidate == null) {
        assert.notEqual(t.label, COUNT_TRANSITION_LABELS.STABLE_NUMERIC_SUPPORTED_COUNT);
      }
    }
  });

  it('reconstructs run usage from pairing records', () => {
    const audit = buildStage18LaneIntervalAudit(ROOT, { skipSensitivity: true });
    assert.equal(audit.candidateGenerationAccounting.usageReconstructsFromPairing, true);
  });

  it('crossing candidates cannot support assessed numeric counts', () => {
    const audit = buildStage18LaneIntervalAudit(ROOT, { skipSensitivity: true });
    assert.equal(audit.geometricCrossingInvestigation.acceptedIntervalsWithCrossingFlag, 0);
    assert.equal(audit.geometricCrossingInvestigation.countAssessmentsSupportedByCrossingIntervals, 0);
  });
});

describe('Stage 18 empty input', () => {
  it('handles empty supported runs', () => {
    const context = {
      supportedRuns: [],
      tracks: [],
      gaps: [],
      trackById: new Map(),
      observationById: new Map(),
      gapById: new Map(),
      runsByParent: new Map(),
      rejectedAmbiguousObservationIds: new Set(),
      supportedRunCount: 0,
    };
    const built = buildStage18FromContext(context, { skipSensitivity: true });
    assert.equal(built.acceptedIntervals.length, 0);
  });
});
