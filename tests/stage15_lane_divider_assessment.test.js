const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  classifyFrameLines,
  detectOrderCrossing,
  analyzeModelEvents,
  edgeAgreement,
  mergeSegmentDistributions,
} = require('../lib/stage15_lane_evidence');
const {
  buildLaneCountRecordTemplate,
  buildProblemDefinition,
  buildCandidatePipeline,
  proposeThresholdCandidates,
  buildValidationPlan,
  verifyStage15DeliverableConsistency,
  LANE_COUNT_SCHEMA_VERSION,
  FROZEN_ROAD_SURFACE_VERSION,
} = require('../lib/stage15_lane_counting_design');
const {
  summarizeNumeric,
  buildHistogram,
  PROB_BINS,
} = require('../lib/stage15_distributions');
const {
  buildLaneDividerAssessment,
  generateAssessmentMarkdown,
  generateDesignMarkdown,
} = require('../lib/stage15_lane_divider_assessment');

const ROOT = path.join(__dirname, '..');

function sampleModelV2(overrides = {}) {
  return {
    laneLines: [
      { x: [5, 10, 20], y: [1.8, 1.7, 1.6], z: [], t: [] },
      { x: [5, 10, 20], y: [-1.8, -1.7, -1.6], z: [], t: [] },
      { x: [5, 10, 20], y: [5.0, 4.9, 4.8], z: [], t: [] },
      { x: [5, 10, 20], y: [-5.0, -4.9, -4.8], z: [], t: [] },
    ],
    laneLineProbs: [0.95, 0.92, 0.85, 0.15],
    laneLineStds: [0.08, 0.09, 0.12, 0.45],
    roadEdges: [
      { x: [5, 10, 20], y: [6.0, 5.9, 5.8], z: [], t: [] },
      { x: [5, 10, 20], y: [-6.0, -5.9, -5.8], z: [], t: [] },
    ],
    roadEdgeStds: [0.2, 0.18],
    meta: { laneChangeState: 0, desireState: [0, 0, 0, 0] },
    ...overrides,
  };
}

describe('Stage 15 distributions', () => {
  it('summarizeNumeric is deterministic', () => {
    const s = summarizeNumeric([0.1, 0.5, 0.9, 0.5]);
    assert.equal(s.count, 4);
    assert.equal(s.median, 0.5);
    assert.equal(s.min, 0.1);
    assert.equal(s.max, 0.9);
  });

  it('buildHistogram counts bins', () => {
    const h = buildHistogram([0.1, 0.55, 0.85, 0.95], PROB_BINS);
    assert.equal(h.total, 4);
    assert.ok(h.counts.reduce((a, b) => a + b, 0) === 4);
  });
});

describe('Stage 15 lane evidence', () => {
  it('classifies ego and adjacent dividers', () => {
    const frame = classifyFrameLines(sampleModelV2());
    assert.equal(frame.classifications.ego_lane_boundaries.length, 2);
    assert.equal(frame.egoRight.index, 1);
    assert.ok(frame.classifications.probable_adjacent_dividers.includes(2) || frame.classifications.uncertain_outer_lines.includes(2));
    assert.ok(frame.classifications.unclassifiable.includes(3));
    assert.ok(frame.egoLaneWidthM > 3);
    assert.equal(frame.frameOutcome, 'two_valid_ego_candidates');
    assert.equal(frame.candidateAvailability, 'both_valid');
  });

  it('detects lateral order crossing', () => {
    assert.equal(detectOrderCrossing([0, 1, 2], [0, 2, 1]), true);
    assert.equal(detectOrderCrossing([0, 1, 2], [0, 1, 2]), false);
  });

  it('analyzes model events with distributions', () => {
    const events = [
      { logMonoTime: '1000', modelV2: sampleModelV2() },
      { logMonoTime: '2000', modelV2: sampleModelV2() },
    ];
    const r = analyzeModelEvents(events);
    assert.equal(r.totalFrames, 2);
    assert.equal(r.framesWithAnyLines, 2);
    assert.ok(r.rawProbValues.length >= 8);
    assert.ok(r.laneLineProb.median > 0.5);
  });

  it('edge agreement uses line-observation interval metrics', () => {
    const frame = classifyFrameLines(sampleModelV2());
    const ag = edgeAgreement(sampleModelV2(), frame);
    assert.equal(ag.comparable, true);
    assert.equal(ag.comparableLineObservations, 4);
    assert.ok(ag.pctLineObservationsInside > 0);
  });

  it('mergeSegmentDistributions aggregates segments', () => {
    const events = [{ logMonoTime: '1', modelV2: sampleModelV2() }];
    const seg = { evidence: analyzeModelEvents(events), chunkCount: 1 };
    const merged = mergeSegmentDistributions([seg]);
    assert.equal(merged.physicalSegments, 1);
    assert.ok(merged.laneLineProb.count > 0);
  });
});

describe('Stage 15 lane counting design', () => {
  it('schema template uses unknown default', () => {
    const t = buildLaneCountRecordTemplate();
    assert.equal(t.schemaVersion, LANE_COUNT_SCHEMA_VERSION);
    assert.equal(t.roadSurfaceBaselineVersion, FROZEN_ROAD_SURFACE_VERSION);
    assert.equal(t.sameDirectionLaneCount, 'unknown');
    assert.ok(Array.isArray(t.supportingDividerIds));
  });

  it('problem definition lists must-remain-unknown cases', () => {
    const p = buildProblemDefinition();
    assert.ok(p.mustRemainUnknown.includes('junctions'));
    assert.ok(p.initialTarget.includes('same-direction'));
  });

  it('candidate pipeline is separate from road surface', () => {
    const pipe = buildCandidatePipeline();
    assert.equal(pipe.separateFromRoadSurface, true);
    assert.equal(pipe.frozenContext, FROZEN_ROAD_SURFACE_VERSION);
    assert.equal(pipe.stages.length, 12);
  });

  it('proposes threshold candidates without selecting production values', () => {
    const policy = proposeThresholdCandidates({
      laneLineProb: { count: 100, median: 0.7 },
      laneLineProbHistogram: { bins: PROB_BINS.map((b) => ({ ...b, count: 10 })), total: 60 },
      laneLineStdHistogram: { bins: [], total: 0 },
    });
    assert.match(policy.policy, /No production thresholds/);
    assert.ok(policy.candidates.length >= 6);
  });

  it('validation plan blocks camera layer', () => {
    const v = buildValidationPlan();
    assert.equal(v.layerC_camera.status, 'BLOCKED');
    assert.match(v.layerC_camera.note, /physical-road accuracy/);
  });

  it('schema unknown is not numeric zero', () => {
    const t = buildLaneCountRecordTemplate();
    assert.notEqual(t.sameDirectionLaneCount, 0);
    assert.equal(t.sameDirectionLaneCount, 'unknown');
  });
});

describe('Stage 15 assessment integration', () => {
  it('runs on a single segment without modifying v11', () => {
    const audit = buildLaneDividerAssessment(ROOT, {
      filenames: ['qlog_f449c_2.bz2'],
    });
    assert.equal(audit.v11GeometryModified, false);
    assert.equal(audit.laneCountingComplete, false);
    assert.equal(audit.productionLaneCountImplemented, false);
    assert.equal(audit.frozenRoadSurfaceVersion, FROZEN_ROAD_SURFACE_VERSION);
    assert.equal(audit.stage15Status, 'approved');
    assert.equal(audit.stage15aStatus, 'approved');
    assert.ok(audit.deliverableConsistency?.passed);
    assert.ok(Array.isArray(audit.coverageOutliers));
    assert.ok(audit.signalInventory.signals.modelV2.presentInSegments.laneLines > 0);
    assert.ok(audit.datasetEvidence.totalModelV2Frames > 0);
    assert.ok(audit.signalInventory.signals.modelV2.exists);
    assert.ok(audit.stage15aClassificationAudit);
    assert.ok(audit.stage15aClassificationAudit.slotSemantics.length === 4);
    assert.ok(audit.stage15aClassificationAudit.accountingInvariants.passed);
  });

  it('generates markdown reports', () => {
    const audit = buildLaneDividerAssessment(ROOT, {
      filenames: ['qlog_f449c_2.bz2'],
    });
    const md = generateAssessmentMarkdown(audit);
    const design = generateDesignMarkdown(audit);
    assert.match(md, /Stage 15/);
    assert.match(md, /Stage 15A/);
    assert.match(md, /minLaneProb/);
    assert.match(design, /Candidate pipeline/);
    assert.match(design, /Stage 16/);
    assert.match(design, /Stage 20/);
  });

  it('full dataset deliverable consistency passes', () => {
    const audit = buildLaneDividerAssessment(ROOT);
    const check = verifyStage15DeliverableConsistency(audit);
    assert.equal(check.passed, true, check.errors.join('; '));
    assert.equal(audit.datasetEvidence.totalModelV2Frames, 2761);
    assert.equal(audit.datasetEvidence.laneLineProb.count, 11044);
    assert.equal(audit.stage15aClassificationAudit.classificationTotals.ego_lane_boundaries, 4381);
    assert.equal(audit.deliverableConsistency.passed, true);
    assert.ok(audit.coverageOutliers.length > 0);
  });
});
