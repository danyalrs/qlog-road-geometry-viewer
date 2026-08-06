# Stage 19 — Normative Specification (Revision 37)

**Dataset-WWide Lane-Interval Sensitivity & BEV Evidence Audit**

| Field | Value |
|-------|-------|
| **Document** | Revision 37 |
| **Status** | **Specification pending final review** |
| **Authorization** | Planning only — **no implementation, no approval** |
| **Processing version** | `2026-07-24-dataset-sensitivity-bev-audit-v0` |
| **Frozen baseline** | `2026-07-24-fusion-v11` |
| **Runtime binding** | Node with `--expose-gc` required for memory evidence |

---

## 0. Delivered artifact manifest

**Primary delivery archive:** `deliverables/stage19-revision37.zip` (62,170 bytes, 38 normative files, verified central directory)

Extract to any directory; the project root is the `stage19-revision37/` folder inside the archive.

```bash
npm install
npm run stage19:evidence    # node --expose-gc scripts/stage19_evidence_runner.js
npm test                    # node --expose-gc --test tests
node scripts/stage19_independent_review.js
```

Both evidence and test commands require \`--expose-gc\` (configured in \`package.json\` as \`npm test\` → \`node --expose-gc --test tests\`).

All paths below are relative to the extracted project root (`stage19-revision37/`).

### 0.1 Specification and evidence

| Primary archive | `deliverables/stage19-revision37.zip` |
| Unpacked tree (same content) | `deliverables/stage19-revision37/` |
| Integrity manifest | `MANIFEST.sha256` (38 normative files; manifest excludes itself) |
| This specification | `docs/stage19_revision37_specification.md` |
| Captured evidence | `docs/stage19/evidence/captured_results.json` |
| Evidence runner | `scripts/stage19_evidence_runner.js` |
| Independent review | `scripts/stage19_independent_review.js` |
| Evidence tests | `tests/stage19_spec_evidence.test.js`, `tests/stage19_mutation.test.js` |

Reproduce evidence:

```bash
npm run stage19:evidence
npm test
node scripts/stage19_independent_review.js
```

Manifest verification runs during evidence generation, `npm test`, and independent review. Workspace and packaged `captured_results.json` hashes must match.

### 0.2 Normative reference implementation (exact binding)

Every normative procedure not repeated verbatim in this document is **exactly bound** to `lib/stage19_spec/`:

| Module | Procedures |
|--------|------------|
| `lib/stage19_spec/config.js` | frozen configuration constants |
| `lib/stage19_spec/math.js` | `normalQuantile`, `eigenvalues`, `referenceEigenvaluesQR`, `runCovarianceMatrixFixtures` |
| `lib/stage19_spec/jcs.js` | `jcsSerialize`, `Stage19JsonParser`, RFC 8785 float/exponent vectors |
| `lib/stage19_spec/partition.js` | ownership model, `partitionDP`, layer audit hooks, ownership tests |
| `lib/stage19_spec/runtime_memory.js` | 20-run GC measurement with median/min/max/CV |
| `lib/stage19_spec/semantic.js` | isolated per-rule fixtures, integration multi-error fixture |
| `lib/stage19_spec/recovery.js` | recovery actions bound to filesystem primitives |
| `lib/stage19_spec/recovery_fs.js` | concurrent reader drain, lease fencing, crash/restart |
| `lib/stage19_spec/manifest_integrity.js` | `generateManifest`, `verifyManifest`, evidence hash compare |
| `lib/stage19_spec/independent_oracle.js` | alternate invariant derivation (no substring oracle) |
| `lib/stage19_spec/normative_inventory.js` | identity, exercise, negative-control callees |

**Binding rule:** `everyNormativeCalleeIsResolvedAndExercised === true` when every export in `NORMATIVE_CALLEES` matches the bound module export by identity, exercises a non-trivial path with asserted output/side effects, and fails if replaced by a stub.

### 0.3 JSON Schemas (ten standalone documents)

Same paths as Revision 36 under `docs/schemas/stage19/`.

---

## 1. Revision 37 corrective scope

Revision 37 resolves independent review defects D1–D8 from Revision 36:

1. **D1 Runtime memory** — `--expose-gc` required; 20-run median/min/max/CV; actual partition/record structures; no ratio≤100 without measured justification.
2. **D2 Manifest integrity** — `MANIFEST.sha256` regenerated excluding self-hash; verified in evidence, tests, and independent review.
3. **D3 Evidence packaging** — evidence generated before ZIP; workspace/package evidence hash comparison.
4. **D4 Normative callees** — referential identity, non-trivial paths, negative stub controls for all declared callees.
5. **D5 Semantic isolation** — one mutation per rule; exactly one error code per negative fixture; separate integration fixture.
6. **D6 Partition ownership** — keeper pinning removed; ownership tracking; per-layer assertions.
7. **D7 Recovery FS** — real filesystem effects; concurrent reader drain; lease/fencing; crash/restart.
8. **D8 Independent derivation** — `independent_oracle.js` alternate checks; mutation tests; no static substring oracle.

---

## 2. Runtime memory model

Structural constants (`W_partition_state_base`, `W_node`, etc.) are validated against a 100-node structural sample within 8× predicted bytes. Retained catalog JCS bytes = 232,428. Pass requires all 20 heap deltas ≥ 500 KB, CV ≤ 0.75, and `--expose-gc`.

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

## 4. Revision 37 invariants (evidence-backed)

Regenerate with `npm run stage19:evidence`. All must be **derived from executed assertions**, not constants or captured flags:

```
partitionDPPreservesRegisteredSurvivors
everyNormativeCalleeIsResolvedAndExercised
maximumInstanceMeasurementsMatchNormativeTable
maximumInstanceMemberCountsAreCorrect
runtimePeakIsMeasuredAgainstAValidatedModel
jcsParserRejectsNestedDuplicateKeys
jcsRequiredEdgeCasesPass
everySemanticRuleHasValidAndInvalidEvidence
covarianceValidationPassesKnownMatrixFixtures
publicationAndRecoveryUseFilesystemIntegrationTests
readerPinAndQuarantineConcurrencyIsTested
npmTestPassesCrossPlatform
testsDeriveInvariantsIndependently
documentationAndManifestMatchDeliveredFiles
manifestIntegrityVerified
finalInvariantClaimsAreBackedByDeliveredEvidence
selfContainedClaimMatchesTheDeliveredArtifact
```

---

## 5. Final status

| Item | Status |
|------|--------|
| **Stage 19 specification** | **Pending final review** (Revision 37) |
| **Implementation** | **Not authorized** |
| **Approval** | **Not granted** |
| **Stages 15–18** | Approved and unchanged |
| **v11** | Frozen and unchanged |
| **Production lane counting** | Not implemented |
| **HD-map system** | Incomplete |
