# Current Status

**Last updated:** 2026-08-26
**Classification key:** Each item is tagged — **VP** verified production, **FV** fixture-validated, **ES** experimental sensitivity, **UR** unsupported real-dataset behaviour, **PW** planned work.

**Method ledger:** Full retrospective reconstruction with evidence IDs is in [METHOD_EVIDENCE_LEDGER.md](./METHOD_EVIDENCE_LEDGER.md).

---

## Repository checkpoint (2026-08-26)

| Item | Value |
|------|-------|
| Branch | `experiment/candidate-layer-display` |
| HEAD | `8ce0ab6e5671110c836be8ff49bbd47c8a0a262f` |
| Remote tracking | None (local-only commits; not pushed) |
| Active processing version | `2026-07-24-fusion-v16` |
| Index | Dirty — modified viewer/server/tests/audit JSON; many untracked reports and experimental libs |

### Checkpointed features (committed on branch)

- Path 1 graph fitting, hybrid fitted lane map, persistent graph-fit cache
- Per-frame connected accumulated display (`dbe7f26`)
- Current-frame connected accumulated display (`8ce0ab6`, HEAD)

### Active uncommitted experiments (viewer-only unless noted)

| Layer / work | Status | Notes |
|--------------|--------|-------|
| Connected accumulated modes | **ES** — REJECTED / PARTIAL | Raw/robust/road-guided v1/dot **REJECTED**; consensus v2/road-guided v2 **PARTIAL**; per-frame/current-frame **checkpointed** — ledger M-035–M-046 |
| Segment 0 mirror display correction | **ES** — ACCEPTED EXPERIMENTAL (uncommitted) | `segment0_mirror_validation.json`; production stored mirror correct |
| Candidate amber-line display layer | **ES** | `public/candidate_layer_display.js` |
| Hybrid lane export | **ES** — paused | `lib/hybrid_lane_export*.js`; deliverables under `deliverables/hybrid_lane_map_v1/` |
| Lane-mapping quality audits | **ES** — diagnostic | `lib/lane_mapping_quality_audit.js`; reports under `reports/lane_mapping_quality/` |

### Rejected / blocked (durable)

- **Path 2 ordering recovery** — NO-GO (`reports/path2_design/path2_feasibility_report.md`)
- **Threshold lowering** — rejected (dedup counterfactual + policy)
- **Video mapping integration** — blocked (intrinsics/reprojection); inventory/UFLD investigation **ACCEPTED EXPERIMENTAL** / **PARTIAL** only
- **Road-guided static v1 / dot connection** — **REJECTED** (practical coverage failed)
- **Road-guided static v2** — **PARTIAL** (correct slots; low supported coverage)
- **Higher-rate modelV2** — blocked (no rlog source)
- **Frame registration / pose-tail fixes** — rejected (regress support/geometry)

### Current main lane-mapping limitation

Sparse ~0.5 Hz qlog modelV2 evidence, strict support gates, and unsafe raw lane-index identity through lane changes limit joined polyline coverage (~40% provenance on Segment 1 audit). **Viewer diagnostic layers (connected accumulated, road-guided, candidate) are not confirmed mapping** and must not enter polygons or production exports without separate gates.

### Next recommended work (not completed)

**Rank-by-bin Road-guided dot connection:** cluster all eligible dots at every trajectory bin, assign by lateral rank without anchor propagation, smooth d(s), count prefix/internal/suffix gaps, and exclude invalid trajectory loops. See ledger recommended-next section.

Other follow-ups: calibrated video or higher-rate evidence before video mapping; optional mirror-fix checkpoint commit (viewer-only).

---

## Summary Table

| Item | Value | Classification |
|------|-------|----------------|
| Active processing version | `2026-07-24-fusion-v16` | **VP** (`lib/version.js`) — stationary pose dwell-window correction; fusion geometry unchanged from v11 |
| Frozen geometry baseline (Stage 19 compare) | `2026-07-24-fusion-v11` | **VP** — Stage 19 delivery-readiness pins still reference v11 label; v16 does not alter fused road-surface geometry |
| Path 1 graph fitting | Experimental display-only layer; **off by default**; enable with `?fit=1` | **ES** (`lib/graph_fit.js`, `lib/segment_local_map.js`, `public/render.js`) |
| Hybrid graph-fitted lane map | **Implemented + validated** — one hybrid boundary per constructed fragment; solid cyan = accepted fit, coloured dashed = fragment fallback; complete-map only; suppressed during causal playback; **off by default** (requires `?fit=1` + checkbox) | **ES** (`lib/graph_fit.js` → `hybridFittedBoundaries`, `public/render.js`) |
| Path 2 graph fitting | **Rejected** — feasibility NO-GO (52 eligible segments; zero safe ordering recovery) | **UR** — see `reports/path2_design/path2_feasibility_report.md`, ledger **M-011** |
| Viewer / diagnostic probe map path | Shared production helper `lib/viewer_map_build.js` | **ES** — probes now match `/api/process` → `enrichTimelineWithMovement` → `buildSegmentLocalMap` |
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
| Constructed lane-boundary fragments | **Experimental display-only layer implemented + audited** — 160 frags / 5 segs, median residual ~0.13 m, source points unmodified | **ES** (`lib/constructed_fragments.js`, `reports/constructed_fragments_experimental.md`) |
| Constructed fragments acceptance validation | **Evidence complete on 7 required segments** — 10/10 structural checks PASS on 14 & 16; regression invariants hold on 2/6/54/58/99; rejected-connection records + visual captures exported; no new test failure | **ES** (`reports/constructed_fragments_validation_evidence.md`) |
| Joined lane-boundary polylines (fragment joining stage) | **Experimental stage implemented + validated** — joins only compatible fragments (mutual-best, evidence corridor, no branching). Seg14: 6 polylines / 19 conns; Seg16: 4 / 13. All 10 K-checks PASS; regression segments conservative (6/54/58/99 unjoined by hard prohibitions). Thresholds from Seg14/16 only | **ES** (`lib/lane_joining.js`, `reports/lane_joining_stage.md`) |
| Constructed/joined mirror alignment | **Mirror regression fixed** — constructed fragments, joined polylines, connectors and EB overlay now carry precomputed mirrored coords through the same `roadGeometryToScreen` selector as the dots; all layers move together on toggle, arrow shift 0 px, corrected default restored on refresh. New screen-coordinate regression test (10/10) | **ES** (`reports/mirror_alignment_fix.md`, `tests/mirror_alignment.test.js`) |
| Constructed/joined endpoint coverage | **Endpoint coverage diagnosed + fixed** — one-sided endpoint extension recovers the clean route-start boundary run (seg14/16 start gap 42 m → 0 m; joined polylines now start at route start) while leaving noisy/sparse end tails conservative. No joining retune, no mirror change. 6 new endpoint tests | **ES** (`reports/endpoint_coverage_fix.md`, `tests/constructed_fragments.test.js`) |
| Joined-output consistency & lane colour | **Fixed** — every valid constructed fragment now appears exactly once in "Joined lane polylines" (singletons + multi-fragment components; missing=0, duplicate=0 on all 8 segments). Solid joined geometry follows dashed fragments 100%. Orange established as a legitimate intermittent 4th boundary (groupTrackId 3), preserved. Fragments/joined/dots share one stable-boundary colour via a shared resolver; debug colours confined to the debug layer. Mirror + arrow unchanged | **ES** (`reports/joined_output_consistency.md`, `tests/lane_joining.test.js`) |
| Lane-viewer rendering regression | **Fixed** — a missing `let drawn = 0` in `_drawConstructedFragments` threw `ReferenceError: drawn is not defined` on every fragment draw, hiding the arrow, joined solid polylines and all non-blue boundaries (looked like first-segment retention). Restored the declaration; all boundaries/joined/arrow render and segment switches fully replace geometry. 12 new viewer-state tests | **ES** (`reports/viewer_regression_fix.md`, `tests/viewer_state_regression.test.js`) |
| Stationary vehicle pose drift | **Fixed** — movement-state machine with time-based dwell locks the mapping pose at a robust anchor while stationary, so GPS position/bearing jitter no longer scatters or rotates the lane map. GPS `speed` is the primary motion signal (displacement only with ≥1 s dt); `moving` at 0.14 m/s is corrected to STATIONARY. Fully-stationary segments (9/60/65/96) reduce 10-28 m drift to <1.2 m; dataset-wide 172 m false travel removed. 24 new tests; viewer shows "STATIONARY LOCKED" | **ES** (`reports/stationary_pose_fix.md`, `tests/stationary_pose_lock.test.js`) |
| Stationary pose dwell-window correction | **Fixed** — two-pass pose lock applies the confirmed anchor from effective stop onset retrospectively, so CANDIDATE_STOP (3 s dwell) poses and geometry are rebuilt with the anchor instead of committed at drifting raw values. Seg6 arrow no longer drifts during the dwell; Seg9 uses one anchor. Dataset-wide 302 m false travel removed. 14 new dwell tests; processing version → fusion-v16 | **ES** (`reports/stationary_pose_dwell_fix.md`, `tests/stationary_pose_lock.test.js`) |
| Stationary Segment 9 `noGeometry` (partial stationary geometry) | **Fixed** — fully-stationary Seg9 showed `reason: noGeometry` in Point-accumulated mode despite 910 valid accumulated lane observations. The map validity gate ignored the point-accumulated cloud (only counted laneFragments/edgeFragments/polygons/trajectory, all empty/degenerate for a stationary segment); `noGeometry` now means every drawable layer is empty. A zero-length reference trajectory (all poses locked to one anchor) is treated as absent so `s`/`d` fall back to the fixed-anchor forward/lateral frame, restoring constructed fragments. Seg9 Point mode: valid=true, 910 points drawn (3 boundaries, 907 repeated-support), 3 constructed fragments, polygons remain 0, trajectory stays 1, pose anchored — no artificial motion, no invented boundaries. 14 new tests | **ES** (`reports/stationary_geometry_no_geometry_fix.md`, `tests/stationary_geometry.test.js`) |
| Stationary Segment 9 lane semantics / arrow / road polygon | **Fixed** — Seg9 map showed a blue polyline "passing through" the arrow (arrow heading fell back to 0° for a stationary segment instead of 90° = segment-local forward; rotated 90° off it pointed at the mirror-displayed ego-right boundary), a "6" fragment label (double increment), and 0 road polygons despite two supported ego boundaries (sd_fusion polygon path requires along-track vehicle travel). Fixed arrow heading for degenerate trajectories, fragment count, and added a general `buildStationaryLocalPolygons` path (fixed-anchor forward/lateral, supported left/right pair, ordering + separation + overlap gates, no invented boundary). Seg9 now: 1 stationaryLocalRoadSurface polygon (lane2×lane1, 316 m²), arrow forward, label 3. lane0 (outer-right) is reported as outcome E — model outputs it all 30 frames at prob ~0.30, below the 0.5 gate in 28/30 frames (genuine low-confidence lane detection, not thresholded away). 13 new tests | **ES** (`reports/stationary_lane_semantics_diagnosis.md`, `tests/stationary_lane_semantics.test.js`) |
| Path 1 graph fitting (experimental) | **Implemented + validated** — fits constructed-fragment runs to smooth splines on the complete local map only (`fitEnabled` via `?fit=1` or UI toggle). Causal playback does **not** run fitting. Fitted output is display-only: **does not feed polygons** or replace fused/constructed geometry. Cyan polylines = accepted fitted curves; purple markers = fitted endpoints (diagnostic). Mirror coordinate-frame defect fixed (fitted vertices carry `mirroredEast`/`mirroredNorth`; renderer no longer falls back to global mirror). Source-corridor gate (`fitMaxSourceCorridorM: 3.0`) rejects fits that deviate from source fragments. Viewer-authoritative accepted counts (fusion-v16, polygons unchanged): Seg2 **4**, Seg3 **11**, Seg9 **0** (1 stationary polygon; CF0 rejected at 4.10 m > 3 m gate), Seg14 **7**, Seg16 **9**, Seg54 **0**, Seg58 **0**, Seg95 **0**, Seg99 **0**. Complete-map fitting remains slow on long segments. 74 graph-fit tests + 8 viewer/probe parity tests | **ES** (`lib/graph_fit.js`, `lib/viewer_map_build.js`, `reports/fitted_layer_probe/segment_fitted_summary.json`) |
| Hybrid graph-fitted lane map | **Implemented + validated (GO)** — `pointAccumulated.hybridFittedBoundaries`: exactly one boundary per constructed fragment. Accepted Path 1 fits render as solid cyan (4 px); rejected/missing fits use coloured dashed original fragment geometry (2 px). Unsupported gaps remain open; no cross-fragment joining. Complete-map only; suppressed during causal playback. Requires `?fit=1` + **Hybrid fitted lane map (experimental)** checkbox (off by default). Constructed-fragment layer visually suppressed while hybrid is active (no duplicate rendering). Polygons unchanged. Accepted counts match Path 1 on nine-segment audit set. Focused tests 149/149; full suite 1,772 / 1,745 pass / 27 fail (established baseline). Video/calibration branch paused separately | **ES** (`lib/graph_fit.js`, `public/render.js`, `reports/hybrid_validation/HYBRID_VALIDATION_REPORT.md`) |
| Persistent graph-fit cache | **Implemented + validated (GO)** — IndexedDB `kommuGraphFitPersistV1` / `stationaryMaps`, schema `graph-fit-persist-v1`, impl version `path1-heldout-memo-v1`. Lookup order: in-memory `stationaryMapCache` → persistent IndexedDB → normal graph-fit build. Applies only to fit-enabled complete-map output (`?fit=1`, non-causal). Fit-disabled and causal paths do not use persistent fitted maps. Origin-specific (separate stores per localhost port). 512 MB LRU on dedicated store only; cache failure falls back to normal fitting. Display-only — never feeds polygons. Seg2 **4** accepted, Seg14 **7**, Seg9 **0** (3 fallback, 1 polygon). Gate: 10/10 Seg2 cycles, 3/3 fresh profiles, browser 8/8. First uncached fit remains expensive (Seg14 cold ~47 s; warm ~1.3 s, 0 fitter calls) | **ES** (`lib/graph_fit_persistent_cache.js`, `public/graph_fit_persistent_cache.js`, `public/app.js`) |

---

## Verified Production Behaviour (**VP**)

### Fusion-v16 processing (geometry unchanged)

- Active processing version: `2026-07-24-fusion-v16` (`lib/version.js`) — two-pass stationary pose dwell-window correction
- v16 bump invalidates stale cached processing results; fused road-surface geometry is unchanged from the frozen v11 baseline
- Full 92-segment v11 geometry compare (Stage 19 delivery): 0 differences (`reports/stage19_v5_corrective_checkpoint_report.json` → `v11GeometryCompare`)
- Stage 19 implementation does **not** modify fused geometry (`v11GeometryModified: false` in `audit_stage19_dataset_sensitivity.json`)
- Graph fitting (`lib/graph_fit.js`) is an optional experimental overlay; default `fitEnabled: false` — polygons and fusion output are identical with fitting on or off

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

## Validation Snapshot

### Full-suite failure history (authoritative sequence)

| Phase | Fail count | Cause |
|-------|------------|-------|
| Pre-migration OneDrive | **28** | Stage 7 audit JSON write failure under OneDrive (27 baseline + 1 environmental) |
| Post-migration local, no API server | **28** | Stage 7 passed; API parity `ECONNREFUSED` on port 3847 |
| Local with API server on 3847 | **27** | Established baseline only |

Evidence: `reports/hybrid_validation/HYBRID_VALIDATION_REPORT.md` Phase 14, `.cache/hybrid_full_suite.txt`, `reports/stationary_pose_dwell_fix.md` §11. Do not summarise all 28-failure runs as one Stage 7 flake.

### Current validation gates

| Check | Result |
|-------|--------|
| Full suite (API server on 3847) | `node --expose-gc --test tests` — **1772** tests, **1745** pass, **27** fail (established baseline) |
| Graph-fit focused suite | `tests/graph_fit.test.js` + `tests/viewer_probe_parity.test.js` + `tests/video_restore.test.js` + `tests/graph_fit_persistent_cache.test.js` — **149/149** pass |
| Persistent-cache browser suite | `RUN_GRAPH_FIT_PERSIST_BROWSER=1` + `tests/graph_fit_persistent_cache_browser.test.js` — **8/8** pass (gated off full suite by default) |
| Persistent-cache reliability gate | `node scripts/run_persist_browser_gate.js` — Seg2 **10/10**, fresh profiles **3/3**, Seg14 E2E pass |
| Viewer/probe parity | `tests/viewer_probe_parity.test.js` — pass |
| Video restore | `tests/video_restore.test.js` — pass (test 4 isolated from host ffmpeg / `.video_cache`) |
| Stage 19 v5 (historical) | 432 pass, 0 fail (`reports/stage19_v5_corrective_checkpoint_report.json`) |
| Publication repeat | 30/30 |
| v11 geometry compare (92 segments) | 0 differences |

**Documented baseline failures (27):** experimental_boundaries fused-mode pin; D12 geometry/rendering pins; segment2 road-surface stage1/2 pins; local road-surface path filter; local trajectory overlay; stage13a/14 pins; stage16/17/18 v11 version pins; stage20 Amendment A frozen-v11 pin; Stage 19 concurrent-publication flake (environmental).

---

## Ongoing Documentation Rule

After every meaningful task, update: `DEVELOPMENT_LOG.md`, this file, `DECISIONS.md`, `EXPERIMENTS.md`, `KNOWN_ISSUES.md`, `RUN_GUIDE.md` as applicable. Never promote experimental or planned items to verified production status.
