"""Operational analytics derived from the orders table."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from app.core.supabase_client import get_supabase

_IN_TRANSIT = ("went_for_delivery", "out_for_delivery")
_PENDING = ("received", "on_place")


def _count(table_query) -> int:
    res = table_query.execute()
    # supabase-py returns count when using count="exact"
    return res.count or 0


def overview() -> dict[str, Any]:
    """High-level counts used by the dashboard summary cards."""
    sb = get_supabase()

    def status_count(statuses: tuple[str, ...]) -> int:
        return _count(
            sb.table("orders").select("id", count="exact").in_("status", list(statuses))
        )

    total = _count(sb.table("orders").select("id", count="exact"))
    delivered = status_count(("delivered",))
    in_transit = status_count(_IN_TRANSIT)
    pending = status_count(_PENDING)
    # Active drivers = available drivers ready for assignment
    active_drivers = _count(
        sb.table("drivers").select("id", count="exact").eq("is_available", True)
    )

    return {
        "total": total,
        "delivered": delivered,
        "in_transit": in_transit,
        "pending": pending,
        "active_drivers": active_drivers,
    }


def daily_summary(day: datetime | None = None) -> dict[str, Any]:
    """Summary for a single day (defaults to today, UTC)."""
    sb = get_supabase()
    day = day or datetime.now(timezone.utc)
    start = day.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)

    base = (
        sb.table("orders")
        .select("id", count="exact")
        .gte("created_at", start.isoformat())
        .lt("created_at", end.isoformat())
    )
    total = _count(base)

    def status_count(statuses: tuple[str, ...]) -> int:
        return _count(
            sb.table("orders")
            .select("id", count="exact")
            .gte("created_at", start.isoformat())
            .lt("created_at", end.isoformat())
            .in_("status", list(statuses))
        )

    return {
        "date": start.date().isoformat(),
        "total": total,
        "delivered": status_count(("delivered",)),
        "in_transit": status_count(_IN_TRANSIT),
        "pending": status_count(_PENDING),
        "failed": status_count(("failed", "cancelled")),
    }
