# Stage 14 — Final Quality, Limitations & Delivery-Readiness Report

**Date:** 2026-07-23  
**Processing version:** `2026-07-24-fusion-v11` (frozen)  
**Stage 14 status:** approved  
**Overall project status:** Baseline delivery-ready for conservative modelV2-based road-surface polygon extraction — **not** a completed HD-map system.

---

## 1. Pipeline scope

The v11 pipeline transforms openpilot qlog recordings into **supported road-surface polygons** derived from modelV2 road-edge observations and vehicle pose evidence.

### Processing flow

1. **Qlog decoding** — decompress and parse Cap'n Proto messages from `qlog_f449c_{N}.bz2`.
2. **modelV2 road-edge extraction** — extract left/right road edge polylines from modelV2 frames.
3. **GPS and pose processing** — validate GPS, interpolate pose at model timestamps, build reference trajectory.
4. **Temporal-pass separation** (Stage 8, frozen) — split multi-pass routes using movement-aware pass detection.
5. **Pose-section splitting** (Stage 9 v10, frozen) — reject discontinuous pose transitions; preserve gaps.
6. **Projection into route coordinates** — transform vehicle-frame edges to east/north; assign along-track `s` and lateral `d`.
7. **Fusion-bin construction** (Stage 10 v11) — bin observations at 2 m intervals; fuse per side with MAD outlier rejection.
8. **Supported-run detection** — split fused boundaries at gaps exceeding `maxInterpolationSpanM` (4 m).
9. **Left/right run pairing** — pair runs with ≥ 4 m s-range overlap.
10. **Polygon resampling and construction** — resample at 2 m; build ring (left forward, right reverse).
11. **Validation** — width bounds, vertex jump, self-intersection checks.
12. **Deterministic polygon IDs** — `segmentId:chunkId:passId:poseSectionId:fragmentIndex`.
13. **JSON and renderer output** — `roadSurfacePolygons[]` per chunk; renderer iterates all fragments.

**Important limitation:** Output represents supported road-surface polygons from modelV2 and pose evidence. It does not independently verify the physical road surface against camera pixels.

---

## 2. Reporting units and dataset-level results

### Reporting units

| Unit | Definition |
|------|------------|
| **Physical route segment** | One `qlog_f449c_{N}.bz2` file — the audited segment entry (92 total). |
| **Route chunk** | Temporal sub-span from `processRoute` chunking within a segment (97 discovered). |
| **First chunk per segment** | `routeChunks[0]` polygon count — matches `dataset_audit.js` `polygonCount`. |
| **All chunks per segment** | Accepted polygons summed across every `routeChunks[]` entry (540 total). |

### Summary A — Primary first-chunk dataset audit (`dataset_audit.js` scope)

| Metric | Value |
|--------|-------|
| Audited segment entries | **92** |
| Accepted polygons (first chunk only) | **524** |
| First-chunk polygon-producing segments | **79** |
| First-chunk zero-polygon segments | **13** |

### Summary B — Complete all-chunk output audit (delivery JSON scope)

| Metric | Value |
|--------|-------|
| Total discovered chunks | **97** |
| Accepted fragments (all chunks) | **540** |
| All-chunk polygon-producing segments | **81** |
| All-chunk zero-polygon segments | **11** |
| Independently useful fragments | **307** |
| Valid-but-short fragments | **233** |
| Polygons/segment (median / p90 / max) | **4 / 12 / 21** |
| Geometrically inconsistent (accepted) | **0** |
| s-range overlap pairs | **2** |
| Processing failures | **0** |

**Do not mix scopes:** 524 is first-chunk only; 540 is all-chunk only.

### 16-polygon difference (540 − 524)

Fully attributed to segments **7, 26, 96** (difference = **16**):

| Segment | Δ polygons | Extra polygon IDs |
|---------|------------|-------------------|
| 7 | **6** | `7:1:0:0:0` (chunk 1, index 1), `7:1:0:0:1` (chunk 1, index 1), `7:1:0:0:2` (chunk 1, index 1), `7:1:0:0:3` (chunk 1, index 1), `7:1:0:0:4` (chunk 1, index 1), `7:1:0:0:5` (chunk 1, index 1) |
| 26 | **9** | `26:2:1:0:0` (chunk 2, index 2), `26:2:1:0:1` (chunk 2, index 2), `26:2:1:0:2` (chunk 2, index 2), `26:2:1:0:3` (chunk 2, index 2), `26:2:1:0:4` (chunk 2, index 2), `26:2:1:0:5` (chunk 2, index 2), `26:2:1:0:6` (chunk 2, index 2), `26:2:1:0:7` (chunk 2, index 2), `26:2:1:0:8` (chunk 2, index 2) |
| 96 | **1** | `96:1:0:0:0` (chunk 1, index 1) |

Segment **7** is first-chunk producing (1 polygon in chunk 0) but gains 6 more in chunk 1. Segments **26** and **96** are **first-chunk zero-polygon** but **all-chunk producing** — diagnostics retained under first-chunk scope only.

### All-chunk reconciliation table (every segment)

| Seg | Chunks | Per-chunk counts | First | All | Long | Short | 1st prod | All prod | 1st-chunk class |
|-----|--------|------------------|-------|-----|------|-------|----------|----------|-----------------|
| 0 | 1 | 1 | 1 | 1 | 1 | 0 | yes | yes | — |
| 1 | 1 | 2 | 2 | 2 | 0 | 2 | yes | yes | — |
| 2 | 1 | 7 | 7 | 7 | 2 | 5 | yes | yes | — |
| 3 | 1 | 9 | 9 | 9 | 8 | 1 | yes | yes | — |
| 4 | 1 | 8 | 8 | 8 | 6 | 2 | yes | yes | — |
| 5 | 1 | 9 | 9 | 9 | 5 | 4 | yes | yes | — |
| 6 | 1 | 2 | 2 | 2 | 2 | 0 | yes | yes | — |
| 7 | 2 | 1, 6 | 1 | 7 | 5 | 2 | yes | yes | — |
| 8 | 1 | 6 | 6 | 6 | 5 | 1 | yes | yes | — |
| 9 | 1 | 0 | 0 | 0 | 0 | 0 | no | no | correctly_rejected_for_insufficient_evidence |
| 10 | 1 | 15 | 15 | 15 | 11 | 4 | yes | yes | — |
| 11 | 1 | 4 | 4 | 4 | 3 | 1 | yes | yes | — |
| 12 | 1 | 15 | 15 | 15 | 6 | 9 | yes | yes | — |
| 13 | 1 | 5 | 5 | 5 | 1 | 4 | yes | yes | — |
| 14 | 1 | 1 | 1 | 1 | 0 | 1 | yes | yes | — |
| 15 | 1 | 1 | 1 | 1 | 0 | 1 | yes | yes | — |
| 16 | 1 | 9 | 9 | 9 | 0 | 9 | yes | yes | — |
| 17 | 1 | 0 | 0 | 0 | 0 | 0 | no | no | inconclusive_without_camera_imagery |
| 18 | 1 | 4 | 4 | 4 | 0 | 4 | yes | yes | — |
| 19 | 1 | 2 | 2 | 2 | 0 | 2 | yes | yes | — |
| 20 | 1 | 12 | 12 | 12 | 10 | 2 | yes | yes | — |
| 22 | 1 | 4 | 4 | 4 | 3 | 1 | yes | yes | — |
| 23 | 1 | 3 | 3 | 3 | 2 | 1 | yes | yes | — |
| 24 | 1 | 11 | 11 | 11 | 9 | 2 | yes | yes | — |
| 25 | 2 | 4, 0 | 4 | 4 | 1 | 3 | yes | yes | — |
| 26 | 3 | 0, 0, 9 | 0 | 9 | 6 | 3 | no | yes | correctly_rejected_for_insufficient_evidence |
| 27 | 1 | 6 | 6 | 6 | 4 | 2 | yes | yes | — |
| 28 | 1 | 2 | 2 | 2 | 1 | 1 | yes | yes | — |
| 29 | 1 | 1 | 1 | 1 | 0 | 1 | yes | yes | — |
| 30 | 1 | 9 | 9 | 9 | 2 | 7 | yes | yes | — |
| 31 | 1 | 0 | 0 | 0 | 0 | 0 | no | no | inconclusive_without_camera_imagery |
| 32 | 1 | 2 | 2 | 2 | 0 | 2 | yes | yes | — |
| 33 | 1 | 9 | 9 | 9 | 2 | 7 | yes | yes | — |
| 34 | 1 | 7 | 7 | 7 | 2 | 5 | yes | yes | — |
| 35 | 1 | 7 | 7 | 7 | 1 | 6 | yes | yes | — |
| 36 | 1 | 8 | 8 | 8 | 1 | 7 | yes | yes | — |
| 37 | 1 | 0 | 0 | 0 | 0 | 0 | no | no | inconclusive_without_camera_imagery |
| 39 | 1 | 12 | 12 | 12 | 10 | 2 | yes | yes | — |
| 40 | 1 | 12 | 12 | 12 | 9 | 3 | yes | yes | — |
| 41 | 1 | 11 | 11 | 11 | 10 | 1 | yes | yes | — |
| 42 | 1 | 12 | 12 | 12 | 12 | 0 | yes | yes | — |
| 43 | 1 | 10 | 10 | 10 | 8 | 2 | yes | yes | — |
| 44 | 1 | 12 | 12 | 12 | 9 | 3 | yes | yes | — |
| 45 | 1 | 14 | 14 | 14 | 9 | 5 | yes | yes | — |
| 46 | 1 | 14 | 14 | 14 | 9 | 5 | yes | yes | — |
| 47 | 1 | 1 | 1 | 1 | 0 | 1 | yes | yes | — |
| 48 | 1 | 2 | 2 | 2 | 0 | 2 | yes | yes | — |
| 49 | 1 | 3 | 3 | 3 | 0 | 3 | yes | yes | — |
| 50 | 1 | 0 | 0 | 0 | 0 | 0 | no | no | inconclusive_without_camera_imagery |
| 51 | 1 | 2 | 2 | 2 | 1 | 1 | yes | yes | — |
| 53 | 1 | 5 | 5 | 5 | 3 | 2 | yes | yes | — |
| 54 | 1 | 3 | 3 | 3 | 2 | 1 | yes | yes | — |
| 55 | 1 | 7 | 7 | 7 | 6 | 1 | yes | yes | — |
| 56 | 1 | 8 | 8 | 8 | 6 | 2 | yes | yes | — |
| 57 | 1 | 0 | 0 | 0 | 0 | 0 | no | no | blocked_by_multi_pass_ambiguity |
| 58 | 1 | 6 | 6 | 6 | 3 | 3 | yes | yes | — |
| 59 | 1 | 1 | 1 | 1 | 1 | 0 | yes | yes | — |
| 60 | 1 | 0 | 0 | 0 | 0 | 0 | no | no | correctly_rejected_for_insufficient_evidence |
| 61 | 1 | 3 | 3 | 3 | 1 | 2 | yes | yes | — |
| 62 | 1 | 0 | 0 | 0 | 0 | 0 | no | no | correctly_rejected_for_insufficient_evidence |
| 63 | 1 | 1 | 1 | 1 | 1 | 0 | yes | yes | — |
| 64 | 1 | 7 | 7 | 7 | 5 | 2 | yes | yes | — |
| 65 | 1 | 0 | 0 | 0 | 0 | 0 | no | no | blocked_by_polygon_validation |
| 66 | 1 | 1 | 1 | 1 | 1 | 0 | yes | yes | — |
| 67 | 1 | 2 | 2 | 2 | 2 | 0 | yes | yes | — |
| 68 | 1 | 17 | 17 | 17 | 7 | 10 | yes | yes | — |
| 69 | 1 | 7 | 7 | 7 | 6 | 1 | yes | yes | — |
| 71 | 1 | 4 | 4 | 4 | 3 | 1 | yes | yes | — |
| 72 | 1 | 7 | 7 | 7 | 1 | 6 | yes | yes | — |
| 73 | 1 | 11 | 11 | 11 | 8 | 3 | yes | yes | — |
| 74 | 1 | 5 | 5 | 5 | 3 | 2 | yes | yes | — |
| 75 | 1 | 2 | 2 | 2 | 1 | 1 | yes | yes | — |
| 81 | 1 | 19 | 19 | 19 | 9 | 10 | yes | yes | — |
| 82 | 1 | 21 | 21 | 21 | 16 | 5 | yes | yes | — |
| 83 | 1 | 19 | 19 | 19 | 18 | 1 | yes | yes | — |
| 84 | 1 | 17 | 17 | 17 | 11 | 6 | yes | yes | — |
| 85 | 1 | 8 | 8 | 8 | 3 | 5 | yes | yes | — |
| 86 | 1 | 7 | 7 | 7 | 1 | 6 | yes | yes | — |
| 87 | 1 | 0 | 0 | 0 | 0 | 0 | no | no | inconclusive_without_camera_imagery |
| 88 | 1 | 4 | 4 | 4 | 0 | 4 | yes | yes | — |
| 89 | 1 | 3 | 3 | 3 | 0 | 3 | yes | yes | — |
| 90 | 1 | 0 | 0 | 0 | 0 | 0 | no | no | blocked_by_run_pairing_misalignment |
| 91 | 1 | 3 | 3 | 3 | 0 | 3 | yes | yes | — |
| 92 | 1 | 7 | 7 | 7 | 0 | 7 | yes | yes | — |
| 93 | 1 | 4 | 4 | 4 | 2 | 2 | yes | yes | — |
| 94 | 1 | 4 | 4 | 4 | 3 | 1 | yes | yes | — |
| 95 | 1 | 2 | 2 | 2 | 0 | 2 | yes | yes | — |
| 96 | 2 | 0, 1 | 0 | 1 | 1 | 0 | no | yes | correctly_rejected_for_insufficient_evidence |
| 97 | 1 | 4 | 4 | 4 | 1 | 3 | yes | yes | — |
| 98 | 1 | 8 | 8 | 8 | 2 | 6 | yes | yes | — |
| 99 | 1 | 3 | 3 | 3 | 3 | 0 | yes | yes | — |
| 100 | 1 | 3 | 3 | 3 | 1 | 2 | yes | yes | — |

### Fragment coverage and area

| Statistic | Coverage (m) | Area (m²) |
|-----------|--------------|-----------|
| Min | 4.0 | 19.7 |
| Median | 6 | 58.5 |
| p90 | 14 | 150.3 |
| Max | 76.0 | 902.1 |

---

## 3. Fragment quality (Stage 11)

- Increased polygon counts result from **supported-run separation** under v11 — not from bridging unsupported gaps.
- Fragments must **not** be merged merely because endpoints are close.
- Unsupported gaps (> 4 m) remain **explicit** between fragments.
- Short fragments (233) are **valid evidence** but may be too short for independent mapping (< 6 m coverage).
- Deterministic ordering and IDs are retained across reruns.
- JSON round-trip and renderer support **multiple polygons** per segment.
- Overlapping fragments: only **2** s-range overlap pairs dataset-wide; no material area double-counting.

### Classification definitions

| Term | Meaning |
|------|---------|
| **Geometrically valid** | Passes vertex-jump and self-intersection validation |
| **Independently useful** | ≥ 6 m coverage; suitable as standalone mapping evidence |
| **Valid but too short** | Geometrically valid but < 6 m; retained, not deleted |

---

## 4. BEV evidence consistency (Stage 12A)

**Terminology:** BEV evidence consistency — **not** camera or physical-road visual validation.

| Metric | Value |
|--------|-------|
| Polygons sampled | **99** (14 segments) |
| Measurable | **84** |
| Inconclusive | **15** |
| Visually accurate | **51** |
| Acceptable within uncertainty | **20** |
| Laterally shifted | **13** |
| Accurate or acceptable | **71/84 = 84.5%** |
| Laterally shifted (measurable) | **13/84 = 15.5%** |
| Long-fragment accuracy | **50/61 = 82.0%** |
| Short-fragment accuracy | **21/23 = 91.3%** |
| Lateral error (median / p90 / max) | **0.27 / 0.79 / 3.57 m** |
| Width error (median / p90 / max) | **0.30 / 1.09 / 2.28 m** |
| `width_too_wide` (secondary tag) | **2** cases on shifted polygons |

### Manual-review outlier: `46:0:0:0:11`

- Coverage: **4.0 m**; one comparable sample
- Sparse-GPS endpoint; mean lateral residual **3.57 m**
- Primary tag: `laterally_shifted`; insufficient evidence for dataset-wide correction

---

## 5. Camera-validation limitation (Stage 12B — BLOCKED)

Stage 12B is **blocked**, not failed. Independent physical-road accuracy cannot be measured until missing inputs are obtained. **Do not use guessed calibration.**

### Available

- Qlog EncodeIndex pointers (~3725/segment)
- Route dongle `f449c322f59e6943`
- openpilot **10.0.5-release** route metadata
- Encoder references: BIG_BOX_LOSSLESS, FULL_HEVC, BIG_BOX_HEVC

### Missing

- Matching `fcamera.hevc`, `ecamera.hevc`, `dcamera.hevc` bitstreams
- Decoded source pixels
- Usable camera intrinsics and distortion parameters
- Confirmed camera-to-vehicle extrinsics
- modelV2-to-image projection implementation

---

## 6. Zero-polygon classification (scope-separated)

### A. First-chunk zero-polygon segments (13)

Used by `dataset_audit.js` and Stage 13 diagnostics.

| Classification | Segments |
|----------------|----------|
| Correctly rejected — insufficient evidence | **9, 26, 60, 62, 96** |
| Blocked — multi-pass ambiguity | **57** |
| Blocked — polygon validation | **65** |
| Blocked — run-pairing misalignment | **90** |
| Inconclusive — without camera imagery | **17, 31, 37, 50, 87** |

### B. All-chunk zero-polygon segments (11)

Segments with **no** accepted polygon in **any** chunk. Segments **26** and **96** are excluded (later chunks produce output).

| Classification | Segments |
|----------------|----------|
| Correctly rejected — insufficient evidence | **9, 60, 62** |
| Blocked — multi-pass ambiguity | **57** |
| Blocked — polygon validation | **65** |
| Blocked — run-pairing misalignment | **90** |
| Inconclusive — without camera imagery | **17, 31, 37, 50, 87** |

### First-chunk diagnostic detail

| Seg | Scope | Classification | Chunks | 1st/All poly | L/S frags | Note | Rejection |
|-----|-------|----------------|--------|--------------|-----------|------|-----------|
| 9 | first-chunk | correctly_rejected_for_insufficient_evidence | 1 | 0 | 0 | 0/0 | — | — |
| 17 | first-chunk | inconclusive_without_camera_imagery | 1 | 0 | 0 | 0/0 | — | — |
| 26 | first-chunk | correctly_rejected_for_insufficient_evidence | 3 | 0 | 9 | 6/3 | first_chunk_zero_but_later_chunks_produce_polygons | — |
| 31 | first-chunk | inconclusive_without_camera_imagery | 1 | 0 | 0 | 0/0 | — | — |
| 37 | first-chunk | inconclusive_without_camera_imagery | 1 | 0 | 0 | 0/0 | — | — |
| 50 | first-chunk | inconclusive_without_camera_imagery | 1 | 0 | 0 | 0/0 | — | — |
| 57 | first-chunk | blocked_by_multi_pass_ambiguity | 1 | 0 | 0 | 0/0 | — | selfIntersecting |
| 60 | first-chunk | correctly_rejected_for_insufficient_evidence | 1 | 0 | 0 | 0/0 | — | — |
| 62 | first-chunk | correctly_rejected_for_insufficient_evidence | 1 | 0 | 0 | 0/0 | — | — |
| 65 | first-chunk | blocked_by_polygon_validation | 1 | 0 | 0 | 0/0 | — | selfIntersecting |
| 87 | first-chunk | inconclusive_without_camera_imagery | 1 | 0 | 0 | 0/0 | — | — |
| 90 | first-chunk | blocked_by_run_pairing_misalignment | 1 | 0 | 0 | 0/0 | — | insufficientPairedCoverage |
| 96 | first-chunk | correctly_rejected_for_insufficient_evidence | 2 | 0 | 1 | 1/0 | first_chunk_zero_but_later_chunks_produce_polygons | — |

---

## 7. Key diagnostic explanations

### Segment 90 — run-pairing misalignment

- Aggregate fused paired span: **~1,199.3 m**
- Left supported runs: **15**; right: **4**
- Qualifying paired-run overlap (≥ 4 m): **0 m**
- Polygon attempts: **0**
- Aggregate per-side span ≠ co-located supported-run coverage
- Sparse observations and source-bin gaps split sides into disjoint run ranges
- Production correctly rejects with `insufficientPairedCoverage`
- **Do not** bridge gaps or lower paired-overlap requirement

### Segment 65 — polygon validation

- One left run, one right run; **7.16 m** paired overlap
- **Four** resampled samples (current minimum); **one** polygon attempted
- Closure bridge **L3→R3** intersects boundary edge **R2→R1**
- Rejected as `selfIntersecting`
- Sparse or tight-curve construction ambiguity is a **possible** explanation — **not** a proven cause
- No dataset-wide ring-order defect demonstrated
- **Do not** disable self-intersection validation or lower support requirements

---

## 8. Delivery-readiness assessment

### A. Lane-count estimation

Potentially useful **supporting evidence**, not a complete lane-count solution. Road-edge polygons define road width but do not always distinguish individual lanes. Reliable lane counting still requires lane-line observations, lane-width assumptions with confidence bounds, temporal aggregation, junction handling, and camera evidence for ambiguous cases.

### B. Road-surface reconstruction

**v11 is suitable** for conservative evidence-backed road-surface extraction: retains supported geometry, separates unsupported gaps, rejects ambiguous construction, represents multiple fragments per segment, preserves traceability. **Incomplete** where evidence is sparse, fragmented, or ambiguous (**13** first-chunk zero-polygon; **11** all-chunk zero-polygon).

### C. Amap-style HD-map extraction

**Ongoing research**, not a completed HD-map system. Current pipeline supplies one geometry layer. A fuller HD map still needs lane boundaries, lane count/width, connectivity, junction topology, direction of travel, markings, signs/signals, confidence/provenance, and independent camera validation.

---

## 9. Recommended next work

1. Obtain matching route HEVC files and usable calibration
2. Complete Stage 12B camera-frame validation
3. Add individual lane-divider extraction for lane counting
4. Build lane topology and connectivity from validated geometry
5. Define confidence scores for polygons and lane-level outputs
6. Retain current v11 result as reproducible baseline

**Not recommended:** lowering support thresholds, bridging unsupported gaps, proximity-only fragment merging, disabling self-intersection validation, segment-specific geometry corrections, guessed camera calibration.

---

## 10. Reproducibility and handoff

| Item | Value |
|------|-------|
| Processing version | `2026-07-24-fusion-v11` |
| Config hash | `9c27690a7bd810d3` |
| Tests | **171/171 pass** |
| Full audit | `node dataset_audit.js --all --out audit_dataset_v11_stage13a.json` |
| Consistency check | **PASSED** |

### Configuration thresholds

| Parameter | Value |
|-----------|-------|
| fusionIntervalM | 2.0 |
| maxInterpolationSpanM | 4.0 |
| minFramesPerBin | 2 |
| maxVertexJumpM | 15 |
| minRoadWidthM / maxRoadWidthM | 2 / 30 |
| minPairedRunOverlapM | 4 |
| minResampledSamples | 3 |
| Polygon ID format | `segmentId:chunkId:passId:poseSectionId:fragmentIndex` |

### Artifact inventory

| Artifact | Purpose |
|----------|---------|
| `audit_dataset_v11_stage13a.json` | Full 92-segment processing audit |
| `audit_stage11_fragments_v11.json` | Fragment quality metrics |
| `audit_stage12_visual_validation.json` | BEV evidence consistency |
| `audit_stage12b_imagery.json` | Camera imagery acquisition status |
| `audit_stage13_zero_polygon.json` | Zero-polygon diagnostics |
| `audit_stage13a_fusion_trace.json` | Fusion-path tracing |
| `audit_stage14_delivery_readiness.json` | This consolidation audit |
| `reports/stage14_final_quality_report.md` | Human-readable final report |

### Output schema

Each segment chunk exposes `roadSurfacePolygons[]` with deterministic `polygonId`, vertex ring, `sRange`, width statistics, pass/pose-section identity, and source frame references.

---

*Generated by Stage 14 delivery-readiness consolidation. Production geometry unchanged.*
