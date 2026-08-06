#!/usr/bin/env node
/**
 * Stage 12B — imagery acquisition audit.
 * Usage: node stage12b_imagery_acquisition.js [--sample qlog_f449c_0.bz2] [--out audit_stage12b_imagery.json]
 */
const fs = require('fs');
const path = require('path');
const { PROCESSING_VERSION } = require('./lib/version');
const { auditImageryAcquisition, searchCameraFiles } = require('./lib/stage12b_imagery_acquisition');

const ROOT = __dirname;

function parseArgs() {
  const args = process.argv.slice(2);
  let sample = path.join(ROOT, 'qlog_f449c_0.bz2');
  let out = path.join(ROOT, 'audit_stage12b_imagery.json');
  let searchAll = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sample' && args[i + 1]) sample = args[++i];
    else if (args[i] === '--out' && args[i + 1]) out = args[++i];
    else if (args[i] === '--search-all') searchAll = true;
  }
  return { sample, out, searchAll };
}

function main() {
  const { sample, out, searchAll } = parseArgs();
  const samplePath = path.isAbsolute(sample) ? sample : path.join(ROOT, sample);
  if (!fs.existsSync(samplePath)) {
    console.error(`Sample qlog not found: ${samplePath}`);
    process.exit(1);
  }

  console.log(`Stage 12B imagery acquisition — version ${PROCESSING_VERSION}`);
  const audit = auditImageryAcquisition(samplePath);
  const globalSearch = searchAll
    ? searchCameraFiles([
      ROOT,
      path.join(ROOT, '..'),
      path.join(process.env.USERPROFILE || '', 'OneDrive', 'Documents'),
    ])
    : audit.externalFileSearch;

  const output = {
    auditedAt: new Date().toISOString(),
    processingVersion: PROCESSING_VERSION,
    stage12bStatus: 'BLOCKED',
    note: 'BEV overlays are NOT camera validation. This audit searches for independent source imagery only.',
    representativeQlog: audit.qlogFile,
    sampleAudit: audit,
    globalFileSearch: globalSearch,
    missingInputsSummary: audit.missingInputs,
    projectionRequirements: audit.projectionRequirements,
    expectedStorageLayout: audit.expectedStorageLayout,
  };

  const outPath = path.isAbsolute(out) ? out : path.join(ROOT, out);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}`);
  console.log(`EncodeIndex count: ${audit.qlogScan.encodeIndexCount}`);
  console.log(`Encode types: ${audit.qlogScan.encodeTypes.join(', ') || 'none'}`);
  console.log(`Route-relevant camera files found: ${globalSearch.routeRelevantFound?.length ?? globalSearch.found?.length ?? 0}`);
  console.log(`Stage 12B: ${output.stage12bStatus}`);
  for (const b of audit.missingInputs.slice(0, 4)) console.log(`  - ${b}`);
}

if (require.main === module) main();
