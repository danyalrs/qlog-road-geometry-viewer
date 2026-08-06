'use strict';

const fs = require('fs');
const path = require('path');
const { sha256Bytes, isPngSignature, decodePngMetadata, convertSvgToPng } = require('./stage19_bev_png');

const STAGE18_BEV_DIR = path.join(__dirname, '..', 'reports', 'stage18_bev');
const STAGE18_MANIFEST = path.join(STAGE18_BEV_DIR, 'stage18_bev_manifest.json');

function parseSvgDimensions(svgText) {
  const wm = svgText.match(/\bwidth="(\d+)"/);
  const hm = svgText.match(/\bheight="(\d+)"/);
  return {
    widthPx: wm ? parseInt(wm[1], 10) : 800,
    heightPx: hm ? parseInt(hm[1], 10) : 520,
  };
}

function validateBevLayers(entry, payloadBytes) {
  const pngValid = isPngSignature(payloadBytes);
  const layerA = {
    sourceExists: Boolean(entry.sourcePath && fs.existsSync(entry.sourcePath)),
    sourceSvgHashVerified: entry.sourceSvgSha256 === sha256Bytes(fs.readFileSync(entry.sourcePath)),
    pngSignatureValid: pngValid,
    conversionProvenancePresent: Boolean(
      entry.provenance?.conversionTool
      && entry.provenance?.sourceSvgSha256
      && entry.provenance?.sourceArtifact,
    ),
  };
  const layerB = {
    linkedIntervalOrAssessment: Boolean(entry.laneIntervalId || entry.countAssessmentId),
    nonEmptyPayload: payloadBytes.length > 0,
    dimensionsValid: entry.widthPx >= 1 && entry.heightPx >= 1,
    mimeMatchesBytes: entry.mime === 'image/png' && pngValid,
    hashVerified: entry.sha256 === sha256Bytes(payloadBytes),
  };
  return {
    layerA,
    layerB,
    layerAPass: Object.values(layerA).every(Boolean),
    layerBPass: Object.values(layerB).every(Boolean),
    pass: Object.values(layerA).every(Boolean) && Object.values(layerB).every(Boolean),
  };
}

async function loadStage18BevArtifacts(options = {}) {
  const manifestPath = options.manifestPath || STAGE18_MANIFEST;
  const bevDir = options.bevDir || STAGE18_BEV_DIR;
  const convertFn = options.convertSvgToPng || convertSvgToPng;
  if (!fs.existsSync(manifestPath)) throw new Error('stage18_bev_manifest_missing');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entries = [];
  const payloads = {};

  for (const art of manifest.artifacts || []) {
    if (!art.available || !art.file) continue;
    const sourcePath = path.join(bevDir, art.file);
    if (!fs.existsSync(sourcePath)) continue;
    const svgBytes = fs.readFileSync(sourcePath);
    const sourceSvgSha256 = sha256Bytes(svgBytes);
    const pngBase = art.file.replace(/\.svg$/i, '.png');
    const payloadPath = `payloads/${pngBase}`;
    const converted = await convertFn(svgBytes);
    if (!isPngSignature(converted.pngBytes)) throw new Error(`bev_png_conversion_invalid:${art.file}`);
    await decodePngMetadata(converted.pngBytes);

    entries.push({
      imageId: `bev-${art.category}`,
      featurePairId: art.laneIntervalId || art.countAssessmentId || art.category,
      category: art.category,
      laneIntervalId: art.laneIntervalId,
      countAssessmentId: art.countAssessmentId,
      sourcePath,
      sourceArtifact: art.file,
      sourceSvgSha256,
      payloadPath,
      widthPx: converted.widthPx,
      heightPx: converted.heightPx,
      sha256: converted.sha256,
      bytes: converted.bytes,
      mime: 'image/png',
      provenance: {
        generator: 'stage18_bev_inspection',
        sourceArtifact: art.file,
        sourceSvgPath: sourcePath,
        sourceSvgSha256,
        stage18GeneratedAt: manifest.generatedAt,
        selectionRule: art.selectionRule,
        processingVersion: '2026-07-24-lane-interval-assessment-v0',
        ...converted.provenance,
      },
    });
    payloads[payloadPath] = converted.pngBytes;
  }

  for (const entry of entries) {
    entry.layerValidation = validateBevLayers(entry, payloads[entry.payloadPath]);
  }

  return { manifest, entries, payloads };
}

function buildStage19BevRecord(runId, artifactLoad) {
  const images = [];
  for (const entry of artifactLoad.entries.filter((e) => e.layerValidation?.pass)) {
    images.push({
      imageId: entry.imageId,
      featurePairId: entry.featurePairId,
      widthPx: entry.widthPx,
      heightPx: entry.heightPx,
      mime: 'image/png',
      sha256: entry.sha256,
      bytes: entry.bytes,
      payloadPath: entry.payloadPath,
    });
  }
  return {
    schemaVersion: 'stage19_bev_v0',
    runId,
    images,
  };
}

function bevEntriesForInterval(artifactLoad, intervalId) {
  return artifactLoad.entries.filter((e) => e.laneIntervalId === intervalId);
}

module.exports = {
  STAGE18_BEV_DIR,
  STAGE18_MANIFEST,
  loadStage18BevArtifacts,
  buildStage19BevRecord,
  bevEntriesForInterval,
  validateBevLayers,
};
