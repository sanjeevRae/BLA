"""Route calculation.

Primary provider: MapTiler Routing API (built on OSM data, vehicle profiles).
Fallback provider: OpenRouteService (2,000 directions/day on the free tier).

Both are called over HTTPS with the API key read from settings. The result is
normalised into a small dict the rest of the app can store on the assignment:
    { "distance_m": float, "duration_s": float, "geometry": <GeoJSON LineString> }
"""
from __future__ import annotations

from typing import Optional

import httpx

from app.core.config import settings

# MapTiler profile names per vehicle type.
_MAPTILER_PROFILE = {
    "bike": "bicycle",
    "car": "driving",
    "van": "driving",
    "truck": "driving",
}
# OpenRouteService profile names per vehicle type.
_ORS_PROFILE = {
    "bike": "cycling-regular",
    "car": "driving-car",
    "van": "driving-car",
    "truck": "driving-hgv",
}


class RouteResult(dict):
    """Lightweight dict subclass for clarity in type hints."""


async def _maptiler_route(
    start: tuple[float, float], end: tuple[float, float], vehicle: str
) -> Optional[RouteResult]:
    if not settings.maptiler_api_key:
        return None
    profile = _MAPTILER_PROFILE.get(vehicle, "driving")
    # MapTiler routing expects lon,lat;lon,lat
    coords = f"{start[1]},{start[0]};{end[1]},{end[0]}"
    url = f"https://api.maptiler.com/routing/{profile}/{coords}"
    params = {
        "key": settings.maptiler_api_key,
        "geometries": "geojson",
        "overview": "full",
    }
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()
    routes = data.get("routes") or []
    if not routes:
        return None
    r = routes[0]
    return RouteResult(
        distance_m=r.get("distance"),
        duration_s=r.get("duration"),
        geometry=r.get("geometry"),
        provider="maptiler",
    )


async def _ors_route(
    start: tuple[float, float], end: tuple[float, float], vehicle: str
) -> Optional[RouteResult]:
    if not settings.openrouteservice_api_key:
        return None
    profile = _ORS_PROFILE.get(vehicle, "driving-car")
    url = f"https://api.openrouteservice.org/v2/directions/{profile}/geojson"
    headers = {"Authorization": settings.openrouteservice_api_key}
    # ORS expects [lon, lat]
    body = {"coordinates": [[start[1], start[0]], [end[1], end[0]]]}
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(url, json=body, headers=headers)
        resp.raise_for_status()
        data = resp.json()
    features = data.get("features") or []
    if not features:
        return None
    feat = features[0]
    summary = feat.get("properties", {}).get("summary", {})
    return RouteResult(
        distance_m=summary.get("distance"),
        duration_s=summary.get("duration"),
        geometry=feat.get("geometry"),
        provider="openrouteservice",
    )


async def calculate_route(
    start: tuple[float, float],
    end: tuple[float, float],
    vehicle: str = "van",
) -> Optional[RouteResult]:
    """Calculate a route, preferring MapTiler and falling back to ORS.

    ``start`` and ``end`` are (latitude, longitude) tuples.
    Returns ``None`` if neither provider is configured or both fail.
    """
    # Try MapTiler first.
    try:
        result = await _maptiler_route(start, end, vehicle)
        if result:
            return result
    except (httpx.HTTPError, ValueError):
        pass  # fall through to ORS

    # Fallback: OpenRouteService.
    try:
        return await _ors_route(start, end, vehicle)
    except (httpx.HTTPError, ValueError):
        return None
