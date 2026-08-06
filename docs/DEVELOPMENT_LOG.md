# Development Log

**Last updated:** 2026-07-28

Chronological record of confirmed work. Entries cite checkpoints, reports, audits, or source where possible. Failed or superseded work is recorded as such.

**Update rule:** Append a dated entry after every meaningful implementation, investigation, experiment, validation, or specification task. Preserve all prior history.

---

## 2026-07-23 — Stages 1–5 baseline investigation

| Field | Detail |
|-------|--------|
| **Objective** | Establish qlog processing architecture and baseline validation |
| **Work** | Dataset inventory, decoder verification, initial fusion pipeline |
| **Components** | `lib/qlog_decoder.js`, `extract_modelv2.js`, `extract_gps.js`, `dataset_audit.js` |
| **Baseline version** | `2026-07-23-validate-v6b` |
| **Status** | Superseded by v11 fusion |
| **Evidence** | `checkpoints/admiral-investigation-2026-07-23.md` § Original investigation |

---

## 2026-07-23 / 2026-07-24 — Stage 6–7: movement state and pose continuity

| Field | Detail |
|-------|--------|
| **Objective** | Movement-aware pass detection; pose continuity gating |
| **Work** | Stage 6 movement state (`2026-07-24-pose-v7`); Stage 7 pose continuity v8 |
| **Components** | `lib/movement_state.js`, `lib/pose_continuity.js` |
| **Results** | 92-segment audits; 17 segments with pass-count decreases (all decreases) |
| **Worked** | Movement-state regression isolated via `--movement-only` |
| **Status** | Approved; feeds Stage 8–9 |
| **Evidence** | `checkpoints/admiral-investigation-2026-07-23.md` § Stage 6–7 |

---

## 2026-07-23 / 2026-07-24 — Stage 8–9: pass separation and pose sections

| Field | Detail |
|-------|--------|
| **Objective** | Multi-pass route splitting; discontinuous pose rejection |
| **Work** | Multi-factor pass suppression (v9); pose-section fragmentation fix (`lib/pose_continuity.js` v10) |
| **Results** | Stage 8 gate approved 2026-07-24; Stage 9 gate approved 2026-07-24 |
| **Did not work** | v7→v8 regression increased zero-polygon segments (+12 net) — root-caused and fixed in v10 |
| **Evidence** | `checkpoints/admiral-investigation-2026-07-23.md` § Stage 8–9 |

---

## 2026-07-23 / 2026-07-24 — Stage 10–11: fusion v11 and fragment quality

| Field | Detail |
|-------|--------|
| **Objective** | Tune interpolation span; validate polygon fragment quality |
| **Work** | `maxInterpolationSpanM` default in `lib/process_route.js`; full v10→v11 comparison (92 segments) |
| **Version frozen** | `2026-07-24-fusion-v11` |
| **Results** | Stage 10 gate approved; Stage 11 gate approved 2026-07-24; 540 accepted fragments across chunks |
| **Components** | `lib/process_route.js`, `lib/fusion.js`, `lib/version.js` |
| **Evidence** | `checkpoints/admiral-investigation-2026-07-23.md` § Stage 10–11 |

---

## 2026-07-24 — Stages 12–14: BEV evidence, diagnostics, delivery readiness

| Field | Detail |
|-------|--------|
| **Objective** | Evidence consistency, zero-polygon diagnostics, delivery consolidation |
| **Work** | Stage 12A BEV approved; Stage 12B blocked (camera imagery); Stage 13/13A/14 approved |
| **Tests** | 171/171 at Stage 14 gate |
| **Limitation** | HD-map not complete; camera validation blocked |
| **Components** | `lib/stage14_delivery_readiness.js`, `reports/stage12a_*`, `audit_stage13a_fusion_trace.json` |
| **Evidence** | `checkpoints/admiral-investigation-2026-07-23.md` § Stage 12–14 |

---

## 2026-07-23 / 2026-07-24 — Stages 15–18: lane-counting pipeline (design through prototype)

| Field | Detail |
|-------|--------|
| **Objective** | Lane-divider evidence assessment and prototype interval counting |
| **Work** | Stage 15 design; Stage 16 projection; Stage 17 tracking; Stage 18 interval assessment |
| **Versions** | `2026-07-24-lane-projection-v0`, `2026-07-24-lane-divider-tracking-v0`, `2026-07-24-lane-interval-assessment-v0` |
| **Results** | Stage 16: 11,044 total observations → 5,809 projected; Stage 17: 742 tracks (573 multi-obs); Stage 18: 5 intervals |
| **Decision** | Production lane counting **not implemented** |
| **Components** | `lib/stage15_lane_counting_design.js`, `lib/stage17_divider_association.js`, `lib/stage18_lane_interval_audit.js` |
| **Evidence** | `reports/stage16_projected_lane_observations.md`, `checkpoints/admiral-investigation-2026-07-23.md` § Stage 15–18 |

---

## 2026-07-27T04:55Z — Stage 19 pre-v0 checkpoint

| Field | Detail |
|-------|--------|
| **Objective** | Rollback reference before Stage 19 production integration |
| **Checkpoint** | `checkpoints/stage19-implementation-pre-v0.json` |
| **Status** | Preservation only; v0 never published as immutable run |

---

## 2026-07-27 — Stage 19 v0–v1: initial production integration

| Field | Detail |
|-------|--------|
| **Objective** | Integrate Rev 37 normative spec into production wiring |
| **Work** | Bundle builder, partition production, publication, server API, webpage panel |
| **Checkpoints** | v1 immutable run at `stage19_bundle/runs/2026-07-27-stage19-v1` |
| **Normative package** | `deliverables/stage19-revision37/` |
| **Status** | Superseded; not approved for production |
| **Evidence** | `lib/stage19_version.js` → `STAGE19_CHECKPOINT_PRESERVATION` |

---

## 2026-07-27T06:16Z — Stage 19 v2 corrective checkpoint

| Field | Detail |
|-------|--------|
| **Objective** | Close validation gaps from v1 |
| **Checkpoint** | `2026-07-27-stage19-v2` |
| **Work** | Path validation, partition/conflict matrix expansion, protected hash verification |
| **Status** | Superseded by v3 |
| **Evidence** | `checkpoints/stage19-implementation-2026-07-27-stage19-v2.json` |

---

## 2026-07-27T07:30Z — Stage 19 v3 corrective checkpoint

| Field | Detail |
|-------|--------|
| **Objective** | Publication overlap, HTTP path validation, conflict matrix on real bundle |
| **Report** | `reports/stage19_v3_corrective_checkpoint_report.json` |
| **Work** | `lib/stage19_path_validation.js`; 11/11 HTTP traversal tests |
| **Real data preserved** | 5,809 singleton chains, 0 multi-obs, P3 0/0/0 |
| **Status** | Superseded by v4 |
| **Evidence** | `reports/stage19_v3_corrective_checkpoint_report.json` |

---

## 2026-07-27T08:15Z — Stage 19 v4 corrective checkpoint

| Field | Detail |
|-------|--------|
| **Objective** | Publication lifecycle fix, fencing, partition/conflict matrix completion |
| **Report** | `reports/stage19_v4_corrective_checkpoint_report.json` |
| **Work** | `lib/stage19_publication_fs.js`, fencing in `lib/stage19_publication_production.js`, `server.js`, `public/app.js` |
| **Tests** | Partition matrix 17 cases; conflict matrix 12 cases; overlap 11 cases |
| **Validation** | 30/30 publication repeat (`reports/stage19_rerun_repeat_v4.json`) |
| **Gaps remaining** | D1, D2, D3, D6 partially verified — not approved |
| **Status** | Superseded by v5 |
| **Evidence** | `reports/stage19_v4_corrective_checkpoint_report.json` |

---

## 2026-07-27T09:10Z — Stage 19 v5 corrective checkpoint

| Field | Detail |
|-------|--------|
| **Objective** | Close v4 partial gaps D1, D2, D3, D6 |
| **Report** | `reports/stage19_v5_corrective_checkpoint_report.json` |
| **Work performed** | |
| | — `lib/stage19_partition_config_overlay.js` (fixture overlay) |
| | — `open_cap_exceeded` / `partition_rejected` in partition production |
| | — P3 through complete bundle path; rejected partition → failed assessment |
| | — `p3_not_invoked` quality gate fix for successful multi-obs chains |
| | — Fencing post-immutable pre-pointer trace test |
| **Tests** | 432/432 pass; 30/30 publication repeat |
| **Protected files** | 28/28 unchanged |
| **Bundle** | `stage19_bundle/runs/2026-07-27-stage19-v5`, `current.json` → v5 |
| **Approval** | **APPROVE STAGE 19 IMPLEMENTATION FOR DATASET-SENSITIVITY AUDITING** (independent validation) |
| **Not approved** | Production deployment, lane counting, threshold changes |
| **Next action** | Dataset-sensitivity investigation |
| **Evidence** | `reports/stage19_v5_corrective_checkpoint_report.json`, `checkpoints/stage19-implementation-2026-07-27-stage19-v5.json` |

---

## 2026-07-28T02:20Z — Dataset-sensitivity investigation (read-only)

| Field | Detail |
|-------|--------|
| **Objective** | Explain 5,809 singleton chains, zero cross-pass, P3 0/0/0 on real dataset |
| **Mode** | Read-only — no production, bundle, or config changes |
| **Runner** | `reports/stage19_dataset_sensitivity_investigation_runner.js` |
| **Key findings** | |
| | — 573 multi-obs partition units; 0 static links under default config |
| | — 81.39% first-failure: `spatial_distance` (>12 m) |
| | — Median spatial separation 32.984 m vs 12 m cap |
| | — 878/878 supported runs missing `temporalPassId` and `chunkId` |
| | — Experimental 50 m overlay: 7 multi-obs chains (not approved) |
| **Conclusion** | **MATCHING AND FILTERING LOGIC IS THE PRIMARY CAUSE** |
| **Did not authorize** | Threshold tuning or metadata fixes |
| **Artifacts** | `reports/stage19_dataset_sensitivity_investigation.json`, `.md` |
| **Next action** | Stage 20 read-only design and specification investigation |
| **Evidence** | `reports/stage19_dataset_sensitivity_investigation.json` |

---

## 2026-07-28 — Living documentation created

| Field | Detail |
|-------|--------|
| **Objective** | Establish continuously maintained project documentation |
| **Work** | Created `docs/PROJECT_OVERVIEW.md`, `CURRENT_STATUS.md`, `DEVELOPMENT_LOG.md`, `DECISIONS.md`, `EXPERIMENTS.md`, `KNOWN_ISSUES.md`, `RUN_GUIDE.md` |
| **Sources** | Checkpoints, reports, audits, specifications, source modules, investigation artifacts |
| **Boundaries** | Documentation only; no code, spec, test, report, checkpoint, or bundle changes |
| **Next action** | Stage 20 read-only design investigation |

---

## 2026-07-28 — Stage 20 design and specification investigation (read-only)

| Field | Detail |
|-------|--------|
| **Objective** | Design corrections for (1) missing pass/chunk/pose metadata and (2) motion-incompatible 12 m spatial cap — investigated independently |
| **Mode** | Read-only — no production, spec, bundle, checkpoint, or `current.json` changes |
| **Runner** | `reports/stage20_design_investigation_runner.js` |
| **Metadata findings** | Boundary IDs dropped at Stage 17B `flushRun()`; 878/878 runs missing `temporalPassId`/`chunkId`; earliest propagation point = supported-run creation |
| **Linking findings** | 5010 consecutive pairs; median spatial 32.98 m; median \|routeS − speed×Δt\| ≈ 1.0 m; 12 m better as residual cap hypothesis (not approved) |
| **Approaches evaluated** | A–H on 5010 pairs; Rev37 = 0 links; pose residual (H) = 9 links boundary-filtered; 50 m experimental = 17 (not approved) |
| **Architecture** | Option 4 recommended — separate Amendment A and B versioned layers |
| **Deliverables** | `reports/stage20_design_investigation.json`, `.md`, `stage20_metadata_provenance.md`, `stage20_link_ground_truth_sample.json`; `deliverables/stage20-amendment-a-draft.md`, `stage20-amendment-b-draft.md`, `stage20-draft-specification.md` |
| **Tests** | `npm test` 432/432 pass (unchanged) |
| **Recommendation** | **PROCEED WITH METADATA PROPAGATION SPECIFICATION FIRST** |
| **Did not authorize** | Implementation, threshold correction, bundle publication, Amendment A/B approval |
| **Next action** | Amendment A specification review; expand ground-truth sample for Amendment B |
| **Evidence** | `reports/stage20_design_investigation.json` |

---

## 2026-07-28 — Amendment A specification (metadata propagation)

| Field | Detail |
|-------|--------|
| **Objective** | Convert Amendment A draft into approval-ready specification for boundary metadata on Stage 17B supported runs |
| **Mode** | Specification only — no implementation |
| **Normative propagation point** | `flushRun()` in `lib/stage17_supported_run_fusion.js` |
| **New artifact** | `lane_divider_supported_runs_v1.json` schema `2026-07-28-lane-divider-supported-runs-v1` |
| **Deliverables** | `deliverables/stage20-amendment-a-specification.md`, `-schema.md`, `-test-matrix.md`, `-compatibility.md` |
| **Key definitions** | Same-pass (4-field equality); cross-pass structural + traversal proof; provisional vs genuine |
| **Error codes** | 25+ stable codes (A-BND-*, A-PTR-*, A-MEM-*, A-LEG-*, A-XPS-*, A-DUP-*, A-ART-*) |
| **Test matrix** | 32 specified tests (not implemented) |
| **Tests** | `npm test` 432/432 pass (regression) |
| **Not authorized** | Implementation, Amendment B, bundle publication, `current.json` change |
| **Next action** | Independent specification review |
| **Evidence** | `deliverables/stage20-amendment-a-specification.md` |

---

## 2026-07-28 — Amendment A specification correction (identity hierarchy v2)

| Field | Detail |
|-------|--------|
| **Objective** | Correct internal contradiction in cross-pass structural-candidate rules before approval |
| **Mode** | Specification-only correction — no implementation |
| **Problem** | v1 required same `parentTrackId` with different `temporalPassId`; `parentTrackId` embeds pass → logically impossible |
| **Correction** | Introduced `dividerCorridorId` (`{chunkId}:{poseSectionId}:{trackIndex}`); cross-pass requires **different** `parentTrackId`, **equal** `dividerCorridorId` |
| **Identity model** | Option A + C: `parentTrackId` remains pass-local FK; new corridor comparison identity |
| **Scope clarifications** | `segmentId` not required equal for cross-pass; `chunkId` segment-local; `poseSectionId` pass-local (scoped via corridor ID) |
| **Satisfiability** | SAT-1 through SAT-6; positive synthetic fixture T-A-034; real data zero structural candidates remains valid (SAT-5) |
| **Deliverables revised** | `deliverables/stage20-amendment-a-specification.md` (v2), `-schema.md`, `-test-matrix.md` (36 tests), `-compatibility.md` |
| **Tests** | `npm test` regression only |
| **Not modified** | Production code, tests, bundles, `current.json`, v11, Stage 19 v5, Rev 37 |
| **Next action** | Independent specification review of v2 |
| **Evidence** | `deliverables/stage20-amendment-a-specification.md` §2–§8 |

---

## 2026-07-28 — Amendment A specification correction v3 (comparison-key scope)

| Field | Detail |
|-------|--------|
| **Objective** | Correct `dividerCorridorId` scope error — locally scoped tuple cannot be authoritative corridor identity |
| **Mode** | Specification-only correction — no implementation |
| **Problem** | v2 treated equal `dividerCorridorId` text as corridor-matched; components (`chunkId`, `poseSectionId`, `trackIndex`) are segment-local, pass-local, or boundary-group-local |
| **Correction** | Option A+C: comparison key within segment only; Stage 20 corridor linkage records with `roadCorridorId`; separated evidence states |
| **Real data** | 3 cross-segment key-collision linkage hypotheses (not corridor matches) |
| **Deliverables revised** | All four Amendment A spec files → v3; test matrix 41 tests |
| **Tests** | `npm test` regression only |
| **Not modified** | Production code, tests, bundles, `current.json`, v11, Stage 19 v5, Rev 37 |
| **Evidence** | `deliverables/stage20-amendment-a-specification.md` v3 |

---

## 2026-07-28 — Amendment A v3 implementation

| Field | Detail |
|-------|--------|
| **Objective** | Implement approved Amendment A v3 metadata propagation and validation |
| **Specification** | Approved v3 (`stage20-amendment-a-spec-v3`) |
| **Propagation point** | `flushRun()` in `lib/stage17_supported_run_fusion.js` (`amendmentA: true`) |
| **New artifact** | `lane_divider_supported_runs_v1.json` (878 runs, 0 rejected) |
| **Content hash** | `0742ca6aa4ecce0cb877f045659c79510aa2ed1e317be6564f4ff0319ee4c9f7` |
| **Cross-pass** | 3 cross-segment key-collision linkage hypotheses; 0 structural; 0 genuine |
| **Linkage records** | Schema validation + fixtures only — no auto-generated validated linkage |
| **Tests** | 29 Amendment A tests + full regression 461/461 (×2 runs) |
| **Checkpoint** | `checkpoints/stage20-amendment-a-implementation-2026-07-28.json` |
| **Not authorized** | Production deployment, P3, lane counting, Amendment B, `current.json` change |
| **v0 artifact** | Immutable (`lane_divider_supported_runs_v0.json` hash unchanged) |

---

## 2026-07-28 — Amendment A v3 acceptance audit

| Field | Detail |
|-------|--------|
| **Objective** | Trace 41 matrix cases vs 29 physical tests; close gaps; verify real-data gates |
| **Result** | 41/41 matrix covered; 48 physical Amendment A test blocks; 480 full regression |
| **Deliverable** | `deliverables/stage20-amendment-a-acceptance-audit.md` |
| **Real data** | 878 runs; 3 linkage hypotheses; 0 structural/genuine |
| **Not modified** | Protected artifacts, v1 artifact, `current.json`, Stage 19 v5 |

---

## 2026-07-28 — Amendment B investigation and specification (v1)

| Field | Detail |
|-------|--------|
| **Objective** | Investigate and specify Amendment B from project records — no implementation |
| **Scope resolution** | **B-MOTION:** within-track motion-aware linking (canonical Amendment B). **B-TRAV:** traversal evidence/linkage schemas (Stage 20 evidence continuation; resolves Amendment A §14 Q1) |
| **Contradiction** | “Motion-aware cross-pass” is **not** canonical — cross-pass remains Amendment A + corridor + traversal linkage |
| **Prerequisite** | B-MOTION threshold blocked (KI-010); B-TRAV requires validated corridor linkage before genuine promotion |
| **Real data** | 100% motion fields on observations; 0 corridor linkages; 0 genuine evidence — valid |
| **Test matrix** | 44 specified cases (18 B-MOTION + 26 B-TRAV) — not implemented |
| **Deliverables** | `deliverables/stage20-amendment-b-{investigation,specification,schema,test-matrix,compatibility}.md` |
| **Regression** | `node --expose-gc --test tests` → 480/480 pass |
| **Not authorized** | Implementation, production promotion, P3, lane counting |

---

## 2026-07-28 — Amendment B specification review approval + prerequisite hardening

| Field | Detail |
|-------|--------|
| **Amendment B** | Approved at **specification-review level only** — implementation unauthorized |
| **Amendment A hardening** | T-A-054 (`A-ART-001`), T-A-055 (`A-ART-002`), T-A-056 (`A-LNK-004`) — KI-011 closed |
| **Terminology correction** | `stage20_link_ground_truth_sample.json` documented as rule-derived candidate sample — not manual ground truth |
| **B-MOTION evidence** | 220-pair review manifest; 92 qlog files in workspace; 0 manual reviewer labels |
| **Threshold** | `RESIDUAL_CAP_M` not approved — calibration blocked until manual review |
| **Regression** | 483 tests (+3 hardening); flaky concurrent-publication on 2/2 runs |
| **Not authorized** | B-MOTION/B-TRAV implementation, production promotion, P3, lane counting |

---

## History Not Fully Confirmed

The following are referenced in `checkpoints/admiral-investigation-2026-07-23.md` but lack independent checkpoint files in this workspace:

- Exact dates and version IDs for Stages 1–5 individual iterations
- Stage 19 v0 and v1 detailed change lists (no `stage19_v0`/`v1` corrective reports found; only checkpoint preservation metadata in `lib/stage19_version.js`)
- Rev 33–36 specification revision history (spec files exist in `docs/` but approval timeline not independently verified here)

When future work confirms these items, append corrections — do not rewrite prior entries.
