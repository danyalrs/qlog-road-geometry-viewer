# Metric Reconciliation

## Discrepancy 1 — Seg14 reported 82 lines vs browser 85

**Report metric source:** `stats.representativeLineCount = survivors.length` from
`buildRepresentativeLaneLinesPurityRevisitFromPerFrame(buildPerFrameConnectedPolylines(
map.pointAccumulated.points).polylines, {})` on the **complete Seg14 map** (no causal
filter, no obs-isolation). Measured: `perFrameCurves = 89`, `survivors = 82`,
`stroked (>=2 pts) = 82`.

**Browser metric source:** `_drawRepresentativeLaneLines` caption shows `stroked`
(polylines with ≥2 finite points) over the builder output for the **active playback
per-frame set**. `_drawRepresentativeLaneLines` rebuilds perFrame from
`filterPointsForCausal(pa.points, elapsedIdx)` when causal playback is active, or from
`visiblePoints` in obs-isolation, or reuses `this._connectedAccumulatedPolylines`.

**Traced builds (Seg14):**

| Build path | perFrame curves | survivors |
|---|--:|--:|
| complete map | 89 | 82 |
| causal idx 0 | 3 | 0 |
| causal idx 10 | 33 | 30 |
| causal idx ≥ 50 | 89 | 82 |
| purity / curveAssociation / purityRevisit (complete) | 89 | 82 (all) |
| legacy | — | 16 |

No read-only build path reproduced **85**. Every accepted builder gives **82** on the
complete Seg14 map. The count is a function of the **per-frame set the browser was
displaying**, which depends on causal playback index / obs-isolation / combined context
(and possibly the user's exact URL). The 82→85 gap is therefore a **build-context**
difference (which points are fed to the per-frame builder), not a difference in the
representative acceptance logic. The exact 85 requires the live session's URL and playback
index, which were not captured; it is not reproducible in the read-only harness.

## Discrepancy 2 — Seg19 "unchanged" yet in the changed-segment list

Two different metrics:
- **"unchanged"** referred to the **count** metrics: `5→5` representative lines, `2→2`
  alongTrackGap, `3→3` logical lanes (v1 and v2).
- **changed-segment list** is keyed on the representative polyline **byte hash**
  (`offHash !== onHash`). Seg19 had **9** restored stations (v2) / 25 (v1), which alter
  point coordinates along the existing lines **without changing the counts**.

Both statements are correct about different metrics. `dataset_validation.json` records
`seg19: offGaps 2, onGaps 2, offLines 5, onLines 5, offLanes 3, onLanes 3, changed true`.
The "changed" flag is coordinate-level, not count-level.

## Consequence
Neither discrepancy indicates a rendering, mirror or identity error. They are
metric-source differences (live playback per-frame set; count vs byte hash).
