# Validation Report — Representative Display Alignment Fix

## 1. Root cause
Representative station points dropped the combined-placed display coordinate
(`placedEast/placedNorth`) that the observation dots carry after
`CombinedSourceTransform.applySourceTransformsToMap`, so in the combined/progressive
display (`combinedCoordinateFrame='combinedPlaced'`) the two layers rendered in different
frames — reversing the outer-lane lateral order (blue↔green) while red stayed central.

## 2. Fix (general, not Seg14-specific)
`public/connected_accumulated_display.js`:
- `interpCurvePointAtS` interpolates `placedEast/placedNorth` when present;
- `makeStation` computes the median placed coordinate;
- `pickStationRepresentative` emits `placedEast/placedNorth` + `coordinateFrame:
  'combinedPlaced'` when the source observations carried them.

Both layers then resolve through the **same** projection branch and the **same single**
lateral reflection decision. No new flag was required: the correction lives inside the
representative build, which is already candidate-gated (`representativeLaneLinesCandidate`,
default OFF) and never touches fitting thresholds.

## 3. Ordering (synthetic combined frame)
| Segment | dot order | OLD rep order | FIXED rep order |
|---|---|---|---|
| Seg14 | 2<1<0 | 0<1<2 (reversed) | **2<1<0** |
| Seg16 | 3<2<1<0 | 0<1<2<3 (reversed) | **3<2<1<0** |
| Seg18 | 3<2<1<0 | 0<1<2<3 (reversed) | **3<2<1<0** |

Seg2 (loop) and Seg99 (revisit) do not define a monotone lateral order, so the assertion is
not valid there; the candidate restores nothing on them and their protections are intact.

## 4. Alignment metrics
A reflection is an isometry, so distances are preserved; the metric that changes is order,
not distance. Same-identity point-to-dot distance medians remain ≤ baseline
(Seg14 baseline 0.601; v2 0.588; see `alignment_metrics.json`).

## 5. Station Support OFF / ON
The placed-frame propagation happens in the station build, so both OFF and ON carry it
(asserted in test A7). OFF and ON no longer differ in frame.

## 6. Dataset
The fix changes only display-frame propagation; fitting geometry, line/lane counts, gap
counts and station-support results are identical to the v2 dataset run
(92/92, 0 mutation, 0 non-finite, deterministic, 0 logical-lane changes). Order inversions:
present before (in the combined frame), 0 after.

## 7. Checksums / determinism
- Input checksum preserved (`mutation = false`); repeated builds identical.
- Non-combined maps are byte-identical (no placed fields present).

## 8. Remaining risks
- The order assertions use a synthetic global combined frame; the real combined transform
  is per-source, but because the fix shares one frame between both layers the order
  property holds for any combined placement.
- Seg2/Seg99 order comparisons are not valid (loop/revisit).
- Not yet visually reviewed.
