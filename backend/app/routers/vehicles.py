"""Vehicles module: fleet overview + per-vehicle detail (map, route, cargo).

Fleet overview joins each vehicle to its active trip, big-driver live position,
origin/destination warehouses, departure/ETA and the count of parcels onboard.
The detail view adds the manifest, loading records and trip checkpoints.
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.auth import require_staff, require_user
from app.core.supabase_client import get_supabase

router = APIRouter(prefix="/vehicles", tags=["vehicles"])

_staff = Depends(require_staff)
_user = Depends(require_user)


def _safe(sb, table: str, select: str = "*", **filters):
    try:
        q = sb.table(table).select(select)
        for k, v in filters.items():
            if v is not None:
                q = q.eq(k, v)
        return q.execute().data or []
    except Exception:
        return []


def _driver_position(driver) -> Optional[dict]:
    if driver and driver.get("current_latitude") is not None:
        return {
            "lat": driver["current_latitude"],
            "lng": driver["current_longitude"],
            "last_seen_at": driver.get("last_seen_at"),
        }
    return None


@router.get("/fleet", dependencies=[_staff])
def fleet_overview():
    """One row per vehicle with its active trip, driver, location and cargo."""
    sb = get_supabase()
    vehicles = _safe(sb, "vehicles", "*") or []
    trips = _safe(sb, "trips", "*")
    active_trips = [t for t in trips if t.get("status") not in ("completed", "cancelled")]
    trips_by_vehicle: dict[str, list] = {}
    for t in active_trips:
        if t.get("vehicle_id"):
            trips_by_vehicle.setdefault(str(t["vehicle_id"]), []).append(t)

    warehouses = {w["id"]: w for w in _safe(sb, "warehouses", "id, name, city, latitude, longitude")}
    manifests = _safe(sb, "trip_manifests", "*")
    onboard_by_trip: dict[str, int] = {}
    for m in manifests:
        key = str(m.get("trip_id"))
        onboard_by_trip[key] = onboard_by_trip.get(key, 0) + 1

    out = []
    for v in vehicles:
        vtrips = trips_by_vehicle.get(str(v["id"]), [])
        trip = vtrips[0] if vtrips else None
        driver = None
        if trip and trip.get("big_driver_id"):
            d = _safe(sb, "drivers", "*", id=trip["big_driver_id"])
            driver = d[0] if d else None
        if not driver:
            d = _safe(sb, "drivers", "*", vehicle_id=v["id"])
            driver = d[0] if d else None

        origin = warehouses.get(trip.get("origin_warehouse_id")) if trip else None
        dest = warehouses.get(trip.get("dest_warehouse_id")) if trip else None
        out.append({
            **v,
            "driver": {"id": driver["id"], "name": driver.get("name")} if driver else None,
            "trip": trip,
            "trip_status": trip.get("status") if trip else "idle",
            "origin_warehouse": origin,
            "dest_warehouse": dest,
            "departed_at": trip.get("departed_at") if trip else None,
            "estimated_arrival": trip.get("estimated_arrival") if trip else None,
            "parcels_onboard": onboard_by_trip.get(str(trip.get("id")), 0) if trip else 0,
            "position": _driver_position(driver),
        })
    return out


@router.get("/{vehicle_id}/detail", dependencies=[_user])
def vehicle_detail(vehicle_id: str):
    sb = get_supabase()
    v = _safe(sb, "vehicles", "*", id=vehicle_id)
    if not v:
        raise HTTPException(status_code=404, detail="vehicle not found")
    vehicle = v[0]

    trips = [t for t in _safe(sb, "trips", "*") if str(t.get("vehicle_id")) == str(vehicle_id)]
    active = next((t for t in trips if t.get("status") not in ("completed", "cancelled")), None)
    trip = active or (trips[0] if trips else None)

    warehouses = {w["id"]: w for w in _safe(sb, "warehouses", "id, name, city, latitude, longitude")}
    driver = None
    if trip and trip.get("big_driver_id"):
        d = _safe(sb, "drivers", "*", id=trip["big_driver_id"])
        driver = d[0] if d else None
    if not driver:
        d = _safe(sb, "drivers", "*", vehicle_id=vehicle_id)
        driver = d[0] if d else None

    shipment_rows = []
    checkpoints = []
    transfers = []
    if trip:
        for m in _safe(sb, "trip_manifests", "*", trip_id=trip["id"]):
            s = _safe(sb, "shipments", "*", id=m.get("shipment_id"))
            if s:
                shipment_rows.append({**s[0], "loaded": m.get("loaded")})
        checkpoints = _safe(sb, "checkpoints", "*", trip_id=trip["id"])
        transfers = _safe(sb, "warehouse_transfers", "*", trip_id=trip["id"])

    loading_records = [
        {
            "shipment_id": t.get("shipment_id"),
            "from_warehouse": warehouses.get(t.get("from_warehouse_id")),
            "to_warehouse": warehouses.get(t.get("to_warehouse_id")),
            "status": t.get("status"),
            "loaded_at": t.get("loaded_at"),
            "unloaded_at": t.get("unloaded_at"),
            "dispatched_at": t.get("created_at"),
            "received_at": t.get("received_at"),
        }
        for t in transfers
    ]

    route_progress = _progress(trip)
    origin = warehouses.get(trip.get("origin_warehouse_id")) if trip else None
    dest = warehouses.get(trip.get("dest_warehouse_id")) if trip else None

    return {
        "vehicle": vehicle,
        "trip": trip,
        "driver": (
            {"id": driver["id"], "name": driver.get("name"), "phone": driver.get("phone")}
            if driver else None
        ),
        "position": _driver_position(driver),
        "origin_warehouse": origin,
        "dest_warehouse": dest,
        "route_progress": route_progress,
        "shipments": shipment_rows,
        "checkpoints": checkpoints,
        "loading_records": loading_records,
        "trip_status": trip.get("status") if trip else "idle",
    }


def _progress(trip) -> Optional[float]:
    if not trip:
        return None
    if trip.get("status") == "completed":
        return 1.0
    if not (trip.get("departed_at") and trip.get("estimated_arrival")):
        return None
    try:
        dep = datetime.fromisoformat(trip["departed_at"].replace("Z", "+00:00"))
        eta = datetime.fromisoformat(trip["estimated_arrival"].replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        total = (eta - dep).total_seconds()
        done = (now - dep).total_seconds()
        return max(0.0, min(1.0, done / total)) if total > 0 else 0.0
    except Exception:
        return None

