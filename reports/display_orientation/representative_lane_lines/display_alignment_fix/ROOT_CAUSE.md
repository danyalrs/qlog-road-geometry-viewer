# Root Cause — Representative-Line Lateral Order Reversal

## Verdict
**Classification 4 — representative points are in a different placed/local/display frame
than the observation dots** (compounded by 7 — the renderer's combined-placed projection
branch falls back silently when the point lacks `placedEast/placedNorth`).

This is **not** a mirror-count, sign, or colour problem. It is a coordinate-frame
propagation gap, exposed only in the combined/progressive display.

## Proof
1. In the combined / progressive display the map is `combinedPlaced`
   (`progressive_combined_playback.js:766-770` sets `combinedCoordinateFrame =
   CST.OUTPUT_FRAME`, `boundaryAnchoredOrientationActive = true`;
   `combined_boundary_anchored_orientation.js:458-465` for the multi-source path).
2. `CombinedSourceTransform.applySourceTransformsToMap` transforms
   `map.pointAccumulated.points` — each dot gains `placedEast/placedNorth` and
   `coordinateFrame: 'combinedPlaced'` (`combined_source_transform.js:69,79,305`).
3. The representative builder reads those points (`interpCurvePointAtS`) but only kept
   `localEast/localNorth`; `makeStation`/`pickStationRepresentative` never carried the
   placed coordinate. So representative points had **no** `placedEast/placedNorth`.
4. `_projectRoadGeometryToScreen` (`public/render.js:292-319`) enters the combined branch
   for both layers (map-level `combinedCoordinateFrame === 'combinedPlaced'`), then:
   `const e = Number.isFinite(point?.placedEast) ? point.placedEast : east;`
   - dots → `placedEast` (combined frame) ✓
   - representative points → fallback `east` = `localEast` (**un-combined frame**) ✗
   The two layers are therefore displaced relative to each other; where the combined
   placement reflects/reorients a source, the lateral order inverts.

## Reproduction (numeric, synthetic combined frame `placedNorth = -localNorth`)
| Segment | dot order | OLD rep order | FIXED rep order | old reversed | fixed matches |
|---|---|---|---|---|---|
| Seg14 | 2<1<0 | 0<1<2 | **2<1<0** | yes | **yes** |
| Seg16 | 3<2<1<0 | 0<1<2<3 | **3<2<1<0** | yes | **yes** |
| Seg18 | 3<2<1<0 | 0<1<2<3 | **3<2<1<0** | yes | **yes** |

The OLD order `0<1<2` vs dots `2<1<0` is exactly the reported **blue↔green outer-lane
swap** with red staying central.

## Why earlier diagnosis missed it
Every earlier measurement was on the **standalone** map (single source, not
`combinedPlaced`), where both layers fall through to the same `ViewerMirrorCoords` branch
and the order matched. The user's URL enables the combined/progressive display, which is
the only path that puts the two layers in different frames. Nearest-distance pooling also
cannot see it because a reflection is an isometry (distances are preserved).

## Fix
Carry the combined-placed display coordinate through the representative build so both
layers resolve through the **same** frame and the **same** projection branch:
- `interpCurvePointAtS` interpolates `placedEast/placedNorth` when present;
- `makeStation` computes the median placed coordinate;
- `pickStationRepresentative` emits `placedEast/placedNorth` + `coordinateFrame:
  'combinedPlaced'` when the source observations carried them.

When the map is not combined, no placed fields exist and behaviour is byte-identical
(75/75 pre-existing tests still pass).
