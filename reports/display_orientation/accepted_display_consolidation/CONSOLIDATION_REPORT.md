# Accepted display-path consolidation — preparation report

## 1. Repository state (before / after)
- Root `C:\Kommu AI Project`; branch `experiment/candidate-layer-display`; HEAD `488c61b`; staged-file count 0.
- After: same branch/HEAD/staged state. Six files edited; nothing staged, committed, or pushed. No unrelated
  cleanup, no file deleted/moved, `server.js` untouched.
- Port 3847 was **not listening**; the server was not restarted, so live plain-load verification was unavailable
  (static/unit verification used instead).

## 2. Exact files edited
| File | Change |
|---|---|
| `public/render.js` | Added display-only `resolveRepresentativeMethod(search)` + `RoadRenderer.resolveRepresentativeMethod`; promoted default method to `purityRevisit`; explicit overrides preserved; availability guard only. |
| `tests/representative_lane_lines_purity_revisit.test.js` | Added `revisit-13` default/override selection test. |
| `docs/CURRENT_STATUS.md` | Updated "Last updated"; added "Accepted display-path consolidation (2026-09-10)" section. |
| `docs/DEVELOPMENT_LOG.md` | Updated "Last updated"; added dated 11-step progression entry. |
| `docs/EXPERIMENTS.md` | Updated "Last updated"; added accepted/retained/rejected/limitations section. |
| `docs/METHOD_EVIDENCE_LEDGER.md` | Added "Accepted display-path evidence (added 2026-09-10)" table. |

## 3. Exact backups created
`.checkpoint_test_backup/pre_accepted_display_consolidation/` (exact files, pre-edit SHA1 recorded):
- `render.js` 6903C02A153CCFFD9A0F1326D42F70090E6AAAAA
- `representative_lane_lines_purity_revisit.test.js` 53A45A5249F4C90B77D967A34EAB81D1867BCC81
- `CURRENT_STATUS.md` EBFD7DCB652619938BED4C87692A10B6AD4CAE03
- `DEVELOPMENT_LOG.md` 6DF338901D6F75E4BF358A2FF1213543A83A321C
- `EXPERIMENTS.md` 1A7FB55BC1B341086065ED905AC1266808C95E27
- `METHOD_EVIDENCE_LEDGER.md` 80BBE48A9F87F49883734C72A594D978A9B944C0

## 4. Default-method change
`public/render.js` now resolves the representative method from the URL query:
- absent `representativeMethod` → **`purityRevisit`**
- `representativeMethod=purityRevisit` → `purityRevisit`
- `representativeMethod=purity` → `purity`
- `representativeMethod=curveAssociation` → `curveAssociation` (corrected association)
- `representativeMethod=legacy` → `legacy`
- unrecognised value → `purityRevisit`
The resolver is display-only (chooses a builder; no source-data mutation). A guard falls back to
`curveAssociation` only if a selected builder is absent; it never changes the selection otherwise. The
purityRevisit algorithm and thresholds were not modified. Representative lane lines remain opt-in (its layer
checkbox is still unchecked by default); this task changed the method used when the layer is enabled.

## 5. URL override results
Verified by `revisit-13` (pass): `''`→purityRevisit; `?local=1&fit=1`→purityRevisit;
`purityRevisit`→purityRevisit; `purity`→purity; `curveAssociation`→curveAssociation; `legacy`→legacy;
`bogus`→purityRevisit; `purityRevisit&x=1`→purityRevisit. Full table in
`default_selection_verification.json`.

## 6. Plain-load default results
Live browser check unavailable (port 3847 down). Static verification:
- `public/index.html`: `vizMode` `local` selected; `localGeometryMode` `pointAccumulated` selected;
  `layerConnectedAccumulated` checked with `perFrame` selected; `layerRepresentativeLaneLines` unchecked.
- `lib/local_geometry_ui.js`: `LOCAL_GEOMETRY_DEFAULT_MODE='pointAccumulated'`, `VIZ_MODE_DEFAULT='local'`,
  `CONNECTED_ACCUMULATED_DEFAULT_ENABLED=true`, `CONNECTED_ACCUMULATED_DEFAULT_MODE='perFrame'`.
- Fused geometry remains a manually selectable option (not default).
Details in `default_selection_verification.json`.

## 7. Sync findings
- Edited file `public/render.js` is **browser-only** (no `lib/render.js`, no sync script) — no sync required.
- Canonical source is `lib/` for all accepted mirror pairs; `public/` is the browser-wrapped mirror
  (intentionally different bytes). Sync commands exist for local_geometry_ui, combined_source_transform +
  combined_boundary_anchored_orientation, combined_visible_lane_projection, point_accumulated_lane_polylines.
- `canvas_layer_attribution` and `segment1_lane_order_diagnostic` have no dedicated sync script → verify
  before staging (recorded, no broad sync run).
- All 36 scripts referenced by `index.html` exist in `public/`; **no accepted runtime dependency exists only in
  a backup directory, temporary script, patch file, or generated-report directory.**
Full record: `sync_verification.json`.

## 8. Documentation updates
Added concise dated entries (history preserved, no rewrites): primary direction + defaults + purityRevisit +
92-segment summary + checkpoint state + limitations + next work (`CURRENT_STATUS.md`); the 11-step
chronological progression (`DEVELOPMENT_LOG.md`); selected/accepted/retained/superseded/limitations
separation (`EXPERIMENTS.md`); evidence table with status per method (`METHOD_EVIDENCE_LEDGER.md`). Combined
Visible Lane Projection is recorded as **accepted (automated gates)** and explicitly **not** claimed as broadly
visually accepted.

## 9. Focused test results
Accepted-path suites: **60/60 pass** (combined_visible_lane_projection 13, point_accumulated_lane_polylines 11,
cross_layer_alignment_shared_frame 4, representative_lane_lines 8, representative_lane_lines_purity 11,
representative_lane_lines_purity_revisit 13 incl. new `revisit-13`).
Pre-existing failures in two non-representative local-playback suites (8 total), none caused by this edit:
- `tests/local_playback_geometry_modes.test.js` 35/41: 6 stale `fused`-default expectations + 1 server-dependent
  API parity test (port down).
- `tests/local_playback_stationary.test.js` 17/19: 2 stale `fused`-default expectations.
Classification and exact assertions: `focused_test_results.json`. These tests were **not** modified (outside
this consolidation's edit scope; flagged for user decision).

## 10. Runtime isolation result
The representative display path is read-only with respect to road geometry, trajectory, arrow, bridges, qlog
extraction, processing pipeline, pose, cache and fused geometry: `resolveRepresentativeMethod` only selects a
builder, and `_drawRepresentativeLaneLines` reads `map.pointAccumulated` and returns new polylines without
mutating those systems. `server.js` is **not** required for the new default selection (selection lives in
`public/render.js`; the candidate flag is set in `public/app.js`).

## 11. Proposed staging manifest totals
`proposed_staging_manifest.json`: `include_runtime` 18, `include_tests_and_tools` 16,
`include_docs_and_compact_evidence` 24 (individually named compact files, no broad report globs),
`exclude_or_defer` 18 grouped entries.

## 12. Files requiring patch-level staging
- `public/index.html`, `public/app.js`, `public/connected_accumulated_display.js` (mixed accepted + possible
  hybrid/experimental hunks).
- `tests/connected_accumulated_display.test.js` (possible experimental-method assertions).
- `tests/local_playback_geometry_modes.test.js`, `tests/local_playback_stationary.test.js` (stale fused-default
  expectations — update or exclude before staging).
- `server.js` is **excluded** and recommended for separate patch-level staging of its hybrid endpoints.

## 13. Excluded paths
`server.js`; `lib/hybrid_*`, `lib/lane_mapping_*`; `deliverables/hybrid_lane_map_v1/`;
`.checkpoint_test_backup/`, `.staged_snapshot_verify/`, `.segment0_correction_staging/`,
`.road_mirror_checkpoint_staging/`, `browser/`; `*.patch`; `notes.txt`; `scripts/*.txt`;
`scripts/apply_*|backup_*|build_*|stage_*|splice_*|rollback_*|archive_*|audit_*|capture_*|probe_*|compare_*|diagnose_*|trace_*|export_hybrid_*`;
generated `audit_segment2_lane_continuity_stage2..8.json`; broad generated report trees; hybrid reports;
prototype/snippet and hybrid tests; rejected-experiment tests/scripts; qlogs and videos.

## 14. Remaining risks
- Stale `fused`-default tests will fail until updated; they contradict the accepted default and should be
  resolved before/with staging.
- `public/connected_accumulated_display.js` mixes accepted builders with experimental helpers — patch-level
  staging recommended.
- `server.js` must not be committed as part of the display checkpoint.
- Live plain-load verification was not possible (server down); static + unit evidence used.
- 92-segment validation covers integrity/regression, not complete map correctness.
- Docs now describe the accepted direction but the broader ledger remains historical.

## 15. Exact files created by this task
`reports/display_orientation/accepted_display_consolidation/`:
- `default_selection_verification.json`
- `focused_test_results.json`
- `sync_verification.json`
- `proposed_staging_manifest.json`
- `CONSOLIDATION_REPORT.md` (this file)
Plus the backup directory listed in §3. No screenshots were created.

## 16. Branch, HEAD and staged-file count
Branch `experiment/candidate-layer-display`; HEAD `488c61b`; staged-file count **0**.

## 17. Commit / push status
No commit, no push, no staging. No `git reset`/`checkout`/`clean`/`restore`/`undo` used.

## 18. Verdict
**Ready for staging review** for the accepted display path, with the explicit caveats that (a) `server.js` is
excluded, (b) `public/index.html`, `public/app.js`, `public/connected_accumulated_display.js` and
`tests/connected_accumulated_display.test.js` need patch-level staging, and (c) the stale `fused`-default
tests require a user decision before a fully green suite. No blocking integrity issue was found.

---

Consolidation preparation only. purityRevisit algorithm and thresholds unchanged. No unrelated cleanup
performed. Nothing staged, committed, or pushed.
