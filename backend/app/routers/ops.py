"""Operational lookups: warehouses, vehicles, inventory, payments."""
from fastapi import APIRouter, Query

from app.core.config import settings
from app.core.supabase_client import get_supabase

router = APIRouter(prefix="/ops", tags=["ops"])


def _safe_count(table: str, filters: list | None = None) -> int | None:
    """Row count for badges. None when the table/env is unreachable."""
    try:
        query = get_supabase().table(table).select("id", count="exact")
        for col, op, val in filters or []:
            query = getattr(query, op)(col, val)
        res = query.limit(0).execute()
        return res.count if res.count is not None else len(res.data or [])
    except Exception:
        return None


@router.get("/profile")
def profile():
    """Signed-in operator profile + sidebar badges + system status.

    Everything the shell needs in ONE call: the operator behind the
    Supabase service key (first staff user), live record counts per
    section, and whether the database is reachable right now.
    """
    sb = get_supabase()
    operator = {"name": "Operator", "role": "staff", "initials": "OP"}
    try:
        res = (
            sb.table("users")
            .select("full_name, email, role")
            .in_("role", ["admin", "dispatcher", "warehouse"])
            .order("created_at")
            .limit(1)
            .execute()
        )
        if res.data:
            row = res.data[0]
            name = (row.get("full_name") or row.get("email") or "Operator").strip()
            role = str(row.get("role") or "staff").capitalize()
            initials = "".join(w[0] for w in name.split() if w[:1].isalpha())[:2].upper() or "OP"
            operator = {"name": name, "role": role, "initials": initials}
    except Exception:
        pass

    try:
        sb.table("users").select("id").limit(1).execute()
        online = True
    except Exception:
        online = False

    counts = {
        "orders": _safe_count("orders"),
        "inventory": _safe_count("inventory"),
        "drivers": _safe_count("drivers", [("is_available", "eq", True)]),
        "customers": _safe_count("customers"),
        "packages": _safe_count("packages"),
        "payments": _safe_count("payments"),
        "vehicles": _safe_count("vehicles"),
        "warehouses": _safe_count("warehouses"),
        "notifications": _safe_count("admin_notifications"),
    }
    badges = {k: v for k, v in counts.items() if v is not None}
    return {
        "operator": operator,
        "environment": settings.environment,
        "online": online,
        "counts": counts,
        "badges": badges,
    }


@router.get("/warehouses")
def list_warehouses(limit: int = Query(default=100, le=500)):
    sb = get_supabase()
    res = sb.table("warehouses").select("*").order("name").limit(limit).execute()
    return res.data or []


@router.get("/vehicles")
def list_vehicles(limit: int = Query(default=200, le=500)):
    sb = get_supabase()
    res = sb.table("vehicles").select("*").order("registration").limit(limit).execute()
    return res.data or []


@router.get("/inventory")
def list_inventory(limit: int = Query(default=200, le=500)):
    sb = get_supabase()
    res = (
        sb.table("inventory")
        .select("*, warehouses(code, name)")
        .order("quantity")
        .limit(limit)
        .execute()
    )
    return res.data or []


@router.get("/payments")
def list_payments(limit: int = Query(default=200, le=500)):
    sb = get_supabase()
    res = (
        sb.table("payments")
        .select("*, orders(order_number)")
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return res.data or []


@router.get("/packages")
def list_packages(limit: int = Query(default=200, le=500)):
    sb = get_supabase()
    res = (
        sb.table("packages")
        .select("*, orders(order_number)")
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return res.data or []
