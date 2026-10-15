"""Shipment helpers: tracking codes, transition rules, audit events.

Pure functions (no DB) are covered by tests/test_phase2.py.
"""
from __future__ import annotations

import random
from datetime import datetime, timezone
from typing import Any, Optional

# --- Tracking codes -----------------------------------------------------------
def generate_tracking_code() -> str:
    """Random `BLA-PAR-YYYY-000001` candidate; backend enforces uniqueness."""
    year = datetime.now(timezone.utc).year
    suffix = random.randint(0, 999999)
    return f"BLA-PAR-{year}-{suffix:06d}"


def generate_unique_tracking_code(sb, *, attempts: int = 10) -> str:
    """A tracking_code not already present in the shipments table."""
    for _ in range(attempts):
        candidate = generate_tracking_code()
        existing = (
            sb.table("shipments").select("id").eq("tracking_code", candidate).limit(1).execute()
        )
        if not existing.data:
            return candidate
    raise RuntimeError("could not generate a unique tracking code")


# --- Independent transition rules ---------------------------------------------
TASK_TRANSITIONS: dict[str, frozenset[str]] = {
    "pending": frozenset({"accepted"}),
    "accepted": frozenset({"picked_up"}),
    "picked_up": frozenset({"out_for_delivery"}),
    "out_for_delivery": frozenset({"delivered", "delivery_failed"}),
    "delivery_failed": frozenset({"returned", "out_for_delivery"}),
    "returned": frozenset(),
    "delivered": frozenset(),
}

TRIP_TRANSITIONS: dict[str, frozenset[str]] = {
    "assigned": frozenset({"loading", "cancelled"}),
    "loading": frozenset({"departed", "cancelled"}),
    "departed": frozenset({"at_checkpoint", "arrived_dest", "cancelled"}),
    "at_checkpoint": frozenset({"at_checkpoint", "arrived_dest", "cancelled"}),
    "arrived_dest": frozenset({"unloading", "cancelled"}),
    "unloading": frozenset({"completed"}),
    "completed": frozenset(),
    "cancelled": frozenset(),
}

PARCEL_TERMINAL = frozenset({"delivered", "returned", "cancelled"})


def validate_task_transition(current: str, nxt: str) -> bool:
    return nxt in TASK_TRANSITIONS.get(current or "", frozenset())


def validate_trip_transition(current: str, nxt: str) -> bool:
    return nxt in TRIP_TRANSITIONS.get(current or "", frozenset())


# --- Audit trail ---------------------------------------------------------------
def log_event(
    sb,
    shipment_id: str,
    event: str,
    *,
    actor_id: str | None = None,
    actor_role: str | None = None,
    location: str | None = None,
    note: str | None = None,
) -> None:
    """Best-effort audit row; audit never blocks a status update."""
    try:
        sb.table("shipment_events").insert(
            {
                "shipment_id": shipment_id,
                "event": event,
                "actor_id": actor_id,
                "actor_role": actor_role,
                "location": location,
                "note": note,
            }
        ).execute()
    except Exception:
        pass

