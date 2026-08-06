const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  classifyFrameLines,
  classifyFrameLinesBeforeFix,
  buildClassificationAudit,
  verifyAccountingInvariants,
  CLASSIFICATION_FIXTURES,
  evaluateLineObservation,
  roadEdgeIntervalMetrics,
  ASSESSMENT_THRESHOLDS,
  V11_MIN_LANE_PROB_USAGE,
} = require('../lib/stage15a_classification_audit');
const {
  buildLaneDividerAssessment,
} = require('../lib/stage15_lane_divider_assessment');

const ROOT = path.join(__dirname, '..');

function eventsFromFixtures(...keys) {
  return keys.map((k, i) => ({
    logMonoTime: String(1000 + i),
    modelV2: CLASSIFICATION_FIXTURES[k].modelV2,
  }));
}

describe('Stage 15A classification audit', () => {
  it('documents v11 minLaneProb usage paths', () => {
    assert.equal(V11_MIN_LANE_PROB_USAGE.value, 0.5);
    assert.ok(V11_MIN_LANE_PROB_USAGE.codePaths.some((p) => p.file === 'lib/transform.js'));
  });

  it('fixture: normal four-line ordering selects inner right not outer', () => {
    const f = CLASSIFICATION_FIXTURES.normalFourLineOrdering;
    const before = classifyFrameLinesBeforeFix(f.modelV2);
    const after = classifyFrameLines(f.modelV2);
    assert.equal(before.egoRight?.index, f.expect.beforeRightIndex);
    assert.equal(after.egoRight?.index, f.expect.rightEgoIndex);
    assert.equal(after.candidateAvailability, 'both_valid');
    assert.equal(after.frameAssessmentReason, 'accepted_both');
  });

  it('fixture: right ego closer to centre than outer-right', () => {
    const f = CLASSIFICATION_FIXTURES.rightEgoCloserThanOuter;
    const before = classifyFrameLinesBeforeFix(f.modelV2);
    const after = classifyFrameLines(f.modelV2);
    assert.equal(before.egoRight?.index, 3);
    assert.equal(after.egoRight?.index, 1);
  });

  it('fixture: missing right yields left_only_valid availability', () => {
    const f = CLASSIFICATION_FIXTURES.missingRightEgoCandidate;
    const after = classifyFrameLines(f.modelV2);
    assert.equal(after.candidateAvailability, 'left_only_valid');
    assert.equal(after.frameOutcome, 'left_only_valid');
    assert.equal(after.retainedEgoCandidateCount, 1);
  });

  it('fixture: low-confidence right yields left_only_valid with rejected_right_confidence', () => {
    const f = CLASSIFICATION_FIXTURES.lowConfidenceInnerRight;
    const after = classifyFrameLines(f.modelV2);
    assert.equal(after.candidateAvailability, f.expect.availability);
    assert.equal(after.frameAssessmentReason, f.expect.assessmentReason);
    assert.equal(after.retainedEgoCandidateCount, 1);
  });

  it('fixture: centre-crossing line is ineligible for ego', () => {
    const f = CLASSIFICATION_FIXTURES.lineCrossingCentre;
    const ob = evaluateLineObservation(0, f.modelV2.laneLines[0], 0.9, 0.1);
    assert.equal(ob.crossing, true);
    assert.equal(ob.eligibleGeometry, false);
  });

  it('fixture: malformed unequal arrays marked unclassifiable', () => {
    const f = CLASSIFICATION_FIXTURES.malformedUnequalArrays;
    const after = classifyFrameLines(f.modelV2);
    for (const idx of f.expect.malformedIndices) {
      assert.ok(after.classifications.unclassifiable.includes(idx));
    }
  });

  it('road-edge interval metrics use line-observation denominator', () => {
    const f = CLASSIFICATION_FIXTURES.normalFourLineOrdering;
    const frame = classifyFrameLines({
      ...f.modelV2,
      roadEdges: [
        { x: [10], y: [6.0], z: [], t: [] },
        { x: [10], y: [-6.0], z: [], t: [] },
      ],
      roadEdgeStds: [0.2, 0.18],
    });
    const m = roadEdgeIntervalMetrics({
      ...f.modelV2,
      roadEdges: [
        { x: [10], y: [6.0], z: [], t: [] },
        { x: [10], y: [-6.0], z: [], t: [] },
      ],
    }, frame);
    assert.equal(m.comparable, true);
    assert.equal(m.comparableLineObservations, 4);
    assert.equal(typeof m.bothRetainedEgoCandidatesInside, 'boolean');
    assert.equal(m.evalForwardXM, ASSESSMENT_THRESHOLDS.evalForwardXM);
  });

  it('synthetic audit satisfies accounting invariants', () => {
    const events = eventsFromFixtures(
      'normalFourLineOrdering',
      'missingRightEgoCandidate',
      'lowConfidenceInnerRight',
    );
    const audit = buildClassificationAudit(events);
    const inv = verifyAccountingInvariants(audit);
    assert.equal(inv.passed, true, inv.errors.join('; '));
    assert.equal(audit.candidateAvailability.both_valid, 1);
    assert.equal(audit.candidateAvailability.left_only_valid, 2);
    assert.equal(audit.classificationTotals.ego_lane_boundaries, 4);
    assert.equal(audit.egoBoundaryReconciliation.reconstructedRetainedClassifications, 4);
  });

  it('invariant: availability cells sum to frame count', () => {
    const events = eventsFromFixtures('normalFourLineOrdering', 'lowConfidenceInnerRight');
    const audit = buildClassificationAudit(events);
    const sum = Object.values(audit.candidateAvailability).reduce((a, b) => a + b, 0);
    assert.equal(sum, events.length);
  });

  it('invariant: reason outcomes sum to frame count', () => {
    const events = eventsFromFixtures('normalFourLineOrdering', 'lowConfidenceInnerRight');
    const audit = buildClassificationAudit(events);
    const sum = Object.values(audit.frameAssessmentReasons).reduce((a, b) => a + b, 0);
    assert.equal(sum, events.length);
  });

  it('invariant: both-valid reconstructs to 2× count classifications', () => {
    const events = eventsFromFixtures('normalFourLineOrdering', 'normalFourLineOrdering');
    const audit = buildClassificationAudit(events);
    assert.equal(audit.egoBoundaryReconciliation.bothValidRetainedClassifications, 4);
    assert.equal(audit.classificationTotals.ego_lane_boundaries, 4);
  });

  it('full dataset audit passes accounting invariants', () => {
    const audit = buildLaneDividerAssessment(ROOT);
    const inv = verifyAccountingInvariants(audit.stage15aClassificationAudit);
    assert.equal(inv.passed, true, inv.errors.join('; '));
    const c = audit.stage15aClassificationAudit;
    assert.equal(c.egoBoundaryReconciliation.reconstructionMatchesTotal, true);
    const availSum = Object.values(c.candidateAvailability).reduce((a, b) => a + b, 0);
    assert.equal(availSum, c.egoBoundaryReconciliation.totalFrames);
    assert.equal(
      2 * c.candidateAvailability.both_valid
        + c.candidateAvailability.left_only_valid
        + c.candidateAvailability.right_only_valid,
      c.classificationTotals.ego_lane_boundaries,
    );
    const re = c.roadEdgeIntervalMetrics;
    assert.equal(re.breakdown.totals.comparableLineObservations, re.comparableLineObservations);
    assert.equal(re.breakdown.totals.insideInterval, re.lineObservationsInsideInterval);
  });
});
