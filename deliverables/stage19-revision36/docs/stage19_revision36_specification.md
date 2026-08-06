# Stage 19 — Normative Specification (Revision 36)

**Dataset-Wide Lane-Interval Sensitivity & BEV Evidence Audit**

| Field | Value |
|-------|-------|
| **Document** | Revision 36 |
| **Status** | **Specification pending final review** |
| **Authorization** | Planning only — **no implementation, no approval** |
| **Processing version** | `2026-07-24-dataset-sensitivity-bev-audit-v0` |
| **Frozen baseline** | `2026-07-24-fusion-v11` |
| **Runtime binding** | Node `v20.16.0` / V8 `11.3.244.8-node.23` |

---

## 0. Delivered artifact manifest

**Primary delivery archive:** `deliverables/stage19-revision36.zip` (49,999 bytes, 35 normative files, verified central directory)

Extract to any directory; the project root is the `stage19-revision36/` folder inside the archive.

```bash
# Unix / macOS / Git Bash
unzip stage19-revision36.zip
cd stage19-revision36
sha256sum -c MANIFEST.sha256   # optional integrity check
npm install
npm run stage19:evidence
node --test tests
```

```powershell
# Windows
Expand-Archive -Path stage19-revision36.zip -DestinationPath .
cd stage19-revision36
npm install
npm run stage19:evidence
node --test tests
```

Both commands were verified on Windows after fresh extraction (exit code 0, Node v20.16.0).

The cross-platform test entry point is `node --test tests` (also exposed as `npm test`).

All paths below are relative to the extracted project root (`stage19-revision36/`).

### 0.1 Specification and evidence

| Primary archive | `deliverables/stage19-revision36.zip` |
| Unpacked tree (same content) | `deliverables/stage19-revision36/` |
| Integrity manifest | `MANIFEST.sha256` (35 normative files) |
| This specification | `docs/stage19_revision36_specification.md` |
| Captured evidence | `docs/stage19/evidence/captured_results.json` |
| Evidence runner | `scripts/stage19_evidence_runner.js` |
| Evidence tests | `tests/stage19_spec_evidence.test.js` |

Reproduce evidence:

```bash
npm run stage19:evidence
node --test tests
```

### 0.2 Normative reference implementation (exact binding)

Every normative procedure not repeated verbatim in this document is **exactly bound** to `lib/stage19_spec/`:

| Module | Procedures |
|--------|------------|
| `lib/stage19_spec/config.js` | frozen configuration constants |
| `lib/stage19_spec/math.js` | `normalQuantile`, `symmetrize`, `eigenvalues`, `eigenvaluesSymmetric`, `runCovarianceMatrixFixtures` |
| `lib/stage19_spec/jcs.js` | `jcsSerialize`, `jcsUtf8Bytes`, `Stage19JsonParser`, `runConformanceVectors` |
| `lib/stage19_spec/canonical.js` | `quantizeUm`, `canonicalMatchId`, `canonicalPassPair` |
| `lib/stage19_spec/geometry.js` | all geometry helpers |
| `lib/stage19_spec/uncertainty.js` | `applyBranchSelection`, `validateCovariance`, `convertConfidenceScalar` |
| `lib/stage19_spec/partition.js` | `NodePool`, `StateRegistry`, `releaseExcept`, `partitionDP`, `runPartitionRegistryTests`, `runPartitionOwnershipTests` |
| `lib/stage19_spec/p3.js` | `chainTransitionValid`, `newOverlapRecord`, `runP3Branch` |
| `lib/stage19_spec/heading.js` | `runHeadingBranch` |
| `lib/stage19_spec/conflict.js` | `measuredConflictForGroup`, conflict fixtures |
| `lib/stage19_spec/maximum_instances.js` | maximum-instance constructors and normative byte-table verification |
| `lib/stage19_spec/runtime_memory.js` | measured heap peak fixture and structural constants |
| `lib/stage19_spec/semantic.js` | `validateStage19Semantics`, `DECLARED_SEMANTIC_RULES`, semantic fixtures |
| `lib/stage19_spec/publication.js` | filesystem publication integration |
| `lib/stage19_spec/recovery.js` | recovery action selection and loop |
| `lib/stage19_spec/recovery_fs.js` | filesystem recovery, reader-pin and quarantine integration tests |
| `lib/stage19_spec/normative_inventory.js` | `NORMATIVE_CALLEES`, `verifyNormativeCallees` |
| `lib/stage19_spec/index.js` | re-exports all bindings |

**Binding rule:** `everyNormativeCalleeIsResolvedAndExercised === true` when every export listed in `NORMATIVE_CALLEES` resolves to the bound module and is exercised with an asserted result or side effect by the evidence runner.

### 0.3 JSON Schemas (ten standalone documents)

| Schema | Path |
|--------|------|
| catalog | `docs/schemas/stage19/catalog_v0.json` |
| manifest | `docs/schemas/stage19/manifest_v0.json` |
| commit | `docs/schemas/stage19/commit_v0.json` |
| exclusions | `docs/schemas/stage19/exclusions_v0.json` |
| unassociated | `docs/schemas/stage19/unassociated_v0.json` |
| cross_pass | `docs/schemas/stage19/cross_pass_v0.json` |
| heading | `docs/schemas/stage19/heading_v0.json` |
| bev | `docs/schemas/stage19/bev_v0.json` |
| assessment | `docs/schemas/stage19/assessment_v0.json` |
| promotion | `docs/schemas/stage19/promotion_v0.json` |

---

## 1. Revision 36 corrective scope

Revision 36 addresses the Revision 35 independent review findings:

1. **Partition registry ownership** — `StateRegistry.releaseExcept` resolves registered IDs from survivor states and pins keeper node references before releasing rejected states.
2. **Normative callee inventory** — `verifyNormativeCallees` resolves and exercises every declared callee; no hardcoded binding flags.
3. **Maximum-instance reproduction** — generated, validated, canonicalized and measured against the §3.2 normative byte table (exclusions member count = 136).
4. **Runtime memory** — measured Node/V8 heap delta against retained maximum-catalog JCS bytes, not an analytical upper bound.
5. **JCS conformance** — recursive-descent parser with duplicate-key detection; expanded edge-case vectors.
6. **Semantic coverage** — valid and invalid fixture per declared semantic error code.
7. **Covariance validation** — Jacobi symmetric eigenvalue solver with known matrix fixtures.
8. **Publication and recovery** — temporary-directory filesystem integration tests.
9. **Cross-platform tests** — `node --test tests` (Windows verified).
10. **Independent tests** — `tests/stage19_spec_evidence.test.js` re-derives invariants without trusting captured flags alone.

---

## 2. Semantic validator contract

`validateStage19Semantics(bundle)` executes all rules declared in `DECLARED_SEMANTIC_RULES`. Every rule has at least one valid and one invalid executable fixture in `buildSemanticRuleFixtures()`.

---

## 3. Maximum-instance canonical UTF-8 byte measurements

| Artifact | UTF-8 bytes | Members |
|----------|------------:|--------:|
| catalog | 232,428 | 5,809 |
| manifest | 1,117 | 9 files |
| commit | 180 | — |
| exclusions | 4,450 | 136 |
| unassociated | 1,968 | 100 |
| cross_pass | 68,124 | 742 |
| heading | 102,134 | 742 |
| bev | 276 | 1 |
| assessment | 174 | — |
| promotion | 392 | 5 |

---

## 4. Revision 36 invariants (evidence-backed)

Regenerate with `npm run stage19:evidence`. All must be derived from executed checks:

```
partitionDPPreservesRegisteredSurvivors === true
everyNormativeCalleeIsResolvedAndExercised === true
maximumInstanceMeasurementsMatchNormativeTable === true
maximumInstanceMemberCountsAreCorrect === true
runtimePeakIsMeasuredAgainstAValidatedModel === true
jcsParserRejectsNestedDuplicateKeys === true
jcsRequiredEdgeCasesPass === true
everySemanticRuleHasValidAndInvalidEvidence === true
covarianceValidationPassesKnownMatrixFixtures === true
publicationAndRecoveryUseFilesystemIntegrationTests === true
readerPinAndQuarantineConcurrencyIsTested === true
npmTestPassesCrossPlatform === true
testsDeriveInvariantsIndependently === true
documentationAndManifestMatchDeliveredFiles === true
finalInvariantClaimsAreBackedByDeliveredEvidence === true
selfContainedClaimMatchesTheDeliveredArtifact === true
```

`selfContainedClaimMatchesTheDeliveredArtifact` requires the full normative-callee, evidence, schema, semantic-coverage and documentation checks above — not schema validation alone.

---

## 5. Final status

| Item | Status |
|------|--------|
| **Stage 19 specification** | **Pending final review** (Revision 36) |
| **Implementation** | **Not authorized** |
| **Approval** | **Not granted** |
| **Stages 15–18** | Approved and unchanged |
| **v11** | Frozen and unchanged |
| **Production lane counting** | Not implemented |
| **HD-map system** | Incomplete |
