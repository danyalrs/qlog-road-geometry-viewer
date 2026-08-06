# Segment 2 Road-Surface Stage 1 Report

**Segment:** `qlog_f449c_2.bz2`  
**Generated:** 2026-08-04  
**Lane-map baseline:** Mode 5 (frozen — no lane geometry modified)

## Summary

Stage 1 identifies adjacent physical-boundary pairs with overlapping accepted support, splits at every unsupported break, and builds conservative polygon strips from accepted boundary coordinates only.

| Metric | Value |
|--------|-------|
| Candidate boundary pairs | **2** (`BP-PB1-PB0`, `BP-PB2-PB1`) |
| Eligible boundary pairs | **2** |
| Rejected boundary pairs | **0** |
| Polygon components generated | **14** |
| Total supported polygon length | **177.4 m** |
| Total polygon area | **537.7 m²** |
| Unsupported breaks retained | **44** |
| Self-intersections | **0** |
| Polygon overlaps | **0** |
| Computed sampling points | **58** (on-segment interpolation only) |

### Width distribution (observed before limit selection)

| Stat | Metres |
|------|--------|
| Sample count | 100 |
| Min | 2.62 |
| p05 | 2.70 |
| Median | 3.00 |
| p95 | 3.86 |
| Max | 4.51 |
| Selected min plausible | 2.29 |
| Selected max plausible | 4.43 |

## Boundary-pair definitions

| Pair ID | Left PB / tracks | Right PB / tracks | Lane strip |
|---------|------------------|-------------------|------------|
| `BP-PB1-PB0` | PB1 (tracks 1, 2) | PB0 (track 0) | Main carriageway |
| `BP-PB2-PB1` | PB2 (track 3) | PB1 (tracks 1, 2) | Outer-left lane |

Road-surface IDs are separate from PB IDs, track IDs, cleaned-run IDs and fused-fragment IDs.

## Open-gap controls (no polygon spans interior)

| Control | Route-s interval | Polygon spans? |
|---------|------------------|----------------|
| CD-10 (1.466 m) | 428.76 – 430.22 | **No** |
| CD-12 (1.640 m) | 498.48 – 500.12 | **No** |
| CD-18 (1.476 m) | 428.76 – 430.23 | **No** |
| CD-01 D10 | 101.42 – 128.15 | **No** |
| 240 m dropout | 92.49 – 332.43 | **No** |
| Class-F gaps (×4) | per separation | **No** |
| D6 gaps (×12) | per gap on owning PB | **No** |

CD-00 and CD-02 receive surface only where PB1–PB0 overlap exists (preserved D12 intervals).

## Mode 5 baseline unchanged

| Check | Result |
|-------|--------|
| Mode 5 lane checksum | `5283af91` (before = after) |
| Mode 5 road-surface count | **0** |
| Cleaned logical runs | **28** |
| Fused fragments | **33** |
| Lane coordinates modified | **No** |

## Prototype display mode

New geometry source: `cleanedWithStage1Surface` (prototype only — not wired to main UI).

- Mode 5 remains lane lines only.
- Prototype mode draws accepted lane boundaries + translucent road-surface fills.
- Each polygon component is drawn separately.
- Geometry is stationary across timeline indices 0 and 16.

### Rendering diagnosis (2026-08-04 recapture)

Initial screenshots showed lane lines only. Root cause:

1. **Mode was correct** (`cleanedWithStage1Surface`) but not labeled in the HUD.
2. **Renderer received 14 polygons** — confirmed in scene JSON and capture manifest (`polygonsDrawn=14/14`).
3. **Visibility toggle was enabled** (`showRoadSurface: true`) but not displayed.
4. **Fill was too faint** — `rgba(59,130,246,0.22)` at overview scale (~1.9 px/m) was below visible threshold on white.

Fix applied in `d12_geometry_verify.html`:

- Explicit white canvas background before draws
- Surfaces drawn **before** lane boundaries
- Fill: `rgba(255, 165, 0, 0.30)` with thin outline `rgba(180, 83, 9, 0.85)`
- Stage 1 HUD: mode, polygon count, surface visibility, lane checksum, timeline index

Recaptured screenshots (harness v2) show orange fill components. Pixel sampling: ~0.01–0.02% orange pixels on overview (thin strips at overview zoom); close-ups show fill clearly between boundaries.

### Screenshots

| Target | File |
|--------|------|
| Overview | [stage1_overview_t0.png](../screenshots/segment2_road_surface_stage1/stage1_overview_t0.png) |
| CD-10 | [stage1_CD-10_t0.png](../screenshots/segment2_road_surface_stage1/stage1_CD-10_t0.png) |
| CD-12 | [stage1_CD-12_t0.png](../screenshots/segment2_road_surface_stage1/stage1_CD-12_t0.png) |
| CD-18 | [stage1_CD-18_t0.png](../screenshots/segment2_road_surface_stage1/stage1_CD-18_t0.png) |
| CD-01 control | [stage1_CD-01_D10_control_t0.png](../screenshots/segment2_road_surface_stage1/stage1_CD-01_D10_control_t0.png) |
| D6 control | [stage1_D6_control_t0.png](../screenshots/segment2_road_surface_stage1/stage1_D6_control_t0.png) |
| Class-F control | [stage1_classF_control_t0.png](../screenshots/segment2_road_surface_stage1/stage1_classF_control_t0.png) |
| 240 m dropout | [stage1_dropout_240m_t0.png](../screenshots/segment2_road_surface_stage1/stage1_dropout_240m_t0.png) |

## Artifacts

| Artifact | Path |
|----------|------|
| Eligibility audit | `audit_segment2_road_surface_eligibility.json` |
| Polygon validation audit | `audit_segment2_road_surface_polygons.json` |
| Implementation | `lib/road_surface_stage1.js` |
| Audit script | `scripts/audit_segment2_road_surface_stage1.js` |
| Tests | `tests/local_playback_road_surface_stage1.test.js` (23 tests) |
| Capture manifest | `screenshots/segment2_road_surface_stage1/capture_manifest.json` |

## Test results

- Stage 1 targeted tests: **23/23 pass**
- D12 rendering + preservation regression: **pass**
- Full suite: **897/907** (10 pre-existing failures; +23 Stage 1 tests; no new failures)

## Main-UI integration

**Not ready.** The main browser `lane_map_cleanup.js` bundle remains broken (`require` in browser). Prototype mode works in the authoritative verification harness (`d12_geometry_verify.html`) only.

## Next evidence-supported action

Visual inspection of prototype screenshots, then Stage 2 refinement (coverage expansion review, overlap policy, main-UI bundle repair for integrated prototype mode).
