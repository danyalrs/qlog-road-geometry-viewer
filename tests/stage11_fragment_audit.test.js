const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadSegmentsData } = require('../lib/qlog_data');
const { processRoute } = require('../lib/process_route');
const { qualifySegments } = require('../lib/segment_qualify');
const { buildGeometryDebug } = require('../lib/geometry_debug');
const {
  DEFAULT_OPTS,
  stablePolygonId,
  sortFragmentsForOrdering,
  classifyFragment,
  sRangeOverlap,
  auditSegmentFragments,
  verifyDownstreamCompatibility,
  MIN_MAPPING_COVERAGE_M,
} = require('../lib/stage11_fragment_audit');
const { maxConsecutiveVertexJump } = require('../lib/geometry_sanity');

const ROUTE_OPTS = { ...DEFAULT_OPTS };

function processSeg(seg) {
  const loaded = loadSegmentsData('.', [`qlog_f449c_${seg}.bz2`], ROUTE_OPTS);
  return processRoute(loaded.modelEvents, loaded.gpsEvents, {
    ...ROUTE_OPTS,
    segmentQualifications: qualifySegments(loaded.audits),
    fileAudits: loaded.audits,
  });
}

describe('Stage 11 fragment audit', () => {
  it('stable polygon IDs are deterministic across reruns', () => {
    const a = auditSegmentFragments(46, ROUTE_OPTS, 0);
    const b = auditSegmentFragments(46, ROUTE_OPTS, 0);
    assert.deepEqual(a.deterministicOrder, b.deterministicOrder);
    assert.equal(a.polygonCount, b.polygonCount);
    for (const f of a.fragments) {
      const id = stablePolygonId(46, f.chunkId, f.passId, f.poseSectionId, f.fragmentIndex);
      assert.equal(f.polygonId, id);
    }
  });

  it('deterministic multi-polygon ordering is by pass, pose section, then s', () => {
    const audit = auditSegmentFragments(46, ROUTE_OPTS, 0);
    const sorted = sortFragmentsForOrdering(audit.fragments);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev.passId === cur.passId && prev.poseSectionId === cur.poseSectionId) {
        assert.ok((prev.sRange?.[0] ?? 0) <= (cur.sRange?.[0] ?? 0) + 1e-6);
      }
    }
  });

  it('classifies tiny fragments as valid_but_too_short_for_mapping', () => {
    const tiny = {
      polygonId: '1:0:0:0:0',
      passId: 0,
      poseSectionId: 0,
      coverageM: 4,
      areaM2: 20,
      selfIntersections: 0,
      maxVertexJumpM: 5,
      widthMin: 3,
      widthMax: 12,
      sRange: [0, 4],
    };
    const tags = classifyFragment(tiny, [tiny], { maxVertexJumpM: 15 });
    assert.ok(tags.includes('valid_but_too_short_for_mapping'));
  });

  it('flags duplicate_or_overlapping when s-ranges substantially overlap', () => {
    const a = {
      polygonId: 'a', passId: 0, poseSectionId: 0, coverageM: 10, sRange: [0, 10],
      selfIntersections: 0, maxVertexJumpM: 5, widthMin: 3, widthMax: 10,
    };
    const b = {
      polygonId: 'b', passId: 0, poseSectionId: 0, coverageM: 10, sRange: [5, 15],
      selfIntersections: 0, maxVertexJumpM: 5, widthMin: 3, widthMax: 10,
    };
    const tags = classifyFragment(a, [a, b], { maxVertexJumpM: 15 });
    assert.ok(tags.includes('duplicate_or_overlapping'));
  });

  it('same-pass adjacent fragments with large gap are separated_by_real_evidence_gap', () => {
    const audit = auditSegmentFragments(46, ROUTE_OPTS, 0);
    const withGaps = audit.fragments.filter((f) => (f.gapToNextAlongTrackM ?? 0) > 4);
    assert.ok(withGaps.length > 0);
    for (const f of withGaps) {
      assert.ok(f.classifications.includes('separated_by_real_evidence_gap'));
    }
  });

  it('does not tag merge across different passes', () => {
    const a = {
      polygonId: 'a', passId: 0, poseSectionId: 0, coverageM: 10, sRange: [0, 10],
      gapToNextAlongTrackM: 2, selfIntersections: 0, maxVertexJumpM: 5, widthMin: 3, widthMax: 10,
      nextPassId: 1, nextPoseSectionId: 0,
      boundaryEndpointAlignmentToNext: { leftEndToNextStartM: 1, rightEndToNextStartM: 1 },
    };
    const tags = classifyFragment(a, [a], { maxVertexJumpM: 15 });
    assert.ok(!tags.includes('potentially_mergeable_direct_support_only'));
  });

  it('JSON round-trip retains every polygon', () => {
    const result = processSeg(46);
    const audit = auditSegmentFragments(46, ROUTE_OPTS, 0);
    const chunk = result.routeChunks[0];
    const rt = JSON.parse(JSON.stringify(chunk));
    assert.equal(rt.roadSurfacePolygons.length, audit.polygonCount);
    assert.equal(result.roadSurfacePolygons.length, audit.polygonCount);
    assert.ok(audit.downstream.chunkRetainsAll);
    assert.ok(audit.downstream.topLevelRetainsAll);
  });

  it('geometry debug counts every polygon for renderer consumers', () => {
    const result = processSeg(10);
    const dbg = buildGeometryDebug(result, ['qlog_f449c_10.bz2']);
    const chunkCount = result.routeChunks[0].roadSurfacePolygons.length;
    assert.equal(dbg.polygonCount, chunkCount);
    assert.ok(chunkCount > 1);
  });

  it('segment 46 accepted fragments pass vertex jump cap', () => {
    const audit = auditSegmentFragments(46, ROUTE_OPTS, 0);
    for (const f of audit.fragments) {
      assert.ok(f.maxVertexJumpM <= ROUTE_OPTS.maxVertexJumpM);
      assert.equal(f.selfIntersections, 0);
    }
    assert.equal(audit.rejections.length, 1);
    assert.ok(audit.rejections[0].maxVertexJumpM > ROUTE_OPTS.maxVertexJumpM);
  });

  it('no s-range overlap double-counts full area for disjoint fragments', () => {
    const a = { sRange: [0, 10], coverageM: 10 };
    const b = { sRange: [12, 20], coverageM: 8 };
    assert.equal(sRangeOverlap(a.sRange, b.sRange), 0);
  });

  it('independently_useful requires minimum mapping coverage', () => {
    assert.equal(MIN_MAPPING_COVERAGE_M, 6);
    const audit = auditSegmentFragments(2, ROUTE_OPTS, 1);
    const useful = audit.fragments.filter((f) => f.classifications.includes('independently_useful'));
    assert.ok(useful.length > 0);
    for (const f of useful) assert.ok(f.coverageM >= MIN_MAPPING_COVERAGE_M);
  });
});
