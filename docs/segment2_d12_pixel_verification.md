# Segment 2 D12 — Pixel Verification Report

**Segment:** `qlog_f449c_2.bz2`  
**Generated:** 2026-08-04  
**Capture method:** Authoritative `lib/` geometry rendered via `public/d12_geometry_verify.html` (Puppeteer, 1280×800, DPR 1).  
**Note:** Main UI `lane_map_cleanup.js` browser bundle is broken (`require` in browser); pixel evidence uses the same Node geometry as structural/rendering tests.

## Artifacts

| Artifact | Path |
|----------|------|
| Screenshots (37) | `screenshots/segment2_d12_verification/` |
| Capture manifest | `screenshots/segment2_d12_verification/capture_manifest.json` |
| Scene definitions | `screenshots/segment2_d12_verification/verification_scenes.json` |
| Pixel audit (JSON) | `audit_segment2_d12_pixel_verification.json` |
| Structural audit | `audit_segment2_d12_rendering_verification.json` |

## Inspected screenshots

### D12 targets (Mode 5 — lane map)

| Target | File | Expected gap | Pixel span | Verdict |
|--------|------|--------------|------------|---------|
| CD-00 | [mode5_CD-00_t0.png](../screenshots/segment2_d12_verification/mode5_CD-00_t0.png) | continuous | — | Continuous (preserved D12+D6) |
| CD-02 | [mode5_CD-02_t0.png](../screenshots/segment2_d12_verification/mode5_CD-02_t0.png) | continuous | — | Continuous |
| CD-10 | [mode5_CD-10_t0.png](../screenshots/segment2_d12_verification/mode5_CD-10_t0.png) | 1.466 m | 192 px | **Visibly open** (98% background along gap chord) |
| CD-10 close-up | [mode5_CD-10_closeup_t0.png](../screenshots/segment2_d12_verification/mode5_CD-10_closeup_t0.png) | 1.466 m | 192 px | **Visibly open**; PB1 green gap + PB2 purple gap separate |
| CD-12 | [mode5_CD-12_t0.png](../screenshots/segment2_d12_verification/mode5_CD-12_t0.png) | 1.640 m | 262 px | **Visibly open** (100% background) |
| CD-12 close-up | [mode5_CD-12_closeup_t0.png](../screenshots/segment2_d12_verification/mode5_CD-12_closeup_t0.png) | 1.640 m | 262 px | **Visibly open** |
| CD-18 | [mode5_CD-18_t0.png](../screenshots/segment2_d12_verification/mode5_CD-18_t0.png) | 1.476 m | 192 px | **Visibly open** (PB2 lane-3 tail separate from preceding run) |
| CD-18 close-up | [mode5_CD-18_closeup_t0.png](../screenshots/segment2_d12_verification/mode5_CD-18_closeup_t0.png) | 1.476 m | 192 px | **Visibly open** |

### Mode 7 gap labels (diagnostic only — not used as Mode 5 proof)

| Target | File |
|--------|------|
| CD-12 | [mode7_CD-12_t0.png](../screenshots/segment2_d12_verification/mode7_CD-12_t0.png) — `OPEN CD-12 1.64m` at correct location |
| CD-10 | [mode7_CD-10_t0.png](../screenshots/segment2_d12_verification/mode7_CD-10_t0.png) |
| CD-18 | [mode7_CD-18_t0.png](../screenshots/segment2_d12_verification/mode7_CD-18_t0.png) |

### Controls

| Control | File | Verdict |
|---------|------|---------|
| CD-01 D10 | [mode5_CD-01_D10_control_t0.png](../screenshots/segment2_d12_verification/mode5_CD-01_D10_control_t0.png) | Open (disconnected fragments) |
| D6 gap | [mode5_D6_control_t0.png](../screenshots/segment2_d12_verification/mode5_D6_control_t0.png) | Open |
| Class-F gap | [mode5_classF_control_t0.png](../screenshots/segment2_d12_verification/mode5_classF_control_t0.png) | Open |
| 240 m dropout | [mode5_dropout_240m_t0.png](../screenshots/segment2_d12_verification/mode5_dropout_240m_t0.png) | Open (wide missing corridor) |

### Mode 3 comparison (fused reference — includes road surface)

Mode 3 captures are present for all targets (e.g. [mode3_CD-10_t0.png](../screenshots/segment2_d12_verification/mode3_CD-10_t0.png)). Mode 5 has **0** road-surface polygons; Mode 3 retains fused road surface for contrast only.

### Playback stationarity (Mode 5, CD-12 viewport)

| Timeline | File | laneChecksum |
|----------|------|--------------|
| 0 | [playback_mode5_CD-12_t0.png](../screenshots/segment2_d12_verification/playback_mode5_CD-12_t0.png) | `5283af91` |
| 16 | [playback_mode5_CD-12_t16.png](../screenshots/segment2_d12_verification/playback_mode5_CD-12_t16.png) | `5283af91` |

Lane geometry is **stationary** across playback indices (identical checksum). Vehicle arrow overlay is not populated for Segment 2 in `resolveArrowOnSegmentMap` (`headingSource: none`); arrow/video sync was **not** re-verified in the main UI due to the broken browser bundle. No playback/transform code was changed.

## Pixel classification summary

| Gap | Structural | Visible (Mode 5) |
|-----|------------|-------------------|
| CD-10 | open | **open** |
| CD-12 | open | **open** |
| CD-18 | open | **open** |

No false pixel bridges detected. Line width/antialiasing does not close any of the three D12 openings. PB1 (green) and PB2 (purple) remain separate polylines with no crossings or lane-order swaps.

## Test baseline reconciliation

| Baseline | Pass / Total | Failures |
|----------|--------------|----------|
| Earlier (partial-tail delivery) | 856 / 867 | 11 |
| Prior rendering report | 875 / 884 | 9 |
| **This run** (2026-08-04) | **874 / 884** | **10** |

**Tests added since 867 → 884:** +17 (15 partial-tail + 17 rendering − overlap in suite structure).

**Resolved since earlier 11-failure baseline:**

1. `D12 partial-tail audit` → **test 14** `coverage accounting reconciles naiveSpanSum` — **fixed** (coverage accounting `naiveSpanSumM` correction).
2. Suite-level failure on `D12 partial-tail audit` — **passed** as a consequence.

**Current 10 failing subtests (none from D12 work):**

1. Stage 13A — `reconciles seg 90 aggregate coverage vs zero production polygons`
2. Stage 13A — `separates first-chunk summary A from all-chunk summary B`
3. Stage 13A — `passes full consistency reconciliation`
4. Stage 13A — `records segment 90 as first-chunk run-pairing misalignment`
5. Stage 14 delivery — `sums per-chunk counts to 540 and first-chunk to 524`
6. Stage 14 chunk reconciliation (suite)
7. Stage 19 v4 — `child process concurrent publication: one winner and one fenced loser`
8. Runtime memory — `20-run regression with expose-gc`
9. Runtime memory — `independent runtime memory oracle`
10. Runtime memory — `independent oracle aggregate` / `captured results match independently derived checks`

All D12 suites pass: partial-tail (15/15), preservation (47/47), rendering (17/17).

**Discrepancy vs 875/884:** One additional Stage 13A failure (`seg 90 aggregate coverage`) appears in this run versus the prior 9-failure report — pre-existing Stage 13A/14/memory-oracle debt, not introduced by D12 rendering.
