"""Trip endpoints for big drivers (inter-warehouse journeys).

Independent trip status track (assigned -> loading -> departed ->
at_checkpoint -> arrived_dest -> unloading -> completed). Live GPS stays on
the admin live map for big drivers only; micro drivers are task-based.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core.auth import require_staff, require_user, role_of
from app.core.supabase_client import get_supabase
from app.services import shipments as shipment_service

router = APIRouter(prefix="/trips", tags=["trips"])

_staff = Depends(require_staff)
_user = Depends(require_user)


class TripCreate(BaseModel):
    big_driver_id: str
    origin_warehouse_id: str | None = None
    dest_warehouse_id: str | None = None
    vehicle_id: str | None = None
    shipment_ids: list[str] = []

    model_config = {"extra": "ignore"}


class TripStatusUpdate(BaseModel):
    status: str

    model_config = {"extra": "ignore"}


class CheckpointCreate(BaseModel):
    label: str
    latitude: float | None = None
    longitude: float | None = None

    model_config = {"extra": "ignore"}


def _caller_driver_id(user: dict | None) -> str | None:
    sub = (user or {}).get("sub")
    if not sub:
        return None
    try:
        res = (
            get_supabase()
            .table("drivers")
            .select("id")
            .eq("user_id", sub)
            .limit(1)
            .execute()
        )
        return res.data[0]["id"] if res.data else None
    except Exception:
        return None


@router.post("", status_code=201, dependencies=[_staff])
def create_trip(payload: TripCreate, user: dict = _user):
    sb = get_supabase()
    res = (
        sb.table("trips")
        .insert(
            {
                "big_driver_id": payload.big_driver_id,
                "origin_warehouse_id": payload.origin_warehouse_id,
                "dest_warehouse_id": payload.dest_warehouse_id,
                "vehicle_id": payload.vehicle_id,
            }
        )
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=400, detail="trip not created")
    trip = res.data[0]
    if payload.shipment_ids:
        sb.table("trip_manifests").insert(
            [{"trip_id": trip["id"], "shipment_id": sid} for sid in payload.shipment_ids]
        ).execute()
        shipment_service.log_event(
            sb, payload.shipment_ids[0], "trip:assigned",
            actor_id=(user or {}).get("sub"), actor_role=role_of(user),
        )
    return trip


@router.get("", dependencies=[_user])
def list_trips(
    driver_id: str | None = Query(default=None),
    active_only: bool = Query(default=True),
    user: dict = _user,
):
    sb = get_supabase()
    own = _caller_driver_id(user)
    effective = driver_id or own if own else driver_id
    query = sb.table("trips").select("*, drivers(name)").order("created_at", desc=True)
    if effective:
        query = query.eq("big_driver_id", effective)
    if active_only:
        query = query.not_.in_("status", ("completed", "cancelled"))
    return query.execute().data or []


@router.get("/{trip_id}")
def get_trip(trip_id: str):
    sb = get_supabase()
    trip = sb.table("trips").select("*, drivers(name)").eq("id", trip_id).limit(1).execute()
    if not trip.data:
        raise HTTPException(status_code=404, detail="trip not found")
    manifest = (
        sb.table("trip_manifests")
        .select("*, shipments(tracking_code, parcel_status)")
        .eq("trip_id", trip_id)
        .execute()
        .data
        or []
    )
    checkpoints = (
        sb.table("checkpoints")
        .select("*")
        .eq("trip_id", trip_id)
        .order("created_at")
        .execute()
        .data
        or []
    )
    return {**trip.data[0], "manifest": manifest, "checkpoints": checkpoints}



@router.patch("/{trip_id}/status", dependencies=[_user])
def update_trip_status(trip_id: str, payload: TripStatusUpdate, user: dict = _user):
    sb = get_supabase()
    res = sb.table("trips").select("*").eq("id", trip_id).limit(1).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="trip not found")
    trip = res.data[0]

    own = _caller_driver_id(user)
    role = role_of(user)
    if own and str(trip.get("big_driver_id")) != str(own) and role != "dev-bypass":
        raise HTTPException(status_code=403, detail="not your trip")

    if not shipment_service.validate_trip_transition(trip.get("status"), payload.status):
        raise HTTPException(
            status_code=400,
            detail=f"cannot move trip {trip.get('status')} -> {payload.status}",
        )

    from datetime import datetime, timezone

    update = {"status": payload.status}
    if payload.status == "departed":
        update["departed_at"] = datetime.now(timezone.utc).isoformat()
    if payload.status in ("arrived_dest", "completed"):
        update["arrived_at"] = datetime.now(timezone.utc).isoformat()
    updated = sb.table("trips").update(update).eq("id", trip_id).execute()

    for row in (
        sb.table("trip_manifests").select("shipment_id").eq("trip_id", trip_id).execute().data or []
    ):
        shipment_service.log_event(
            sb, row["shipment_id"], f"trip:{payload.status}",
            actor_id=(user or {}).get("sub"), actor_role=role,
        )
    return updated.data[0] if updated.data else trip


@router.post("/{trip_id}/checkpoints", status_code=201, dependencies=[_user])
def add_checkpoint(trip_id: str, payload: CheckpointCreate, user: dict = _user):
    sb = get_supabase()
    res = (
        sb.table("checkpoints")
        .insert(
            {
                "trip_id": trip_id,
                "label": payload.label,
                "latitude": payload.latitude,
                "longitude": payload.longitude,
            }
        )
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=400, detail="checkpoint not created")
    for row in (
        sb.table("trip_manifests").select("shipment_id").eq("trip_id", trip_id).execute().data or []
    ):
        shipment_service.log_event(
            sb, row["shipment_id"], f"checkpoint:{payload.label}",
            actor_id=(user or {}).get("sub"), actor_role=role_of(user),
        )
    return res.data[0]
