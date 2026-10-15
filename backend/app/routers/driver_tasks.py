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
        .select("*, shipments(tracking_code, parcel_status, recipient_name, destination_address)")
        .order("created_at", desc=True)
    )
    if effective:
        query = query.eq("driver_id", effective)
    if active_only:
        query = query.not_.in_("status", ("delivered", "returned"))
    return query.execute().data or []


@router.patch("/{task_id}/status", dependencies=[_user])
def update_task_status(
    task_id: str,
    status: str = Query(...),
    cod_collected: float = Query(default=0),
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

    update = {"status": status}
    if status in ("delivered", "returned"):
        update["completed_at"] = datetime.now(timezone.utc).isoformat()
    if status == "delivered" and cod_collected:
        update["cod_collected"] = cod_collected
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
    if status == "delivered" and cod_collected:
        try:
            sb.table("cod_collections").insert(
                {
                    "shipment_id": task.get("shipment_id"),
                    "driver_task_id": task_id,
                    "collected_by": task.get("driver_id"),
                    "amount": cod_collected,
                    "collected_at": datetime.now(timezone.utc).isoformat(),
                }
            ).execute()
        except Exception:
            pass

    shipment_service.log_event(
        sb, task.get("shipment_id"), f"task:{status}",
        actor_id=(user or {}).get("sub"), actor_role=role,
    )
    return updated.data[0] if updated.data else task
