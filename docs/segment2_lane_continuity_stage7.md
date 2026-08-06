# Segment 2 Lane Continuity — Stage 7

Stage 7 implements a **general PB1 positive-boundary fusion continuity bridge** and closes DC-009–DC-012 when each candidate independently passes evidence gates.

## Production change

**Function:** `lib/sd_fusion.js` → `canBridgeTrackerContinuousFusionGap` / `trackerContinuityBridgeEligibility`

**Rule:** Extend tracker-continuity bridging to **proven positive-mean-d boundary tracks** (left-side lane boundaries), using per-lateral-cluster leftmost-positive track selection — not a global leftmost positive track.

| Gate | Outer (PB0) | Positive (PB1) |
|------|-------------|----------------|
| Max bridge gap | 28 m | 18 m |
| Min bridge gap | >10 m (D11) | **12 m** |
| Obs in gap | strict interior | **inclusive** endpoints |
| Min obs in gap | 2 | **6** |
| Bimodal join evidence | yes (outer only) | no |

**Flag:** `positiveBoundaryContinuityBridgeEnabled` (default `true` in production; `false` reproduces pre-Stage-7 geometry for Stages 1–6 audits).

Processing version: `2026-07-24-fusion-v12`.

---

## Target repairs (all accepted)

| ID | Stable key | Gap (m) | Verdict |
|----|------------|--------:|---------|
| **DC-009** | `PB1\|554.04\|567.35` | 13.31 | **A — Repaired** |
| **DC-010** | `PB1\|572.04\|590.04` | 18.00 | **A — Repaired** |
| **DC-011** | `PB1\|609.53\|621.53` | 12.00 | **A — Repaired** |
| **DC-012** | `PB1\|630.57\|646.89` | 16.31 | **A — Repaired** |

Join operation: structural fusion-fragment merge via `trackerContinuousFusionBridge` — **no interior sampled points** across gaps.

---

## Geometry accounting

| Metric | Before (Stage 6) | After (Stage 7) |
|--------|------------------|-----------------|
| Lane checksum | `ff6d115e` | **`10845acd`** |
| Fused fragments | 22 | **18** |
| Cleaned runs | 21 | **17** |
| Stable disconnections | 18 | **14** |
| PB0 disconnections | 5 | 5 |
| PB1 disconnections | 12 | **8** |
| PB2 disconnections | 1 | 1 |
| Road-surface checksum | `70457ea` | `70457ea` |
| PB0 displacement | — | **0 m** |
| PB2 displacement | — | **0 m** |

---

## Preserved geometry

- **Open:** DC-015, all eight unsafe gaps, DC-000/005/007 (dashed), DC-006/008
- **Closed:** DC-014, DC-019/020/021/022/023/024
- No crossings, self-intersections, or lane-order violations introduced

---

## Artifacts

- `audit_segment2_lane_continuity_stage7.json`
- `lib/lane_continuity_stage7.js`
- `tests/local_playback_lane_continuity_stage7.test.js`
- `scripts/export_segment2_lane_continuity_stage7_scenes.js`
- `scripts/capture_segment2_lane_continuity_stage7.js`
- `screenshots/segment2_lane_continuity_stage7/`
