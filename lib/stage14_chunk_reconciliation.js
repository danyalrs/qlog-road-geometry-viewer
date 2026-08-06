/**
 * Stage 14 — per-segment chunk-scope reconciliation (read-only).
 */
const fs = require('fs');
const path = require('path');
const { loadSegmentsData } = require('./qlog_data');
const { processRoute } = require('./process_route');
const { qualifySegments } = require('./segment_qualify');
const { DEFAULT_OPTS, MIN_MAPPING_COVERAGE_M } = require('./stage11_fragment_audit');
const { PROCESSING_VERSION } = require('./version');

const FROZEN_VERSION = '2026-07-24-fusion-v11';

const FIRST_CHUNK_ZERO_POLYGON_CLASSIFICATION = {
  9: 'correctly_rejected_for_insufficient_evidence',
  17: 'inconclusive_without_camera_imagery',
  26: 'correctly_rejected_for_insufficient_evidence',
  31: 'inconclusive_without_camera_imagery',
  37: 'inconclusive_without_camera_imagery',
  50: 'inconclusive_without_camera_imagery',
  57: 'blocked_by_multi_pass_ambiguity',
  60: 'correctly_rejected_for_insufficient_evidence',
  62: 'correctly_rejected_for_insufficient_evidence',
  65: 'blocked_by_polygon_validation',
  87: 'inconclusive_without_camera_imagery',
  90: 'blocked_by_run_pairing_misalignment',
  96: 'correctly_rejected_for_insufficient_evidence',
};

function polygonId(segmentId, chunkId, poly) {
  return `${segmentId}:${chunkId ?? 0}:${poly.passId ?? 0}:${poly.poseSectionId ?? 0}:${poly.fragmentIndex ?? 0}`;
}

function coverageM(poly) {
  if (!poly?.sRange || poly.sRange.length < 2) return 0;
  return Math.max(0, poly.sRange[1] - poly.sRange[0]);
}

function classifyLongShort(poly) {
  return coverageM(poly) >= MIN_MAPPING_COVERAGE_M ? 'long' : 'short';
}

function discoverSegmentFiles(root) {
  return fs.readdirSync(root)
    .filter((f) => /^qlog_f449c.*\.bz2$/i.test(f))
    .sort((a, b) => parseInt(a.match(/_(\d+)/)[1], 10) - parseInt(b.match(/_(\d+)/)[1], 10));
}

function auditSegmentChunks(segmentId, root = process.cwd(), opts = DEFAULT_OPTS) {
  const filename = `qlog_f449c_${segmentId}.bz2`;
  const loaded = loadSegmentsData(root, [filename], opts);
  const quals = qualifySegments(loaded.audits);
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
    ...opts,
    segmentQualifications: quals,
    fileAudits: loaded.audits,
  });

  const chunks = result.routeChunks || [];
  const perChunk = chunks.map((chunk) => {
    const polys = chunk.roadSurfacePolygons || [];
    const chunkId = chunk.chunkId ?? 0;
    return {
      chunkId,
      polygonCount: polys.length,
      polygonIds: polys.map((p) => polygonId(segmentId, chunkId, p)),
      polygons: polys.map((p) => ({
        polygonId: polygonId(segmentId, chunkId, p),
        passId: p.passId ?? 0,
        poseSectionId: p.poseSectionId ?? 0,
        fragmentIndex: p.fragmentIndex ?? 0,
        coverageM: coverageM(p),
        lengthClass: classifyLongShort(p),
      })),
    };
  });

  const firstChunkPolygonCount = perChunk[0]?.polygonCount ?? 0;
  const allChunkPolygonCount = (result.roadSurfacePolygons || []).length;
  let longFragmentCount = 0;
  let shortFragmentCount = 0;
  for (const p of result.roadSurfacePolygons || []) {
    if (classifyLongShort(p) === 'long') longFragmentCount++;
    else shortFragmentCount++;
  }

  const firstChunkPolygonProducing = firstChunkPolygonCount > 0;
  const allChunkPolygonProducing = allChunkPolygonCount > 0;
  const scopeMismatch = firstChunkPolygonProducing !== allChunkPolygonProducing;

  return {
    segmentId,
    physicalRouteSegment: segmentId,
    chunkCount: chunks.length,
    perChunk,
    firstChunkPolygonCount,
    allChunkPolygonCount,
    longFragmentCount,
    shortFragmentCount,
    firstChunkPolygonProducing,
    allChunkPolygonProducing,
    firstChunkZeroPolygon: !firstChunkPolygonProducing,
    allChunkZeroPolygon: !allChunkPolygonProducing,
    scopeMismatch,
    firstChunkZeroPolygonClassification: !firstChunkPolygonProducing
      ? (FIRST_CHUNK_ZERO_POLYGON_CLASSIFICATION[segmentId] || null)
      : null,
    allChunkZeroPolygonClassification: !allChunkPolygonProducing
      ? (FIRST_CHUNK_ZERO_POLYGON_CLASSIFICATION[segmentId] || null)
      : null,
    firstChunkDiagnosticNote: scopeMismatch && allChunkPolygonProducing
      ? 'first_chunk_zero_but_later_chunks_produce_polygons'
      : null,
  };
}

function enrichSegmentsWithStage11FragmentCounts(table, stage11) {
  for (const row of table) {
    const seg = (stage11.results || []).find((s) => s.segmentId === row.segmentId);
    if (!seg) continue;
    row.longFragmentCount = (seg.fragments || []).filter((f) => (f.classifications || []).includes('independently_useful')).length;
    row.shortFragmentCount = (seg.fragments || []).filter((f) => (f.classifications || []).includes('valid_but_too_short_for_mapping')).length;
  }
  return table;
}

function buildChunkReconciliation(root = process.cwd(), stage11 = null) {
  const files = discoverSegmentFiles(root);
  const segments = files.map((f) => parseInt(f.match(/_(\d+)/)[1], 10));
  const table = segments.map((id) => auditSegmentChunks(id, root));
  if (stage11) enrichSegmentsWithStage11FragmentCounts(table, stage11);

  const firstChunkAcceptedPolygons = table.reduce((n, r) => n + r.firstChunkPolygonCount, 0);
  const allChunkAcceptedPolygons = table.reduce((n, r) => n + r.allChunkPolygonCount, 0);
  const totalDiscoveredChunks = table.reduce((n, r) => n + r.chunkCount, 0);

  const firstChunkProducing = table.filter((r) => r.firstChunkPolygonProducing).length;
  const firstChunkZero = table.filter((r) => r.firstChunkZeroPolygon).length;
  const allChunkProducing = table.filter((r) => r.allChunkPolygonProducing).length;
  const allChunkZero = table.filter((r) => r.allChunkZeroPolygon).length;

  const countMismatchSegments = table
    .filter((r) => r.firstChunkPolygonCount !== r.allChunkPolygonCount)
    .map((r) => r.segmentId);
  const producingStatusMismatchSegments = table
    .filter((r) => r.scopeMismatch)
    .map((r) => r.segmentId);
  const polygonDifference = allChunkAcceptedPolygons - firstChunkAcceptedPolygons;

  const differenceAttribution = countMismatchSegments.map((segmentId) => {
    const row = table.find((r) => r.segmentId === segmentId);
    const attributedCount = row.allChunkPolygonCount - row.firstChunkPolygonCount;
    const firstIds = new Set(row.perChunk[0]?.polygonIds || []);
    const extraPolygons = [];
    for (let i = 0; i < row.perChunk.length; i++) {
      const chunk = row.perChunk[i];
      for (const poly of chunk.polygons) {
        if (i > 0 || !firstIds.has(poly.polygonId)) {
          extraPolygons.push({
            chunkId: chunk.chunkId,
            chunkIndex: i,
            polygonId: poly.polygonId,
            coverageM: poly.coverageM,
          });
        }
      }
    }
    return {
      segmentId,
      attributedPolygonDifference: attributedCount,
      chunks: row.perChunk.map((c, chunkIndex) => ({
        chunkIndex,
        chunkId: c.chunkId,
        polygonCount: c.polygonCount,
        polygonIds: c.polygonIds,
      })),
      extraPolygons,
    };
  });

  const attributedSum = differenceAttribution.reduce((n, d) => n + d.attributedPolygonDifference, 0);

  const firstChunkZeroByClass = {};
  const allChunkZeroByClass = {};
  for (const row of table) {
    if (row.firstChunkZeroPolygon && row.firstChunkZeroPolygonClassification) {
      const c = row.firstChunkZeroPolygonClassification;
      firstChunkZeroByClass[c] = firstChunkZeroByClass[c] || [];
      firstChunkZeroByClass[c].push(row.segmentId);
    }
    if (row.allChunkZeroPolygon && row.allChunkZeroPolygonClassification) {
      const c = row.allChunkZeroPolygonClassification;
      allChunkZeroByClass[c] = allChunkZeroByClass[c] || [];
      allChunkZeroByClass[c].push(row.segmentId);
    }
  }

  return {
    auditedAt: new Date().toISOString(),
    processingVersion: FROZEN_VERSION,
    reportingUnits: {
      physicalRouteSegment: 'One qlog_f449c_{N}.bz2 file — the audited route segment entry.',
      routeChunk: 'Temporal sub-span produced by processRoute chunking within a segment.',
      firstChunkPerSegment: 'routeChunks[0] polygon count — matches dataset_audit.js polygonCount.',
      allChunksPerSegment: 'Sum of accepted polygons across every routeChunks[] entry plus top-level roadSurfacePolygons.',
    },
    definitions: {
      allChunkPolygonProducingSegment: 'At least one accepted polygon in any included chunk.',
      allChunkZeroPolygonSegment: 'No accepted polygon in every included chunk.',
      firstChunkZeroPolygonSegment: 'No accepted polygon in routeChunks[0], even if later chunks produce output.',
    },
    summaryA_firstChunkDatasetAudit: {
      scope: 'first_chunk_per_segment',
      auditedSegmentEntries: segments.length,
      acceptedPolygons: firstChunkAcceptedPolygons,
      polygonProducingSegments: firstChunkProducing,
      zeroPolygonSegments: firstChunkZero,
      zeroPolygonSegmentIds: table.filter((r) => r.firstChunkZeroPolygon).map((r) => r.segmentId),
      rejectionClassAccounting: firstChunkZeroByClass,
    },
    summaryB_allChunkOutputAudit: {
      scope: 'all_chunks_per_segment',
      totalDiscoveredChunks,
      acceptedFragments: allChunkAcceptedPolygons,
      polygonProducingSegments: allChunkProducing,
      zeroPolygonSegments: allChunkZero,
      zeroPolygonSegmentIds: table.filter((r) => r.allChunkZeroPolygon).map((r) => r.segmentId),
      rejectionClassAccounting: allChunkZeroByClass,
      segmentsRemovedFromAllChunkZeroDueToLaterChunks: table
        .filter((r) => r.scopeMismatch && r.allChunkPolygonProducing)
        .map((r) => ({
          segmentId: r.segmentId,
          firstChunkClassification: r.firstChunkZeroPolygonClassification,
          allChunkPolygonCount: r.allChunkPolygonCount,
          diagnosticRetained: r.firstChunkDiagnosticNote,
        })),
    },
    polygonDifferenceReconciliation: {
      firstChunkTotal: firstChunkAcceptedPolygons,
      allChunkTotal: allChunkAcceptedPolygons,
      difference: polygonDifference,
      attributedDifference: attributedSum,
      fullyAttributedToSegments: countMismatchSegments,
      producingStatusMismatchSegments,
      attribution: differenceAttribution,
    },
    segments: table,
    consistencyChecks: {
      perChunkSumEquals540: allChunkAcceptedPolygons === 540,
      firstChunkSumEquals524: firstChunkAcceptedPolygons === 524,
      differenceEquals16: polygonDifference === 16,
      attributionEquals16: attributedSum === 16,
      firstProducingPlusZeroEquals92: firstChunkProducing + firstChunkZero === segments.length,
      allProducingPlusZeroEquals92: allChunkProducing + allChunkZero === segments.length,
      noAllChunkZeroWithPolygons: table.every((r) => !(r.allChunkZeroPolygon && r.allChunkPolygonCount > 0)),
    },
  };
}

module.exports = {
  FROZEN_VERSION,
  FIRST_CHUNK_ZERO_POLYGON_CLASSIFICATION,
  buildChunkReconciliation,
  auditSegmentChunks,
  polygonId,
  enrichSegmentsWithStage11FragmentCounts,
};
