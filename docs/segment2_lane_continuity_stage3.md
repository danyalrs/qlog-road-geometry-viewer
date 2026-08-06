# Segment 2 Lane Continuity — Stage 3 (DC-014)

Stage 3 investigates the D10 lateral spike blocking DC-014 at s≈101–128 m and applies a proven, general bin-aggregation correction.

## Accepted inputs

| Item | Value |
|------|-------|
| Stage 2 lane checksum | `fa3dac79` |
| Stage 2 fused fragments | 23 |
| Stage 2 cleaned runs | 22 |
| Stage 2 visible disconnections | 12 |
| Stage 2 repaired | DC-019, DC-020, DC-021, DC-023 |
| Stage 2 unresolved | DC-014, DC-022, DC-024 |

## Stage 1 / Stage 2 candidate reconciliation

Stage 1 reported **13** `fusion_pairing` candidates:

| ID | PB | Stage 2/3 disposition |
|----|----|-----------------------|
| DC-006, DC-008–DC-012 | PB1 | Outside PB0 — not targeted by Stage 2/3 |
| DC-014 | PB0 | **Stage 3 primary target** |
| DC-019–DC-024 | PB0 | Stage 2 PB0 fusion-pairing scope (7 candidates) |

Stage 2’s “7 candidates” is correct: the other six are PB1 parallel-boundary gaps at similar route-s intervals.

## DC-014 root cause

| Field | Result |
|-------|--------|
| First failing stage | **5 — bin aggregation** |
| Spike bin | **58** (s≈116 m) |
| Unimodal fused d | −9.01 m |
| Corrected fused d | −1.47 m |
| Expected trajectory d | ≈ −3.39 m |
| Lateral residual (prelim − expected) | ≈ −5.62 m |
| Source | Bimodal cluster contamination (frames 2523/2563 projected track-0 laterals ≈ −28 m mixed with valid ≈ −1.5 m cluster) |
| MAD filter | Spread 7.52 m — all values kept as inliers |

Raw modelV2 frames 2523/2563 contribute bad track-0 projections, but the **first pipeline stage where the spike becomes fused geometry** is bin aggregation.

## Repair (verdict E + F)

1. **E — bin aggregation** (`selectBimodalCluster` / `aggregateFusedBin`)
   - Detect ≥2 lateral clusters separated by `maxLateralJumpM`
   - Require contamination evidence (multi-cluster, MAD spread, or unimodal/neighbour mismatch)
   - Select cluster closest to neighbour-interpolated trajectory
   - Two-pass aggregation with rolling corrected previous-bin context
   - Outer-boundary track (PB0) only

2. **F — fusion compatibility** (`canBridgeTrackerContinuousFusionGap`)
   - When a bimodal-corrected bin would have been spike-blocked under unimodal aggregation (`|preliminaryD − prev.d| > 2×maxLateralJumpM`) and rejection delta ≥ 4 m, allow bridge join lateral up to `maxLateralJumpM` (not global threshold change)

## Geometry after Stage 3

| Metric | Stage 2 | Stage 3 |
|--------|---------|---------|
| Lane checksum | `fa3dac79` | `ff6d115e` |
| Fused fragments | 23 | 22 |
| Cleaned runs | 22 | 21 |
| Visible disconnections | 12 | 18 |
| DC-014 | Open | **Closed** |
| DC-013 / DC-015 | Open | Open |
| All 8 unsafe gaps | Open | Open |
| DC-019/020/021/023 | Repaired | Repaired |
| DC-022 / DC-024 | Unchanged | Unchanged |
| PB1 / PB2 displacement | 0 m | 0 m |

## Road-surface checksum accounting

| Checksum | Meaning |
|----------|---------|
| `26ae09b9` | Frozen Stage 1 baseline (14 polygons) — **obsolete** |
| `cd437093` | Stage 2 bridge-only surface (13 polygons) |
| `70457ea` | Stage 3 after bimodal lane correction |

Stage 3 lane repair changes PB0 geometry; road-surface polygons are **regenerated from lane dependency** without modifying road-surface generator code. Browser and Node use the same polygon set per build.

## Artifacts

- `audit_segment2_lane_continuity_stage3.json`
- `lib/lane_continuity_stage3.js`
- `tests/local_playback_lane_continuity_stage3.test.js`
- `screenshots/segment2_lane_continuity_stage3/`

## Tests

Stage 1 (15), Stage 2 (27), Stage 3 (24), D12 (32), cleanup (19), class-D fusion (28) — **145/145 pass**.

## Next action

Investigate DC-022 and DC-024 under the same evidence framework (Stage 2 left them unresolved at fusion-trace level while main-chain geometry may already be continuous).
