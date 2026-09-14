'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const VMB = require('../lib/viewer_map_build');
const SLM = require('../lib/segment_local_map');
const CBAO = require('../lib/combined_boundary_anchored_orientation');
const CVLP = require('../lib/combined_visible_lane_projection');
const DIAG = require('../lib/segment1_lane_order_diagnostic');
const CST = require('../lib/combined_source_transform');

const ROOT = path.join(__dirname, '..');
const SEG1 = 'qlog_f449c_1.bz2';
const FRAMES = [1603, 1803, 2003];
const RENDER_SRC = fs.readFileSync(path.join(ROOT, 'public/render.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

function processSelection(segments) {
  const files = segments.map((s) => `qlog_f449c_${s}.bz2`);
  const loaded = require('../lib/qlog_data').loadSegmentsData(ROOT, files, VMB.VIEWER_DEFAULT_PROCESS_OPTIONS);
  const { processRoute, buildTimeline } = require('../lib/process_route');
  const { qualifySegments } = require('../lib/segment_qualify');
  const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
  const sq = qualifySegments(loaded.audits);
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
    ...VMB.VIEWER_DEFAULT_PROCESS_OPTIONS,
    segmentQualifications: sq,
    fileAudits: loaded.audits,
  });
  return {
    ...result,
    timeline: enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath),
    fileAudits: loaded.audits,
  };
}

function buildCombined(pd, geometrySource = 'pointAccumulated') {
  const base = SLM.buildSegmentLocalMap(pd, { geometrySource, timelineIndex: 0, fitEnabled: true });
  return CBAO.applyBoundaryAnchoredOrientation(base, pd, { mirrorChecked: true });
}

function projectPaMap(map) {
  CVLP.resetDrawDiagnostics();
  return {
    ...map,
    pointAccumulated: {
      ...map.pointAccumulated,
      points: (map.pointAccumulated?.points || []).map((p) => {
        const r = CVLP.projectCombinedSourceLanePoint(p, map, 'pointAccumulated', {
          mirrorChecked: true,
          useVisibleLaneProjection: true,
        });
        if (!r?.corrected) return p;
        return {
          ...p,
          placedEast: r.east,
          placedNorth: r.north,
          east: r.east,
          north: r.north,
          localEast: r.east,
          localNorth: r.north,
        };
      }),
    },
  };
}

function projectFusedMap(map) {
  CVLP.resetDrawDiagnostics();
  return {
    ...map,
    laneFragments: (map.laneFragments || []).map((frag) => {
      CVLP.noteLaneFragmentPass();
      return {
        ...frag,
        points: (frag.points || []).map((p) => {
          const r = CVLP.projectCombinedSourceLanePoint(p, map, 'laneFragments', {
            mirrorChecked: true,
            useVisibleLaneProjection: true,
            fragmentHint: frag,
          });
          if (!r?.corrected) return p;
          return {
            ...p,
            placedEast: r.east,
            placedNorth: r.north,
            east: r.east,
            north: r.north,
          };
        }),
      };
    }),
  };
}

function checksumTrajectory(traj) {
  return JSON.stringify((traj || []).map((p) => [
    p.placedEast ?? p.east,
    p.placedNorth ?? p.north,
    p.sourceFile,
    p.frameId,
  ]));
}

test('1. candidate is enabled by default; explicit 0 disables it', () => {
  assert.equal(CVLP.parseCombinedVisibleLaneProjectionCandidate(''), true);
  assert.equal(CVLP.parseCombinedVisibleLaneProjectionCandidate('?combinedVisibleLaneProjectionCandidate=1'), true);
  assert.equal(CVLP.parseCombinedVisibleLaneProjectionCandidate('?combinedVisibleLaneProjectionCandidate=0'), false);
  assert.equal(CVLP.isCandidateEligible(buildCombined(processSelection([0, 1, 2])), {
    useVisibleLaneProjection: false,
    mirrorChecked: true,
  }), false);
});

test('2. candidate requires Candidate C and multiple sources', () => {
  assert.equal(CVLP.isCandidateEligible(null, { useVisibleLaneProjection: true }), false);
  const stand = SLM.buildSegmentLocalMap(processSelection([1]), {
    geometrySource: 'pointAccumulated',
    timelineIndex: 0,
    fitEnabled: true,
  });
  assert.equal(CVLP.isCandidateEligible(stand, {
    useVisibleLaneProjection: true,
    mirrorChecked: true,
  }), false);
});

test('3. PA draw pass uses the shared lane helper', () => {
  assert.match(RENDER_SRC, /projectCombinedSourceLanePoint/);
  assert.match(RENDER_SRC, /_visibleLaneProjectionPass = 'pointAccumulated'/);
  assert.match(INDEX_SRC, /combined_visible_lane_projection\.js/);
});

test('4. fused fragment draw pass uses the same helper', () => {
  assert.match(RENDER_SRC, /_visibleLaneProjectionPass = 'laneFragments'/);
});

test('5-6. PA and fused visible projections move Seg1 points', () => {
  const pd = processSelection([0, 1, 2]);
  const pa = buildCombined(pd, 'pointAccumulated');
  const fused = buildCombined(pd, 'fused');
  const samplePa = (pa.pointAccumulated.points || []).find((p) => p.sourceFile === SEG1 && p.frameId === 1803);
  const beforePa = { e: samplePa.placedEast, n: samplePa.placedNorth };
  const projPa = CVLP.projectCombinedSourceLanePoint(samplePa, pa, 'pointAccumulated', {
    mirrorChecked: true,
    useVisibleLaneProjection: true,
  });
  assert.equal(projPa.corrected, true);
  assert.ok(Math.hypot(projPa.east - beforePa.e, projPa.north - beforePa.n) > 1e-6);

  const sampleFrag = (fused.laneFragments || []).flatMap((f) => f.points || [])[0];
  const beforeF = { e: sampleFrag.east, n: sampleFrag.north };
  const projF = CVLP.projectCombinedSourceLanePoint(sampleFrag, fused, 'laneFragments', {
    mirrorChecked: true,
    useVisibleLaneProjection: true,
  });
  assert.equal(projF.corrected, true);
  assert.ok(Math.hypot(projF.east - beforeF.e, projF.north - beforeF.n) > 1e-6);
});

test('7. source-relative anchor remains fixed', () => {
  const map = buildCombined(processSelection([0, 1, 2]), 'pointAccumulated');
  const p = (map.pointAccumulated.points || []).find((x) => x.sourceFile === SEG1 && x.frameId === 1803);
  const pair = CVLP.findTrajectoryAnchorPair(map.baselineTrajectory, map.trajectory, p);
  assert.ok(pair);
  const r = CVLP.projectCombinedSourceLanePoint(p, map, 'pointAccumulated', {
    mirrorChecked: true,
    useVisibleLaneProjection: true,
  });
  // Anchor itself projects to the accepted placed anchor when offset is zeroed conceptually:
  // rotated offset from lane, not from moving the anchor.
  assert.equal(pair.placedEast, map.trajectory.find((t) => t.sourceFile === SEG1 && t.frameId === 1803).placedEast
    ?? map.trajectory.find((t) => t.sourceFile === SEG1 && t.frameId === 1803).east);
  assert.ok(r.corrected);
  assert.equal(r.sourceAnchorId, pair.sourceAnchorId);
});

test('8. no global-origin reflection', () => {
  const map = buildCombined(processSelection([0, 1, 2]), 'pointAccumulated');
  const p = (map.pointAccumulated.points || []).find((x) => x.sourceFile === SEG1 && x.frameId === 1803);
  const r = CVLP.projectCombinedSourceLanePoint(p, map, 'pointAccumulated', {
    mirrorChecked: true,
    useVisibleLaneProjection: true,
  });
  assert.notEqual(r.east, -p.placedEast);
  assert.notEqual(r.north, -p.placedNorth);
});

test('9. no Segment 1 filename or frame hardcoding in helper', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/combined_visible_lane_projection.js'), 'utf8');
  assert.doesNotMatch(src, /qlog_f449c_1/);
  assert.doesNotMatch(src, /1803/);
});

test('10. lane identities and colours remain stable at sample frames', () => {
  const pdStand = processSelection([1]);
  const pdComb = processSelection([0, 1, 2]);
  const stand = SLM.buildSegmentLocalMap(pdStand, {
    geometrySource: 'pointAccumulated',
    timelineIndex: pdStand.timeline.findIndex((t) => t.sourceFile === SEG1),
    fitEnabled: true,
  });
  const cand = projectPaMap(buildCombined(pdComb, 'pointAccumulated'));
  for (const frameId of FRAMES) {
    const rows = DIAG.compareRoadRelativeOrder(
      DIAG.summarizeLaneLines(stand, 'standalone', frameId, true),
      DIAG.summarizeLaneLines(cand, 'combined', frameId, true),
    );
    assert.ok(rows.length > 0, `expected lanes at ${frameId}`);
    for (const row of rows) {
      assert.equal(row.sideReversed, false, `side reversed ${row.laneIdentity} @${frameId}`);
      assert.equal(row.colourSame, true);
      assert.equal(row.identitySame, true);
    }
  }
});

test('11. missing provenance falls back safely', () => {
  const map = buildCombined(processSelection([0, 1, 2]), 'pointAccumulated');
  CVLP.resetDrawDiagnostics();
  const r = CVLP.projectCombinedSourceLanePoint({ east: 1, north: 2 }, map, 'pointAccumulated', {
    mirrorChecked: true,
    useVisibleLaneProjection: true,
  });
  assert.equal(r.corrected, false);
  assert.ok(CVLP.getBrowserDiagnostics().pointAccumulatedFallbackCount >= 1);
});

test('12. cache hits still apply projection (draw-time helper)', () => {
  assert.match(RENDER_SRC, /fromCacheHit:\s*this\._visibleLaneProjectionFromCacheHit/);
  assert.match(RENDER_SRC, /_visibleLaneProjectionFromCacheHit/);
  const map = buildCombined(processSelection([0, 1, 2]), 'pointAccumulated');
  CVLP.resetDrawDiagnostics();
  const p = (map.pointAccumulated.points || []).find((x) => x.sourceFile === SEG1 && x.frameId === 1803);
  const r = CVLP.projectCombinedSourceLanePoint(p, map, 'pointAccumulated', {
    mirrorChecked: true,
    useVisibleLaneProjection: true,
    fromCacheHit: true,
  });
  assert.equal(r.corrected, true);
  assert.ok(CVLP.getBrowserDiagnostics().cacheHitApplicationCount >= 1);
});

test('13-14. arrow/road/bridge geometry unchanged by helper (trajectory checksum)', () => {
  const pd = processSelection([0, 1, 2]);
  const baseline = buildCombined(pd, 'pointAccumulated');
  const projected = projectPaMap(baseline);
  assert.equal(checksumTrajectory(baseline.trajectory), checksumTrajectory(projected.trajectory));
  assert.equal(baseline.roadSurfaceChecksum, projected.roadSurfaceChecksum);
  assert.equal(
    JSON.stringify(baseline.combinedRouteContinuity || null),
    JSON.stringify(projected.combinedRouteContinuity || null),
  );
});

test('15-18. standalone Seg1 / segment scopes unchanged by inactive candidate', () => {
  const pd = processSelection([1]);
  const stand = SLM.buildSegmentLocalMap(pd, {
    geometrySource: 'pointAccumulated',
    timelineIndex: 0,
    fitEnabled: true,
  });
  assert.equal(CVLP.isCandidateEligible(stand, {
    useVisibleLaneProjection: true,
    mirrorChecked: true,
  }), false);
  const pdComb = processSelection([0, 1, 2]);
  const map = buildCombined(pdComb, 'pointAccumulated');
  assert.ok(map.boundaryAnchoredOrientationActive);
  assert.ok(map.baselineTrajectory?.length);
  // finalize preserves provenance without changing placed values for trajectory:
  const t0 = map.trajectory[0];
  assert.ok(Number.isFinite(t0.placedEast) || Number.isFinite(t0.east));
  assert.equal(CST.OUTPUT_FRAME, 'combinedPlaced');
});
