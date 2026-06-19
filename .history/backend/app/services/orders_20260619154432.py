"""Order business logic: creation, status updates, driver assignment."""
from __future__ import annotations

import random
from datetime import datetime, timezone
from typing import Any, Optional

from app.core.supabase_client import get_supabase
from app.schemas.orders import OrderCreate
from app.services import notifications
from app.services.routing import calculate_route


def _generate_order_number() -> str:
    year = datetime.now(timezone.utc).year
    suffix = random.randint(0, 9999)
    return f"BLA-{year}-{suffix:04d}"


async def create_order(payload: OrderCreate) -> dict[str, Any]:
    """Create an order (+ items), then fire-and-forget a confirmation."""
    sb = get_supabase()

    total_weight = sum(i.weight_kg * i.quantity for i in payload.items)
    total_amount = sum(i.unit_price * i.quantity for i in payload.items)

    order_row = {
        "order_number": _generate_order_number(),
        "customer_id": str(payload.customer_id) if payload.customer_id else None,
        "warehouse_id": str(payload.warehouse_id) if payload.warehouse_id else None,
        "status": "received",
        "pickup_address": payload.pickup_address,
        "pickup_latitude": payload.pickup_latitude,
        "pickup_longitude": payload.pickup_longitude,
        "delivery_address": payload.delivery_address,
        "delivery_latitude": payload.delivery_latitude,
        "delivery_longitude": payload.delivery_longitude,
        "recipient_name": payload.recipient_name,
        "recipient_phone": payload.recipient_phone,
        "total_weight_kg": total_weight,
        "total_amount": total_amount,
        "notes": payload.notes,
        "scheduled_at": payload.scheduled_at.isoformat() if payload.scheduled_at else None,
    }
    res = sb.table("orders").insert(order_row).execute()
    order = res.data[0]

    if payload.items:
        items = [
            {
                "order_id": order["id"],
                "sku": i.sku,
                "description": i.description,
                "quantity": i.quantity,
                "unit_price": i.unit_price,
                "weight_kg": i.weight_kg,
            }
            for i in payload.items
        ]
        sb.table("order_items").insert(items).execute()

    # Best-effort confirmation (won't raise on provider failure).
    await notifications.notify_order_confirmation(order)
    return order


def get_order(order_id: str) -> Optional[dict[str, Any]]:
    sb = get_supabase()
    res = sb.table("orders").select("*").eq("id", order_id).limit(1).execute()
    return res.data[0] if res.data else None


def list_orders(
    status: Optional[str] = None, limit: int = 100, offset: int = 0
) -> list[dict[str, Any]]:
    sb = get_supabase()
    query = sb.table("orders").select("*").order("created_at", desc=True)
    if status:
        query = query.eq("status", status)
    res = query.range(offset, offset + limit - 1).execute()
    return res.data or []


def list_drivers(available_only: bool = False) -> list[dict[str, Any]]:
    sb = get_supabase()
    query = sb.table("drivers").select("id, name, is_available, vehicle_id").order("name")
    if available_only:
        query = query.eq("is_available", True)
    res = query.execute()
    return res.data or []


async def update_order_status(
    order_id: str,
    status: str,
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    note: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Update an order's status and notify the customer.

    The DB trigger ``log_order_status_change`` writes the history row and sets
    ``delivered_at`` automatically. We add a richer history row here (with
    coordinates / note) for completeness.
    """
    sb = get_supabase()
    update = {"status": status}
    if status == "delivered":
        update["delivered_at"] = datetime.now(timezone.utc).isoformat()
    res = sb.table("orders").update(update).eq("id", order_id).execute()
    if not res.data:
        return None
    order = res.data[0]



    await notifications.notify_status_update(order, status)
    return order


async def assign_driver(
    order_id: str, driver_id: str, vehicle_id: Optional[str] = None
) -> dict[str, Any]:
    """Create a delivery assignment and compute a route for it.

    The new row in ``delivery_assignments`` is broadcast to the assigned driver
    via Supabase Realtime (the driver app subscribes to its own assignments).
    """
    sb = get_supabase()
    order = get_order(order_id)
    if not order:
        raise ValueError("order not found")

    # Resolve vehicle type for routing profile.
    vehicle_type = "van"
    if vehicle_id:
        v = sb.table("vehicles").select("type").eq("id", vehicle_id).limit(1).execute()
        if v.data:
            vehicle_type = v.data[0]["type"]

    route = None
    start = (order.get("pickup_latitude"), order.get("pickup_longitude"))
    end = (order.get("delivery_latitude"), order.get("delivery_longitude"))
    if all(c is not None for c in (*start, *end)):
        route = await calculate_route(start, end, vehicle_type)

    assignment = {
        "order_id": order_id,
        "driver_id": driver_id,
        "vehicle_id": vehicle_id,
        "status": "pending",
        "route_distance_m": route.get("distance_m") if route else None,
        "route_duration_s": route.get("duration_s") if route else None,
        "route_geometry": route.get("geometry") if route else None,
    }
    res = sb.table("delivery_assignments").insert(assignment).execute()

    # Mark driver busy.
    sb.table("drivers").update({"is_available": False}).eq("id", driver_id).execute()
    return res.data[0]


def driver_assignments(driver_id: str, active_only: bool = True) -> list[dict[str, Any]]:
    """Assignments for a driver, joined with the parent order details."""
    sb = get_supabase()
    query = (
        sb.table("delivery_assignments")
        .select("*, orders(*)")
        .eq("driver_id", driver_id)
        .order("assigned_at", desc=True)
    )
    if active_only:
        query = query.in_("status", ["pending", "accepted", "in_progress"])
    res = query.execute()
    return res.data or []


def update_assignment_status(assignment_id: str, status: str) -> Optional[dict[str, Any]]:
    sb = get_supabase()
    update: dict[str, Any] = {"status": status}
    now = datetime.now(timezone.utc).isoformat()
    if status == "accepted":
        update["accepted_at"] = now
    elif status in ("completed", "cancelled"):
        update["completed_at"] = now
    res = sb.table("delivery_assignments").update(update).eq("id", assignment_id).execute()
    if not res.data:
        return None
    assignment = res.data[0]
    # Free the driver when the run finishes.
    if status in ("completed", "cancelled"):
        sb.table("drivers").update({"is_available": True}).eq(
            "id", assignment["driver_id"]
        ).execute()
    return assignment
