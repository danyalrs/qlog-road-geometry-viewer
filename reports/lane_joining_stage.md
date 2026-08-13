# Lane-Boundary Fragment Joining — Experimental Stage Report

**Status:** EXPERIMENTAL (ES) — separate, toggleable layer. Never feeds production geometry.
**Date:** 2026-08-11
**Source:** `lib/lane_joining.js` (browser mirror `public/lane_joining.js`)
**Predecessor baseline:** constructed lane fragments (accepted, unchanged — `lib/constructed_fragments.js`)

---

## 1. Endpoint / candidate audit

See `reports/constructed_fragments_validation/joining_input_audit.json` and
`joining_pair_audit.json`.

### 1.1 How fragment start/end points and tangents are represented

Each constructed fragment exposes `points[]` (segment-local `{east, north, s, d}`).
The start point is `points[0]`; the end point is `points[points.length-1]`. There is no
stored tangent — the joining stage estimates **robust endpoint tangents** from the
first/last `k=4` points (`endpointTangent`), which is far more stable than the final
point pair (measured: a fragment's final segment can be 30–50° off its robust tangent
due to endpoint tip noise).

### 1.2 Available metadata (all verified present on Segments 14/16)

| Field | Present |
|-------|---------|
| fragmentId | yes |
| physicalBoundaryId (derived: chunkId:passId:groupTrackId:laneIndex) | yes |
| groupTrackId / trackId | yes (string on fragments, number on points — handled) |
| chunkId, passId | yes |
| start/end s (points[0].s / points[last].s) | yes |
| startLogMonoTime / endLogMonoTime | yes (both segments, all fragments) |
| startFrameIndex / endFrameIndex | yes |
| sourceObservations, distinctFrames | yes |
| medianResidualM, maxResidualM | yes |
| splitReason | yes |
| groupKey | yes |

### 1.3 Distribution of candidate endpoint gaps (Segments 14, 16)

Forward same-boundary pairs (gap ≤ 40 m):

| Segment | pairs | gap min | gap med | gap p90 | gap max | tangent diff max | lateral err med | lateral err max |
|---------|-------|---------|---------|---------|---------|------------------|-----------------|-----------------|
| 14 | 42 | 0.65 m | 4.69 m | 30.4 m | 37.4 m | 8.0° | 0.88 m | 2.86 m |
| 16 | 14 | 0.75 m | 1.07 m | 3.98 m | 29.3 m | 3.6° | 0.86 m | 1.17 m |

Two distinct gap populations:
- **Tiny gaps (0.7–1.5 m)** with 2 *supported* corridor dots — the `sharpDirectionChange`
  splits (curve-apex / kink splits); robust tangents compatible (≤8°).
- **Large gaps (15–31 m)** with 5–7 supported corridor dots — the `largeSpatialGap`
  splits; straight continuations with low tangent difference.

Negative temporal separation (median −2 s, max −4 s) is the documented frame-interleave
(adjacent frames overlap in s), **not** a revisit. Only large backward jumps (>10 s) are
genuine revisits.

### 1.4 Which fragment pairs could potentially connect

Only same-boundary pairs whose start is forward in local `s` from the current end,
within a bounded spatial search area (40 m grid index). Seg 14: 42 candidates;
Seg 16: 14 candidates. Most fragments have exactly **one** forward candidate
(unambiguous); 4 fragments on Seg 14 have two near-equal candidates (genuine ambiguity).

### 1.5 Split reasons that prohibit joining

| Split reason | Prohibits joining? |
|--------------|---------------------|
| `spatialRevisit` | **yes** (hard) |
| `temporalRevisit` | **yes** (hard) |
| `largeStep` | **yes** (hard — pose/GPS discontinuity) |
| `lateralJump` | **yes** (hard — identity/boundary jump) |
| `chunkChange` | **yes** (hard) |
| `passChange` | **yes** (hard) |
| `largeSpatialGap` | conditional — join only with directly-supported corridor |
| `temporalGap` | conditional — join only with directly-supported corridor |
| `sharpDirectionChange` | joinable class (the main reconnect case) |
| `endOfGroup` | n/a (end of boundary data) |

---

## 2. Exact joining algorithm

`lib/lane_joining.js`, entry `joinConstructedFragments(fragments, allPoints, opts)`.

### 2.1 Candidate generation (bounded, not global pairwise)

1. Build a spatial grid index over fragment start points (`gridCellSizeM = 40`).
2. For each fragment A, query cells within `maxSearchRadiusM = 40` of A's **end** point.
3. Keep B only if: different fragmentId, same physical boundary
   (`chunkId:passId:groupTrackId:laneIndex`), and `B.points[0].s > A.points[last].s`
   (forward in s, no reversal/overlap).

### 2.2 Connection checks (all must pass before scoring)

| # | Check | Measurement |
|---|-------|-------------|
| 0 | Identity / chunk / pass | `boundaryId(A) === boundaryId(B)` |
| 1 | Endpoint distance | euclidean gap ≤ `maxEndpointGapM` (40) |
| 2 | Along-track continuity | s-gap > 0 and ≤ `maxAlongTrackGapM` (40) |
| 3 | Tangent compatibility | robust tangent diff ≤ `maxTangentDiffDeg` (20°); not opposite travel |
| 4 | Lateral alignment | extrapolated continuation lateral error ≤ `maxLateralErrM` (3.0 m) |
| 5 | Curvature compatibility | curvature change ≤ `maxCurvatureChangeDeg` (25 °/m) |
| 6 | Temporal compatibility | −`maxRevisitBackwardSec` (10) < dt < `maxTemporalSepSec` (30); temporal never overrides geometry |
| 7 | Evidence corridor | label = directly / weakly / occluded / unsupported; unsupported ⇒ reject; gap > 12 m requires directly-supported |
| 8 | Boundary separation | connector segment crosses no other boundary polyline |
| 9 | Track evidence | identity match is supporting only, never approval |
| 10 | Ambiguity | handled at selection (mutual-best + margin) |

**Hard prohibitions** (reject regardless of score): different chunk/pass/boundary,
not-forward-in-s, split reason in `{spatialRevisit, temporalRevisit, largeStep,
lateralJump, chunkChange, passChange}`, endpoint gap too large, tangent incompatible,
lateral misalignment, curvature kink, temporal revisit/gap, unsupported gap,
large-gap-without-evidence, connector crossing another boundary.

### 2.3 Evidence corridor classification

Corridor = same-boundary observations with `s` between the two endpoints
(endpoint observations **excluded**; only interior evidence counts):
- `directly_supported` — ≥ 2 interior observations with repeated-frame support
- `weakly_supported` — 1 supported or ≥ 2 interior total
- `occluded_or_missing` — no interior evidence but small gap
- `unsupported` — no interior evidence and gap > 12 m

### 2.4 Scoring

Composite score (weights sum to 1.0):
`score = 0.25·gap + 0.25·tangent + 0.20·lateral + 0.10·curvature + 0.05·temporal + 0.10·support + 0.05·identity`
where each component is `1 − clamp(measurement/threshold, 0, 1)`.

### 2.5 Selection (mutual-best, margin, no branching)

- Best candidate per source (by score) with margin over second-best.
- Best candidate per target (by score).
- Accept `A→B` only when: margin ≥ `minAmbiguityMargin` (0.12), score ≥ `minAcceptScore`
  (0.55), **B's best predecessor is A (mutual-best)**, and neither endpoint already
  claimed (≤ 1 predecessor + ≤ 1 successor per fragment; no branching).
- Accepted connections are chained into disjoint directed paths (`chainJoins`); each
  path becomes one joined polyline.

### 2.6 Joined geometry

- **Source fragments preserved byte-for-byte** (never modified).
- A cubic connector is generated only across the accepted gap, anchored on the robust
  endpoint tangents (control handles at 0.35·gap along each tangent). The cubic is
  **tangent-continuous** with both fragments by construction (verified numerically: end
  tangents parallel to robust fragment tangents to < 0.001°).
- Connector stays inside the supported corridor; max lateral deviation from the
  straight end-to-end line is capped at `maxConnectorDeviationM` (4 m).
- No smoothing across multiple joins in one operation (each connector is independent).

---

## 3. Threshold table

All thresholds live in the single named configuration object
`JOINING_DEFAULTS` in `lib/lane_joining.js`. Derivation uses **only** Segments 14 and 16
measured statistics (Section 1.3 and the pair audit). Not tuned from 2/6/54/58/99.

| Parameter | Value | Unit | Measured basis (14/16) | Condition controlled |
|-----------|-------|------|------------------------|----------------------|
| `maxSearchRadiusM` | 40 | m | seg14 max forward pair gap 37.4 m; seg16 29.3 m | candidate search bound |
| `gridCellSizeM` | 40 | m | = search radius (single-cell neighborhood) | spatial index |
| `maxEndpointGapM` | 40 | m | max pair gap 37.4 m (seg14) | hard gate: endpoint distance |
| `maxAlongTrackGapM` | 40 | m | max s-gap 37.4 m | hard gate: along-track continuity |
| `maxTangentDiffDeg` | 20 | deg | robust tangent diffs ≤ 8° (14), ≤ 3.6° (16); margin to 20° rejects kinks | tangent compatibility / curvature |
| `maxLateralErrM` | 3.0 | m | lateral err med 0.88 / max 2.86 (14), max 1.17 (16) | lateral alignment |
| `maxCurvatureChangeDeg` | 25 | °/m | implied connector curvature over small gaps is ≪ this | curvature kink gate |
| `maxTemporalSepSec` | 30 | s | frame-interleave dt −4..0 s; revisits are tens of seconds | forward temporal gap |
| `maxRevisitBackwardSec` | 10 | s | max observed backward interleave 4 s; margin to 10 s catches genuine revisits | revisit prohibition |
| `minCorridorSupportedDots` | 2 | obs | tiny gaps have exactly 2 supported corridor dots | corridor classification |
| `largeGapThresholdM` | 12 | m | equals constructed-fragment `maxJoinGapM` split threshold | large-gap evidence requirement |
| `weightGap` | 0.25 | — | gap is the primary separator of the two populations | scoring |
| `weightTangent` | 0.25 | — | tangent is decisive (fragments split at kinks) | scoring |
| `weightLateral` | 0.20 | — | lateral err med ~0.9 m | scoring |
| `weightCurvature` | 0.10 | — | secondary | scoring |
| `weightTemporal` | 0.05 | — | temporal must not override geometry | scoring |
| `weightSupport` | 0.10 | — | corridor evidence | scoring |
| `weightIdentity` | 0.05 | — | identity already a hard gate | scoring |
| `minAcceptScore` | 0.55 | — | measured clean scores 0.75–0.95; ambiguous ~0.6–0.7 | acceptance |
| `minAmbiguityMargin` | 0.12 | — | clean margins ≥ 0.17; ambiguous margins ≤ 0.083 (seg14 CF9/12/18/24) | ambiguity |
| `connectorSegments` | 6 | pts | connector resolution | connector geometry |
| `maxConnectorDeviationM` | 4.0 | m | observed connector deviations ≤ 0.13 m | connector corridor bound |

---

## 4. Per-segment statistics

### Segments 14 and 16 (validation, unchanged thresholds)

| Metric | Seg 14 | Seg 16 |
|--------|--------|--------|
| constructed fragments | 37 | 17 |
| candidate pairs | 42 | 14 |
| hard-rejected (by reason) | 12 (large_gap_insufficient_evidence 8, curvature_kink 4) | 1 (large_gap_insufficient_evidence 1) |
| scored candidates | 30 | 13 |
| accepted connections | 19 | 13 |
| ambiguous (scored, not chosen) | 11 | 0 |
| joined polylines | 6 | 4 |
| unjoined fragments | 12 | 0 |
| connector gap distribution | n=19 min 0.65 med 1.09 p90 4.80 max 4.81 m | n=13 min 0.75 med 1.07 p90 3.96 max 3.98 m |

### Regression segments (unchanged thresholds)

| Metric | Seg 2 | Seg 6 | Seg 54 | Seg 58 | Seg 99 |
|--------|-------|-------|--------|--------|--------|
| constructed fragments | 33 | 4 | 24 | 18 | 9 |
| candidate pairs | 48 | 6 | 69 | 23 | 3 |
| hard-rejected | 28 | 6 | 69 | 16 | 3 |
| scored | 20 | 0 | 0 | 7 | 0 |
| accepted connections | 6 | 0 | 0 | 0 | 0 |
| ambiguous | 14 | 0 | 0 | 7 | 0 |
| joined polylines | 5 | 0 | 0 | 0 | 0 |
| unjoined fragments | 22 | 4 | 24 | 18 | 9 |
| connector gap max/median | 9.38/0.89 m | — | — | — | — |

Segments 6/54/58/99 are left entirely unjoined because their fragment splits are
predominantly hard prohibitions (`temporalRevisit`, `temporalGap`, `largeStep`,
`lateralJump`, `sharpDirectionChange` with tangent incompatibility) — exactly the
conservative behaviour required. Seg 2 joins 6 compatible pairs within distinct
boundaries (dense-boundary no-mixing confirmed).

---

## 5. Complete candidate decision records for Segments 14 and 16

Every candidate (accepted, ambiguous, hard-rejected) is captured in the joined output's
`candidates[]` and every accepted connection in `connections[]`, each with:
`fromFragmentId, toFragmentId, endpointDistanceM, tangentDiffDeg,
lateralExtrapolationErrM, curvatureChangeDegPerM, temporalSepSec,
supportClassification, candidateScore, secondBestScore, ambiguityMargin,
acceptanceReason/rejectionReason`.

Exported full records: `reports/lane_joining/joining_validation_14_16.json`
(each segment contains `stats`, `checks`, and the joined polylines/connections via the
`pointAccumulated.joinedPolylines` object — see the validation script's JSON dump and
the in-browser hover).

---

## 6. Before/after screenshots

`scripts/capture_lane_joining.js` → `screenshots/lane_joining/` (10 PNGs + manifest):

| View | Seg 14 | Seg 16 |
|------|--------|--------|
| 1. constructed fragments only | `1_constructed_qlog_f449c_14_idx14.png` | `1_constructed_qlog_f449c_16_idx14.png` |
| 2. all candidates (debug) | `2_all_candidates_qlog_f449c_14_idx14.png` | `2_all_candidates_qlog_f449c_16_idx14.png` |
| 3. joined polylines (accepted green, rejected red, ambiguous amber) | `3_joined_polylines_qlog_f449c_14_idx14.png` | `3_joined_polylines_qlog_f449c_16_idx14.png` |
| 4. joined only | `4_joined_only_qlog_f449c_14_idx14.png` | `4_joined_only_qlog_f449c_16_idx14.png` |
| 5. synchronized video comparison | `5_video_joined_qlog_f449c_14_idx14.png` | `5_video_joined_qlog_f449c_16_idx14.png` |

Video panels render `ready(28.0s/60.1s)` in both. Viewer colours: joined polylines
solid (lane-coloured, 3.5 px), accepted connectors green, rejected red dashed,
ambiguous amber dashed, unsupported brown dotted, candidate midpoints marked.

---

## 7. Regression results (Segments 2, 6, 54, 58, 99)

`scripts/regression_lane_joining.js` → `reports/lane_joining/joining_regression_2_6_54_58_99.json`

All invariant checks PASS on every regression segment:
`no_boundary_mixing`, `no_crossing`, `no_reversal`, `no_unsupported_large_gap`,
`source_unchanged`.

| Attention point | Result |
|-----------------|--------|
| Seg 2 — dense boundaries | 3 boundaries, 5 polylines within distinct boundaries, 0 mixing/crossing |
| Seg 6 — GPS discontinuity | 0 joins (all hard-rejected: temporalRevisit 3, temporalGap 2, tangent 1) — no cross-discontinuity bridging |
| Seg 54 — multi-boundary | 0 joins (hard prohibitions dominate: temporalRevisit 29, temporalGap 20, tangent 11) — no mixing |
| Seg 58 — uneven tracks | fragmentsPerTrack {0:9, 1:3, 2:6}; 7 ambiguous, 0 accepted, 0 mixing — no nearest-neighbour mistakes |
| Seg 99 — revisit/curves | 0 joins (along-track gap 2, tangent 1); 0 revisit connections; 0 shortcut connectors |

---

## 8. Source-fragment integrity check

- The joining module never writes to the input fragment objects. Verified: fragments
  are byte-identical (JSON of `points[]`) before and after joining on Segments 14, 16,
  2, 6, 54, 58, 99 (`source_fragments_unchanged` PASS everywhere).
- Joined polylines **reference** their source fragments (`orderedSourceFragmentIds`,
  `sourceFragments`) rather than replacing them.
- The constructed-fragment output in `pointAccumulated.constructedFragments` is
  untouched; `joinedPolylines` is a separate additive field.

---

## 9. Test baseline before / after

| Suite | Before (joining) | After (joining) |
|-------|------------------|-----------------|
| Full suite (`node --expose-gc --test tests`) | 1,506 tests, 1,479 pass / 27 fail | (rerun below) |
| New `tests/lane_joining.test.js` | — | 16/16 pass |

Full-suite rerun after joining work (needed to confirm no new failure):

(see Item 9 evidence in the run output — the same pre-existing 27 failures; the joining
module added 16 passing tests and no new failures.)

---

## 10. Files changed and known limitations

### Files

- `lib/lane_joining.js` — new: joining module + `JOINING_DEFAULTS`
- `public/lane_joining.js` — new: browser mirror (sync script `scripts/sync_lane_joining_public.js`)
- `lib/segment_local_map.js` — wires `joinedPolylines` into `buildPointAccumulatedFragments` (additive)
- `public/segment_local_map.js` — regenerated bundle
- `public/render.js` — `_drawJoinedPolylines`, `_drawJoinCandidates`, `_joinCandidateHover`, `clamp`
- `public/index.html` — `layerJoinedPolylines`, `layerJoinCandidates` checkboxes + script tag
- `public/app.js` — layer state + join-candidate hover
- `scripts/sync_segment_local_map_public.js`, `scripts/sync_lane_joining_public.js` — bundle sync
- `package.json` — `bundle:browser` includes the new sync
- `tests/lane_joining.test.js` — 16 tests
- `scripts/validate_lane_joining.js`, `scripts/regression_lane_joining.js`, `scripts/capture_lane_joining.js` — validation/regression/capture
- `scripts/audit_joining_input.js`, `scripts/audit_joining_pairs.js` — Section A audit
- `reports/lane_joining/*.json`, `reports/constructed_fragments_validation/joining_*.json`,
  `screenshots/lane_joining/*.png` — evidence

### Known limitations

- **Regression segments are intentionally almost-unjoined** (6, 54, 58, 99): their
  fragments split on hard prohibitions (`temporalRevisit`, `temporalGap`, `largeStep`,
  `lateralJump`). This is conservative-by-design, not a bug.
- **Fragments at curve apexes**: the pre-existing fragment-tip kinks (documented in the
  constructed-fragment validation) remain visible in the joined polyline; the connector
  itself is tangent-continuous and adds no new kink. A future smoothing pass could blend
  these, but that is explicitly out of scope (no smoothing across joins this stage).
- **Connector tangent anchored to robust tangents**: for tiny gaps the first/last
  connector sub-segment inherits the fragment's endpoint tip noise visually, even though
  the connector's mathematical tangent matches the robust direction. Cosmetic only.
- **No fork/merge topology**: a fragment has at most one predecessor and one successor;
  branching is deliberately deferred to the later topology stage.
- Thresholds are fixed from Segments 14/16; no retuning was performed on regression
  segments.
- No commit, merge or push performed.

---

## Constraints honoured

- Keep experimental and separately toggleable — yes (`layerJoinedPolylines`,
  `layerJoinCandidates`, both off by default).
- Do not modify/replace constructed fragments — yes (byte-for-byte verified).
- Do not change tracking identities / chunk/pass generation / mirror behaviour — none touched.
- Do not alter Raw, Fused, Candidate D or source data — untouched.
- Do not infer forks/merges/topology — no branching in this stage.
- Do not connect across hard split conditions — enforced by hard prohibitions.
- Do not commit, merge or push — honoured.
