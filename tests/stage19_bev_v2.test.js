'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isPngSignature, convertSvgToPng, decodePngMetadata } = require('../lib/stage19_bev_png');
const { loadStage18BevArtifacts, buildStage19BevRecord, validateBevLayers } = require('../lib/stage19_bev_production');
const { validateAgainstSchema } = require('../lib/stage19_schema_validate');
const { validateProductionQualityGates } = require('../lib/stage19_quality_gates');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'reports/stage18_bev/stage18_bev_stable_two_lane_assessment.svg');

describe('Stage 19 v2 BEV PNG production', () => {
  it('converts SVG to valid PNG with correct signature', async () => {
    const svgBytes = fs.readFileSync(SVG);
    const out = await convertSvgToPng(svgBytes);
    assert.equal(isPngSignature(out.pngBytes), true);
    const meta = await decodePngMetadata(out.pngBytes);
    assert.equal(meta.format, 'png');
    assert.ok(meta.widthPx >= 1);
    assert.ok(meta.heightPx >= 1);
    assert.ok(out.provenance.conversionTool);
  });

  it('loads Stage 18 artifacts as PNG payloads', async () => {
    const load = await loadStage18BevArtifacts();
    assert.ok(load.entries.length >= 1);
    for (const e of load.entries) {
      const bytes = load.payloads[e.payloadPath];
      assert.equal(isPngSignature(bytes), true);
      assert.equal(e.mime, 'image/png');
      assert.ok(e.provenance.sourceSvgSha256);
      assert.ok(e.provenance.conversionTool);
      assert.notEqual(e.sha256, e.sourceSvgSha256);
    }
  });

  it('published bev_v0.json has no extra properties and passes schema', async () => {
    const load = await loadStage18BevArtifacts();
    const bev = buildStage19BevRecord('test-run', load);
    assert.equal(Object.prototype.hasOwnProperty.call(bev, '_productionMeta'), false);
    const schema = validateAgainstSchema(bev, 'bev_v0.json');
    assert.equal(schema.ok, true, JSON.stringify(schema.errors));
  });

  it('rejects SVG bytes declared as PNG in quality gates', () => {
    const svg = fs.readFileSync(SVG);
    const gates = validateProductionQualityGates({
      catalog: { members: [] },
      crossPass: { pairs: [] },
      bev: { images: [{ mime: 'image/png', payloadPath: 'payloads/x.png', sha256: 'a'.repeat(64), imageId: 'x' }] },
      partitionResults: [],
      failedObservations: new Set(),
      crossPassCandidates: { candidates: [] },
      crossPassCandidateCount: 0,
      crossPassBundleCount: 0,
      bevAnchorCount: 0,
      assessments: [{ status: 'insufficient_evidence' }],
      sensitivityTable: { authorityNote: 'x' },
      partitionStats: { multiObservationChains: 0 },
      payloadFiles: { 'payloads/x.png': svg },
      expectedInsufficientIntervalCount: 1,
    }, { 'payloads/x.png': svg });
    assert.equal(gates.ok, false);
    assert.ok(gates.errors.some((e) => e.code === 'bev_mime_png_bytes_mismatch'));
  });

  it('rejects _productionMeta in schema validation', () => {
    const bad = { schemaVersion: 'stage19_bev_v0', runId: 'r', images: [], _productionMeta: [] };
    const r = validateAgainstSchema(bad, 'bev_v0.json');
    assert.equal(r.ok, false);
  });
});
