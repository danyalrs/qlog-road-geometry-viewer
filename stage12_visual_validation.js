#!/usr/bin/env node
/**
 * Stage 12 — visual/geometric accuracy audit against source model evidence.
 * Usage:
 *   node stage12_visual_validation.js
 *   node stage12_visual_validation.js --segments 0,2,46,27 --out audit_stage12_visual_validation.json
 */
const fs = require('fs');
const path = require('path');
const { PROCESSING_VERSION } = require('./lib/version');
const { DEFAULT_OPTS } = require('./lib/stage11_fragment_audit');
const {
  REQUIRED_SEGMENTS,
  OVERLAP_SEGMENT,
  buildStratifiedSample,
  auditSegmentVisual,
  summarizeVisualAudit,
  inspectOverlapPairs,
} = require('./lib/stage12_visual_validation');

const ROOT = __dirname;
const STAGE11_AUDIT = path.join(ROOT, 'audit_stage11_fragments_v11.json');

function parseArgs() {
  const args = process.argv.slice(2);
  let segments = null;
  let out = path.join(ROOT, 'audit_stage12_visual_validation.json');
  let outDir = path.join(ROOT, 'audit_stage12_visual');
  let stage11 = STAGE11_AUDIT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--segments' && args[i + 1]) {
      segments = args[++i].split(',').map((n) => parseInt(n.trim(), 10));
    } else if (args[i] === '--out' && args[i + 1]) out = args[++i];
    else if (args[i] === '--out-dir' && args[i + 1]) outDir = args[++i];
    else if (args[i] === '--stage11' && args[i + 1]) stage11 = args[++i];
  }
  if (!segments) {
    segments = [...new Set([...REQUIRED_SEGMENTS, OVERLAP_SEGMENT])].sort((a, b) => a - b);
  }
  return { segments, out, outDir, stage11 };
}

function suggestCorrectionRules(summary) {
  const rules = [];
  const patterns = summary.failurePatterns || [];
  if (patterns.some(([k]) => k === 'laterally_shifted')) {
    rules.push({
      rule: 'Review lateral offset calibration between modelV2 edges and fused boundaries at supported bins',
      evidence: 'Repeated lateral_shifted classifications in measurable frames',
      scope: 'dataset_wide',
    });
  }
  if (patterns.some(([k]) => k.includes('width'))) {
    rules.push({
      rule: 'Audit width pairing tolerance in pairSupportedRuns when edge confidence is low',
      evidence: 'Width too narrow/wide classifications',
      scope: 'dataset_wide',
    });
  }
  if (patterns.some(([k]) => k === 'unsupported_road_surface_extension')) {
    rules.push({
      rule: 'Tighten longitudinal polygon extent to visible edge x-range at support frames',
      evidence: 'Polygon extends beyond visible model edges',
      scope: 'dataset_wide',
    });
  }
  if (!rules.length) {
    rules.push({
      rule: 'No dataset-wide geometry correction indicated from visual audit',
      evidence: 'Classifications within acceptable thresholds or inconclusive',
      scope: 'none',
    });
  }
  return rules;
}

function manualReviewCases(segmentResults) {
  const cases = [];
  for (const seg of segmentResults) {
    for (const poly of seg.polygons || []) {
      if (poly.primaryClassification === 'incorrect_boundary_association'
        || poly.primaryClassification === 'laterally_shifted') {
        cases.push({
          polygonId: poly.polygonId,
          segmentId: seg.segmentId,
          classification: poly.primaryClassification,
          meanLateralErrorM: poly.bestMeanLateralErrorM,
        });
      }
    }
  }
  return cases;
}

function main() {
  const { segments, out, outDir, stage11 } = parseArgs();
  if (!fs.existsSync(stage11)) {
    console.error(`Stage 11 audit not found: ${stage11}`);
    console.error('Run: node stage11_polygon_fragment_audit.js --all');
    process.exit(1);
  }

  const fragmentAudit = JSON.parse(fs.readFileSync(stage11, 'utf8'));
  const bySeg = new Map((fragmentAudit.results || []).map((r) => [r.segmentId, r]));
  const samples = buildStratifiedSample(fragmentAudit, segments);

  console.log(`Stage 12 visual validation — ${segments.length} segment(s), version ${PROCESSING_VERSION}`);
  console.log('Evidence mode: BEV modelV2 road edges vs fused polygon (camera pixels unavailable)');

  fs.mkdirSync(outDir, { recursive: true });
  const segmentResults = [];
  const overlapInspections = [];

  for (const segId of segments) {
    const entry = bySeg.get(segId);
    if (!entry) {
      console.log(`  seg ${segId}... SKIP (not in stage11 audit)`);
      continue;
    }
    process.stdout.write(`  seg ${segId}...`);
    try {
      const result = auditSegmentVisual(segId, entry, DEFAULT_OPTS, { outDir, fs });
      segmentResults.push(result);
      if (segId === OVERLAP_SEGMENT) {
        overlapInspections.push(...inspectOverlapPairs(result));
      }
      console.log(` ${result.polygons.length} polygons validated`);
    } catch (e) {
      console.log(` ERROR ${e.message}`);
      segmentResults.push({ segmentId: segId, error: e.message, polygons: [] });
    }
  }

  const summary = summarizeVisualAudit(segmentResults, samples);
  const suggestedRules = suggestCorrectionRules(summary);
  const manualReview = manualReviewCases(segmentResults);

  const output = {
    auditedAt: new Date().toISOString(),
    processingVersion: PROCESSING_VERSION,
    evidenceMode: 'bev_model_edges',
    evidenceLimitation: 'Camera pixel decode unavailable; validation uses modelV2 road edges in vehicle frame as visible boundary proxy',
    samplingMethod: {
      requiredSegments: REQUIRED_SEGMENTS,
      overlapSegment: OVERLAP_SEGMENT,
      stratifiedCategories: [
        'independently_useful',
        'valid_short_fragment',
        'overlap_pair',
        'high_fragment_count',
        'control_segment',
      ],
      segmentsProcessed: segments,
      sampleEntries: samples.length,
      polygonsInSample: segmentResults.reduce((n, s) => n + (s.polygons?.length || 0), 0),
    },
    summary,
    overlapInspections,
    suggestedCorrectionRules: suggestedRules,
    manualReviewCases: manualReview,
    segmentResults,
  };

  const outPath = path.isAbsolute(out) ? out : path.join(ROOT, out);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log(`Overlays: ${outDir}/`);
  console.log(`Measurable: ${summary.measurableCount}/${summary.polygonsValidated}`);
  console.log(`Long-fragment accuracy: ${summary.longFragmentAccuracyRate}`);
  console.log(`Short-fragment accuracy: ${summary.shortFragmentAccuracyRate}`);
  console.log(`Overlap pairs inspected: ${overlapInspections.length}`);
}

if (require.main === module) main();
