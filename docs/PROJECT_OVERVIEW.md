# Project Overview

**Last updated:** 2026-07-28  
**Maintainer note:** Living documentation — see [DEVELOPMENT_LOG.md](./DEVELOPMENT_LOG.md) for change history and update rules.

---

## Objective

This project processes openpilot **qlog** recordings (`qlog_f449c_{N}.bz2`) into **supported road-surface polygons** and related lane-evidence artifacts derived from **modelV2** road-edge and lane-line observations, vehicle pose, and GPS.

The long-term goal is toward lane-counting and HD-map-style outputs. **Current authorized scope stops at Stage 19:** a dataset-wide lane-interval sensitivity and BEV evidence audit. Production lane counting is **not implemented**. The HD-map system is **incomplete**. No production deployment is authorized.

---

## Input Data

| Input | Description | Source |
|-------|-------------|--------|
| Qlog segments | Compressed Cap'n Proto logs, pattern `qlog_f449c_{N}.bz2` | Project root (92 segments in full-dataset audits per `lib/stage14_delivery_readiness.js`) |
| modelV2 frames | Road edges and lane lines (~0.5 Hz per segment) | `extract_modelv2.js` / `lib/qlog_decoder.js` |
| GPS / pose | Validated GPS, interpolated pose at model timestamps | `extract_gps.js`, `lib/gps_validate.js`, `lib/alignment.js` |

**Workspace note:** Qlog files may be absent in a checkout; full-dataset commands require them in the project root.

---

## Processing Pipeline

### Frozen geometry baseline (`2026-07-24-fusion-v11`)

The v11 pipeline (`lib/process_route.js`, `lib/fusion.js`, `lib/version.js`) transforms qlog data into supported road-surface polygons:

1. Qlog decode and modelV2/GPS extraction
2. GPS validation and pose interpolation
3. Temporal-pass separation (Stage 8, frozen)
4. Pose-section splitting (Stage 9 v10, frozen)
5. Projection into route coordinates (along-track `s`, lateral `d`)
6. Fusion-bin construction at 2 m intervals with MAD outlier rejection (Stage 10 v11)
7. Supported-run detection, left/right pairing, polygon construction and validation
8. Deterministic polygon IDs and JSON/renderer output

**Limitation:** Output represents modelV2-and-pose-supported polygons; it does not independently verify physical road surface against camera pixels (Stage 12B blocked).

Evidence: `checkpoints/admiral-investigation-2026-07-23.md`, `lib/stage14_delivery_readiness.js`.

### Lane-counting pipeline (Stages 15–18)

Separate from v11 geometry; uses frozen v11 as road-surface baseline reference only.

| Stage | Version ID | Purpose | Key modules |
|-------|------------|---------|-------------|
| **15** | `2026-07-24-lane-count-v0` (design) | Lane-counting problem definition, threshold policy, validation plan (read-only design) | `lib/stage15_lane_counting_design.js`, `lib/stage15_signal_inventory.js` |
| **16** | `2026-07-24-lane-projection-v0` | Project modelV2 lane lines from device frame to route coordinates | `lib/stage16_projection_schema.js`, `projected_lane_observations_v0.json` |
| **17** | `2026-07-24-lane-divider-tracking-v0` | Temporal divider association, supported-run fusion, gap recording | `lib/stage17_divider_association.js`, `lib/stage17_supported_run_fusion.js` |
| **18** | `2026-07-24-lane-interval-assessment-v0` | Lane-interval construction, prototype same-direction interval-count assessment | `lib/stage18_lane_interval_audit.js`, `lib/stage18_lane_interval_schema.js` |

Production lane counting remains **disabled** (`productionLaneCountImplemented: false` in `audit_stage19_dataset_sensitivity.json`).

### Stage 19 — dataset sensitivity & BEV evidence audit

| Field | Value |
|-------|-------|
| Spec | Revision 37 — see `docs/stage19_revision37_specification.md` |
| Processing version | `2026-07-24-dataset-sensitivity-bev-audit-v0` |
| Implementation checkpoint | `2026-07-27-stage19-v5` |
| Approval scope | Dataset-sensitivity auditing only (not production lane counting) |

Stage 19 reads approved Stage 18 outputs and upstream context, builds match records, runs static partition (chain formation), cross-pass candidate detection, interval evidence assessment, P3 branch selection, quality gates, and publishes immutable bundle runs under `stage19_bundle/runs/`.

Normative logic lives in `lib/stage19_spec/` (protected). Production wiring: `lib/stage19_*` modules, `stage19_bundle/`.

**Stage 20:** Amendment A v3 **implemented and audited** (2026-07-28) — `lane_divider_supported_runs_v1.json` with boundary metadata at `flushRun()`. Cross-pass evaluation requires validated corridor + traversal linkage (none published; 3 linkage hypotheses on real data). Amendment B **specification v1 drafted** — two parts: **B-MOTION** (within-track pose-residual linking) and **B-TRAV** (traversal evidence schemas). Not implemented. Not production-approved.

---

## Main Components and Data Flow

```
qlog_f449c_*.bz2
    │
    ├─► extract_modelv2.js / extract_gps.js
    │       └─► modelV2 + GPS events
    │
    ├─► lib/process_route.js  (frozen v11)
    │       └─► roadSurfacePolygons[], routeChunks[], timeline
    │
    ├─► Stage 16 projection
    │       └─► projected_lane_observations_v0.json (5,809 projected of 11,044 total)
    │
    ├─► Stage 17 tracking
    │       └─► 742 tracks (573 multi-observation), 878 supported runs, 136 gaps
    │
    ├─► Stage 18 interval assessment
    │       └─► 5 lane intervals assessed
    │
    └─► Stage 19 bundle builder
            └─► stage19_bundle/runs/{runId}/
                    catalog (5,809 members), assessments, BEV PNGs, manifest
```

Cross-check: `reports/stage19_dataset_sensitivity_investigation.json` → `dataAlignment`.

---

## Webpage Viewer

| Item | Detail |
|------|--------|
| Server | `server.js` (Express) |
| Port | `3847` (override via `PORT` env) |
| Static UI | `public/` (`public/app.js`) |
| Start command | `npm start` |

### API endpoints (verified in `server.js`)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/segments` | List available qlog segments |
| `POST /api/extract` | Extract modelV2/GPS from segments |
| `POST /api/process` | Run v11 `processRoute` pipeline |
| `GET /api/export/json`, `/csv`, `/geojson` | Export processed geometry |
| `GET /api/stage19/summary` | Stage 19 audit summary (checkpoint, counts) |
| `GET /api/stage19/bundle/*` | Serve published Stage 19 bundle artifacts |

The UI displays v11 road-surface polygons and a Stage 19 panel (implementation checkpoint, singleton chain count, P3 stats, promotion decisions). Verified against `reports/stage19_v5_corrective_checkpoint_report.json` → `liveApi`, `browserPanel`.

---

## System Boundaries

### In scope (verified)

- Frozen v11 road-surface polygon extraction (92-segment dataset audits when qlogs present)
- Stages 15–18 read-only / prototype lane-evidence pipeline
- Stage 19 implementation v5: fixture-validated partition, conflict, publication, API, and BEV paths
- Stage 19 real-dataset baseline recording (5,809 singleton chains; sensitivity table records baseline only per Rev 37)
- Dataset-sensitivity investigation (read-only, 2026-07-28)

### Out of scope / not authorized

- Production lane counting
- HD-map system completion
- Production deployment
- Threshold correction or config mutation on real dataset (no approved correction)
- Stage 20 implementation
- Camera-frame physical-road validation (Stage 12B blocked)

### Protected / frozen artifacts

- `lib/version.js` — v11 geometry frozen at `2026-07-24-fusion-v11`
- `lib/stage19_spec/*` — 28 immutable protected files (hashes in `checkpoints/stage19-implementation-2026-07-27-stage19-v5.json`)
- Published immutable runs: `stage19_bundle/runs/2026-07-27-stage19-v{0..5}/`
- `stage19_bundle/current.json` — points to `2026-07-27-stage19-v5`

---

## Related Documentation

| Document | Purpose |
|----------|---------|
| [CURRENT_STATUS.md](./CURRENT_STATUS.md) | Verified current state |
| [DEVELOPMENT_LOG.md](./DEVELOPMENT_LOG.md) | Chronological work history |
| [DECISIONS.md](./DECISIONS.md) | Technical decisions |
| [EXPERIMENTS.md](./EXPERIMENTS.md) | Measurements and sensitivity runs |
| [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) | Open and resolved issues |
| [RUN_GUIDE.md](./RUN_GUIDE.md) | Commands and reproduction |
| `docs/stage19_revision37_specification.md` | Normative Stage 19 specification |
| `deliverables/stage20-draft-specification.md` | Stage 20 combined draft (not approved) |
| `checkpoints/admiral-investigation-2026-07-23.md` | Stages 6–18 investigation record |
