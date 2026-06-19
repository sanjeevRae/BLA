"""Order management endpoints (dispatch / warehouse staff)."""
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query

from app.schemas.assignments import AssignmentCreate, AssignmentOut
from app.schemas.orders import OrderCreate, OrderOut, OrderStatusUpdate, OrderUpdate
from app.services import orders as order_service

router = APIRouter(prefix="/orders", tags=["orders"])


@router.post("", response_model=OrderOut, status_code=201)
async def create_order(payload: OrderCreate):
    return await order_service.create_order(payload)


@router.put("/{order_id}", response_model=OrderOut)
async def update_order(order_id: UUID, payload: OrderUpdate):
    order = await order_service.update_order(str(order_id), payload)
    if not order:
        raise HTTPException(status_code=404, detail="order not found")
    return order


@router.delete("/{order_id}", status_code=204)
def delete_order(order_id: UUID):
    deleted = order_service.delete_order(str(order_id))
    if not deleted:
        raise HTTPException(status_code=404, detail="order not found")
    return None


@router.get("", response_model=list[OrderOut])
def list_orders(
    status: Optional[str] = Query(default=None),
    limit: int = Query(default=100, le=500),
    offset: int = Query(default=0, ge=0),
):
    return order_service.list_orders(status=status, limit=limit, offset=offset)


@router.get("/{order_id}", response_model=OrderOut)
def get_order(order_id: UUID):
    order = order_service.get_order(str(order_id))
    if not order:
        raise HTTPException(status_code=404, detail="order not found")
    return order


@router.get("/{order_id}/assignment", response_model=AssignmentOut)
def get_order_assignment(order_id: UUID):
    assignment = order_service.get_order_assignment(str(order_id))
    if not assignment:
        raise HTTPException(status_code=404, detail="assignment not found")
    return assignment


@router.patch("/{order_id}/status", response_model=OrderOut)
async def update_status(order_id: UUID, payload: OrderStatusUpdate):
    order = await order_service.update_order_status(
        str(order_id),
        payload.status.value,
        lat=payload.latitude,
        lon=payload.longitude,
        note=payload.note,
    )
    if not order:
        raise HTTPException(status_code=404, detail="order not found")
    return order


@router.post("/{order_id}/assign", response_model=AssignmentOut, status_code=201)
async def assign_driver(order_id: UUID, payload: AssignmentCreate):
    if str(payload.order_id) != str(order_id):
        raise HTTPException(status_code=400, detail="order_id mismatch")
    try:
        return await order_service.assign_driver(
            str(order_id),
            str(payload.driver_id),
            str(payload.vehicle_id) if payload.vehicle_id else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
