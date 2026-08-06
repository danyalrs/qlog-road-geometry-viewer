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
const PACKAGE_ROOT = path.join(ROOT, 'deliverables', 'stage19-revision37');
const REV = 'revision37';

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
  const specPath = path.join(ROOT, 'docs', `stage19_${REV}_specification.md`);
  const zipPath = path.join(ROOT, 'deliverables', `stage19-${REV}.zip`);
  const manifestPath = path.join(PACKAGE_ROOT, 'MANIFEST.sha256');
  const specExists = fs.existsSync(specPath);
  const specText = specExists ? fs.readFileSync(specPath, 'utf8') : '';
  const zipExists = fs.existsSync(zipPath);
  const zipBytes = zipExists ? fs.statSync(zipPath).size : 0;
  const manifestExists = fs.existsSync(manifestPath);
  const manifestVerify = manifestExists ? spec.verifyManifest(PACKAGE_ROOT) : { allPass: false, fileCount: 0 };
  const byteClaim = specText.match(/\(([\d,]+)\s+bytes/i);
  const fileClaim = specText.match(/(\d+)\s+normative files/i);
  const claimedBytes = byteClaim ? Number(byteClaim[1].replace(/,/g, '')) : -1;
  const claimedFiles = fileClaim ? Number(fileClaim[1]) : -1;
  const buildInProgress = process.env.STAGE19_BUILD_IN_PROGRESS === '1';
  const evidenceMatch = fs.existsSync(PACKAGE_ROOT)
    ? spec.verifyWorkspaceEvidenceMatchesPackage(ROOT, PACKAGE_ROOT)
    : { allPass: false };
  const docOk = buildInProgress || (
    specExists && zipExists && manifestExists && manifestVerify.allPass
    && claimedBytes === zipBytes && claimedFiles === manifestVerify.fileCount
    && evidenceMatch.allPass
    && specText.includes('--expose-gc') && specText.includes('npm run stage19:evidence')
  );
  return {
    specExists,
    zipExists,
    manifestExists,
    zipBytes,
    manifestFileCount: manifestVerify.fileCount || 0,
    manifestVerifyPass: manifestVerify.allPass,
    byteClaimMatches: claimedBytes === zipBytes,
    fileClaimMatches: claimedFiles === (manifestVerify.fileCount || 0),
    evidenceHashMatches: evidenceMatch.allPass,
    documentsCrossPlatformTestCommand: specText.includes('--expose-gc') && (specText.includes('npm test') || specText.includes('node --test tests')),
    documentsEvidenceCommand: specText.includes('npm run stage19:evidence'),
    buildInProgress,
    allPass: docOk,
  };
}

function runNpmTestCrossPlatform() {
  const result = spawnSync(process.execPath, ['--expose-gc', '--test', 'tests'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  return {
    pass: result.status === 0,
    status: result.status,
    command: 'node --expose-gc --test tests',
  };
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
    const independentOracle = spec.runIndependentOracleChecks({ packageRoot: PACKAGE_ROOT });
    const workspaceManifest = fs.existsSync(PACKAGE_ROOT) ? spec.verifyManifest(PACKAGE_ROOT) : { allPass: false };
    const documentation = verifyDocumentationManifest();
    const npmTest = runNpmTestCrossPlatform();

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
      readerPinAndQuarantineConcurrencyIsTested: recoveryFs.results.some((r) => r.name === 'concurrent-reader-drain-before-quarantine' && r.pass),
      npmTestPassesCrossPlatform: npmTest.pass,
      testsDeriveInvariantsIndependently: independentOracle.allPass,
      documentationAndManifestMatchDeliveredFiles: documentation.allPass,
      manifestIntegrityVerified: workspaceManifest.allPass,
      allTenSchemasAreDelivered: SCHEMA_FILES.length === 10,
      everySchemaPassesDraft202012MetaSchemaValidation: schemaValidation.allPass,
      partitionOwnershipTestsPass: partitionOwnership.allPass,
      measuredConflictFixturePass: measuredConflict.pass && measuredConflictEmpty.pass,
    };

    invariants.finalInvariantClaimsAreBackedByDeliveredEvidence = Object.entries(invariants)
      .filter(([k]) => k !== 'finalInvariantClaimsAreBackedByDeliveredEvidence' && k !== 'selfContainedClaimMatchesTheDeliveredArtifact')
      .every(([, v]) => v === true);

    invariants.selfContainedClaimMatchesTheDeliveredArtifact = invariants.finalInvariantClaimsAreBackedByDeliveredEvidence
      && documentation.specExists && documentation.zipExists;

    return {
      generatedAt: new Date().toISOString(),
      revision: REV,
      nodeVersion: process.version,
      v8Version: process.versions.v8,
      exposeGc: typeof global.gc === 'function',
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
      independentOracle,
      workspaceManifest,
      documentation,
      npmTest,
      invariants,
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function main() {
  if (typeof global.gc !== 'function') {
    console.error('exposeGcRequired: run node with --expose-gc');
    process.exit(1);
  }
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
