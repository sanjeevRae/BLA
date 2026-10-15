"""Phase 3 workflow endpoints: approval → intake → routing → dispatch → payment.

Role gates:
  * order create (vendor)      : vendor (auto pending) or staff (auto approved)
  * approval (approve/reject)  : super_admin / admin
  * warehouse intake           : warehouse_admin / super_admin / admin
  * dispatch (assign driver/trip): warehouse_admin / super_admin / dispatcher
  * payment update             : warehouse_admin / super_admin / dispatcher
  * order detail (map)         : staff or the owning vendor/customer
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core.auth import (
    require_role,
    require_staff,
    require_user,
    role_of,
)
from app.core.supabase_client import get_supabase
from app.services import shipments as shipment_service
from app.services import workflow

router = APIRouter(prefix="/workflow", tags=["workflow"])

_staff = Depends(require_staff)
_user = Depends(require_user)
_admin = Depends(require_role("super_admin", "admin", "warehouse_admin", "dispatcher", "service_role"))
_approver = Depends(require_role("super_admin", "admin", "service_role"))
_intake = Depends(require_role("super_admin", "admin", "warehouse_admin", "service_role"))
_dispatch = Depends(require_role("super_admin", "admin", "warehouse_admin", "dispatcher", "service_role"))
_payment = Depends(require_role("super_admin", "admin", "warehouse_admin", "dispatcher", "service_role"))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# --- Schemas ------------------------------------------------------------------
class OrderCreate(BaseModel):
    delivery_address: str
    recipient_name: Optional[str] = None
    recipient_phone: Optional[str] = None
    pickup_address: Optional[str] = None
    pickup_latitude: Optional[float] = None
    pickup_longitude: Optional[float] = None
    delivery_latitude: Optional[float] = None
    delivery_longitude: Optional[float] = None
    warehouse_id: Optional[str] = None
    origin_warehouse_id: Optional[str] = None
    origin_district: Optional[str] = None
    destination_district: Optional[str] = None
    sender_name: Optional[str] = None
    sender_phone: Optional[str] = None
    delivery_instructions: Optional[str] = None
    payment_method: str = "cod"
    total_amount: float = 0
    total_weight_kg: float = 0
    notes: Optional[str] = None

    model_config = {"extra": "ignore"}


class ApprovalUpdate(BaseModel):
    approval_status: str  # approved | rejected
    note: Optional[str] = None

    model_config = {"extra": "ignore"}


class IntakePayload(BaseModel):
    """Warehouse Admin records the physical, verified parcel details."""

    weight_kg: float = 0
    parcel_type: str = "package"
    quantity: int = 1
    length_cm: Optional[float] = None
    width_cm: Optional[float] = None
    height_cm: Optional[float] = None
    handling_requirements: Optional[str] = None
    sender_name: Optional[str] = None
    sender_phone: Optional[str] = None
    recipient_name: Optional[str] = None
    recipient_phone: Optional[str] = None
    destination_address: Optional[str] = None
    destination_district: Optional[str] = None
    origin_district: Optional[str] = None
    origin_warehouse_id: Optional[str] = None
    dest_warehouse_id: Optional[str] = None
    declared_value: float = 0
    payment_method: str = "cod"
    payment_status: str = "unpaid"
    delivery_instructions: Optional[str] = None

    model_config = {"extra": "ignore"}


class DispatchPayload(BaseModel):
    """Route an intaken shipment: micro driver (last mile) or vehicle trip."""

    shipment_id: str
    mode: str  # last_mile | inter_warehouse
    driver_id: Optional[str] = None       # for last_mile
    trip_id: Optional[str] = None         # for inter_warehouse (existing trip)
    vehicle_id: Optional[str] = None      # for inter_warehouse (new/existing)
    origin_warehouse_id: Optional[str] = None
    dest_warehouse_id: Optional[str] = None
    cod_required: bool = False
    cod_amount: float = 0

    model_config = {"extra": "ignore"}


class PaymentUpdate(BaseModel):
    payment_status: Optional[str] = None
    payment_method: Optional[str] = None

    model_config = {"extra": "ignore"}


# --- 1) Create order (admin on behalf of customer, or vendor) -----------------
@router.post("/orders", status_code=201, dependencies=[_user])
def create_order(payload: OrderCreate, user: dict = _user):
    """Admin creates an approved order; a vendor creates a PENDING order that
    an admin must review before any warehouse work begins."""
    sb = get_supabase()
    role = role_of(user)
    is_vendor = role == "vendor"

    vendor_id = None
    if is_vendor:
        sub = (user or {}).get("sub")
        try:
            res = sb.table("users").select("vendor_id").eq("id", sub).limit(1).execute()
            vendor_id = res.data[0].get("vendor_id") if res.data else None
        except Exception:
            vendor_id = None
        if not vendor_id:
            raise HTTPException(status_code=403, detail="vendor account not linked")
    elif role not in (
        "super_admin", "warehouse_admin", "admin", "dispatcher",
        "warehouse", "service_role", "dev-bypass",
    ):
        raise HTTPException(status_code=403, detail="staff or vendor only")

    # Vendor orders wait for approval; staff orders are approved immediately.
    approval = "pending" if is_vendor else "approved"
    now = _now()
    row = {
        "order_number": _next_order_number(sb),
        "status": "received",
        "approval_status": approval,
        "created_by_role": "vendor" if is_vendor else "admin",
        "vendor_id": vendor_id,
        "delivery_address": payload.delivery_address,
        "recipient_name": payload.recipient_name,
        "recipient_phone": payload.recipient_phone,
        "pickup_address": payload.pickup_address,
        "pickup_latitude": payload.pickup_latitude,
        "pickup_longitude": payload.pickup_longitude,
        "delivery_latitude": payload.delivery_latitude,
        "delivery_longitude": payload.delivery_longitude,
        "warehouse_id": payload.warehouse_id,
        "origin_warehouse_id": payload.origin_warehouse_id or payload.warehouse_id,
        "origin_district": payload.origin_district,
        "destination_district": payload.destination_district,
        "sender_name": payload.sender_name,
        "sender_phone": payload.sender_phone,
        "delivery_instructions": payload.delivery_instructions,
        "payment_method": payload.payment_method,
        "payment_status": "unpaid",
        "total_amount": payload.total_amount,
        "total_weight_kg": payload.total_weight_kg,
        "notes": payload.notes,
    }
    if not is_vendor:
        row["approved_at"] = now
    res = sb.table("orders").insert(row).execute()
    if not res.data:
        raise HTTPException(status_code=400, detail="order not created")
    order = res.data[0]
    workflow.log_order_event(
        sb, order["id"],
        "created" + (" (pending approval)" if is_vendor else " (auto-approved)"),
        actor_id=(user or {}).get("sub"), actor_role=role,
        note=payload.notes,
    )
    return order


def _next_order_number(sb) -> str:
    import random
    year = datetime.now(timezone.utc).year
    for _ in range(20):
        cand = f"BLA-{year}-{random.randint(0, 9999):04d}"
        if not sb.table("orders").select("id").eq("order_number", cand).limit(1).execute().data:
            return cand
    raise HTTPException(status_code=400, detail="could not allocate order number")


# --- 2) Approval (super admin / admin) ---------------------------------------
@router.patch("/orders/{order_id}/approval", dependencies=[_user])
def set_approval(order_id: str, payload: ApprovalUpdate, user: dict = _user):
    sb = get_supabase()
    role = role_of(user)
    if role not in ("super_admin", "admin", "service_role", "dev-bypass"):
        raise HTTPException(status_code=403, detail="admin approval required")
    if payload.approval_status not in ("approved", "rejected"):
        raise HTTPException(status_code=400, detail="approval_status must be approved or rejected")
    res = sb.table("orders").select("*").eq("id", order_id).limit(1).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="order not found")
    update = {
        "approval_status": payload.approval_status,
        "approval_note": payload.note,
    }
    if payload.approval_status == "approved":
        update["approved_by"] = (user or {}).get("sub")
        update["approved_at"] = _now()
    sb.table("orders").update(update).eq("id", order_id).execute()
    workflow.log_order_event(
        sb, order_id, f"approval:{payload.approval_status}",
        actor_id=(user or {}).get("sub"), actor_role=role, note=payload.note,
    )
    return sb.table("orders").select("*").eq("id", order_id).limit(1).execute().data[0]


# --- 3) Warehouse intake (verified shipment + routing decision) ---------------
@router.post("/orders/{order_id}/intake", dependencies=[_user])
def intake_order(order_id: str, payload: IntakePayload, user: dict = _user):
    """Warehouse Admin receives the physical parcel, records verified details,
    and computes the last-mile vs inter-warehouse route. Creates/updates the
    shipment and links it back to the order."""
    sb = get_supabase()
    role = role_of(user)
    if role not in ("super_admin", "admin", "warehouse_admin", "dispatcher", "service_role", "dev-bypass"):
        raise HTTPException(status_code=403, detail="warehouse admin required")

    res = sb.table("orders").select("*").eq("id", order_id).limit(1).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="order not found")
    order = res.data[0]
    if order.get("approval_status") != "approved":
        raise HTTPException(status_code=400, detail="order must be approved before intake")

    origin_wh = payload.origin_warehouse_id or order.get("origin_warehouse_id") or order.get("warehouse_id")
    dest_wh = payload.dest_warehouse_id
    origin_district = payload.origin_district or order.get("origin_district")
    dest_district = payload.destination_district or order.get("destination_district")
    route_kind = workflow.decide_route(origin_district, dest_district)

    # Auto-pick a destination warehouse matching the district/city when not given.
    if not dest_wh:
        dest_wh = _match_destination_warehouse(sb, dest_district)

    ship_row = {
        "order_id": order_id,
        "vendor_id": order.get("vendor_id"),
        "origin_warehouse_id": origin_wh,
        "current_warehouse_id": origin_wh,
        "dest_warehouse_id": dest_wh,
        "recipient_name": payload.recipient_name or order.get("recipient_name"),
        "recipient_phone": payload.recipient_phone or order.get("recipient_phone"),
        "sender_name": payload.sender_name or order.get("sender_name"),
        "sender_phone": payload.sender_phone or order.get("sender_phone"),
        "destination_address": payload.destination_address or order.get("delivery_address"),
        "destination_latitude": order.get("delivery_latitude"),
        "destination_longitude": order.get("delivery_longitude"),
        "origin_district": origin_district,
        "destination_district": dest_district,
        "delivery_instructions": payload.delivery_instructions or order.get("delivery_instructions"),
        "weight_kg": payload.weight_kg,
        "declared_value": payload.declared_value,
        "parcel_type": payload.parcel_type,
        "quantity": payload.quantity,
        "length_cm": payload.length_cm,
        "width_cm": payload.width_cm,
        "height_cm": payload.height_cm,
        "handling_requirements": payload.handling_requirements,
        "payment_method": payload.payment_method,
        "payment_status": payload.payment_status,
        "route_kind": route_kind,
        "parcel_status": "registered",
        "verified_by": (user or {}).get("sub"),
        "verified_at": _now(),
    }

    existing = sb.table("shipments").select("*").eq("order_id", order_id).limit(1).execute()
    if existing.data:
        shipment_id = existing.data[0]["id"]
        ship_row.pop("tracking_code", None)
        sb.table("shipments").update(ship_row).eq("id", shipment_id).execute()
        shipment = sb.table("shipments").select("*").eq("id", shipment_id).limit(1).execute().data[0]
    else:
        ship_row["tracking_code"] = shipment_service.generate_unique_tracking_code(sb)
        ins = sb.table("shipments").insert(ship_row).execute()
        if not ins.data:
            raise HTTPException(status_code=400, detail="shipment not created")
        shipment = ins.data[0]
        shipment_id = shipment["id"]

    # Persist intake onto the order + link shipment.
    sb.table("orders").update({
        "shipment_id": shipment_id,
        "origin_warehouse_id": origin_wh,
        "origin_district": origin_district,
        "destination_district": dest_district,
        "payment_method": payload.payment_method,
        "total_weight_kg": payload.weight_kg,
        "warehouse_id": origin_wh,
    }).eq("id", order_id).execute()

    shipment_service.log_event(
        sb, shipment_id, "intake:verified",
        actor_id=(user or {}).get("sub"), actor_role=role,
        note=f"route={route_kind}; {workflow.route_reason(origin_district, dest_district)}",
    )
    workflow.log_order_event(
        sb, order_id, "warehouse_intake",
        actor_id=(user or {}).get("sub"), actor_role=role,
        note=f"route={route_kind}",
    )
    return {
        "order_id": order_id,
        "shipment": shipment,
        "route_kind": route_kind,
        "route_reason": workflow.route_reason(origin_district, dest_district),
        "dest_warehouse_id": dest_wh,
    }


def _match_destination_warehouse(sb, dest_district: Optional[str]) -> Optional[str]:
    if not dest_district:
        return None
    try:
        rows = sb.table("warehouses").select("id, city, name").limit(50).execute().data or []
    except Exception:
        return None
    d = dest_district.strip().lower()
    for w in rows:
        if (w.get("city") or "").strip().lower() == d:
            return w["id"]
    return None


# --- 4) Dispatch: micro driver (last mile) or vehicle trip (inter-warehouse) ---
@router.post("/dispatch", status_code=201, dependencies=[_user])
def dispatch(payload: DispatchPayload, user: dict = _user):
    sb = get_supabase()
    role = role_of(user)
    if role not in ("super_admin", "admin", "warehouse_admin", "dispatcher", "service_role", "dev-bypass"):
        raise HTTPException(status_code=403, detail="dispatch role required")

    ships = sb.table("shipments").select("*").eq("id", payload.shipment_id).limit(1).execute()
    if not ships.data:
        raise HTTPException(status_code=404, detail="shipment not found")
    shipment = ships.data[0]
    order_id = shipment.get("order_id")

    if payload.mode == "last_mile":
        if not payload.driver_id:
            raise HTTPException(status_code=400, detail="driver_id required for last_mile")
        task = (
            sb.table("driver_tasks")
            .insert({
                "shipment_id": payload.shipment_id,
                "driver_id": payload.driver_id,
                "task_type": "delivery",
                "status": "pending",
                "cod_required": payload.cod_required or (shipment.get("payment_method") == "cod"),
                "cod_amount": payload.cod_amount or (shipment.get("declared_value") or 0),
                "payment_method": shipment.get("payment_method"),
                "delivery_instructions": shipment.get("delivery_instructions"),
            })
            .execute()
        )
        if not task.data:
            raise HTTPException(status_code=400, detail="task not created")
        sb.table("shipments").update({"parcel_status": "out_for_delivery"}).eq("id", payload.shipment_id).execute()
        shipment_service.log_event(
            sb, payload.shipment_id, "dispatch:last_mile",
            actor_id=(user or {}).get("sub"), actor_role=role,
            note=f"driver={payload.driver_id}",
        )
        workflow.log_order_event(
            sb, order_id, "dispatch:last_mile",
            actor_id=(user or {}).get("sub"), actor_role=role,
            note=f"micro driver assigned",
        ) if order_id else None
        return {"mode": "last_mile", "task": task.data[0]}

    elif payload.mode == "inter_warehouse":
        trip_id = payload.trip_id
        if not trip_id:
            # Create the trip (vehicle journey origin -> destination warehouse).
            if not payload.vehicle_id or not payload.origin_warehouse_id or not payload.dest_warehouse_id:
                raise HTTPException(
                    status_code=400,
                    detail="vehicle_id, origin_warehouse_id, dest_warehouse_id required to open a trip",
                )
            trip = sb.table("trips").insert({
                "big_driver_id": _big_driver_for_vehicle(sb, payload.vehicle_id),
                "vehicle_id": payload.vehicle_id,
                "origin_warehouse_id": payload.origin_warehouse_id,
                "dest_warehouse_id": payload.dest_warehouse_id,
                "status": "loading",
            }).execute()
            if not trip.data:
                raise HTTPException(status_code=400, detail="trip not created")
            trip_id = trip.data[0]["id"]

        # Put the shipment on the trip manifest + create a transfer leg.
        sb.table("trip_manifests").insert({
            "trip_id": trip_id, "shipment_id": payload.shipment_id, "loaded": False,
        }).execute()
        trip_row = sb.table("trips").select("*").eq("id", trip_id).limit(1).execute().data[0]
        sb.table("warehouse_transfers").insert({
            "shipment_id": payload.shipment_id,
            "from_warehouse_id": shipment.get("origin_warehouse_id"),
            "to_warehouse_id": payload.dest_warehouse_id or shipment.get("dest_warehouse_id"),
            "status": "dispatched",
            "trip_id": trip_id,
            "vehicle_id": payload.vehicle_id or trip_row.get("vehicle_id"),
        }).execute()
        sb.table("shipments").update({
            "parcel_status": "in_transit",
            "current_warehouse_id": shipment.get("origin_warehouse_id"),
        }).eq("id", payload.shipment_id).execute()
        shipment_service.log_event(
            sb, payload.shipment_id, "dispatch:inter_warehouse",
            actor_id=(user or {}).get("sub"), actor_role=role,
            note=f"trip={trip_id}",
        )
        if order_id:
            workflow.log_order_event(
                sb, order_id, "dispatch:inter_warehouse",
                actor_id=(user or {}).get("sub"), actor_role=role,
                note=f"trip={trip_id}",
            )
        return {"mode": "inter_warehouse", "trip_id": trip_id}

    raise HTTPException(status_code=400, detail="mode must be last_mile or inter_warehouse")


# --- 5) Payment (INDEPENDENT of delivery status) ------------------------------
@router.patch("/orders/{order_id}/payment", dependencies=[_user])
def update_payment(order_id: str, payload: PaymentUpdate, user: dict = _user):
    """Record payment status/method without touching delivery status, so a
    parcel can be Delivered while COD collection/settlement is still Pending."""
    sb = get_supabase()
    role = role_of(user)
    if role not in ("super_admin", "admin", "warehouse_admin", "dispatcher", "service_role", "dev-bypass"):
        raise HTTPException(status_code=403, detail="dispatch/warehouse role required")
    res = sb.table("orders").select("*").eq("id", order_id).limit(1).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="order not found")

    update: dict = {}
    if payload.payment_status is not None:
        if payload.payment_status not in ("unpaid", "pending", "paid", "refunded"):
            raise HTTPException(status_code=400, detail="invalid payment_status")
        update["payment_status"] = payload.payment_status
    if payload.payment_method is not None:
        if payload.payment_method not in ("cod", "online", "advance"):
            raise HTTPException(status_code=400, detail="invalid payment_method")
        update["payment_method"] = payload.payment_method
    if not update:
        raise HTTPException(status_code=400, detail="nothing to update")
    update["updated_at"] = _now()
    sb.table("orders").update(update).eq("id", order_id).execute()

    # Mirror onto the shipment so driver + warehouse views stay consistent.
    order = res.data[0]
    if order.get("shipment_id"):
        ship_update = {k: v for k, v in update.items() if k in ("payment_status", "payment_method")}
        if ship_update:
            sb.table("shipments").update(ship_update).eq("id", order["shipment_id"]).execute()

    workflow.log_order_event(
        sb, order_id, "payment:" + (payload.payment_status or payload.payment_method or ""),
        actor_id=(user or {}).get("sub"), actor_role=role,
    )
    return sb.table("orders").select("*").eq("id", order_id).limit(1).execute().data[0]


# --- 6) Order detail (per-order map + timeline) -------------------------------
@router.get("/orders/{order_id}/detail", dependencies=[_user])
def order_detail(order_id: str):
    detail = workflow.get_order_detail(order_id)
    if not detail:
        raise HTTPException(status_code=404, detail="order not found")
    return detail


# --- 7) Pending-approval queue (admin review) ---------------------------------
@router.get("/orders/pending", dependencies=[_user])
def pending_orders(limit: int = Query(default=100, le=500)):
    sb = get_supabase()
    try:
        res = (
            sb.table("orders")
            .select("*")
            .eq("approval_status", "pending")
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return res.data or []
    except Exception:
        # Pre-migration fallback: approval column not provisioned yet.
        return []



def _big_driver_for_vehicle(sb, vehicle_id: str) -> str:
    """Pick the big driver linked to this vehicle (falls back to any big driver)."""
    try:
        rows = sb.table("drivers").select("id").eq("vehicle_id", vehicle_id).eq("driver_type", "big").limit(1).execute().data
        if rows:
            return rows[0]["id"]
        any_big = sb.table("drivers").select("id").eq("driver_type", "big").limit(1).execute().data
        if any_big:
            return any_big[0]["id"]
    except Exception:
        pass
    raise HTTPException(status_code=400, detail="no big driver available for this vehicle")



