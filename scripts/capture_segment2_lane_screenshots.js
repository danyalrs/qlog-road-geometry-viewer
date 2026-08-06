'use strict';

/**
 * Capture Segment 2 lane cleanup screenshots via headless browser automation.
 * Usage: node scripts/capture_segment2_lane_screenshots.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots', 'segment2_lane_cleanup');
const PORT = 3847;
const INDICES = [0, 6, 13, 16, 29];
const MODES = {
  A_raw_observations: 'observations',
  B_tracked_observations: 'tracked',
  C_fused_before_cleanup: 'fused',
  D_rejected_geometry: 'rejected',
  E_cleaned_map: 'cleaned',
  F_cleaned_debug: 'cleanedDebug',
  G_cleaned_with_surface: 'cleanedWithSurface',
};

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    console.log('puppeteer not installed; writing capture plan only');
    const plan = [];
    for (const [label] of Object.entries(MODES)) {
      for (const idx of INDICES) plan.push(path.join('screenshots/segment2_lane_cleanup', `${label}_idx${idx}.png`));
    }
    fs.writeFileSync(path.join(OUT_DIR, 'capture_plan.json'), JSON.stringify({ plan, note: 'Install puppeteer or capture manually in browser' }, null, 2));
    return;
  }

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  const url = `http://localhost:${PORT}/?v=20260804a`;
  try {
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 15000 });
  } catch (e) {
    console.error('Could not reach dev server at', url, e.message);
    await browser.close();
    process.exit(1);
  }

  await page.select('#segmentSelect', 'qlog_f449c_2.bz2');
  await page.click('#btnProcess');
  await wait(3000);
  await page.select('#vizMode', 'local');
  await page.evaluate(() => document.getElementById('vizMode').dispatchEvent(new Event('change')));
  await wait(500);

  const captured = [];
  for (const [label, mode] of Object.entries(MODES)) {
    await page.select('#localGeometryMode', mode);
    await page.evaluate((m) => {
      document.getElementById('localGeometryMode').value = m;
      document.getElementById('localGeometryMode').dispatchEvent(new Event('change'));
    }, mode);
    await wait(600);
    for (const idx of INDICES) {
      await page.evaluate((i) => {
        const tl = document.getElementById('timeline');
        tl.value = String(i);
        tl.dispatchEvent(new Event('input'));
      }, idx);
      await wait(400);
      if (idx === INDICES[0]) {
        await page.click('#btnFit');
        await wait(300);
      }
      const file = path.join(OUT_DIR, `${label}_idx${idx}.png`);
      await page.screenshot({ path: file });
      captured.push(file);
      console.log('captured', file);
    }
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT_DIR, 'capture_manifest.json'), JSON.stringify({ captured, at: new Date().toISOString() }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
