'use strict';

/**
 * Browser-safe map tile configuration for GET /api/map-config.
 * OpenStreetMap raster tiles are for development/review only — not production.
 */

const OSM_STREET = {
  available: true,
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '© OpenStreetMap contributors',
  tileSize: 256,
  maxZoom: 19,
};

function buildSatelliteConfig() {
  const tileUrl = process.env.MAP_SATELLITE_TILE_URL || null;
  const available = !!(tileUrl && String(tileUrl).trim());
  return {
    available,
    tileUrl: available ? String(tileUrl).trim() : null,
    attribution: process.env.MAP_SATELLITE_ATTRIBUTION
      ? String(process.env.MAP_SATELLITE_ATTRIBUTION)
      : null,
    tileSize: 256,
    maxZoom: Number.parseInt(process.env.MAP_SATELLITE_MAX_ZOOM || '19', 10) || 19,
  };
}

function getMapConfig() {
  return {
    street: { ...OSM_STREET },
    satellite: buildSatelliteConfig(),
    grey: {
      available: true,
      tileUrl: null,
      attribution: null,
      tileSize: 256,
      maxZoom: 19,
    },
    developmentNotice:
      'Public OpenStreetMap raster tiles are for development and supervisor review only; they are not the production tile service.',
  };
}

function satelliteConfigured() {
  return buildSatelliteConfig().available;
}

module.exports = {
  getMapConfig,
  satelliteConfigured,
  OSM_STREET,
};
