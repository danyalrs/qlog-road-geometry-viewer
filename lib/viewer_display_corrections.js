'use strict';

/**
 * Viewer display corrections keyed by immutable qlog source SHA-256.
 * Display-only; does not modify processing data.
 */

const fs = require('fs');
const path = require('path');
const VMC = require('./viewer_mirror_coords');

const CORRECTION_ID = 'fullSegmentLocalLateralReflection';
const MANIFEST_PATH = path.join(__dirname, '..', 'config', 'viewer_display_corrections.json');

function loadManifest(manifestPath = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function normalizeSha256(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
}

function createViewerDisplayCorrections(manifest) {
  const entries = manifest && typeof manifest === 'object' ? manifest : {};

  function manifestEntry(sourceQlogSha256) {
    const key = normalizeSha256(sourceQlogSha256);
    if (!key) return null;
    return entries[key] ?? null;
  }

  function isExactDisplayCorrectionActive(mirrorChecked, sourceQlogSha256) {
    if (!mirrorChecked) return false;
    const entry = manifestEntry(sourceQlogSha256);
    return entry?.correction === CORRECTION_ID;
  }

  function transformDisplayPoint(east, north) {
    return VMC.reflectSegmentLocalLateral(east, north);
  }

  function transformDisplayHeading(headingDeg) {
    if (!Number.isFinite(headingDeg)) return { headingDeg, valid: false };
    const normalized = ((headingDeg % 360) + 360) % 360;
    return { headingDeg: (180 - normalized + 360) % 360, valid: true };
  }

  function mirrorAwareBounds(bounds) {
    if (!bounds) return bounds;
    const corners = [
      { east: bounds.minE, north: bounds.minN },
      { east: bounds.minE, north: bounds.maxN },
      { east: bounds.maxE, north: bounds.minN },
      { east: bounds.maxE, north: bounds.maxN },
    ];
    let minE = Infinity;
    let maxE = -Infinity;
    let minN = Infinity;
    let maxN = -Infinity;
    for (const c of corners) {
      const t = transformDisplayPoint(c.east, c.north);
      if (!Number.isFinite(t.east) || !Number.isFinite(t.north)) continue;
      minE = Math.min(minE, t.east);
      maxE = Math.max(maxE, t.east);
      minN = Math.min(minN, t.north);
      maxN = Math.max(maxN, t.north);
    }
    if (!Number.isFinite(minE)) return bounds;
    return { minE, maxE, minN, maxN };
  }

  function getDiagnostics(mirrorChecked, sourceQlogSha256) {
    const key = normalizeSha256(sourceQlogSha256);
    const entry = manifestEntry(key);
    const active = isExactDisplayCorrectionActive(mirrorChecked, key);
    return {
      sourceQlogSha256: key,
      manifestMatch: entry ? 'true' : 'false',
      correctionActive: active ? 'true' : 'false',
      correction: entry?.correction ?? null,
      scope: entry?.scope ?? null,
      roadTransformSource: active ? 'canonical+fullSegmentLocalLateralReflection' : 'restoredResolver',
      laneTransformSource: active ? 'canonical+fullSegmentLocalLateralReflection' : 'restoredResolver',
      trajectoryTransformSource: active ? 'canonical+fullSegmentLocalLateralReflection' : 'canonical',
      arrowTransformSource: active ? 'canonical+fullSegmentLocalLateralReflection' : 'canonical',
    };
  }

  return {
    CORRECTION_ID,
    manifest: entries,
    manifestEntry,
    isExactDisplayCorrectionActive,
    transformDisplayPoint,
    transformDisplayHeading,
    mirrorAwareBounds,
    getDiagnostics,
  };
}

const defaultCorrections = createViewerDisplayCorrections(loadManifest());

function resolveSourceQlogSha256(processedData, chunkId) {
  const audits = processedData?.fileAudits || [];
  if (!audits.length) return null;
  const chunk = processedData?.routeChunks?.find((c) => c.chunkId === chunkId)
    ?? processedData?.routeChunks?.[0];
  const primaryFile = chunk?.files?.[0]
    ?? processedData?.frames?.find((f) => f.chunkId === chunkId)?.sourceFile
    ?? audits[0]?.filename;
  const audit = audits.find((a) => a.filename === primaryFile) || audits[0];
  return normalizeSha256(audit?.sha256);
}

module.exports = {
  CORRECTION_ID,
  MANIFEST_PATH,
  loadManifest,
  createViewerDisplayCorrections,
  resolveSourceQlogSha256,
  ...defaultCorrections,
};
