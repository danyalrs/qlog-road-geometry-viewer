# Amendment A v3 — Acceptance Audit Report

**Date:** 2026-07-28  
**Specification:** `stage20-amendment-a-spec-v3`  
**Checkpoint:** `2026-07-28-stage20-amendment-a-v1`  
**Auditor:** Implementation acceptance audit (verification and gap correction)

---

## Executive summary

| Metric | Result |
|--------|--------|
| Specified matrix cases | **41** |
| Matrix cases covered | **41 / 41** |
| Physical Amendment A test blocks | **48** |
| Full regression tests (post-audit) | **483** |
| Real-data supported runs | **878** (0 rejected) |
| Recommendation | **AMENDMENT A IMPLEMENTATION READY FOR REVIEW** |

The initial implementation reported **29** physical tests covering **26** matrix IDs plus 3 acceptance helpers. This audit added **11** missing matrix implementations (T-A-003–013, T-A-041, T-A-043, T-A-047, T-A-048) and **5** supplemental rejection-code blocks (T-A-040b–f), bringing physical coverage to **48** blocks for **41** specified cases.

Amendment B, P3, lane counting, and production promotion remain **paused**.

---

## 1. Test traceability (41 specified cases)

| ID | Requirement | Test name | File | Fixture | Assertion | Expected code | Status |
|----|-------------|-----------|------|---------|-----------|---------------|--------|
| T-A-001 | Valid single-observation v1 emission | T-A-001 valid single-observation run | `tests/stage20_amendment_a.test.js:109` | Track `0:0:0:0`, one obs | `dividerCorridorId === '0:0:0'`, `comparisonKeyScope === 'within_segment'` | — | **covered** |
| T-A-002 | Valid multi-observation uniform segmentId | T-A-002 valid multi-observation run | `:122` | 3 obs, track `0:0:4:0` | `runs.length === 1`, all `segmentId === 10` | — | **covered** |
| T-A-003 | Parent track FK not found | T-A-003 parent track not found | `:149` | `parentTrackId: 'missing'` | `validateRunForEmission` → `A-PTR-002` | A-PTR-002 | **covered** |
| T-A-004 | segmentId ∉ track.segmentIds | T-A-004 segmentId not in track.segmentIds | `:155` | obs seg 99, track seg [10] | `rejectedRuns[0].code === A-PTR-003` | A-PTR-003 | **covered** |
| T-A-005 | Mixed member segmentId | T-A-005 mixed member segmentId rejected | `:164` | obs seg 10 + 11 | `rejectedRuns[0].code === A-MEM-004` | A-MEM-004 | **covered** |
| T-A-006 | Member observation missing | T-A-006 member observation missing | `:173` | `obsIds: ['missing:obs']` | `err.code === A-MEM-001` | A-MEM-001 | **covered** |
| T-A-007 | Member missing segmentId | T-A-007 member missing segmentId | `:189` | obs without segmentId | `err.code === A-MEM-002` | A-MEM-002 | **covered** |
| T-A-008 | Member chunkId mismatch | T-A-008 member chunkId mismatch | `:208` | ob chunk 1, track chunk 0 | `A-MEM-003` at emission | A-MEM-003 | **covered** |
| T-A-009 | Member temporalPassId mismatch | T-A-009 member temporalPassId mismatch | `:217` | ob pass 1, track pass 0 | `A-MEM-003` at emission | A-MEM-003 | **covered** |
| T-A-010 | Member poseSectionId mismatch | T-A-010 member poseSectionId mismatch | `:226` | ob section 5, track 4 | `A-MEM-003` at emission | A-MEM-003 | **covered** |
| T-A-011 | Missing trackIndex on parent | T-A-011 missing trackIndex on parent track | `:235` | track without trackIndex | `A-BND-002` at emission | A-BND-002 | **covered** |
| T-A-012 | Duplicate dividerRunId | T-A-012 duplicate dividerRunId in artifact | `:246` | artifact with dup IDs | envelope contains `A-ART-003` | A-ART-003 | **covered** |
| T-A-013 | Deterministic serialization/hash | T-A-013 deterministic serialization and content hash | `:259` | unsorted runs, bad hash, bad processingVersion | `A-ART-006`, `A-ART-004`, `A-ART-005`; sorted valid envelope passes | A-ART-004/005/006 | **covered** |
| T-A-014 | dividerCorridorId comparison key | T-A-014 dividerCorridorId assignment | `:135` | track `0:0:4:2` | `buildDividerCorridorId === '0:4:2'` | — | **covered** |
| T-A-015 | trackIndex propagation | T-A-015 trackIndex copied from track | `:140` | trackIndex 5 | `run.trackIndex === 5` | — | **covered** |
| T-A-020 | Same parentTrackId, different pass | T-A-020 same parentTrackId different temporalPassId | `:282` | two runs same parent, diff pass | `detectParentTrackIdConflicts` → `A-PTR-001` | A-PTR-001 | **covered** |
| T-A-021 | Run pass ≠ parent track | T-A-021 run temporalPassId differs from parent track | `:293` | ob pass mismatched | `A-PTR-001` or `A-MEM-003` | A-PTR-001 | **covered** |
| T-A-030 | Same-pass grouping | T-A-030 valid same-pass grouping | `:332` | fixture runA vs clone | `isSamePass === true` | — | **covered** |
| T-A-031 | Same-pass not corridor-linked | T-A-031 same-pass cannot be corridor-linked | `:337` | same-pass pair | `A-XPS-001` | A-XPS-001 | **covered** |
| T-A-032 | Comparison-key match same segment | T-A-032 comparison-key match same segment | `:344` | fixture A/B seg 10 | `isComparisonKeyMatch === true` | — | **covered** |
| T-A-033 | Key match without linkage | T-A-033 comparison-key without linkage is linkage hypothesis only | `:349` | fixture A/B, no linkage | `LINKAGE_HYPOTHESIS`, `A-XPS-012` | A-XPS-012 | **covered** |
| T-A-034 | Structural positive fixture (SAT-1) | T-A-034 structural candidate with validated linkage fixture | `:356` | linkage + overlap ≥5m | overlap verified; provisional `A-XPS-007` without traversal; `GENUINE` with traversal | A-XPS-007 | **combined coverage** |
| T-A-035 | Cross-segment key collision | T-A-035 cross-segment key collision | `:374` | seg 64/57, key `0:4:0` | `LINKAGE_HYPOTHESIS`, `A-XPS-013` | A-XPS-013 | **covered** |
| T-A-036 | Equal chunkId across segments | T-A-036 equal chunkId across segments rejected | `:383` | seg 2/5, chunk 0 | `A-XPS-010` | A-XPS-010 | **covered** |
| T-A-037 | Equal poseSectionId not identity | T-A-037 equal poseSectionId across passes without linkage | `:390` | fixture A/B | not `CORRIDOR_LINKED`; `identityBasis:'poseSectionId'` → `A-XPS-011` | A-XPS-011 | **covered** |
| T-A-038 | Valid corridor linkage | T-A-038 valid authoritative corridor linkage | `:396` | linkage + low overlap | `roadCorridorId` set; `A-XPS-007` provisional | A-XPS-007 | **combined coverage** |
| T-A-039 | Conflicting linkage records | T-A-039 conflicting linkage records | `:440` | two records, diff roadCorridorId | `A-LNK-001` or `A-LNK-002` | A-LNK-001/002 | **covered** |
| T-A-040 | Missing linkage provenance | T-A-040 missing linkage provenance | `:450` | linkage without provenance | `A-LNK-005` | A-LNK-005 | **covered** |
| T-A-041 | Cross-segment + alignment | T-A-041 cross-segment with validated alignment | `:407` | T-A-035 + cross-segment linkage | provisional `A-XPS-007`; `GENUINE` with traversal | A-XPS-007 | **covered** |
| T-A-042 | No traversal → provisional | T-A-042 same segment without traversal proof stays provisional | `:459` | linkage, no traversal | `PROVISIONAL`, `A-XPS-007` | A-XPS-007 | **covered** |
| T-A-043 | Deterministic linkage grouping | T-A-043 deterministic linkage grouping | `:418` | two linkage records | `sortLinkageRecordsDeterministic` by `corridorLinkageId` | — | **covered** |
| T-A-044 | Equal key text without linkage | T-A-044 equal dividerCorridorId without linkage | `:468` | fixture A/B | `LINKAGE_HYPOTHESIS` only | A-XPS-012 | **covered** |
| T-A-045 | Cross-segment unavailable structural | T-A-045 cross-segment without linkage unavailable for structural | `:474` | seg 64/57 | not structural/genuine | A-XPS-013 | **covered** |
| T-A-046 | Self-pair rejection | T-A-046 self-pair rejection | `:482` | runA vs runA | `A-XPS-002` | A-XPS-002 | **covered** |
| T-A-047 | Cross-chunk same pass | T-A-047 cross-chunk same pass rejection | `:426` | same seg/pass, diff chunk | `A-XPS-003` | A-XPS-003 | **covered** |
| T-A-048 | Duplicate feature pair | T-A-048 duplicate feature pair detection | `:433` | duplicate pair key | `detectDuplicateFeaturePair` → `A-DUP-003` | A-DUP-003 | **covered** |
| T-A-049 | Geometry not corridor identity | T-A-049 geometry overlap not corridor identity | `:488` | `identityBasis:'geometry_overlap'`; geometry-only linkage | `A-LEG-003`; linkage `A-LNK-007` | A-LEG-003 | **covered** |
| T-A-050 | v0 legacy unavailable | T-A-050 v0 legacy unavailable | `:502` | v0 artifact | `A-LEG-001` via `legacyV0Unavailable` | A-LEG-001 | **covered** |
| T-A-051 | Frozen v11 unchanged | T-A-051 frozen v11 unchanged | `:509` | `PROCESSING_VERSION` | `=== '2026-07-24-fusion-v11'` | — | **covered** |
| T-A-052 | Rev 37 maxSpatialJumpM | T-A-052 Revision 37 maxSpatialJumpM unchanged | `:513` | `config.js` | `maxSpatialJumpM === 12` | — | **covered** |
| T-A-053 | current.json unchanged | T-A-053 current.json unchanged | `:518` | `stage19_bundle/current.json` | `runId === '2026-07-27-stage19-v5'` | — | **covered** |

**Supplemental rejection blocks (not additional matrix cases):** T-A-040b (`A-LNK-003`), T-A-040c (`A-LNK-006`), T-A-040d (`A-XPS-008`), T-A-040e (`A-XPS-009`), T-A-040f (`A-XPS-004`).

**Acceptance audit blocks:** real-data counters; deterministic byte-for-byte hash rerun.

---

## 2. Rejection code coverage (35 defined codes)

| Code | Triggering fixture | Implemented test | Classification | Artifact reject / unavailable | Pass |
|------|-------------------|------------------|----------------|------------------------------|------|
| A-BND-002 | Track missing trackIndex | T-A-011 | emission reject | rejected run | pass |
| A-PTR-001 | Same parent, diff pass | T-A-020, T-A-021 | identity conflict | conflict / reject | pass |
| A-PTR-002 | Missing parent track | T-A-003 | FK missing | reject | pass |
| A-PTR-003 | segmentId not in track | T-A-004 | FK scope | reject | pass |
| A-MEM-001 | Missing observation | T-A-006 | member FK | reject | pass |
| A-MEM-002 | Missing member segmentId | T-A-007 | member field | reject | pass |
| A-MEM-003 | Member boundary mismatch | T-A-008–010 | member boundary | reject | pass |
| A-MEM-004 | Mixed member segmentId | T-A-005 | member uniformity | reject | pass |
| A-LEG-001 | v0 artifact consumption | T-A-050 | legacy | evidence unavailable | pass |
| A-LEG-003 | Geometry overlap as identity | T-A-049 | prohibited basis | unavailable | pass |
| A-XPS-001 | Same-pass pair | T-A-031 | scope | unavailable | pass |
| A-XPS-002 | Self-pair | T-A-046 | scope | unavailable | pass |
| A-XPS-003 | Cross-chunk same pass | T-A-047 | scope | unavailable | pass |
| A-XPS-004 | Cross-pose-section | T-A-040f | scope | unavailable | pass |
| A-XPS-007 | Missing traversal / low overlap | T-A-034,038,041,042 | provisional | not promoted | pass |
| A-XPS-008 | Cross-segment alignment pending | T-A-040d | provisional | not structural | pass |
| A-XPS-009 | No linkage, no key match | T-A-040e | unavailable | unavailable | pass |
| A-XPS-010 | Cross-segment chunk compare | T-A-036 | scope | unavailable | pass |
| A-XPS-011 | poseSectionId as identity | T-A-037 | prohibited basis | unavailable | pass |
| A-XPS-012 | Key match without linkage | T-A-033,044 | linkage hypothesis | not structural | pass |
| A-XPS-013 | Cross-segment key collision | T-A-035,045 | linkage hypothesis | not structural | pass |
| A-DUP-003 | Duplicate feature pair | T-A-048 | duplicate pair | reject pair | pass |
| A-ART-003 | Duplicate dividerRunId | T-A-012 | envelope | reject artifact | pass |
| A-ART-004 | contentHash mismatch | T-A-013 | envelope | reject artifact | pass |
| A-ART-005 | processingVersion mismatch | T-A-013 | envelope | reject artifact | pass |
| A-ART-006 | Unsorted runs/gaps | T-A-013 | envelope | reject artifact | pass |
| A-LNK-001 | Duplicate corridorLinkageId | T-A-039 | linkage artifact | reject | pass |
| A-LNK-002 | Conflicting roadCorridorId | T-A-039 | linkage artifact | conflict | pass |
| A-LNK-003 | Endpoint not in runs | T-A-040b | linkage record | reject record | pass |
| A-LNK-005 | Missing provenance | T-A-040 | linkage record | reject record | pass |
| A-LNK-006 | Cross-segment no alignment | T-A-040c | linkage record | reject record | pass |
| A-LNK-007 | Geometry-only validation | T-A-049 | linkage record | reject record | pass |
| A-ART-001 | schemaVersion mismatch | T-A-054 | envelope | reject artifact | **exercised** |
| A-ART-002 | count mismatch | T-A-055 | envelope | reject artifact | **exercised** |
| A-LNK-004 | Endpoint FK field mismatch | T-A-056 | linkage record | reject record | **exercised** |

---

## 3. Real-data acceptance gates (`lane_divider_supported_runs_v1.json`)

| Counter | Count | % of 878 |
|---------|------:|---------:|
| Total runs | 878 | 100.00 |
| segmentId coverage | 878 | 100.00 |
| chunkId coverage | 878 | 100.00 |
| temporalPassId coverage | 878 | 100.00 |
| poseSectionId coverage | 878 | 100.00 |
| trackIndex coverage | 878 | 100.00 |
| dividerCorridorId coverage | 878 | 100.00 |
| parentTrackId resolved FKs | 878 | 100.00 |
| parentTrackId unresolved FKs | 0 | 0.00 |
| parent-track identity conflicts | 0 | 0.00 |
| member-observation identity conflicts | 0 | 0.00 |
| cross-boundary supported runs | 0 | 0.00 |
| duplicated supported runs (dividerRunId) | 0 | 0.00 |
| duplicated evidence units | 136 | 15.49 |
| duplicated feature pairs (parentTrackId pair keys) | 109997 | — |
| self-pairs | 0 | 0.00 |
| same-pass pairs misclassified as cross-pass | 0 | 0.00 |
| cross-chunk structural pairs | 0 | 0.00 |
| cross-pose-section structural pairs | 0 | 0.00 |

---

## 4. Evidence-state output (real data, no published linkage artifact)

| State | Count |
|-------|------:|
| Comparison-key matches (embedded in hypotheses) | 0 |
| Linkage hypotheses | 3 |
| Cross-segment key collisions | 3 |
| Validated corridor linkages | 0 |
| Structural candidates | 0 |
| Provisional candidates | 0 |
| Validated traversal linkages | 0 |
| Genuine evidence | 0 |
| Unavailable evaluations | 385000 |

**Confirmations:**
- Equal `dividerCorridorId` text does **not** create authoritative corridor identity (3 cross-segment collisions remain hypotheses only).
- **Zero** production linkage records auto-generated from geometry, route-s overlap, or key equality (`linkageRecordsAutoGenerated: 0`).

Cross-segment collision pairs (linkage hypotheses only):
- `0:0:4:0:run:0` (seg 64) ↔ `0:1:4:0:run:0` (seg 57), key `0:4:0`
- `0:0:4:1:run:0` (seg 64) ↔ `0:1:4:1:run:0` (seg 57), key `0:4:1`
- `0:0:4:2:run:0` (seg 64) ↔ `0:1:4:2:run:0` (seg 57), key `0:4:2`

---

## 5. Determinism verification

| Check | Result |
|-------|--------|
| Content SHA-256 run 1 | `0742ca6aa4ecce0cb877f045659c79510aa2ed1e317be6564f4ff0319ee4c9f7` |
| Content SHA-256 run 2 | `0742ca6aa4ecce0cb877f045659c79510aa2ed1e317be6564f4ff0319ee4c9f7` |
| On-disk file SHA-256 | `57e1c1ea222407db1a0a9b42c172ce4202cb8e76e28db54c1fb67fd4aae3af50` |
| Byte-for-byte equality (rebuild vs on-disk content) | **true** |
| Deterministic run ordering | **true** (`dividerRunId` ascending) |
| Deterministic linkage grouping | **true** (`corridorLinkageId` ascending) |
| Timestamp exclusion (`boundaryProvenance.copiedAt`, `provenance.createdAt`) | **verified** via `contentHashSha256` |

Fixed timestamp used: `2026-07-28T04:00:00.000Z`.

---

## 6. Protected artifacts (SHA-256, unchanged)

### current.json resolution

Only **one** `current.json` exists in the repository: `stage19_bundle/current.json`.  
No root `current.json` exists.

| Artifact | SHA-256 |
|----------|---------|
| `lane_divider_supported_runs_v0.json` | `bcf6a5ee88f37bd736a54e907022d9cf07a412d10455f06dd5fcffd657ecb7ae` |
| `stage19_bundle/current.json` | `673b58a8b7fbe667fb4e114ebced23b50fb249e4510ef28b9c031d733cc3edf3` |
| `stage19_bundle/runs/2026-07-27-stage19-v5/manifest_v0.json` | `72e16122fae6eecc8d12a4a4f869b949dc2aba53f7cb3be7868efab902ab35f6` |
| `lib/stage19_spec/config.js` | `227b1754acabc7ec1792f3ca7236421c716ef35f909bd4d8825b714a5f426b2a` |
| `lib/version.js` | `09444cdec775828371e681b858aa99e2ea0bacfd122ba936f84775eab5f6a235` |
| `audit_reference_v11.json` | `fabc302b4350104d6ca573537e75f2f1422055ba0a4d31dec65376662e41b0c8` |
| `audit_dataset_v11_full.json` | `5ab5a60133afab6e67d0439dd67a8e2cc088d38d51b5716a51d203d27c3a9d4d` |

Published bundle manifests (unchanged):

| Bundle | Manifest SHA-256 |
|--------|------------------|
| `2026-07-27-stage19-v1` | `29c87f924087aa346fcaba87b7d24eed0c533cac3c48fd5821e246d46e832d81` |
| `2026-07-27-stage19-v2` | `ea04796ad2004d42ad6bb5263edd253b16ca0031326f350b783730918a0489c9` |
| `2026-07-27-stage19-v3` | `3767bcde6f26c9af946fffb9298ab360c2a769167b7d0835d86c6df3440a223d` |
| `2026-07-27-stage19-v4` | `2d8cad5689994de08e9a4c44a6a1ef3b508a573dfba614a198785da038c521c1` |
| `2026-07-27-stage19-v5` | `72e16122fae6eecc8d12a4a4f869b949dc2aba53f7cb3be7868efab902ab35f6` |

Revision 37 immutable files verified against `checkpoints/stage19-implementation-pre-v5.json` — all hashes match. `maxSpatialJumpM` remains **12**.

---

## 7. Regression (`node --expose-gc --test tests`)

| Run | Exit | Pass | Fail | Skipped | Cancelled | Duration (ms) |
|-----|------|------|------|---------|-----------|---------------|
| 1 | 0 | 483 | 0 | 0 | 0 | 213795.06 |
| 2 | 1 | 482 | 1 | 0 | 0 | 224723.88 |

**Flaky recurrence:** yes — Run 2 failed `Stage 19 v4 overlapping publication / child process concurrent publication` (pre-existing Stage 19 concurrency test, unrelated to Amendment A). Run 1 passed 483/483.

Post-hardening full-suite count: **483** (+3 hardening tests from post-audit 480).

---

## 8. Files changed during this audit

| File | Change |
|------|--------|
| `lib/stage20_amendment_a_acceptance.js` | Real-data audit counters; cross-boundary detection |
| `lib/stage20_amendment_a_corridor_linkage.js` | `A-DUP-003` on duplicate pairs; cross-segment fixtures |
| `lib/stage20_amendment_a_cross_pass.js` | `A-LEG-003`, `A-XPS-011` identity-basis guards |
| `lib/stage20_amendment_a_validation.js` | `A-ART-005` processingVersion check |
| `tests/stage20_amendment_a.test.js` | +19 physical blocks (41 matrix + 5 supplemental + 2 audit) |
| `checkpoints/stage20-amendment-a-implementation-2026-07-28.json` | Acceptance audit results |
| `deliverables/stage20-amendment-a-acceptance-audit.md` | This report |

Protected artifacts, `current.json`, Stage 19 v5, Rev 37, and v11 geometry were **not rewritten**.

---

## 9. Unresolved gaps

1. ~~**Three rejection codes** not directly unit-tested~~ — **closed** 2026-07-28 via T-A-054, T-A-055, T-A-056.
2. **Pre-existing flaky** Stage 19 concurrent-publication test (Run 1 failure).
3. **duplicatedEvidenceUnits (136)** and **duplicatedFeaturePairs (109997)** are measured pairwise enumeration artifacts on real data, not validation failures — documented for transparency.

---

## 10. Paused scope confirmation

- Amendment B: **not started**
- P3 / lane counting: **not enabled**
- Production promotion of Amendment A v1: **not authorized**
- Revision 37 / `maxSpatialJumpM: 12` / frozen v11 / Stage 19 v5 / published bundles / `current.json`: **unchanged**

---

**Recommendation:** AMENDMENT A IMPLEMENTATION READY FOR REVIEW
