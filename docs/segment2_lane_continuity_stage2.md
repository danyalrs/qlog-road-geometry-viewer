# Segment 2 Lane-Continuity Stage 2

Generated: 2026-08-04

## Scope

Targeted PB0 fusion-pairing repair on Segment 2 (`qlog_f449c_2.bz2`). Stage 1 artifacts are preserved unchanged.

## Root cause

**Function:** `fuseLaneTrackSdFragments` in `lib/sd_fusion.js`  
**Condition:** `ds > maxLaneFragmentGapM` (10 m) splits consecutive accepted fusion bins into separate fragments even when:

- the same lane track (track 0) remains continuous in the tracker;
- mapped observations span the gap (≥2 obs, ≥2 frames);
- fused-bin endpoints are laterally and heading compatible (`endpointCompatibility`).

Tracker continuity did not propagate because fragment construction applied a fixed 10 m bin-spacing rule (D11) without evaluating cross-gap tracker support.

## Fix implemented

Added `canBridgeTrackerContinuousFusionGap()` and `isOuterBoundaryTrack()`:

- Bridge only on the **right-side outer boundary track** (PB0 / track 0 in Segment 2).
- Gap must be >10 m and <28 m (below 30 m dropout scale).
- Requires mapped observations and frames in the gap interval.
- Uses `endpointCompatibility` with next-bin heading context (rejects DC-013 heading mismatch).
- Does not bridge lateral-jump splits (`D10`) or left-side tracks (PB2 unchanged).

## Geometry change

| Metric | Before | After |
|--------|--------|-------|
| Mode 5 lane checksum | `5283af91` | `fa3dac79` |
| Fused fragments | 33 | 23 |
| Cleaned runs | 28 | 22 |
| Visible disconnections | 25 | 12 |
| PB0 disconnections | 12 | 6 |

## PB0 repair results

| Stage 1 ID | Gap (m) | Result |
|------------|--------:|--------|
| DC-019 | 22.5 | **Repaired** |
| DC-020 | 24.0 | **Repaired** |
| DC-021 | 13.1 | **Repaired** |
| DC-023 | 12.0 | **Repaired** |
| DC-014 | 26.7 | Unresolved — lateral spike at intermediate bin (D10) |
| DC-022 | 18.0 | Unresolved — cleanup still separates after partial fusion |
| DC-024 | 16.3 | Unresolved — cleanup still separates after partial fusion |

4 of 7 PB0 `fusion_pairing` candidates repaired. The main PB0 chain (s≈381–690 m) is now a single cleaned run.

## Unsafe gaps — all remain open

DC-002, DC-003, DC-004, DC-013, DC-015, DC-016, DC-017, DC-018 verified open after repair.

## Unchanged systems

| System | Status |
|--------|--------|
| PB1 geometry | Identical (0 m displacement) |
| PB2 dashed-marking suspects | Unchanged |
| Road-surface polygons | Unchanged (`cd437093`; frozen Stage 1 reference `26ae09b9` semantically outdated) |
| Tracker, cleanup rules, D12 | Not modified |
| Stage 1 audit JSON | Preserved |

## Tests

```
node --test tests/local_playback_lane_continuity_stage1.test.js
node --test tests/local_playback_lane_continuity_stage2.test.js
```

42/42 pass (15 Stage 1 + 27 Stage 2).

## Artifacts

| File | Purpose |
|------|---------|
| `audit_segment2_lane_continuity_stage2.json` | Machine-readable Stage 2 audit |
| `lib/sd_fusion.js` | Fusion bridge implementation |
| `lib/lane_continuity_stage2.js` | Stage 2 audit runner |
| `screenshots/segment2_lane_continuity_stage2/` | Before/after captures (17) |

## Recommended next action

Address unresolved DC-014 (intermediate lateral spike at s≈101–128 m) with a targeted bin-level or cleanup join review — not a broad gap threshold increase.

## Final verdict

| Criterion | Result |
|-----------|--------|
| PB0 fusion cause confirmed | Yes — D11_maxLaneFragmentGapM without tracker bridge |
| Targeted repair implemented | Yes |
| Approved PB0 connections valid | Yes (4 repaired, no crossings/self-intersections) |
| All unsafe gaps remain open | Yes |
| Unrelated geometry unchanged | Yes (PB1/PB2) |
| Mode 5 visibly improved | Yes — PB0 chain substantially more continuous |
| Stage 2 accepted | Yes — partial repair per evidence |
| Next action | DC-014 lateral-spike review |
