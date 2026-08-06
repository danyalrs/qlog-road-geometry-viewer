# Stage 19 — Normative Specification (Revision 35)

**Dataset-Wide Lane-Interval Sensitivity & BEV Evidence Audit**

| Field | Value |
|-------|-------|
| **Document** | Revision 35 |
| **Status** | **Specification pending final review** |
| **Authorization** | Planning only — **no implementation, no approval** |
| **Processing version** | `2026-07-24-dataset-sensitivity-bev-audit-v0` |
| **Frozen baseline** | `2026-07-24-fusion-v11` |
| **Runtime binding** | Node `v20.16.0` / V8 `11.3.244.8-node.23` |

---

## 0. Delivered artifact manifest

**Primary delivery archive:** `deliverables/stage19-revision35.zip` (40,559 bytes, 37 ZIP entries, verified central directory)

Extract to any directory; the project root is the `stage19-revision35/` folder inside the archive.

```bash
# Unix / macOS / Git Bash
unzip stage19-revision35.zip
cd stage19-revision35
sha256sum -c MANIFEST.sha256   # optional integrity check
npm install
npm run stage19:evidence
npm test
```

```powershell
# Windows
Expand-Archive -Path stage19-revision35.zip -DestinationPath .
cd stage19-revision35
npm install
npm run stage19:evidence
npm test
```

Both commands were verified after fresh extraction (exit code 0, Node v20.16.0).

All paths below are relative to the extracted project root (`stage19-revision35/`).

### 0.1 Specification and evidence

| Primary archive | `deliverables/stage19-revision35.zip` |
| Unpacked tree (same content) | `deliverables/stage19-revision35/` |
| Integrity manifest | `MANIFEST.sha256` (33 normative files) |
| This specification | `docs/stage19_revision35_specification.md` |
| Captured evidence | `docs/stage19/evidence/captured_results.json` |
| Evidence runner | `scripts/stage19_evidence_runner.js` |
| Evidence tests | `tests/stage19_spec_evidence.test.js` |

Reproduce evidence:

```bash
npm run stage19:evidence
npm test -- tests/stage19_spec_evidence.test.js
```

### 0.2 Normative reference implementation (exact binding)

Every normative procedure not repeated verbatim in this document is **exactly bound** to `lib/stage19_spec/`:

| Module | Procedures |
|--------|------------|
| `lib/stage19_spec/config.js` | frozen configuration constants |
| `lib/stage19_spec/math.js` | `normalQuantile`, `symmetrize`, `eigenvalues`, `quadraticForm` |
| `lib/stage19_spec/jcs.js` | `jcsSerialize`, `jcsUtf8Bytes`, `Stage19JsonParser`, `runConformanceVectors` |
| `lib/stage19_spec/canonical.js` | `quantizeUm`, `canonicalMatchId`, `canonicalPassPair` |
| `lib/stage19_spec/geometry.js` | all geometry helpers |
| `lib/stage19_spec/uncertainty.js` | `applyBranchSelection`, `validateCovariance`, `convertConfidenceScalar` |
| `lib/stage19_spec/partition.js` | `NodePool`, `preActionClosure`, `postActionClosure`, `dedupeByFutureKey`, `finalizationClosure`, `partitionDP`, `runPartitionOwnershipTests` |
| `lib/stage19_spec/p3.js` | `chainTransitionValid`, `newOverlapRecord`, `runP3Branch` |
| `lib/stage19_spec/heading.js` | `runHeadingBranch` |
| `lib/stage19_spec/conflict.js` | `measuredConflictForGroup`, conflict fixtures |
| `lib/stage19_spec/maximum_instances.js` | all maximum-instance constructors |
| `lib/stage19_spec/runtime_memory.js` | `measureRuntimePeak_v1`, `runtimePeakFixture` |
| `lib/stage19_spec/semantic.js` | `validateStage19Semantics`, semantic fixtures |
| `lib/stage19_spec/recovery.js` | `selectRecoveryAction`, `applyRecoveryAction`, `runRecoveryLoop`, recovery fixtures |
| `lib/stage19_spec/index.js` | re-exports all bindings |

**Binding rule:** `everyNormativeCalleeIsDefinedOrExactlyBound === true` when the module export named in the table exists and is exercised by `scripts/stage19_evidence_runner.js`.

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

## 1. Previously unresolved callees (now bound)

| Callee | Binding |
|--------|---------|
| `preActionClosure` | `lib/stage19_spec/partition.js` — enumerates `closureSubsets`, copies state, calls `closeInPlace` |
| `postActionClosure` | `lib/stage19_spec/partition.js` — alias of `preActionClosure` |
| `dedupeByFutureKey` | `lib/stage19_spec/partition.js` — keys by `futureKey`, keeps lexicographically better partition state |
| `finalizationClosure` | `lib/stage19_spec/partition.js` — closes all non-empty open-path subsets, keeps fully closed states |
| `chainTransitionValid` | `lib/stage19_spec/p3.js` — `staticBranchCandidateEdge` + gap ≤ `maxP3InternalGapM` |
| `newOverlapRecord` | `lib/stage19_spec/p3.js` — extends parent overlap chain with hashed IDs |
| `selectRecoveryAction` | `lib/stage19_spec/recovery.js` — priority-ordered action selection |
| `normalQuantile` | `lib/stage19_spec/math.js` — Acklam rational approximation |
| `eigenvalues` | `lib/stage19_spec/math.js` — power-iteration deflation for 4×4/5×5 |

---

## 2. Semantic validator contract

`validateStage19Semantics(bundle)` in `lib/stage19_spec/semantic.js` executes all declared rules:

| Rule | Error code |
|------|------------|
| Observation coverage and disjointness | `observation_not_covered`, `catalog_extra_member`, `coverage_disjointness`, `duplicate_member` |
| Terminal branch foreign keys | `terminal_branch_foreign_key`, `branch_out_of_range` |
| Span positional agreement | `span_positional_inversion`, `span_positional_nonfinite` |
| Heading-audit foreign keys | `heading_audit_foreign_key`, `heading_fk_mismatch` |
| Measured-conflict candidate foreign keys | `conflict_candidate_foreign_key` |
| Cross-pass feature-pair foreign keys | `duplicate_feature_pair_id`, `missing_feature_pair_id`, `bev_feature_pair_foreign_key` |
| BEV `featurePairId` uniqueness | `duplicate_bev_feature_pair_id` |
| Image-hash and payload linkage | `bev_payload_missing`, `bev_image_hash_mismatch` |
| Manifest-to-payload coverage | `manifest_payload_missing`, `manifest_hash_mismatch`, `payload_not_in_manifest` |
| Status, evidence-shape and promotion agreement | `status_promotion_mismatch`, `status_evidence_shape_mismatch`, `failed_missing_evidence`, `conflict_missing_evidence`, `insufficient_missing_evidence`, `caveats_missing`, `promotion_table_mismatch` |

---

## 3. Captured evidence (executed 2026-07-24)

Source: `docs/stage19/evidence/captured_results.json` (regenerate with `npm run stage19:evidence`).

### 3.1 Schema validation (Draft 2020-12 meta-schema + maximum instance)

All ten schemas: `metaSchemaPass === true` and `instancePass === true`.

### 3.2 Maximum-instance canonical UTF-8 byte measurements

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

### 3.3 Runtime peak fixture

| Field | Value |
|-------|------:|
| `catalogBytes` (measured) | 232,428 |
| `predictedBytes` | 39,970,187,116 |
| `measuredHeapDelta` | 1,720 |
| `pass` | `true` |

### 3.4 JCS conformance (8/8 PASS)

`duplicate-reject`, `number-1`, `number-negative-zero`, `utf16-order`, `control-escape`, `unicode-string`, `nested`, `unsupported-nan`.

### 3.5 Partition ownership (3/3 PASS)

`abandoned-allocation-discard`, `committed-ref-released`, `double-release-throws`.

### 3.6 Measured-conflict fixture

| Field | Value |
|-------|-------|
| `maxCrossPassHeadingDiffDeg` | 10 |
| Pair A mean / unit | +5° / `KA` |
| Pair B mean / unit | +20° / `KB` |
| `measuredConflictForGroup` | `true` |
| Empty-estimate input | `false` |

### 3.7 Recovery fixtures

| Fixture | Result |
|---------|--------|
| Active lease denies remote delete | PASS |
| Expired lease + newer fencing token allows delete | PASS |
| Recovery loop (`DELETE_STAGING` → `WRITE_CURRENT_POINTER` → `NO_OP`) | terminal `STABLE` |

### 3.8 Semantic fixtures (5/5 PASS)

`valid`, `invalidDuplicateMember`, `invalidPromotion`, `invalidSpan`, `invalidManifest`.

---

## 4. Resubmission invariants (evidence-backed)

These invariants are reported **only after** `npm run stage19:evidence` completes with exit code 0:

```
everyNormativeCalleeIsDefinedOrExactlyBound === true
allTenSchemasAreDelivered === true
everySchemaPassesDraft202012MetaSchemaValidation === true
maximumInstanceMeasurementsAreReproduced === true
runtimePeakMeasurementsAreReproduced === true
jcsConformanceResultsAreReproduced === true
semanticValidatorCoversEveryDeclaredRule === true
finalInvariantClaimsAreBackedByDeliveredEvidence === true
selfContainedClaimMatchesTheDeliveredArtifact === true
```

---

## 5. Final status

| Item | Status |
|------|--------|
| **Stage 19 specification** | **Pending final review** (Revision 35) |
| **Implementation** | **Not authorized** |
| **Approval** | **Not granted** |
| **Stages 15–18** | Approved and unchanged |
| **v11** | Frozen and unchanged |
| **Production lane counting** | Not implemented |
| **HD-map system** | Incomplete |
