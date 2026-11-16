/**
 * Map tile configuration for the Live Operations map (V2 Phase 5).
 *
 * This module is the ONLY place the tile URL / attribution may
 * appear. Tiles are OpenStreetMap's standard tile layer, used under
 * the OSM tile usage policy (see docs/live-gps-tracking.md §9):
 * no bulk downloading, attribution always visible on the map.
 */
export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

/** Default map view when no driver has reported a position yet:
 *  the geographic centre of Nepal. */
export const NEPAL_CENTRE: readonly [number, number] = [28.3949, 84.124];
export const DEFAULT_MAP_ZOOM = 7;
