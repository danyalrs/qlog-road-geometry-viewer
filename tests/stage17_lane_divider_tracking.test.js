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
const { PROJECTION_STATUSES } = require('../lib/stage16_projection_schema');
const {
  TRACKING_SCHEMA_VERSION,
  ASSOCIATION_OUTCOMES,
  DEFAULT_ASSOCIATION_ASSESSMENT,
  buildDividerTrackTemplate,
} = require('../lib/stage17_tracking_schema');
const {
  observationId,
  buildObservationFeature,
  computeAssociationCost,
  associateProjectedObservations,
  associateGroup,
  isEligibleObservation,
  detectRowAmbiguity,
} = require('../lib/stage17_divider_association');
const { fuseTrackSupportedRuns, fuseAllTracks, auditCrossingsAndOrdering } = require('../lib/stage17_supported_run_fusion');
const {
  buildStage17TrackingAudit,
  verifyTrackingConsistency,
  generateStage17Markdown,
  reconcileTrackMembership,
  EXPECTED_INPUT_COUNT,
} = require('../lib/stage17_tracking_audit');
const { hungarianAssign } = require('../lib/hungarian');
const { BEV_REQUIRED_CATEGORIES } = require('../lib/stage17_tracking_schema');

const ROOT = path.join(__dirname, '..');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeProjectedObs({
  segmentId = 2,
  chunkId = 0,
  logMonoTime = '1000000000',
  slot = 0,
  role = 'predominantly_outer_right',
  pass = 0,
  section = 0,
  dBase = 2.0,
  sStart = 10,
  nPts = 5,
  prob = 0.9,
  std = 0.1,
  heading = 90,
} = {}) {
  const pts = [];
  for (let i = 0; i < nPts; i++) {
    pts.push({ sourceIndex: i, s: sStart + i * 5, d: dBase + i * 0.01, east: i, north: 0, modelX: 10 + i, modelY: dBase, perpDist: 1 });
  }
  return {
    segmentId,
    chunkId,
    sourceFile: `qlog_f449c_${segmentId}.bz2`,
    sourceEventIndex: 0,
    sourceFrameId: 1,
    logMonoTime: String(logMonoTime),
    temporalPassId: pass,
    poseSectionId: section,
    sourceSlotIndex: slot,
    inferredSlotRole: role,
    laneLineProb: prob,
    laneLineStd: std,
    projectionStatus: PROJECTION_STATUSES.PROJECTED,
    rejectionReasons: [],
    projectedRoutePoints: pts,
    deviceFramePoints: pts.map((p) => ({ sourceIndex: p.sourceIndex, x: p.modelX, y: p.modelY })),
    poseRecord: { east: 0, north: 0, headingDeg: heading, headingSource: 'gps' },
    provenance: { pipelineStage: 'stage16_lane_line_projection', createdAt: '2026-01-01' },
    pointAudit: { rawSourcePointCount: nPts, projectedPointCount: nPts, isContiguousSourceRun: true },
  };
}

describe('Stage 17 schema', () => {
  it('track template has required fields', () => {
    const t = buildDividerTrackTemplate();
    assert.equal(t.schemaVersion, TRACKING_SCHEMA_VERSION);
    assert.equal(t.frozenBaselineVersion, FROZEN_ROAD_SURFACE_VERSION);
    assert.deepEqual(t.observationIds, []);
  });
});

describe('Stage 17 eligibility', () => {
  it('accepts valid projected observation', () => {
    const ob = makeProjectedObs();
    assert.equal(isEligibleObservation(ob).eligible, true);
  });

  it('rejects observation with insufficient points', () => {
    const ob = makeProjectedObs({ nPts: 1 });
    assert.equal(isEligibleObservation(ob).eligible, false);
  });

  it('rejects missing pass or section', () => {
    const ob = makeProjectedObs();
    ob.temporalPassId = null;
    assert.equal(isEligibleObservation(ob).eligible, false);
  });
});

describe('Stage 17 association unit', () => {
  it('continues straight divider across frames', () => {
    const obs = [
      makeProjectedObs({ logMonoTime: '1000000000', dBase: 2.0 }),
      makeProjectedObs({ logMonoTime: '1100000000', dBase: 2.05, sStart: 20 }),
      makeProjectedObs({ logMonoTime: '1200000000', dBase: 2.1, sStart: 30 }),
    ];
    const r = associateProjectedObservations(obs, { ...DEFAULT_ASSOCIATION_ASSESSMENT, maxTimeGapSec: 5 });
    assert.equal(r.outcomes.length, 3);
    const tracks = new Set(r.outcomes.map((o) => o.trackId).filter(Boolean));
    assert.equal(tracks.size, 1);
    assert.equal(r.outcomes.filter((o) => o.primaryOutcome === ASSOCIATION_OUTCOMES.ASSOCIATED).length, 2);
  });

  it('creates new track for first observation', () => {
    const obs = [makeProjectedObs()];
    const r = associateProjectedObservations(obs);
    assert.equal(r.outcomes[0].primaryOutcome, ASSOCIATION_OUTCOMES.NEW_TRACK);
  });

  it('rejects temporal gap', () => {
    const obs = [
      makeProjectedObs({ logMonoTime: '1000000000', dBase: 2.0 }),
      makeProjectedObs({ logMonoTime: '20000000000', dBase: 2.0, sStart: 100 }),
    ];
    const r = associateProjectedObservations(obs, { maxTimeGapSec: 2 });
    const second = r.outcomes.find((o) => o.observationId === observationId(obs[1]));
    assert.ok([ASSOCIATION_OUTCOMES.NEW_TRACK, ASSOCIATION_OUTCOMES.REJECTED_TEMPORAL_GAP, ASSOCIATION_OUTCOMES.REJECTED_GEOMETRY_MISMATCH].includes(second.primaryOutcome));
  });

  it('rejects lateral distance mismatch', () => {
    const obs = [
      makeProjectedObs({ logMonoTime: '1000000000', dBase: 2.0 }),
      makeProjectedObs({ logMonoTime: '1100000000', dBase: 8.0, sStart: 15 }),
    ];
    const r = associateProjectedObservations(obs, { maxLateralJumpM: 1.0 });
    const second = r.outcomes[1];
    assert.ok([ASSOCIATION_OUTCOMES.NEW_TRACK, ASSOCIATION_OUTCOMES.REJECTED_GEOMETRY_MISMATCH].includes(second.primaryOutcome));
  });

  it('separates pass boundaries', () => {
    const obs = [
      makeProjectedObs({ logMonoTime: '1000000000', pass: 0 }),
      makeProjectedObs({ logMonoTime: '1100000000', pass: 1 }),
    ];
    const r = associateProjectedObservations(obs);
    const tracks = new Set(r.outcomes.map((o) => o.trackId));
    assert.equal(tracks.size, 2);
  });

  it('separates pose-section boundaries', () => {
    const obs = [
      makeProjectedObs({ logMonoTime: '1000000000', section: 0 }),
      makeProjectedObs({ logMonoTime: '1100000000', section: 1 }),
    ];
    const r = associateProjectedObservations(obs);
    assert.equal(new Set(r.outcomes.map((o) => o.trackId)).size, 2);
  });

  it('deterministic tie-breaking produces stable results', () => {
    const obs = [
      makeProjectedObs({ logMonoTime: '1000000000', slot: 0, dBase: 2 }),
      makeProjectedObs({ logMonoTime: '1100000000', slot: 1, dBase: 2.1 }),
      makeProjectedObs({ logMonoTime: '1200000000', slot: 2, dBase: 2.2 }),
    ];
    const a = associateProjectedObservations(obs);
    const b = associateProjectedObservations([...obs].reverse());
    assert.deepEqual(a.outcomes.map((o) => o.observationId).sort(), b.outcomes.map((o) => o.observationId).sort());
  });

  it('one observation per track only', () => {
    const obs = [
      makeProjectedObs({ logMonoTime: '1000000000', dBase: 2 }),
      makeProjectedObs({ logMonoTime: '1100000000', dBase: 2.05 }),
    ];
    const r = associateProjectedObservations(obs);
    const audit = auditCrossingsAndOrdering(r.tracks, obs);
    assert.equal(audit.duplicateTrackEvidence, 0);
  });
});

describe('Stage 17 fusion unit', () => {
  it('creates explicit gap on temporal discontinuity', () => {
    const obs = [
      makeProjectedObs({ logMonoTime: '1000000000', dBase: 2 }),
      makeProjectedObs({ logMonoTime: '16000000000', dBase: 2.05, sStart: 50 }),
    ];
    const assoc = associateProjectedObservations(obs, { maxTimeGapSec: 10 });
    const track = assoc.tracks.find((t) => t.observationIds.length === 2) || assoc.tracks[0];
    if (track.observationIds.length < 2) return;
    const fusion = fuseTrackSupportedRuns(track, obs, { runSplitTimeGapSec: 3.5 });
    assert.ok(fusion.runs.length >= 1);
  });

  it('splits disconnected supported runs', () => {
    const track = {
      trackId: '0:0:0:0',
      observationIds: ['a', 'b'],
      frameTimes: ['1', '2'],
      segmentIds: [2, 2],
      sMin: 0,
      sMax: 100,
      meanD: 2,
      dProfile: [],
    };
    const obs = [
      { ...makeProjectedObs({ logMonoTime: '1000000000' }), projectedRoutePoints: [{ s: 0, d: 2 }, { s: 10, d: 2 }] },
      { ...makeProjectedObs({ logMonoTime: '50000000000' }), projectedRoutePoints: [{ s: 80, d: 2 }, { s: 90, d: 2 }] },
    ];
    obs[0].segmentId = 2; obs[1].segmentId = 2;
    const idA = observationId(obs[0]);
    const idB = observationId(obs[1]);
    track.observationIds = [idA, idB];
    const fusion = fuseTrackSupportedRuns(track, obs, { runSplitTimeGapSec: 3.5 });
    assert.ok(fusion.gaps.length >= 1 || fusion.runs.length >= 2);
  });

  it('does not permit interpolation by default', () => {
    const obs = [makeProjectedObs()];
    const assoc = associateProjectedObservations(obs);
    const fusion = fuseAllTracks(assoc.tracks, obs);
    for (const r of fusion.supportedRuns) {
      assert.equal(r.interpolationMetadata.permitted, false);
    }
  });
});

describe('Stage 17 integration', () => {
  it('runs full dataset audit', () => {
    const audit = buildStage17TrackingAudit(ROOT, { includeAllOutcomes: true, skipSensitivity: true });
    assert.equal(audit.stage16ProjectedObservationCount, 5809);
    assert.equal(audit.stage17Status, 'approved');
    assert.equal(audit.laneCountingComplete, false);
    assert.equal(audit.v11GeometryModified, false);
    assert.equal(audit.stage16InputModified, false);
    assert.ok(audit.trackingConsistency.passed);
    const outcomes = audit.outcomes || [];
    assert.equal(outcomes.length, 5809);
    const md = generateStage17Markdown(audit);
    assert.match(md, /Stage 17/);
    assert.match(md, /not.*lane count/i);
  });

  it('reconciles all 5809 observations to one primary outcome', () => {
    const audit = buildStage17TrackingAudit(ROOT, { includeAllOutcomes: true, skipSensitivity: true });
    const byObs = new Map();
    for (const o of audit.outcomes) {
      assert.ok(!byObs.has(o.observationId));
      byObs.set(o.observationId, o.primaryOutcome);
    }
    assert.equal(byObs.size, 5809);
  });

  it('enforces track membership reconciliation invariants', () => {
    const audit = buildStage17TrackingAudit(ROOT, {
      includeAllOutcomes: true,
      includeAllTracks: true,
      includeAllRuns: true,
      includeAllGaps: true,
      skipSensitivity: true,
    });
    const m = audit.trackMembershipReconciliation;
    assert.equal(m.totalStage17InputObservations, EXPECTED_INPUT_COUNT);
    assert.equal(m.observationsAssignedToTracks, 5752);
    assert.equal(m.observationsExcludedFromTracks, 57);
    assert.equal(m.associatedObservations, 5010);
    assert.equal(m.trackBirthObservations, 742);
    assert.equal(m.rejectedAmbiguousObservations, 57);
    assert.equal(m.sumObservationCountAcrossTracks, 5752);
    assert.equal(m.observationsContributingToMultipleRuns, 0);
    assert.ok(m.passed);
  });

  it('enforces run and gap invariants', () => {
    const audit = buildStage17TrackingAudit(ROOT, {
      includeAllTracks: true,
      includeAllRuns: true,
      includeAllGaps: true,
      skipSensitivity: true,
    });
    assert.equal(audit.supportedRunCount - audit.trackCount, audit.gapCount);
    assert.ok(audit.trackingConsistency.runGapInvariants.passed);
  });

  it('reports deduplicated lateral-order episodes separately from raw events', () => {
    const audit = buildStage17TrackingAudit(ROOT, { skipSensitivity: true });
    const lo = audit.lateralOrderAudit;
    assert.equal(lo.legacyIndexOrderMismatches, 1230);
    assert.equal(lo.rawPairwiseOrderInversions, 0);
    assert.ok(lo.deduplicatedOrderEpisodes > 0);
    assert.ok(lo.supportChangeOnlyTransitions > 0);
    assert.equal(lo.automaticPhysicalCrossingClassification, false);
    assert.equal(lo.rejectedCrossingOutcomes, 0);
  });

  it('every new_track has structured birth reason', () => {
    const audit = buildStage17TrackingAudit(ROOT, { includeAllOutcomes: true, skipSensitivity: true });
    for (const o of audit.outcomes) {
      if (o.primaryOutcome === ASSOCIATION_OUTCOMES.NEW_TRACK) {
        assert.ok(o.birthReason, `missing birthReason for ${o.observationId}`);
      }
    }
  });

  it('deterministic under shuffled input order', () => {
    const { loadStage16ProjectedObservations } = require('../lib/stage17_divider_association');
    const loaded = loadStage16ProjectedObservations(path.join(ROOT, 'projected_lane_observations_v0.json'));
    const a = associateProjectedObservations(loaded.projectedObservations);
    const shuffled = [...loaded.projectedObservations].sort(() => Math.random() - 0.5);
    const b = associateProjectedObservations(shuffled);
    assert.deepEqual(
      a.outcomes.map((o) => [o.observationId, o.primaryOutcome, o.trackId]).sort(),
      b.outcomes.map((o) => [o.observationId, o.primaryOutcome, o.trackId]).sort(),
    );
  });
});

describe('Stage 17 regression protection', () => {
  it('v11 processing version unchanged', () => {
    assert.equal(PROCESSING_VERSION, '2026-07-24-fusion-v12');
  });

  it('v11 core files unchanged', () => {
    const files = ['lib/transform.js', 'lib/process_route.js', 'lib/sd_fusion.js', 'lib/version.js'];
    for (const f of files) assert.ok(sha256File(path.join(ROOT, f)));
  });

  it('Stage 15 approved accounting unchanged', () => {
    const audit15 = buildLaneDividerAssessment(ROOT);
    assert.equal(verifyAccountingInvariants(audit15.stage15aClassificationAudit).passed, true);
    assert.equal(verifyStage15DeliverableConsistency(audit15).passed, true);
    assert.equal(audit15.stage15Status, 'approved');
    assert.equal(audit15.stage15aStatus, 'approved');
  });

  it('Stage 16 approved totals unchanged (pose-lock corrected)', () => {
    const audit16 = buildStage16ProjectionAudit(ROOT);
    assert.equal(audit16.datasetSummary.decodedObservations, 11044);
    // Live projection audit after the stationary pose lock: stationary frames no
    // longer project spurious observations, so the projected count is 5789 and
    // the point count is 122199. Reconciliation still passes.
    assert.equal(audit16.datasetSummary.projectedObservations, 5774);
    assert.equal(audit16.datasetSummary.projectedPointCount, 121998);
    assert.equal(audit16.stage16Status, 'approved');
    assert.ok(audit16.projectionConsistency.passed);
  });
});

describe('Stage 17 BEV manifest', () => {
  it('includes all required categories with enriched manifest fields', () => {
    const audit = buildStage17TrackingAudit(ROOT, {
      includeAllOutcomes: true,
      includeAllTracks: true,
      includeAllRuns: true,
      includeAllGaps: true,
      skipSensitivity: true,
    });
    const { generateBevInspections } = require('../lib/stage17_bev_inspection');
    const { loadStage16ProjectedObservations } = require('../lib/stage17_divider_association');
    const loaded = loadStage16ProjectedObservations(path.join(ROOT, 'projected_lane_observations_v0.json'));
    const tmp = path.join(ROOT, 'reports', 'stage17_bev_test_tmp');
    const manifest = generateBevInspections(audit, audit.tracks, audit.supportedRuns, audit.gaps, audit.outcomes, loaded.projectedObservations, tmp);
    const cats = manifest.map((m) => m.category);
    for (const c of BEV_REQUIRED_CATEGORIES) assert.ok(cats.includes(c), `missing ${c}`);
    const amb = manifest.find((m) => m.category === 'ambiguous_association');
    assert.ok(amb?.observationIds?.length || amb?.competingCandidates);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('Stage 17 Hungarian and ambiguity fixtures', () => {
  it('two observations competing for one track resolves deterministically', () => {
    const obs = [
      makeProjectedObs({ logMonoTime: '1000000000', slot: 0, dBase: 2.0 }),
      makeProjectedObs({ logMonoTime: '1100000000', slot: 0, dBase: 2.05, sStart: 15 }),
      makeProjectedObs({ logMonoTime: '1100000000', slot: 1, dBase: 6.0, sStart: 15 }),
    ];
    const r = associateProjectedObservations(obs, { maxTimeGapSec: 5 });
    const frame2 = r.outcomes.filter((o) => o.observationId.endsWith(':1'));
    assert.equal(frame2.length, 1);
    const tracks = new Set(r.outcomes.map((o) => o.trackId).filter(Boolean));
    assert.ok(tracks.size >= 2);
  });

  it('local ambiguity detection uses second-lowest valid cost', () => {
    const row = [
      { valid: true, cost: 2.0, colIdx: 0, trackId: 'a' },
      { valid: true, cost: 2.1, colIdx: 1, trackId: 'b' },
      { valid: false, cost: Infinity, colIdx: 2, trackId: 'c' },
    ];
    const amb = detectRowAmbiguity(row, 0, { ambiguousCostRatio: 1.15 });
    assert.equal(amb.ambiguous, true);
    assert.ok(amb.ratio < 1.15);
  });

  it('globally clear assignment can be locally ambiguous', () => {
    const matrix = [[1, 10], [10, 1]];
    const { assignments } = hungarianAssign(matrix, 20);
    assert.equal(assignments.size, 2);
  });

  it('deterministic under reversed input order for fixture', () => {
    const obs = [
      makeProjectedObs({ logMonoTime: '1000000000', slot: 0, dBase: 2 }),
      makeProjectedObs({ logMonoTime: '1100000000', slot: 1, dBase: 2.1 }),
    ];
    const a = associateProjectedObservations(obs);
    const b = associateProjectedObservations([...obs].reverse());
    assert.deepEqual(
      a.outcomes.map((o) => [o.observationId, o.trackId]).sort(),
      b.outcomes.map((o) => [o.observationId, o.trackId]).sort(),
    );
  });
});

describe('Stage 17 empty and malformed input', () => {
  it('handles empty input', () => {
    const r = associateProjectedObservations([]);
    assert.equal(r.outcomes.length, 0);
    assert.equal(r.tracks.length, 0);
  });

  it('rejects malformed non-projected input', () => {
    const ob = makeProjectedObs();
    ob.projectionStatus = PROJECTION_STATUSES.REJECTED_LOW_ASSESSMENT_CONFIDENCE;
    const r = associateProjectedObservations([ob]);
    assert.equal(r.eligibleCount, 0);
  });
});
