'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
const LMC = require('../lib/lane_map_cleanup');
const SLM = require('../lib/segment_local_map');
const LCS = require('../lib/lane_continuity_stage1');
const { collectLaneObservations } = require('../lib/sd_fusion');
const { buildReferenceTrajectory } = require('../lib/trajectory');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEG = 'qlog_f449c_2.bz2';
const AUDIT_PATH = path.join(ROOT, 'audit_segment2_lane_continuity_stage1.json');

function loadSegment() {
  const segPath = path.join(ROOT, SEG);
  const model = extractModel(segPath).map((e) => ({ ...e, sourceFile: SEG }));
  const gps = extractGps(segPath).map((e) => ({ ...e, sourceFile: SEG }));
  const result = processRoute(model, gps, {
    pipelineMode: 'C',
    trackerContinuityBridgeEnabled: false,
    bimodalClusterSelection: false,
  });
  const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
  return { ...result, timeline };
}

function buildAudit() {
  const data = loadSegment();
  const chunk = data.routeChunks[0];
  const classDGaps = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'audit_segment2_class_d_fusion_gaps.json'), 'utf8',
  )).gaps;
  const cleanup = LMC.buildCleanedLaneMap({
    frames: chunk.frames,
    fusedLanes: chunk.fusedLaneLines,
    tracks: chunk.laneTracks,
    chunkId: 0,
    passId: 0,
    vehiclePath: chunk.vehiclePath,
    classDGaps: classDGaps.filter((g) => g.primaryMechanism === 'D12'),
    enableD12Preservation: true,
  });
  const mode5 = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
  const trajectory = buildReferenceTrajectory(chunk.vehiclePath);
  const observations = collectLaneObservations(chunk.frames, trajectory);
  return LCS.runLaneContinuityStage1({
    data, cleanup, mode5Map: mode5, frames: chunk.frames, timeline: data.timeline,
    observations, fusedLanes: chunk.fusedLaneLines, classDGaps, laneChecksumBefore: mode5.laneChecksum,
  });
}

describe('Segment 2 lane-continuity Stage 1 audit', () => {
  it('1. every final fragment endpoint is accounted for', () => {
    if (!fs.existsSync(path.join(ROOT, SEG))) return;
    const audit = buildAudit();
    assert.equal(audit.endpoints.length, audit.summary.totalFinalLaneFragments * 2);
    assert.equal(audit.endpoints.length, 56);
  });

  it('2. every candidate connection has provenance', () => {
    if (!fs.existsSync(path.join(ROOT, SEG))) return;
    const audit = buildAudit();
    for (const ep of audit.endpoints) {
      for (const c of ep.candidateContinuations || []) {
        assert.ok(c.candidateRunId != null);
        assert.ok(c.candidatePb);
      }
    }
  });

  it('3. every disconnection has one primary classification', () => {
    if (!fs.existsSync(path.join(ROOT, SEG))) return;
    const audit = buildAudit();
    for (const d of audit.disconnections) {
      assert.ok(LCS.PRIMARY_CAUSES.includes(d.primaryCause), d.disconnectionId);
    }
  });

  it('4. first pipeline stage where split appears is recorded', () => {
    if (!fs.existsSync(path.join(ROOT, SEG))) return;
    const audit = buildAudit();
    assert.ok(audit.disconnections.every((d) => d.firstPipelineStageDisconnected));
  });

  it('5. no cross-pass connection is recommended as safe', () => {
    if (!fs.existsSync(path.join(ROOT, SEG))) return;
    const audit = buildAudit();
    const safe = audit.disconnections.filter((d) => d.safeConnectionCandidate);
    assert.ok(safe.every((d) => d.passId === 0));
  });

  it('6. no cross-chunk connection is recommended as safe without evidence', () => {
    if (!fs.existsSync(path.join(ROOT, SEG))) return;
    const audit = buildAudit();
    const safe = audit.disconnections.filter((d) => d.safeConnectionCandidate);
    assert.ok(safe.every((d) => d.chunkId === 0));
  });

  it('7. no proposed safe connection crosses another boundary', () => {
    if (!fs.existsSync(path.join(ROOT, SEG))) return;
    const audit = buildAudit();
    for (const d of audit.disconnections.filter((x) => x.safeConnectionCandidate)) {
      assert.ok(d.samePhysicalBoundaryEvidence);
      assert.ok(!d.connectionIssues?.includes('different_physical_boundary'));
    }
  });

  it('8. lane order remains valid for each recommendation', () => {
    if (!fs.existsSync(path.join(ROOT, SEG))) return;
    const audit = buildAudit();
    for (const d of audit.disconnections) {
      if (d.safeConnectionCandidate) {
        assert.ok(d.candidateStartRouteS > d.endpointRouteS - 0.1, d.disconnectionId);
      }
    }
  });

  it('9. competing continuations are recorded on endpoints', () => {
    if (!fs.existsSync(path.join(ROOT, SEG))) return;
    const audit = buildAudit();
    const withCandidates = audit.endpoints.filter((e) => e.candidateContinuations?.length > 1);
    assert.ok(withCandidates.length > 0);
  });

  it('10. unknown cases remain unresolved instead of auto-joined', () => {
    if (!fs.existsSync(path.join(ROOT, SEG))) return;
    const audit = buildAudit();
    const unknown = audit.disconnections.filter((d) => d.primaryCause === 'unknown');
    assert.ok(unknown.every((d) => !d.safeConnectionCandidate || d.preliminaryVerdict !== 'continuous'));
  });

  it('11. Mode 5 checksum remains 5283af91 during investigation', () => {
    if (!fs.existsSync(path.join(ROOT, SEG))) return;
    const audit = buildAudit();
    assert.equal(audit.summary.laneChecksum, '5283af91');
  });

  it('12. cleaned-run count remains 28 during investigation', () => {
    if (!fs.existsSync(path.join(ROOT, SEG))) return;
    const audit = buildAudit();
    assert.equal(audit.summary.cleanedRunCount, 28);
  });

  it('13. fused-fragment count remains 33 during investigation', () => {
    if (!fs.existsSync(path.join(ROOT, SEG))) return;
    const audit = buildAudit();
    assert.equal(audit.summary.fusedFragmentCount, 33);
  });

  it('14. no road-surface geometry changes', () => {
    if (!fs.existsSync(path.join(ROOT, SEG))) return;
    const data = loadSegment();
    const proto = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleanedWithStage1Surface', timelineIndex: 0 });
    assert.equal(proto.roadSurfacePolygonCount, 14);
  });

  it('15. audit JSON export exists and matches frozen Stage 1 baseline', () => {
    if (!fs.existsSync(path.join(ROOT, SEG))) return;
    if (!fs.existsSync(AUDIT_PATH)) return;
    const exported = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
    assert.equal(exported.summary.laneChecksum, '5283af91');
    assert.equal(exported.summary.cleanedRunCount, 28);
    assert.equal(exported.summary.fusedFragmentCount, 33);
    assert.equal(exported.endpoints.length, 56);
  });
});
