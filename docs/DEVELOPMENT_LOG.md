# Development Log

**Last updated:** 2026-08-12

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

## 2026-08-10 — Constructed lane-boundary fragments (experimental display layer)

| Field | Detail |
|-------|--------|
| **Objective** | Add a separate, toggleable experimental layer that converts the accumulated Point dots into short, reliable local boundary polylines without touching the fused/tracked pipeline or the dots |
| **Work** | New `lib/constructed_fragments.js` (+ browser mirror + sync script): group by physical boundary, order by along-track `s`, connect only when all local checks pass, split on gaps/conflicts/revisit/support, 5-pt moving-average smoothing (endpoints kept, shift capped 0.8 m), residual/confidence reporting. Wired `constructedFragments` into `buildPointAccumulatedFragments`; renderer layer `layerConstructedFragments`; causal/isolation rebuild at draw time. Pre-existing `headingDegForVehicleIcon` bundle bug fixed in `scripts/sync_segment_local_map_public.js`. 17 new tests in `tests/constructed_fragments.test.js` |
| **Components** | `lib/constructed_fragments.js`, `public/constructed_fragments.js`, `scripts/sync_constructed_fragments_public.js`, `scripts/audit_constructed_fragments.js`, `lib/segment_local_map.js`, `public/render.js`, `public/index.html`, `public/app.js`, `tests/constructed_fragments.test.js`, `reports/constructed_fragments_experimental.md` |
| **Results** | 160 fragments across 5-segment sample; median length ~27 m (seg 14: 42.8 m); median fragment residual ~0.13 m; source points unmodified in all segments; split reasons balanced |
| **Status** | **EXPERIMENTAL (ES) — display-only, never production** |
| **Evidence** | `reports/constructed_fragments_experimental.md`, `scripts/audit_constructed_fragments.js`, `tests/constructed_fragments.test.js` (17/17) |

---

## 2026-08-11 — Constructed fragments acceptance validation (evidence completion)

| Field | Detail |
|-------|--------|
| **Objective** | Complete the acceptance evidence for the constructed-fragments layer on the seven required segments (14, 16, 54, 2, 58, 99, 6) without tuning the algorithm or joining fragments |
| **Work** | Added rejection-record diagnostics (source point IDs, spatial/lateral/direction/temporal deltas) to `lib/constructed_fragments.js` (pure measurement, no threshold change). Added `scripts/validate_constructed_fragments.js` (per-segment stats + 10 structural checks), `scripts/regression_constructed_fragments.js` (segments 2/6/54/58/99), `scripts/capture_constructed_fragments.js` + `scripts/verify_constructed_fragments_capture.js` (visual comparisons). Added display-only `?cfLabels=1` fragment-ID/split-reason labels in `public/render.js`. Documented the pre-existing browser-bundle repair separately |
| **Results** | All 10 structural checks PASS for segments 14 and 16 (boundary separation, no crossing, no unsupported-gap bridging, no order reversal/interior zigzag, smoothing within 0.8 m cap, evidence-supported endpoints, vehicle-between-boundaries, corrected orientation unchanged). Regression invariants hold on 2/6/54/58/99. 8 synchronized captures + programmatic pixel verification. Full rejected-connection records exported |
| **Baseline** | Full suite: 1,506 tests, 1,479 pass / 27 fail — same failure set as before (the 26→27 delta is the known-flaky Stage 19 concurrent-publication test that passes in isolation). No new failure added |
| **Status** | **EXPERIMENTAL (ES)** — evidence complete; no commit/merge/push |
| **Evidence** | `reports/constructed_fragments_validation_evidence.md`, `reports/constructed_fragments_validation/*.json`, `screenshots/constructed_fragments/*.png` |

---

## 2026-08-11 — Lane-boundary fragment joining stage (experimental)

| Field | Detail |
|-------|--------|
| **Objective** | Join only compatible constructed fragments (same chunk/pass/physical boundary, forward in s, evidence corridor, mutual-best, no branching) into longer lane-boundary polylines; keep real gaps, revisits, discontinuities and ambiguity separated |
| **Work** | New `lib/lane_joining.js` (+ browser mirror + sync): hard prohibitions, bounded spatial candidate generation, 10 connection checks, evidence-corridor classification, composite score, mutual-best selection with ambiguity margin and ≤1 pred/succ (no branching), chaining into disjoint polylines, cubic tangent-continuous connectors. Thresholds derived only from Segments 14/16 (`JOINING_DEFAULTS`). Wired `joinedPolylines` into `buildPointAccumulatedFragments` (additive). Viewer layers `layerJoinedPolylines` + `layerJoinCandidates` with connector colours and hover. 16 new tests. Validation/regression/capture scripts |
| **Results** | Seg 14: 42 candidates → 19 accepted, 11 ambiguous, 6 polylines, 12 unjoined; Seg 16: 14 → 13 accepted, 4 polylines, 0 unjoined. All 10 K-checks PASS on both (no boundary mixing, no reversal, no connector crossing, no unsupported gap, no kink, evidence-close, ambiguity unjoined, source fragments byte-identical, mirror + arrow unchanged). Regression on 2/6/54/58/99: all invariants PASS; segments 6/54/58/99 left unjoined (hard prohibitions) by design |
| **Baseline** | Full suite after joining: 1,522 tests, 1,495 pass / 27 fail — identical pre-existing failure set, 16 new joining tests all pass, no new failure |
| **Status** | **EXPERIMENTAL (ES)** — separate toggleable layer; no commit/merge/push |
| **Evidence** | `reports/lane_joining_stage.md`, `reports/lane_joining/*.json`, `screenshots/lane_joining/*.png`, `tests/lane_joining.test.js` (16/16) |

---

## 2026-08-11 — Mirror-alignment fix for constructed/joined layers

| Field | Detail |
|-------|--------|
| **Objective** | Fix a visual mirror regression: with "Mirror road lateral display" checked, the constructed fragments and joined lane polylines rendered at the legacy (uncorrected) lane positions while the dots were mirrored |
| **Work** | Traced the coordinate flow: the dots carry precomputed `mirroredLocalEast/mirroredLocalNorth` and pass them through `roadGeometryToScreen(e,n,me,mn)`, but the constructed/joined/connector/EB layers carried only canonical `{east,north}` and called the selector with 2 args → with mirror on they used the unmirrored coords. Fixed by propagating the precomputed mirrored coords onto every derived-layer point and passing them through the same selector (no new reflection formula). Changed `lib/constructed_fragments.js`, `lib/lane_joining.js`, `lib/experimental_boundaries.js`, `public/render.js` + bundle sync scripts |
| **Results** | All road layers move together on toggle (L0 4.5px, L1 1.8px, L2 1.2px, joined 1.4px, EB 1.7px); arrow shift 0.00px; fresh load restores corrected default; dot-vs-fragment ≤ 0.4 px in both mirror states. Canonical joining decisions unchanged (seg14: 19 accepted / 6 polylines / 12 unjoined). New `tests/mirror_alignment.test.js` (10/10) compares actual screen coordinates |
| **Baseline** | Full suite after fix: 1,532 tests, 1,505 pass / 27 fail — same pre-existing failure set; 10 new tests pass; no new failure |
| **Status** | **EXPERIMENTAL (ES)** — fixed; no commit/merge/push |
| **Evidence** | `reports/mirror_alignment_fix.md`, `screenshots/mirror_verify/*.png`, `tests/mirror_alignment.test.js` |

---

## 2026-08-11 — Endpoint coverage fix for constructed/joined layers

| Field | Detail |
|-------|--------|
| **Objective** | Recover visible accumulated boundary dots at the temporal/spatial route START that were excluded from constructed fragments (and therefore from joined polylines); keep end tails conservative |
| **Work** | Diagnosed: the 42 m start gap on Segments 14/16 is the first temporal frame's observations (support=1, monotonic, geometrically consistent continuation) rejected by the global `minSupportCount` gate. End tails are noisy/cross-lane (seg16 alternating −5.1/−3.9) or sparse (seg14 2 unique points) and should NOT be bridged. Added a one-sided endpoint-extension pass in `lib/constructed_fragments.js` (`extendEndpoints`/`applyEndpointExtensions`): extends only the first/last fragment of a boundary using raw accumulated points, gated by boundary identity, monotonic ordering, consecutive-observation count, bounded gaps, lateral continuity + tight per-step lateral, lateral monotonicity, confidence floor, span cap, and never extrapolates beyond observed dots. `minSupportCount` not lowered globally |
| **Results** | Seg14/16 start gaps 42 m → 0 m (15 pts/boundary recovered); joined polylines now start at the route start. End tails left unextended (conservative). All 10 constructed-fragment validation checks PASS; 0 crossing/reversal/bridge; Seg6/99 hard splits intact; canonical+mirrored pairing preserved. Joining decisions unchanged (seg14 19 conns / 6 polylines, seg16 13 / 4) |
| **Baseline** | Full suite after fix: 1,538 tests, 1,512 pass / 26 fail — 6 new endpoint tests pass; failing set byte-identical to before (27→26 delta = flaky Stage 19 concurrent-publication passing this run). No new failure |
| **Status** | **EXPERIMENTAL (ES)** — diagnosed + fixed; no commit/merge/push |
| **Evidence** | `reports/endpoint_coverage_fix.md`, `reports/constructed_fragments_validation/endpoint_coverage_*.json`, `screenshots/endpoint_coverage/*.png`, `tests/constructed_fragments.test.js` (23/23) |

---

## 2026-08-12 — Joined-output consistency & lane-colour diagnosis

| Field | Detail |
|-------|--------|
| **Objective** | (1) Every valid constructed fragment must appear in the solid "Joined lane polylines" layer; (2) establish the meaning of orange lane geometry |
| **Work** | Diagnosed incomplete solid coverage: `joinConstructedFragments` only built polylines from accepted-connection chains with no singleton treatment — chain heads and isolated fragments (e.g. CF0@0.0) were omitted (seg14: 12/37 missing, seg20: 45/80). Fixed by treating all fragments as graph nodes, accepted connectors as edges, building disjoint components, and folding every unconnected fragment into a one-fragment singleton. Established orange = `trackColor(3)` = groupTrackId 3, a legitimate intermittent outer-left 4th boundary (own identity/observations/lateral position), preserved. Fixed a colour-selection inconsistency: fragments/joined used a hard-coded `laneColors[laneIndex]` map while dots used `trackColor(groupTrackId)`; added a shared `boundaryColor(groupTrackId)` resolver so all normal layers use the stable boundary colour. Debug decision colours remain confined to "Join candidates (debug)" |
| **Results** | Every valid fragment now appears exactly once in joined output (missing=0, duplicate=0) on Segments 14/16/20/2/6/54/58/99. Joined geometry covers 100% of fragment points (solid follows dashed exactly). Joined polylines start at the route start for every boundary. Fragments, joined and dots share one colour per boundary. All constructed-fragment validation checks PASS; regression invariants PASS; Seg6/54/58/99 fragments now visible as singletons. Mirror + arrow protections verified (arrow shift 0.00 px) |
| **Baseline** | Full suite after fix: 1,546 tests, 1,519 pass / 27 fail — 8 new joining tests pass; failing set identical to baseline; no new failure |
| **Status** | **EXPERIMENTAL (ES)** — no commit/merge/push |
| **Evidence** | `reports/joined_output_consistency.md`, `screenshots/joined_consistency/*.png`, `tests/lane_joining.test.js` (24/24) |

---

## 2026-08-12 — Lane-viewer rendering regression fix (`drawn` ReferenceError)

| Field | Detail |
|-------|--------|
| **Objective** | Repair the viewer regression after the singleton + shared-boundary-colour changes: first processed segment's geometry appeared retained, the vehicle arrow disappeared, only the blue dashed boundary rendered, no solid joined polylines |
| **Work** | Reproduced in the browser and captured the browser-console error: `ReferenceError: drawn is not defined`, thrown on every fragment draw. Root cause: the colour fix removed `let drawn = 0` (alongside the old `laneColors` const) from `_drawConstructedFragments`, but the method still referenced `drawn` in the label count. Every fragment draw threw, aborting the point-accumulated canvas function — hiding the arrow (drawn later), the joined solid polylines (drawn after fragments), and all boundaries except the first fragment's (blue). Segment state replacement itself was correct (verified: frag/joined counts and arrow position change per segment). Fixed by restoring `let drawn = 0`. Added `tests/viewer_state_regression.test.js` (12 tests) pinning the fix + invariants |
| **Results** | All boundary colours render (blue/red/green/orange per groupTrackId), joined solid polylines render, the vehicle arrow renders and moves across segments, segment switches fully replace geometry (no first-segment retention). Numeric/string groupTrackId resolve identically; debug amber confined to the candidates layer |
| **Baseline** | Full suite after fix: 1,558 tests, 1,531 pass / 26-27 fail — 12 new viewer tests pass; failing set identical to baseline; no new failure |
| **Status** | **EXPERIMENTAL (ES)** — no commit/merge/push |
| **Evidence** | `reports/viewer_regression_fix.md`, `screenshots/viewer_regression_fix/*.png`, `tests/viewer_state_regression.test.js` (12/12) |

---

## 2026-08-12 — Stationary vehicle pose drift fix

| Field | Detail |
|-------|--------|
| **Objective** | Stop the mapping pose drifting/rotating when the physical vehicle is stationary, caused by low-speed GPS position and bearing noise being interpreted as real movement (e.g. `moving` at 0.14 m/s on qlog_f449c_6) |
| **Work** | Diagnosed: lane observations are transformed through per-frame GPS poses; `movement_state.js` labelled states but never locked the pose; `effSpeed = max(speed, implied)` let displacement noise (1 m / 0.1 s → 10 m/s implied) override the reported 0.14 m/s. Added `lib/stationary_pose_lock.js`: a MOVING/CANDIDATE_STOP/STATIONARY/CANDIDATE_MOVE state machine with time-based dwell, GPS-`speed`-primary motion signal (displacement only with ≥1 s dt), stationary anchor (median of near-stop poses), mapping-pose freeze while stationary, and a movement-resumption blend with a stale-anchor departure guard. Wired into `process_route.js` so `transformFrameGeometry` uses the locked pose; lane observations still processed from the fixed anchor. Viewer shows "STATIONARY LOCKED" + anchor + mapping pose. 24 new tests; updated pose-lock-corrected baselines |
| **Results** | Fully-stationary segments (9, 60, 65, 96): raw drift 10.8–28.4 m → mapped travel 0.2–1.2 m; heading frozen. Stop-and-go (6, 54, 57, 58, 59, 61, 62, 64, 66, 67, 95): drift removed, no teleport. Dataset-wide: 172 m false travel removed, 91 segments classified (4 fully-stationary, 10 stop-and-go, 77 unchanged). Seg57 no longer fragments into spurious passes. Seg6 correctly shows STATIONARY at 0.14 m/s |
| **Baseline** | Full suite: 1,582 tests, 1,556 pass / 26 fail — 24 new tests pass; failing set identical to pre-change baseline; no new failure |
| **Status** | **EXPERIMENTAL (ES)** — no commit/merge/push |
| **Evidence** | `reports/stationary_pose_fix.md`, `reports/stationary_pose_validation.json`, `tests/stationary_pose_lock.test.js` (24/24) |

---

## 2026-08-12 — Stationary pose dwell-window correction (two-pass)

| Field | Detail |
|-------|--------|
| **Objective** | Fix the remaining regression: the arrow and geometry still drifted during the CANDIDATE_STOP (3 s stop-confirmation) window because only FUTURE poses were locked after confirmation; poses produced during the dwell were committed at drifting raw GPS values |
| **Work** | Refactored `lib/stationary_pose_lock.js` to a two-pass algorithm: Pass 1 classifies states (time-based dwell), Pass 2 applies the confirmed anchor from `effectiveStopTime` (start of the validated CANDIDATE_STOP run, or first usable frame for initially-stationary segments) retrospectively to every frame in the interval. Anchor = last reliable moving pose (reported speed ≥ stop threshold), so post-stop drift cannot centre it and there is no backward jump. Bumped `PROCESSING_VERSION` → `fusion-v16` to invalidate stale cached results; confirmed pose-lock params are not in the processing-options snapshot |
| **Results** | Seg6 arrow no longer moves backward during the dwell (fi=10-11 previously 46.84→45.86; now locked at last moving pose 47.70); Seg9 all frames use one anchor (-0.26, 0 m travel). Dataset-wide: 6 fully-stationary + 12 stop-and-go segments, 302 m false travel removed (was 172 m), fully-stationary mapped travel 0 m. 14 new dwell-correction tests |
| **Baseline** | Full suite: 1,596 tests, 1,570 pass / 26 fail (deterministic) — 38 stationary-pose tests pass; failing set identical to pre-change baseline; no new failure. (One API-parity test requires a running server and fails with ECONNREFUSED when none is present — pre-existing environment dependency, verified passing with a fresh server.) |
| **Status** | **EXPERIMENTAL (ES)** — no commit/merge/push |
| **Evidence** | `reports/stationary_pose_dwell_fix.md`, `reports/stationary_pose_validation.json`, `tests/stationary_pose_lock.test.js` (38/38) |

---

## 2026-08-12 — Stationary Segment 9 `noGeometry` fix (partial stationary geometry)

| Field | Detail |
|-------|--------|
| **Objective** | Restore drawable local lane geometry for fully-stationary Segment 9, which showed `Stationary local map unavailable / reason: noGeometry / mode: pointAccumulated` after the fusion-v16 two-pass pose-lock correction, despite 910 valid accumulated lane observations |
| **Diagnosis** | Traced all 11 pipeline stages. Source extraction (35 lane lines, 910 points), accumulation (910 displayed, 0 rejected) and tracking (4 tracks: 0/30 frames, 1/1, 2/2, 3/2; 0 rejected) all succeed. The **first loss stage** is the map validity gate in `buildSegmentLocalMap`: `valid`/`reason` were computed only from `laneFragments+edgeFragments > 0 || roadSurfacePolygons > 0 || trajectory >= 2`. In Point mode laneFragments are empty by design (dots drawn from `pointAccumulated.points`) and a stationary segment has 0 polygons + a 1-point trajectory, so the gate reported `noGeometry` and `render.js` short-circuited to the unavailable overlay. Secondary: a zero-length reference trajectory (all 30 poses locked to one anchor) collapsed every observation onto `s=0,d=0`, preventing constructed fragments |
| **Work** | (1) `hasDrawableGeometry` now includes `pointAccumulated.points.length > 0` — `noGeometry` only when EVERY drawable layer is empty. (2) Degenerate (zero-length) reference trajectories are treated as absent in `buildPointAccumulatedFragments` and `accumulatePointObservations`, so `s`/`d` fall back to the fixed-anchor forward/lateral frame (`s` = forward distance 0–117 m, `d` = lateral −4.5…+3.0). Regenerated public mirrors. No thresholds changed, no segment-specific conditions, no artificial motion |
| **Results** | Seg9 Point mode: `valid=true, reason=null`; 910 points drawn (3 boundary groups, 907 repeated-support); 3 constructed fragments (CF0 lane1 60.8 m, CF1 lane2 75 m, CF2 lane0 99.2 m); 3 experimental-boundary lanes; polygons stay 0 (no travel, no invented boundaries); trajectory stays 1 (pose anchored). Causal playback: elapsed 0→26, 5→182, 15→442, 29→910 points. Occlusion evidence: lane1 (ego boundary) present all 30 frames prob 0.58–0.88; lanes 0/2 only frames 4, 28–29; **no frame without usable evidence** — the car ahead reduces the boundary set but the model outputs sufficient lane evidence; the blank map was the pipeline gate, not occlusion |
| **Baseline** | Full suite: 1,610 tests (1,596 baseline + 14 new), 1,583 pass / 27 fail — all 14 new stationary-geometry tests pass; failing set identical to pre-change baseline (Stage 19 checksum/completeness, browser/Node checksum parity, flaky concurrent-publication test, three `v11 processing version unchanged` pins); no new failure |
| **Status** | **EXPERIMENTAL (ES)** — no commit/merge/push |
| **Evidence** | `reports/stationary_geometry_no_geometry_fix.md`, `reports/stationary_geometry_validation.json`, `tests/stationary_geometry.test.js` (14/14), `screenshots/point_accumulated_modes/*_qlog_f449c_9_*.png` |

---

## 2026-08-12 — Stationary Segment 9 lane semantics / arrow / road-polygon diagnosis

| Field | Detail |
|-------|--------|
| **Objective** | Segment 9 displayed 910 points, 3 fragments (label "6"), 3 joined polylines, 0 road polygons; the blue polyline appeared to pass through the vehicle arrow and the video showed a right-side boundary not displayed. Diagnose lane semantics, lateral coordinates, missing-boundary evidence and polygon eligibility before editing |
| **Diagnosis** | Three displayed polylines: JP1 = lane1 (ego-right, 30 frames, prob 0.57–0.88), JP2 = lane2 (ego-left, 3 frames: 4/28/29), JP3 = lane0 (outer-right, 2 frames: 28/29). **Arrow defect**: for a fully stationary segment the map trajectory collapses to one point, so `resolvePathHeadingDeg` fell back to 0 (canvas-north) while segment-local forward is +east (heading 90) → arrow rotated 90° off, pointing at the mirror-displayed blue ego-right boundary → "polyline appears to pass through the arrow". **Label defect**: `_drawConstructedFragments` incremented `drawn` twice per fragment → "6" for 3. **Outer-right boundary**: lane0 is output by the model in all 30 frames at prob ~0.30 (below the 0.5 gate) in 28/30 frames → first loss = probability filter; only frames 28–29 shown → outcome E (genuine low-confidence lane detection). **Road polygon**: sd_fusion polygon path requires along-track s spread; a stationary segment projects everything to s=0 → `intervalRejected missingBoundary`, `selectOuterLaneTrackBoundaries` null, `fusedLaneLines=0` → no polygon even though two supported ego boundaries exist → demonstrated pipeline gap |
| **Work** | (1) `resolveArrowOnSegmentMap`: heading 90° when trajectory < 2 points (stationary), moving segments unchanged. (2) Fixed fragment-count double increment. (3) Added `buildStationaryLocalPolygons` — a general stationary local-map polygon path using the fixed-anchor forward/lateral point cloud (left/right supported pair, correct ordering, lateral separation, forward overlap, no extrapolation, no invented boundary, no Segment 9 condition). (4) Normal-mode renderer draws stationary polygons (previously only debug/ribbon paths). (5) Wired into `buildSegmentLocalMap` pointAccumulated mode; regenerated public mirrors; widened render source-shape test windows |
| **Results** | Seg9: 1 stationaryLocalRoadSurface polygon (lane2 ego-left × lane1 ego-right, supportFrames 3, overlap 117.2 m, sep 2.65 m, area 316.3 m²); arrow heading 90° (forward); fragment label now 3. lane0/lane3 excluded by generic support gate (no invented boundary). Seg6/seg2 unchanged (sd_fusion polygons intact, moving arrow headings 39.5°/88.2°). 13 new lane-semantics tests |
| **Baseline** | Full suite: 1,623 tests (1,596 baseline + 27 new), 1,596 pass / 27 fail — failing set identical to pre-change baseline; no new failure |
| **Status** | **EXPERIMENTAL (ES)** — no commit/merge/push |
| **Evidence** | `reports/stationary_lane_semantics_diagnosis.md`, `reports/stationary_lane_semantics_validation.json`, `tests/stationary_lane_semantics.test.js` (13/13), `screenshots/seg9_*.png` |

---

## History Not Fully Confirmed

The following are referenced in `checkpoints/admiral-investigation-2026-07-23.md` but lack independent checkpoint files in this workspace:

- Exact dates and version IDs for Stages 1–5 individual iterations
- Stage 19 v0 and v1 detailed change lists (no `stage19_v0`/`v1` corrective reports found; only checkpoint preservation metadata in `lib/stage19_version.js`)
- Rev 33–36 specification revision history (spec files exist in `docs/` but approval timeline not independently verified here)

When future work confirms these items, append corrections — do not rewrite prior entries.
