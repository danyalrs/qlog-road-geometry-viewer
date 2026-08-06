'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadSegment, buildCtx, PRE_STAGE7_SEGMENT_OPTS } = require('../lib/lane_continuity_stage7');
const { buildLaneDiagnostics, RENDERER_MAX_INTRA_GAP_M } = require('../lib/geometry_diagnostics');
const SLM = require('../lib/segment_local_map');
const { PROCESSING_VERSION } = require('../lib/version');

describe('geometry diagnostics — Stage 7 browser verification', () => {
  it('computes lane checksum 10845acd on post-Stage-7 production path', () => {
    const data = loadSegment({
      bimodalClusterSelection: true,
      positiveBoundaryContinuityBridgeEnabled: true,
    });
    const map = SLM.buildSegmentLocalMap({
      ...data,
      processingVersion: PROCESSING_VERSION,
      processingOptions: data.processingOptions,
    }, { geometrySource: 'cleaned', timelineIndex: 0 });
    const diag = buildLaneDiagnostics(
      {
        processingVersion: PROCESSING_VERSION,
        routeChunks: data.routeChunks,
        processingOptions: data.processingOptions,
      },
      map,
      data.processingOptions,
    );
    assert.equal(diag.laneChecksum, '10845acd');
    assert.equal(diag.fusedFragmentCount, 18);
    assert.equal(diag.cleanedRunCount, 17);
    assert.equal(diag.stableDisconnectionCount, 14);
    assert.equal(diag.pbGapCounts.PB1, 8);
    assert.equal(diag.stage7RepairFlag, true);
    assert.deepEqual(diag.acceptedRepairedGapIds, ['DC-009', 'DC-010', 'DC-011', 'DC-012']);
  });

  it('pre-Stage-7 baseline checksum remains ff6d115e', () => {
    const data = loadSegment(PRE_STAGE7_SEGMENT_OPTS);
    const map = SLM.buildSegmentLocalMap({
      ...data,
      processingVersion: PROCESSING_VERSION,
      processingOptions: data.processingOptions,
    }, { geometrySource: 'cleaned', timelineIndex: 0 });
    assert.equal(map.laneChecksum, 'ff6d115e');
  });

  it('distinguishes structural-only vs rendered continuity by renderer gap threshold', () => {
    const data = loadSegment({
      bimodalClusterSelection: true,
      positiveBoundaryContinuityBridgeEnabled: true,
    });
    const map = SLM.buildSegmentLocalMap({
      ...data,
      processingVersion: PROCESSING_VERSION,
      processingOptions: data.processingOptions,
    }, { geometrySource: 'cleaned', timelineIndex: 0 });
    const diag = buildLaneDiagnostics(
      {
        processingVersion: PROCESSING_VERSION,
        routeChunks: data.routeChunks,
        processingOptions: data.processingOptions,
      },
      map,
      data.processingOptions,
    );
    const byId = Object.fromEntries(diag.repairAnalysis.map((r) => [r.id, r]));
    assert.equal(byId['DC-009'].verdict, 'rendered_continuity');
    assert.ok(byId['DC-009'].coordinateJump.jumpM < RENDERER_MAX_INTRA_GAP_M);
    assert.equal(byId['DC-010'].verdict, 'structural_only');
    assert.ok(byId['DC-010'].coordinateJump.jumpM > RENDERER_MAX_INTRA_GAP_M);
    assert.equal(byId['DC-011'].verdict, 'rendered_continuity');
    assert.equal(byId['DC-012'].verdict, 'structural_only');
    assert.equal(diag.continuityVerdict, 'mixed');
  });

  it('reports zero generated interior geometry', () => {
    const data = loadSegment({
      bimodalClusterSelection: true,
      positiveBoundaryContinuityBridgeEnabled: true,
    });
    const map = SLM.buildSegmentLocalMap({
      ...data,
      processingVersion: PROCESSING_VERSION,
      processingOptions: data.processingOptions,
    }, { geometrySource: 'cleaned', timelineIndex: 0 });
    const diag = buildLaneDiagnostics(
      {
        processingVersion: PROCESSING_VERSION,
        routeChunks: data.routeChunks,
        processingOptions: data.processingOptions,
      },
      map,
      data.processingOptions,
    );
    for (const r of diag.repairAnalysis) {
      assert.equal(r.generatedInteriorPointsM ?? 0, 0);
    }
  });
});
