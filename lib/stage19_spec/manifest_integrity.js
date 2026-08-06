'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST_NAME = 'MANIFEST.sha256';

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listDeliverableFiles(rootDir) {
  const files = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else files.push(full);
    }
  }
  walk(rootDir);
  return files
    .map((f) => path.relative(rootDir, f).split(path.sep).join('/'))
    .filter((rel) => rel !== MANIFEST_NAME)
    .sort();
}

function generateManifest(rootDir) {
  const rels = listDeliverableFiles(rootDir);
  const lines = rels.map((rel) => `${sha256File(path.join(rootDir, rel))}  ${rel}`);
  fs.writeFileSync(path.join(rootDir, MANIFEST_NAME), `${lines.join('\n')}\n`, 'utf8');
  return { fileCount: rels.length, lines };
}

function verifyManifest(rootDir) {
  const manifestPath = path.join(rootDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    return { allPass: false, reason: 'missingManifest', missing: [MANIFEST_NAME], mismatched: [], extra: [] };
  }
  const entries = fs.readFileSync(manifestPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf('  ');
      return { hash: line.slice(0, idx).trim(), rel: line.slice(idx).trim() };
    });
  const expected = new Set(listDeliverableFiles(rootDir));
  const listed = new Set(entries.map((e) => e.rel));
  const missing = [...expected].filter((r) => !listed.has(r));
  const extra = [...listed].filter((r) => !expected.has(r));
  const mismatched = [];
  for (const e of entries) {
    const fp = path.join(rootDir, e.rel);
    if (!fs.existsSync(fp)) {
      missing.push(e.rel);
      continue;
    }
    const actual = sha256File(fp);
    if (actual !== e.hash) mismatched.push({ rel: e.rel, expected: e.hash, actual });
  }
  return {
    allPass: missing.length === 0 && extra.length === 0 && mismatched.length === 0,
    fileCount: entries.length,
    missing,
    extra,
    mismatched,
  };
}

function verifyWorkspaceEvidenceMatchesPackage(workspaceRoot, packageRoot) {
  const ws = path.join(workspaceRoot, 'docs/stage19/evidence/captured_results.json');
  const pkg = path.join(packageRoot, 'docs/stage19/evidence/captured_results.json');
  if (!fs.existsSync(ws) || !fs.existsSync(pkg)) {
    return { allPass: false, reason: 'missingEvidenceFile' };
  }
  const wsHash = sha256File(ws);
  const pkgHash = sha256File(pkg);
  return { allPass: wsHash === pkgHash, workspaceHash: wsHash, packageHash: pkgHash };
}

module.exports = {
  MANIFEST_NAME,
  sha256File,
  listDeliverableFiles,
  generateManifest,
  verifyManifest,
  verifyWorkspaceEvidenceMatchesPackage,
};
