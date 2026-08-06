'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PACKAGE_SPEC_ROOT = path.join(__dirname, '..', 'deliverables', 'stage19-revision37', 'lib', 'stage19_spec');
const WORKSPACE_SPEC_ROOT = path.join(__dirname, 'stage19_spec');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listFilesRecursive(rootDir) {
  const files = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else files.push(path.relative(rootDir, full).split(path.sep).join('/'));
    }
  }
  walk(rootDir);
  return files.sort();
}

function verifyNormativeBindingsAgainstPackage(options = {}) {
  const packageRoot = options.packageRoot || PACKAGE_SPEC_ROOT;
  const workspaceRoot = options.workspaceRoot || WORKSPACE_SPEC_ROOT;
  const pkgFiles = listFilesRecursive(packageRoot);
  const wsFiles = listFilesRecursive(workspaceRoot);
  const pkgSet = new Set(pkgFiles);
  const wsSet = new Set(wsFiles);
  const missing = pkgFiles.filter((f) => !wsSet.has(f));
  const extra = wsFiles.filter((f) => !pkgSet.has(f));
  const mismatched = [];
  for (const rel of pkgFiles) {
    if (!wsSet.has(rel)) continue;
    const a = sha256File(path.join(workspaceRoot, rel));
    const b = sha256File(path.join(packageRoot, rel));
    if (a !== b) mismatched.push({ rel, workspace: a, package: b });
  }
  return {
    ok: missing.length === 0 && extra.length === 0 && mismatched.length === 0,
    packageFileCount: pkgFiles.length,
    workspaceFileCount: wsFiles.length,
    missing,
    extra,
    mismatched,
  };
}

module.exports = {
  PACKAGE_SPEC_ROOT,
  WORKSPACE_SPEC_ROOT,
  verifyNormativeBindingsAgainstPackage,
  sha256File,
};
