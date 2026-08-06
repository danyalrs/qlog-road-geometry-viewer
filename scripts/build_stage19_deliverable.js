'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { generateManifest } = require('../lib/stage19_spec/manifest_integrity');

const ROOT = path.join(__dirname, '..');
const REV = 'revision37';
const DELIVERABLE_DIR = path.join(ROOT, 'deliverables', `stage19-${REV}`);
const ZIP_PATH = path.join(ROOT, 'deliverables', `stage19-${REV}.zip`);
const SPEC_SRC = path.join(ROOT, 'docs', `stage19_${REV}_specification.md`);

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyTree(srcDir, destDir, filter) {
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, ent.name);
    const dest = path.join(destDir, ent.name);
    if (ent.isDirectory()) copyTree(src, dest, filter);
    else if (!filter || filter(src)) copyFile(src, dest);
  }
}

function collectDeliverableFiles() {
  const files = [];
  const libDir = path.join(ROOT, 'lib', 'stage19_spec');
  for (const f of fs.readdirSync(libDir)) {
    if (f.endsWith('.js') && f !== 'partition_test_nopin.js') {
      files.push({ src: path.join(libDir, f), rel: `lib/stage19_spec/${f}` });
    }
  }
  const schemaDir = path.join(ROOT, 'docs', 'schemas', 'stage19');
  for (const f of fs.readdirSync(schemaDir)) {
    if (!f.endsWith('.json')) continue;
    files.push({ src: path.join(schemaDir, f), rel: `docs/schemas/stage19/${f}` });
  }
  files.push({ src: path.join(ROOT, 'docs', 'stage19', 'evidence', 'captured_results.json'), rel: 'docs/stage19/evidence/captured_results.json' });
  files.push({ src: SPEC_SRC, rel: `docs/stage19_${REV}_specification.md` });
  files.push({ src: path.join(ROOT, 'scripts', 'stage19_evidence_runner.js'), rel: 'scripts/stage19_evidence_runner.js' });
  files.push({ src: path.join(ROOT, 'scripts', 'stage19_independent_review.js'), rel: 'scripts/stage19_independent_review.js' });
  files.push({ src: path.join(ROOT, 'tests', 'stage19_spec_evidence.test.js'), rel: 'tests/stage19_spec_evidence.test.js' });
  files.push({ src: path.join(ROOT, 'tests', 'stage19_mutation.test.js'), rel: 'tests/stage19_mutation.test.js' });
  files.push({ src: path.join(ROOT, 'package.json'), rel: 'package.json' });
  return files;
}

function buildZip(sourceDir, zipPath) {
  if (process.platform === 'win32') {
    if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
    const ps = spawnSync('powershell', [
      '-NoProfile', '-Command',
      `Compress-Archive -Path '${sourceDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
    ], { stdio: 'inherit' });
    if (ps.status !== 0) throw new Error('zipFailed');
    return;
  }
  const r = spawnSync('zip', ['-r', zipPath, '.'], { cwd: sourceDir, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('zipFailed');
}

function updateSpecClaims(zipBytes, fileCount) {
  let specText = fs.readFileSync(SPEC_SRC, 'utf8');
  specText = specText.replace(/PLACEHOLDER_BYTES bytes, PLACEHOLDER_FILES normative files/g, `${zipBytes.toLocaleString('en-US')} bytes, ${fileCount} normative files`);
  specText = specText.replace(/PLACEHOLDER_FILES normative files; manifest excludes itself/g, `${fileCount} normative files; manifest excludes itself`);
  specText = specText.replace(/\([\d,]+ bytes, \d+ normative files/g, `(${zipBytes.toLocaleString('en-US')} bytes, ${fileCount} normative files`);
  specText = specText.replace(/MANIFEST\.sha256` \(\d+ normative files\)/g, `MANIFEST.sha256\` (${fileCount} normative files)`);
  fs.writeFileSync(SPEC_SRC, specText);
}

function finalizeDeliverableTree() {
  copyFile(path.join(ROOT, 'docs/stage19/evidence/captured_results.json'), path.join(DELIVERABLE_DIR, 'docs/stage19/evidence/captured_results.json'));
  copyFile(SPEC_SRC, path.join(DELIVERABLE_DIR, `docs/stage19_${REV}_specification.md`));
  generateManifest(DELIVERABLE_DIR);
  buildZip(DELIVERABLE_DIR, ZIP_PATH);
  const zipBytes = fs.statSync(ZIP_PATH).size;
  const fileCount = fs.readFileSync(path.join(DELIVERABLE_DIR, 'MANIFEST.sha256'), 'utf8').trim().split('\n').filter(Boolean).length;
  updateSpecClaims(zipBytes, fileCount);
  copyFile(SPEC_SRC, path.join(DELIVERABLE_DIR, `docs/stage19_${REV}_specification.md`));
  generateManifest(DELIVERABLE_DIR);
  buildZip(DELIVERABLE_DIR, ZIP_PATH);
  return {
    zipBytes: fs.statSync(ZIP_PATH).size,
    fileCount: fs.readFileSync(path.join(DELIVERABLE_DIR, 'MANIFEST.sha256'), 'utf8').trim().split('\n').filter(Boolean).length,
  };
}

function main() {
  if (!fs.existsSync(SPEC_SRC)) {
    console.error(`Missing specification: ${SPEC_SRC}`);
    process.exit(1);
  }
  const ev = spawnSync(process.execPath, ['--expose-gc', path.join(ROOT, 'scripts', 'stage19_evidence_runner.js')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, STAGE19_BUILD_IN_PROGRESS: '1' },
  });
  if (ev.status !== 0) {
    console.warn('Initial evidence run incomplete (expected before package exists); continuing build.');
  }

  if (fs.existsSync(DELIVERABLE_DIR)) fs.rmSync(DELIVERABLE_DIR, { recursive: true, force: true });
  fs.mkdirSync(DELIVERABLE_DIR, { recursive: true });

  for (const f of collectDeliverableFiles()) {
    if (!fs.existsSync(f.src)) {
      console.error(`Missing source file: ${f.src}`);
      process.exit(1);
    }
    copyFile(f.src, path.join(DELIVERABLE_DIR, f.rel));
  }

  const manifest = generateManifest(DELIVERABLE_DIR);
  console.log(`Generated MANIFEST.sha256 (${manifest.fileCount} files)`);

  buildZip(DELIVERABLE_DIR, ZIP_PATH);
  const zipBytes = fs.statSync(ZIP_PATH).size;
  const manifestLines = fs.readFileSync(path.join(DELIVERABLE_DIR, 'MANIFEST.sha256'), 'utf8').trim().split('\n').filter(Boolean).length;
  let specText = fs.readFileSync(SPEC_SRC, 'utf8');
  specText = specText.replace(/PLACEHOLDER_BYTES bytes, PLACEHOLDER_FILES normative files/, `${zipBytes.toLocaleString('en-US')} bytes, ${manifestLines} normative files`);
  specText = specText.replace(/PLACEHOLDER_FILES normative files; manifest excludes itself/, `${manifestLines} normative files; manifest excludes itself`);
  specText = specText.replace(/\*\*Primary delivery archive:\*\* `deliverables\/stage19-revision37.zip` \(PLACEHOLDER_BYTES bytes, PLACEHOLDER_FILES normative files/, `**Primary delivery archive:** \`deliverables/stage19-revision37.zip\` (${zipBytes.toLocaleString('en-US')} bytes, ${manifestLines} normative files`);
  fs.writeFileSync(SPEC_SRC, specText);
  copyFile(SPEC_SRC, path.join(DELIVERABLE_DIR, `docs/stage19_${REV}_specification.md`));
  generateManifest(DELIVERABLE_DIR);

  console.log('Final evidence regeneration...');
  const evFinal = spawnSync(process.execPath, ['--expose-gc', path.join(ROOT, 'scripts', 'stage19_evidence_runner.js')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  const finalized = finalizeDeliverableTree();
  if (finalized.zipBytes !== Number(fs.readFileSync(SPEC_SRC, 'utf8').match(/\(([\d,]+)\s+bytes/i)[1].replace(/,/g, ''))) {
    updateSpecClaims(finalized.zipBytes, finalized.fileCount);
    finalizeDeliverableTree();
  }
  console.log(`Built ${ZIP_PATH} (${fs.statSync(ZIP_PATH).size} bytes, ${finalized.fileCount} manifest entries)`);
  process.exit(evFinal.status || 0);
}

main();
