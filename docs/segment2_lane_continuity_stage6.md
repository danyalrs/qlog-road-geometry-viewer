# Segment 2 Lane Continuity — Stage 6

Stage 6 classifies the **seven remaining lane-continuity candidates** after Stages 2–5. Investigation only — no production geometry changes.

## D12 test accounting correction

Five D12 partial-tail/rendering tests failed because they asserted **Stage 1** fragment/run counts (33 fused / 28 cleaned) instead of the **accepted Stage 5 baseline** (22 fused / 21 cleaned).

| Metric | Stage 1 (stale) | Accepted baseline |
|--------|-----------------|-------------------|
| Fused fragments | 33 | **22** |
| Cleaned runs | 28 | **21** |
| Lane checksum | `5283af91` | **`ff6d115e`** |

**Runtime geometry was unchanged** — only test expectations were updated. Lane checksum remains `ff6d115e` before and after the test fix.

Display-span delta (−45.56 m) is a **stable structural offset** after Stage 2/3 lane repairs, not a regression.

---

## Seven candidates (from current geometry)

### Four remaining safe fusion candidates (PB1 track 2)

Parallel to the repaired PB0 554–647 m chain; **DC-006/DC-008** are out of scope (earlier route segment).

| ID | Stable key | Gap (m) | Verdict | First failing stage |
|----|------------|--------:|---------|---------------------|
| **DC-009** | `PB1\|554.04\|567.35` | 13.3 | **A** | fused_fragments |
| **DC-010** | `PB1\|572.04\|590.04` | 18.0 | **A** | fused_fragments |
| **DC-011** | `PB1\|609.53\|621.53` | 12.0 | **A** | fused_fragments |
| **DC-012** | `PB1\|630.57\|646.89` | 16.3 | **A** | fused_fragments |

**Verdict A:** Supported short fusion gap — eligible for later **PB1-scoped** fusion-pairing repair. Endpoints compatible; D11 `maxLaneFragmentGapM` split; tracker continuous on track 2; sparse mapped obs (2 frames) but same mechanism as repaired PB0 gaps.

### Three dashed-marking suspects

| ID | Stable key | PB | Gap (m) | Verdict |
|----|------------|-----|--------:|---------|
| **DC-000** | `PB2\|428.76\|430.23` | PB2 | 1.48 | **D** |
| **DC-005** | `PB1\|428.76\|430.22` | PB1 | 1.47 | **D** |
| **DC-007** | `PB1\|498.48\|500.12` | PB1 | 1.64 | **D** |

**Verdict D:** Normal dashed-marking interval with **continuous boundary identity** — endpoints compatible, same track, lane order preserved. **Do not join** based on dash spacing alone; gaps remain open by D12 preservation policy.

---

## Repairability summary

| Category | IDs | Ready for targeted repair |
|----------|-----|---------------------------|
| Fusion pairing (PB1) | DC-009, DC-010, DC-011, DC-012 | **Yes** (later stage, PB1-scoped) |
| Dashed marking | DC-000, DC-005, DC-007 | **No** — remain open |

**DC-015** remains open (`PB0|128.15|260.57`). All eight unsafe gaps open. DC-014 and Stage 2 repairs retained.

---

## Geometry accounting (unchanged)

| Metric | Value |
|--------|-------|
| Lane checksum | `ff6d115e` |
| Fused fragments | 22 |
| Cleaned runs | 21 |
| Stable physical disconnections | 18 |
| Road-surface checksum | `70457ea` |
| PB1/PB2 displacement | 0 m |

---

## Artifacts

- `audit_segment2_lane_continuity_stage6.json`
- `lib/lane_continuity_stage6.js`
- `tests/local_playback_lane_continuity_stage6.test.js`
- `screenshots/segment2_lane_continuity_stage6/`
