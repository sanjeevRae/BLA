"""Shared enums and value objects used across schemas."""
from enum import Enum


class OrderStatus(str, Enum):
    received = "received"
    on_place = "on_place"
    went_for_delivery = "went_for_delivery"
    out_for_delivery = "out_for_delivery"
    delivered = "delivered"
    cancelled = "cancelled"
    failed = "failed"


class AssignmentStatus(str, Enum):
    pending = "pending"
    accepted = "accepted"
    in_progress = "in_progress"
    completed = "completed"
    cancelled = "cancelled"


class VehicleType(str, Enum):
    bike = "bike"
    car = "car"
    van = "van"
    truck = "truck"


# Customer-facing status progression, in order.
CUSTOMER_STATUS_FLOW: list[OrderStatus] = [
    OrderStatus.received,
    OrderStatus.on_place,
    OrderStatus.went_for_delivery,
    OrderStatus.out_for_delivery,
    OrderStatus.delivered,
]
