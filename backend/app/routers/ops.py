"""Operational lookups: profile, warehouses, vehicles, inventory, payments."""
from fastapi import APIRouter, Depends, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.auth import ROLE_CATALOG, decode_optional, require_admin_console
from app.core.config import settings
from app.core.supabase_client import get_supabase

router = APIRouter(prefix="/ops", tags=["ops"])

_bearer = HTTPBearer(auto_error=False)

# Staff roles considered "operators" when no login token is presented (dev mode).
_OPERATOR_ROLES = ["super_admin", "warehouse_admin", "admin", "dispatcher", "warehouse"]


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


def _resolve_operator(sb, sub: str | None) -> dict:
    """Identity for the shell: the signed-in user when a JWT is presented,
    otherwise the first staff operator (dev/demo mode)."""
    fallback = {"name": "Operator", "role": "staff", "role_label": "Operator", "initials": "OP"}

    def _row_to_operator(row: dict) -> dict:
        name = (row.get("full_name") or row.get("email") or "Operator").strip()
        role = str(row.get("role") or "staff")
        label = next(
            (r["label"] for r in ROLE_CATALOG if r["id"] == role), role.replace("_", " ").title()
        )
        initials = (
            "".join(w[0] for w in name.split() if w[:1].isalpha())[:2].upper() or "OP"
        )
        operator = {
            "name": name,
            "role": role,
            "role_label": label,
            "initials": initials,
            "vendor_id": row.get("vendor_id"),
            "email": row.get("email"),
        }
        if operator.get("vendor_id"):
            try:
                vres = (
                    sb.table("vendors")
                    .select("id, name")
                    .eq("id", operator["vendor_id"])
                    .limit(1)
                    .execute()
                )
                if vres.data:
                    operator["vendor_name"] = vres.data[0].get("name")
            except Exception:
                pass
        return operator

    def _fetch(columns: str, *, by_id: str | None = None, staff_only: bool = False):
        query = sb.table("users").select(columns)
        if by_id:
            query = query.eq("id", by_id).limit(1)
        elif staff_only:
            query = query.in_("role", _OPERATOR_ROLES).order("created_at").limit(1)
        return query.execute()

    try:
        if sub:
            # vendor_id column may not exist on a live DB until Phase 1 runs.
            try:
                res = _fetch("full_name, email, role, vendor_id", by_id=sub)
            except Exception:
                res = _fetch("full_name, email, role", by_id=sub)
            if res.data:
                return _row_to_operator(res.data[0])
        try:
            res = _fetch("full_name, email, role, vendor_id", staff_only=True)
        except Exception:
            try:
                res = _fetch("full_name, email, role", staff_only=True)
            except Exception:
                # The new enum values may not exist yet on an unmigrated
                # database — retry with legacy staff roles only.
                res = (
                    sb.table("users")
                    .select("full_name, email, role")
                    .in_("role", ["admin", "dispatcher", "warehouse"])
                    .order("created_at")
                    .limit(1)
                    .execute()
                )
        if res and res.data:
            return _row_to_operator(res.data[0])
    except Exception:
        pass
    return fallback


@router.get("/profile", dependencies=[Depends(require_admin_console)])
def profile(creds: HTTPAuthorizationCredentials | None = Depends(_bearer)):
    """Signed-in operator profile + sidebar badges + system status.

    Everything the shell needs in ONE call: operator identity (resolved from
    the JWT when present), the role catalog for role-aware UI, live record
    counts per section, and whether the database is reachable right now.
    """
    sb = get_supabase()
    claims = decode_optional(creds.credentials) if creds else None
    sub = str(claims.get("sub")) if claims and claims.get("sub") else None

    operator = _resolve_operator(sb, sub)

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
        "vendors": _safe_count("vendors"),
        "shipments": _safe_count("shipments"),
        "trips": _safe_count("trips"),
    }
    badges = {k: v for k, v in counts.items() if v is not None}
    return {
        "operator": operator,
        "role": operator.get("role"),
        "roles": ROLE_CATALOG,
        "auth_required": settings.require_auth,
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
