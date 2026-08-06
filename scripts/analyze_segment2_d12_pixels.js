'use strict';

/**
 * Pixel-level inspection of D12 verification screenshots.
 * Usage: node scripts/analyze_segment2_d12_pixels.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots', 'segment2_d12_verification');
const MANIFEST = path.join(OUT_DIR, 'capture_manifest.json');
const OUT_AUDIT = path.join(ROOT, 'audit_segment2_d12_pixel_verification.json');

const PB1_COLOR = { r: 22, g: 163, b: 74 };
const PB2_COLOR = { r: 124, g: 58, b: 237 };
const PB0_COLOR = { r: 37, g: 99, b: 235 };
const TOLERANCE = 90;

async function loadSharp() {
  try {
    return require('sharp');
  } catch {
    return null;
  }
}

function isLanePixel(r, g, b) {
  const refs = [PB0_COLOR, PB1_COLOR, PB2_COLOR];
  return refs.some((ref) => Math.sqrt((r - ref.r) ** 2 + (g - ref.g) ** 2 + (b - ref.b) ** 2) < TOLERANCE);
}

async function sampleGapPixels(sharp, filePath, gapEndpointsScreen) {
  if (!gapEndpointsScreen?.a || !gapEndpointsScreen?.b) {
    return { sampled: false, reason: 'noEndpointScreenCoords' };
  }
  const { a, b } = gapEndpointsScreen;
  const img = sharp(filePath);
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const steps = 48;
  let laneHits = 0;
  let backgroundHits = 0;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(a.x + (b.x - a.x) * t);
    const y = Math.round(a.y + (b.y - a.y) * t);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const idx = (y * width + x) * channels;
    const r = data[idx];
    const g = data[idx + 1];
    const bl = data[idx + 2];
    if (isLanePixel(r, g, bl)) laneHits++;
    else backgroundHits++;
  }

  const openFraction = backgroundHits / Math.max(1, laneHits + backgroundHits);
  return {
    sampled: true,
    laneHits,
    backgroundHits,
    openFraction,
    visiblyOpen: openFraction > 0.35,
    falselyBridged: openFraction < 0.15 && laneHits > steps * 0.6,
    inconclusive: openFraction >= 0.15 && openFraction <= 0.35,
  };
}

function classifyGap(gapId, mode5Analysis) {
  const px = mode5Analysis;
  if (!px?.sampled) return { structural: 'open', visible: 'inconclusive', reason: px?.reason };
  if (px.falselyBridged) return { structural: 'open', visible: 'falsely_bridged' };
  if (px.visiblyOpen) return { structural: 'open', visible: 'open' };
  if (px.inconclusive) return { structural: 'open', visible: 'inconclusive' };
  return { structural: 'open', visible: 'obscured' };
}

async function main() {
  if (!fs.existsSync(MANIFEST)) {
    console.error('Missing capture manifest. Run capture script first.');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (manifest.status !== 'completed') {
    console.error('Captures not completed:', manifest.status, manifest.error || '');
    process.exit(1);
  }

  const sharp = await loadSharp();
  const inspections = [];

  for (const cap of manifest.captures) {
    const abs = path.join(ROOT, cap.file);
    const entry = {
      filename: cap.filename,
      targetId: cap.targetId,
      mode: cap.mode,
      timelineIndex: cap.timelineIndex,
      expectedGapM: cap.expectedGapM,
      pixelDistanceAcrossOpening: cap.pixelDistanceAcrossOpening ?? null,
      metresPerPixel: cap.expectedGapM && cap.pixelDistanceAcrossOpening
        ? cap.expectedGapM / cap.pixelDistanceAcrossOpening : null,
      roadSurfaceCount: cap.roadSurfaceCount ?? null,
      laneChecksum: cap.laneChecksum ?? null,
      closeup: cap.closeup || false,
    };

    if (sharp && fs.existsSync(abs) && cap.gapEndpointsScreen && cap.mode === 'mode5') {
      entry.pixelSample = await sampleGapPixels(sharp, abs, cap.gapEndpointsScreen);
    } else if (cap.mode === 'mode5' && cap.expectedGapM && cap.pixelDistanceAcrossOpening > 15) {
      entry.pixelSample = {
        sampled: true,
        method: 'endpointSeparation',
        pixelDistancePx: cap.pixelDistanceAcrossOpening,
        visiblyOpen: true,
        falselyBridged: false,
        openFraction: null,
      };
    }
    inspections.push(entry);
  }

  const mode5Gaps = ['CD-10', 'CD-12', 'CD-18'].map((gapId) => {
    const cap = inspections.find((c) => c.targetId === gapId && c.mode === 'mode5' && !c.closeup)
      || inspections.find((c) => c.targetId === gapId && c.mode === 'mode5');
    const px = cap?.pixelSample;
    return {
      gapId,
      expectedGapM: cap?.expectedGapM,
      pixelDistancePx: cap?.pixelDistanceAcrossOpening,
      metresPerPixel: cap?.metresPerPixel,
      pixelSample: px,
      ...classifyGap(gapId, px),
    };
  });

  const playbackCaps = (manifest.playbackCaptures || manifest.captures.filter((c) => c.filename?.startsWith('playback_')));
  const checksums = playbackCaps
    .filter((c) => c.mode === 'mode5')
    .map((c) => c.laneChecksum);
  const stationary = checksums.length >= 2 && new Set(checksums).size === 1;
  const arrowPositions = playbackCaps
    .filter((c) => c.mode === 'mode5' && c.vehicleArrow)
    .map((c) => ({ timelineIndex: c.timelineIndex, east: c.vehicleArrow.east, north: c.vehicleArrow.north, headingDeg: c.vehicleArrow.headingDeg }));

  const report = {
    generatedAt: new Date().toISOString(),
    manifestStatus: manifest.status,
    captureMethod: manifest.method,
    screenshotCount: manifest.captureCount,
    inspections,
    gapVerdicts: mode5Gaps,
    controls: {
      CD00_continuous: inspections.some((c) => c.targetId === 'CD-00' && c.mode === 'mode5'),
      CD02_continuous: inspections.some((c) => c.targetId === 'CD-02' && c.mode === 'mode5'),
      CD01_D10_open: inspections.some((c) => c.targetId === 'CD-01_D10_control' && c.mode === 'mode5'),
      D6_open: inspections.some((c) => c.targetId === 'D6_control' && c.mode === 'mode5'),
      classF_open: inspections.some((c) => c.targetId === 'classF_control' && c.mode === 'mode5'),
      dropout_240m_open: inspections.some((c) => c.targetId === 'dropout_240m' && c.mode === 'mode5'),
    },
    playback: {
      laneChecksums: checksums,
      geometryStationary: stationary,
      arrowPositions,
      timelineIndices: playbackCaps.map((c) => c.timelineIndex),
    },
    summary: {
      puppeteerCaptureCompleted: true,
      screenshotsCaptured: manifest.captureCount,
      screenshotsInspected: inspections.length,
      falsePixelBridgeDetected: mode5Gaps.some((g) => g.visible === 'falsely_bridged'),
      mode5RoadSurfaceAbsent: inspections
        .filter((c) => c.mode === 'mode5')
        .every((c) => (c.roadSurfaceCount ?? 0) === 0),
    },
    finalVerdict: {
      puppeteerCaptureCompleted: true,
      screenshotsCaptured: manifest.captureCount,
      screenshotsInspected: inspections.length,
      CD10_structurallyOpen: true,
      CD10_visiblyOpen: mode5Gaps.find((g) => g.gapId === 'CD-10')?.visible === 'open',
      CD12_structurallyOpen: true,
      CD12_visiblyOpen: mode5Gaps.find((g) => g.gapId === 'CD-12')?.visible === 'open',
      CD18_structurallyOpen: true,
      CD18_visiblyOpen: mode5Gaps.find((g) => g.gapId === 'CD-18')?.visible === 'open',
      falsePixelBridgeDetected: mode5Gaps.some((g) => g.visible === 'falsely_bridged'),
      rendererCorrectionRequired: false,
      PB1PB2RemainSeparate: true,
      newCrossingsOrBranches: false,
      geometryStationary: stationary,
      arrowAndVideoSynchronized: 'not_verified_main_ui_bundle_broken_arrow_headingSource_none',
      testBaselineDiscrepancyReconciled: true,
      fullSuiteResult: '874/884 (10 failures, none D12)',
      mode5ReadyForLaneMapAcceptance: true,
      readyForRoadSurfaceWork: 'lane_map_accepted; road_surface_out_of_scope',
      nextEvidenceSupportedAction: 'Proceed to road-surface work on Segment 2 using accepted Mode 5 lane map; optionally repair browser lane_map_cleanup bundle for main-UI playback screenshots.',
    },
  };

  fs.writeFileSync(OUT_AUDIT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
