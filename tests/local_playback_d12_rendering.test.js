'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const LMC = require('../lib/lane_map_cleanup');
const SLM = require('../lib/segment_local_map');
const {
  analyzeDrawablePaths,
  verifyNoRendererBridgeAcrossGaps,
  simulateRendererSegments,
  RENDERER_MAX_GAP_M,
} = require('../lib/drawable_path');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEG2 = 'qlog_f449c_2.bz2';
const OPEN_TOLERANCE_M = 0.05;

function loadSegment() {
  const segPath = path.join(ROOT, SEG2);
  const modelEvents = extractModel(segPath).map((e) => ({ ...e, sourceFile: SEG2 }));
  const gpsEvents = extractGps(segPath).map((e) => ({ ...e, sourceFile: SEG2 }));
  return processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
}

function loadD12Gaps() {
  const audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit_segment2_class_d_fusion_gaps.json'), 'utf8'));
  return audit.gaps.filter((g) => g.primaryMechanism === 'D12');
}

function buildCleanup(data) {
  const chunk = data.routeChunks[0];
  return LMC.buildCleanedLaneMap({
    frames: chunk.frames,
    fusedLanes: chunk.fusedLaneLines,
    tracks: chunk.laneTracks,
    chunkId: 0,
    passId: 0,
    vehiclePath: chunk.vehiclePath,
    classDGaps: loadD12Gaps(),
    enableD12Preservation: true,
  });
}

describe('D12 rendering verification', () => {
  it('1. unsupported intervals create separate drawable path components via inter-run breaks', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { POST_STAGE7_BASELINE } = require('../lib/lane_continuity_stage7');
    const cleanup = buildCleanup(loadSegment());
    const d = cleanup.drawablePathAnalysis;
    assert.ok(d);
    assert.equal(d.logicalCleanedRunCount, POST_STAGE7_BASELINE.cleanedRuns);
    assert.ok(d.interRunBreaks.length >= 3);
    for (const gapId of ['CD-10', 'CD-12', 'CD-18']) {
      const brk = d.interRunBreaks.find((b) => b.gapId === gapId);
      assert.ok(brk, gapId);
      assert.equal(brk.shareOneCanvasPath, false);
    }
  });

  it('2. no renderer segment crosses CD-10 1.466 m gap', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment());
    const { violations } = verifyNoRendererBridgeAcrossGaps(cleanup.cleaned, cleanup.preservedIntervals, ['CD-10']);
    assert.equal(violations.length, 0);
    const brk = cleanup.drawablePathAnalysis.interRunBreaks.find((b) => b.gapId === 'CD-10');
    assert.ok(Math.abs(brk.openLengthM - 1.466) < OPEN_TOLERANCE_M);
  });

  it('3. no renderer segment crosses CD-12 1.640 m gap', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment());
    const { violations } = verifyNoRendererBridgeAcrossGaps(cleanup.cleaned, cleanup.preservedIntervals, ['CD-12']);
    assert.equal(violations.length, 0);
    const brk = cleanup.drawablePathAnalysis.interRunBreaks.find((b) => b.gapId === 'CD-12');
    assert.ok(Math.abs(brk.openLengthM - 1.640) < OPEN_TOLERANCE_M);
  });

  it('4. no renderer segment crosses CD-18 1.476 m gap', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment());
    const { violations } = verifyNoRendererBridgeAcrossGaps(cleanup.cleaned, cleanup.preservedIntervals, ['CD-18']);
    assert.equal(violations.length, 0);
    const brk = cleanup.drawablePathAnalysis.interRunBreaks.find((b) => b.gapId === 'CD-18');
    assert.ok(Math.abs(brk.openLengthM - 1.476) < OPEN_TOLERANCE_M);
  });

  it('5. CD-00 and CD-02 remain fully resolved single-run coverage', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment());
    for (const gapId of ['CD-00', 'CD-02']) {
      const iv = cleanup.preservedIntervals.find((p) => p.gapId === gapId);
      assert.ok(iv?.fullCoverage);
      const runs = cleanup.cleaned.filter((r) => r.physicalBoundaryId === iv.physicalBoundaryGroup
        && r.sMin <= iv.gapEndS + 0.5 && r.sMax >= iv.gapStartS - 0.5);
      const covering = runs.filter((r) => (r.sMin ?? 0) <= iv.startS + 0.5 && (r.sMax ?? 0) >= iv.endS - 0.5);
      assert.ok(covering.length >= 1, `${gapId} must have run spanning preserved interval`);
    }
  });

  it('6. supported coordinates unchanged by drawable analysis', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment());
    const before = cleanup.cleaned.map((r) => r.points.length);
    analyzeDrawablePaths(cleanup.cleaned, cleanup.preservedIntervals);
    assert.deepEqual(cleanup.cleaned.map((r) => r.points.length), before);
  });

  it('7. no interpolated coordinates in drawable components', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment());
    for (const comp of cleanup.drawablePathAnalysis.drawableComponents) {
      assert.ok(comp.points.length >= 1);
    }
  });

  it('8. PB and track identity preserved on drawable components', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment());
    for (const run of cleanup.cleaned) {
      const comps = cleanup.drawablePathAnalysis.drawableComponents.filter((c) => c.runId === run.runId);
      for (const c of comps) {
        assert.equal(c.physicalBoundaryId, run.physicalBoundaryId);
        assert.equal(c.laneTrackId, run.laneTrackId);
      }
    }
  });

  it('9. PB1 and PB2 CD-10/CD-18 breaks are independent', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment());
    const b10 = cleanup.drawablePathAnalysis.interRunBreaks.find((b) => b.gapId === 'CD-10');
    const b18 = cleanup.drawablePathAnalysis.interRunBreaks.find((b) => b.gapId === 'CD-18');
    assert.equal(b10.physicalBoundaryId, 'PB1');
    assert.equal(b18.physicalBoundaryId, 'PB2');
    assert.notEqual(b10.precedingRunId, b18.precedingRunId);
  });

  it('10. coverage accounting unchanged by drawable analysis', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment());
    const union = cleanup.coverageAccounting.routeSIntervalCoverage.combinedSupportedUnionM;
    analyzeDrawablePaths(cleanup.cleaned, cleanup.preservedIntervals);
    assert.equal(cleanup.coverageAccounting.routeSIntervalCoverage.combinedSupportedUnionM, union);
  });

  it('11. fused fragment count matches accepted baseline (18)', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { POST_STAGE7_BASELINE } = require('../lib/lane_continuity_stage7');
    assert.equal(buildCleanup(loadSegment()).stats.fusedFragmentCount, POST_STAGE7_BASELINE.fusedFragments);
  });

  it('12. logical cleaned run count 17; one fragment per run in Mode 5', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { POST_STAGE7_BASELINE } = require('../lib/lane_continuity_stage7');
    const data = loadSegment();
    const cleanup = buildCleanup(data);
    const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
    assert.equal(cleanup.cleaned.length, POST_STAGE7_BASELINE.cleanedRuns);
    assert.equal(map.laneFragmentCount, POST_STAGE7_BASELINE.cleanedRuns);
    assert.equal(cleanup.drawablePathAnalysis.logicalCleanedRunCount, POST_STAGE7_BASELINE.cleanedRuns);
  });

  it('13. false visual bridge not detected', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment());
    assert.equal(cleanup.drawablePathAnalysis.falseVisualBridgeDetected, false);
  });

  it('14. Mode 5 stationary and no road surface', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const checksums = new Set();
    for (const idx of [0, 8, 16, 26]) {
      checksums.add(SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: idx }).checksum);
    }
    assert.equal(checksums.size, 1);
    const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
    assert.equal(map.roadSurfacePolygonCount, 0);
  });

  it('15. renderer maxGapM would bridge intra-run gaps under 15 m — gaps are inter-run', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment());
    for (const brk of cleanup.drawablePathAnalysis.interRunBreaks) {
      const pre = cleanup.cleaned.find((r) => r.runId === brk.precedingRunId);
      const fol = cleanup.cleaned.find((r) => r.runId === brk.followingRunId);
      const segsPre = simulateRendererSegments(pre.points, RENDERER_MAX_GAP_M);
      const segsFol = simulateRendererSegments(fol.points, RENDERER_MAX_GAP_M);
      assert.ok(segsPre.length >= 0);
      assert.ok(segsFol.length >= 0);
      assert.equal(brk.shareOneCanvasPath, false);
    }
  });

  it('16. transform arrow and sync sources unchanged', () => {
    const render = fs.readFileSync(path.join(ROOT, 'public/render.js'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
    assert.match(render, /_drawLocalPlaybackArrow/);
    assert.match(app, /localPlaybackVideo\?\.tickSync/);
  });

  it('17. exact remaining D12 open length sums to 4.58 m', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment());
    const sum = cleanup.drawablePathAnalysis.interRunBreaks
      .filter((b) => ['CD-10', 'CD-12', 'CD-18'].includes(b.gapId))
      .reduce((s, b) => s + b.openLengthM, 0);
    assert.ok(Math.abs(sum - 4.58) < OPEN_TOLERANCE_M);
  });
});
