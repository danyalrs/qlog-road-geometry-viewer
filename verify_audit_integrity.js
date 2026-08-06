#!/usr/bin/env node
/**
 * Verify dataset audit JSON integrity and regenerate corrupted files.
 * Detects compare_audits.js argv[3] corruption (comparison object written over audit input).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = __dirname;

const AUDIT_FILES = [
  { path: 'audit_dataset_full.json', kind: 'v6b baseline', regenerate: null },
  { path: 'audit_dataset_v7_full.json', kind: 'v9 movement-only', regenerate: '--all --movement-only --out audit_dataset_v9_movement_full.json' },
  { path: 'audit_dataset_v8_full.json', kind: 'v8 pose continuity (superseded)', regenerate: null },
  { path: 'audit_dataset_v9_full.json', kind: 'v9 pose continuity', regenerate: '--all --out audit_dataset_v9_full.json' },
  { path: 'audit_reference_v7.json', kind: 'v7 reference (legacy)', regenerate: '--segments 2,6,54,58,99 --movement-only --out audit_reference_v7.json' },
  { path: 'audit_reference_v7_rerun.json', kind: 'v7 reference rerun', regenerate: '--segments 2,6,54,58,99 --movement-only --out audit_reference_v7_rerun.json' },
  { path: 'audit_reference_v8.json', kind: 'v8 reference', regenerate: '--segments 2,6,54,58,99 --out audit_reference_v8.json' },
];

const COMPARISON_FILES = [
  { path: 'audit_comparison_v6b_v7.json', cmd: 'node compare_audits.js audit_dataset_full.json audit_dataset_v9_movement_full.json audit_comparison_v6b_v9movement.json' },
  { path: 'audit_comparison_v7_v8.json', cmd: 'node compare_audits.js audit_dataset_v7_full.json audit_dataset_v8_full.json audit_comparison_v7_v8.json' },
  { path: 'audit_comparison_v8_v9.json', cmd: 'node compare_audits.js audit_dataset_v8_full.json audit_dataset_v9_full.json audit_comparison_v8_v9.json' },
];

function sha256File(p) {
  const buf = fs.readFileSync(p);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function inspectAudit(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) {
    return { path: relPath, exists: false, valid: false, reason: 'missing' };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    return { path: relPath, exists: true, valid: false, reason: `parse error: ${e.message}` };
  }
  if (data.baselineVersion && !data.results) {
    return {
      path: relPath,
      exists: true,
      valid: false,
      reason: 'corrupted: comparison summary (baselineVersion) — likely compare_audits argv[3] overwrite',
      sha256: sha256File(abs),
      mtime: fs.statSync(abs).mtime.toISOString(),
    };
  }
  if (!Array.isArray(data.results)) {
    return { path: relPath, exists: true, valid: false, reason: 'missing results[]', sha256: sha256File(abs) };
  }
  return {
    path: relPath,
    exists: true,
    valid: true,
    processingVersion: data.processingVersion,
    segmentCount: data.results.length,
    multiPassCount: data.multiPassCount,
    zeroPolygonCount: data.zeroPolygonCount,
    medianProcessingMs: data.medianProcessingMs,
    sha256: sha256File(abs),
    mtime: fs.statSync(abs).mtime.toISOString(),
  };
}

function regenerate(relPath, flags) {
  console.log(`  Regenerating ${relPath} ...`);
  execSync(`node dataset_audit.js ${flags}`, { cwd: ROOT, stdio: 'inherit' });
}

function main() {
  const doFix = process.argv.includes('--fix');
  const report = { checkedAt: new Date().toISOString(), audits: [], comparisons: [], actions: [] };

  console.log('=== Audit integrity check ===\n');
  for (const entry of AUDIT_FILES) {
    let info = inspectAudit(entry.path);
    if (!info.valid && entry.regenerate && doFix) {
      regenerate(entry.path, entry.regenerate);
      info = inspectAudit(entry.path);
      report.actions.push({ file: entry.path, action: 'regenerated' });
    }
    report.audits.push({ ...info, kind: entry.kind });
    const status = info.valid ? 'OK' : `INVALID (${info.reason})`;
    console.log(`${entry.path}: ${status}`);
    if (info.valid) {
      console.log(`  version=${info.processingVersion} segments=${info.segmentCount} sha256=${info.sha256.slice(0, 16)}... mtime=${info.mtime}`);
    }
  }

  const allAuditsValid = report.audits.filter((a) => a.exists && a.kind.includes('full')).every((a) => a.valid);
  if (allAuditsValid && doFix) {
    console.log('\n=== Regenerating comparisons (correct argv[4]) ===\n');
    for (const cmp of COMPARISON_FILES) {
      execSync(cmp.cmd, { cwd: ROOT, stdio: 'inherit' });
      const abs = path.join(ROOT, cmp.path);
      report.comparisons.push({
        path: cmp.path,
        sha256: sha256File(abs),
        mtime: fs.statSync(abs).mtime.toISOString(),
      });
      console.log(`Wrote ${cmp.path}`);
    }
  } else if (!doFix) {
    console.log('\nRun with --fix to regenerate invalid audits and comparisons.');
  }

  const outPath = path.join(ROOT, 'checkpoints', 'audit_integrity_report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nReport: ${outPath}`);
}

if (require.main === module) main();
