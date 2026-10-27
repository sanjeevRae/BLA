"""Warehouse parcel intake with district-based routing.

When a customer places a parcel at a warehouse, the intake flow decides:

* Same district  -> route_kind = 'last_mile'; parcel stays at this warehouse
  and one of its drivers delivers directly.
* Other district -> route_kind = 'inter_warehouse'; a warehouse_transfer row
  is created to move the parcel to the destination warehouse, whose driver
  then completes the last mile.
"""
from __future__ import annotations
import random
from datetime import datetime, timezone
from typing import Any, Optional

from app.core.supabase_client import get_supabase
from app.services import notifications
from app.services.orders import _generate_unique_order_number
from pydantic import BaseModel, Field


class WarehouseIntakeCreate(BaseModel):
    """Parcel intake request submitted by a warehouse admin."""

    warehouse_id: str
    customer_id: Optional[str] = None
    sender_name: Optional[str] = None
    sender_phone: Optional[str] = None
    recipient_name: str
    recipient_phone: Optional[str] = None
    delivery_address: str
    delivery_latitude: Optional[float] = None
    delivery_longitude: Optional[float] = None
    destination_district: Optional[str] = None
    weight_kg: float = Field(default=0, ge=0)
    declared_value: float = Field(default=0, ge=0)
    parcel_type: str = Field(default="package")
    quantity: int = Field(default=1, gt=0)
    length_cm: Optional[float] = None
    width_cm: Optional[float] = None
    height_cm: Optional[float] = None
    handling_requirements: Optional[str] = None
    delivery_instructions: Optional[str] = None
    payment_method: str = Field(default="cod")
    items: list[dict] = Field(default_factory=list)

    model_config = {"extra": "ignore"}


class WarehouseIntakeOut(BaseModel):
    order_id: str
    order_number: str
    shipment_id: str
    tracking_code: str
    route_kind: str
    origin_warehouse_id: str
    dest_warehouse_id: Optional[str]
    transfer_id: Optional[str]


def _generate_tracking_code() -> str:
    year = datetime.now(timezone.utc).year
    suffix = random.randint(0, 999999)
    return f"BLA-PAR-{year}-{suffix:06d}"


def _generate_unique_tracking_code(sb, *, attempts: int = 10) -> str:
    for _ in range(attempts):
        candidate = _generate_tracking_code()
        existing = (
            sb.table("shipments")
            .select("id")
            .eq("tracking_code", candidate)
            .limit(1)
            .execute()
        )
        if not existing.data:
            return candidate
    raise RuntimeError("could not generate a unique tracking code")

def intake_parcel(payload: WarehouseIntakeCreate, user: dict | None) -> WarehouseIntakeOut:
    """Create a new parcel intake with district-based routing."""
    sb = get_supabase()

    # Fetch origin warehouse to determine its district
    wh = (
        sb.table("warehouses")
        .select("id, district, name, code")
        .eq("id", payload.warehouse_id)
        .limit(1)
        .execute()
    )
    if not wh.data:
        raise ValueError(f"warehouse {payload.warehouse_id} not found")
    origin_wh = wh.data[0]
    origin_district = origin_wh.get("district") or ""

    # Determine destination district
    dest_district = payload.destination_district or origin_district

    # Determine route kind
    route_kind: str
    dest_warehouse_id: Optional[str] = None
    transfer_id: Optional[str] = None

    if dest_district and dest_district != origin_district:
        route_kind = "inter_warehouse"
        dest_warehouse_id = _resolve_dest_warehouse(sb, dest_district)
    else:
        route_kind = "last_mile"
        dest_warehouse_id = origin_wh["id"]

    # Calculate totals from items
    total_amount = sum(
        (i.get("unit_price", 0) * i.get("quantity", 1)) for i in payload.items
    )
    total_weight = sum(
        (i.get("weight_kg", 0) * i.get("quantity", 1)) for i in payload.items
    )
    if not total_amount and payload.declared_value:
        total_amount = payload.declared_value
    if not total_weight and payload.weight_kg:
        total_weight = payload.weight_kg

    # Generate unique tracking code
    tracking_code = _generate_unique_tracking_code(sb)

    # Calculate totals from items
    total_amount = sum(
        (i.get("unit_price", 0) * i.get("quantity", 1)) for i in payload.items
    )
    total_weight = sum(
        (i.get("weight_kg", 0) * i.get("quantity", 1)) for i in payload.items
    )
    if not total_amount and payload.declared_value:
        total_amount = payload.declared_value
    if not total_weight and payload.weight_kg:
        total_weight = payload.weight_kg

    # Create order
    order_row = {
        "order_number": _generate_unique_order_number(sb),
        "customer_id": payload.customer_id,
        "warehouse_id": payload.warehouse_id,
        "origin_warehouse_id": payload.warehouse_id,
        "origin_district": origin_district or None,
        "destination_district": dest_district or None,
        "delivery_address": payload.delivery_address,
        "delivery_latitude": payload.delivery_latitude,
        "delivery_longitude": payload.delivery_longitude,
        "recipient_name": payload.recipient_name,
        "recipient_phone": payload.recipient_phone,
        "sender_name": payload.sender_name,
        "sender_phone": payload.sender_phone,
        "total_weight_kg": total_weight,
        "total_amount": total_amount,
        "payment_method": payload.payment_method,
        "payment_status": "unpaid",
        "status": "received",
        "notes": payload.delivery_instructions,
        "created_by_role": (user or {}).get("role", "warehouse"),
        "delivery_instructions": payload.delivery_instructions,
    }
    order_res = sb.table("orders").insert(order_row).execute()
    if not order_res.data:
        raise RuntimeError("order not created")
    order = order_res.data[0]

    # Create order items
    if payload.items:
        items = [
            {
                "order_id": order["id"],
                "sku": i.get("sku"),
                "description": i.get("description", ""),
                "quantity": i.get("quantity", 1),
                "unit_price": i.get("unit_price", 0),
                "weight_kg": i.get("weight_kg", 0),
            }
            for i in payload.items
        ]
        sb.table("order_items").insert(items).execute()

    # Create shipment
    shipment_row = {
        "tracking_code": tracking_code,
        "order_id": order["id"],
        "origin_warehouse_id": payload.warehouse_id,
        "dest_warehouse_id": dest_warehouse_id,
        "recipient_name": payload.recipient_name,
        "recipient_phone": payload.recipient_phone,
        "destination_address": payload.delivery_address,
        "destination_latitude": payload.delivery_latitude,
        "destination_longitude": payload.delivery_longitude,
        "weight_kg": payload.weight_kg,
        "declared_value": payload.declared_value,
        "parcel_status": "registered",
        "origin_district": origin_district or None,
        "destination_district": dest_district or None,
        "created_by_role": (user or {}).get("role", "warehouse"),
    }
    shipment_res = sb.table("shipments").insert(shipment_row).execute()
    if not shipment_res.data:
        raise RuntimeError("shipment not created")
    shipment = shipment_res.data[0]

    # Create warehouse transfer if inter_warehouse
    if route_kind == "inter_warehouse" and dest_warehouse_id:
        transfer_res = (
            sb.table("warehouse_transfers")
            .insert(
                {
                    "shipment_id": shipment["id"],
                    "origin_warehouse_id": payload.warehouse_id,
                    "dest_warehouse_id": dest_warehouse_id,
                    "status": "pending",
                }
            )
            .execute()
        )
        if transfer_res.data:
            transfer_id = transfer_res.data[0]["id"]

    # Send notification
    try:
        notifications.send_notification(
            user_id=payload.customer_id,
            title="Parcel Registered",
            message=f"Your parcel {tracking_code} has been registered at warehouse {origin_wh.get('code', payload.warehouse_id)}.",
        )
    except Exception:
        pass

    return WarehouseIntakeOut(
        order_id=order["id"],
        order_number=order["order_number"],
        shipment_id=shipment["id"],
        tracking_code=tracking_code,
        route_kind=route_kind,
        origin_warehouse_id=payload.warehouse_id,
        dest_warehouse_id=dest_warehouse_id,
        transfer_id=transfer_id,
    )

def _resolve_dest_warehouse(sb, district: str) -> Optional[str]:
    res = (
        sb.table("warehouses")
        .select("id")
        .eq("district", district)
        .eq("is_active", True)
        .limit(1)
        .execute()
    )
    return res.data[0]["id"] if res.data else None
