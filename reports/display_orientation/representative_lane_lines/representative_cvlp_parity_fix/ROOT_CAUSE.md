# Root Cause — Representative CVLP Parity

## Proven
Seg14 representative **fitting and identity mapping are correct**: for every group the
coordinate source `gid` equals the metadata `gid`, each line lies inside its own dot band
(Δd ≈ 0.1 m), no identity/laneIndex/order swap, and the placed coordinates are fully
present (`placed=3124/3124`, `localOnly=0`).

The visible reversal came from the **renderer using different final display projections for
the two layers in the combined frame**:

- `public/render.js:89` `_visibleLaneProjectionEnabled` **defaults ON**.
- The point-accumulated dot pass sets `this._visibleLaneProjectionPass = 'pointAccumulated'`
  (`render.js:2043`) and resets it to `null` after (`render.js:2101`).
- `_drawRepresentativeLaneLines` never set a pass, so when it drew, the pass was `null` and
  the guard `pass && CVLP?.projectCombinedSourceLanePoint && _mirrorRoadLateralDisplay`
  **skipped CVLP**.
- Result: dots were re-projected through
  `CVLP.projectCombinedSourceLanePoint(..., 'pointAccumulated', {mirrorChecked:true})`
  (which for non-display-correction sources re-derives the canonical display placement and
  can change the lateral side), while lines used the raw `placedEast/placedNorth` from the
  CST transform — so the outer bands landed on opposite sides.

## Fix
Make the representative layer use the **same** CVLP call with an **explicit pass kind**:
- `public/combined_visible_lane_projection.js` — add `'representativeLaneLines'` to
  `APPROVED_LAYER_KINDS` (the projection math is kind-independent; the kind only routes
  counters), so the representative points get the identical projection.
- `public/connected_accumulated_display.js` — `makeStation` records the dominant source
  file; `pickStationRepresentative` emits `sourceFile` and the first supporting `frameId`
  on the station point (provenance for `resolveSourceFileForPoint`/anchor resolution).
- `public/render.js` — `_drawRepresentativeLaneLines` calls
  `CVLP.projectCombinedSourceLanePoint(pt, map, 'representativeLaneLines', {…})` per point
  (explicit kind, no reliance on mutable global pass state); if CVLP returns null it falls
  back to the existing safe `_projectRoadGeometryToScreen` and records `missingSource` /
  `fallback`.

## Explicitly unchanged
`fitClusterStations`, Station Support thresholds and algorithm, representative association,
lane identity, line/lane/gap counts, processing geometry, combined orientation, and CVLP
behaviour for the existing `pointAccumulated` / `laneFragments` kinds.
