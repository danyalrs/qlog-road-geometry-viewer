#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'stage19_bundle');
const REPORT = path.join(ROOT, 'reports', 'stage19_legacy_publication_classification_v3.json');

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function classifyDir(name, fullPath) {
  const files = fs.existsSync(fullPath) ? fs.readdirSync(fullPath) : [];
  const hasManifest = files.includes('manifest_v0.json');
  const hasCommit = files.includes('commit_v0.json');
  const inRuns = fullPath.includes(`${path.sep}runs${path.sep}`);
  let classification = 'unknown';
  let relationship = 'none';
  if (name.startsWith('stage19-2026-07-27T')) {
    classification = 'legacy_dual_write_output';
    relationship = 'v0_development_artifact';
  } else if (name.startsWith('perf-run-')) {
    classification = 'non_authoritative_perf_output';
    relationship = 'v2_validation_harness';
  } else if (inRuns && hasManifest && hasCommit) {
    classification = 'authoritative_published_run';
    if (name.includes('stage19-v1')) relationship = 'v1';
    if (name.includes('stage19-v2')) relationship = 'v2';
    if (name.includes('stage19-v3')) relationship = 'v3';
  } else if (files.length === 0) {
    classification = 'empty_directory';
  }
  return {
    directory: name,
    path: fullPath,
    fileCount: files.length,
    hasManifest,
    hasCommit,
    classification,
    relationship,
    manifestSha256: hasManifest ? sha256File(path.join(fullPath, 'manifest_v0.json')) : null,
  };
}

function main() {
  const entries = [];
  for (const name of fs.readdirSync(BUNDLE)) {
    const full = path.join(BUNDLE, name);
    if (!fs.statSync(full).isDirectory()) continue;
    if (name === 'runs' || name === 'quarantine' || name === 'legacy_archive') {
      if (name === 'runs') {
        for (const run of fs.readdirSync(full)) {
          entries.push(classifyDir(run, path.join(full, run)));
        }
      }
      continue;
    }
    entries.push(classifyDir(name, full));
  }

  const archiveRoot = path.join(BUNDLE, 'legacy_archive');
  fs.mkdirSync(archiveRoot, { recursive: true });
  const actions = [];
  for (const e of entries) {
    if (e.classification === 'legacy_dual_write_output' || e.classification === 'non_authoritative_perf_output') {
      const dest = path.join(archiveRoot, e.directory);
      if (fs.existsSync(e.path) && !fs.existsSync(dest)) {
        fs.renameSync(e.path, dest);
        actions.push({ action: 'archived', from: e.path, to: dest, classification: e.classification });
      }
    }
  }

  const report = {
    classifiedAt: new Date().toISOString(),
    v0Preservation: {
      checkpointOnly: fs.existsSync(path.join(ROOT, 'checkpoints/stage19-implementation-pre-v0.json')),
      immutableRun: fs.existsSync(path.join(BUNDLE, 'runs', '2026-07-27-stage19-v0')),
      note: 'v0 was never published through the immutable run system; checkpoint-only preservation',
    },
    entries,
    actions,
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main();
