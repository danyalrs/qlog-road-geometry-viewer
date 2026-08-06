# Segment 2 Lane Continuity — Stage 5

Stage 5 investigates **DC-015** on PB0 (`s≈128.15–260.57 m`, ~132.4 m along-track). **Investigation only** — no production geometry changes, no corridor connection.

## 1. DC-015 identity and extent

| Field | Value |
|-------|-------|
| Physical boundary | PB0 |
| Track ID | 0 |
| Chunk / pass | 0 / 0 |
| Stage 4 physical gap key | `PB0\|128.15\|260.57` |
| Stage 1 physical gap key | `PB0\|136.89\|260.57` |
| Along-track gap | 132.42 m |
| Euclidean endpoint distance | ~91.9 m |
| Lateral offset (endpoints) | 2.27 m |
| Heading difference (endpoints) | 0.63° |
| Endpoint compatibility | **Incompatible** (lateralMismatch: dΔ=2.27 m > 0.8 m join threshold) |

### Endpoint-key reconciliation

After DC-014 closed `PB0|101.42|128.15`, the preceding PB0 run now ends at **128.15 m** instead of 136.89 m. The corridor `PB0|136.89|260.57` shifted west by **8.74 m** to `PB0|128.15|260.57`. The east endpoint (260.57 m) is unchanged.

**No new physical gap was introduced.** Net physical gap count remains 18.

---

## 2. Pipeline trace (s=110–280 m)

| Stage | DC-015 corridor evidence |
|-------|--------------------------|
| Raw modelV2 | 95 points in gap from track 0 + track 1; 25 frames with lane track 0 present |
| Vehicle-relative / pose | Lane polylines present; forward range limits projection into interior |
| Accepted observations (track 0) | **35** mapped points, **4** distinct frames |
| Tracker | Track 0 maintained; track 1 separate (PB1-class lateral) |
| Bin aggregation | **24** bins in gap: **5 accepted**, **19 rejected** (D6×15, D7×4) |
| Fused fragments | Primary split bins **73→130**: gapM=**114.7 m**, lateralΔ=17.6 m |
| Cleaned runs | Open gap 128.15–260.57 m |
| Mode 5 | Open — matches cleaned |

### Accepted fused bins in/near gap

| Bin | route-s (m) | lateral-d (m) |
|-----|-------------|---------------|
| 64 | 128.2 | −3.71 |
| 68 | 136.9 | −7.34 |
| 70 | 139.1 | −10.69 |
| 71 | 142.4 | −14.60 |
| 73 | 145.9 | −19.05 |
| 130 | 260.6 | −1.44 |

West cluster (128–146 m) has sparse support; **148–228 m** has **zero** track-0 mapped observations; east approach (238–258 m) has observations but all bins rejected.

---

## 3. First support loss

| Field | Value |
|-------|-------|
| **Category** | **A** — genuine long detection dropout |
| **First stage** | `raw_modelV2` (interior 148–228 m); fusion split at `fuseLaneTrackSdFragments` for 114.7 m |
| **Responsible function** | modelV2 forward polyline + `fuseLaneTrackSdFragments` |
| **Condition** | Lane points project only within vehicle forward range (~0–66 m ahead of vehicle); interior corridor has no track-0 mapped obs; D11 split bins 73→130 |
| **Distinction** | `no_raw_detection` (interior) + `missing_fusion_output` (fragment split) |

---

## 4. Video / frame evidence

qlog source video is **not available** in the workspace. Frame-to-route-s table is built from modelV2 metadata (`audit_segment2_lane_continuity_stage5.json` → `dc015.frameRouteSTable`).

| route-s region | Physical condition (artifact-based) |
|----------------|-------------------------------------|
| 128–146 m | Sparse mapped support; low frame diversity |
| 148–228 m | **No track-0 mapped observations** — interior dropout |
| 238–258 m | modelV2 present; bins rejected (D6/D7) |
| 260 m | Accepted bin resumes |

---

## 5. Alternative tracks

| Track | Obs in gap | Mean lateral-d | PB0 lateral delta | Reassignment |
|-------|------------|----------------|-------------------|--------------|
| 0 (PB0) | 35 | −7.03 m | — | — |
| 1 | 10 | −9.28 m | ~2–14 m | **Rejected** — lateral separation |

No track switch or identity swap detected. Nearest observations are not reassigned by endpoint distance alone.

---

## 6. Offline recovery options

| Option | Max supported span | Longest unsupported | Production modified |
|--------|-------------------|---------------------|---------------------|
| 1. Existing PB0 obs | ~17.7 m (west cluster) | 114.7 m | No |
| 2. Rejected candidates restored | ~2 m per bin | 114.7 m | No |
| 3. Alternative track | 0 m | 132.4 m | No |
| 4. Short interpolation | ≤10 m sub-gaps | 114.7 m | No |
| 5. Piecewise fitting | ~17.7 m | 114.7 m | No |
| 6. **No reconstruction** | — | 114.7 m | **Recommended** |

**Complete reconstruction is not defensible** — interior lacks independent observations.

---

## 7. Verdict

| Item | Result |
|------|--------|
| **Primary verdict** | **G** — short recoverable west-end sections; **114.7 m unsupported interior** |
| DC-015 state | **Open** |
| Ready for targeted repair | **No** |
| Next action | Remain open; optional future west-end local repair only if independent interior evidence appears |

---

## 8. Geometry accounting (unchanged)

| Metric | Value |
|--------|-------|
| Lane checksum | `ff6d115e` |
| Fused fragments | 22 |
| Cleaned runs | 21 |
| Stable physical disconnections | 18 |
| Road-surface checksum | `70457ea` |
| PB1/PB2 displacement | 0 m |
| Production geometry modified | **No** |

All 8 unsafe gaps remain open. DC-014 and Stage 2 repairs retained. DC-022/DC-024 physically closed.

---

## Artifacts

- `audit_segment2_lane_continuity_stage5.json`
- `lib/lane_continuity_stage5.js`
- `tests/local_playback_lane_continuity_stage5.test.js`
- `screenshots/segment2_lane_continuity_stage5/`
- `screenshots/segment2_lane_continuity_stage5/capture_manifest.json`
