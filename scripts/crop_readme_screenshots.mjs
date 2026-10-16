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
const input = process.argv[3] || path.join(root, 'docs', 'images', '_full-temp.png');

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
  const left = Math.round(w * 0.205);
  const top = Math.round(h * 0.17);
  const cropW = w - left - Math.round(w * 0.02);
  const cropH = h - top - Math.round(h * 0.04);
  const canvas = await sharp(input).extract({ left, top, width: cropW, height: cropH }).toBuffer();
  const closeLeft = Math.round(cropW * 0.22);
  const closeTop = Math.round(cropH * 0.28);
  const closeW = Math.round(cropW * 0.5);
  const closeH = Math.round(cropH * 0.55);
  await sharp(canvas)
    .extract({ left: closeLeft, top: closeTop, width: closeW, height: closeH })
    .resize({ width: 900, withoutEnlargement: false })
    .png({ compressionLevel: 9 })
    .toFile(outClose);
  console.log('Wrote', outClose);
} else {
  console.error('Unknown mode:', mode);
  process.exit(1);
}
