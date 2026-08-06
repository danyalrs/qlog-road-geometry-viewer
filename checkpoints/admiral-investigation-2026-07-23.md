# Admiral Investigation Report — Qlog Road Geometry Pipeline
**Date:** 2026-07-23 (updated 2026-07-24)  
**Processing version:** `2026-07-24-fusion-v11`  
**Stage:** 12A approved — 12B blocked — Stages 13/13A/14 approved — Stages 15/15A/16/17/18 approved — **Stage 19 pending authorization** — overall visual-accuracy gate **OPEN** (camera validation blocked)  
**Orchestrator:** Admiral  

---

## Stage 8 — Transform & frame-pair audit ✅

### Reproducibility fix (2026-07-24)

Malformed optional `modelV2_extracted.json` no longer blocks audits:

| Component | Change |
|-----------|--------|
| `lib/json_extract.js` | `loadJsonExtract` returns `{ data, status, error }` — never throws on bad JSON |
| `lib/qlog_data.js` | Logs warning, continues with SHA-keyed `.bz2` extracts; exposes `legacyExtractWarnings` |
| `server.js` | Uses tolerant loader for legacy extracts |
| `tests/qlog_data_extract.test.js` | Audit succeeds when legacy JSON missing or malformed |

### Multi-factor pass suppression (v9 refinement)

`lib/pass_revisit_assess.js` distinguishes genuine revisits/crossings from sparse GPS chord artifacts using:

- **Self-intersection:** crossing angle + segment–tangent alignment + heading continuity + along-track separation (not ratio/distance alone)
- **Spatial revisit:** heading delta, tangent alignment, path heading accumulation, approach bearing, time separation — curve artifacts require low tangent alignment with high travel/euclidean ratio **and** no loop-closure evidence

`tests/passes_movement_validation.test.js` covers closed loop, same-road return, figure-eight, road crossing, U-turn revisit — dense, sparse, and noisy variants.

### Post-fix full audit (2026-07-23T04:31Z)

```bash
node --test tests/*.test.js          # 82/82 pass
node dataset_audit.js --all --out audit_dataset_v9_full.json
```

| Metric | Result | Independent verification |
|--------|--------|--------------------------|
| Segments processed | **92** | 92 ✓ |
| Failures | **0** | 0 ✓ |
| Multi-pass segments | **25** (4 passes), **57** (2 passes) | 25, 57 ✓ |
| Zero-polygon segments | **37** | 37 ✓ |
| Seg 2 passes | **1** (`suppressedChordSelfIntersection` @ 3123) | 1 ✓ |
| Seg 99 passes | **1** (`suppressedCurveSpatialRevisit` + chord) | 1 ✓ |

**Gate status:** Approved 2026-07-24. Independent verification matched; Stage 9 unblocked.

---

## Stage 9 — Pose-section fragmentation ✅ (gate approved 2026-07-24)

**Technical gate:** Approved. Circular missing-speed fallback removed; expected speed from independent reported, historical, neighbouring, or conservative-fallback evidence only. Candidate implied speed is diagnostic only.

### Affected-segment accounting (v7→v8 regression cohort)

**17 affected segments** (lost polygons when pose-section separation shipped):

`0, 14, 15, 16, 17, 18, 25, 29, 30, 31, 32, 35, 37, 49, 88, 89, 90`

| Outcome | Count | Segment IDs |
|---------|-------|-------------|
| **Recovered** | **16/17** | `0, 14, 15, 16, 17, 18, 29, 30, 31, 32, 35, 37, 49, 88, 89, 90` |
| **Unrecovered** | **1/17** | `25` |

**Segment 25 — remaining rejection breakdown** (4 temporal passes, 6 pose sections, 0 polygons, 65.3 m hidden connectors):

| # | Frames | Reason | Classification | Step (m) | Implied (m/s) | Reported (m/s) | Motion disagree (°) |
|---|--------|--------|----------------|----------|---------------|----------------|---------------------|
| 1 | 30803→30843 | `headingMotionDisagreement` | false_sparse_heading_noise | 6.0 | 3.0 | 2.4 | 76° (limit 65°) |
| 2 | 30923→30963 | `headingMotionDisagreement` | genuine_localization_failure | 10.4 | 5.2 | 1.1 | 92° (limit 45°) |
| 3 | 30963→31003 | `headingMotionDisagreement` | genuine_localization_failure | 26.7 | 13.3 | 2.4 | 168° (limit 45°) |
| 4 | 31043→31083 | `headingMotionDisagreement` | genuine_localization_failure | 22.3 | 11.1 | 1.0 | 125° (limit 45°) |
| 5 | 31123→31163 | `headingMotionDisagreement` | genuine_localization_failure | 1.7 | 0.8 | 0.6 | 154° (limit 45°) |

Seg 25 is a genuine multi-pass U-turn with localization failures — not a false-sparse threshold case. Pose gaps preserved; no cross-gap fusion.

### Root cause (v7→v8 regression)

17 segments lost polygons when pose-section separation shipped. **100%** classified as `excessive_section_fragmentation`:

| Pattern | Count | First rejection |
|---------|-------|-----------------|
| `positionJump` at ~2 s GPS spacing | 16 | step 35–44 m, implied ~17–22 m/s — consistent with reported speed |
| `headingMotionDisagreement` | 1 (seg 25) | 53° disagreement at 6.5 m/s on a curve |

Fixed 35 m threshold rejected **valid sparse highway GPS** (step ≈ speed × Δt). Each rejection created a 1-frame pose section → insufficient paired-edge overlap → zero polygons. **No cross-gap fusion** was used for recovery.

### Fix (`lib/pose_continuity.js` v10)

Speed- and time-adaptive position jump limit:

```
maxAllowedStep = min(max(expectedSpeed × Δt × 1.35 + 10 m, 35 m), 65 m)
```

**Independent speed estimation** (`estimateExpectedSpeedMps`) — the candidate transition's implied speed is **never** used for its own threshold (avoids circular acceptance where `maxAllowed ≈ step × 1.35 + 10`):

1. **Reported GPS speed** when present and consistent with neighbours
2. **Median** of accepted-history speeds + neighbouring accepted-step speeds (`independentSpeedEstimates`)
3. **Previous point reported speed** when history is thin
4. **Conservative fallback** (`conservativeFallbackSpeedMps` = 12 m/s) at startup or insufficient history

When reported speed is **suspiciously lower** than neighbour median (>60% gap), neighbour median overrides reported (not applied during acceleration where reported > neighbour).

`impliedSpeed` is retained only for diagnostics, `impliedSpeedExceeded` cap (55 m/s), and heading-motion disagreement — not for thresholding.

Relaxed heading-motion disagreement (45° → 65°) when implied speed matches reference speed (sparse curves).

New config keys: `positionJumpSpeedSlack`, `positionJumpBufferM`, `absoluteMaxPositionJumpM`, `stationaryMaxPositionJumpM`, `conservativeFallbackSpeedMps`, `speedHistoryWindow`, `maxHeadingMotionDisagreementSparseDeg`, `speedConsistencyRatioMax`.

### Investigation tooling

`pose_rejection_audit.js` — per-rejection metrics: displacement, elapsed time, implied speed, movement state, heading continuity, neighbour steps, GPS interval, section length, false-sparse vs genuine classification.

```bash
node pose_rejection_audit.js --affected17 --out audit_pose_rejection_v10.json
```

### v10 audit results (2026-07-23T04:41Z — final, circular-speed fix verified)

```bash
node --test tests/*.test.js                    # 97/97 pass
node dataset_audit.js --segments 2,6,54,58,99 --out audit_reference_v10.json
node dataset_audit.js --segments 2,6,54,58,99,25,62,66,96,0,10,30 --out audit_expanded_v10.json
node dataset_audit.js --all --out audit_dataset_v10_full.json
node pose_rejection_audit.js --affected17
node compare_audits.js audit_dataset_v9_full.json audit_dataset_v10_full.json audit_comparison_v9_v10.json
```

| Metric | v9 | v10 (final) | Δ |
|--------|----|----|---|
| Segments processed | 92 | 92 | — |
| Failures | 0 | 0 | — |
| Multi-pass | 2 (25, 57) | 2 (25, 57) | 0 |
| Zero-polygon | 37 | **19** | **−18** |
| Pose sections (affected 17 median) | ~30 | **1** | fragmentation removed |
| Stability-group pass regressions | — | **0** | — |

**Recovered polygons (16/17):** 0, 14, 15, 16, 17, 18, 29, 30, 31, 32, 35, 37, 49, 88, 89, 90  
**Still zero (genuine):** seg **25** only — see rejection breakdown above

**Pose-rejection audit (affected 17):** 5 total rejections across all 17 segments (all on seg 25) — 1 false-sparse, 4 genuine. Genuine GPS jumps still rejected elsewhere; polygon recovery confined to valid pose sections.

**Reference gate (v10):**

| Seg | Passes | Polygons | Notes |
|-----|--------|----------|-------|
| 2 | 1 | 1 | chord suppression intact |
| 6 | 1 | 1 | stationary drift |
| 54 | 1 | 2 | stationary drift |
| 58 | 1 | 0 | pre-existing |
| 99 | 1 | 0 | curve artifact suppression intact |

**Segment-ID check:** `grep segmentId lib/**/*.js` → **0 matches** (no production segment-ID logic).

**Tests added:** `tests/pose_continuity.test.js` — 17 cases: original sparse/jump/outlier/shift suite + 9 missing-speed threshold tests (steady sparse, isolated jump, startup fallback, acceleration, sustained shift, sub-cap jump rejection, reported-vs-neighbour conflict, outlier recovery, no-circular-acceptance).

**Deferred:** Lane/polygon threshold tuning (Stage 10); seg 25 genuine multi-pass geometry (investigate separately, not pose tuning).

---

## Stage 10 — Lane/polygon threshold tuning (in progress)

**Scope:** Remaining **19** zero-polygon segments (post-v10). Pose-continuity changes frozen at v10; rejected pose gaps preserved. No cross-gap fusion.

**Classification** (`audit_zero_polygon_v10.json`, 2026-07-23T04:46Z):

| Cause | Count | Segments |
|-------|-------|----------|
| `polygon_validation_rejected:selfIntersecting` | 5 | 5, 24, 56, 58, 99 |
| `polygon_validation_rejected:vertexJumpTooLarge` | 5 | 28, 46, 50, 72, 92 |
| `insufficient_paired_coverage` | 2 | 9, 65 |
| `pose_section_fragmentation` | 7 | 22, 25, 26, 60, 61, 66, 96 |

**Stage 10 buckets:**

| Bucket | Count | Segment IDs |
|--------|-------|-------------|
| Lane/polygon candidates (single section, no pose rejections) | **12** | `5, 9, 24, 28, 46, 50, 56, 58, 65, 72, 92, 99` |
| Pose/multi-pass (not lane-threshold fixes) | **7** | `22, 25, 26, 60, 61, 66, 96` |

```bash
node zero_polygon_audit.js --all --out audit_zero_polygon_v10.json
node dataset_audit.js --all --out audit_dataset_v10_full.json   # baseline before tuning
```

**Constraints:** Tune `minLaneProb`, `minFramesPerBin`, `minObsPerBin`, `fusionIntervalM`, polygon validation (`maxVertexJumpM`, self-intersection handling) only. Do not modify `lib/pose_continuity.js` in this stage.

### Per-candidate diagnostics (2026-07-23T04:49Z)

Tooling: `lib/stage10_diagnostics.js`, `stage10_candidate_diagnostics.js` → `audit_stage10_diagnostics.json`

| Seg | Group | Pass/Sec | Paired frames | Bins L/R | Paired cov (m) | Max interp span (m) | Rejection | Inferred root cause |
|-----|-------|----------|---------------|----------|----------------|---------------------|-----------|---------------------|
| 5 | selfIntersecting | 1/1 | 28 | 132/130 | 243 | 15.2 | selfIntersecting (1×) | sparse_bin_interpolation |
| 9 | insufficientPairedCoverage | 1/1 | 27 | 7/7 | **9.7** | — | no polygon built | fusion coverage too short |
| 24 | selfIntersecting | 1/1 | 30 | — | — | — | selfIntersecting | sparse_bin_interpolation |
| 28 | vertexJumpTooLarge | 1/1 | 30 | 336/335 | 854 | **86.9** | vertexJump 16.0>15 | missing bin + bridge gap |
| 46 | vertexJumpTooLarge | 1/1 | 30 | — | — | — | vertexJumpTooLarge | missing bin + bridge gap |
| 50 | vertexJumpTooLarge | 1/1 | 30 | — | — | — | vertexJumpTooLarge | missing bin + bridge gap |
| 56 | selfIntersecting | 1/1 | — | — | — | — | selfIntersecting | sparse_bin_interpolation |
| 58 | selfIntersecting | 1/1 | 30 | 170/204 | 499 | **180.1** | selfIntersecting (2×) | sparse_bin_interpolation |
| 65 | insufficientPairedCoverage | 1/1 | 26 | 6/6 | **9.1** | 2.5 | selfIntersecting (4 samples) | short coverage + curve |
| 72 | vertexJumpTooLarge | 1/1 | 30 | — | — | — | vertexJumpTooLarge | missing bin + bridge gap |
| 92 | vertexJumpTooLarge | 1/1 | 30 | — | — | — | vertexJumpTooLarge | missing bin + bridge gap |
| 99 | selfIntersecting | 1/1 | 30 | 215/213 | 452 | **123.3** | selfIntersecting (3×) | sparse_bin_interpolation |

**Key findings (pre-threshold):**

1. **Self-intersection group (5, 24, 56, 58, 99):** Adequate paired coverage (240–500 m) and plausible widths (7–10 m median). Failures driven by **long unsupported interpolation spans** (15–180 m) across missing fusion bins — not lane-side swapping (0 boundary-crossing samples). Fix requires **algorithmic interval splitting** at large interpolation gaps, not validation weakening.

2. **Vertex-jump group (28, 46, 50, 72, 92):** Jumps barely exceed 15 m cap (e.g. seg 28: **16.04 m**) at **left→right bridge edge** of ring closure. Same large interpolation spans (up to 87 m). Fix: split intervals at gaps / bridge, not global `maxVertexJumpM` increase.

3. **Insufficient coverage (9, 65):** Only **~10 m** paired longitudinal coverage despite 27–28 paired frames — fusion produces **6–7 occupied bins** total. Lowering `minFramesPerBin` **not justified** without independent paired-edge support audit. Seg 65 additionally builds a 4-sample polygon that self-intersects on a tight curve.

**Next change (planned):** Split resampled intervals when `interpolateD` span exceeds `fusionIntervalM × 2` — one algorithmic rule, named config `maxInterpolationSpanM`.

### Stage 10 implementation — `maxInterpolationSpanM` (`2026-07-24-fusion-v11`) ✅

**Single algorithmic change:** `maxInterpolationSpanM = fusionIntervalM × 2` (default **4 m**).

**Implementation (`lib/sd_fusion.js`):**
- `sourceBinSpacing()` — spacing from fusion grid `binKey` delta × `fusionIntervalM` (falls back to along-track `s` when keys absent)
- `splitSupportedRuns()` — divide boundaries at source-bin spacing **>** `maxInterpolationSpanM`
- `pairSupportedRuns()` — pair left/right runs only where longitudinal overlap ≥ `polygonSampleStepM × 2`
- `interpolateDWithinRun()` — bracket interpolation only when source-bin span ≤ cap; no cross-gap bridging
- `resampleBoundaries()` — build intervals per qualifying paired run via `resamplePairedRun()`; multiple runs → **separate polygons** (no silent join)
- Default wired in `lib/process_route.js`; version `2026-07-24-fusion-v11`

**Tests:** `tests/stage10_interpolation_split.test.js` (14 cases) + `tests/stage10_diagnostics.test.js` (5). Full suite **116/116 pass**.

**Candidate audit** (`stage10_candidate_audit.js` → `audit_stage10_candidates_v11.json`):

| Seg | Runs L/R | Paired overlaps | Polygons | Self-IX | Max jump (m) | Width median (m) | Unsupported removed (m) | Outcome |
|-----|----------|-----------------|----------|---------|--------------|------------------|-------------------------|---------|
| 5 | 9/8 | 9 (4–28 m) | **9** | 0 | 10.6 | 8–10 | 170.5 | **accepted** |
| 9 | 1/1 | 0 | 0 | 0 | — | — | 9.7 | **rejected** — missingBoundary / no overlap |
| 24 | 21/21 | 11 | **11** | 0 | 13.7 | 10–13 | 407.8 | **accepted** |
| 28 | 16/24 | 2 | **2** | 0 | 13.5 | 11–14 | 843.7 | **accepted** |
| 46 | 23/23 | 15 | **14** (+1 rej) | 0 | acc **14.46** / rej **15.129** | 9–15 | 521.0 | **accepted** |
| 50 | 5/9 | 0 | 0 | 0 | — | — | 554.8 | **rejected** — insufficientPairedCoverage |
| 56 | 17/13 | 8 | **8** | 0 | 9.9 | 5–10 | 291.0 | **accepted** |
| 58 | 11/17 | 6 | **6** | 0 | 9.8 | 6–10 | 466.8 | **accepted** |
| 65 | 1/1 | 1 (7.2 m) | 0 | **1** | 10.9 | — | 9.1 | **rejected** — selfIntersecting |
| 72 | 26/26 | 7 | **7** | 0 | 11.9 | 11–12 | 817.5 | **accepted** |
| 92 | 17/26 | 7 | **7** | 0 | 14.6 | 10–14 | 743.0 | **accepted** |
| 99 | 15/16 | 3 | **3** | 0 | 8.2 | 7–8 | 431.9 | **accepted** |

**Recovered: 9/12** — `5, 24, 28, 46, 56, 58, 72, 92, 99`. **Still zero: 3** — `9, 50, 65` (matches expected interpretation).

### v10 → v11 full dataset comparison (92 segments)

| Metric | v10 (pose) | v11 (fusion) | Delta |
|--------|------------|--------------|-------|
| Zero-polygon | **19** | **13** | **−6** |
| Multi-pass | 2 | 2 | 0 |
| Median ms | 586 | 575 | −11 |
| Processing failures | 0 | 0 | 0 |
| Temporal pass regressions | — | **0** | — |
| Pose-section regressions | — | **0** | — |

**Zero-polygon recovered from v10:** `5, 22, 24, 25, 28, 46, 56, 58, 61, 66, 72, 92, 99` (13 segments).

**New zero-polygon (v10 had polygon):** `17, 31, 37, 57, 62, 87, 90` (7 segments) — prior single polygons depended on unsupported interpolation across gaps > 4 m; no independently supported paired run meets existing coverage/width/validation checks under v11.

**Polygon count pattern:** Most segments with polygons now emit **multiple smaller polygons** (one per supported paired run) instead of one bridged polygon — e.g. seg 2: 1→7, seg 10: 1→15. Not a loss of coverage where supported runs qualify.

**Reference audit (2, 6, 54, 58, 99):** all **non-zero** polygon; seg 58/99 recovered; passes unchanged at 1 each.

**Expanded audit:** seg 25 gained 4 polygons; seg 66 gained 1; seg 62 lost prior bridged polygon (0); seg 96 unchanged zero.

**Production rule check:** `segmentId` in `lib/**` only in `lib/stage10_diagnostics.js` (investigation tooling, not pipeline).

**Artifacts:** `audit_stage10_candidates_v11.json`, `audit_reference_v11.json`, `audit_expanded_v11.json`, `audit_dataset_v11_full.json`, `audit_comparison_v10_v11.json`.

**Stage 10 gate:** Candidate recovery **passes** (9/12, expected 3 remain rejected). Zero-polygon **improves** 19→13. **Accepted** candidate polygons all satisfy `maxConsecutiveVertexJump(ring) ≤ maxVertexJumpM` (15 m); audit-table “15.1 m” on seg 46 is the **rejected** run only (see reconciliation below). **7 stability-group polygon losses** from retiring unsupported bridging — individually documented below. Pose continuity frozen at v10; no other parameters tuned.

### Audit consistency — Segment 46 vertex jump

| Question | Answer |
|----------|--------|
| **1. Unrounded maximum jump** | **Accepted runs:** `14.459800276542618` m (fragment 14). **Rejected run:** `15.129188987881262` m (fragment 10). |
| **2. Polygon and edge endpoints** | Rejected fragment 10, ring index 5: **left downstream end** `(-327.813859, 388.767717)` at s=503.22 → **right downstream end** `(-316.347903, 398.638087)` at s=503.22 (ring closure edge at fixed s). |
| **3. Classification** | **Separately rejected run** — not an accepted polygon. The rounded “15.1 m” in the summary table mixed accepted and rejected extrema; production accepts 14 polygons and rejects 1. |
| **4. Production validation comparison** | `validateRoadPolygon()` in `lib/geometry_sanity.js`: `maxJump = maxConsecutiveVertexJump(ring)` then `if (maxJump > maxVertexJump)` → reject. Uses strict `>` (not `≥`) with `maxVertexJumpM = 15`. Here `15.129188987881262 > 15` → `vertexJumpTooLarge`. |
| **5. Accepted vs rejected max jump** | **Accepted max:** 14.459800276542618 m across 14 polygons. **Rejected max:** 15.129188987881262 m on fragment 10 only. Chunk output: 14 accepted polygons (matches production). |

`stage10_candidate_audit.js` now reports `maxAcceptedVertexJumpM` and `maxRejectedVertexJumpM` separately. Test: `tests/stage10_interpolation_split.test.js` — “segment 46 vertex jump: accepted runs pass cap; rejected run fails closure edge”.

### Seven retired v10 polygons (stability group)

All seven: **temporal pass count unchanged**, **pose-section count unchanged**, v11 `insufficientPairedCoverage` (no qualifying paired supported run ≥ 4 m overlap). v10 single polygon depended on interpolating across source-bin gaps **> 4 m** (unsupported under v11).

| Seg | v10→v11 poly | Passes | Pose sec | Gaps >4 m (L/R) | Max gap (m) | L/R runs | v11 paired runs | v11 intervals |
|-----|--------------|--------|----------|-----------------|-------------|----------|-----------------|---------------|
| **17** | 1→0 | 1→1 | 1→1 | 187 | 422 | 10/17 | 0 | 0 |
| **31** | 1→0 | 1→1 | 1→1 | 174 | 518 | 0/17 | 0 | 0 |
| **37** | 1→0 | 1→1 | 1→1 | 216 | 82 | 18/14 | 0 | 0 |
| **57** | 1→0 | 2→2 | 5→5 | 16 | 118 | 4/8 | 0 | 0 |
| **62** | 1→0 | 1→1 | 15→15 | 10 | 22 | 4/6 | 0 | 0 |
| **87** | 1→0 | 1→1 | 1→1 | 180 | 42 | 13/14 | 0 | 0 |
| **90** | 1→0 | 1→1 | 1→1 | 196 | 82 | 18/5 | 0 | 0 |

### Multi-polygon downstream retention

Confirmed: `process_route.js` maps **every** `roadSurfacePolygons[]` entry onto the chunk and top-level `roadSurfacePolygons` array (no single-polygon assumption). `public/render.js` iterates all chunk polygons. Test: `process_route retains every supported-run polygon without collapsing to one` (seg 46 → 14 polygons, JSON round-trip preserved).

### Stage 10 gate — **APPROVED** (2026-07-23)

Processing version **frozen:** `2026-07-24-fusion-v11`.

---

## Stage 11 — polygon fragment quality (`2026-07-24-fusion-v11`) ✅ COMPLETE (gate approved 2026-07-24)

**Objective:** Determine whether v11 supported-run polygons are geometrically valid, temporally stable, and usable for HD-map reconstruction. **No production geometry changes** in this stage.

**Frozen upstream:** Stage 8 pass detection, Stage 9 pose v10, Stage 10 fusion v11 (`maxInterpolationSpanM = 4 m`, `maxVertexJumpM = 15 m`). The 13 zero-polygon segments are **not** tuned.

### Tooling

| Tool | Output |
|------|--------|
| `lib/stage11_fragment_audit.js` | Core per-fragment metrics + classification |
| `stage11_polygon_fragment_audit.js` | Full-dataset CLI audit |
| `stage11_visual_inspection.js` | SVG overlays (`audit_stage11_visual/`) |
| `tests/stage11_fragment_audit.test.js` | 11 tests (ordering, classification, downstream) |

**Per-fragment fields (16 metrics):** polygon count, longitudinal coverage, area, perimeter, vertices, supporting frames/bins, width median/range, distance to prev/next polygon, along-track gap, heading change across gap, L/R endpoint alignment, pass/pose-section identity, adjacent unsupported rejection reason, self-intersections, max vertex jump, unsupported interpolation distance, source frame IDs/timestamps.

**Classifications:** `independently_useful`, `valid_but_too_short_for_mapping`, `duplicate_or_overlapping`, `contained_inside_another`, `geometrically_inconsistent`, `separated_by_real_evidence_gap`, `potentially_mergeable_direct_support_only`.

**Polygon ID:** deterministic `segmentId:chunkId:passId:poseSectionId:fragmentIndex`; ordering by pass → pose section → `sRange[0]` → `fragmentIndex`.

### Full-dataset fragment audit (92 segments)

| Metric | Value |
|--------|-------|
| Total accepted fragments | **540** |
| Polygons/segment (median / p90 / max) | **4 / 12 / 21** (seg 82) |
| `independently_useful` | **307** (57%) |
| `valid_but_too_short_for_mapping` | **233** (43%) |
| `separated_by_real_evidence_gap` | **455** gap tags (adjacent unsupported > 4 m) |
| `duplicate_or_overlapping` s-range pairs | **2** dataset-wide |
| `geometrically_inconsistent` (accepted) | **0** |
| `potentially_mergeable_direct_support_only` | **0** (no merge without bridging) |
| Sharp v10→v11 increases (Δ≥3) | **56** segments |

**Representative fragmentation:**

| Seg | v10 poly | v11 poly | Useful | Too short |
|-----|----------|----------|--------|-----------|
| 2 | 1 | 7 | 2 | 5 |
| 10 | 1 | 15 | 11 | 4 |
| 46 | 0 | 14 | 9 | 5 |
| 58 | 0 | 6 | 3 | 3 |
| 99 | 0 | 3 | 3 | 0 |

**Controls unchanged:** seg 0 (1→1), seg 14 (1→1), seg 15 (1→1), seg 47 (1→1).

### Downstream compatibility (verified)

- JSON chunk + top-level `roadSurfacePolygons` retain **all** fragments (129/129 tests).
- `buildGeometryDebug` polygon count matches chunk count (renderer iterates every polygon).
- Deterministic IDs and ordering stable across reruns.
- Aggregate overlap double-count estimate: **2** s-range overlap pairs only; no widespread area duplication.

### Visual inspection

25 SVG overlays in `audit_stage11_visual/` — representatives (2, 5, 10, 24, 46, 58, 99), controls (0, 6, 54), and all segments with ≥10 polygons. Unsupported gaps shown as yellow dashed connectors (> 4 m).

### Dataset audits (unchanged processing)

| Audit | Zero-polygon | Multi-pass | Failures |
|-------|--------------|------------|----------|
| Reference | 0/5 | 0 | 0 |
| Expanded | 2/12 | 1 | 0 |
| Full 92 | **13** | 2 | 0 |

Matches Stage 10 baseline — no regression from audit-only tooling.

### Stage 11 verdict — **APPROVED** (2026-07-24)

Fragments are **geometrically valid** (0 inconsistent accepted, all pass vertex-jump/self-intersection checks). Fragmentation is **expected** from supported-run splitting; most short fragments reflect real 4–6 m supported spans, not bad geometry. **No dataset-wide consolidation rule** is justified without reintroducing unsupported interpolation. The **233 short fragments remain valid-but-short** — do not delete, merge, or extend based only on length or endpoint proximity.

**Gate:** Approved. Processing frozen at `2026-07-24-fusion-v11`.

**Artifacts:** `audit_stage11_fragments_v11.json`, `audit_stage11_visual/`, `audit_dataset_v11_stage11.json`, `audit_reference_v11_stage11.json`, `audit_expanded_v11_stage11.json`.

```bash
node stage11_polygon_fragment_audit.js --all --out audit_stage11_fragments_v11.json
node stage11_visual_inspection.js --all-high
node --test tests/stage11_fragment_audit.test.js tests/stage10_interpolation_split.test.js tests/road_geometry.test.js
node dataset_audit.js --all --out audit_dataset_v11_stage11.json
```

---

## Stage 12 — visual/geometric accuracy vs source evidence (`2026-07-24-fusion-v11`)

**Overall gate:** **OPEN** — Stage 12A (model evidence consistency) approved; Stage 12B (camera-frame validation) blocked. Do **not** treat BEV overlays as camera validation.

**Objective:** Determine whether accepted polygons align with the physical road visible in camera images. Stage 12A establishes consistency with modelV2 observations only. **No production geometry changes** from this audit. Do **not** reopen Stage 10 or Stage 11 geometry based on Stage 12A alone.

**Frozen upstream:** Stage 8 pass detection, Stage 9 pose v10, Stage 10 fusion v11, Stage 11 fragment representation, `maxInterpolationSpanM = 4 m`, `maxVertexJumpM = 15 m`, all support/coverage/validation thresholds.

---

### Stage 12A — modelV2 BEV evidence consistency ✅ APPROVED (2026-07-24)

**What this establishes:** Consistency between fused polygons and modelV2 road-edge observations in the vehicle frame — the same source evidence the fusion pipeline consumes. It does **not** independently establish alignment with the physical road visible in camera images.

**Evidence mode:** BEV comparison of fused polygon boundaries vs modelV2 `roadEdges` reprojected to vehicle frame at support frames.

#### Tooling

| Tool | Output |
|------|--------|
| `lib/stage12_visual_validation.js` | Per-polygon BEV validation + classification |
| `stage12_visual_validation.js` | Stratified CLI audit |
| `tests/stage12_visual_validation.test.js` | 8 tests |
| `audit_stage12_visual/` | 90 BEV SVG overlays |

#### Sampling

99 polygons across 14 segments: **0, 2, 5, 10, 14, 15, 24, 27, 46, 47, 54, 58, 82, 99**. Stratified across independently useful fragments, valid short fragments, overlap pairs, high-fragment-count, and control segments.

#### Results

| Metric | Value |
|--------|-------|
| Polygons sampled | **99** |
| Measurable | **84** |
| Inconclusive (not counted as failures) | **15** |
| Accurate or acceptable | **71/84 (84.5%)** |
| Laterally shifted | **13/84 (15.5%)** |
| Long-fragment accuracy | **50/61 (82.0%)** |
| Short-fragment accuracy | **21/23 (91.3%)** |
| Lateral error median / p90 / max | **0.27 m / 0.79 m / 3.57 m** |
| Width error median / p90 | **0.30 m / 1.09 m** |
| Overlap pairs (seg 27) | **2/2 valid adjacent evidence** |
| Tests | **137/137 pass** |
| Full 92-segment audit | **0 failures**, 13 zero-polygon unchanged |
| Processing version | **`2026-07-24-fusion-v11` frozen** |

#### Classification accounting (84 measurable, mutually exclusive primary outcomes)

| Primary outcome | Count |
|-----------------|-------|
| `visually_accurate` | **51** |
| `acceptable_within_image_uncertainty` | **20** |
| `laterally_shifted` | **13** |
| **Total** | **84** |

**`width_too_wide` (2) is a secondary tag, not a primary bucket.** Both cases carry primary `laterally_shifted` with an additional `width_too_wide` secondary tag:

| Polygon ID | Primary | Secondary tags |
|------------|---------|----------------|
| `10:0:0:0:10` | `laterally_shifted` | `width_too_wide` |
| `27:0:0:1:1` | `laterally_shifted` | `width_too_wide` |

These 2 are included in the 13 shifted count, not additive to the 84 total.

#### Overlap pair inspection (segment 27)

Both pairs confirmed **`valid_adjacent_evidence`** — pose-section boundary overlap with distinct support frames, not duplicated road area:

| Pair | Overlap | Verdict |
|------|---------|---------|
| `27:0:0:0:0` ↔ `27:0:0:1:0` | 4.0 m | valid adjacent evidence |
| `27:0:0:0:1` ↔ `27:0:0:1:0` | 3.84 m | valid adjacent evidence |

#### Maximum lateral residual — manual review

| Field | Value |
|-------|-------|
| **Polygon ID** | **`46:0:0:0:11`** |
| Segment / pass / pose section | 46 / 0 / 0 |
| Fragment | short (4.0 m coverage) |
| Support frame | **56243** (`logMonoTime` 2829068716473) |
| Mean lateral error | **3.57 m** (left 2.95 m, right **4.19 m**) |
| Width error | 1.24 m |
| Road shape | `sparse_gps` |
| Sample count | **1** comparable x-sample (fragment endpoint) |
| Likely cause | **Sparse-GPS correspondence error** at a short-fragment endpoint with single-frame support — asymmetric right-side mismatch suggests edge-to-polygon pairing at fragment boundary, not a dataset-wide calibration offset. **No geometry change from this case alone.** |

#### Manual-review flags (13 `laterally_shifted`)

Retained as review flags only — **no calibration or geometry changes** from this sample:

`2:0:0:0:5`, `2:0:0:0:6`, `5:0:0:0:0`, `10:0:0:0:10`, `24:0:0:0:4`, `27:0:0:1:0`, `27:0:0:1:1`, `27:0:0:1:3`, `46:0:0:0:4`, `46:0:0:0:6`, **`46:0:0:0:11`**, `54:0:0:0:1`, `58:0:0:0:4`

Mean lateral error range: 0.34–3.57 m. No segment-specific correction warranted.

#### Stage 12A verdict — **APPROVED**

Fused polygons are **consistent with modelV2 source edges** in the sampled evidence. No dataset-wide geometry correction indicated. Short fragments perform equal to or better than long fragments. Overlap pairs are valid adjacent evidence.

**Artifacts:** `audit_stage12_visual_validation.json`, `audit_stage12_visual/`, `audit_dataset_v11_stage12.json`.

---

### Stage 12B — camera-frame visual validation ⛔ BLOCKED (Track A: imagery acquisition)

**Status:** Blocked — encoded frame references exist in qlogs but route-matching camera files and projection inputs are unavailable. BEV overlays are **not** camera validation.

#### Imagery acquisition audit (`stage12b_imagery_acquisition.js`)

Representative scan: `qlog_f449c_0.bz2` (dongle `f449c322f59e6943`, openpilot `10.0.5-release`).

| Item | Finding |
|------|---------|
| EncodeIndex events | **3725** per 60 s segment (tags 14/74/75) |
| Encoder types | `BIG_BOX_LOSSLESS`, `FULL_HEVC`, `BIG_BOX_HEVC` |
| Encode rate | ~**60.5 Hz** |
| modelV2 rate | ~**0.5 Hz** (31 frames/segment) |
| Embedded camera pixels | **0** (FrameData.image not populated) |
| Route HEVC files (`fcamera.hevc`, `ecamera.hevc`, `dcamera.hevc`) | **Not found** adjacent to qlog workspace |
| LiveCalibration | Present (calPerc 100) but **extrinsic matrix empty** in decoded sample; RPY list decode incomplete |
| CarParams / intrinsics | **Not extracted** |

**Expected openpilot layout:** `<route_dir>/fcamera.hevc`, `ecamera.hevc`, `dcamera.hevc` alongside `qlog` — segment index `N` in `qlog_f449c_{N}.bz2` maps to 60 s chunk; `EncodeIndex` fields: `frameId`, `encodeId`, `segmentNum`, `segmentId`, `type`, `timestampSof/Eof`.

**Missing inputs for Stage 12B unblock:**
1. Route-matching HEVC bitstream files referenced by EncodeIndex
2. HEVC SPS/PPS initialization data
3. Camera intrinsics (focal length, distortion) from CarParams
4. Camera-to-vehicle extrinsics (LiveCalibration decode)
5. ModelV2-to-image projection pipeline

**Artifact:** `audit_stage12b_imagery.json`

---

### Stage 13 — zero-polygon diagnostics ✅ APPROVED (Track B)

**Objective:** Read-only investigation of **13** remaining zero-polygon segments. No production geometry changes. No threshold tuning, pose changes, or segment-specific logic.

**Segments:** `9, 17, 26, 31, 37, 50, 57, 60, 62, 65, 87, 90, 96`

| Tool | Output |
|------|--------|
| `lib/stage13_zero_polygon_diagnostics.js` | Per-segment fusion/pose diagnostics |
| `stage13_zero_polygon_diagnostics.js` | CLI for all 13 segments |
| `tests/stage13_zero_polygon_diagnostics.test.js` | 5 tests |

#### Classification summary

| Classification | Segments |
|----------------|----------|
| `correctly_rejected_for_insufficient_evidence` | **9, 26, 60, 62, 96** |
| `blocked_by_multi_pass_ambiguity` | **57** |
| `blocked_by_polygon_validation` | **65** |
| `blocked_by_run_pairing_misalignment` | **90** |
| `inconclusive_without_camera_imagery` | **17, 31, 37, 50, 87** |

#### Key findings

| Seg | Passes | Sections | Primary cause | Paired cov. | Attempted | Rejection |
|-----|--------|----------|---------------|-------------|-----------|-----------|
| 9 | 1 | 1 | insufficient evidence | 9.7 m | 0 | — |
| 17 | 1 | 1 | inconclusive | — | 0 | — |
| 26 | 1 | 2 | pose fragmentation + insufficient | — | 0 | — |
| 57 | **2** | **5** | multi-pass + pose fragmentation | 0 (pass 0) | 0 | — |
| 62 | 1 | **15** | pose fragmentation (14 rejections) | — | 0 | — |
| 65 | 1 | 1 | polygon validation (`blocked_by_polygon_validation`) | 9.1 m | **1** | `selfIntersecting` |
| 90 | 1 | 1 | run-pairing misalignment (`blocked_by_run_pairing_misalignment`) | 1199 m diag. / **0 m** qualifying overlap | 0 | `insufficientPairedCoverage` |

**No production correction approved** for any zero-polygon segment.

**Artifact:** `audit_stage13_zero_polygon.json`, `audit_dataset_v11_stage13.json`

```bash
node stage12b_imagery_acquisition.js --out audit_stage12b_imagery.json
node stage13_zero_polygon_diagnostics.js --out audit_stage13_zero_polygon.json
node dataset_audit.js --all --out audit_dataset_v11_stage13.json
```

**Tests:** **146/146 pass** (137 prior + 9 new Stage 12B/13 tests). Processing frozen at `2026-07-24-fusion-v11`. Zero-polygon count: **13**.

---

### Stage 13A — fusion-path tracing ✅ APPROVED (read-only)

**Objective:** Targeted 11-stage fusion-path trace for segments **90** and **65**, plus negative controls. No production geometry changes. Correction allowed only for demonstrated dataset-wide defects.

| Tool | Output |
|------|--------|
| `lib/stage13a_fusion_trace.js` | Per-stage L/R counts, run pairing, polygon inspection |
| `stage13a_fusion_trace.js` | CLI (`--segments 90,65 --controls`) |
| `tests/stage13a_fusion_trace.test.js` | 7 trace-focused tests |

**Negative controls:** seg **0** (straight valid), **10** (curved valid), **9** (insufficient evidence), **57** (multi-pass).

#### Segment 90 — `blocked_by_run_pairing_misalignment`

**Final classification:** `blocked_by_run_pairing_misalignment`

The apparent coverage contradiction is reconciled:

| Metric | Value |
|--------|-------|
| Aggregate fused paired span (diagnostic) | **~1199.3 m** |
| Left supported runs | **15** |
| Right supported runs | **4** |
| Qualifying paired-run overlap (≥ 4 m) | **0 m** |
| Polygon attempts | **0** |

Aggregate per-side span is **not** equivalent to co-located supported-run coverage. Sparse observations and source-bin gaps split the two sides into disjoint run ranges. Production correctly rejects seg 90 with `insufficientPairedCoverage`. **Do not** bridge gaps or lower the paired-overlap requirement.

**Dataset-wide defect check:** `detectDatasetWideDefects()` found no implementation defect (reversed s, bin-key bugs, reversed overlap endpoints).

#### Segment 65 — `blocked_by_polygon_validation`

**Final classification:** `blocked_by_polygon_validation`

| Property | Value |
|----------|-------|
| Supported runs | **1** left, **1** right |
| Qualifying paired-run overlap | **7.16 m** |
| Resampled points | **4** (current minimum) |
| Polygon attempts | **1** |
| Rejection | `selfIntersecting` (1 intersection) |
| Lane widths at samples | 8.42, 10.82, 10.02, 8.57 m (valid) |
| Ring order | left forward → right reverse (standard) |
| Intersecting edges | bridge **L3→R3** × boundary **R2→R1** (`crossesLegs: true`) |

**Established findings (retained):**

- One left run and one right run with 7.16 m paired overlap.
- Four resampled points (current minimum); one polygon attempted.
- Downstream bridge edge L3→R3 intersects boundary edge R2→R1.
- Validation correctly rejects the ring as `selfIntersecting`.
- Negative controls show no general ring-order failure.
- Current evidence is insufficient to justify changing polygon construction.

**Verdict:** Likely sparse/tight-curve construction ambiguity, correctly rejected under current validation. The d change from +5.42 m to +5.27 m is only 0.15 m and must not be described as a lateral jump; crossing an east-coordinate sign boundary is not independently evidence of a boundary discontinuity. **Do not** claim sparse evidence as the proven cause.

**No production correction approved.** Do not disable self-intersection validation or lower support requirements.

#### Negative control outcomes (unchanged)

| Seg | Polygons | Qualifying overlap | Notes |
|-----|----------|-------------------|-------|
| 0 | 1 | 6.9 m | straight valid |
| 10 | 15 | 124.4 m | curved valid |
| 9 | 0 | 0 m | insufficient evidence (9.7 m aggregate) |
| 57 | 0 | 0 m | 2 passes, 6 pose sections |

**Artifacts:** `audit_stage13a_fusion_trace.json`, `audit_dataset_v11_stage13a.json`

```bash
node stage13a_fusion_trace.js --segments 90,65 --controls
node --test tests/stage13a_fusion_trace.test.js
node dataset_audit.js --all --out audit_dataset_v11_stage13a.json
```

**Tests:** **153/153 pass**. Full 92-segment audit: **0 failures**, **13 zero-polygon** unchanged. Processing frozen at `2026-07-24-fusion-v11`. **No production geometry modified.**

---

### Stage 14 — final quality & delivery-readiness ✅ APPROVED (2026-07-24)

**Objective:** Consolidated reporting with **scope-separated** accounting. No production geometry changes.

| Deliverable | Path |
|-------------|------|
| Final quality report | `reports/stage14_final_quality_report.md` |
| Delivery-readiness audit | `audit_stage14_delivery_readiness.json` |
| Chunk reconciliation | `audit_stage14_chunk_reconciliation.json` |
| Tooling | `lib/stage14_chunk_reconciliation.js`, `lib/stage14_delivery_readiness.js` |

#### Reporting units (defined)

| Unit | Scope |
|------|-------|
| Physical route segment | One `qlog_f449c_{N}.bz2` (92 entries) |
| Route chunk | Temporal sub-span within a segment (97 discovered) |
| First chunk per segment | `routeChunks[0]` — matches `dataset_audit.js` |
| All chunks per segment | Sum across every `routeChunks[]` entry |

#### Summary A — first-chunk dataset audit (`dataset_audit.js`)

| Metric | Value |
|--------|-------|
| Accepted polygons | **524** |
| Polygon-producing segments | **79** |
| First-chunk zero-polygon segments | **13** |

#### Summary B — all-chunk output audit (delivery JSON)

| Metric | Value |
|--------|-------|
| Total discovered chunks | **97** |
| Accepted fragments | **540** (307 useful + 233 short) |
| All-chunk polygon-producing segments | **81** |
| All-chunk zero-polygon segments | **11** |

**16-polygon difference (540−524)** fully attributed to segments **7** (+6), **26** (+9), **96** (+1).

Segments **26** and **96**: first-chunk zero-polygon (diagnostics retained) but **all-chunk producing** — excluded from all-chunk zero total. Segment **7**: first-chunk producing (1 polygon) with 6 additional polygons in chunk 1.

**Do not mix scopes** when citing polygon-producing or zero-polygon counts.

**Tests:** **171/171 pass**. Stage 14 consistency: **PASSED**. **Gate:** Approved 2026-07-24.

#### Final project status

| Item | Status |
|------|--------|
| Processing version | `2026-07-24-fusion-v11` (frozen baseline) |
| Production geometry | Unchanged |
| v11 road-surface extraction | Delivery-ready (conservative, scope-documented) |
| Lane counting | **Incomplete** |
| Amap-style HD-map | **Incomplete** |
| Stage 12B camera validation | **BLOCKED** |
| Overall HD-map project | **INCOMPLETE** |

Do **not** describe v11 as a complete lane-counting or Amap-style HD-map system.

---

### Stage 15 — lane-divider evidence assessment & lane-counting design ✅ APPROVED

**Stage 16** projected lane-line observations ✅ **APPROVED** (2026-07-23). **Stage 17** temporal divider association and supported-run fusion ✅ **APPROVED** (2026-07-23). **Stage 18** lane-interval construction and prototype same-direction interval-count assessment ✅ **APPROVED** (2026-07-24). Production lane counting **not implemented**. Stage 19 **pending authorization** — not started.

| Deliverable | Path |
|-------------|------|
| Evidence assessment report | `reports/stage15_lane_divider_assessment.md` |
| Lane-counting design | `reports/stage15_lane_counting_design.md` |
| Evidence audit JSON | `audit_stage15_lane_divider_evidence.json` |
| Tooling | `lib/stage15a_classification_audit.js`, `lib/stage15_lane_evidence.js`, `lib/stage15_geometry.js` |

```bash
node stage15_lane_divider_assessment.js --out audit_stage15_lane_divider_evidence.json
node --test tests/stage15a_classification_audit.test.js
```

#### Stage 15A — ego-boundary classification audit ✅ APPROVED

**Key finding:** The prior 5,522 ego-boundary count (= 2 × 2,761 frames) reflected unconditional nearest-to-centre selection without confidence gates. Corrected classifier retains **4,381** ego-boundary classifications (mean **1.59**/frame).

**A. Candidate availability** (exhaustive, sums to 2,761):

| Outcome | Frames | % |
|---------|--------|---|
| both_valid | 2,077 | 75.2% |
| left_only_valid | 74 | 2.7% |
| right_only_valid | 153 | 5.5% |
| neither_valid | 457 | 16.6% |

**Reconciliation:** `2 × both_valid + left_only_valid + right_only_valid = 4,381` → 2×2,077 + 74 + 153 = **4,381** ✓

**B. Frame assessment reasons** (primary, sums to 2,761):

| Reason | Frames |
|--------|--------|
| accepted_both | 2,077 |
| rejected_left_confidence | 152 |
| rejected_right_confidence | 71 |
| rejected_both_confidence | 456 |
| rejected_left_uncertainty | 2 |
| rejected_right_uncertainty | 3 |

**Confidence failure sides** (not merged into “one side”):
- left only: 152
- right only: 71
- both: 456

**Classification reconciliation:**
- both_valid frames → 4,154 retained classifications (2,077 × 2)
- single-valid frames → 227 retained classifications (74 left + 153 right)
- 4,381 − 4,154 = **227** fully assigned to left_only_valid + right_only_valid

**Slot semantics (decoded):** index 0 = outer-right; 1 = inner-right ego; 2 = inner-left ego; 3 = outer-left. Right ego corrected from index 0 → 1 on all 2,761 frames.

**Road-edge interval metrics (corrected denominators):**

| Metric | Value |
|--------|-------|
| Comparable frames | 2,761 |
| Comparable line observations | 11,044 |
| Inside road-edge interval | 8,901 (**80.6%** of lines) |
| Both retained ego inside | 2,076 / 2,077 both_valid frames |
| ≥1 retained ego inside | 2,304 / 2,304 frames with any retained ego |

Frame-level inside metrics use **retained valid ego only**; rejected candidates excluded.

**`minLaneProb=0.5`:** frozen **v11 production** default in `lib/transform.js` → `extractModelGeometry` and `lib/process_route.js`. Stage 15 assessment reuses it for prob-filtered frame counts only.

**Stage 16** projected lane-line observation prototype ✅ **APPROVED**. Stage 16 does not implement divider tracking, fusion, lane intervals, or lane counting.

| Deliverable | Path |
|-------------|------|
| Projection report | `reports/stage16_projected_lane_observations.md` |
| Projection audit JSON | `audit_stage16_projected_lane_observations.json` |
| Versioned observations | `projected_lane_observations_v0.json` |
| BEV inspections | `reports/stage16_bev/` |
| Tooling | `lib/stage16_lane_line_projection.js`, `lib/stage16_projection_audit.js`, `lib/stage16_projection_schema.js`, `lib/stage16_bev_inspection.js` |

```bash
node stage16_lane_line_projection.js --out audit_stage16_projected_lane_observations.json
node --test tests/stage16_lane_line_projection.test.js
```

#### Stage 16 — projected lane-line observations ✅ APPROVED

| Metric | Value |
|--------|-------|
| Schema version | `2026-07-24-lane-projection-v0` |
| Source slot observations | 11,044 |
| Projected observations | 5,809 (52.6%) |
| Raw decoded points | 364,452 |
| Rejected outside device-X window | 77,308 |
| Points after X window | 287,144 |
| Points in observation-rejected records | 125,112 |
| Points submitted to projection | 162,032 |
| Projected points | 122,439 |
| Rejected perpendicular distance | 37,000 |
| Discarded non-primary fragments | 2,593 |
| Projection consistency | passed |
| v11 modified | no |

**Tests:** **294/294 pass**. Lane counting **not implemented**. Stage 17 **approved**. Stage 18 **approved**. Stage 19 **pending authorization**, not started.

#### Stage 17 — temporal divider association & supported-run fusion ✅ APPROVED

**Canonical project status**

| Stage / item | Status |
|--------------|--------|
| Stage 15 | approved |
| Stage 15A | approved |
| Stage 16 | approved |
| Stage 17 | approved |
| Stage 18 | approved (`2026-07-24-lane-interval-assessment-v0`) |
| Stage 19 | pending authorization — not started |
| v11 baseline | frozen and unchanged |
| Stage 12B | blocked |
| Production lane counting | not implemented |
| Physical-road validation | not completed |
| Overall HD-map system | incomplete |

**Approved totals**

| Metric | Value |
|--------|-------|
| Tracking schema | `2026-07-24-lane-divider-tracking-v0` |
| Stage 16 projected input | 5,809 |
| Observations assigned to tracks | 5,752 |
| Observations excluded (ambiguous) | 57 |
| Associated observations | 5,010 (86.2%) |
| New-track observations | 742 (12.8%) |
| Rejected ambiguous | 57 (1.0%) |
| Divider tracks | 742 |
| Supported runs | 878 |
| Explicit gaps | 136 |
| Runs − tracks = gaps | 878 − 742 = 136 (invariant) |
| Legacy index-position mismatches | 1,230 (support-change noise; not physical crossings) |
| Pairwise lateral-order inversions (persisting tracks) | 0 |
| rejected_crossing outcomes | 0 |
| Cross-chunk association | **forbidden** (chunkId in grouping key) |
| Tracking consistency | passed |
| v11 modified | no |
| Stage 16 modified | no |

The audit found 1,230 legacy index-position mismatches caused by support changes. It found zero pairwise lateral-order inversions among persisting tracks. These mismatches are not evidence of physical divider crossings.

**Approved (2026-07-23):** track-membership reconciliation, outcome/birth-reason semantics, lateral-order audit, crossing audit categories, chunk-boundary policy (cross-chunk forbidden), Hungarian/ambiguity fixtures, sensitivity sweeps (prototype), run/gap invariants, fragmentation audit, enriched BEV manifest (11 categories).

```bash
node stage17_lane_divider_tracking.js --out audit_stage17_lane_divider_tracking.json
node --test tests/stage17_lane_divider_tracking.test.js
```

#### Stage 18 — lane-interval construction & prototype interval-count assessment ✅ APPROVED

| Metric | Value |
|--------|-------|
| Schema version | `2026-07-24-lane-interval-assessment-v0` |
| Stage 17 supported runs (input) | 878 |
| Divider-pair candidates | 834 |
| Accepted pairings / intervals | 5 |
| Assessed numeric same-direction interval counts | 1 (count = 2) |
| Incomplete outer-boundary assessments (null count) | 7 |
| Stage 17 gaps preserved | 136 / 136 |
| Legacy `rejected_non_positive_width` aggregate | 0 (704 pre-review count superseded) |
| Width/order failure records | 408 (`partial_order_exchange`: 329, `geometric_intersection_candidate`: 79) |
| Crossing candidates / accepted with crossing | 79 / 0 |
| Stage 18 consistency | passed |
| v11 modified | no |
| Stages 15–17 modified | no |

**Approved (2026-07-24):** signed-width policy, local route-s adjacency, pairing accounting, width/order failure investigation, run-usage reconciliation, crossing policy, count-stability terminology, gap preservation, 13-parameter sensitivity (39 sweeps), performance optimization (~5 s full build).

The sole numeric result (`0:0:4:assess:1.3:160.3`, supported same-direction interval count = 2) is evidence-supported only — not a total physical-road lane count.

```bash
node stage18_lane_interval_assessment.js
node --test tests/stage18_lane_interval_assessment.test.js
```


**Files confirmed corrupted during investigation (now regenerated):**
| File | Symptom | Regenerated |
|------|---------|-------------|
| `audit_dataset_v7_full.json` | `baselineVersion` instead of `processingVersion` | Yes — from live processing |
| `audit_dataset_v8_full.json` | same | Yes — from live processing |

**Files never corrupted:** `audit_dataset_full.json` (v6b baseline), reference audits, comparison outputs (when written to correct 4th arg).

**Fix:** `compare_audits.js` output path → `process.argv[4]`. Validator: `verify_audit_integrity.js` rejects files missing `results[]`.

### Integrity commands & hashes (2026-07-23T04:17Z)

```bash
node verify_audit_integrity.js --fix
node dataset_audit.js --all --movement-only --out audit_dataset_v9_movement_full.json
node dataset_audit.js --all --out audit_dataset_v9_full.json
node compare_audits.js audit_dataset_full.json audit_dataset_v9_movement_full.json audit_comparison_v6b_v9movement.json
node compare_audits.js audit_dataset_v8_full.json audit_dataset_v9_full.json audit_comparison_v8_v9.json
node transform_frame_audit.js 2
node transform_frame_audit.js 99
node classify_zero_polygon_delta.js audit_dataset_v7_full.json audit_dataset_v8_full.json
```

| Artifact | SHA-256 (prefix) | mtime |
|----------|------------------|-------|
| `audit_dataset_full.json` (v6b) | `e0ad975af5f0e403` | 2026-07-23T03:44:31Z |
| `audit_dataset_v7_full.json` | `b30f5c0c26eb4d6f` | 2026-07-23T04:09:57Z |
| `audit_dataset_v8_full.json` | `54e546fa2a0d95d6` | 2026-07-23T04:10:53Z |
| `audit_dataset_v9_full.json` | `9ee7c00b628289b4` | 2026-07-23T04:17:37Z |
| `audit_dataset_v9_movement_full.json` | (see `checkpoints/audit_integrity_report.json`) | regenerated |

Full integrity report: `checkpoints/audit_integrity_report.json`

### Transform chain (verified, no code change required)

| Property | Value |
|----------|-------|
| Axes | x=forward, y=left, z=up (vehicle frame) |
| Yaw | Degrees, clockwise from north |
| Rotation | `east = E + x·sin(θ) − y·cos(θ)`, `north = N + x·cos(θ) + y·sin(θ)` |
| Translation origin | First valid GPS fix per segment (`setLocalCoords`) |
| Heading order | GPS bearing (speed≥2) → motion bearing → GPS fallback → 0 |
| Model/pose alignment | `interpolateGpsAtTime(model.logMonoTime)`, max Δ 2 s |
| Behind vehicle | `x < −5 m` excluded from `transformXyztLine` |
| Pose source | `gpsLocation` only; Kalman never used for projection |

Unit tests: `tests/transform.test.js` (12 cases: yaw ±90°, lateral, behind, translation, stale gap, non-finite).

### Segment 2 — frame 3123 (`selfIntersection` → suppressed)

**Observation pair at split:**
| | Previous (3083) | Current (3123) |
|--|-----------------|----------------|
| logMonoTime | 171706391399 | 173712039287 |
| Map position | (−47.72, −25.95) | (−49.22, 0.78) |
| Heading | 357.31° (interpolated GPS) | 357.51° |
| Speed | 12.76 m/s | 13.74 m/s |
| Movement state | moving | moving |
| Model/GPS Δ | 0 ns | 0 ns |

- **Displacement:** 26.77 m in 2.01 s → **13.35 m/s** implied  
- **Motion bearing:** 356.80°; **heading disagreement:** 0.71°  
- **Pose continuity:** **passed** (step < 35 m, implied < 55 m/s)

**Intersecting segments (GPS vehicle path chords, not model geometry):**
- Earlier: frames **2443→2483** (−24.06,−6.69) → (−56.86,−16.87)  
- New: frames **3083→3123** (−47.72,−25.95) → (−49.22, 0.78)  
- **Along-track from hit to split:** 380.75 m  

**Verdict:** Category **5 — invalid pass-detection rule**. GPS chords at ~0.5 Hz cross on a forward curve; transform and pose continuity are correct. Not model-path or fused-geometry intersection.

**Why pose continuity did not reject:** Valid 26.8 m step at 13.3 m/s; rejection at 3243→3283 (35 m jump) occurs **later** and creates a pose section, not a temporal pass.

### Segment 99 — frame 119803 (`spatialRevisit` → suppressed)

**Revisit pair:**
| | Earlier (118963, index 3) | Current (119803) |
|--|---------------------------|------------------|
| Position | (−40.88, −43.68) | (−41.68, −43.76) |
| Time | 5964229387910 | 6006146226986 |
| **Euclidean sep** | **0.80 m** | |
| **Along-track travel** | **332.6 m** | |
| **Travel/euclidean ratio** | **413.3** | |
| Movement state | moving | moving |
| Headings | 289.59° / 32.78° | |

**Verdict:** Category **5 — invalid pass-detection rule**. Vehicle did **not** physically return; sparse GPS curve brings chords within 8 m after 333 m travel. Raw **vehicle positions** only; no pose rejection (continuity valid at 31 m / 15.6 m/s).

### Pass-detection fix (v9, named config)

```js
selfIntersectionMinAlongTrackSepM: 45,      // suppress chord crossing when hit is far along-track
spatialRevisitMaxTravelToEuclideanRatio: 50 // suppress revisit when travel >> euclidean closure
```

Tests: `tests/passes_sparse_path.test.js` (reference trajectories from seg 2/99 audits).

### v9 regression results

| Audit | Multi-pass | Zero-polygon | Median ms | Failures |
|-------|------------|--------------|-----------|----------|
| v6b baseline | 21 | 16 | 629 | 0 |
| v9 movement-only | **2** | 25 | ~579 | 0 |
| v9 full (pose) | **2** | 37 | 565 | 0 |
| v8 full (prior) | 4 | 36 | 562 | 0 |

**Reference (v9):** seg 2,6,54,58,99 all **1 pass**; seg 2 has 2 polygons.  
**Remaining multi-pass:** segments **25** (4× sharpHeadingChange, moving), **57** (directionReversal, moving).  
**Stability-group pass regressions:** 0.  
**v8→v9 pass changes:** seg 2 and 99 only (2→1), both improvements.

### v7→v8 zero-polygon increase (+12 net, 17 lost polygons)

Classified in `audit_zero_polygon_v7_v8.json`: **17 segments** lost polygons v7→v8, all **`excessive_section_fragmentation`** — pose continuity `positionJump` at ~2 s GPS spacing creates near-per-frame pose sections (~20–30 sections/segment), preventing paired-edge fusion within sections. **No fusion across rejected gaps** (by design). Not fixable by lane thresholds; requires pose-section tuning (future stage).

### Tooling added

- `verify_audit_integrity.js` — detect corruption, regenerate, re-compare  
- `transform_frame_audit.js` — per-segment split forensics  
- `classify_zero_polygon_delta.js` — v7/v8 polygon regression taxonomy  
- `tests/transform.test.js`, `tests/passes_sparse_path.test.js`

### Upstream gate status

**PASSED** for reference segments 2 and 99 (explained + fixed with dataset-wide geometric rules). Lane/polygon threshold tuning remains deferred; pose-section fragmentation (v7→v8 zero-polygon) is a separate upstream issue.

---

## Stage 6 gate — movement state (`2026-07-24-pose-v7`) ✅

**Server note:** Live API runs **v8** (movement state + pose continuity). Movement-only regression uses `node dataset_audit.js --movement-only` which reports version `2026-07-24-pose-v7` and disables pose-section fusion.

### Reference segments (reprocessed, no v6b cache reuse)

| Seg | v6b passes | v7 passes | Split reason (v7) | Suppressed reversals |
|-----|------------|-----------|-------------------|----------------------|
| 2 | 2 | **2** | `selfIntersection` @ 3123 | 0 |
| 6 | 3 | **1** | — | **2** |
| 54 | 1 | **1** | — | 0 |
| 58 | 3 | **1** | — | **2** |
| 99 | 2 | **2** | `spatialRevisit` @ 119803 | 0 |

### Full dataset (92 segments) — v6b vs v7

| Metric | v6b | v7 | Delta |
|--------|-----|-----|-------|
| Multi-pass segments | 21 | **4** | −17 |
| Zero-polygon segments | 16 | 24 | +8 (fusion unchanged; flagging only) |
| Median processing ms | 629 | 579 | −50 ms |
| Processing failures | 0 | 0 | — |
| Suppressed reversal candidates | 0 | **29** | +29 |
| Stability-group pass regressions | — | **0** | — |

**Movement-state counts (v7, frame-step aggregate):** moving 2166, stationary 152, creeping 0, uncertain 304.

**Remaining multi-pass (v7):** segments **2, 25, 57, 99** only.

### Per-segment pass-count changes (17 segments, all decreases)

| Seg | v6b→v7 | Why |
|-----|--------|-----|
| 66 | 6→1 | 3 suppressed `directionReversal` + removed `sharpHeadingChange`/`selfIntersection` splits at stationary/uncertain |
| 62 | 5→1 | 2 suppressed reversals; 4× `sharpHeadingChange` no longer split while not `moving` |
| 60 | 4→1 | 3 suppressed `directionReversal` at stop |
| 65 | 4→1 | 1 suppressed reversal; `selfIntersection` splits gated off non-moving states |
| 96 | 4→1 | 4 suppressed `directionReversal` at stationary |
| 6 | 3→1 | 2 suppressed reversals during 21 m stationary drift |
| 58 | 3→1 | 2 suppressed reversals during low-speed GPS noise |
| 67 | 3→1 | 1 suppressed reversal + `sharpHeadingChange` gated |
| 5, 23, 27, 59, 61, 95, 97 | 2→1 | Suppressed `directionReversal` (and `sharpHeadingChange` where applicable) |
| 9, 64 | 2→1 | `selfIntersection` split no longer fires when movement state ≠ `moving` |

**Unchanged multi-pass:** 2 (`selfIntersection`), 25 (4× `sharpHeadingChange` while `moving`), 57 (`directionReversal` while `moving`), 99 (`spatialRevisit` on curve).

### Production rule check

`grep` on `lib/**/*.js`: **no segment-ID conditionals** in production pipeline code. Segment IDs appear only in CLI defaults, tests, and audit tooling.

### Artifacts

- `audit_dataset_v7_full.json` — full 92-segment v7 audit  
- `audit_reference_v7_rerun.json` — reference reprocess  
- `audit_comparison_v6b_v7.json` — v6b↔v7 diff (fixed `compare_audits.js` argv bug)  

**Stage 6 verdict:** Dataset-wide regression **acceptable** — 0 pass-count increases, 0 stability-group regressions, major false multi-pass reduction.

---

## Stage 7 — pose continuity (`2026-07-24-pose-v8`) ✅

### Implementation

- `lib/pose_continuity.js` — transition validation, pose sections, sectioned trajectories  
- `lib/sd_fusion.js` — fusion per temporal-pass × pose-section; `poseContinuityEnabled` flag for v7 audits  
- `public/render.js` — draws `trajectorySegments` without cross-gap connectors  
- `lib/process_route.js` — exposes `trajectorySegments` on route chunks  
- Tests: `tests/pose_continuity.test.js` (passing); full suite **44/44 pass**

### v7 vs v8 (92 segments)

| Metric | v7 | v8 | Notes |
|--------|----|----|-------|
| Multi-pass | 4 | 4 | **Identical** — pose sections do not change temporal passes |
| Zero-polygon | 24 | 36 | Pose-section splits reduce per-section fusion coverage (expected upstream tradeoff) |
| Median ms | 577 | 561.5 | Slightly faster |
| Pass regressions | — | **0** | |
| Stability regressions | — | **0** | |

### Reference pose diagnostics (v8)

| Seg | Passes | Pose sections | First rejected transition |
|-----|--------|---------------|---------------------------|
| **2** | 2 | 2 | `positionJump` frames 3243→3283: **35.2 m** in 2.0 s (**17.7 m/s**). Temporal split remains at frame 3123 (`selfIntersection` — earlier than pose break). |
| **6** | 1 | 2 | `headingMotionDisagreement` frames 7563→7603 during stationary tail |
| 54 | 1 | 1 | none |
| 58 | 1 | 1 | none (2 suppressed reversals) |
| **99** | 2 | 1 | **No pose rejection.** Multi-pass from `spatialRevisit` @ 119803 — GPS path revisits prior point after ~494 m travel on sparse 30-frame polyline (curve artifact, not pose gap). |

### Artifacts

- `audit_dataset_v8_full.json`  
- `audit_comparison_v7_v8.json`  

**Upstream gate:** Pass-count stable v7→v8. Polygon count regression is pose-section fragmentation — **lane/polygon tuning deferred** until transform audit (Stage 8).

---

## Original investigation (Stages 1–5)

**Baseline processing version:** `2026-07-23-validate-v6b`  


## 1. Dataset inventory

| Metric | Value |
|--------|-------|
| Qlog files (`qlog_f449c_*.bz2`) | **92** |
| Total size | **0.24 GB** |
| Complete qualified (current rules) | **92** |
| Incomplete / rejected | **0** (current `segment_qualify.js` thresholds are permissive) |
| Typical segment duration | ~58 s |
| Typical modelV2 count | 30 (~0.5 Hz) |
| Typical GPS count | 60 (1 Hz) |
| Segment ID ↔ filename | `qlog_f449c_{N}.bz2` — numeric suffix is segment ID |

**Artifacts:** `audit_dataset_full.json`, `audit_reference_baseline.json`, `.cache/qlog-extracts/` (SHA-256 keyed), legacy `modelV2_extracted.json` / `gps_extracted.json`.

**Processing time (cold, single segment):** median **~630 ms** (parse + fusion). Full dataset audit: **~59 s** for 92 segments.

---

## 2. Processing architecture

```
qlog_f449c_N.bz2
  → lib/qlog_parse_once.js (single-pass audit + modelV2 + GPS)
  → lib/process_route.js
       → gps_validate + enrichGpsHeadings (alignment.js)
       → interpolateGpsAtTime per model frame
       → transform.js (modelToGlobal)
       → chunking.js
       → lib/sd_fusion.js → passes.js (detectPasses)
       → lane_tracking.js, lane_support.js, geometry_sanity.js
  → server.js /api/process (hash-keyed result cache)
  → public/app.js + render.js
```

**Pose source:** `gpsLocation` (tag 20) only — `lib/pose_source.js`. LiveLocationKalman never used for projection (gpsOK=false on all samples).

---

## 3. Ranked dataset-wide failure categories

| Rank | Category | Segments affected | Severity |
|------|----------|-------------------|----------|
| 1 | **False multi-pass** (`detectPasses`) | 21 / 92 (23%) | High |
| 2 | **Stationary GPS drift** (>15 m accumulated at speed <2 m/s) | 12 / 92 | High |
| 3 | **Zero road polygons** (may be valid) | 16 / 92 | Medium–High |
| 4 | **Self-intersection pass splits** | subset of multi-pass | High |
| 5 | **Spatial-revisit pass splits** | subset of multi-pass | High |
| 6 | **Lane fragmentation** (low fused lane / track ratio) | e.g. seg 6, 58 | Medium |
| 7 | **No pose-section / continuity model** | all | High (architectural) |

---

## 4. Reference segment baseline (v6b)

| Seg | Expected (video) | Actual passes | Split reason | Polygons | Stationary drift |
|-----|------------------|---------------|--------------|----------|------------------|
| **2** | 1 pass, forward curve | **2** | `selfIntersection` @ frame 3123 | 2 | 0 m |
| **6** | 1 pass + stationary | **3** | `directionReversal` ×2 @ 7643, 8323 | 2 | **21.4 m** |
| **54** | 1 pass | **1** ✓ | — | **0** | **22.0 m** |
| **58** | 1 pass | **3** | `directionReversal` ×2 @ 69923, 70083 | 1 | 7.0 m |
| **99** | 1 pass, curves | **2** | `spatialRevisit` @ 119803 | 2 | 0 m |

**Worst multi-pass segments:** 66 (6 passes), 62 (5), 25/60/65/96 (4 passes).

---

## 5. Root-cause hypotheses (ranked by evidence)

### H1 — Pass detection ignores movement state (STRONG)
- **Evidence:** Seg 6 splits at `directionReversal` while `stationaryDriftM=21.4`, 22 low-speed points; dot thresholds triggered on GPS noise.
- **Code:** `lib/passes.js` lines 123–124: `step > 0.5 && dot < reversalDotThreshold (-0.3)` — no speed gate.
- **Against:** Some multi-pass segments may have genuine loops (unverified without video).
- **Test:** Reprocess seg 6 with movement-state gate; expect 1 pass.

### H2 — Stationary GPS drift extends trajectory (STRONG)
- **Evidence:** Seg 54/6 accumulate ~22 m drift at speed <2 m/s; dataset p95 stationary drift ~22 m.
- **Code:** `vehiclePath` built from all GPS-aligned frame poses without drift suppression.
- **Test:** Measure displacement distribution; cap trajectory extension when `stationary`.

### H3 — Self-intersection / spatial-revisit on accumulated noise (MEDIUM–STRONG)
- **Evidence:** Seg 2 `selfIntersection`, Seg 99 `spatialRevisit` without video-confirmed reversal.
- **Code:** `passes.js` `segmentIntersectsPath`, revisit loop — uses raw east/north steps.

### H4 — No pose-section separation (STRONG, architectural)
- **Evidence:** Fusion runs across full chunk; no `poseSectionId`; invalid intervals not rejected.
- **Code:** `process_route.js` has no consecutive-pose validation.

### H5 — Transformation math incorrect (WEAK for ref cases)
- **Evidence:** `transform.js` documents standard rotation; unit tests exist for bearing 0/90.
- **Needs:** Frame-pair audit on seg 2 first suspicious frame (3123).

---

## 6. Evaluation groups

### Group 1 — Known-problem reference
`2, 6, 54, 58, 99` — video-reviewed, regression gate required.

### Group 2 — Auto-detected problem (sample)
Multi-pass: `5, 9, 23, 25, 27, 57, 59, 60, 61, 62, 64, 65, 66, 67, 95, 96, 97, 99`  
Stationary drift + flags: `7, 22, 56, 59, 60, 62, 64, 66, 67, 95, 96`  
Zero polygon: `7, 9, 22, 24, 26, 28, 46, 50, 54, 56, 60, 65, 72, 92, 96`

### Group 3 — Stability controls (60 segments, no severity flags)
Examples: `0, 1, 3, 4, 8, 10–21, 29–37, 39–45, 47–49, 51, 53, 55, 63, 68–69, 71, 73–75, 81–91, 93–94, 98, 100`  
**Note:** Not ground truth — selected for comparatively low automated flags only.

---

## 7. Motion / GPS-noise measurements (dataset-wide)

| Metric | min | median | p90 | p95 | max |
|--------|-----|--------|-----|-----|-----|
| Temporal pass count | 1 | 1 | 2 | 3 | **6** |
| Stationary drift (m, speed<2) | 0 | ~8 | ~21 | **~22** | ~24 |

**Proposed initial config (measurement-based, names only — not yet implemented):**

```js
movementState: {
  stationaryMaxSpeedMps: 2.0,           // from minSpeedForGpsBearing
  stationaryMaxStepM: 0.5,              // below p50 drift step at stop
  creepingMaxSpeedMps: 4.0,             // between stop and normal move
  movingMinConsecutiveSteps: 3,         // hysteresis
  stationaryMinConsecutiveSteps: 3,
  maxStationaryDriftM: 3.0,             // well below p90 noise (~21m) — tune from labelled periods
}
poseContinuity: {
  maxImpliedSpeedMps: 55,               // existing
  maxPositionJumpM: 30,                 // existing maxGpsGapM scale
  maxHeadingChangeLowSpeedDeg: 15,        // when speed < 2 m/s
  minDisplacementForReversalM: 5.0,       // reversal requires real movement
  reversalDotThreshold: -0.3,           // existing — only when moving
}
```

---

## 8. Implementation plan (stages 6–15)

| Stage | Work | Gate |
|-------|------|------|
| 6 | `lib/movement_state.js` + integrate before `detectPasses` | Reference + auto-problem group |
| 7 | `lib/pose_continuity.js` + pose sections | Upstream regression gate |
| 8 | Transform audit + frame-pair diagnostics | Unit tests + seg 2/99 first break |
| 9 | Trajectory rendering — no connectors across gaps | Visual + metrics |
| 10–11 | Lane tracking / polygons | **Only after upstream gate passes** |
| 12 | UI diagnostics + job deduplication | Backend enforced |
| 13–16 | Test commands, review, checkpoint | Full dataset |

**New processing version:** `2026-07-24-pose-v7` (will invalidate cache).

---

## 9. Test commands (defined, not yet wired to CI)

```bash
# Fast reference regression
node dataset_audit.js --segments 2,6,54,58,99 --out audit_reference.json

# Expanded (reference + flagged sample)
node dataset_audit.js --segments 2,6,54,58,99,25,62,66,96,0,10,30 --out audit_expanded.json

# Full dataset
node dataset_audit.js --all --out audit_dataset_full.json

# Unit tests (explicit glob — required on Windows)
node --test tests/*.test.js
```

---

## 10. Risks

- Over-aggressive stationary suppression could break genuine creeping traffic (seg 54).
- Tightening pass detection may miss rare true reversals — need displacement evidence rule.
- Stability group may still contain undetected issues (flags are necessary not sufficient).

---

## 11. Next action

**Stages 13/13A/14:** Approved. **Stages 15/15A:** Approved. **Stage 16:** Approved (projected lane-line observations). **Stage 17:** Approved (divider association + supported-run fusion). **Stage 18:** Approved (lane-interval construction and prototype same-direction interval-count assessment; `2026-07-24-lane-interval-assessment-v0`). **Stage 19:** Pending authorization — not started. Processing frozen at `2026-07-24-fusion-v11`. **v11 baseline:** frozen and unchanged. **Production lane counting:** not implemented. **Physical-road validation:** not completed. **Malaysian road-standard validation:** not completed. Stage 12B camera validation **BLOCKED**. Overall HD-map project **INCOMPLETE**.

```bash
node stage15_lane_divider_assessment.js --out audit_stage15_lane_divider_evidence.json
node stage12b_imagery_acquisition.js --out audit_stage12b_imagery.json
node stage13_zero_polygon_diagnostics.js --out audit_stage13_zero_polygon.json
node dataset_audit.js --all --out audit_dataset_v11_stage13.json
```


---

## Supreme Team routing

| Stage | Specialist |
|-------|------------|
| 1–5 Investigation | Admiral + investigate tooling |
| 6–9 Upstream build | build/build-management |
| 10–11 Lane/fusion | build (after gate) |
| 12 Diagnostics | build + design |
| 13 Testing | testing-and-qa |
| 14–15 Review | review/code-chief |
| Gate | gatekeeper-admiral |
