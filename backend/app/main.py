"""FastAPI application entrypoint for the BLA delivery operations platform.

Monolithic backend: one process exposes all REST endpoints (orders, drivers,
analytics, background tasks). Realtime fan-out (GPS, assignments) is delegated
to Supabase Realtime, so this service stays stateless and free-tier friendly.

Run locally:
    uvicorn app.main:app --reload --port 8000
"""
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.routers import analytics, drivers, orders, tasks

logging.basicConfig(level=logging.INFO)

app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="Monolithic FastAPI backend for the BLA delivery operations platform.",
)

# ---------------------------------------------------------------------------
# CORS — allow the static frontends (admin dashboard, customer tracking) to call
# the API directly from the browser.
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------
app.include_router(orders.router)
app.include_router(drivers.router)
app.include_router(analytics.router)
app.include_router(tasks.router)


@app.get("/", tags=["meta"])
def root():
    return {
        "service": settings.app_name,
        "version": "0.1.0",
        "docs": "/docs",
        "environment": settings.environment,
    }


@app.get("/health", tags=["meta"])
def health():
    """Liveness probe. Render pings this; the free tier spins down after 15 min
    of inactivity and cold-starts on the next request."""
    return {"status": "ok"}

# ---------------------------------------------------------------------------
# SCALING NOTE (Redis pub/sub):
# This is a single-instance deployment. To scale horizontally:
#   1. Set REDIS_URL (Render-managed Redis, ~$32/mo) in the environment.
#   2. Enable the Render load balancer / multiple web instances in render.yaml.
#   3. Wire Redis pub/sub at the marked integration point in
#      app/services/realtime.py so any backend-managed WebSocket state is shared
#      across instances. (Supabase Realtime already handles DB-change fan-out,
#      so Redis is only required if you add custom backend WebSocket endpoints.)
# ---------------------------------------------------------------------------
