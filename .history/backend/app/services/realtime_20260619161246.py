"""Supabase Realtime integration.

Architecture note
-----------------
Most realtime traffic in this platform is *database-driven*: drivers insert
rows into ``gps_tracking`` and dispatchers insert into ``delivery_assignments``,
and Supabase Realtime broadcasts those Postgres changes directly to subscribed
browsers (admin dashboard, customer tracking page). The backend does NOT need
to be in that hot path — it simply writes to the database and Supabase fans the
events out over WebSockets. This keeps the FastAPI service stateless.

The helpers below let the backend *write* GPS pings and assignments (so they
get broadcast) and *broadcast* ad-hoc messages on a named channel when needed.

------------------------------------------------------------------------------
SCALING / REDIS NOTE
------------------------------------------------------------------------------
Because realtime fan-out is handled by Supabase (not by in-process WebSockets
in FastAPI), this design scales horizontally on Render WITHOUT Redis for the
common case. If you later add backend-managed WebSocket endpoints (e.g. a
custom dispatcher feed) and run multiple Render instances behind the load
balancer, you MUST share pub/sub state across instances. That is exactly where
Render-managed **Redis Pub/Sub** slots in:

    # >>> REDIS PUB/SUB INTEGRATION POINT (multi-instance only) <<<
    # import redis.asyncio as redis
    # r = redis.from_url(settings.redis_url)
    # await r.publish("gps", json.dumps(ping))           # producer instance
    # async for msg in r.subscribe("gps"): broadcast(msg) # every instance
    #
    # Until settings.redis_url is set, the app runs single-instance and relies
    # solely on Supabase Realtime for fan-out.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.core.supabase_client import get_supabase


def record_gps_ping(ping: dict[str, Any]) -> dict[str, Any]:
    """Insert a GPS ping; Supabase Realtime broadcasts it to subscribers."""
    sb = get_supabase()
    res = sb.table("gps_tracking").insert(ping).execute()
    return res.data[0] if res.data else {}


def update_driver_location(driver_id: str, lat: float, lon: float) -> None:
    """Keep a denormalised 'last known location' on the driver row."""
    sb = get_supabase()
    sb.table("drivers").update(
        {
            "current_latitude": lat,
            "current_longitude": lon,
            "last_seen_at": datetime.now(timezone.utc).isoformat(),
        }
    ).eq("id", driver_id).execute()
