# Qlog Road Geometry Viewer

Interactive viewer for qlog-derived road geometry: local canvas playback, optional MapLibre street map, synchronized dashcam video, and supervisor Review / Evidence / Debug modes.

**Status:** This viewer build is **frozen** (supervisor-directed preservation snapshot). No further feature development is planned in this repository.

## Requirements

- **Node.js** 20.x LTS (tested with v20.20.x)
- **npm** 10.x
- **Windows:** run `START_VIEWER.bat` or `start.bat` from the repository root
- **Any OS:** `npm install` then `npm start` or `node server.js`
- Default URL: **http://localhost:3847**

Place segment qlogs (`.bz2`) and optional `*---qcamera.ts` video files in the project root or paths configured by your deployment. **Raw qlogs and videos are not included in this Git repository.**

## Basic usage

1. Start the server (`START_VIEWER.bat` or `npm start`).
2. Open http://localhost:3847 in a browser.
3. Select one or more segments in the sidebar, then click **Load segment** (Process).
4. Use the timeline and **Play** / **Prev** / **Next** for playback.
5. **Review** — clean lane result on map or grey canvas. **Evidence** — adds observation dots and source curves. **Debug** — full technical controls.
6. **Map background:** Grey (local canvas only), Street (OpenStreetMap dev tiles), or Satellite (only if `MAP_SATELLITE_TILE_URL` is set — see [MAP_SETUP.md](MAP_SETUP.md)).
7. **Add next segment** (progressive combined playback) when enabled for your dataset.

## Input data

- Compressed qlogs: `qlog_f449c_*.bz2` (modelV2 lane observations, GPS fixes)
- Optional front-camera transport streams for video sync (not shipped in Git)

Processing uses the in-repo pipeline (`lib/process_route.js`, segment-local maps, point accumulation, representative lane lines).

## Architecture (summary)

| Layer | Role |
|--------|------|
| `server.js` | Express API: process segments, video range, map config, static UI |
| `public/render.js` | Local canvas renderer (grey mode) |
| `public/geographic_map_native.js` | MapLibre geographic mode (street/satellite) |
| `lib/segment_local_map.js` | Stationary map, trajectory, arrow on path |
| `public/connected_accumulated_display.js` | Per-frame curves and representative lines |

See [docs/CURRENT_VIEWER_STATUS.md](docs/CURRENT_VIEWER_STATUS.md) for the frozen snapshot details.

## Important paths

- `public/` — browser UI and client modules
- `lib/` — server-side processing and shared logic
- `tests/` — Node test suites (`npm test` runs all; use focused files for map/UI)
- `public/vendor/maplibre-gl/` — bundled MapLibre GL JS (tiles fetched at runtime for Street)

## Tests

```bash
npm test
```

Focused supervisor / map smoke tests:

```bash
node --test tests/supervisor_ui_revision.test.js tests/supervisor_ui_revision_2.test.js tests/map_native_geographic.test.js tests/map_native_overlay_visibility.test.js tests/vehicle_marker_and_mode_state.test.js tests/map_container_size.test.js
```

## Known limitations

- Geographic **representative lane lines** may be missing or incomplete on the map.
- **Satellite** requires environment configuration (`MAP_SATELLITE_TILE_URL`); not enabled by default.
- Some **representative lines** remain fragmented in local canvas mode.
- Experimental URL flags and debug controls remain for regression only.
- Viewer development has **stopped**; this repo documents the supervisor review build.

## Data and privacy

This repository contains **source code and tests only**. It does **not** include raw qlogs, `.bz2` archives, MP4/TS videos, GPS exports, API keys, or private tile tokens.

## Future direction (not implemented here)

Planned downstream work (separate effort): raw qlogs with modelV2 and `gpsLocation` / `gpsLocationExternal` → raw GeoJSON → miniature Pintaz Map update simulation.
