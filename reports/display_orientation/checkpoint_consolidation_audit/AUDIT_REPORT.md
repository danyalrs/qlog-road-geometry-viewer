# Checkpoint consolidation audit (read-only)

## 1. Repository state
- Root `C:\Kommu AI Project`; branch `experiment/candidate-layer-display`; HEAD `488c61b`; staged-file count 0.
- 241 working-tree entries: **26 tracked modified** (0 deleted/renamed/type-changed) and **215 untracked** porcelain entries.
- No write to production/tests/docs/reports/config; only the four files in this audit directory were created.
- Server not touched; no qlog processing, dataset scan, browser capture, or broad test run.

## 2. Total tracked changes
26 modified tracked files (8,142 insertions / 619 deletions). Full per-file record: `tracked_changes.json`.
Highlights: `public/connected_accumulated_display.js` (+6191), `tests/connected_accumulated_display.test.js` (+617),
`public/render.js` (+518), `scripts/verify_connected_accumulated_runtime.js` (+307), `public/app.js` (+284),
`docs/DEVELOPMENT_LOG.md` (+181), `public/local_geometry_ui.js` (+181).

## 3. Untracked inventory (grouped)
Full record: `untracked_inventory.json`.
- Backup/staging dirs (F): `.checkpoint_test_backup/` 1650 files/74 MB; `.staged_snapshot_verify/` 5622/355.6 MB;
  `.segment0_correction_staging/` 38/1.4 MB; `.road_mirror_checkpoint_staging/` 26/0.8 MB; `browser/` 8/0.9 MB.
- Patches (F): `.connected_accumulated_staging.patch`, `.road_mirror_checkpoint.patch`.
- Untracked source (A/B): 12 `lib/*.js` (3 accepted canonical: combined_visible_lane_projection,
  point_accumulated_lane_polylines, segment1_lane_order_diagnostic; plus hybrid/lane-mapping/segment0 groups),
  5 `public/*.js` (4 runtime-loaded), ~120 `scripts/*` (grouped), ~30 `tests/*`.
- Generated/evidence (E/G): `reports/` ~22,324 files/~4.5 GB; `deliverables/hybrid_lane_map_v1/` 1556/203.6 MB.
- `reports/display_orientation/` sub-dirs are compact-ish evidence (52 representative files = 3.5 MB).

## 4. Classification totals
| Class | Tracked | Untracked (entries/groups) |
|---|---|---|
| A — required runtime | 11 | 7 (lib/public modules) |
| B — required tests/tools | 3 | ~20 (tests + scripts) |
| C — docs/compact evidence | 4 | 6 report dirs |
| D — superseded experimental | 0 | ~15 (segment0/m051/combined_segment1 etc.) |
| E — generated/bulky | 7 | ~18 report dirs + capture scripts |
| F — backup/patch/temp | 0 | ~15 groups (dirs/patches/scripts) |
| G — unrelated/uncertain | 0 | hybrid/lane-mapping (~10) |
| MIXED | 1 (`server.js`) | 0 |

## 5. Accepted runtime dependency chain
`public/index.html` loads (in order) `local_playback.js`, `point_accumulation.js`,
`connected_accumulated_display.js`, `segment_local_map.js`, `local_geometry_ui.js`,
`combined_source_transform.js`, `combined_boundary_anchored_orientation.js`,
`combined_visible_lane_projection.js`, `point_accumulated_lane_polylines.js`,
`canvas_layer_attribution.js`, `segment1_lane_order_diagnostic.js`, `render.js`, `app.js` (plus
pre-existing modules). Findings:
- All required browser scripts are present under `public/`; none exist only inside a backup directory.
- No accepted method depends on an untracked temporary script; `render.js` selects
  `representativeMethod=purityRevisit` via URL regex and `app.js` sets the candidate flag.
- Local playback + point-accumulated defaults are centralized in `lib/local_geometry_ui.js` →
  `public/local_geometry_ui.js`.
- Road/trajectory/arrow share `combined_source_transform.js` + `combined_boundary_anchored_orientation.js`.
- Combined Visible Lane Projection is applied only in the point-accumulated path.
- Road, trajectory, arrow, bridges, cache and processing data are separate passes from the
  representative-line mutation in `render.js`.
- Diagnostic methods (legacy/purity/curveAssociation, road-guided, segment1 diagnostic) remain selectable
  without being defaults.

## 6. Public/lib synchronization findings
Canonical source is `lib/`; `public/` is a browser-wrapped mirror (hash differences are expected).
| Pair | Sync command | Status |
|---|---|---|
| local_geometry_ui | `scripts/sync_local_geometry_ui_public.js` | in sync (wrapped) |
| combined_source_transform | `scripts/sync_combined_boundary_anchored_orientation_public.js` (also writes source transform) | in sync (wrapped) |
| combined_boundary_anchored_orientation | `scripts/sync_combined_boundary_anchored_orientation_public.js` | in sync (wrapped) |
| combined_visible_lane_projection | `scripts/sync_combined_visible_lane_projection_public.js` | in sync (wrapped) |
| point_accumulated_lane_polylines | `scripts/sync_point_accumulated_lane_polylines_public.js` | in sync (wrapped) |
| canvas_layer_attribution | no dedicated sync script found | manually maintained — verify before commit |
| segment1_lane_order_diagnostic | no dedicated sync script found | manually maintained — verify before commit |
| segment0_road_mirror_fix | no sync script | deferred experiment |

## 7. Test ownership and stale-test findings
Accepted coverage:
- Combined visible-lane projection → `tests/combined_visible_lane_projection.test.js`.
- Point-accumulated lane polylines → `tests/point_accumulated_lane_polylines.test.js`.
- Representative fitting → `tests/representative_lane_lines.test.js`, `tests/connected_accumulated_display.test.js`.
- Purity association → `tests/representative_lane_lines_purity.test.js`.
- purityRevisit → `tests/representative_lane_lines_purity_revisit.test.js`.
- Cross-layer display alignment → `tests/cross_layer_alignment_shared_frame.test.js`.
- Default UI mode → `tests/local_playback_geometry_modes.test.js`, `tests/local_playback_stationary.test.js`.
- Combined/standalone orientation → `tests/combined_boundary_anchoring.test.js`, `tests/combined_full_layer_alignment.test.js`.

Findings:
- `fused` references are in local-playback data-model tests (`fusedLanes`/`fusedLaneLines`) and remain valid;
  no test was found asserting a removed render layer.
- Tests belonging to rejected/earlier experiments (defer, do not include): `combined_segment1_*`,
  `narrow_segment1_arrow_projection`, `m051_*`, `candidate_layer_display`, `segment0_road_mirror_fix`,
  `segment0_full_layer_candidate`.
- Prototype/snippet tests (`*_prototype.test.js`, `*_snippet.js`) and hybrid/lane-mapping tests are not part
  of the accepted suite.
- Docs are stale (below), not tests.

## 8. Documentation gaps
- `docs/CURRENT_STATUS.md`: last stage ≈ 20; no mention of the Local + point-accumulated + representative +
  purityRevisit direction or the 92/92 validation.
- `docs/DEVELOPMENT_LOG.md`: last entries Stage 20; accepted candidate chain undocumented.
- `docs/EXPERIMENTS.md`: newest E-016/E-018 (Stage 20); no representative/purity/purityRevisit experiment entries.
- `docs/METHOD_EVIDENCE_LEDGER.md`: M-036/M-041 describe older representative attempts as REJECTED/PARTIAL;
  no entry for the accepted corrected/purity/purityRevisit methods.
- Reports to cite when updating: `reports/display_orientation/representative_lane_lines/` (incl.
  `purity_revisit_candidate/REPORT.md` and `purity_revisit_dataset_validation/VALIDATION_REPORT.md`),
  `combined_visible_lane_projection/`, `point_accumulated_lane_polylines/`, `cross_layer_alignment/`.

## 9. Mixed-change risks
- **`server.js` (HIGH):** accepted server runtime + unrelated `/api/export/hybrid/*` endpoints (require
  `lib/hybrid_lane_export*.js`). Must not be committed as-is into a display checkpoint.
- **`public/connected_accumulated_display.js` (HIGH):** one file holds accepted corrected/purity/purityRevisit
  builders plus earlier experimental road-guided/robust helpers. Keep, but consider a later split.
- **`public/app.js` / `public/index.html` (MEDIUM):** display wiring plus possible hybrid/experimental controls;
  verify no hybrid-only tags before commit.
- **`tests/connected_accumulated_display.test.js` (MEDIUM):** may assert experimental methods; review before commit.

## 10. Proposed checkpoint manifest
See `proposed_checkpoint_manifest.json` (`include_runtime` 18, `include_tests_and_tools` 14,
`include_docs_and_compact_evidence` 10, `exclude_or_defer` 25 grouped entries).

## 11. Proposed commit structure
Clean per-feature commits are **not** fully possible: `render.js`, `app.js`, `index.html`,
`connected_accumulated_display.js` and `local_geometry_ui.js` interleave changes from the shared-transform,
defaults, and representative/purity work in single files, so they cannot be split by path without patch-level
staging. Recommended sequence:
1. **Checkpoint commit A — accepted display path** (runtime + tests + compact evidence): the `include_runtime`
   and `include_tests_and_tools` lists plus the compact `include_docs_and_compact_evidence` report dirs, with
   `server.js` **excluded** (its hybrid endpoints staged separately/manually later).
2. **Commit B — documentation update** after the docs are rewritten to reflect the accepted direction.
3. **Later/manual — hybrid export feature** (server.js endpoints + `lib/hybrid_*` + tests + deliverables) as its
   own feature branch/commit, not part of the display checkpoint.
If the team prefers a single commit, use one named checkpoint commit for the display path only, and explicitly
exclude server.js, all backup/cache/generated dirs, and hybrid material.

## 12. Files that must remain excluded
`.checkpoint_test_backup/`, `.staged_snapshot_verify/`, `.segment0_correction_staging/`,
`.road_mirror_checkpoint_staging/`, `browser/`, `*.patch`, `notes.txt`, `scripts/*.txt`,
`scripts/apply_*`, `scripts/backup_*`, `scripts/build_*`, `scripts/stage_*`, `scripts/splice_*`,
`scripts/rollback_*`, `scripts/archive_*`, `scripts/audit_*`, `scripts/capture_*`, `scripts/probe_*`,
`scripts/compare_*`, `scripts/diagnose_*`, `scripts/trace_*`, `scripts/export_hybrid_*`,
`reports/` (all generated dirs except the compact evidence listed in §10), `deliverables/hybrid_lane_map_v1/`,
`lib/hybrid_*`, `lib/lane_mapping_*`, `public/segment0_road_mirror_fix.js`, prototype/snippet tests,
hybrid tests, and the tracked generated `audit_segment2_lane_continuity_stage2..8.json`.

## 13. Files requiring user judgment
- `server.js` hybrid endpoints (accept as separate feature or defer).
- `lib/segment0_road_mirror_fix.js`, `lib/segment0_mirror_probe.js`, `public/segment0_road_mirror_fix.js`
  and the two segment0 tests (diagnostic vs accepted).
- `reports/display_orientation/` diagnostic dirs (`segment1_visible_pixel_owner`, `combined_boundary_anchoring`,
  `combined_lane_display_contract`, `combined_segment1_full_layer_handedness`) — include or defer.
- `scripts/run_*metrics.js` (keep as reusable tools or drop).
- `audit_segment2_lane_continuity_stage2..8.json` (generated tracked changes).

## 14. Exact files created by this audit
`reports/display_orientation/checkpoint_consolidation_audit/`
- `tracked_changes.json`
- `untracked_inventory.json`
- `proposed_checkpoint_manifest.json`
- `AUDIT_REPORT.md` (this file)

## 15. No existing file changed
No production source, test, documentation, report, configuration, or generated-data file was modified. Only the
new audit directory was written. No backup was created.

## 16. Branch / HEAD / staging / commit
Branch `experiment/candidate-layer-display`; HEAD `488c61b`; staged-file count 0; no commit; no push.

## 17. Final verdict
**Needs targeted cleanup first.** The accepted display path itself is well-isolated and safe to consolidate,
but a whole-tree commit is unsafe because (a) `server.js` mixes an unrelated hybrid-export feature, (b) the
working tree contains large backup/generated/hybrid material, and (c) docs are stale. Recommended path: commit
the display-path checkpoint (excluding `server.js`), stage the hybrid feature separately, and update docs in a
follow-up commit. No cleanup, staging, or commit was performed in this audit.

---

Audit only. No candidate logic changed. No existing files changed. Nothing staged, committed, or pushed.
