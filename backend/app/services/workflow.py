"""Phase 3 workflow logic: district routing, order detail map payload, audit.

The routing decision is the heart of dispatch:
  * same district / local service area -> last_mile  (assign a micro driver)
  * different district                 -> inter_warehouse (transfer manifest + vehicle)

Everything here is read/assemble only (no writes) so it is safe to call from
any role-gated endpoint.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from app.core.supabase_client import get_supabase


# --- Routing decision ---------------------------------------------------------
def _norm(value: Optional[str]) -> str:
    return (value or "").strip().lower()


def decide_route(origin_district: Optional[str], destination_district: Optional[str]) -> str:
    """Return 'last_mile' when origin and destination share a district, else
    'inter_warehouse'.

    Missing districts fall back to inter_warehouse (the safer, warehouse-managed
    path) so a parcel never silently skips the transfer step.
    """
    o = _norm(origin_district)
    d = _norm(destination_district)
    if o and d and o == d:
        return "last_mile"
    return "inter_warehouse"


def route_reason(origin_district: Optional[str], destination_district: Optional[str]) -> str:
    o = (origin_district or "").strip() or "—"
    d = (destination_district or "").strip() or "—"
    if _norm(origin_district) and _norm(origin_district) == _norm(destination_district):
        return f"Same district ({o}) — assign a micro driver for last-mile delivery."
    return f"{o} → {d} — different district, route via inter-warehouse transfer + vehicle."


# --- Audit --------------------------------------------------------------------
def log_order_event(
    sb,
    order_id: str,
    event: str,
    *,
    actor_id: Optional[str] = None,
    actor_role: Optional[str] = None,
    note: Optional[str] = None,
) -> None:
    """Best-effort order audit row; never blocks the main action."""
    try:
        sb.table("order_events").insert(
            {
                "order_id": order_id,
                "event": event,
                "actor_id": actor_id,
                "actor_role": actor_role,
                "note": note,
            }
        ).execute()
    except Exception:
        pass


def _safe(sb, table: str, select: str = "*", **filters) -> list[dict[str, Any]]:
    try:
        q = sb.table(table).select(select)
        for k, v in filters.items():
            if v is not None:
                q = q.eq(k, v)
        return q.execute().data or []
    except Exception:
        return []


# --- Order detail (per-order map payload) -------------------------------------
def get_order_detail(order_id: str) -> Optional[dict[str, Any]]:
    """Assemble the order details page + per-order interactive map payload.

    Scoped to ONE order: its origin warehouse, current/intermediate warehouse,
    destination, assigned vehicle/driver, and a unified timestamped timeline.
    """
    sb = get_supabase()
    orders = _safe(sb, "orders", "*", id=order_id)
    if not orders:
        return None
    order = orders[0]

    shipment_id = order.get("shipment_id")
    if not shipment_id:
        sh = _safe(sb, "shipments", "*", order_id=order_id)
        shipment_id = sh[0]["id"] if sh else None
    shipment = _safe(sb, "shipments", "*", id=shipment_id)[0] if shipment_id else None

    warehouses = _safe(sb, "warehouses", "id, code, name, address, city, latitude, longitude")
    wh_by_id = {w["id"]: w for w in warehouses}
    waypoints: list[dict[str, Any]] = []

    def _wp(wh_id: Optional[str], role: str) -> None:
        if not wh_id:
            return
        w = wh_by_id.get(wh_id)
        if not w or w.get("latitude") is None:
            return
        waypoints.append(
            {
                "role": role,
                "warehouse_id": w["id"],
                "name": w["name"],
                "city": w.get("city"),
                "lng": w["longitude"],
                "lat": w["latitude"],
            }
        )

    origin_wh = (
        order.get("origin_warehouse_id")
        or (shipment or {}).get("origin_warehouse_id")
        or order.get("warehouse_id")
    )
    current_wh = (shipment or {}).get("current_warehouse_id")
    dest_wh = (shipment or {}).get("dest_warehouse_id")
    _wp(origin_wh, "origin")
    _wp(current_wh, "current")
    _wp(dest_wh, "destination")

    if order.get("delivery_latitude") is not None and order.get("delivery_longitude") is not None:
        waypoints.append(
            {
                "role": "delivery",
                "warehouse_id": None,
                "name": order.get("delivery_address") or "Delivery address",
                "city": None,
                "lng": order["delivery_longitude"],
                "lat": order["delivery_latitude"],
            }
        )

    transfers = _safe(sb, "warehouse_transfers", "*", shipment_id=shipment_id) if shipment_id else []

    # Trip + vehicle (if this shipment rides a vehicle between warehouses).
    trip: Optional[dict[str, Any]] = None
    vehicle: Optional[dict[str, Any]] = None
    big_driver: Optional[dict[str, Any]] = None
    if shipment_id:
        manifests = _safe(sb, "trip_manifests", "*", shipment_id=shipment_id)
        if manifests:
            trips = _safe(sb, "trips", "*", id=manifests[0].get("trip_id"))
            trip = trips[0] if trips else None
    if not trip and transfers and transfers[0].get("trip_id"):
        trips = _safe(sb, "trips", "*", id=transfers[0]["trip_id"])
        trip = trips[0] if trips else None
    if trip:
        if trip.get("vehicle_id"):
            v = _safe(sb, "vehicles", "*", id=trip["vehicle_id"])
            vehicle = v[0] if v else None
        if trip.get("big_driver_id"):
            d = _safe(sb, "drivers", "*", id=trip["big_driver_id"])
            big_driver = d[0] if d else None

    # Micro-driver last-mile task.
    tasks = _safe(sb, "driver_tasks", "*", shipment_id=shipment_id) if shipment_id else []
    task = tasks[0] if tasks else None
    micro_driver = None
    if task:
        d = _safe(sb, "drivers", "*", id=task.get("driver_id"))
        micro_driver = d[0] if d else None

    # Vehicle live position (big driver GPS) while in transit.
    vehicle_position = None
    if big_driver and big_driver.get("current_latitude") is not None:
        vehicle_position = {
            "lng": big_driver["current_longitude"],
            "lat": big_driver["current_latitude"],
            "driver_name": big_driver.get("name"),
            "last_seen_at": big_driver.get("last_seen_at"),
            "trip_status": (trip or {}).get("status"),
        }

    # Unified timeline: order events + shipment events, chronological.
    timeline: list[dict[str, Any]] = []
    for e in _safe(sb, "order_events", "*", order_id=order_id):
        timeline.append(
            {
                "at": e.get("created_at"),
                "event": e.get("event"),
                "note": e.get("note"),
                "actor_role": e.get("actor_role"),
                "source": "order",
            }
        )
    if shipment_id:
        for e in _safe(sb, "shipment_events", "*", shipment_id=shipment_id):
            timeline.append(
                {
                    "at": e.get("created_at"),
                    "event": e.get("event"),
                    "note": e.get("note"),
                    "actor_role": e.get("actor_role"),
                    "source": "shipment",
                }
            )
    timeline.sort(key=lambda x: x.get("at") or "")

    route_kind = (shipment or {}).get("route_kind") or decide_route(
        order.get("origin_district") or (shipment or {}).get("origin_district"),
        order.get("destination_district") or (shipment or {}).get("destination_district"),
    )

    return {
        "order": order,
        "shipment": shipment,
        "route_kind": route_kind,
        "route_reason": route_reason(
            order.get("origin_district") or (shipment or {}).get("origin_district"),
            order.get("destination_district") or (shipment or {}).get("destination_district"),
        ),
        "waypoints": waypoints,
        "stage": _stage_label(order, shipment, trip, task),
        "transfers": transfers,
        "trip": trip,
        "vehicle": vehicle,
        "big_driver": big_driver,
        "vehicle_position": vehicle_position,
        "task": task,
        "micro_driver": micro_driver,
        "timeline": timeline,
    }


def _stage_label(order, shipment, trip, task) -> str:
    """Human label for where the parcel is in the multi-stage journey."""
    if order.get("approval_status") == "pending":
        return "Awaiting admin approval"
    if order.get("approval_status") == "rejected":
        return "Rejected by admin"
    if not shipment:
        return "Approved - awaiting warehouse intake"
    status = shipment.get("parcel_status") or ""
    if status in ("registered", "picked_up", "at_origin_hub"):
        return "At origin warehouse"
    if status == "in_transit" or (trip and trip.get("status") in ("departed", "at_checkpoint", "loading")):
        return "In transit between warehouses"
    if status == "at_dest_hub":
        return "Arrived at destination warehouse"
    if status == "out_for_delivery":
        return "Out for last-mile delivery"
    if status == "delivered":
        return "Delivered"
    if status in ("delivery_failed", "returned", "cancelled"):
        return status.replace("_", " ").title()
    return (status or "Processing").replace("_", " ").title()



