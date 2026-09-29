# Current viewer status (frozen snapshot)

| Field | Value |
|--------|--------|
| Branch | `experiment/supervisor-ui-simplification` |
| Source commit (pre-export) | `3f7e8f586cfc8a9e2a1d2563ca80a0e3a4b413fa` |
| Preservation date | 2026-09-29 |
| Directive | Supervisor: stop viewer development; document and preserve |

## Accepted working functionality

- Segment load and local playback with stationary segment-local map
- Point-accumulated observations and representative lane lines (local canvas / grey)
- Supervisor UI: Review, Evidence, Debug presets
- Map backgrounds: Grey, Street (OSM dev tiles via `/api/map-config`)
- Map-native GPS route overlay, start/end markers, DOM vehicle marker on Street
- Progressive combined playback (Add next / Remove last) when enabled
- Synchronized road video when qcamera files are available locally
- Compact review status and pending-segment selection messaging

## Incomplete / known gaps

- Geographic representative lane lines often absent or incomplete on MapLibre
- Representative-line fragmentation in some segments
- Satellite mode disabled without `MAP_SATELLITE_TILE_URL`
- Evidence vs Review layer toggles require correct preset sync; some diagnostics still canvas-oriented
- Large experimental and audit scripts under `scripts/` and `reports/` not part of portable runtime

## Render paths

| `mapBackground` | Renderer |
|-----------------|----------|
| `grey` | `public/render.js` local canvas |
| `street` / `satellite` | `public/geographic_map_native.js` + MapLibre raster + GeoJSON overlays |

## Useful URL parameters

- `uiMode=review|evidence|debug`
- `mapBackground=grey|street|satellite`
- `representativeMethod=purityRevisit|purity|curveAssociation|legacy` (optional)
- Progressive / mirror / candidate flags as documented in advanced debug (frozen)

## Major architecture files

- `server.js`, `lib/process_route.js`, `lib/segment_local_map.js`
- `public/app.js`, `public/render.js`, `public/geographic_map_native.js`
- `lib/map_config.js`, `public/vendor/maplibre-gl/`

## Startup

```bat
npm install
START_VIEWER.bat
```

Open http://localhost:3847 — load segments from locally supplied `.bz2` files.

## WIP commits preserved locally (not pushed by export task)

- `c66cb392` — station-support promotion WIP (`wip/station-support-v2-default-promotion-20260928`)
- `6135607` — deferred curve-gap WIP (`wip/curve-gap-bridge-deferred-20260922`)

These branches/commits were not modified during preservation.
