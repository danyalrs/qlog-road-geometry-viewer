'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const GPC = require('../lib/graph_fit_persistent_cache');
const SLM = require('../lib/segment_local_map');
const GF = require('../lib/graph_fit');
const { VIEWER_DEFAULT_PROCESS_OPTIONS, viewerLocalMapOptions } = require('../lib/viewer_map_build');
const { loadSegmentsData } = require('../lib/qlog_data');
const { qualifySegments } = require('../lib/segment_qualify');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
const { normalizeProcessOptions } = require('../lib/process_defaults');

const ROOT = path.join(__dirname, '..');
const DEPS = { SLM, GF };

function loadProcessData(segmentFile) {
  const merged = normalizeProcessOptions({ ...VIEWER_DEFAULT_PROCESS_OPTIONS });
  const loaded = loadSegmentsData(ROOT, [segmentFile], merged);
  const segmentQualifications = qualifySegments(loaded.audits);
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
    ...merged,
    segmentQualifications,
    fileAudits: loaded.audits,
  });
  return {
    processingVersion: require('../lib/version').PROCESSING_VERSION,
    processingOptions: merged,
    mode: result.mode,
    stats: result.stats,
    routeChunks: result.routeChunks,
    vehiclePath: result.vehiclePath,
    frames: result.frames,
    timeline: enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath),
    fileAudits: loaded.audits,
  };
}

function buildFitMap(processData, overrides = {}) {
  const mapOpts = {
    ...viewerLocalMapOptions({ fitEnabled: true }),
    timelineIndex: 0,
    chunkId: processData.routeChunks?.[0]?.chunkId ?? 0,
    passId: processData.routeChunks?.[0]?.passes?.[0]?.passId ?? 0,
    ...overrides,
  };
  const map = SLM.buildSegmentLocalMap(processData, mapOpts);
  return { map: SLM.freezeStationaryMapGeometry(map), mapOpts };
}

describe('graph-fit persistent cache — identity contract', () => {
  let processData;
  let baseIdentity;

  before(() => {
    const file = 'qlog_f449c_2.bz2';
    if (!fs.existsSync(path.join(ROOT, file))) return;
    processData = loadProcessData(file);
    const { mapOpts } = buildFitMap(processData);
    baseIdentity = GPC.computeFitPersistIdentity(processData, mapOpts, DEPS);
  });

  it('1. returns null when fitEnabled is false', () => {
    const { mapOpts } = buildFitMap(processData, { fitEnabled: false });
    assert.equal(GPC.computeFitPersistIdentity(processData, mapOpts, DEPS), null);
  });

  it('2. stable identity for identical inputs', () => {
    if (!baseIdentity) return;
    const { mapOpts } = buildFitMap(processData);
    const again = GPC.computeFitPersistIdentity(processData, mapOpts, DEPS);
    assert.equal(again.cacheKey, baseIdentity.cacheKey);
  });

  it('3. misses on changed processing version', () => {
    if (!baseIdentity) return;
    const { mapOpts } = buildFitMap(processData);
    const mutated = { ...processData, processingVersion: 'changed-version' };
    const id2 = GPC.computeFitPersistIdentity(mutated, mapOpts, DEPS);
    assert.notEqual(id2.cacheKey, baseIdentity.cacheKey);
  });

  it('4. misses on changed graph-fit impl version', () => {
    if (!baseIdentity) return;
    const { mapOpts } = buildFitMap(processData);
    const fakeGF = { ...GF, GRAPH_FIT_CACHE_IMPL_VERSION: 'other-impl' };
    const id2 = GPC.computeFitPersistIdentity(processData, mapOpts, { SLM, GF: fakeGF });
    assert.notEqual(id2.cacheKey, baseIdentity.cacheKey);
  });

  it('5. misses on changed fit configuration', () => {
    if (!baseIdentity) return;
    const { mapOpts } = buildFitMap(processData, { fitMaxHeldOutMedianM: 9.99 });
    const id2 = GPC.computeFitPersistIdentity(processData, mapOpts, DEPS);
    assert.notEqual(id2.cacheKey, baseIdentity.cacheKey);
  });

  it('6. misses on changed qlog/source hash', () => {
    if (!baseIdentity) return;
    const { mapOpts } = buildFitMap(processData);
    const audits = processData.fileAudits.map((a) => ({ ...a, sha256: '0'.repeat(64) }));
    const id2 = GPC.computeFitPersistIdentity({ ...processData, fileAudits: audits }, mapOpts, DEPS);
    assert.notEqual(id2.cacheKey, baseIdentity.cacheKey);
  });

  it('7. misses on changed chunk/pass', () => {
    if (!baseIdentity) return;
    const altPass = (baseIdentity.identity.passId ?? 0) + 1;
    const manual = { ...baseIdentity.identity, passId: altPass };
    assert.notEqual(GPC.digestCanonical(manual), GPC.digestCanonical(baseIdentity.identity));
    const base = buildFitMap(processData);
    const id2 = GPC.computeFitPersistIdentity(processData, { ...base.mapOpts, passId: altPass }, DEPS);
    if (id2) assert.notEqual(id2.cacheKey, baseIdentity.cacheKey);
  });

  it('8. misses on changed geometry source', () => {
    if (!baseIdentity) return;
    const { mapOpts } = buildFitMap(processData, { geometrySource: 'fused' });
    const id2 = GPC.computeFitPersistIdentity(processData, mapOpts, DEPS);
    assert.notEqual(id2?.cacheKey, baseIdentity.cacheKey);
  });

  it('9. misses on changed reference pose', () => {
    if (!baseIdentity) return;
    const { mapOpts } = buildFitMap(processData);
    const fakeSLM = {
      ...SLM,
      resolveSegmentReferencePose: () => ({
        east: 999, north: 999, headingDeg: 45, frameId: 'x', logMonoTime: '1',
      }),
    };
    const id2 = GPC.computeFitPersistIdentity(processData, mapOpts, { SLM: fakeSLM, GF });
    assert.notEqual(id2?.cacheKey, baseIdentity.cacheKey);
  });

  it('10. misses on changed trajectory digest', () => {
    if (!baseIdentity) return;
    const { mapOpts } = buildFitMap(processData);
    const mutated = {
      ...processData,
      routeChunks: processData.routeChunks.map((c) => ({
        ...c,
        vehiclePath: (c.vehiclePath || []).map((p, i) => (
          i === 0 ? { ...p, east: (p.east || 0) + 0.01 } : p
        )),
      })),
    };
    const id2 = GPC.computeFitPersistIdentity(mutated, mapOpts, DEPS);
    assert.notEqual(id2?.cacheKey, baseIdentity.cacheKey);
  });

  it('11. misses on changed processing options', () => {
    if (!baseIdentity) return;
    const { mapOpts } = buildFitMap(processData);
    const mutated = {
      ...processData,
      processingOptions: { ...processData.processingOptions, maxForwardM: 999 },
    };
    const id2 = GPC.computeFitPersistIdentity(mutated, mapOpts, DEPS);
    assert.notEqual(id2?.cacheKey, baseIdentity.cacheKey);
  });

  it('12. misses on changed segment file set', () => {
    if (!baseIdentity) return;
    const { mapOpts } = buildFitMap(processData);
    const id2 = GPC.computeFitPersistIdentity(
      { ...processData, fileAudits: [...processData.fileAudits, { filename: 'extra.bz2', sha256: 'a'.repeat(64) }] },
      mapOpts,
      DEPS,
    );
    assert.notEqual(id2?.cacheKey, baseIdentity.cacheKey);
  });

  it('13. identical semantic objects with different insertion order share digest', () => {
    const a = { z: 1, a: 2, m: { y: 1, x: 2 } };
    const b = { a: 2, m: { x: 2, y: 1 }, z: 1 };
    assert.equal(GPC.digestCanonical(a), GPC.digestCanonical(b));
  });

  it('14. canonical number edge cases', () => {
    const cases = [
      { v: { n: NaN }, expect: '__NaN__' },
      { v: { n: Infinity }, expect: '__Infinity__' },
      { v: { n: -Infinity }, expect: '__-Infinity__' },
      { v: { n: -0 }, expect: 0 },
    ];
    for (const c of cases) {
      const canon = GPC.canonicalize(c.v);
      assert.equal(canon.n, c.expect);
    }
    assert.equal(GPC.digestCanonical({ a: undefined }), GPC.digestCanonical({}));
  });

  it('15. generatedAt and source mtime do not alter identity key', () => {
    if (!baseIdentity) return;
    const { mapOpts } = buildFitMap(processData);
    const again = GPC.computeFitPersistIdentity(processData, mapOpts, DEPS);
    assert.equal(again.cacheKey, baseIdentity.cacheKey);
    const record = GPC.buildPersistRecord(buildFitMap(processData).map, baseIdentity);
    record.createdAt = 1;
    record.lastAccessedAt = 2;
    assert.equal(record.cacheKey, baseIdentity.cacheKey);
  });

  it('16. no absolute path in identity or payload', () => {
    if (!baseIdentity) return;
    const { map } = buildFitMap(processData);
    const record = GPC.buildPersistRecord(map, baseIdentity);
    const blob = JSON.stringify({ identity: baseIdentity.identity, record });
    assert.doesNotMatch(blob, /C:\\Users\\/i);
    assert.doesNotMatch(blob, /[A-Z]:\\\\/);
  });

  it('17. identity computation does not invoke fitConstructedRuns', () => {
    const file = 'qlog_f449c_2.bz2';
    if (!fs.existsSync(path.join(ROOT, file))) return;
    const pd = loadProcessData(file);
    const { mapOpts } = buildFitMap(pd);
    let fitCalls = 0;
    const fakeGF = {
      ...GF,
      fitConstructedRuns() {
        fitCalls += 1;
        return GF.fitConstructedRuns.apply(this, arguments);
      },
    };
    const id = GPC.computeFitPersistIdentity(pd, mapOpts, { SLM, GF: fakeGF });
    assert.ok(id?.cacheKey);
    assert.equal(fitCalls, 0, 'identity must not call fitConstructedRuns');
  });

  it('18. identity uses fitEnabled false for fragment construction', () => {
    const file = 'qlog_f449c_2.bz2';
    if (!fs.existsSync(path.join(ROOT, file))) return;
    const pd = loadProcessData(file);
    const { mapOpts } = buildFitMap(pd);
    let capturedOptions = null;
    const fakeSLM = {
      ...SLM,
      normalizeGeometrySource: SLM.normalizeGeometrySource,
      resolveActiveChunkPass: SLM.resolveActiveChunkPass,
      resolveSegmentReferencePose: SLM.resolveSegmentReferencePose,
      buildLaneFragmentsForSource(processData, args) {
        capturedOptions = args.options;
        return SLM.buildLaneFragmentsForSource(processData, args);
      },
    };
    GPC.computeFitPersistIdentity(pd, mapOpts, { SLM: fakeSLM, GF });
    assert.equal(capturedOptions?.fitEnabled, false);
  });
});

describe('graph-fit persistent cache — payload contract', () => {
  const segCases = [
    { id: 2, accepted: 4 },
    { id: 3, accepted: 11 },
    { id: 9, accepted: 0, roadSurfacePolygonCount: 1 },
    { id: 14, accepted: 7 },
    { id: 16, accepted: 9 },
    { id: 54, accepted: 0 },
    { id: 58, accepted: 0 },
    { id: 95, accepted: 0 },
    { id: 99, accepted: 0 },
  ];

  for (const seg of segCases) {
    it(`round-trip seg ${seg.id}: coordinates and accepted IDs unchanged`, () => {
      const file = `qlog_f449c_${seg.id}.bz2`;
      if (!fs.existsSync(path.join(ROOT, file))) return;
      const processData = loadProcessData(file);
      const { map, mapOpts } = buildFitMap(processData);
      const identity = GPC.computeFitPersistIdentity(processData, mapOpts, DEPS);
      const record = GPC.buildPersistRecord(map, identity);
      const valid = GPC.validatePersistRecord(record, identity);
      assert.equal(valid.ok, true);
      const cmp = GPC.comparePersistedMaps(map, valid.record.map);
      assert.equal(cmp.maxCoordinateDifference, 0);
      assert.equal(cmp.acceptedIdsMatch, true);
      assert.equal(cmp.polygonChecksumMatch, true);
      const accepted = (map.pointAccumulated?.fittedPolylines?.results || [])
        .filter((r) => r.status === 'accepted');
      assert.equal(accepted.length, seg.accepted);
      if (seg.roadSurfacePolygonCount != null) {
        assert.equal(map.roadSurfacePolygonCount, seg.roadSurfacePolygonCount);
      }
    });
  }

  it('cold build vs persisted clone: full output equivalence seg 14', () => {
    const file = 'qlog_f449c_14.bz2';
    if (!fs.existsSync(path.join(ROOT, file))) return;
    const processData = loadProcessData(file);
    const { map, mapOpts } = buildFitMap(processData);
    const identity = GPC.computeFitPersistIdentity(processData, mapOpts, DEPS);
    const record = GPC.buildPersistRecord(map, identity);
    const valid = GPC.validatePersistRecord(record, identity);
    assert.equal(valid.ok, true);
    const cmp = GPC.comparePersistedMaps(map, valid.record.map);
    assert.equal(cmp.maxCoordinateDifference, 0);
    assert.equal(cmp.acceptedIdsMatch, true);
    assert.equal(cmp.polygonChecksumMatch, true);
    assert.equal(cmp.hybridCountMatch, true);
  });

  it('payload byte sizes for representative segments', () => {
    const sizes = {};
    for (const segId of [2, 9, 14, 16]) {
      const file = `qlog_f449c_${segId}.bz2`;
      if (!fs.existsSync(path.join(ROOT, file))) continue;
      const processData = loadProcessData(file);
      const { map, mapOpts } = buildFitMap(processData);
      const identity = GPC.computeFitPersistIdentity(processData, mapOpts, DEPS);
      const record = GPC.buildPersistRecord(map, identity);
      sizes[segId] = record.byteEstimate;
      assert.ok(record.byteEstimate > 0);
    }
    if (sizes[2]) assert.ok(sizes[2] > 1_000_000);
    if (sizes[14]) assert.ok(sizes[14] > sizes[2]);
  });

  it('corrupt checksum detected on digest verify', () => {
    const file = 'qlog_f449c_2.bz2';
    if (!fs.existsSync(path.join(ROOT, file))) return;
    const processData = loadProcessData(file);
    const { map, mapOpts } = buildFitMap(processData);
    const identity = GPC.computeFitPersistIdentity(processData, mapOpts, DEPS);
    const record = GPC.buildPersistRecord(map, identity);
    record.payloadChecksum = 'deadbeef';
    assert.notEqual(record.payloadChecksum, GPC.digestCanonical(record.map));
  });

  it('incomplete record rejected', () => {
    const valid = GPC.validatePersistRecord({ schemaVersion: GPC.PERSIST_SCHEMA_VERSION }, { cacheKey: 'x' });
    assert.equal(valid.ok, false);
  });

  it('wrong schema version rejected', () => {
    const file = 'qlog_f449c_2.bz2';
    if (!fs.existsSync(path.join(ROOT, file))) return;
    const processData = loadProcessData(file);
    const { map, mapOpts } = buildFitMap(processData);
    const identity = GPC.computeFitPersistIdentity(processData, mapOpts, DEPS);
    const record = GPC.buildPersistRecord(map, identity);
    record.schemaVersion = 'wrong';
    const valid = GPC.validatePersistRecord(record, identity);
    assert.equal(valid.ok, false);
    assert.equal(valid.reason, 'schemaVersion');
  });

  it('wrong cache key rejected', () => {
    const file = 'qlog_f449c_2.bz2';
    if (!fs.existsSync(path.join(ROOT, file))) return;
    const processData = loadProcessData(file);
    const { map, mapOpts } = buildFitMap(processData);
    const identity = GPC.computeFitPersistIdentity(processData, mapOpts, DEPS);
    const record = GPC.buildPersistRecord(map, identity);
    const valid = GPC.validatePersistRecord(record, { cacheKey: 'other' });
    assert.equal(valid.ok, false);
    assert.equal(valid.reason, 'cacheKey');
  });

  it('missing map field rejected', () => {
    const valid = GPC.validatePersistRecord({
      schemaVersion: GPC.PERSIST_SCHEMA_VERSION,
      cacheKey: 'k',
    }, { cacheKey: 'k' });
    assert.equal(valid.ok, false);
    assert.equal(valid.reason, 'missingMap');
  });

  it('checksum mismatch rejected', () => {
    const file = 'qlog_f449c_2.bz2';
    if (!fs.existsSync(path.join(ROOT, file))) return;
    const processData = loadProcessData(file);
    const { map, mapOpts } = buildFitMap(processData);
    const identity = GPC.computeFitPersistIdentity(processData, mapOpts, DEPS);
    const record = GPC.buildPersistRecord(map, identity);
    record.payloadChecksum = 'deadbeef';
    const valid = GPC.validatePersistRecord(record, identity);
    assert.equal(valid.ok, false);
    assert.equal(valid.reason, 'checksum');
  });

  it('structured-clone/json audit passes on representative maps', () => {
    const file = 'qlog_f449c_14.bz2';
    if (!fs.existsSync(path.join(ROOT, file))) return;
    const processData = loadProcessData(file);
    const { map } = buildFitMap(processData);
    const audit = GPC.auditStructuredCloneCompatibility(map);
    assert.equal(audit.jsonRoundTripOk, true);
    assert.equal(audit.hasMap, false);
    assert.equal(audit.hasSet, false);
    assert.equal(audit.hasFunction, false);
  });
});

describe('graph-fit persistent cache — wiring', () => {
  it('public module exposes IndexedDB cache API', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'graph_fit_persistent_cache.js'), 'utf8');
    assert.match(src, /GraphFitPersistCache/);
    assert.match(src, /indexedDB\.open/);
    assert.match(src, /DEFAULT_MAX_STORE_BYTES/);
  });

  it('app.js uses memory then persistent then build path', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.match(src, /getOrBuildStationaryMapAsync/);
    assert.match(src, /persistent-hit/);
    assert.match(src, /GraphFitPersistCache\.get/);
    assert.match(src, /GraphFitPersistCache\.put/);
    assert.match(src, /shouldUseGraphFitPersist/);
    assert.match(src, /mapAcquisitionGeneration/);
    assert.match(src, /inFlightMapBuilds/);
    assert.match(src, /mapContextsCompatible/);
  });

  it('public cache module exposes write-state API', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'graph_fit_persistent_cache.js'), 'utf8');
    assert.match(src, /getPersistentWriteState/);
    assert.match(src, /waitForWriteCommitted/);
    assert.match(src, /readRawRecord/);
    assert.match(src, /tx\.oncomplete/);
  });

  it('index.html loads graph_fit_persistent_cache.js', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.match(src, /graph_fit_persistent_cache\.js/);
  });

  it('graph_fit exports cache impl version', () => {
    assert.equal(GF.GRAPH_FIT_CACHE_IMPL_VERSION, 'path1-heldout-memo-v1');
    const pub = fs.readFileSync(path.join(ROOT, 'public', 'graph_fit.js'), 'utf8');
    assert.match(pub, /GRAPH_FIT_CACHE_IMPL_VERSION/);
    assert.match(pub, /path1-heldout-memo-v1/);
  });

  it('no hardcoded machine paths in cache modules', () => {
    for (const f of ['lib/graph_fit_persistent_cache.js', 'public/graph_fit_persistent_cache.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.doesNotMatch(src, /C:\\Users\\/i);
    }
  });
});

describe('graph-fit persistent cache — LRU simulation', () => {
  it('evicts oldest entries when over byte limit', () => {
    const entries = [
      { cacheKey: 'a', byteEstimate: 100, lastAccessedAt: 1 },
      { cacheKey: 'b', byteEstimate: 100, lastAccessedAt: 2 },
      { cacheKey: 'c', byteEstimate: 100, lastAccessedAt: 3 },
    ];
    const result = GPC.simulateLruEviction(entries, 150, 250);
    assert.deepEqual(result.evicted, ['a', 'b']);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].cacheKey, 'c');
  });

  it('retains recently accessed entry', () => {
    const entries = [
      { cacheKey: 'old', byteEstimate: 200, lastAccessedAt: 1 },
      { cacheKey: 'recent', byteEstimate: 200, lastAccessedAt: 99 },
    ];
    const result = GPC.simulateLruEviction(entries, 100, 300);
    assert.deepEqual(result.evicted, ['old']);
    assert.equal(result.entries[0].cacheKey, 'recent');
  });

  it('no eviction when under limit', () => {
    const entries = [{ cacheKey: 'only', byteEstimate: 50, lastAccessedAt: 1 }];
    const result = GPC.simulateLruEviction(entries, 10, 100);
    assert.deepEqual(result.evicted, []);
    assert.equal(result.entries.length, 1);
  });
});

describe('graph-fit persistent cache — mirror digest in provenance', () => {
  it('mirrored coordinate change alters fragment provenance digest', () => {
    const runA = [{ east: 1, north: 2, mirroredEast: 3, mirroredNorth: 4, frameId: 'f1' }];
    const runB = [{ east: 1, north: 2, mirroredEast: 5, mirroredNorth: 4, frameId: 'f1' }];
    const cf = { fragments: [{ fragmentId: 'x', chunkId: 0, passId: 0 }] };
    const dA = GPC.digestCanonical([{
      fragmentId: 'x', chunkId: 0, passId: 0, runDigest: GPC.digestRunPoints(runA),
    }]);
    const dB = GPC.digestCanonical([{
      fragmentId: 'x', chunkId: 0, passId: 0, runDigest: GPC.digestRunPoints(runB),
    }]);
    assert.notEqual(dA, dB);
  });
});
