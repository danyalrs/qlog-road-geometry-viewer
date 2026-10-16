/**
 * Crop full-window captures into README PNGs.
 *   node scripts/crop_readme_screenshots.mjs map <full.png>     → readme-app-screenshot.png
 *   node scripts/crop_readme_screenshots.mjs grey <full.png>    → readme-geometry-closeup.png
 */
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] || 'map';
const mapStageOnly = process.argv.includes('--mapstage');
const input = process.argv.find((a) => a.endsWith('.png')) || path.join(root, 'docs', 'images', '_full-temp.png');

const meta = await sharp(input).metadata();
const w = meta.width;
const h = meta.height;

if (mode === 'map') {
  const outMain = path.join(root, 'docs', 'images', 'readme-app-screenshot.png');
  const left = Math.round(w * 0.12);
  const top = Math.round(h * 0.08);
  const cropW = w - left - Math.round(w * 0.01);
  const cropH = h - top - Math.round(h * 0.02);
  await sharp(input)
    .extract({ left, top, width: cropW, height: cropH })
    .resize({ width: 1200, withoutEnlargement: false })
    .png({ compressionLevel: 9 })
    .toFile(outMain);
  console.log('Wrote', outMain);
} else if (mode === 'grey') {
  const outClose = path.join(root, 'docs', 'images', 'readme-geometry-closeup.png');
  const mapLeft = mapStageOnly ? 0 : Math.round(w * (280 / 1904.8));
  const mapTop = mapStageOnly ? 0 : Math.round(h * (153.8 / 1113.8));
  const mapW = mapStageOnly ? w : Math.round(w * (1624.8 / 1904.8));
  const mapH = mapStageOnly ? h : Math.round(h * (960 / 1113.8));

  const { data, info } = await sharp(input)
    .extract({ left: mapLeft, top: mapTop, width: mapW, height: mapH })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = info.width;
  const H = info.height;
  let minX = W;
  let minY = H;
  let maxX = 0;
  let maxY = 0;
  let hits = 0;

  const topIgnore = Math.round(H * 0.07);
  for (let y = 0; y < H; y += 2) {
    if (y < topIgnore) continue;
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max - min;
      const lum = (r + g + b) / 3;
      const isGrid = Math.abs(r - g) < 8 && Math.abs(g - b) < 8 && lum > 210 && lum < 245;
      const isTealOverlayText = g > r + 12 && g > b + 8 && lum > 90 && lum < 220;
      const isRoadFill = lum < 190 && lum > 100 && sat < 28;
      const isColoredLane = sat > 38 && lum < 225;
      const isContent = (isRoadFill || isColoredLane) && !isGrid && !isTealOverlayText;
      if (!isContent) continue;
      hits += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (hits < 100) {
    console.error('grey crop: could not detect road geometry pixels');
    process.exit(1);
  }

  const boxW = maxX - minX + 1;
  const boxH = maxY - minY + 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const margin = Math.round(Math.max(boxW, boxH) * 0.12);
  const targetAspect = 3 / 2;
  const maxCenteredW = 2 * Math.min(cx, mapW - 1 - cx);
  const maxCenteredH = 2 * Math.min(cy, mapH - 1 - cy);
  let cropW = Math.min(boxW + margin * 2, maxCenteredW, mapW);
  let cropH = Math.min(boxH + margin * 2, maxCenteredH, mapH);
  if (cropW / cropH > targetAspect) {
    cropH = Math.min(Math.round(cropW / targetAspect), maxCenteredH, mapH);
  } else {
    cropW = Math.min(Math.round(cropH * targetAspect), maxCenteredW, mapW);
  }
  cropW = Math.max(1, Math.min(cropW, maxCenteredW, mapW));
  cropH = Math.max(1, Math.min(cropH, maxCenteredH, mapH));
  const cropLeft = Math.round(cx - cropW / 2);
  const cropTop = Math.round(cy - cropH / 2);

  await sharp(input)
    .extract({
      left: mapLeft + cropLeft,
      top: mapTop + cropTop,
      width: cropW,
      height: cropH,
    })
    .resize({ width: 900, withoutEnlargement: false })
    .png({ compressionLevel: 9 })
    .toFile(outClose);
  console.log('Wrote', outClose, { cropLeft, cropTop, cropW, cropH, boxW, boxH });
} else {
  console.error('Unknown mode:', mode);
  process.exit(1);
}
