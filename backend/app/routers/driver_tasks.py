"""Driver-task endpoints for micro drivers.

Independent task status track (pending -> accepted -> picked_up ->
out_for_delivery -> delivered / delivery_failed / returned).
"""
from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.auth import require_staff, require_user, role_of
from app.core.supabase_client import get_supabase
from app.services import shipments as shipment_service

router = APIRouter(prefix="/driver-tasks", tags=["driver-tasks"])

_staff = Depends(require_staff)
_user = Depends(require_user)


def _caller_driver_id(user: dict | None) -> str | None:
    """Map the JWT caller to their driver row (None for staff/dev-bypass)."""
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
def create_task(
    shipment_id: str = Query(...),
    driver_id: str = Query(...),
    task_type: str = Query(...),
    cod_required: bool = Query(default=False),
    cod_amount: float = Query(default=0),
):
    """Assign a task to a micro driver (staff only)."""
    if task_type not in ("pickup", "delivery"):
        raise HTTPException(status_code=400, detail="task_type must be pickup/delivery")
    sb = get_supabase()
    res = (
        sb.table("driver_tasks")
        .insert(
            {
                "shipment_id": shipment_id,
                "driver_id": driver_id,
                "task_type": task_type,
                "cod_required": cod_required,
                "cod_amount": cod_amount,
            }
        )
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=400, detail="task not created")
    shipment_service.log_event(sb, shipment_id, "task:assigned", actor_role="staff")
    return res.data[0]


@router.get("", dependencies=[_user])
def list_tasks(
    driver_id: str | None = Query(default=None),
    active_only: bool = Query(default=True),
    user: dict = _user,
):
    """Staff sees everything; a driver sees only their own tasks."""
    sb = get_supabase()
    own = _caller_driver_id(user)
    effective = driver_id or own if own else driver_id
    query = (
        sb.table("driver_tasks")
        .select(
            "*, shipments("
            "tracking_code, parcel_status, recipient_name, recipient_phone, "
            "destination_address, destination_latitude, destination_longitude, "
            "delivery_instructions, payment_method, payment_status, "
            "quantity, parcel_type, declared_value)"
        )
        .order("created_at", desc=True)
    )
    if effective:
        query = query.eq("driver_id", effective)
    if active_only:
        query = query.not_.in_("status", ("delivered", "returned"))
    return query.execute().data or []


def _ship_pay_of(sb, shipment_id: str | None) -> dict | None:
    """Fetch the shipment's payment defaults (best-effort, no 404)."""
    if not shipment_id:
        return None
    try:
        res = (
            sb.table("shipments")
            .select("payment_method, declared_value, cod_required")
            .eq("id", shipment_id)
            .limit(1)
            .execute()
        )
        return res.data[0] if res.data else None
    except Exception:
        return None


@router.patch("/{task_id}/status", dependencies=[_user])
def update_task_status(
    task_id: str,
    status: str = Query(...),
    cod_collected: float = Query(default=0),
    payment_method: str | None = Query(default=None),
    payment_amount: float = Query(default=0),
    payment_collected: bool = Query(default=False),
    proof_note: str | None = Query(default=None),
    attempt_note: str | None = Query(default=None),
    user: dict = _user,
):
    sb = get_supabase()
    res = sb.table("driver_tasks").select("*").eq("id", task_id).limit(1).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="task not found")
    task = res.data[0]

    own = _caller_driver_id(user)
    role = role_of(user)
    if own and str(task.get("driver_id")) != str(own) and role != "dev-bypass":
        raise HTTPException(status_code=403, detail="not your task")

    if not shipment_service.validate_task_transition(task.get("status"), status):
        raise HTTPException(
            status_code=400,
            detail=f"cannot move task {task.get('status')} -> {status}",
        )

    from datetime import datetime, timezone

    # Normalize legacy pair (cod_collected) into the payment fields.
    if payment_method is None:
        shipment_for_pay = _ship_pay_of(sb, task.get("shipment_id")) or task
        payment_method = shipment_for_pay.get("payment_method") or "cod"
    if payment_collected is False and payment_amount == 0 and cod_collected:
        payment_collected = True
        payment_amount = float(cod_collected)

    update = {"status": status}
    now = datetime.now(timezone.utc).isoformat()
    if status in ("delivered", "returned"):
        update["completed_at"] = now
    if status == "delivered" and payment_amount:
        update["cod_collected"] = payment_amount
    # Delivery attempts: every delivery_failed records an attempt.
    if status == "delivery_failed":
        update["failed_attempts"] = int(task.get("failed_attempts") or 0) + 1
        update["last_attempt_at"] = now
        if attempt_note is not None:
            update["delivery_instructions"] = attempt_note
    # Payment + proof are recorded on the task (task ≠ parcel delivery status).
    if payment_method is not None:
        if payment_method not in ("cod", "online", "advance"):
            raise HTTPException(status_code=400, detail="invalid payment_method")
        update["payment_method"] = payment_method
    if payment_amount:
        update["payment_amount"] = payment_amount
    if payment_collected:
        update["payment_collected"] = True
    if proof_note is not None:
        update["proof_note"] = proof_note
    updated = (
        sb.table("driver_tasks").update(update).eq("id", task_id).execute()
    )

    # Task progress drives the parcel track (task -> parcel linkage is one-way).
    parcel_map = {
        "picked_up": "picked_up",
        "out_for_delivery": "out_for_delivery",
        "delivered": "delivered",
        "delivery_failed": "delivery_failed",
        "returned": "returned",
    }
    if status in parcel_map:
        try:
            sb.table("shipments").update({"parcel_status": parcel_map[status]}).eq(
                "id", task.get("shipment_id")
            ).execute()
        except Exception:
            pass

    # COD audit row on payment at the door.
    if status == "delivered" and payment_amount and payment_method == "cod":
        try:
            sb.table("cod_collections").insert(
                {
                    "shipment_id": task.get("shipment_id"),
                    "driver_task_id": task_id,
                    "collected_by": task.get("driver_id"),
                    "amount": payment_amount,
                    "collected_at": now,
                }
            ).execute()
        except Exception:
            pass

    # Mirror payment collection onto the shipment payment record (delivery
    # status itself is already handled above / by parcel linkage).
    if payment_collected or (status == "delivered" and payment_amount):
        try:
            kind = "paid"
            sb.table("shipments").update({"payment_status": kind}).eq(
                "id", task.get("shipment_id")
            ).execute()
        except Exception:
            pass

    shipment_service.log_event(
        sb, task.get("shipment_id"), f"task:{status}",
        actor_id=(user or {}).get("sub"), actor_role=role,
    )
    return updated.data[0] if updated.data else task
