"""Driver-facing endpoints: fetch assignments, update status, push GPS, upload POD.

In production these are protected by Supabase Auth JWTs; the driver app sends
its bearer token and a gateway/dependency verifies it. For brevity the auth
dependency is left as a clearly-marked TODO so the routes stay runnable in dev.
"""
from uuid import UUID

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.schemas.assignments import (
    AssignmentOut,
    AssignmentStatusUpdate,
    GpsPing,
)
from app.services import orders as order_service
from app.services import realtime, storage
from app.core.supabase_client import get_supabase

router = APIRouter(prefix="/drivers", tags=["drivers"])


@router.get("")
def list_drivers(available_only: bool = False):
    """Dispatch dashboard fetches assignable drivers here."""
    return order_service.list_drivers(available_only=available_only)


@router.get("/{driver_id}/assignments", response_model=list[AssignmentOut])
def get_assignments(driver_id: UUID, active_only: bool = True):
    """Driver app polls / loads its current assignments here."""
    return order_service.driver_assignments(str(driver_id), active_only=active_only)


@router.patch("/assignments/{assignment_id}/status", response_model=AssignmentOut)
def update_assignment_status(assignment_id: UUID, payload: AssignmentStatusUpdate):
    assignment = order_service.update_assignment_status(
        str(assignment_id), payload.status.value
    )
    if not assignment:
        raise HTTPException(status_code=404, detail="assignment not found")
    return assignment


@router.post("/gps", status_code=201)
def push_gps(ping: GpsPing):
    """Drivers POST a GPS ping (every ~5s).

    The row is inserted into ``gps_tracking`` and Supabase Realtime broadcasts
    it to the admin dashboard and the customer tracking page. We also update the
    driver's denormalised last-known location.

    NOTE: Drivers can also write directly to Supabase Realtime from the client
    using the anon key (RLS restricts inserts to their own driver_id). This
    endpoint exists for clients that prefer going through the backend.
    """
    row = {
        "driver_id": str(ping.driver_id),
        "assignment_id": str(ping.assignment_id) if ping.assignment_id else None,
        "order_id": str(ping.order_id) if ping.order_id else None,
        "latitude": ping.latitude,
        "longitude": ping.longitude,
        "speed_kmh": ping.speed_kmh,
        "heading": ping.heading,
        "accuracy_m": ping.accuracy_m,
    }
    saved = realtime.record_gps_ping(row)
    realtime.update_driver_location(str(ping.driver_id), ping.latitude, ping.longitude)
    return {"id": saved.get("id"), "ok": True}


@router.post("/pod", status_code=201)
async def upload_proof_of_delivery(
    package_id: UUID = Form(...),
    signed_by: str = Form(""),
    photo: UploadFile = File(...),
):
    """Upload a proof-of-delivery photo to Cloudinary and attach to the package."""
    contents = await photo.read()
    url = storage.upload_pod_photo(contents, public_id=f"pod-{package_id}")
    if not url:
        raise HTTPException(status_code=503, detail="Cloudinary not configured")

    sb = get_supabase()
    res = (
        sb.table("packages")
        .update(
            {
                "pod_photo_url": url,
                "pod_signed_by": signed_by or None,
                "pod_signed_at": "now()",
            }
        )
        .eq("id", str(package_id))
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="package not found")
    return {"package_id": str(package_id), "pod_photo_url": url}
