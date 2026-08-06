# Current Status

**Last updated:** 2026-07-28  
**Classification key:** Each item is tagged — **VP** verified production, **FV** fixture-validated, **ES** experimental sensitivity, **UR** unsupported real-dataset behaviour, **PW** planned work.

---

## Summary Table

| Item | Value | Classification |
|------|-------|----------------|
| Frozen geometry baseline | `2026-07-24-fusion-v11` | **VP** (`lib/version.js`) |
| Stage 19 specification | Approved — Revision 37 | **VP** (implementation bound to `lib/stage19_spec/`, normative package `deliverables/stage19-revision37/`) |
| Stage 19 implementation | `2026-07-27-stage19-v5` | **FV** + **UR** (see below) |
| Stage 19 approval scope | Dataset-sensitivity auditing only | **VP** |
| Dataset-sensitivity investigation | Complete | **UR** (read-only analysis) |
| Investigation conclusion | **MATCHING AND FILTERING LOGIC IS THE PRIMARY CAUSE** | **UR** (`reports/stage19_dataset_sensitivity_investigation.json`) |
| Observations | 5,809 | **UR** |
| Singleton chains | 5,809 | **UR** |
| Multi-observation chains | 0 | **UR** |
| P3 eligible / executed / selected | 0 / 0 / 0 | **UR** |
| Median inter-observation displacement | ~32.98 m | **UR** |
| Approved static spatial cap | 12 m (`maxSpatialJumpM`) | **VP** (`lib/stage19_spec/config.js`) |
| Supported runs missing `temporalPassId` | 878 / 878 | **UR** |
| Supported runs missing `chunkId` | 878 / 878 | **UR** |
| Threshold correction approved | None | **VP** |
| Production lane counting | Disabled | **VP** |
| HD-map system | Incomplete | **VP** |
| Production deployment | Not authorized | **VP** |
| Stage 20 | Amendment A implemented; Amendment B spec approved for review | **FV** / **PW** |
| Stage 20 recommendation | Amendment A complete; B-MOTION manual evidence collection | **PW** |
| Amendment A (metadata) | **v3 implemented + audited** — 41/41 matrix; 878 v1 runs; not production-approved | **FV** |
| Amendment B | **Spec v1 approved for review** — evidence manifest 220 pairs; threshold blocked | **PW** |
| Earliest metadata propagation point | Stage 17B `flushRun()` | **VP** (implemented) |
| Next action | Manual B-MOTION pair review; corridor linkage for B-TRAV | **PW** |

---

## Verified Production Behaviour (**VP**)

### Frozen v11 geometry

- Processing version: `2026-07-24-fusion-v11` (`lib/version.js`)
- Full 92-segment geometry compare: 0 differences (`reports/stage19_v5_corrective_checkpoint_report.json` → `v11GeometryCompare`)
- Stage 19 implementation does **not** modify v11 geometry (`v11GeometryModified: false` in `audit_stage19_dataset_sensitivity.json`)

### Stage 19 normative constants (Rev 37)

From `lib/stage19_spec/config.js` (protected):

| Parameter | Value |
|-----------|-------|
| `maxSpatialJumpM` | 12 |
| `maxConsecutiveRouteSGapM` | 50 |
| `maxLocalHeadingDeltaDeg` | 30 |
| `maxLateralOffsetDeltaM` | 2 |

No threshold correction has been approved. Experimental overlays (25 m, 50 m, etc.) are **not** production thresholds — see [EXPERIMENTS.md](./EXPERIMENTS.md).

### Stage 19 implementation v5 — structural behaviour

Verified by **432/432** tests, **30/30** publication-repeat, evidence runner, and independent review (`reports/stage19_v5_corrective_checkpoint_report.json`):

- Publication lifecycle, fencing, path validation, API routes
- Partition matrix (overflow, rejected partitions, P3 through bundle, applyBranchSelection failures)
- Conflict bundle (same-pass, self-pair, repeated evidence, duplicate provenance)
- Post-immutable pre-pointer fencing trace (D3)
- Normative package verification (21/21 files match `deliverables/stage19-revision37/`)

v4 partial gaps closed in v5:

| Requirement | Status |
|-------------|--------|
| D1 — P3 through complete bundle | VERIFIED |
| D2 — same-pass repeated evidence full bundle | VERIFIED |
| D3 — fencing post-immutable pre-pointer trace | VERIFIED |
| D6 — genuine rejected non-overflow partition | VERIFIED |

### Published bundle state

| Field | Value | Source |
|-------|-------|--------|
| `current.json` runId | `2026-07-27-stage19-v5` | `stage19_bundle/current.json` |
| Catalog members | 5,809 | `audit_stage19_dataset_sensitivity.json` |
| Assessments | 5 × `insufficient_evidence` | same |
| Promotion decisions | 5 × `hold` | same |
| BEV PNG images | 5 | `reports/stage19_dataset_sensitivity.md` |
| Cross-pass conflicts | 0 (evidence unavailable) | same |

---

## Fixture-Validated Behaviour (**FV**)

These behaviours are verified on synthetic/fixture data and controlled overlays, not on successful real-dataset multi-observation chains:

- Multi-branch partition, P3 branch selection, and `applyBranchSelection` through `buildStage19Bundle`
- Rejected non-overflow partitions (`open_cap_exceeded` via `lib/stage19_partition_config_overlay.js`)
- Cross-pass conflict detection and quality-gate blocking on fixture evidence pairs
- Publication overlap, concurrent writers, stale token rejection
- BEV production audit schema on fixture images

---

## Experimental Sensitivity Results (**ES**)

Read-only overlays from `reports/stage19_dataset_sensitivity_investigation.json` → `experimentalSensitivity`. **Not approved for production.**

| Overlay | Multi-obs chains | Singleton chains |
|---------|-----------------|------------------|
| Baseline (12 m cap) | 0 | 5,809 |
| `spatial_jump_25m` | 0 | 5,809 |
| `spatial_jump_50m` | 7 | 5,793 |
| `combined_relaxed_geometry` | 7 | 5,793 |

Even at 50 m spatial cap, cross-pass candidates remain **0**. P3 selected remains **0** in all experimental rows.

---

## Unsupported Real-Dataset Behaviour (**UR**)

On the current real dataset with approved Rev 37 config:

- **All 5,809 observations form singleton chains** — zero multi-observation chains
- **573** Stage 17 multi-observation partition units produce **zero** static links under default config
- **81.4%** of per-observation first-failure reasons: `spatial_distance` (>12 m cap)
- Median consecutive spatial separation: **32.984 m** (threshold 12 m); median temporal separation: **~2.0 s**
- **878/878** supported runs lack explicit `temporalPassId` and `chunkId` → **zero** cross-pass candidates
- P3: **0/0/0** (eligible/executed/selected)
- Approved sensitivity table records baseline outcomes only (7 parameters, all deltas zero) — dataset lacks cross-pass and multi-obs chains for meaningful parameter sweeps

Upstream data exists: Stage 17 has **573** multi-observation tracks; Stage 16 projects **5,809** of **11,044** observations.

---

## Stage 20 Design Investigation (**PW** — draft, not approved)

Completed 2026-07-28 read-only investigation. Deliverables in `reports/stage20_*` and `deliverables/stage20-*`.

| Finding | Detail |
|---------|--------|
| Metadata drop point | Stage 17B supported-run fusion — boundary IDs on tracks, not on persisted runs |
| Motion-linking root cause | Raw 12 m euclidean cap vs ~33 m median displacement; route-s vs speed×Δt median residual ~1.0 m |
| 12 m as residual cap | Supported by data as hypothesis — **not approved** as production threshold |
| Architecture | Option 4 — separate Amendment A and B versioned layers; v5 bundle immutable |
| Ground-truth sample | 576 pairs rule-classified; video unavailable; precision/recall targets deferred |

**Not changed:** Rev 37, v5 implementation, v5 bundle, `current.json`, frozen v11, production code.

## Planned Work (**PW**)

- **Amendment A:** v3 implemented and audited — checkpoint `checkpoints/stage20-amendment-a-implementation-2026-07-28.json`; acceptance audit `deliverables/stage20-amendment-a-acceptance-audit.md`; not production-approved
- **Amendment B:** specification v1 **approved for review** — manual evidence collection manifest (220 pairs); `RESIDUAL_CAP_M` not approved
- **Terminology:** `reports/stage20_link_ground_truth_sample.json` is a **rule-derived candidate sample**, not manual ground truth — see `reports/stage20_link_candidate_pair_sample_v1.terminology.md`

---

## Specification Note

Project status treats **Revision 37** as the approved normative specification for Stage 19 implementation. The header in `docs/stage19_revision37_specification.md` still contains a legacy banner ("Specification pending final review"); that file is protected and was not modified. Implementation is bound to `deliverables/stage19-revision37/lib/stage19_spec/` per `lib/stage19_normative_verify.js`.

---

## Validation Snapshot (v5)

| Check | Result |
|-------|--------|
| `npm test` | 432 pass, 0 fail, 0 skipped |
| Publication repeat | 30/30 |
| `npm run stage19:evidence` | exit 0 |
| `node scripts/stage19_independent_review.js` | exit 0 |
| v11 geometry compare (92 segments) | 0 differences |
| Protected files | 28/28 unchanged (only `lib/stage19_version.js` intentionally bumped) |

Source: `reports/stage19_v5_corrective_checkpoint_report.json`

---

## Ongoing Documentation Rule

After every meaningful task, update: `DEVELOPMENT_LOG.md`, this file, `DECISIONS.md`, `EXPERIMENTS.md`, `KNOWN_ISSUES.md`, `RUN_GUIDE.md` as applicable. Never promote experimental or planned items to verified production status.
