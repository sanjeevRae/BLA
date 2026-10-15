"""Warehouse operations: scans, transfers, handovers (staff only).

Parcel registration = POST /shipments. Scan/dispatch/arrival/handovers live here.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.auth import require_staff, require_user, role_of
from app.core.supabase_client import get_supabase
from app.services import shipments as shipment_service

router = APIRouter(tags=["warehouse-ops"])

_staff = Depends(require_staff)
_user = Depends(require_user)

SCAN_EVENTS = {
    "registered",
    "sorted",
    "dispatched",
    "arrived",
    "picked_up",
    "handed_to_driver",
    "received_from_driver",
}


class ScanCreate(BaseModel):
    shipment_id: str
    warehouse_id: str | None = None
    event: str

    model_config = {"extra": "ignore"}


class TransferCreate(BaseModel):
    shipment_id: str
    from_warehouse_id: str | None = None
    to_warehouse_id: str

    model_config = {"extra": "ignore"}


class HandoverCreate(BaseModel):
    shipment_id: str
    warehouse_id: str | None = None
    driver_id: str
    direction: str

    model_config = {"extra": "ignore"}


def _audit(sb, shipment_id: str, event: str, user: dict | None, *, location=None, note=None):
    shipment_service.log_event(
        sb,
        shipment_id,
        event,
        actor_id=(user or {}).get("sub"),
        actor_role=role_of(user),
        location=location,
        note=note,
    )


@router.post("/warehouse/scans", status_code=201, dependencies=[_staff])
def create_scan(payload: ScanCreate, user: dict = _user):
    if payload.event not in SCAN_EVENTS:
        raise HTTPException(status_code=400, detail=f"unknown scan event: {payload.event}")
    sb = get_supabase()
    res = (
        sb.table("scan_events")
        .insert(
            {
                "shipment_id": payload.shipment_id,
                "warehouse_id": payload.warehouse_id,
                "event": payload.event,
            }
        )
        .execute()
    )
    _audit(sb, payload.shipment_id, f"scan:{payload.event}", user)
    return res.data[0] if res.data else {}


@router.get("/warehouse/scans", dependencies=[_staff])
def list_scans(shipment_id: str | None = None):
    sb = get_supabase()
    query = sb.table("scan_events").select("*").order("created_at")
    if shipment_id:
        query = query.eq("shipment_id", shipment_id)
    return query.execute().data or []


@router.post("/warehouse/transfers", status_code=201, dependencies=[_staff])
def create_transfer(payload: TransferCreate, user: dict = _user):
    sb = get_supabase()
    res = (
        sb.table("warehouse_transfers")
        .insert(
            {
                "shipment_id": payload.shipment_id,
                "from_warehouse_id": payload.from_warehouse_id,
                "to_warehouse_id": payload.to_warehouse_id,
            }
        )
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=400, detail="transfer not created")
    _audit(sb, payload.shipment_id, "status:registered->in_transit", user)
    sb.table("shipments").update({"parcel_status": "in_transit"}).eq(
        "id", payload.shipment_id
    ).execute()
    return res.data[0]


@router.patch("/warehouse/transfers/{transfer_id}/receive", dependencies=[_staff])
def receive_transfer(transfer_id: str, user: dict = _user):
    sb = get_supabase()
    res = (
        sb.table("warehouse_transfers")
        .select("*")
        .eq("id", transfer_id)
        .limit(1)
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="transfer not found")
    transfer = res.data[0]
    from datetime import datetime, timezone

    updated = (
        sb.table("warehouse_transfers")
        .update(
            {
                "status": "received",
                "received_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        .eq("id", transfer_id)
        .execute()
    )
    _audit(sb, transfer["shipment_id"], "status:in_transit->at_dest_hub", user)
    sb.table("shipments").update({"parcel_status": "at_dest_hub"}).eq(
        "id", transfer["shipment_id"]
    ).execute()
    return updated.data[0] if updated.data else transfer


@router.post("/warehouse/handovers", status_code=201, dependencies=[_staff])
def create_handover(payload: HandoverCreate, user: dict = _user):
    if payload.direction not in ("to_driver", "to_warehouse"):
        raise HTTPException(status_code=400, detail="direction must be to_driver/to_warehouse")
    sb = get_supabase()
    res = (
        sb.table("handovers")
        .insert(
            {
                "shipment_id": payload.shipment_id,
                "warehouse_id": payload.warehouse_id,
                "driver_id": payload.driver_id,
                "direction": payload.direction,
            }
        )
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=400, detail="handover not created")
    _audit(sb, payload.shipment_id, f"handover:{payload.direction}", user)
    return res.data[0]


@router.patch("/warehouse/handovers/{handover_id}/confirm", dependencies=[_staff])
def confirm_handover(handover_id: str, user: dict = _user):
    sb = get_supabase()
    res = sb.table("handovers").select("*").eq("id", handover_id).limit(1).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="handover not found")
    handover = res.data[0]
    from datetime import datetime, timezone

    updated = (
        sb.table("handovers")
        .update({"status": "confirmed", "confirmed_at": datetime.now(timezone.utc).isoformat()})
        .eq("id", handover_id)
        .execute()
    )
    _audit(sb, handover["shipment_id"], "handover:confirmed", user)
    return updated.data[0] if updated.data else handover
