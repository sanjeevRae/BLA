"""Supabase client factory.

The backend uses the *service role* key, which bypasses Row Level Security.
This is appropriate because the backend is a trusted server that enforces its
own authorization in the routers. Never expose the service key to a browser.
"""
from functools import lru_cache

from supabase import Client, create_client

from app.core.config import settings


@lru_cache
def get_supabase() -> Client:
    if not settings.supabase_url or not settings.supabase_service_key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set to use the database."
        )
    return create_client(settings.supabase_url, settings.supabase_service_key)
