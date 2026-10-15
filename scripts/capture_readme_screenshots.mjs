/**
 * Capture README screenshots (requires local qlog in repo root, not committed).
 * Usage: node scripts/capture_readme_screenshots.mjs
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'images');
const baseUrl = process.env.VIEWER_URL || 'http://127.0.0.1:3847/';

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1440, height: 900 } });
  const page = await browser.newPage();
  await page.goto(`${baseUrl}?mapBackground=street`, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForSelector('#segmentSelect option');
  await page.screenshot({ path: path.join(outDir, 'readme-welcome-before.png'), fullPage: false });

  await page.select('#segmentSelect', await page.$eval('#segmentSelect option', (o) => o.value));
  await page.click('#btnProcess');
  await page.waitForFunction(
    () => document.getElementById('mapEmptyHelp')?.classList.contains('hidden'),
    { timeout: 180000 },
  );
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, 'readme-app-screenshot.png'), fullPage: false });

  await browser.close();
  console.log('Wrote', path.join(outDir, 'readme-app-screenshot.png'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
