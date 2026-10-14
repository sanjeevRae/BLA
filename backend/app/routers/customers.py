"""Customer management endpoints for the admin dashboard."""

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.services import customers as customer_service

router = APIRouter(prefix="/customers", tags=["customers"])


class CustomerCreate(BaseModel):
    name: str
    phone: str
    email: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    postal_code: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    user_id: str | None = None

    model_config = {"extra": "ignore"}


class CustomerUpdate(BaseModel):
    name: str | None = None
    phone: str | None = None
    email: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    postal_code: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    user_id: str | None = None

    model_config = {"extra": "ignore"}


@router.get("")
def list_customers(
    q: str | None = Query(default=None, description="Search by name, email, phone, or city"),
    limit: int = Query(default=50, le=200),
):
    return customer_service.list_customers(search=q, limit=limit)


@router.post("", status_code=201)
def create_customer(payload: CustomerCreate):
    return customer_service.create_customer(payload.model_dump(exclude_none=True))


@router.put("/{customer_id}")
def update_customer(customer_id: str, payload: CustomerUpdate):
    customer = customer_service.update_customer(
        customer_id, payload.model_dump(exclude_none=True)
    )
    if not customer:
        raise HTTPException(status_code=404, detail="customer not found")
    return customer


@router.delete("/{customer_id}", status_code=204)
def delete_customer(customer_id: str):
    deleted = customer_service.delete_customer(customer_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="customer not found")
    return None
