"""Settlements + COD collections (super-admin tier owns payouts).

Fourth status track: pending -> collected -> reconciled -> deducted ->
settled (with a disputed detour). Gross amounts are computed from
cod_collections on the vendor's shipments inside the period.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core.auth import (
    STAFF_OR_VENDOR_ROLES,
    require_role,
    require_staff,
    require_super_admin,
    require_user,
    role_of,
)
from app.core.supabase_client import get_supabase
from app.services import shipments as shipment_service

router = APIRouter(prefix="/settlements", tags=["settlements"])

_staff = Depends(require_staff)
_staff_or_vendor = Depends(require_role(*STAFF_OR_VENDOR_ROLES))
_super = Depends(require_super_admin)


def _vendor_id_of(user: dict | None) -> str | None:
    """Resolve the vendor a vendor JWT belongs to (needs the users row)."""
    if role_of(user) != "vendor":
        return None
    sub = (user or {}).get("sub")
    if not sub:
        return None
    try:
        res = (
            get_supabase()
            .table("users")
            .select("vendor_id")
            .eq("id", sub)
            .limit(1)
            .execute()
        )
        return res.data[0].get("vendor_id") if res.data else None
    except Exception:
        return None


class SettlementCreate(BaseModel):
    vendor_id: str
    period_start: str  # YYYY-MM-DD
    period_end: str  # YYYY-MM-DD
    deductions: float = 0

    model_config = {"extra": "ignore"}


class SettlementStatusUpdate(BaseModel):
    status: str

    model_config = {"extra": "ignore"}


@router.get("", dependencies=[_staff_or_vendor])
def list_settlements(
    vendor_id: str | None = Query(default=None),
    user: dict = Depends(require_user),
):
    sb = get_supabase()
    # Vendors see ONLY their own settlements.
    if role_of(user) == "vendor":
        own = _vendor_id_of(user)
        if not own:
            return []
        vendor_id = own
    query = sb.table("settlements").select("*, vendors(name)").order("created_at", desc=True)
    if vendor_id:
        query = query.eq("vendor_id", vendor_id)
    return query.execute().data or []


@router.get("/cod", dependencies=[_staff])
def list_cod_collections(limit: int = Query(default=200, le=500)):
    """COD collected at the door, joined to parcel + task context."""
    sb = get_supabase()
    res = (
        sb.table("cod_collections")
        .select("*, shipments(tracking_code, parcel_status), driver_tasks(status)")
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return res.data or []


@router.post("", status_code=201, dependencies=[_super])
def create_settlement(payload: SettlementCreate):
    sb = get_supabase()
    vendor = (
        sb.table("vendors").select("id").eq("id", payload.vendor_id).limit(1).execute()
    )
    if not vendor.data:
        raise HTTPException(status_code=404, detail="vendor not found")

    # Gross = COD collected on this vendor's shipments within the period.
    try:
        rows = (
            sb.table("cod_collections")
            .select("amount, created_at, shipments(vendor_id)")
            .gte("created_at", payload.period_start)
            .lte("created_at", f"{payload.period_end}T23:59:59.999999+00:00")
            .execute()
            .data
            or []
        )
    except Exception:
        rows = []
    gross = sum(
        float(r.get("amount") or 0)
        for r in rows
        if (r.get("shipments") or {}).get("vendor_id") == payload.vendor_id
    )
    deductions = float(payload.deductions or 0)

    res = (
        sb.table("settlements")
        .insert(
            {
                "vendor_id": payload.vendor_id,
                "period_start": payload.period_start,
                "period_end": payload.period_end,
                "gross_amount": gross,
                "deductions": deductions,
                "net_amount": max(gross - deductions, 0),
                "status": "pending",
            }
        )
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=400, detail="settlement not created")
    return res.data[0]


@router.patch("/{settlement_id}/status", dependencies=[_super])
def update_settlement_status(settlement_id: str, payload: SettlementStatusUpdate):
    sb = get_supabase()
    res = (
        sb.table("settlements")
        .select("*")
        .eq("id", settlement_id)
        .limit(1)
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="settlement not found")

    current = res.data[0].get("status")
    nxt = payload.status
    if nxt not in {
        "pending", "collected", "reconciled", "deducted", "settled", "disputed",
    }:
        raise HTTPException(status_code=400, detail="unknown settlement status")
    if not shipment_service.validate_settlement_transition(current, nxt):
        raise HTTPException(
            status_code=400, detail=f"cannot move settlement {current} -> {nxt}"
        )

    update = {"status": nxt}
    if nxt == "settled":
        update["settled_at"] = datetime.now(timezone.utc).isoformat()
    sb.table("settlements").update(update).eq("id", settlement_id).execute()
    refreshed = (
        sb.table("settlements")
        .select("*, vendors(name)")
        .eq("id", settlement_id)
        .limit(1)
        .execute()
    )
    return refreshed.data[0] if refreshed.data else {"id": settlement_id, **update}
