# Map background setup (supervisor UI)

The viewer serves MapLibre GL JS from `public/vendor/maplibre-gl/` and exposes tile configuration at `GET /api/map-config`.

## Grey (offline)

No network access required. Uses the legacy canvas projection only.

## Street (development / review)

Enabled by default when the server starts. Uses public OpenStreetMap raster tiles with attribution shown on the map.

**These tiles are for development and supervisor review only — not the production tile service.**

## Satellite (optional)

Configure environment variables before starting the server (never commit tokens to Git):

| Variable | Purpose |
|----------|---------|
| `MAP_SATELLITE_TILE_URL` | Raster template URL with `{z}/{x}/{y}` placeholders |
| `MAP_SATELLITE_ATTRIBUTION` | Required attribution HTML/text for the provider |
| `MAP_SATELLITE_MAX_ZOOM` | Optional max zoom (default 19) |

If `MAP_SATELLITE_TILE_URL` is unset, the Satellite option stays disabled and the UI shows “Satellite provider not configured”.

## URL parameter

`mapBackground=grey|street|satellite` — invalid values fall back to Street when available, otherwise Grey.

## Portable ZIP

- `START_VIEWER.bat` starts the Express server as before.
- Map **library** files are bundled under `public/vendor/maplibre-gl/`.
- Map **tiles** are not bundled; Street/Satellite require Internet access at runtime.
