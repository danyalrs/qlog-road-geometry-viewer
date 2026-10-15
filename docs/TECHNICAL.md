# Technical reference — Road Geometry Viewer

This document supplements the [README](../README.md) for developers and researchers. The viewer is a **frozen** supervisor review build (see [CURRENT_VIEWER_STATUS.md](CURRENT_VIEWER_STATUS.md)).

## Architecture (summary)

| Layer | Role |
|--------|------|
| `server.js` | Express API: process segments, video range, map config, static UI |
| `public/render.js` | Local canvas renderer (grey background mode) |
| `public/geographic_map_native.js` | MapLibre geographic mode (street/satellite) |
| `lib/segment_local_map.js` | Stationary map, trajectory, arrow on path |
| `public/connected_accumulated_display.js` | Per-frame curves and representative lines |

## Input data

- Compressed **qlogs** (`.bz2`): driving logs with lane detections (`modelV2`) and GPS fixes
- Optional front-camera transport streams (`*---qcamera.ts`) for synchronized video — not included in Git

Processing pipeline: `lib/process_route.js`, segment-local maps, point accumulation, representative lane lines.

## Map backgrounds

| Mode | Renderer |
|------|----------|
| Grey | `public/render.js` (local canvas) |
| Street / Satellite | `public/geographic_map_native.js` + MapLibre raster + GeoJSON overlays |

Satellite requires `MAP_SATELLITE_TILE_URL` in the environment ([MAP_SETUP.md](MAP_SETUP.md)).

## URL parameters

- `uiMode=review|evidence|debug`
- `mapBackground=grey|street|satellite`
- `representativeMethod=purityRevisit|purity|curveAssociation|legacy` (optional)
- Progressive / mirror / candidate flags (debug; frozen)

## Tests

```bash
npm test
```

Focused supervisor / map smoke tests:

```bash
node --test tests/supervisor_ui_revision.test.js tests/supervisor_ui_revision_2.test.js tests/map_native_geographic.test.js tests/map_native_overlay_visibility.test.js tests/vehicle_marker_and_mode_state.test.js tests/map_container_size.test.js
```

## Future direction (not in this repo)

Downstream work may connect raw qlogs to map-update simulations; that pipeline is **not** implemented here.
