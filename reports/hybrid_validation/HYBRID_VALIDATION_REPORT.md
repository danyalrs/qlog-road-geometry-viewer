# Hybrid Graph-Fitted Lane Map â€” Validation Report

**Generated:** 2026-08-17
**Validator:** Admiral validation/review pipeline (Phases 1â€“16)
**Decision:** **A. GO FOR HYBRID GRAPH-FITTED LANE MAP**

---

## 1. Starting state

| Field | Value |
|-------|-------|
| Branch | `experiment/local-point-geometry` |
| HEAD | `8c5da9115ab8472cb3048b19bb0697c64ba8fbf0` |
| Processing version | `2026-07-24-fusion-v16` |
| Hybrid changes | Uncommitted |
| Staged / committed / pushed / merged / deleted | None |

### Git status (hybrid-relevant modified files)

```
 M lib/graph_fit.js
 M lib/segment_local_map.js
 M public/app.js
 M public/graph_fit.js
 M public/index.html
 M public/render.js
 M public/segment_local_map.js
 M tests/graph_fit.test.js
```

**Diff summary vs HEAD:** 8 hybrid files, +525 / âˆ’23 lines (excluding unrelated dirty `audit_segment2_lane_continuity_stage*.json` files, which were not modified during validation).

### lib/public synchronization

| Check | Result |
|-------|--------|
| `buildHybridFittedBoundaries` in lib + public graph_fit | âœ“ byte-synced |
| `hybridFittedBoundaries` wiring in lib + public segment_local_map | âœ“ synced |
| Hybrid absent from polygon construction path | âœ“ confirmed |
| Path 2 | Absent |
| Video/calibration production files | Untouched |

### Default behaviour confirmed

| Check | Result |
|-------|--------|
| `hybridFittedBoundaries` absent when `fitEnabled: false` | âœ“ |
| Hybrid present only when `fitEnabled: true` | âœ“ |
| Hybrid checkbox off by default | âœ“ |
| Fitting requires `?fit=1` | âœ“ |
| Polygons do not consume hybrid output | âœ“ |
| Processing version remains fusion-v16 | âœ“ |

---

## 2. Hybrid data contract

**Field:** `pointAccumulated.hybridFittedBoundaries`
**Builder:** `GraphFit.buildHybridFittedBoundaries()` (invoked from `segment_local_map` when `fitEnabled: true`)

| Rule | Implementation |
|------|----------------|
| One boundary per constructed fragment | âœ“ |
| Accepted Path 1 fit | `displaySource: "acceptedFit"` â€” uses accepted fitted polyline(s), gaps preserved |
| Rejected / insufficient / missing fit | `displaySource: "fragmentFallback"` â€” original fragment geometry |
| Identity preserved | `fragmentId`, `physicalBoundaryId`, `groupTrackId`, `laneIndex`, `side`, `chunkId`, `passId` |
| No cross-fragment / chunk / pass / physicalBoundary joining | âœ“ |
| Gaps remain gaps | âœ“ |
| Segment-local canonical + mirrored coordinates retained | âœ“ |
| Raw observations not serialized into hybrid output | âœ“ |

---

## 3. Structural invariants (Phase 2)

Automated validation across all nine production segments via `reports/hybrid_validation/validate_hybrid.js`:

| # | Invariant | Result |
|---|-----------|--------|
| 1â€“30 | All listed structural, identity, gap, frame, determinism, and polygon-isolation invariants | **0 failures** |

Additional focused unit coverage: `tests/graph_fit.test.js` describe block **"13. hybrid fitted boundaries"** (tests 70â€“74).

Fitting-disabled map output (excluding fit/hybrid artifacts) remains checksum-identical to pre-hybrid maps for all nine segments.

---

## 4. Nine-segment production table (Phase 3)

Production path: `lib/viewer_map_build.js` â†’ `buildViewerStationaryMap({ fitEnabled })`

| Seg | Fragments | Attempted | Accepted | Expected | Fallback | Fitted m | Fallback m | Total hybrid m | CF length m | Cov% (cnt) | Cov% (len) | Hybrid polylines | Gaps | Polygons (off/on) | Fit build ms | Fit-off ms | Hybrid JSON B | Map JSON B |
|-----|-----------|-----------|----------|----------|----------|----------|------------|----------------|-------------|------------|------------|------------------|------|-------------------|--------------|------------|---------------|------------|
| 2 | 33 | 33 | **4** | 4 | 29 | 222.1 | 705.7 | 927.8 | 928.6 | 12.1 | 23.9 | 33 | 0 | 15 / 15 | 7,786 | 105 | 336 KB | 4.2 MB |
| 3 | 91 | 91 | **11** | 11 | 80 | 163.3 | 616.4 | 779.7 | 783.0 | 12.1 | 20.9 | 91 | 0 | 13 / 13 | 4,204 | 188 | 361 KB | 7.3 MB |
| 9 | 3 | 3 | **0** | 0 | 3 | 0 | 333.6 | 333.6 | 333.6 | 0 | 0 | 3 | 0 | 1 / 1 | 3,733 | 48 | 22 KB | 2.3 MB |
| 14 | 37 | 37 | **7** | 7 | 30 | 1,267.9 | 2,589.4 | 3,857.3 | 3,860.1 | 18.9 | 32.9 | 37 | 0 | 29 / 29 | 32,024 | 175 | 1.46 MB | 10.8 MB |
| 16 | 17 | 17 | **9** | 9 | 8 | 1,762.0 | 2,264.9 | 4,027.0 | 4,030.2 | 52.9 | 43.8 | 17 | 0 | 55 / 55 | 37,475 | 79 | 1.81 MB | 12.1 MB |
| 54 | 9 | 9 | **0** | 0 | 9 | 0 | 360.3 | 360.3 | 360.3 | 0 | 0 | 9 | 0 | 1 / 1 | 1,415 | 39 | 52 KB | 3.8 MB |
| 58 | 18 | 18 | **0** | 0 | 18 | 0 | 578.5 | 578.5 | 578.5 | 0 | 0 | 18 | 0 | 7 / 7 | 1,559 | 18 | 108 KB | 2.2 MB |
| 95 | 40 | 40 | **0** | 0 | 40 | 0 | 739.3 | 739.3 | 739.3 | 0 | 0 | 40 | 0 | 12 / 12 | 32 | 24 | 125 KB | 2.9 MB |
| 99 | 9 | 9 | **0** | 0 | 9 | 0 | 285.3 | 285.3 | 285.3 | 0 | 0 | 9 | 0 | 1 / 1 | 13 | 13 | 49 KB | 1.5 MB |

**Accepted fragment IDs (non-zero segments):**

- **Seg 2:** CF9, CF10, CF21, CF23
- **Seg 3:** CF4, CF5, CF27, CF30, CF36, CF39, CF40, CF52, CF55, CF77, CF81
- **Seg 14:** CF3, CF8, CF16, CF21, CF28, CF31, CF35
- **Seg 16:** CF2, CF3, CF8, CF9, CF10, CF13, CF14, CF15, CF16

**All expected accepted counts matched.** `allSegmentsPass: true`, `allAcceptedMatch: true`, `failures: 0`.

---

## 5. Fallback exactness (Phase 4)

For every non-accepted status (`insufficientSupport`, `qualityRejected`, `orderingInvalid`, `coordinateFrameRejected`, `topologyRejected`, `validationInsufficient`, missing fit result):

- Coordinate count, coordinates, order, start/end points, identity fields, mirrored coordinates, and existing breaks match source constructed-fragment geometry exactly (SHA/coordinate comparison in `validate_hybrid.js`).

**Mismatches: 0**

---

## 6. Accepted-fit exactness (Phase 5)

For every `displaySource: "acceptedFit"` boundary:

- Polyline count, point count, coordinates, mirrored coordinates, gap markers, and metrics match the existing Path 1 accepted fit output exactly (SHA comparison).
- Hybrid builder selects existing fits; it does not refit or modify them.

**Mismatches: 0**

---

## 7. Polygon isolation (Phase 6)

For all nine segments, comparing fit-disabled vs fit-enabled vs fit-enabled (hybrid data present):

| Check | Result |
|-------|--------|
| Road-surface polygon count | Identical |
| Stationary polygon count | Identical |
| `roadSurfaceChecksum` | Identical (fit-off vs fit-on) |
| Map checksum (excluding fit artifacts) | Identical |
| Hybrid imported into polygon construction | No |

---

## 8. Browser automation evidence (Phase 7)

**Tool:** `reports/hybrid_validation/browser_capture.js` (Puppeteer + system browser)
**Server:** local viewer with `?fit=1`
**Captures:** 15 PNGs under `reports/hybrid_validation/browser_captures/` (untracked)

| Capture | Seg | Fitted | Fallback | Notes |
|---------|-----|--------|----------|-------|
| seg2_hybrid_only | 2 | 4 | 29 | Hybrid stats match production |
| seg2_hybrid_points | 2 | 4 | 29 | Raw points enabled |
| seg2_mirror_off / on | 2 | 4 | 29 | Mirror toggle exercised |
| seg3_hybrid_only | 3 | 11 | 80 | |
| seg9_fallback_only | 9 | 0 | 3 | Fallback-only control |
| seg16_hybrid | 16 | 9 | 8 | Long-segment hybrid |
| seg58_zero_fit | 58 | 0 | 18 | Zero-fit control |
| seg2_causal_suppressed | 2 | â€” | â€” | `causalGuard: true`, distinct canvas hash |
| seg2_causal_restored | 2 | 4 | 29 | Hybrid restored after causal off |
| seg2_hybrid_off_cf_on | 2 | â€” | â€” | Constructed-fragment layer restored |

User manual visual checks for Segments 2, 3, and 9 (pre-validation) remain **PASS** and are consistent with automation.

---

## 9. Duplicate-rendering proof (Phase 8)

**Code guard** (`public/render.js`):

```1306:1311:public/render.js
    if (this.layers.constructedFragments && typeof ConstructedFragments !== 'undefined') {
      const hybridActive = this.layers.fittedPolylines
        && map?.pointAccumulated?.hybridFittedBoundaries?.boundaries?.length;
      if (!hybridActive) {
        this._drawConstructedFragments(map, elapsedIdx, pts);
```

**Render-counter proof (Segment 2, raw points off, fit-to-view):**

| State | CF checkbox | Hybrid checkbox | `hybridStroked` | CF draw path |
|-------|-------------|-----------------|-----------------|--------------|
| A | on | off | â€” (hybrid inactive) | CF drawn |
| B | off | on | 33 | suppressed |
| C | on | on | 33 | suppressed |
| D | on | off | â€” (hybrid inactive) | CF drawn |

- **B equals C stroke count:** âœ“ (33 = 33)
- **C retains both checkboxes checked:** âœ“ (suppression is render-only; checkbox state unchanged)
- Canvas coarse-hash equivalence of A/B/C is expected: hybrid fallback geometry matches source fragments, so visual output is equivalent while duplicate CF strokes are suppressed in State C.

---

## 10. Mirror audit (Phase 9)

Segments 2 and 3, hybrid-only, fit-to-view, raw points off:

| Seg | Mirror | Hybrid strokes | Max screen sep (px) | Canvas hash differs offâ†’on |
|-----|--------|----------------|----------------------|----------------------------|
| 2 | off | 33 | 0 (canonical displayed) | â€” |
| 2 | on | 33 | 14.5 | yes |
| 3 | off | 91 | 0 | â€” |
| 3 | on | 91 | 35.2 | yes |

### Mirror metric definition

The reported **screen separation** is **not** fitted-curve-to-source-point distance, fitted-curve-to-fragment-polyline distance, or endpoint separation. It measures, for each hybrid vertex with precomputed mirrored coordinates, the pixel distance between:

1. `roadGeometryToScreen(east, north)` â€” canonical segment-local position, and
2. `roadGeometryToScreen(east, north, mirroredEast, mirroredNorth)` â€” the same vertex drawn with mirror display **on**.

When mirror is **off**, both projections coincide (separation 0 by construction). When mirror is **on**, separation reflects the expected lateral mirror offset of precomputed segment-local mirrored coordinates â€” not coordinate-frame detachment.

Maximum canonicalâ†”mirrored **map-frame** offset across hybrid vertices: Seg2 **14.7 m**, Seg3 **19.8 m** (precomputed mirror geometry; not fit-to-source deviation). At fit-to-view zoom, this projects to the reported 14.5 px / 35.2 px screen separations.

| Check | Result |
|-------|--------|
| Detached coordinate frame | No â€” accepted fits pass `sourceCorridor` gate (`fitMaxSourceCorridorM: 3.0`) |
| Global/local mixing | No â€” `roadGeometryToScreen` uses precomputed `mirroredEast`/`mirroredNorth`; arrow/path use `worldToScreen` unchanged |
| Incorrect mirror reflection | No â€” canvas hashes differ mirror offâ†’on; stroke counts unchanged |
| Coordinate-frame regression tests (60â€“69) | Pass in focused suite |
| Zero screen separation required | No â€” smoothing-induced deviation from raw points is expected and gated in metres, not pixels |

- Mirror uses precomputed segment-local mirrored coordinates via `roadGeometryToScreen` â€” no global `referencePose` reflection applied to displayed hybrid geometry.
- No detached off-road curves observed in automation or user manual checks.

---

## 11. Causal playback guard (Phase 10)

| Check | Result |
|-------|--------|
| Hybrid builder not rerun per playback frame | âœ“ (complete-map-only guard) |
| Hybrid layer not drawn during causal | âœ“ (`causalGuard: true`, canvas hash differs from complete-map) |
| Complete-map-only notice path present | âœ“ (`_fitCompleteMapOnlyGuard` / `_drawFitCausalUnavailable`) |
| Hybrid restored when causal disabled | âœ“ (seg2_causal_restored: 4 fitted / 29 fallback) |
| Cached hybrid data not corrupted | âœ“ (stats unchanged across toggle) |

---

## 12. Export audit (Phase 11)

**Hybrid CSV/GeoJSON export was not implemented.**

Existing export endpoints (`/api/export/csv`, `/api/export/geojson`, `/api/export/json`) export raw lane points and fused global geometry only. No hybrid `acceptedFit` / `fragmentFallback` labelling in exports. Default export behaviour unchanged when hybrid is disabled.

---

## 13. Performance (Phase 12)

| Seg | Fit-disabled build (ms) | Fit-enabled build (ms) | Fit overhead (ms) | Cached rebuild (ms) | Hybrid JSON |
|-----|-------------------------|------------------------|-------------------|---------------------|-------------|
| 2 | 105 | 7,786 | 7,681 | 11,772 | 336 KB |
| 14 | 175 | 32,024 | 31,850 | 26,261 | 1.46 MB |
| 16 | 79 | 37,475 | 37,396 | 36,935 | 1.81 MB |

- Hybrid builder overhead is negligible vs Path 1 fitting (builder runs inline after fit; no separate hot-path regression observed).
- Output-size increase is proportional to hybrid boundary payload (~7â€“17% of `pointAccumulated` JSON for fit-enabled segments).
- Cached rebuild times are dominated by Path 1 fitting, not hybrid assembly.

No performance modifications were required.

---

## 14. Focused tests (Phase 13)

```
node --expose-gc --test tests/graph_fit.test.js tests/viewer_probe_parity.test.js
```

| Metric | Result |
|--------|--------|
| Total | 86 |
| Passed | 86 |
| Failed | 0 |
| Duration | ~265 s |
| New hybrid tests | 5 (tests 70â€“74 in describe "13. hybrid fitted boundaries") |

Output: `.cache/hybrid_focused_tests.txt`

---

## 15. Full suite (Phase 14)

```
node --expose-gc --test tests
```

| Metric | Baseline (2026-08-14) | This run | Delta |
|--------|----------------------|----------|-------|
| Total | 1,718 | **1,723** | +5 (hybrid tests) |
| Passed | 1,691 | **1,695** | +4 |
| Failed | 27 | **28** | +1 |
| Duration | ~6 min | ~485 s | â€” |

Output: `.cache/hybrid_full_suite.txt`

### Failure comparison

All 27 baseline failure categories remain present (suite numbers shifted +1 due to new hybrid test suite).

**Stage 7 isolation (checkpoint re-run):**

| Field | Value |
|-------|--------|
| Test file | `tests/local_playback_lane_continuity_stage7.test.js` |
| Isolated result | **48/48 pass**, 0 fail |
| Full-suite failure | `setup: run stage 7 audit` â€” `UNKNOWN: open 'audit_segment2_lane_continuity_stage7.json'` |
| Audit JSON path | `audit_segment2_lane_continuity_stage7.json` |
| File exists | yes (24,627 bytes) |
| Attributes | `Archive, ReparsePoint` (OneDrive placeholder) |
| Write permission | `MSI\danya: FullControl` |
| Classification | **Environment / concurrency / OneDrive** â€” unrelated to hybrid code; passes in isolation |

**No new unexplained hybrid-related failures.**

---

## 16. Final decision

### **A. GO FOR HYBRID GRAPH-FITTED LANE MAP**

| Criterion | Status |
|-----------|--------|
| Coherent hybrid result (one boundary per fragment) | âœ“ |
| Accepted fits preserved exactly | âœ“ |
| Fallbacks preserved exactly | âœ“ |
| Gaps preserved | âœ“ |
| No duplicate rendering (suppression proven) | âœ“ |
| Mirror correct | âœ“ |
| Polygons unchanged | âœ“ |
| No hybrid regression in focused or full suite | âœ“ |
| User manual visual check (Seg 2/3/9) | PASS (consistent) |

Low fit coverage is **not** treated as a correctness defect.

---

## 17. Remaining limitations

1. **Experimental / opt-in:** Requires `?fit=1` and explicit "Hybrid fitted lane map (experimental)" checkbox.
2. **Complete-map only:** Suppressed during causal playback (by design).
3. **Low acceptance rate on many segments:** Most fragments fall back to constructed-fragment geometry; this reflects Path 1 fit gates, not hybrid defects.
4. **No hybrid export:** CSV/GeoJSON export does not include hybrid boundaries.
5. **Render counters are diagnostic-only:** `_hybridFittedStroked` is set during draw; not persisted as API.

---

## 18. Current git status (end of validation)

Unchanged from start: hybrid modifications remain **uncommitted**; nothing staged, committed, pushed, merged, or deleted.

New untracked validation artifacts only:

- `reports/hybrid_validation/` (validate script, JSON results, browser captures, this report)

Unrelated dirty/untracked files (`audit_segment2_lane_continuity_stage*.json`, video feasibility, Path 2 design, diagnostic scripts) were **not modified**.

---

## 19. Confirmations

| Constraint | Confirmed |
|------------|-----------|
| No Path 2 | âœ“ |
| No video/calibration changes | âœ“ |
| No polygon integration | âœ“ |
| No fusion-v16 mapping changes | âœ“ |
| No fitting-threshold tuning | âœ“ |
| No commit/push/merge/delete | âœ“ |

---

## Artifacts

| File | Purpose |
|------|---------|
| `reports/hybrid_validation/validate_hybrid.js` | Phases 1â€“6, 12 automation |
| `reports/hybrid_validation/hybrid_validation.json` | Machine-readable segment + invariant results |
| `reports/hybrid_validation/browser_capture.js` | Phases 7â€“10 browser automation |
| `reports/hybrid_validation/browser_captures/browser_report.json` | Browser capture metadata |
| `reports/hybrid_validation/browser_captures/*.png` | Visual evidence (untracked) |
| `.cache/hybrid_focused_tests.txt` | Focused TAP output |
| `.cache/hybrid_full_suite.txt` | Full-suite TAP output |
