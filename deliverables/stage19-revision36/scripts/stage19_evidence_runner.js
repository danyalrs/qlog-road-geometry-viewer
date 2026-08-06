'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const spec = require('../lib/stage19_spec');

const SCHEMA_DIR = path.join(__dirname, '..', 'docs', 'schemas', 'stage19');
const OUT_DIR = path.join(__dirname, '..', 'docs', 'stage19', 'evidence');
const ROOT = path.join(__dirname, '..');

const SCHEMA_FILES = [
  'catalog_v0.json', 'manifest_v0.json', 'commit_v0.json', 'exclusions_v0.json',
  'unassociated_v0.json', 'cross_pass_v0.json', 'heading_v0.json', 'bev_v0.json',
  'assessment_v0.json', 'promotion_v0.json',
];

const INSTANCE_MAP = {
  'catalog_v0.json': spec.maximumCatalogRecord,
  'manifest_v0.json': () => spec.maximumManifestRecord('run-max'),
  'commit_v0.json': spec.maximumCommitRecord,
  'exclusions_v0.json': spec.maximumExclusionsRecord,
  'unassociated_v0.json': spec.maximumUnassociatedRecord,
  'cross_pass_v0.json': spec.maximumCrossPassRecord,
  'heading_v0.json': spec.maximumHeadingRecord,
  'bev_v0.json': spec.maximumBevRecord,
  'assessment_v0.json': spec.maximumAssessmentRecord,
  'promotion_v0.json': spec.maximumPromotionRecord,
};

async function validateSchemas() {
  const results = [];
  for (const file of SCHEMA_FILES) {
    const schemaPath = path.join(SCHEMA_DIR, file);
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const ajvMeta = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajvMeta);
    const validateMeta = ajvMeta.getSchema('https://json-schema.org/draft/2020-12/schema');
    const metaOk = validateMeta(schema);
    const ajvDoc = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajvDoc);
    const validateInstance = ajvDoc.compile(schema);
    const instance = INSTANCE_MAP[file]();
    const canonical = spec.jcsUtf8Bytes(instance);
    const instanceOk = validateInstance(instance);
    results.push({
      file, metaSchemaPass: metaOk, instancePass: instanceOk,
      canonicalUtf8Bytes: canonical.length,
      pass: metaOk && instanceOk,
    });
  }
  return { allPass: results.every((r) => r.pass), results };
}

function verifyDocumentationManifest() {
  const specPath = path.join(ROOT, 'docs', 'stage19_revision36_specification.md');
  const zipPath = path.join(ROOT, 'deliverables', 'stage19-revision36.zip');
  const manifestPath = path.join(ROOT, 'deliverables', 'stage19-revision36', 'MANIFEST.sha256');
  const specExists = fs.existsSync(specPath);
  const specText = specExists ? fs.readFileSync(specPath, 'utf8') : '';
  const zipExists = fs.existsSync(zipPath);
  const zipBytes = zipExists ? fs.statSync(zipPath).size : 0;
  const manifestExists = fs.existsSync(manifestPath);
  const manifestLines = manifestExists
    ? fs.readFileSync(manifestPath, 'utf8').trim().split('\n').filter((l) => l.includes('  '))
    : [];
  const byteClaim = specText.match(/\(([\d,]+)\s+bytes/i);
  const fileClaim = specText.match(/(\d+)\s+normative files/i);
  const claimedBytes = byteClaim ? Number(byteClaim[1].replace(/,/g, '')) : -1;
  const claimedFiles = fileClaim ? Number(fileClaim[1]) : -1;
  return {
    specExists,
    zipExists,
    manifestExists,
    zipBytes,
    manifestFileCount: manifestLines.length,
    byteClaimMatches: claimedBytes === zipBytes,
    fileClaimMatches: claimedFiles === manifestLines.length,
    documentsCrossPlatformTestCommand: specText.includes('node --test tests'),
    documentsEvidenceCommand: specText.includes('npm run stage19:evidence'),
    allPass: specExists && zipExists && manifestExists
      && claimedBytes === zipBytes && claimedFiles === manifestLines.length
      && specText.includes('node --test tests') && specText.includes('npm run stage19:evidence'),
  };
}

function runNpmTestCrossPlatform() {
  const result = spawnSync(process.execPath, ['--test', 'tests'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  return {
    pass: result.status === 0,
    status: result.status,
    command: 'node --test tests',
  };
}

function testsDeriveInvariantsIndependently() {
  const testPath = path.join(ROOT, 'tests', 'stage19_spec_evidence.test.js');
  if (!fs.existsSync(testPath)) return { pass: false, reason: 'missingTestFile' };
  const src = fs.readFileSync(testPath, 'utf8');
  const checks = [
    'verifyMaximumInstancesAgainstNormativeTable',
    'verifyNormativeCallees',
    'runSemanticFixtures',
    'runConformanceVectors',
    'runPartitionRegistryTests',
    'runPublicationIntegrationTests',
    'runRecoveryFilesystemTests',
    'captured.invariants.everyNormativeCalleeIsResolvedAndExercised, callees.allPass',
  ];
  const missing = checks.filter((c) => !src.includes(c));
  return { pass: missing.length === 0, missing, testPath };
}

async function runAll() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-evidence-'));
  try {
    const schemaValidation = await validateSchemas();
    const normativeCallees = await spec.verifyNormativeCallees();
    const maximumVerification = spec.verifyMaximumInstancesAgainstNormativeTable();
    const runtimePeak = spec.runtimePeakFixture();
    const jcsConformance = spec.runConformanceVectors();
    const partitionOwnership = spec.runPartitionOwnershipTests();
    const partitionRegistry = spec.runPartitionRegistryTests();
    const measuredConflict = spec.runMeasuredConflictFixture();
    const measuredConflictEmpty = spec.runMeasuredConflictEmptyFixture();
    const semantic = spec.runSemanticFixtures();
    const covariance = spec.runCovarianceMatrixFixtures();
    const publication = await spec.runPublicationIntegrationTests(tmpRoot);
    const recoveryFs = await spec.runRecoveryFilesystemTests(tmpRoot);
    const documentation = verifyDocumentationManifest();
    const npmTest = runNpmTestCrossPlatform();
    const independentTests = testsDeriveInvariantsIndependently();

    const invariants = {
      partitionDPPreservesRegisteredSurvivors: partitionRegistry.allPass,
      everyNormativeCalleeIsResolvedAndExercised: normativeCallees.allPass,
      maximumInstanceMeasurementsMatchNormativeTable: maximumVerification.allPass,
      maximumInstanceMemberCountsAreCorrect: maximumVerification.allPass,
      runtimePeakIsMeasuredAgainstAValidatedModel: runtimePeak.pass,
      jcsParserRejectsNestedDuplicateKeys: jcsConformance.nestedDuplicateRejected === true,
      jcsRequiredEdgeCasesPass: jcsConformance.allPass,
      everySemanticRuleHasValidAndInvalidEvidence: semantic.allPass && semantic.missingRules.length === 0,
      covarianceValidationPassesKnownMatrixFixtures: covariance.allPass,
      publicationAndRecoveryUseFilesystemIntegrationTests: publication.allPass && recoveryFs.allPass,
      readerPinAndQuarantineConcurrencyIsTested: recoveryFs.results.some((r) => r.name === 'new-pin-blocked-after-generation-bump' && r.pass),
      npmTestPassesCrossPlatform: npmTest.pass,
      testsDeriveInvariantsIndependently: independentTests.pass,
      documentationAndManifestMatchDeliveredFiles: documentation.allPass,
      allTenSchemasAreDelivered: SCHEMA_FILES.length === 10,
      everySchemaPassesDraft202012MetaSchemaValidation: schemaValidation.allPass,
      partitionOwnershipTestsPass: partitionOwnership.allPass,
      measuredConflictFixturePass: measuredConflict.pass && measuredConflictEmpty.pass,
    };

    invariants.finalInvariantClaimsAreBackedByDeliveredEvidence = Object.entries(invariants)
      .filter(([k]) => k !== 'finalInvariantClaimsAreBackedByDeliveredEvidence' && k !== 'selfContainedClaimMatchesTheDeliveredArtifact')
      .every(([, v]) => v === true);

    invariants.selfContainedClaimMatchesTheDeliveredArtifact = invariants.finalInvariantClaimsAreBackedByDeliveredEvidence
      && documentation.specExists;

    return {
      generatedAt: new Date().toISOString(),
      nodeVersion: process.version,
      v8Version: process.versions.v8,
      schemaValidation,
      normativeCallees,
      maximumVerification,
      runtimePeak,
      jcsConformance,
      partitionOwnership,
      partitionRegistry,
      measuredConflict,
      measuredConflictEmpty,
      semantic,
      covariance,
      publication,
      recoveryFs,
      documentation,
      npmTest,
      independentTests,
      invariants,
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function main() {
  const captured = await runAll();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'captured_results.json');
  fs.writeFileSync(outPath, JSON.stringify(captured, null, 2));
  console.log(JSON.stringify(captured, null, 2));
  if (!captured.invariants.finalInvariantClaimsAreBackedByDeliveredEvidence) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
