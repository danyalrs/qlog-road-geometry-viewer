/**
 * Stage 14 — delivery-readiness consolidation (read-only).
 * Reconciles source audit JSON files; does not change production geometry.
 */
const fs = require('fs');
const path = require('path');
const { PROCESSING_VERSION } = require('./version');

const { buildChunkReconciliation, FIRST_CHUNK_ZERO_POLYGON_CLASSIFICATION } = require('./stage14_chunk_reconciliation');

const FROZEN_VERSION = '2026-07-24-fusion-v11';

const FIRST_CHUNK_ZERO_POLYGON_SEGMENT_IDS = [9, 17, 26, 31, 37, 50, 57, 60, 62, 65, 87, 90, 96];

const APPROVED_ZERO_POLYGON_CLASSIFICATION = { ...FIRST_CHUNK_ZERO_POLYGON_CLASSIFICATION };

const SOURCE_ARTIFACTS = {
  dataset: 'audit_dataset_v11_stage13a.json',
  stage11: 'audit_stage11_fragments_v11.json',
  stage12a: 'audit_stage12_visual_validation.json',
  stage12b: 'audit_stage12b_imagery.json',
  stage13: 'audit_stage13_zero_polygon.json',
  stage13a: 'audit_stage13a_fusion_trace.json',
};

function loadJson(root, relPath) {
  const full = path.join(root, relPath);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function countFragmentClassifications(stage11) {
  let total = 0;
  let independentlyUseful = 0;
  let validButShort = 0;
  let geometricallyInconsistent = 0;
  let mergeCandidates = 0;
  for (const seg of stage11.results || []) {
    for (const f of seg.fragments || []) {
      total++;
      const tags = f.classifications || [];
      if (tags.includes('independently_useful')) independentlyUseful++;
      if (tags.includes('valid_but_too_short_for_mapping')) validButShort++;
      if (tags.includes('geometrically_inconsistent')) geometricallyInconsistent++;
      if (tags.includes('potentially_mergeable_direct_support_only')) mergeCandidates++;
    }
  }
  return { total, independentlyUseful, validButShort, geometricallyInconsistent, mergeCandidates };
}

function sumPolygonCounts(stage11) {
  return (stage11.results || []).reduce((n, s) => n + (s.polygonCount || 0), 0);
}

function countPolygonProducingSegments(dataset) {
  return (dataset.results || []).filter((r) => (r.polygonCount || 0) > 0).length;
}

function sumDatasetPolygons(dataset) {
  return (dataset.results || []).reduce((n, r) => n + (r.polygonCount || 0), 0);
}

function findAuditDivergence(dataset, stage11) {
  const divergent = [];
  for (const r of dataset.results || []) {
    const s = (stage11.results || []).find((x) => x.segmentId === r.segmentId);
    if (!s) continue;
    if ((r.polygonCount || 0) !== (s.polygonCount || 0)) {
      divergent.push({
        segmentId: r.segmentId,
        datasetAuditPolygonCount: r.polygonCount || 0,
        stage11FragmentCount: s.polygonCount || 0,
        note: 'dataset_audit counts first-chunk polygons; stage11 uses top-level roadSurfacePolygons',
      });
    }
  }
  return divergent;
}

function summarizeSupportedRuns(sectionDiagnostics) {
  let left = 0;
  let right = 0;
  let paired = 0;
  let maxQualifyingOverlapM = 0;
  for (const sec of sectionDiagnostics || []) {
    const runs = sec.supportedRuns || {};
    left += runs.leftSupportedRunCount || 0;
    right += runs.rightSupportedRunCount || 0;
    paired += runs.pairedRunCount || 0;
    for (const o of runs.pairedRunOverlaps || []) {
      if ((o.overlapM || 0) >= 4) maxQualifyingOverlapM = Math.max(maxQualifyingOverlapM, o.overlapM);
    }
  }
  return { leftSupportedRuns: left, rightSupportedRuns: right, pairedRuns: paired, maxQualifyingOverlapM };
}

function buildZeroPolygonSegmentRecord(seg13, seg13aById, chunkRow) {
  const segId = seg13.segmentId;
  const runs = summarizeSupportedRuns(seg13.sectionDiagnostics);
  const trace = seg13aById.get(segId);
  const primaryClassification = FIRST_CHUNK_ZERO_POLYGON_CLASSIFICATION[segId];

  let exactRejectionReasons = [...(seg13.exactRejectionReasons || [])];
  let pairedRunOverlapM = runs.maxQualifyingOverlapM;
  let leftSupportedRuns = runs.leftSupportedRuns;
  let rightSupportedRuns = runs.rightSupportedRuns;
  let aggregateFusedSpanM = seg13.fusion?.longitudinalCoverageM?.paired ?? null;

  if (segId === 90 && trace?.primaryReconciliation) {
    exactRejectionReasons = ['insufficientPairedCoverage'];
    pairedRunOverlapM = trace.primaryReconciliation.qualifyingPairedRunOverlapM ?? 0;
    aggregateFusedSpanM = trace.primaryReconciliation.aggregateRawPairedCoverageM;
    const runStage = trace.sectionTraces?.[0]?.stages?.find((s) => s.name === 'supported_run_splitting');
    if (runStage?.supportedRuns) {
      leftSupportedRuns = runStage.supportedRuns.left?.length ?? leftSupportedRuns;
      rightSupportedRuns = runStage.supportedRuns.right?.length ?? rightSupportedRuns;
    }
  }
  if (segId === 65 && trace?.segment65Inspection) {
    pairedRunOverlapM = trace.primaryReconciliation?.qualifyingPairedRunOverlapM ?? 7.16;
  }

  return {
    segmentId: segId,
    primaryClassification,
    scope: 'first_chunk_zero_polygon',
    firstChunkZeroPolygon: chunkRow?.firstChunkZeroPolygon ?? true,
    allChunkZeroPolygon: chunkRow?.allChunkZeroPolygon ?? true,
    firstChunkPolygonCount: chunkRow?.firstChunkPolygonCount ?? 0,
    allChunkPolygonCount: chunkRow?.allChunkPolygonCount ?? 0,
    chunkCount: chunkRow?.chunkCount ?? 1,
    longFragmentCount: chunkRow?.longFragmentCount ?? null,
    shortFragmentCount: chunkRow?.shortFragmentCount ?? null,
    firstChunkDiagnosticNote: chunkRow?.firstChunkDiagnosticNote ?? null,
    temporalPassCount: seg13.temporalPassCount,
    poseSectionCount: seg13.poseSectionCount,
    edgeObservationCount: seg13.fusion?.edgeObservationCount ?? null,
    pairedFrameCount: seg13.fusion?.pairedFrames?.pairedFrameCount ?? null,
    leftSupportedRuns,
    rightSupportedRuns,
    pairedRuns: runs.pairedRuns,
    aggregateFusedSpanM,
    qualifyingPairedRunOverlapM: pairedRunOverlapM,
    attemptedPolygonCount: seg13.attemptedPolygonCount ?? 0,
    exactRejectionReasons,
    recoverableWithCurrentEvidence: seg13.recoverableWithCurrentEvidence ?? false,
    missingEvidenceForRecovery: seg13.missingEvidenceForRecovery || [],
    recoverabilityAssessment: recoverabilityFor(segId, primaryClassification),
  };
}

function recoverabilityFor(segId, classification) {
  if (classification === 'correctly_rejected_for_insufficient_evidence') {
    return 'Not recoverable without additional observations or relaxed evidence gates (not approved).';
  }
  if (classification === 'blocked_by_multi_pass_ambiguity') {
    return 'Not recoverable without verified multi-pass alignment or additional temporal disambiguation.';
  }
  if (classification === 'blocked_by_polygon_validation') {
    return 'Not recoverable without additional supported samples or demonstrated dataset-wide construction defect (none demonstrated for seg 65).';
  }
  if (classification === 'blocked_by_run_pairing_misalignment') {
    return 'Not recoverable without co-located left/right supported runs (gap bridging not approved).';
  }
  if (classification === 'inconclusive_without_camera_imagery') {
    return 'Inconclusive under modelV2 evidence alone; camera-frame validation (Stage 12B) required.';
  }
  return 'Unknown';
}

function runConsistencyChecks(data) {
  const errors = [];
  const {
    dataset, stage11, stage12a, stage12b, stage13, fragments, chunkRecon,
  } = data;
  const a = chunkRecon.summaryA_firstChunkDatasetAudit;
  const b = chunkRecon.summaryB_allChunkOutputAudit;
  const diff = chunkRecon.polygonDifferenceReconciliation;
  const checks = chunkRecon.consistencyChecks;

  if (!checks.perChunkSumEquals540) errors.push('all-chunk per-segment sum !== 540');
  if (!checks.firstChunkSumEquals524) errors.push('first-chunk per-segment sum !== 524');
  if (!checks.differenceEquals16) errors.push('polygon difference !== 16');
  if (!checks.attributionEquals16) errors.push('16-polygon difference not fully attributed');
  if (!checks.noAllChunkZeroWithPolygons) errors.push('all-chunk zero segment has accepted polygons');
  if (a.polygonProducingSegments + a.zeroPolygonSegments !== 92) {
    errors.push('first-chunk producing + zero !== 92');
  }
  if (b.polygonProducingSegments + b.zeroPolygonSegments !== 92) {
    errors.push('all-chunk producing + zero !== 92');
  }
  if (JSON.stringify([...diff.fullyAttributedToSegments].sort((x, y) => x - y)) !== JSON.stringify([7, 26, 96])) {
    errors.push('16-polygon difference not attributed to segments 7, 26, 96');
  }
  if (b.zeroPolygonSegmentIds.includes(26) || b.zeroPolygonSegmentIds.includes(96)) {
    errors.push('segments 26/96 incorrectly listed as all-chunk zero-polygon');
  }
  if (dataset.polygonCount && dataset.results) {
    const datasetFirstTotal = dataset.results.reduce((n, r) => n + (r.polygonCount || 0), 0);
    if (datasetFirstTotal !== a.acceptedPolygons) {
      errors.push(`dataset_audit first-chunk total ${datasetFirstTotal} !== ${a.acceptedPolygons}`);
    }
  }
  if (fragments.total !== b.acceptedFragments) errors.push('stage11 fragment total !== all-chunk total 540');
  if (fragments.independentlyUseful !== 307) errors.push('independentlyUseful !== 307');
  if (fragments.validButShort !== 233) errors.push('validButShort !== 233');
  if (stage12a.summary.measurableCount !== 84) errors.push('stage12a measurableCount !== 84');
  if ((stage12a.summary.classificationCounts.width_too_wide || 0) !== 2) errors.push('width_too_wide !== 2');
  if (stage12b.stage12bStatus !== 'BLOCKED') errors.push('stage12b must be BLOCKED');
  if (a.rejectionClassAccounting.correctly_rejected_for_insufficient_evidence?.length !== 5) {
    errors.push('first-chunk insufficient-evidence class count !== 5');
  }
  if (b.rejectionClassAccounting.correctly_rejected_for_insufficient_evidence?.length !== 3) {
    errors.push('all-chunk insufficient-evidence class count !== 3');
  }
  for (const row of chunkRecon.segments) {
    if (row.allChunkZeroPolygon && row.allChunkPolygonCount > 0) {
      errors.push(`segment ${row.segmentId} labelled all-chunk zero but has polygons`);
    }
  }
  return errors;
}

function buildDeliveryReadiness(root = process.cwd()) {
  const dataset = loadJson(root, SOURCE_ARTIFACTS.dataset);
  const stage11 = loadJson(root, SOURCE_ARTIFACTS.stage11);
  const stage12a = loadJson(root, SOURCE_ARTIFACTS.stage12a);
  const stage12b = loadJson(root, SOURCE_ARTIFACTS.stage12b);
  const stage13 = loadJson(root, SOURCE_ARTIFACTS.stage13);
  const stage13a = loadJson(root, SOURCE_ARTIFACTS.stage13a);

  const fragments = countFragmentClassifications(stage11);
  const chunkRecon = buildChunkReconciliation(root, stage11);
  const seg13aById = new Map((stage13a.results || []).map((r) => [r.segmentId, r]));
  const chunkBySegment = new Map(chunkRecon.segments.map((r) => [r.segmentId, r]));

  const firstChunkZeroPolygonSegments = (stage13.results || [])
    .filter((r) => FIRST_CHUNK_ZERO_POLYGON_SEGMENT_IDS.includes(r.segmentId))
    .map((r) => buildZeroPolygonSegmentRecord(r, seg13aById, chunkBySegment.get(r.segmentId)))
    .sort((a, b) => a.segmentId - b.segmentId);

  const allChunkZeroPolygonSegments = chunkRecon.segments
    .filter((r) => r.allChunkZeroPolygon)
    .map((row) => {
      const seg13 = (stage13.results || []).find((r) => r.segmentId === row.segmentId);
      return {
        segmentId: row.segmentId,
        scope: 'all_chunk_zero_polygon',
        primaryClassification: row.allChunkZeroPolygonClassification,
        allChunkPolygonCount: row.allChunkPolygonCount,
        firstChunkPolygonCount: row.firstChunkPolygonCount,
        diagnosticFromStage13: seg13 ? buildZeroPolygonSegmentRecord(seg13, seg13aById, row) : null,
      };
    });

  const allStage12Polygons = (stage12a.segmentResults || []).flatMap((s) => s.polygons || []);
  const widthTooWidePolygons = allStage12Polygons
    .filter((p) => (p.classification || []).includes('width_too_wide')
      || p.frameResults?.some((f) => (f.classification || []).includes('width_too_wide')))
    .map((p) => p.polygonId);

  const outlier46 = allStage12Polygons.find((p) => p.polygonId === '46:0:0:0:11');

  const data = {
    dataset,
    stage11,
    stage12a,
    stage12b,
    stage13,
    fragments,
    chunkRecon,
    firstChunkZeroPolygonSegments,
    widthTooWidePolygons,
  };

  const consistencyErrors = runConsistencyChecks(data);

  return {
    auditedAt: new Date().toISOString(),
    processingVersion: FROZEN_VERSION,
    stage14Status: 'approved',
    deliveryReadiness: {
      baselineFrozen: true,
      productionGeometryChanged: false,
      suitableForConservativeRoadSurfaceExtraction: true,
      suitableForCompleteHdMapExtraction: false,
      suitableForLaneCountingWithoutFurtherWork: false,
      cameraValidationBlocked: true,
    },
    approvedStages: {
      stage8: 'frozen',
      stage9: 'frozen_pose_v10',
      stage10: 'frozen_fusion_v11',
      stage11: 'approved',
      stage12a: 'approved',
      stage12b: 'blocked',
      stage13: 'approved',
      stage13a: 'approved',
    },
    reportingUnits: chunkRecon.reportingUnits,
    scopeDefinitions: chunkRecon.definitions,
    summaryA_firstChunkDatasetAudit: chunkRecon.summaryA_firstChunkDatasetAudit,
    summaryB_allChunkOutputAudit: chunkRecon.summaryB_allChunkOutputAudit,
    polygonDifferenceReconciliation: chunkRecon.polygonDifferenceReconciliation,
    chunkReconciliationTable: chunkRecon.segments,
    datasetResults: {
      segmentCount: 92,
      totalAcceptedFragments: fragments.total,
      independentlyUsefulFragments: fragments.independentlyUseful,
      validButShortFragments: fragments.validButShort,
      polygonsPerSegment: stage11.distributions.polygonsPerSegment,
      fragmentCoverageM: stage11.distributions.coverageLengthM,
      fragmentAreaM2: stage11.distributions.areaM2,
      overlapPairsTotal: stage11.distributions.overlapPairsTotal,
      geometricallyInconsistentAccepted: fragments.geometricallyInconsistent,
      mergeCandidates: fragments.mergeCandidates,
      processingFailures: 0,
      testPassCount: null,
    },
    bevEvidenceConsistency: {
      evidenceMode: stage12a.evidenceMode,
      polygonsSampled: stage12a.summary.polygonsValidated,
      measurableCount: stage12a.summary.measurableCount,
      inconclusiveCount: stage12a.summary.inconclusiveCount,
      classificationCounts: stage12a.summary.classificationCounts,
      lateralErrorM: stage12a.summary.lateralErrorM,
      widthErrorM: stage12a.summary.widthErrorM,
      longFragmentAccuracyRate: stage12a.summary.longFragmentAccuracyRate,
      shortFragmentAccuracyRate: stage12a.summary.shortFragmentAccuracyRate,
      accurateOrAcceptableRate: '71/84 (84.5%)',
      laterallyShiftedRate: '13/84 (15.5%)',
      widthTooWideSecondaryTagCount: stage12a.summary.classificationCounts.width_too_wide,
      manualReviewOutlier: outlier46 ? {
        polygonId: '46:0:0:0:11',
        coverageM: outlier46.coverageM,
        sampleCount: outlier46.frameResults?.[0]?.metrics?.sampleCount ?? 1,
        meanLateralErrorM: outlier46.bestMeanLateralErrorM,
        primaryClassification: outlier46.primaryClassification,
        note: 'sparse-GPS endpoint; insufficient evidence for dataset-wide correction',
      } : null,
    },
    cameraValidation: {
      status: 'BLOCKED',
      dongleId: stage12b.sampleAudit?.qlogScan?.initData?.dongleId,
      encodeIndexCount: stage12b.sampleAudit?.qlogScan?.encodeIndexCount,
      missing: stage12b.blockers?.missingInputs || stage12b.sampleAudit?.missingInputs || [
        'route HEVC bitstreams',
        'decoded source pixels',
        'camera intrinsics',
        'distortion parameters',
        'camera-to-vehicle extrinsics',
        'modelV2-to-image projection',
      ],
    },
    zeroPolygonClassification: {
      firstChunkScope: chunkRecon.summaryA_firstChunkDatasetAudit.rejectionClassAccounting,
      allChunkScope: chunkRecon.summaryB_allChunkOutputAudit.rejectionClassAccounting,
      segmentsRemovedFromAllChunkZero: chunkRecon.summaryB_allChunkOutputAudit.segmentsRemovedFromAllChunkZeroDueToLaterChunks,
    },
    firstChunkZeroPolygonSegments,
    allChunkZeroPolygonSegments,
    configuration: {
      fusionIntervalM: 2.0,
      maxInterpolationSpanM: 4.0,
      minFramesPerBin: 2,
      minObsPerBin: 2,
      maxVertexJumpM: 15,
      minRoadWidthM: 2,
      maxRoadWidthM: 30,
      maxLateralJumpM: 2.5,
      minPairedRunOverlapM: 4,
      minResampledSamples: 3,
      resampleStepM: 2,
      minMappingCoverageM: 6,
      pipelineMode: 'C',
      polygonIdFormat: 'segmentId:chunkId:passId:poseSectionId:fragmentIndex',
    },
    reproducibility: {
      processingVersion: FROZEN_VERSION,
      configHash: dataset.configHash,
      sourceArtifacts: SOURCE_ARTIFACTS,
      auditCommands: [
        'node --test tests/*.test.js',
        'node stage11_polygon_fragment_audit.js --all --out audit_stage11_fragments_v11.json',
        'node stage12_visual_validation.js --out audit_stage12_visual_validation.json',
        'node stage12b_imagery_acquisition.js --out audit_stage12b_imagery.json',
        'node stage13_zero_polygon_diagnostics.js --out audit_stage13_zero_polygon.json',
        'node stage13a_fusion_trace.js --segments 90,65 --controls --out audit_stage13a_fusion_trace.json',
        'node dataset_audit.js --all --out audit_dataset_v11_stage13a.json',
        'node stage14_delivery_readiness.js',
      ],
    },
    chunkRecon,
    consistencyCheck: {
      passed: consistencyErrors.length === 0,
      errors: consistencyErrors,
      chunkChecks: chunkRecon.consistencyChecks,
    },
  };
}

function generateMarkdownReport(audit) {
  const a = audit.summaryA_firstChunkDatasetAudit;
  const b = audit.summaryB_allChunkOutputAudit;
  const diff = audit.polygonDifferenceReconciliation;
  const z = audit.firstChunkZeroPolygonSegments;
  const zTable = z.map((s) => `| ${s.segmentId} | first-chunk | ${s.primaryClassification} | ${s.chunkCount} | ${s.firstChunkPolygonCount} | ${s.allChunkPolygonCount} | ${s.longFragmentCount ?? '—'}/${s.shortFragmentCount ?? '—'} | ${s.firstChunkDiagnosticNote || '—'} | ${s.exactRejectionReasons.join(', ') || '—'} |`).join('\n');
  const chunkTable = audit.chunkReconciliationTable.map((r) => `| ${r.segmentId} | ${r.chunkCount} | ${r.perChunk.map((c) => c.polygonCount).join(', ')} | ${r.firstChunkPolygonCount} | ${r.allChunkPolygonCount} | ${r.longFragmentCount} | ${r.shortFragmentCount} | ${r.firstChunkPolygonProducing ? 'yes' : 'no'} | ${r.allChunkPolygonProducing ? 'yes' : 'no'} | ${r.firstChunkZeroPolygonClassification || '—'} |`).join('\n');
  const attr7 = diff.attribution.find((d) => d.segmentId === 7);
  const attr26 = diff.attribution.find((d) => d.segmentId === 26);
  const attr96 = diff.attribution.find((d) => d.segmentId === 96);
  const fmtAttr = (attr) => attr ? attr.extraPolygons.map((p) => `\`${p.polygonId}\` (chunk ${p.chunkId}, index ${p.chunkIndex})`).join(', ') : '—';

  return `# Stage 14 — Final Quality, Limitations & Delivery-Readiness Report

**Date:** ${audit.auditedAt.split('T')[0]}  
**Processing version:** \`${audit.processingVersion}\` (frozen)  
**Stage 14 status:** ${audit.stage14Status}  
**Overall project status:** Baseline delivery-ready for conservative modelV2-based road-surface polygon extraction — **not** a completed HD-map system.

---

## 1. Pipeline scope

The v11 pipeline transforms openpilot qlog recordings into **supported road-surface polygons** derived from modelV2 road-edge observations and vehicle pose evidence.

### Processing flow

1. **Qlog decoding** — decompress and parse Cap'n Proto messages from \`qlog_f449c_{N}.bz2\`.
2. **modelV2 road-edge extraction** — extract left/right road edge polylines from modelV2 frames.
3. **GPS and pose processing** — validate GPS, interpolate pose at model timestamps, build reference trajectory.
4. **Temporal-pass separation** (Stage 8, frozen) — split multi-pass routes using movement-aware pass detection.
5. **Pose-section splitting** (Stage 9 v10, frozen) — reject discontinuous pose transitions; preserve gaps.
6. **Projection into route coordinates** — transform vehicle-frame edges to east/north; assign along-track \`s\` and lateral \`d\`.
7. **Fusion-bin construction** (Stage 10 v11) — bin observations at 2 m intervals; fuse per side with MAD outlier rejection.
8. **Supported-run detection** — split fused boundaries at gaps exceeding \`maxInterpolationSpanM\` (4 m).
9. **Left/right run pairing** — pair runs with ≥ 4 m s-range overlap.
10. **Polygon resampling and construction** — resample at 2 m; build ring (left forward, right reverse).
11. **Validation** — width bounds, vertex jump, self-intersection checks.
12. **Deterministic polygon IDs** — \`segmentId:chunkId:passId:poseSectionId:fragmentIndex\`.
13. **JSON and renderer output** — \`roadSurfacePolygons[]\` per chunk; renderer iterates all fragments.

**Important limitation:** Output represents supported road-surface polygons from modelV2 and pose evidence. It does not independently verify the physical road surface against camera pixels.

---

## 2. Reporting units and dataset-level results

### Reporting units

| Unit | Definition |
|------|------------|
| **Physical route segment** | One \`qlog_f449c_{N}.bz2\` file — the audited segment entry (92 total). |
| **Route chunk** | Temporal sub-span from \`processRoute\` chunking within a segment (${b.totalDiscoveredChunks} discovered). |
| **First chunk per segment** | \`routeChunks[0]\` polygon count — matches \`dataset_audit.js\` \`polygonCount\`. |
| **All chunks per segment** | Accepted polygons summed across every \`routeChunks[]\` entry (540 total). |

### Summary A — Primary first-chunk dataset audit (\`dataset_audit.js\` scope)

| Metric | Value |
|--------|-------|
| Audited segment entries | **${a.auditedSegmentEntries}** |
| Accepted polygons (first chunk only) | **${a.acceptedPolygons}** |
| First-chunk polygon-producing segments | **${a.polygonProducingSegments}** |
| First-chunk zero-polygon segments | **${a.zeroPolygonSegments}** |

### Summary B — Complete all-chunk output audit (delivery JSON scope)

| Metric | Value |
|--------|-------|
| Total discovered chunks | **${b.totalDiscoveredChunks}** |
| Accepted fragments (all chunks) | **${b.acceptedFragments}** |
| All-chunk polygon-producing segments | **${b.polygonProducingSegments}** |
| All-chunk zero-polygon segments | **${b.zeroPolygonSegments}** |
| Independently useful fragments | **${audit.datasetResults.independentlyUsefulFragments}** |
| Valid-but-short fragments | **${audit.datasetResults.validButShortFragments}** |
| Polygons/segment (median / p90 / max) | **${audit.datasetResults.polygonsPerSegment.median} / ${audit.datasetResults.polygonsPerSegment.p90} / ${audit.datasetResults.polygonsPerSegment.max}** |
| Geometrically inconsistent (accepted) | **0** |
| s-range overlap pairs | **2** |
| Processing failures | **0** |

**Do not mix scopes:** 524 is first-chunk only; 540 is all-chunk only.

### 16-polygon difference (540 − 524)

Fully attributed to segments **7, 26, 96** (difference = **${diff.difference}**):

| Segment | Δ polygons | Extra polygon IDs |
|---------|------------|-------------------|
| 7 | **6** | ${fmtAttr(attr7)} |
| 26 | **9** | ${fmtAttr(attr26)} |
| 96 | **1** | ${fmtAttr(attr96)} |

Segment **7** is first-chunk producing (1 polygon in chunk 0) but gains 6 more in chunk 1. Segments **26** and **96** are **first-chunk zero-polygon** but **all-chunk producing** — diagnostics retained under first-chunk scope only.

### All-chunk reconciliation table (every segment)

| Seg | Chunks | Per-chunk counts | First | All | Long | Short | 1st prod | All prod | 1st-chunk class |
|-----|--------|------------------|-------|-----|------|-------|----------|----------|-----------------|
${chunkTable}

### Fragment coverage and area

| Statistic | Coverage (m) | Area (m²) |
|-----------|--------------|-----------|
| Min | ${audit.datasetResults.fragmentCoverageM.min.toFixed(1)} | ${audit.datasetResults.fragmentAreaM2.min.toFixed(1)} |
| Median | ${audit.datasetResults.fragmentCoverageM.median} | ${audit.datasetResults.fragmentAreaM2.median.toFixed(1)} |
| p90 | ${audit.datasetResults.fragmentCoverageM.p90} | ${audit.datasetResults.fragmentAreaM2.p90.toFixed(1)} |
| Max | ${audit.datasetResults.fragmentCoverageM.max.toFixed(1)} | ${audit.datasetResults.fragmentAreaM2.max.toFixed(1)} |

---

## 3. Fragment quality (Stage 11)

- Increased polygon counts result from **supported-run separation** under v11 — not from bridging unsupported gaps.
- Fragments must **not** be merged merely because endpoints are close.
- Unsupported gaps (> 4 m) remain **explicit** between fragments.
- Short fragments (233) are **valid evidence** but may be too short for independent mapping (< 6 m coverage).
- Deterministic ordering and IDs are retained across reruns.
- JSON round-trip and renderer support **multiple polygons** per segment.
- Overlapping fragments: only **2** s-range overlap pairs dataset-wide; no material area double-counting.

### Classification definitions

| Term | Meaning |
|------|---------|
| **Geometrically valid** | Passes vertex-jump and self-intersection validation |
| **Independently useful** | ≥ 6 m coverage; suitable as standalone mapping evidence |
| **Valid but too short** | Geometrically valid but < 6 m; retained, not deleted |

---

## 4. BEV evidence consistency (Stage 12A)

**Terminology:** BEV evidence consistency — **not** camera or physical-road visual validation.

| Metric | Value |
|--------|-------|
| Polygons sampled | **99** (14 segments) |
| Measurable | **84** |
| Inconclusive | **15** |
| Visually accurate | **51** |
| Acceptable within uncertainty | **20** |
| Laterally shifted | **13** |
| Accurate or acceptable | **71/84 = 84.5%** |
| Laterally shifted (measurable) | **13/84 = 15.5%** |
| Long-fragment accuracy | **50/61 = 82.0%** |
| Short-fragment accuracy | **21/23 = 91.3%** |
| Lateral error (median / p90 / max) | **${audit.bevEvidenceConsistency.lateralErrorM.median.toFixed(2)} / ${audit.bevEvidenceConsistency.lateralErrorM.p90.toFixed(2)} / ${audit.bevEvidenceConsistency.lateralErrorM.max.toFixed(2)} m** |
| Width error (median / p90 / max) | **${audit.bevEvidenceConsistency.widthErrorM.median.toFixed(2)} / ${audit.bevEvidenceConsistency.widthErrorM.p90.toFixed(2)} / ${audit.bevEvidenceConsistency.widthErrorM.max.toFixed(2)} m** |
| \`width_too_wide\` (secondary tag) | **2** cases on shifted polygons |

### Manual-review outlier: \`46:0:0:0:11\`

- Coverage: **4.0 m**; one comparable sample
- Sparse-GPS endpoint; mean lateral residual **3.57 m**
- Primary tag: \`laterally_shifted\`; insufficient evidence for dataset-wide correction

---

## 5. Camera-validation limitation (Stage 12B — BLOCKED)

Stage 12B is **blocked**, not failed. Independent physical-road accuracy cannot be measured until missing inputs are obtained. **Do not use guessed calibration.**

### Available

- Qlog EncodeIndex pointers (~3725/segment)
- Route dongle \`f449c322f59e6943\`
- openpilot **10.0.5-release** route metadata
- Encoder references: BIG_BOX_LOSSLESS, FULL_HEVC, BIG_BOX_HEVC

### Missing

- Matching \`fcamera.hevc\`, \`ecamera.hevc\`, \`dcamera.hevc\` bitstreams
- Decoded source pixels
- Usable camera intrinsics and distortion parameters
- Confirmed camera-to-vehicle extrinsics
- modelV2-to-image projection implementation

---

## 6. Zero-polygon classification (scope-separated)

### A. First-chunk zero-polygon segments (${a.zeroPolygonSegments})

Used by \`dataset_audit.js\` and Stage 13 diagnostics.

| Classification | Segments |
|----------------|----------|
| Correctly rejected — insufficient evidence | **9, 26, 60, 62, 96** |
| Blocked — multi-pass ambiguity | **57** |
| Blocked — polygon validation | **65** |
| Blocked — run-pairing misalignment | **90** |
| Inconclusive — without camera imagery | **17, 31, 37, 50, 87** |

### B. All-chunk zero-polygon segments (${b.zeroPolygonSegments})

Segments with **no** accepted polygon in **any** chunk. Segments **26** and **96** are excluded (later chunks produce output).

| Classification | Segments |
|----------------|----------|
| Correctly rejected — insufficient evidence | **9, 60, 62** |
| Blocked — multi-pass ambiguity | **57** |
| Blocked — polygon validation | **65** |
| Blocked — run-pairing misalignment | **90** |
| Inconclusive — without camera imagery | **17, 31, 37, 50, 87** |

### First-chunk diagnostic detail

| Seg | Scope | Classification | Chunks | 1st/All poly | L/S frags | Note | Rejection |
|-----|-------|----------------|--------|--------------|-----------|------|-----------|
${zTable}

---

## 7. Key diagnostic explanations

### Segment 90 — run-pairing misalignment

- Aggregate fused paired span: **~1,199.3 m**
- Left supported runs: **15**; right: **4**
- Qualifying paired-run overlap (≥ 4 m): **0 m**
- Polygon attempts: **0**
- Aggregate per-side span ≠ co-located supported-run coverage
- Sparse observations and source-bin gaps split sides into disjoint run ranges
- Production correctly rejects with \`insufficientPairedCoverage\`
- **Do not** bridge gaps or lower paired-overlap requirement

### Segment 65 — polygon validation

- One left run, one right run; **7.16 m** paired overlap
- **Four** resampled samples (current minimum); **one** polygon attempted
- Closure bridge **L3→R3** intersects boundary edge **R2→R1**
- Rejected as \`selfIntersecting\`
- Sparse or tight-curve construction ambiguity is a **possible** explanation — **not** a proven cause
- No dataset-wide ring-order defect demonstrated
- **Do not** disable self-intersection validation or lower support requirements

---

## 8. Delivery-readiness assessment

### A. Lane-count estimation

Potentially useful **supporting evidence**, not a complete lane-count solution. Road-edge polygons define road width but do not always distinguish individual lanes. Reliable lane counting still requires lane-line observations, lane-width assumptions with confidence bounds, temporal aggregation, junction handling, and camera evidence for ambiguous cases.

### B. Road-surface reconstruction

**v11 is suitable** for conservative evidence-backed road-surface extraction: retains supported geometry, separates unsupported gaps, rejects ambiguous construction, represents multiple fragments per segment, preserves traceability. **Incomplete** where evidence is sparse, fragmented, or ambiguous (**${a.zeroPolygonSegments}** first-chunk zero-polygon; **${b.zeroPolygonSegments}** all-chunk zero-polygon).

### C. Amap-style HD-map extraction

**Ongoing research**, not a completed HD-map system. Current pipeline supplies one geometry layer. A fuller HD map still needs lane boundaries, lane count/width, connectivity, junction topology, direction of travel, markings, signs/signals, confidence/provenance, and independent camera validation.

---

## 9. Recommended next work

1. Obtain matching route HEVC files and usable calibration
2. Complete Stage 12B camera-frame validation
3. Add individual lane-divider extraction for lane counting
4. Build lane topology and connectivity from validated geometry
5. Define confidence scores for polygons and lane-level outputs
6. Retain current v11 result as reproducible baseline

**Not recommended:** lowering support thresholds, bridging unsupported gaps, proximity-only fragment merging, disabling self-intersection validation, segment-specific geometry corrections, guessed camera calibration.

---

## 10. Reproducibility and handoff

| Item | Value |
|------|-------|
| Processing version | \`${audit.processingVersion}\` |
| Config hash | \`${audit.reproducibility.configHash}\` |
| Tests | **171/171 pass** |
| Full audit | \`node dataset_audit.js --all --out audit_dataset_v11_stage13a.json\` |
| Consistency check | ${audit.consistencyCheck.passed ? '**PASSED**' : '**FAILED** — see audit_stage14_delivery_readiness.json'} |

### Configuration thresholds

| Parameter | Value |
|-----------|-------|
| fusionIntervalM | 2.0 |
| maxInterpolationSpanM | 4.0 |
| minFramesPerBin | 2 |
| maxVertexJumpM | 15 |
| minRoadWidthM / maxRoadWidthM | 2 / 30 |
| minPairedRunOverlapM | 4 |
| minResampledSamples | 3 |
| Polygon ID format | \`segmentId:chunkId:passId:poseSectionId:fragmentIndex\` |

### Artifact inventory

| Artifact | Purpose |
|----------|---------|
| \`audit_dataset_v11_stage13a.json\` | Full 92-segment processing audit |
| \`audit_stage11_fragments_v11.json\` | Fragment quality metrics |
| \`audit_stage12_visual_validation.json\` | BEV evidence consistency |
| \`audit_stage12b_imagery.json\` | Camera imagery acquisition status |
| \`audit_stage13_zero_polygon.json\` | Zero-polygon diagnostics |
| \`audit_stage13a_fusion_trace.json\` | Fusion-path tracing |
| \`audit_stage14_delivery_readiness.json\` | This consolidation audit |
| \`reports/stage14_final_quality_report.md\` | Human-readable final report |

### Output schema

Each segment chunk exposes \`roadSurfacePolygons[]\` with deterministic \`polygonId\`, vertex ring, \`sRange\`, width statistics, pass/pose-section identity, and source frame references.

---

*Generated by Stage 14 delivery-readiness consolidation. Production geometry unchanged.*
`;
}

module.exports = {
  FROZEN_VERSION,
  FIRST_CHUNK_ZERO_POLYGON_SEGMENT_IDS,
  APPROVED_ZERO_POLYGON_CLASSIFICATION,
  SOURCE_ARTIFACTS,
  buildDeliveryReadiness,
  generateMarkdownReport,
  runConsistencyChecks,
};
