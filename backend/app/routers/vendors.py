"""Vendor management endpoints.

Reads: any staff role (warehouse admins need vendor names for registration).
Writes: super-admin tier only (vendors = business accounts, per spec the
super admin owns vendors / settlements / settings).
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core.auth import require_staff, require_super_admin
from app.core.supabase_client import get_supabase

router = APIRouter(prefix="/vendors", tags=["vendors"])

_staff = Depends(require_staff)
_super = Depends(require_super_admin)

_ALLOWED_FIELDS = {
    "name",
    "contact_name",
    "email",
    "phone",
    "address",
    "city",
    "state",
    "postal_code",
    "country",
    "is_active",
}


class VendorCreate(BaseModel):
    name: str
    contact_name: str | None = None
    email: str | None = None
    phone: str | None = None
    address: str | None = None
    city: str | None = None
    state: str | None = None
    postal_code: str | None = None
    country: str | None = "IN"
    is_active: bool = True

    model_config = {"extra": "ignore"}


class VendorUpdate(BaseModel):
    name: str | None = None
    contact_name: str | None = None
    email: str | None = None
    phone: str | None = None
    address: str | None = None
    city: str | None = None
    state: str | None = None
    postal_code: str | None = None
    country: str | None = None
    is_active: bool | None = None

    model_config = {"extra": "ignore"}


def _clean(payload: dict) -> dict:
    return {k: v for k, v in (payload or {}).items() if k in _ALLOWED_FIELDS}


@router.get("", dependencies=[_staff])
def list_vendors(q: str | None = Query(default=None), limit: int = Query(default=200, le=500)):
    sb = get_supabase()
    query = sb.table("vendors").select("*").order("name").limit(limit)
    if q and q.strip():
        term = q.strip()
        query = query.or_(f"name.ilike.%{term}%,city.ilike.%{term}%,email.ilike.%{term}%")
    res = query.execute()
    return res.data or []


@router.get("/{vendor_id}", dependencies=[_staff])
def get_vendor(vendor_id: str):
    sb = get_supabase()
    res = sb.table("vendors").select("*").eq("id", vendor_id).limit(1).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="vendor not found")
    return res.data[0]


@router.post("", status_code=201, dependencies=[_super])
def create_vendor(payload: VendorCreate):
    sb = get_supabase()
    res = sb.table("vendors").insert(_clean(payload.model_dump())).execute()
    if not res.data:
        raise HTTPException(status_code=400, detail="vendor not created")
    return res.data[0]


@router.put("/{vendor_id}", dependencies=[_super])
def update_vendor(vendor_id: str, payload: VendorUpdate):
    sb = get_supabase()
    res = (
        sb.table("vendors")
        .update(_clean(payload.model_dump(exclude_none=True)))
        .eq("id", vendor_id)
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="vendor not found")
    return res.data[0]
