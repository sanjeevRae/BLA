"""Schemas for driver assignments and GPS tracking."""
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, Field

from app.schemas.common import AssignmentStatus


class AssignmentCreate(BaseModel):
    order_id: UUID
    driver_id: UUID
    vehicle_id: Optional[UUID] = None


class AssignmentStatusUpdate(BaseModel):
    status: AssignmentStatus


class AssignmentOut(BaseModel):
    id: UUID
    order_id: UUID
    driver_id: UUID
    vehicle_id: Optional[UUID] = None
    status: AssignmentStatus
    route_distance_m: Optional[float] = None
    route_duration_s: Optional[float] = None
    route_geometry: Optional[Any] = None
    assigned_at: Optional[datetime] = None

    model_config = {"extra": "ignore"}


class GpsPing(BaseModel):
    driver_id: UUID
    assignment_id: Optional[UUID] = None
    order_id: Optional[UUID] = None
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    speed_kmh: Optional[float] = None
    heading: Optional[float] = None
    accuracy_m: Optional[float] = None
