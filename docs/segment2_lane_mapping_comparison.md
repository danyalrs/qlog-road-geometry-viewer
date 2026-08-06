# Segment 2 Lane-Mapping Reversible Comparison

**Generated:** 2026-08-05  
**Input:** `qlog_f449c_2.bz2`, Mode 5 (`geometrySource: 'cleaned'`)  
**Git:** No repository detected in workspace — baseline identified from audit artifacts, `lib/version.js` history, and feature-flag presets.

---

## 1. Baseline identification (pre–Stage 7/8)

| Item | Value |
|------|-------|
| **Last frozen VP processing version** | `2026-07-24-fusion-v11` (`docs/CURRENT_STATUS.md`, `docs/DECISIONS.md`) |
| **Stage 6 accepted lane checksum** | `ff6d115e` |
| **Stage 7 introduced** | `2026-07-24-fusion-v12`, `positiveBoundaryContinuityBridgeEnabled` |
| **Stage 8 introduced** | `2026-07-24-fusion-v13`, `visibleGapReconstructionEnabled` |
| **Reproducible flag preset (pre-7/8)** | `PRE_STAGE7_SEGMENT_OPTS` in `lib/lane_continuity_stage6.js` |

```javascript
PRE_STAGE7_SEGMENT_OPTS = {
  bimodalClusterSelection: true,
  positiveBoundaryContinuityBridgeEnabled: false,
  // visibleGapReconstructionEnabled defaults false
}
```

This matches the geometry accepted at the end of Stage 6 and the frozen v11 visual baseline for Segment 2.

---

## 2. Three-way comparison configurations

| Variant | Description | Flags | Lane | Coordinate | Road surface |
|---------|-------------|-------|------|------------|--------------|
| **A** | Earlier baseline (pre Stage 7/8) | `PRE_STAGE7` | `ff6d115e` | `6838c279` | `70457ea` |
| **B** | Current code, Stage 8 disabled | `PRE_STAGE8` | `10845acd` | `a418087f` | `70457ea` |
| **C** | Current code, Stages 7+8 disabled | `PRE_STAGE7` | `ff6d115e` | `6838c279` | `70457ea` |

**A ≡ C** on the current codebase (identical checksums and geometry). Variant A is the historical label; variant C confirms the same output is reproduced on `fusion-v13` with flags off.

| Metric | A / C | B |
|--------|-------|---|
| Fused fragments | 22 | 18 |
| Cleaned runs | 21 | 17 |
| Interpolated points | 0 | 0 |

Current production default (Stage 7+8 on): lane `10845acd`, coordinate `df4a32f1`, 34 interpolated points — **not** in this three-way set; included for reference only.

---

## 3. Screenshots (identical viewport per view)

**Directory:** `screenshots/segment2_lane_mapping_comparison/`  
**Manifest:** `capture_manifest.json`  
**Viewport:** 1280×800

| View | Files |
|------|-------|
| Full overview Mode 5 | `compare_{A,B,C}_overview_mode5.png` |
| PB1 540–660 m (gap markers) | `compare_{A,B,C}_pb1_540_660.png` |
| DC-010 zoom | `compare_{A,B,C}_DC-010.png` |
| DC-012 zoom | `compare_{A,B,C}_DC-012.png` |

All variants use the **same bounds** per view (derived from variant A reference geometry).

**Visual differences (expected):**

| Region | A / C (pre-7) | B (Stage 7 only) |
|--------|---------------|------------------|
| DC-009, DC-011 | Open run breaks or shorter runs | Merged runs; renderer may connect (≤15 m jumps) |
| DC-010, DC-012 | Separate runs / visible endpoint gap | Single merged run; **18 m / 16 m visual gap** remains (structural only) |
| Global topology | 22 fused fragments, 21 cleaned runs | 18 fused, 17 cleaned runs |
| PB0 / PB2 | Unchanged | Unchanged (Stage 7 PB1-only rule) |

`compare_A_*` and `compare_C_*` PNGs should be visually identical.

---

## 4. Configuration differences affecting output

| Layer | A / C (pre-7/8) | B (Stage 7, no Stage 8) | Production (7+8 on) |
|-------|-------------------|-------------------------|---------------------|
| **Pose transformation** | GPS interpolation via `interpolateGpsAtTime`; same `pipelineMode: 'C'` | *Same* | *Same* |
| **Observation accumulation** | `collectLaneObservations` + binning; same thresholds | *Same* | *Same* |
| **Fusion — tracker bridge** | PB0 outer-boundary bridge only (`trackerContinuityBridgeEnabled: true`) | **+ PB1 positive-boundary bridge** (`positiveBoundaryContinuityBridgeEnabled: true`) | *Same as B* |
| **Fusion — PB1 gates** | No positive cluster bridge | min gap 12 m, max 18 m, ≥6 obs, per-cluster leftmost positive track | *Same* |
| **Fusion — bimodal** | `bimodalClusterSelection: true` | *Same* | *Same* |
| **Cleanup — merge** | 22→21 fragment/run topology | 18→17 (structural joins at DC-009–012) | *Same as B* |
| **Cleanup — Stage 8 interpolation** | Off | Off | **On** — `applyVisibleGapReconstruction`, ≤1 m spacing |
| **Pass separation** | Unchanged (chunk 0, pass 0) | *Same* | *Same* |
| **D12 preservation** | Enabled | *Same* | *Same* |
| **Renderer 15 m stroke break** | Unchanged | *Same* | *Same* |
| **Processing version string** | `fusion-v13` (code) | `fusion-v13` | `fusion-v13` |
| **Cache key** | Includes `PROCESSING_VERSION` + options JSON | Different options → different cache key | Different |

**Unchanged across all variants:** road-surface generator (`70457ea`), GPS/pose pipeline, pass/chunk separation, lane-tracking thresholds, D12 preservation rules, canvas 15 m polyline break.

---

## 5. Reversible activation (no code deletion)

Stage 7/8 implementation remains intact. To switch baselines:

| Target | `loadSegment` / `processRoute` options |
|--------|------------------------------------------|
| **Pre-7/8 visual baseline (recommended)** | `PRE_STAGE7_SEGMENT_OPTS` |
| Stage 7 structural only | `PRE_STAGE8_SEGMENT_OPTS` |
| Full Stage 8 | `positiveBoundaryContinuityBridgeEnabled: true`, `visibleGapReconstructionEnabled: true` |

Re-run comparison:

```bash
node scripts/export_segment2_lane_mapping_comparison.js
node scripts/capture_segment2_lane_mapping_comparison.js
```

---

## 6. Recommendation

### Active visual baseline: **Variant A / C (`ff6d115e`, pre–Stage 7/8)**

**Rationale:**

1. Matches the last **frozen VP geometry** (`fusion-v11` era) and Stage 6 accepted accounting.
2. Preserves **honest run boundaries** — gaps at DC-010/DC-012 remain visibly open rather than structurally merged or interpolated.
3. Avoids Stage 7 fragment-identity merges that changed topology (22→18 fragments) without consistent visual improvement across all four targets.
4. Stage 8 interpolation is valuable for diagnostics but introduces synthetic coordinates that are not required for the default map view.

### Preserve newer work behind flags

| Feature | Flag | Default recommendation |
|---------|------|------------------------|
| Stage 7 PB1 structural bridge | `positiveBoundaryContinuityBridgeEnabled` | **`false`** (restore pre-7 visuals) |
| Stage 8 visible interpolation | `visibleGapReconstructionEnabled` | **`false`** (already opt-in) |

**Suggested production defaults** (configuration only — no geometry rewrite):

```javascript
// loadSegment / processRoute defaults
positiveBoundaryContinuityBridgeEnabled: false,
visibleGapReconstructionEnabled: false,
```

Keep `PROCESSING_VERSION` at `fusion-v13` for cache invalidation; behavior is controlled by flags. Stage 7/8 remain available for audits, diagnostics, and explicit opt-in.

### Next evidence-supported action

1. Flip production defaults to `PRE_STAGE7_SEGMENT_OPTS` if visual baseline approval is confirmed.
2. Retain Stage 7/8 tests and audits behind explicit flag-enabled paths (already supported).
3. Optional: add UI toggle or diagnostics banner showing active flag state vs checksum.

---

## Artifacts

| File | Purpose |
|------|---------|
| `audit_segment2_lane_mapping_comparison.json` | Checksums + variant metadata |
| `screenshots/segment2_lane_mapping_comparison/` | 12 PNGs + manifests |
| `scripts/export_segment2_lane_mapping_comparison.js` | Reproducible scene export |
| `scripts/capture_segment2_lane_mapping_comparison.js` | Puppeteer capture |
