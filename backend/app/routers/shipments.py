"""Shipment (parcel) endpoints: register, list, status, audit trail.

Phase 2: parcels track a status independent of the classic order flow.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core.auth import require_staff, require_user, role_of
from app.core.supabase_client import get_supabase
from app.services import shipments as shipment_service

router = APIRouter(prefix="/shipments", tags=["shipments"])

_staff = Depends(require_staff)
_user = Depends(require_user)


class ShipmentCreate(BaseModel):
    destination_address: str
    order_id: str | None = None
    vendor_id: str | None = None
    origin_warehouse_id: str | None = None
    dest_warehouse_id: str | None = None
    recipient_name: str | None = None
    recipient_phone: str | None = None
    destination_latitude: float | None = None
    destination_longitude: float | None = None
    weight_kg: float = 0
    declared_value: float = 0

    model_config = {"extra": "ignore"}


class ShipmentStatusUpdate(BaseModel):
    status: str
    note: str | None = None

    model_config = {"extra": "ignore"}


_ALLOWED_FIELDS = {
    "order_id",
    "vendor_id",
    "origin_warehouse_id",
    "dest_warehouse_id",
    "recipient_name",
    "recipient_phone",
    "destination_address",
    "destination_latitude",
    "destination_longitude",
    "weight_kg",
    "declared_value",
    "registered_by",
    "parcel_status",
}


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


@router.post("", status_code=201)
def create_shipment(payload: ShipmentCreate, user: dict = _user):
    """Register a parcel (warehouse/v super-admin, or a vendor for itself)."""
    sb = get_supabase()
    role = role_of(user)
    vid = _vendor_id_of(user)
    if role == "vendor":
        if not vid:
            raise HTTPException(status_code=403, detail="vendor account not linked")
        data = payload.model_dump(exclude_none=True)
        data["vendor_id"] = vid
    elif role not in ("super_admin", "warehouse_admin", "admin", "dispatcher", "warehouse", "service_role", "dev-bypass"):
        raise HTTPException(status_code=403, detail="staff or vendor only")
    else:
        data = payload.model_dump(exclude_none=True)

    data = {k: v for k, v in data.items() if k in _ALLOWED_FIELDS}
    data["tracking_code"] = shipment_service.generate_unique_tracking_code(sb)
    data.setdefault("parcel_status", "registered")

    res = sb.table("shipments").insert(data).execute()
    if not res.data:
        raise HTTPException(status_code=400, detail="shipment not created")
    shipment = res.data[0]
    shipment_service.log_event(
        sb, shipment["id"], "registered", actor_id=(user or {}).get("sub"), actor_role=role
    )
    return shipment


@router.get("", dependencies=[_staff])
def list_shipments(
    status: str | None = Query(default=None),
    vendor_id: str | None = Query(default=None),
    limit: int = Query(default=100, le=500),
):
    sb = get_supabase()
    query = sb.table("shipments").select("*").order("created_at", desc=True).limit(limit)
    if status:
        query = query.eq("parcel_status", status)
    if vendor_id:
        query = query.eq("vendor_id", vendor_id)
    return query.execute().data or []


@router.get("/by-tracking/{tracking_code}")
def get_by_tracking(tracking_code: str):
    sb = get_supabase()
    res = (
        sb.table("shipments")
        .select("*")
        .eq("tracking_code", tracking_code.strip())
        .limit(1)
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="shipment not found")
    return res.data[0]


@router.get("/{shipment_id}")
def get_shipment(shipment_id: str):
    sb = get_supabase()
    res = sb.table("shipments").select("*").eq("id", shipment_id).limit(1).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="shipment not found")
    return res.data[0]


@router.get("/{shipment_id}/events")
def get_shipment_events(shipment_id: str):
    """Full accountability trail: WHO did WHAT, WHERE and WHEN."""
    sb = get_supabase()
    res = (
        sb.table("shipment_events")
        .select("*")
        .eq("shipment_id", shipment_id)
        .order("created_at")
        .execute()
    )
    return res.data or []


@router.patch("/{shipment_id}/status", dependencies=[_staff])
def update_shipment_status(shipment_id: str, payload: ShipmentStatusUpdate, user: dict = _user):
    sb = get_supabase()
    res = sb.table("shipments").select("*").eq("id", shipment_id).limit(1).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="shipment not found")
    current = res.data[0].get("parcel_status")
    nxt = payload.status
    if current in shipment_service.PARCEL_TERMINAL and nxt != current:
        raise HTTPException(status_code=400, detail=f"parcel is {current}; status is final")
    updated = (
        sb.table("shipments").update({"parcel_status": nxt}).eq("id", shipment_id).execute()
    )
    shipment_service.log_event(
        sb,
        shipment_id,
        f"status:{current}->{nxt}" if current else f"status:{nxt}",
        actor_id=(user or {}).get("sub"),
        actor_role=role_of(user),
        note=payload.note,
    )
    return updated.data[0] if updated.data else res.data[0]
