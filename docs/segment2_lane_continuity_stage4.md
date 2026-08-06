# Segment 2 Lane Continuity — Stage 4

Stage 4 reconciles the Stage 2/Stage 3 visible-disconnection count conflict and independently investigates DC-022 and DC-024.

## 1. Disconnection count reconciliation

### Why Stage 2 summary said “12”

The Stage 2 markdown table listed **12** as the post-repair **total** visible disconnection count. That number is the **PB1-only** count (12 PB1 gaps). The correct stable totals are:

| Metric | Stage 2 | Stage 3 |
|--------|---------|---------|
| **Stable physical gaps** (all boundaries) | **19** | **18** |
| PB0 gaps | 6 | 5 |
| PB1 gaps | 12 | 12 |
| PB2 gaps | 1 | 1 |
| Audit `disconnections.length` | 19 | 18 |

**Stable definition:** consecutive cleaned-run gaps on the same physical boundary with `alongTrackGapM > S_EPS` (0.05 m). This matches `runLaneContinuityStage1` audit enumeration.

### Why Stage 3 summary said “18”

Stage 3 correctly reported **18** audit disconnections. The apparent conflict with “12” was a **documentation error**, not a geometry regression.

### Physical change from Stage 3 (DC-014 repair)

| Event | Physical gap key | Effect |
|-------|------------------|--------|
| **Closed** | `PB0\|101.42\|128.15` | DC-014 repair |
| **Closed** | `PB0\|136.89\|260.57` | Run merge endpoint shift (not separate closure) |
| **Opened** | `PB0\|128.15\|260.57` | Same corridor as former DC-015 with shifted start after DC-014 merge |

**Net new physical gaps: 0.** Count 19 → 18 = one physical closure (DC-014).

Audit IDs re-index after run merges (e.g. former DC-015 interval appears under DC-014 id) — **not new geometry**.

### Reconciliation verdict

**Passed.** No new physical disconnections from Stage 3.

---

## 2. DC-022 investigation (PB0, s≈572–590 m)

| Field | Value |
|-------|-------|
| Along-track gap | 18.0 m |
| Lateral offset | 0.07 m |
| Heading difference | 10.2° |
| Obs in gap | 8 (2 frames) |
| **First failing stage** | **fused_fragments** (stage 6) |
| Split condition | `D11_maxLaneFragmentGapM` — 18.0 m bin gap, bridge disabled at Stage 1 baseline |
| Endpoint compatibility | **Compatible** (dΔ=0.07 m, headingΔ=10.2°) |
| Cleanup at baseline | Mirrors fusion — two runs 567–572 and 590–610 |
| **Cleanup root cause?** | **No** — cleanup only separates because fusion emitted two fragments |
| Accepted Stage 3 state | **Physically closed** — single run 381.5–689.8 m |
| **Verdict** | **D** — fusion output defect, **resolved by Stage 2 tracker-continuity bridge** |
| Stage 4 repair | **None** |

---

## 3. DC-024 investigation (PB0, s≈631–647 m)

| Field | Value |
|-------|-------|
| Along-track gap | 16.3 m |
| Lateral offset | 0.02 m |
| Heading difference | 6.4° |
| Obs in gap | 9 (2 frames) |
| **First failing stage** | **fused_fragments** |
| Split condition | `D11_maxLaneFragmentGapM` — 16.3 m between bins 315→323 |
| Endpoint compatibility | **Compatible** |
| Cleanup at baseline | Two runs 621–631 and 647–690 |
| **Cleanup root cause?** | **No** |
| Accepted Stage 3 state | **Physically closed** |
| **Verdict** | **D** — fusion defect, **resolved by Stage 2 bridge** (incidental to 381–690 m chain) |
| Stage 4 repair | **None** |

DC-022 and DC-024 do **not** share identical bin keys or split geometry, but both fail at the same pipeline stage with the same mechanism class (D11 without bridge).

---

## 4. Geometry accounting (no Stage 4 repair)

| Metric | Value |
|--------|-------|
| Lane checksum | `ff6d115e` (unchanged) |
| Fused fragments | 22 |
| Cleaned runs | 21 |
| Stable physical disconnections | 18 |
| Road-surface checksum | `70457ea` |

---

## Artifacts

- `audit_segment2_lane_continuity_stage4.json`
- `lib/lane_continuity_stage4.js`
- `tests/local_playback_lane_continuity_stage4.test.js`
- `screenshots/segment2_lane_continuity_stage4/`

## Tests

Stage 1–4, D12, cleanup, class-D fusion — full suite pass required.

## Next action

No Stage 4 code repair warranted. Monitor PB0 dropout-scale gaps (DC-015 corridor) under separate evidence review.
