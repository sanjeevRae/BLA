"""Pydantic request/response schemas for orders."""
from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field

from app.schemas.common import OrderStatus


class OrderItemCreate(BaseModel):
    sku: Optional[str] = None
    description: str
    quantity: int = Field(default=1, gt=0)
    unit_price: float = 0
    weight_kg: float = 0


class OrderCreate(BaseModel):
    customer_id: Optional[UUID] = None
    warehouse_id: Optional[UUID] = None
    pickup_address: Optional[str] = None
    pickup_latitude: Optional[float] = None
    pickup_longitude: Optional[float] = None
    delivery_address: str
    delivery_latitude: Optional[float] = None
    delivery_longitude: Optional[float] = None
    recipient_name: Optional[str] = None
    recipient_phone: Optional[str] = None
    notes: Optional[str] = None
    scheduled_at: Optional[datetime] = None
    items: list[OrderItemCreate] = Field(default_factory=list)


class OrderUpdate(BaseModel):
    customer_id: Optional[UUID] = None
    warehouse_id: Optional[UUID] = None
    pickup_address: Optional[str] = None
    pickup_latitude: Optional[float] = None
    pickup_longitude: Optional[float] = None
    delivery_address: str
    delivery_latitude: Optional[float] = None
    delivery_longitude: Optional[float] = None
    recipient_name: Optional[str] = None
    recipient_phone: Optional[str] = None
    notes: Optional[str] = None
    scheduled_at: Optional[datetime] = None
    status: OrderStatus = OrderStatus.received
    items: list[OrderItemCreate] = Field(default_factory=list)


class OrderStatusUpdate(BaseModel):
    status: OrderStatus
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    note: Optional[str] = None


class OrderOut(BaseModel):
    id: UUID
    order_number: str
    status: OrderStatus
    customer_id: Optional[UUID] = None
    warehouse_id: Optional[UUID] = None
    delivery_address: str
    delivery_latitude: Optional[float] = None
    delivery_longitude: Optional[float] = None
    recipient_name: Optional[str] = None
    recipient_phone: Optional[str] = None
    total_weight_kg: float = 0
    total_amount: float = 0
    notes: Optional[str] = None
    created_at: Optional[datetime] = None

    model_config = {"extra": "ignore"}
