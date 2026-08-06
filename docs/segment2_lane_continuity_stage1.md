# Segment 2 Lane-Continuity Stage 1

Generated: 2026-08-04

## Scope

Read-only disconnection audit and root-cause classification for **Segment 2** (`qlog_f449c_2.bz2`) Mode 5 lane geometry. Road-surface development is **paused**. No geometry, fusion, cleanup, transform, or browser-bundle changes were made during this investigation.

## Accepted baseline (unchanged)

| Metric | Value |
|--------|-------|
| Lane layer | Mode 5 |
| Lane checksum | `5283af91` |
| Cleaned runs | 28 |
| Fused fragments | 33 |
| Road-surface polygons | 14 |
| Surface checksum | `26ae09b9` |
| Geometry modified | **No** |

## Executive summary

Segment 2 Mode 5 lane output contains **28** cleaned fragments with **56** endpoints. Along each physical boundary (PB0, PB1, PB2), consecutive cleaned runs that do not share a vertex form **25** visible disconnections. Every endpoint is accounted for in `audit_segment2_lane_continuity_stage1.json`.

The dominant root cause is **intentional D12 preservation of unsupported gaps** (17 cases): geometry is split at cleanup/preservation even when tracker or sparse raw support exists nearby. A second cluster is **fusion-stage fragmentation** (19 disconnections first split at `fused_fragments`, though primary cause is often still classified as preserved gap when D12 applies). **4** disconnections are unsafe due to **real missing observation** (dropout-scale gaps with no mapped obs). **4** are unsafe due to **excessive heading difference** at the junction.

**17** disconnections are safe connection candidates (same physical boundary, compatible chunk/pass, valid route-s ordering). **13** of those recommend `fusion_pairing` as the smallest responsible repair. **8** are unsafe and must remain open.

## Audit metrics

| Metric | Count |
|--------|------:|
| Total final lane fragments | 28 |
| Total endpoints | 56 |
| Visible disconnections | 25 |
| Plausible same-boundary continuations | 25 |
| Intentional open gaps (D12 preserved) | 17 |
| Raw-detection gaps (first split at raw_modelV2) | 2 |
| Tracker splits (primary cause) | 0 |
| Cleanup splits (primary cause) | 0 |
| Fusion splits (first stage `fused_fragments`) | 19 |
| Transform/pose splits | 0 |
| Chunk-boundary gaps | 0 |
| Pass-boundary gaps | 0 |
| Renderer-only gaps | 0 |
| Branch/merge cases | 0 |
| Dashed-marking suspects | 3 |
| Unknown cases | 0 |
| Safe connection candidates | 17 |
| Unsafe connection candidates | 8 |

### Primary cause distribution

| Primary cause | Count |
|---------------|------:|
| `intentionally_preserved_unsupported_gap` | 17 |
| `excessive_heading_difference` | 4 |
| `real_missing_observation` | 4 |

### First pipeline stage where split appears

| Stage | Count | Interpretation |
|-------|------:|----------------|
| `fused_fragments` | 19 | Tracking continuous; fusion did not bridge adjacent spans |
| `preservation_d12` | 3 | Raw/tracker support present; D12 kept gap open |
| `raw_modelV2` | 2 | No mapped observation in gap interval |
| `cleaned_runs` | 1 | Cleanup separation before preservation |

## Methodology

1. Enumerate all Mode 5 cleaned-run endpoints (28 fragments × 2 = 56).
2. Group runs by physical boundary; sort by route-s.
3. For each consecutive run pair on the same PB, build a disconnection record with nearest plausible continuation metrics.
4. Trace pipeline stages: raw modelV2 → tracker → cleaned runs → fused fragments → D12 preservation → Mode 5 → renderer.
5. Assign exactly one primary cause plus contributing causes.
6. Classify safe vs unsafe connection using `endpointCompatibility` rules (no cross-pass/chunk joins without evidence, no boundary crossing, lane-order preservation).
7. Distinguish dashed-marking suspects from true geometry gaps via `dashedMarkingAnalysis` in JSON.

Implementation: `lib/lane_continuity_stage1.js`  
Audit runner: `scripts/audit_segment2_lane_continuity_stage1.js`  
Tests: `tests/local_playback_lane_continuity_stage1.test.js` (15/15 pass)

## Disconnection inventory

| ID | PB | Gap (m) | Heading Δ | Primary cause | First split stage | Verdict | Recommended fix |
|----|-----|--------:|----------:|---------------|-------------------|---------|-----------------|
| DC-000 | PB2 | 1.5 | 1.0° | intentionally_preserved_unsupported_gap | preservation_d12 | safe | none_preserve_gap |
| DC-001 | PB1 | 24.8 | 19.9° | intentionally_preserved_unsupported_gap | raw_modelV2 | safe | none_until_detection_improves |
| DC-002 | PB1 | 17.4 | — | excessive_heading_difference | raw_modelV2 | unsafe | — |
| DC-003 | PB1 | 239.9 | 111.4° | real_missing_observation | cleaned_runs | unsafe | — |
| DC-004 | PB1 | 15.0 | — | excessive_heading_difference | fused_fragments | unsafe | — |
| DC-005 | PB2 | 1.5 | — | intentionally_preserved_unsupported_gap | preservation_d12 | safe | none_preserve_gap |
| DC-006 | PB1 | 27.6 | — | intentionally_preserved_unsupported_gap | fused_fragments | safe | fusion_pairing |
| DC-007 | PB2 | 1.6 | — | intentionally_preserved_unsupported_gap | preservation_d12 | safe | none_preserve_gap |
| DC-008 | PB0 | 24.0 | — | intentionally_preserved_unsupported_gap | fused_fragments | safe | fusion_pairing |
| DC-009 | PB0 | 13.3 | — | intentionally_preserved_unsupported_gap | fused_fragments | safe | fusion_pairing |
| DC-010 | PB0 | 18.0 | — | intentionally_preserved_unsupported_gap | fused_fragments | safe | fusion_pairing |
| DC-011 | PB0 | 12.0 | — | intentionally_preserved_unsupported_gap | fused_fragments | safe | fusion_pairing |
| DC-012 | PB0 | 16.3 | — | intentionally_preserved_unsupported_gap | fused_fragments | safe | fusion_pairing |
| DC-013 | PB1 | 17.4 | — | excessive_heading_difference | fused_fragments | unsafe | — |
| DC-014 | PB0 | 26.7 | — | intentionally_preserved_unsupported_gap | fused_fragments | safe | fusion_pairing |
| DC-015 | PB0 | 123.7 | — | real_missing_observation | fused_fragments | unsafe | — |
| DC-016 | PB1 | 17.2 | — | excessive_heading_difference | fused_fragments | unsafe | — |
| DC-017 | PB0 | 36.2 | — | real_missing_observation | fused_fragments | unsafe | — |
| DC-018 | PB0 | 43.0 | — | real_missing_observation | fused_fragments | unsafe | — |
| DC-019 | PB0 | 22.5 | — | intentionally_preserved_unsupported_gap | fused_fragments | safe | fusion_pairing |
| DC-020 | PB0 | 24.0 | — | intentionally_preserved_unsupported_gap | fused_fragments | safe | fusion_pairing |
| DC-021 | PB0 | 13.1 | — | intentionally_preserved_unsupported_gap | fused_fragments | safe | fusion_pairing |
| DC-022 | PB0 | 18.0 | — | intentionally_preserved_unsupported_gap | fused_fragments | safe | fusion_pairing |
| DC-023 | PB0 | 12.0 | — | intentionally_preserved_unsupported_gap | fused_fragments | safe | fusion_pairing |
| DC-024 | PB0 | 16.3 | — | intentionally_preserved_unsupported_gap | fused_fragments | safe | fusion_pairing |

Full machine-readable records (GPS, logMonoTime, observation indices, competing continuations, pipeline trace per stage) are in `audit_segment2_lane_continuity_stage1.json`.

## Root-cause findings

### 1. D12 preserved unsupported gaps (17)

Most visible fragmentation is **by design**: cleanup emits separate cleaned runs and D12 preservation blocks bridging when mapped observation support in the gap is sparse or absent. Examples: DC-000, DC-005, DC-007 (~1.5 m gaps on PB2 with sparse mapped obs but modelV2 frames present — possible dashed-marking artifact).

**Contributing causes:** `sparse_mapped_obs_in_gap`, `D6`, `no_mapped_obs_in_gap`.

### 2. Fusion failure cluster (13 safe repair candidates)

On **PB0**, runs 8–27 form a chain of 12–27 m gaps (DC-008 through DC-024) where tracker output is continuous but **fused fragments do not pair** adjacent spans on the same track. Primary cause remains `intentionally_preserved_unsupported_gap` because D12 also applies, but **first failing stage is `fused_fragments`**.

**Recommended fix:** `fusion_pairing` — smallest responsible change before touching preservation rules.

### 3. Real missing observation (4 unsafe)

DC-003, DC-015, DC-017, DC-018: large along-track gaps (36–240 m) with **zero mapped observations** in the interval. First split at `raw_modelV2` or `cleaned_runs`/`fused_fragments` with no defensible continuity model.

**Verdict:** `unsupported_open` — do not connect.

### 4. Excessive heading difference (4 unsafe)

DC-002, DC-004, DC-013, DC-016: endpoint heading mismatch (~17–20°) at junction despite same PB label. Competing geometry or curvature change; connection would risk crossing adjacent boundaries.

**Verdict:** `visible_disconnection` — remain separate.

### 5. Dashed-marking suspects (3)

DC-000, DC-005, DC-007: `dashedMarkingAnalysis.verdict = possible_dashed_marking_not_geometry_gap`. Short gaps (~1.5 m) with repeated dash spacing suspected; pipeline may be breaking at paint gaps rather than missing physical divider path.

## Safe connection candidates — recommended fixes

| Fix type | Count | Disconnect IDs |
|----------|------:|----------------|
| `fusion_pairing` | 13 | DC-006, DC-008–DC-012, DC-014, DC-019–DC-024 |
| `none_preserve_gap` | 3 | DC-000, DC-005, DC-007 |
| `none_until_detection_improves` | 1 | DC-001 |

**Do not implement in Stage 1.** Stage 2 should target **fusion pairing on PB0** first (largest cluster, 13 gaps, same track/chunk/pass).

## Visual evidence

Screenshots: `screenshots/segment2_lane_continuity_stage1/`  
Manifest: `screenshots/segment2_lane_continuity_stage1/capture_manifest.json`  
Scenes: `screenshots/segment2_lane_continuity_stage1/verification_scenes.json`

| Asset | Description |
|-------|-------------|
| `lc_stage1_overview_endpoints.png` | Full Segment 2 Mode 5 with 56 numbered endpoint markers |
| `lc_stage1_DC-NNN.png` | Close-up per disconnection (gap marker, cause, verdict HUD) |
| `lc_stage1_DC-NNN_pipeline.png` | Same viewport: gray dashed=fused, orange=raw observations, solid=cleaned |

**51** captures total (1 overview + 25 close-ups + 25 pipeline comparisons).

Vehicle-relative and pose-transform before/after coordinates are recorded in JSON `pipelineTrace` per disconnection; no transform/pose splits were observed in this segment. Renderer breaks (`browserRendering.rendererBreak`) appear only where geometry is genuinely discontinuous in Mode 5 data — not renderer-only artifacts.

## Tests

```
node --test tests/local_playback_lane_continuity_stage1.test.js
```

15/15 pass:

1. Every final fragment endpoint accounted for  
2. Every candidate connection has provenance  
3. Every disconnection has one primary classification  
4. First pipeline stage recorded  
5. No cross-pass safe recommendations  
6. No cross-chunk safe recommendations without evidence  
7. No safe connection crosses another boundary  
8. Lane order valid for recommendations  
9. Competing continuations recorded  
10. Unknown cases not auto-joined  
11. Lane checksum `5283af91`  
12. Cleaned runs = 28  
13. Fused fragments = 33  
14. No road-surface geometry changes  
15. Audit JSON matches live audit  

## Artifacts

| File | Purpose |
|------|---------|
| `audit_segment2_lane_continuity_stage1.json` | Machine-readable audit (endpoints, disconnections, pipeline traces) |
| `docs/segment2_lane_continuity_stage1.md` | This report |
| `lib/lane_continuity_stage1.js` | Audit engine |
| `scripts/audit_segment2_lane_continuity_stage1.js` | Regenerate JSON |
| `scripts/export_segment2_lane_continuity_scenes.js` | Build verification scenes |
| `scripts/capture_segment2_lane_continuity_stage1.js` | Puppeteer capture |
| `tests/local_playback_lane_continuity_stage1.test.js` | Audit regression tests |

Prior lane, D12, and road-surface audit files were **not** overwritten.

## Final verdict

| Criterion | Result |
|-----------|--------|
| Root causes identified | **Yes** — D12 preservation (17), fusion fragmentation (19 first-stage), raw dropout (4), heading mismatch (4) |
| Every visible disconnection accounted for | **Yes** — 25/25 in JSON + screenshots |
| Safe connection candidates identified | **Yes** — 17 (13 fusion_pairing, 3 preserve, 1 detection) |
| Unsupported gaps kept separate | **Yes** — 8 unsafe cases explicitly rejected |
| Lane baseline unchanged | **Yes** — checksum `5283af91`, 28 runs, 33 fused |
| Ready for targeted continuity repair | **Yes** |
| Recommended first repair | **Fusion pairing on PB0** for DC-008–DC-024 cluster (same track 0, chunk 0, pass 0; tracker continuous; fused fragments split) |
