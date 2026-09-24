# Validation Report — Representative CVLP Parity Fix

## 1. Root cause
Dots entered `CVLP.projectCombinedSourceLanePoint(..., 'pointAccumulated')` (the dot pass set
`_visibleLaneProjectionPass='pointAccumulated'`); the representative draw left the pass
`null` and skipped CVLP, using raw `placedEast`. Different final display projections → the
outer lane bands landed on opposite sides.

## 2. Fix
- CVLP: `APPROVED_LAYER_KINDS` gains `'representativeLaneLines'` (kind-independent math).
- CAD: representative points carry `sourceFile` + first `frameId` (dominant source file per
  station).
- Renderer: representative points routed through
  `CVLP.projectCombinedSourceLanePoint(pt, map, 'representativeLaneLines', {explicit kind})`,
  with a safe fallback and `missingSource`/`fallback` counters.

## 3. Parity
For a given point, projecting under `'pointAccumulated'` and `'representativeLaneLines'`
returns identical `east/north/reason` (tests 2–5), under mirror 0/1 and under
`combinedPlaced` display-correction sources (which return `placedEast/placedNorth`).

## 4. Identity/coordinate trace (Seg14)
| gid | laneIndex | side | dot d | line d | sourceGid | metadataGid |
|---|---|---|---|---|---|---|
| 0 | 0 | right | −4.62 | −4.50 | 0 | 0 |
| 1 | 1 | right | −1.56 | −1.43 | 1 | 1 |
| 2 | 2 | left | 1.38 | 1.50 | 2 | 2 |
No identity/coordinate swap; order `gid0<gid1<gid2` for both dots and lines.

## 5. Unchanged
`fitClusterStations`, Station Support thresholds, representative association, lane identity,
line/lane/gap counts, processing geometry, combined orientation, and CVLP behaviour for the
existing kinds.

## 6. Focus / dataset
Focus counts identical to v2 (Seg14 82/79→46/23, Seg16 82/75→62/26, Seg18 79/76→73/39,
Seg89 77/62→53/28; Seg2/12/99 unchanged). 92/92 processed, 0 lane changes, 0 mutation,
0 non-finite, deterministic.

## 7. Safety
Seg2/Seg99 restore nothing (0 accepted) → protections intact. No input mutation.

## 8. Remaining risks
- The exact live CVLP projection cannot be executed headlessly; parity is proven at the
  projection function and the on-screen diagnostic (`repPass=cvlpProjected/missingSource/
  fallback`) confirms the live counts.
- Representative points are synthetic station medians; CVLP resolves their source file via
  the station's dominant source and `s`/`frameId`. On a multi-source boundary a station could
  in principle resolve to a neighbouring source; this is counted as `missingSource`/fallback
  and does not change geometry.
- Not yet visually reviewed.
