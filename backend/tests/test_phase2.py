"""Phase 2 status-track tests: tracking codes and transition tables (no DB)."""
import re

from app.services import shipments as svc


def test_tracking_code_format():
    code = svc.generate_tracking_code()
    assert re.fullmatch(r"BLA-PAR-\d{4}-\d{6}", code)


def test_task_transitions():
    assert svc.validate_task_transition("pending", "accepted")
    assert svc.validate_task_transition("accepted", "picked_up")
    assert svc.validate_task_transition("picked_up", "out_for_delivery")
    assert svc.validate_task_transition("out_for_delivery", "delivered")
    assert svc.validate_task_transition("out_for_delivery", "delivery_failed")
    assert svc.validate_task_transition("delivery_failed", "returned")
    assert svc.validate_task_transition("delivery_failed", "out_for_delivery")
    assert not svc.validate_task_transition("pending", "delivered")
    assert not svc.validate_task_transition("delivered", "out_for_delivery")
    assert not svc.validate_task_transition("returned", "accepted")
    assert not svc.validate_task_transition("", "pending")


def test_trip_transitions():
    assert svc.validate_trip_transition("assigned", "loading")
    assert svc.validate_trip_transition("loading", "departed")
    assert svc.validate_trip_transition("departed", "at_checkpoint")
    assert svc.validate_trip_transition("at_checkpoint", "at_checkpoint")
    assert svc.validate_trip_transition("at_checkpoint", "arrived_dest")
    assert svc.validate_trip_transition("arrived_dest", "unloading")
    assert svc.validate_trip_transition("unloading", "completed")
    assert not svc.validate_trip_transition("assigned", "completed")
    assert not svc.validate_trip_transition("completed", "departed")
    assert not svc.validate_trip_transition("cancelled", "assigned")


def test_parcel_terminal_set():
    assert svc.PARCEL_TERMINAL == frozenset({"delivered", "returned", "cancelled"})


def test_settlement_transitions():
    assert svc.validate_settlement_transition("pending", "collected")
    assert svc.validate_settlement_transition("collected", "reconciled")
    assert svc.validate_settlement_transition("reconciled", "deducted")
    assert svc.validate_settlement_transition("deducted", "settled")
    assert svc.validate_settlement_transition("pending", "disputed")
    assert svc.validate_settlement_transition("disputed", "reconciled")
    assert not svc.validate_settlement_transition("pending", "settled")
    assert not svc.validate_settlement_transition("settled", "disputed")
    assert not svc.validate_settlement_transition("", "collected")
