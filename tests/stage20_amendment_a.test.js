const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fuseTrackSupportedRuns } = require('../lib/stage17_supported_run_fusion');
const { associateGroup } = require('../lib/stage17_divider_association');
const { PROJECTION_STATUSES } = require('../lib/stage16_projection_schema');
const {
  SUPPORTED_RUNS_V1_SCHEMA_VERSION,
  AMENDMENT_A_ERROR_CODES: E,
  CROSS_PASS_STATES,
  buildDividerCorridorId,
} = require('../lib/stage20_amendment_a_schema');
const { SUPPORTED_RUNS_V1_PROCESSING_VERSION } = require('../lib/stage20_amendment_a_version');
const {
  validateRunForEmission,
  validateArtifactEnvelope,
  isLegacyV0Artifact,
  legacyV0Unavailable,
} = require('../lib/stage20_amendment_a_validation');
const {
  buildValidatedSameSegmentLinkage,
  buildValidatedCrossSegmentLinkage,
  validateLinkageRecord,
  validateLinkageArtifact,
  sortLinkageRecordsDeterministic,
  detectDuplicateFeaturePair,
} = require('../lib/stage20_amendment_a_corridor_linkage');
const {
  isSamePass,
  isComparisonKeyMatch,
  isCrossSegmentKeyCollision,
  evaluateCrossPassPair,
  evaluateCrossPassFromArtifacts,
  routeSOverlapM,
} = require('../lib/stage20_amendment_a_cross_pass');
const { buildV1SupportedRunsArtifact } = require('../lib/stage20_amendment_a_emit');
const { auditV1Artifact, featurePairId } = require('../lib/stage20_amendment_a_acceptance');
const { contentHashSha256, canonicalJson } = require('../lib/stage20_amendment_a_serialization');
const { CORRIDOR_LINKAGE_SCHEMA_VERSION } = require('../lib/stage20_amendment_a_version');
const { PROCESSING_VERSION } = require('../lib/version');

const ROOT = path.join(__dirname, '..');
const FIXED_TS = '2026-07-28T04:00:00.000Z';

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeObs({
  segmentId = 10,
  chunkId = 0,
  pass = 0,
  section = 4,
  slot = 0,
  logMonoTime = '1000000000',
  sStart = 0,
  nPts = 5,
  dBase = 2,
} = {}) {
  const pts = [];
  for (let i = 0; i < nPts; i++) pts.push({ sourceIndex: i, s: sStart + i * 10, d: dBase, east: i, north: 0, modelX: 10, modelY: dBase, perpDist: 1 });
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
    inferredSlotRole: 'predominantly_outer_right',
    laneLineProb: 0.9,
    laneLineStd: 0.1,
    projectionStatus: PROJECTION_STATUSES.PROJECTED,
    rejectionReasons: [],
    projectedRoutePoints: pts,
    deviceFramePoints: pts.map((p) => ({ sourceIndex: p.sourceIndex, x: p.modelX, y: p.modelY })),
    poseRecord: { east: 0, north: 0, headingDeg: 90, headingSource: 'gps' },
    provenance: { pipelineStage: 'stage16_lane_line_projection', createdAt: FIXED_TS },
    pointAudit: { rawSourcePointCount: nPts, projectedPointCount: nPts, isContiguousSourceRun: true },
  };
}

function makeTrack({ trackId, chunkId = 0, pass = 0, section = 4, trackIndex = 0, segmentIds = [10], obsIds = ['obs:0'] } = {}) {
  return {
    trackId,
    trackIndex,
    chunkId,
    temporalPassId: pass,
    poseSectionId: section,
    segmentIds,
    observationIds: obsIds,
    frameTimes: ['1000000000'],
    sMin: 0,
    sMax: 40,
    confidence: 0.9,
    uncertainty: 0.1,
  };
}

function buildV1RunFromTrack(track, observations, opts = {}) {
  const { runs, rejectedRuns } = fuseTrackSupportedRuns(track, observations, { amendmentA: true, createdAt: FIXED_TS, ...opts });
  return { run: runs[0], rejectedRuns };
}

describe('Amendment A — emission and propagation', () => {
  it('T-A-001 valid single-observation run', () => {
    const ob = makeObs({ section: 0, trackIndex: 0, sStart: 0 });
    const track = makeTrack({ trackId: '0:0:0:0', section: 0, trackIndex: 0, segmentIds: [10], obsIds: ['10:0:1000000000:0'] });
    ob.sourceSlotIndex = 0;
    const { observationId } = require('../lib/stage17_divider_association');
    const id = observationId(ob);
    track.observationIds = [id];
    const { run } = buildV1RunFromTrack(track, [ob]);
    assert.equal(run.dividerCorridorId, '0:0:0');
    assert.equal(run.segmentId, 10);
    assert.equal(run.boundaryProvenance.comparisonKeyScope, 'within_segment');
  });

  it('T-A-002 valid multi-observation run', () => {
    const obs = [
      makeObs({ logMonoTime: '1000000000', sStart: 0 }),
      makeObs({ logMonoTime: '1100000000', sStart: 20 }),
      makeObs({ logMonoTime: '1200000000', sStart: 40 }),
    ];
    const { observationId } = require('../lib/stage17_divider_association');
    const track = makeTrack({ trackId: '0:0:4:0', obsIds: obs.map(observationId) });
    const { runs } = fuseTrackSupportedRuns(track, obs, { amendmentA: true, createdAt: FIXED_TS });
    assert.equal(runs.length, 1);
    assert.ok(runs.every((r) => r.segmentId === 10));
  });

  it('T-A-014 dividerCorridorId assignment', () => {
    const track = makeTrack({ trackId: '0:0:4:2', section: 4, trackIndex: 2 });
    assert.equal(buildDividerCorridorId(track), '0:4:2');
  });

  it('T-A-015 trackIndex copied from track', () => {
    const ob = makeObs();
    const track = makeTrack({ trackId: '0:0:4:5', trackIndex: 5, obsIds: ['10:0:1000000000:0'] });
    const { observationId } = require('../lib/stage17_divider_association');
    track.observationIds = [observationId(ob)];
    const { run } = buildV1RunFromTrack(track, [ob]);
    assert.equal(run.trackIndex, 5);
  });

  it('T-A-003 parent track not found', () => {
    const run = { parentTrackId: 'missing', observationIds: [], schemaVersion: SUPPORTED_RUNS_V1_SCHEMA_VERSION };
    const err = validateRunForEmission(run, null, new Map());
    assert.equal(err.code, E.A_PTR_002);
  });

  it('T-A-004 segmentId not in track.segmentIds', () => {
    const ob = makeObs({ segmentId: 99 });
    const track = makeTrack({ trackId: '0:0:4:0', segmentIds: [10] });
    const { observationId } = require('../lib/stage17_divider_association');
    track.observationIds = [observationId(ob)];
    const { rejectedRuns } = buildV1RunFromTrack(track, [ob]);
    assert.equal(rejectedRuns[0].code, E.A_PTR_003);
  });

  it('T-A-005 mixed member segmentId rejected', () => {
    const ob1 = makeObs({ segmentId: 10, logMonoTime: '1000000000' });
    const ob2 = makeObs({ segmentId: 11, logMonoTime: '1100000000', sStart: 50 });
    const { observationId } = require('../lib/stage17_divider_association');
    const track = makeTrack({ trackId: '0:0:4:0', segmentIds: [10, 11], obsIds: [observationId(ob1), observationId(ob2)] });
    const { rejectedRuns } = fuseTrackSupportedRuns(track, [ob1, ob2], { amendmentA: true, createdAt: FIXED_TS });
    assert.equal(rejectedRuns[0].code, E.A_MEM_004);
  });

  it('T-A-006 member observation missing', () => {
    const track = makeTrack({ trackId: '0:0:4:0', obsIds: ['missing:obs'] });
    const err = validateRunForEmission({
      parentTrackId: track.trackId,
      observationIds: ['missing:obs'],
      temporalPassId: 0,
      chunkId: 0,
      poseSectionId: 4,
      trackIndex: 0,
      dividerCorridorId: '0:4:0',
      segmentId: 10,
      boundaryProvenance: { comparisonKeyScope: 'within_segment' },
    }, track, new Map());
    assert.equal(err.code, E.A_MEM_001);
  });

  it('T-A-007 member missing segmentId', () => {
    const ob = makeObs();
    delete ob.segmentId;
    const { observationId } = require('../lib/stage17_divider_association');
    const track = makeTrack({ trackId: '0:0:4:0', obsIds: [observationId(ob)] });
    const err = validateRunForEmission({
      parentTrackId: track.trackId,
      observationIds: track.observationIds,
      temporalPassId: 0,
      chunkId: 0,
      poseSectionId: 4,
      trackIndex: 0,
      dividerCorridorId: '0:4:0',
      segmentId: 10,
      boundaryProvenance: { comparisonKeyScope: 'within_segment' },
    }, track, new Map([[observationId(ob), ob]]));
    assert.equal(err.code, E.A_MEM_002);
  });

  it('T-A-008 member chunkId mismatch', () => {
    const ob = makeObs({ chunkId: 1 });
    const track = makeTrack({ trackId: '0:0:4:0', chunkId: 0 });
    const { observationId } = require('../lib/stage17_divider_association');
    track.observationIds = [observationId(ob)];
    const { rejectedRuns } = buildV1RunFromTrack(track, [ob]);
    assert.equal(rejectedRuns[0].code, E.A_MEM_003);
  });

  it('T-A-009 member temporalPassId mismatch', () => {
    const ob = makeObs({ pass: 1 });
    const track = makeTrack({ trackId: '0:0:4:0', pass: 0 });
    const { observationId } = require('../lib/stage17_divider_association');
    track.observationIds = [observationId(ob)];
    const { rejectedRuns } = buildV1RunFromTrack(track, [ob]);
    assert.equal(rejectedRuns[0].code, E.A_MEM_003);
  });

  it('T-A-010 member poseSectionId mismatch', () => {
    const ob = makeObs({ section: 5 });
    const track = makeTrack({ trackId: '0:0:4:0', section: 4 });
    const { observationId } = require('../lib/stage17_divider_association');
    track.observationIds = [observationId(ob)];
    const { rejectedRuns } = buildV1RunFromTrack(track, [ob]);
    assert.equal(rejectedRuns[0].code, E.A_MEM_003);
  });

  it('T-A-011 missing trackIndex on parent track', () => {
    const ob = makeObs();
    const track = makeTrack({ trackId: 'bad', trackIndex: undefined });
    delete track.trackIndex;
    track.trackId = 'bad:bad:bad';
    const { observationId } = require('../lib/stage17_divider_association');
    track.observationIds = [observationId(ob)];
    const { rejectedRuns } = buildV1RunFromTrack(track, [ob]);
    assert.equal(rejectedRuns[0].code, E.A_BND_002);
  });

  it('T-A-012 duplicate dividerRunId in artifact', () => {
    const artifact = {
      schemaVersion: SUPPORTED_RUNS_V1_SCHEMA_VERSION,
      supportedRunCount: 2,
      gapCount: 0,
      supportedRuns: [{ dividerRunId: 'dup' }, { dividerRunId: 'dup' }],
      gaps: [],
      contentHashSha256: 'x',
    };
    const errors = validateArtifactEnvelope(artifact);
    assert.ok(errors.some((e) => e.code === E.A_ART_003));
  });

  it('T-A-013 deterministic serialization and content hash', () => {
    const runs = [
      { dividerRunId: 'b:run:0', schemaVersion: SUPPORTED_RUNS_V1_SCHEMA_VERSION },
      { dividerRunId: 'a:run:0', schemaVersion: SUPPORTED_RUNS_V1_SCHEMA_VERSION },
    ];
    const artifact = {
      schemaVersion: SUPPORTED_RUNS_V1_SCHEMA_VERSION,
      processingVersion: SUPPORTED_RUNS_V1_PROCESSING_VERSION,
      supportedRunCount: 2,
      gapCount: 0,
      supportedRuns: runs,
      gaps: [],
    };
    const hash = contentHashSha256({ supportedRuns: runs, gaps: [] });
    artifact.contentHashSha256 = hash;
    const errors = validateArtifactEnvelope(artifact);
    assert.ok(errors.some((e) => e.code === E.A_ART_006));
    artifact.supportedRuns = [{ dividerRunId: 'a:run:0' }, { dividerRunId: 'b:run:0' }];
    artifact.contentHashSha256 = contentHashSha256({ supportedRuns: artifact.supportedRuns, gaps: [] });
    assert.equal(validateArtifactEnvelope(artifact).length, 0);
    artifact.contentHashSha256 = 'deadbeef';
    assert.ok(validateArtifactEnvelope(artifact).some((e) => e.code === E.A_ART_004));
    artifact.contentHashSha256 = contentHashSha256({ supportedRuns: artifact.supportedRuns, gaps: [] });
    artifact.processingVersion = 'legacy-v0';
    assert.ok(validateArtifactEnvelope(artifact).some((e) => e.code === E.A_ART_005));
  });

  it('T-A-054 schemaVersion mismatch envelope reject', () => {
    const artifact = {
      schemaVersion: 'wrong-schema',
      supportedRunCount: 0,
      gapCount: 0,
      supportedRuns: [],
      gaps: [],
      contentHashSha256: contentHashSha256({ supportedRuns: [], gaps: [] }),
    };
    const errors = validateArtifactEnvelope(artifact);
    assert.ok(errors.some((e) => e.code === E.A_ART_001));
  });

  it('T-A-055 artifact count mismatch envelope reject', () => {
    const artifact = {
      schemaVersion: SUPPORTED_RUNS_V1_SCHEMA_VERSION,
      processingVersion: SUPPORTED_RUNS_V1_PROCESSING_VERSION,
      supportedRunCount: 99,
      gapCount: 0,
      supportedRuns: [],
      gaps: [],
      contentHashSha256: contentHashSha256({ supportedRuns: [], gaps: [] }),
    };
    const errors = validateArtifactEnvelope(artifact);
    assert.ok(errors.some((e) => e.code === E.A_ART_002));
    const gapArtifact = { ...artifact, supportedRunCount: 0, gapCount: 5 };
    assert.ok(validateArtifactEnvelope(gapArtifact).some((e) => e.code === E.A_ART_002));
  });
});

describe('Amendment A — identity conflicts', () => {
  it('T-A-020 same parentTrackId different temporalPassId rejected in artifact', () => {
    const runs = [
      { parentTrackId: '0:0:4:0', temporalPassId: 0, dividerRunId: 'a' },
      { parentTrackId: '0:0:4:0', temporalPassId: 1, dividerRunId: 'b' },
    ];
    const { detectParentTrackIdConflicts } = require('../lib/stage20_amendment_a_validation');
    const conflicts = detectParentTrackIdConflicts(runs);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].code, E.A_PTR_001);
  });

  it('T-A-021 run temporalPassId differs from parent track', () => {
    const ob = makeObs({ pass: 1 });
    const track = makeTrack({ trackId: '0:1:4:0', pass: 1, obsIds: [] });
    const { observationId } = require('../lib/stage17_divider_association');
    track.observationIds = [observationId(ob)];
    ob.temporalPassId = 0;
    const { rejectedRuns } = buildV1RunFromTrack(track, [ob]);
    assert.equal(rejectedRuns.length, 1);
    assert.ok([E.A_PTR_001, E.A_MEM_003].includes(rejectedRuns[0].code));
  });
});

describe('Amendment A — comparison key and linkage', () => {
  function fixtureRuns() {
    const runA = {
      schemaVersion: SUPPORTED_RUNS_V1_SCHEMA_VERSION,
      dividerRunId: '0:0:4:0:run:0',
      parentTrackId: '0:0:4:0',
      segmentId: 10,
      chunkId: 0,
      temporalPassId: 0,
      poseSectionId: 4,
      trackIndex: 0,
      dividerCorridorId: '0:4:0',
      routeSStart: 0,
      routeSEnd: 100,
      interpolationMetadata: { permitted: false },
    };
    const runB = {
      ...runA,
      dividerRunId: '0:1:4:0:run:0',
      parentTrackId: '0:1:4:0',
      temporalPassId: 1,
      routeSStart: 50,
      routeSEnd: 120,
    };
    return { runA, runB };
  }

  it('T-A-030 valid same-pass grouping', () => {
    const { runA } = fixtureRuns();
    assert.equal(isSamePass(runA, { ...runA }), true);
  });

  it('T-A-031 same-pass cannot be corridor-linked', () => {
    const { runA } = fixtureRuns();
    const clone = { ...runA, dividerRunId: '0:0:4:0:run:1' };
    const result = evaluateCrossPassPair(runA, clone);
    assert.equal(result.code, E.A_XPS_001);
  });

  it('T-A-032 comparison-key match same segment', () => {
    const { runA, runB } = fixtureRuns();
    assert.equal(isComparisonKeyMatch(runA, runB), true);
  });

  it('T-A-033 comparison-key without linkage is linkage hypothesis only', () => {
    const { runA, runB } = fixtureRuns();
    const result = evaluateCrossPassPair(runA, runB);
    assert.equal(result.state, CROSS_PASS_STATES.LINKAGE_HYPOTHESIS);
    assert.equal(result.code, E.A_XPS_012);
  });

  it('T-A-034 structural candidate with validated linkage fixture', () => {
    const { runA, runB } = fixtureRuns();
    const linkage = buildValidatedSameSegmentLinkage(runA, runB, { roadCorridorId: 'corridor:test-040', routeSOverlapM: 50 });
    const runById = new Map([[runA.dividerRunId, runA], [runB.dividerRunId, runB]]);
    assert.equal(validateLinkageRecord(linkage, runById), null);
    assert.ok(routeSOverlapM(runA, runB) >= 5);
    const withoutTraversal = evaluateCrossPassPair(runA, runB, { linkageRecords: [linkage], runById });
    assert.equal(withoutTraversal.code, E.A_XPS_007);
    assert.notEqual(withoutTraversal.state, CROSS_PASS_STATES.GENUINE);
    assert.ok(routeSOverlapM(runA, runB) >= 5);
    const pairKey = [runA.dividerRunId, runB.dividerRunId].sort().join('|');
    const withTraversal = evaluateCrossPassPair(runA, runB, {
      linkageRecords: [linkage],
      runById,
      traversalLinkageByPair: new Map([[pairKey, { validated: true, traversalLinkageId: 'trav:1' }]]),
    });
    assert.equal(withTraversal.state, CROSS_PASS_STATES.GENUINE);
  });

  it('T-A-035 cross-segment key collision', () => {
    const runA = { ...fixtureRuns().runA, segmentId: 64 };
    const runB = { ...fixtureRuns().runB, segmentId: 57 };
    assert.equal(isCrossSegmentKeyCollision(runA, runB), true);
    const result = evaluateCrossPassPair(runA, runB);
    assert.equal(result.state, CROSS_PASS_STATES.LINKAGE_HYPOTHESIS);
    assert.equal(result.code, E.A_XPS_013);
  });

  it('T-A-036 equal chunkId across segments rejected', () => {
    const runA = { segmentId: 2, chunkId: 0, dividerCorridorId: '0:4:0', parentTrackId: 'a', temporalPassId: 0, dividerRunId: 'a:run:0' };
    const runB = { segmentId: 5, chunkId: 0, dividerCorridorId: '0:4:1', parentTrackId: 'b', temporalPassId: 1, dividerRunId: 'b:run:0' };
    const result = evaluateCrossPassPair(runA, runB);
    assert.equal(result.code, E.A_XPS_010);
  });

  it('T-A-037 equal poseSectionId across passes without linkage', () => {
    const { runA, runB } = fixtureRuns();
    const result = evaluateCrossPassPair(runA, runB);
    assert.notEqual(result.state, CROSS_PASS_STATES.CORRIDOR_LINKED);
    const poseOnly = evaluateCrossPassPair(runA, runB, { identityBasis: 'poseSectionId' });
    assert.equal(poseOnly.code, E.A_XPS_011);
  });

  it('T-A-038 valid authoritative corridor linkage', () => {
    const { runA, runB } = fixtureRuns();
    const runAlow = { ...runA, routeSStart: 0, routeSEnd: 1 };
    const runBlow = { ...runB, routeSStart: 10, routeSEnd: 11 };
    const linkage = buildValidatedSameSegmentLinkage(runAlow, runBlow);
    const runById = new Map([[runAlow.dividerRunId, runAlow], [runBlow.dividerRunId, runBlow]]);
    const result = evaluateCrossPassPair(runAlow, runBlow, { linkageRecords: [linkage], runById });
    assert.equal(result.roadCorridorId, linkage.roadCorridorId);
    assert.equal(result.code, E.A_XPS_007);
  });

  it('T-A-041 cross-segment with validated alignment', () => {
    const runA = { ...fixtureRuns().runA, segmentId: 64, dividerRunId: '0:0:4:0:run:0' };
    const runB = { ...fixtureRuns().runB, segmentId: 57, dividerRunId: '0:1:4:0:run:0' };
    const linkage = buildValidatedCrossSegmentLinkage(runA, runB, { roadCorridorId: 'corridor:cross:041' });
    const runById = new Map([[runA.dividerRunId, runA], [runB.dividerRunId, runB]]);
    const result = evaluateCrossPassPair(runA, runB, { linkageRecords: [linkage], runById });
    assert.equal(result.state, CROSS_PASS_STATES.PROVISIONAL);
    assert.equal(result.code, E.A_XPS_007);
    assert.notEqual(result.state, CROSS_PASS_STATES.GENUINE);
    const pairKey = [runA.dividerRunId, runB.dividerRunId].sort().join('|');
    const withTraversal = evaluateCrossPassPair(runA, runB, {
      linkageRecords: [linkage],
      runById,
      traversalLinkageByPair: new Map([[pairKey, { validated: true, traversalLinkageId: 'trav:041' }]]),
    });
    assert.equal(withTraversal.state, CROSS_PASS_STATES.GENUINE);
  });

  it('T-A-043 deterministic linkage grouping', () => {
    const { runA, runB } = fixtureRuns();
    const l1 = buildValidatedSameSegmentLinkage(runA, runB, { roadCorridorId: 'corridor:z' });
    const l2 = buildValidatedSameSegmentLinkage(runA, runB, { roadCorridorId: 'corridor:a' });
    const sorted = sortLinkageRecordsDeterministic([l1, l2]);
    assert.ok(sorted[0].corridorLinkageId < sorted[1].corridorLinkageId);
  });

  it('T-A-047 cross-chunk same pass rejection', () => {
    const runA = { ...fixtureRuns().runA, chunkId: 0, temporalPassId: 0, segmentId: 10, dividerRunId: 'a:run:0' };
    const runB = { ...fixtureRuns().runB, chunkId: 1, temporalPassId: 0, segmentId: 10, parentTrackId: '0:0:4:1', dividerRunId: 'b:run:0' };
    const result = evaluateCrossPassPair(runA, runB);
    assert.equal(result.code, E.A_XPS_003);
  });

  it('T-A-048 duplicate feature pair detection', () => {
    const { runA, runB } = fixtureRuns();
    const key = featurePairId(runA, runB);
    const dups = detectDuplicateFeaturePair([key, key]);
    assert.equal(dups.length, 1);
    assert.equal(dups[0].code, E.A_DUP_003);
    assert.equal(dups[0].pairKey, key);
  });

  it('T-A-039 conflicting linkage records', () => {
    const { runA, runB } = fixtureRuns();
    const l1 = buildValidatedSameSegmentLinkage(runA, runB, { roadCorridorId: 'corridor:a' });
    const l2 = buildValidatedSameSegmentLinkage(runA, runB, { roadCorridorId: 'corridor:b' });
    l2.corridorLinkageId = l1.corridorLinkageId;
    const runById = new Map([[runA.dividerRunId, runA], [runB.dividerRunId, runB]]);
    const errors = validateLinkageArtifact({ schemaVersion: CORRIDOR_LINKAGE_SCHEMA_VERSION, linkageRecords: [l1, l2] }, runById);
    assert.ok(errors.some((e) => e.code === E.A_LNK_001 || e.code === E.A_LNK_002));
  });

  it('T-A-040 missing linkage provenance', () => {
    const { runA, runB } = fixtureRuns();
    const linkage = buildValidatedSameSegmentLinkage(runA, runB);
    delete linkage.provenance;
    const runById = new Map([[runA.dividerRunId, runA], [runB.dividerRunId, runB]]);
    const err = validateLinkageRecord(linkage, runById);
    assert.equal(err.code, E.A_LNK_005);
  });

  it('T-A-056 corridor linkage endpoint FK field mismatch', () => {
    const { runA, runB } = fixtureRuns();
    const linkage = buildValidatedSameSegmentLinkage(runA, runB);
    linkage.endpoints[1].segmentId = 999;
    const runById = new Map([[runA.dividerRunId, runA], [runB.dividerRunId, runB]]);
    const err = validateLinkageRecord(linkage, runById);
    assert.equal(err.code, E.A_LNK_004);
  });

  it('T-A-040b linkage endpoint not in supported runs', () => {
    const { runA, runB } = fixtureRuns();
    const linkage = buildValidatedSameSegmentLinkage(runA, runB);
    linkage.endpoints[1].dividerRunId = 'missing:run';
    const runById = new Map([[runA.dividerRunId, runA]]);
    const err = validateLinkageRecord(linkage, runById);
    assert.equal(err.code, E.A_LNK_003);
  });

  it('T-A-040c cross-segment validated without alignment record', () => {
    const runA = { ...fixtureRuns().runA, segmentId: 64 };
    const runB = { ...fixtureRuns().runB, segmentId: 57 };
    const linkage = buildValidatedCrossSegmentLinkage(runA, runB);
    delete linkage.crossSegmentAlignment;
    const runById = new Map([[runA.dividerRunId, runA], [runB.dividerRunId, runB]]);
    const err = validateLinkageRecord(linkage, runById);
    assert.equal(err.code, E.A_LNK_006);
  });

  it('T-A-040d cross-segment linkage without alignment stays provisional', () => {
    const runA = { ...fixtureRuns().runA, segmentId: 64, dividerRunId: 'x:run:0' };
    const runB = { ...fixtureRuns().runB, segmentId: 57, dividerRunId: 'y:run:0' };
    const linkage = buildValidatedCrossSegmentLinkage(runA, runB);
    linkage.crossSegmentAlignment.validationState = 'pending';
    const runById = new Map([[runA.dividerRunId, runA], [runB.dividerRunId, runB]]);
    const result = evaluateCrossPassPair(runA, runB, { linkageRecords: [linkage], runById });
    assert.equal(result.code, E.A_XPS_008);
  });

  it('T-A-040e corridor identity unavailable without linkage', () => {
    const runA = { ...fixtureRuns().runA, dividerCorridorId: '0:4:1', parentTrackId: '0:0:4:1' };
    const runB = { ...fixtureRuns().runB, dividerCorridorId: '0:4:2', parentTrackId: '0:1:4:2' };
    const result = evaluateCrossPassPair(runA, runB);
    assert.equal(result.code, E.A_XPS_009);
  });

  it('T-A-040f cross-pose-section same segment rejection', () => {
    const runA = { segmentId: 10, chunkId: 0, temporalPassId: 0, poseSectionId: 4, parentTrackId: '0:0:4:0', dividerCorridorId: '0:4:0', dividerRunId: 'a:run:0' };
    const runB = { segmentId: 10, chunkId: 0, temporalPassId: 1, poseSectionId: 5, parentTrackId: '0:1:5:0', dividerCorridorId: '0:5:0', dividerRunId: 'b:run:0' };
    assert.equal(evaluateCrossPassPair(runA, runB).code, E.A_XPS_004);
  });

  it('T-A-042 same segment without traversal proof stays provisional', () => {
    const { runA, runB } = fixtureRuns();
    const linkage = buildValidatedSameSegmentLinkage(runA, runB);
    const runById = new Map([[runA.dividerRunId, runA], [runB.dividerRunId, runB]]);
    const result = evaluateCrossPassPair(runA, runB, { linkageRecords: [linkage], runById });
    assert.equal(result.state, CROSS_PASS_STATES.PROVISIONAL);
    assert.equal(result.code, E.A_XPS_007);
  });

  it('T-A-044 equal dividerCorridorId without linkage', () => {
    const { runA, runB } = fixtureRuns();
    const result = evaluateCrossPassPair(runA, runB);
    assert.equal(result.state, CROSS_PASS_STATES.LINKAGE_HYPOTHESIS);
  });

  it('T-A-045 cross-segment without linkage unavailable for structural', () => {
    const runA = { ...fixtureRuns().runA, segmentId: 64 };
    const runB = { ...fixtureRuns().runB, segmentId: 57 };
    const result = evaluateCrossPassPair(runA, runB);
    assert.notEqual(result.state, CROSS_PASS_STATES.STRUCTURAL_CANDIDATE);
    assert.notEqual(result.state, CROSS_PASS_STATES.GENUINE);
  });

  it('T-A-046 self-pair rejection', () => {
    const { runA } = fixtureRuns();
    const result = evaluateCrossPassPair(runA, runA);
    assert.equal(result.code, E.A_XPS_002);
  });

  it('T-A-049 geometry overlap not corridor identity', () => {
    const { runA, runB } = fixtureRuns();
    assert.equal(isComparisonKeyMatch(runA, runB), true);
    const overlapOnly = evaluateCrossPassPair(runA, runB, { identityBasis: 'geometry_overlap' });
    assert.equal(overlapOnly.code, E.A_LEG_003);
    const runA2 = { ...runA, dividerCorridorId: '0:4:0', routeSStart: 0, routeSEnd: 100 };
    const runB2 = { ...runB, dividerCorridorId: '0:4:1', routeSStart: 50, routeSEnd: 120, parentTrackId: '0:1:4:1' };
    assert.equal(isComparisonKeyMatch(runA2, runB2), false);
    const linkage = buildValidatedSameSegmentLinkage(runA2, runB2);
    linkage.evidenceInputs.geometryOnlyValidation = true;
    linkage.validationState = 'validated';
    const runById = new Map([[runA2.dividerRunId, runA2], [runB2.dividerRunId, runB2]]);
    const err = validateLinkageRecord(linkage, runById);
    assert.equal(err.code, E.A_LNK_007);
  });
});

describe('Amendment A — legacy and immutability', () => {
  it('T-A-050 v0 legacy unavailable', () => {
    const v0 = JSON.parse(fs.readFileSync(path.join(ROOT, 'lane_divider_supported_runs_v0.json'), 'utf8'));
    assert.equal(isLegacyV0Artifact(v0), true);
    const unavailable = legacyV0Unavailable();
    assert.equal(unavailable.code, E.A_LEG_001);
  });

  it('T-A-051 frozen v11 unchanged', () => {
    assert.equal(PROCESSING_VERSION, '2026-07-24-fusion-v12');
  });

  it('T-A-052 Revision 37 maxSpatialJumpM unchanged', () => {
    const { config } = require('../lib/stage19_spec/config');
    assert.equal(config.maxSpatialJumpM, 12);
  });

  it('T-A-053 current.json unchanged', () => {
    const currentPath = path.join(ROOT, 'stage19_bundle', 'current.json');
    assert.ok(fs.existsSync(currentPath));
    const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
    assert.equal(current.runId || current.checkpoint, '2026-07-27-stage19-v5');
  });
});

describe('Amendment A — acceptance audit', () => {
  it('real-data acceptance counters from validators', () => {
    const audit = auditV1Artifact(ROOT);
    assert.equal(audit.totalRuns, 878);
    assert.equal(audit.coverage.segmentId.count, 878);
    assert.equal(audit.coverage.segmentId.pct, 100);
    assert.equal(audit.coverage.dividerCorridorId.pct, 100);
    assert.equal(audit.crossBoundarySupportedRuns, 0);
    assert.equal(audit.memberObservationIdentityConflicts, 0);
    assert.equal(audit.duplicatedSupportedRuns, 0);
    assert.equal(audit.evidenceStates.structural, 0);
    assert.equal(audit.evidenceStates.genuine, 0);
    assert.equal(audit.evidenceStates.crossSegmentKeyCollisions, 3);
    assert.equal(audit.linkageRecordsAutoGenerated, 0);
  });

  it('deterministic file hash byte equality on fixed timestamp', () => {
    const out = path.join(ROOT, 'lane_divider_supported_runs_v1.json');
    const h1 = sha256File(out);
    const built = buildV1SupportedRunsArtifact(ROOT, { createdAt: FIXED_TS });
    const json = canonicalJson(built.artifact);
    const h2 = crypto.createHash('sha256').update(json).digest('hex');
    assert.equal(built.artifact.contentHashSha256, '0742ca6aa4ecce0cb877f045659c79510aa2ed1e317be6564f4ff0319ee4c9f7');
    assert.equal(h1, h2);
  });
});
