"""Phase 3 workflow tests: district routing decisions (no DB)."""
from app.services import workflow as wf


def test_same_district_is_last_mile():
    assert wf.decide_route("Kathmandu", "Kathmandu") == "last_mile"
    assert wf.decide_route("Lalitpur", " lalitpur ") == "last_mile"


def test_different_district_is_inter_warehouse():
    assert wf.decide_route("Kathmandu", "Pokhara") == "inter_warehouse"
    assert wf.decide_route("Kathmandu", "Chitwan") == "inter_warehouse"


def test_missing_district_defaults_to_inter_warehouse():
    assert wf.decide_route(None, "Pokhara") == "inter_warehouse"
    assert wf.decide_route("Kathmandu", None) == "inter_warehouse"
    assert wf.decide_route(None, None) == "inter_warehouse"


def test_route_reason_mentions_districts():
    assert "Same district" in wf.route_reason("Kathmandu", "Kathmandu")
    assert "Kathmandu" in wf.route_reason("Kathmandu", "Pokhara")
    assert "Pokhara" in wf.route_reason("Kathmandu", "Pokhara")


def test_stage_label_pending_and_intake():
    assert wf._stage_label({"approval_status": "pending"}, None, None, None) == "Awaiting admin approval"
    assert wf._stage_label({"approval_status": "rejected"}, None, None, None) == "Rejected by admin"
    assert "intake" in wf._stage_label(
        {"approval_status": "approved"}, None, None, None
    ).lower()


def test_stage_label_progression():
    order = {"approval_status": "approved"}
    assert wf._stage_label(order, {"parcel_status": "at_origin_hub"}, None, None) == "At origin warehouse"
    assert "transit" in wf._stage_label(order, {"parcel_status": "in_transit"}, None, None).lower()
    assert wf._stage_label(order, {"parcel_status": "out_for_delivery"}, None, None) == "Out for last-mile delivery"
    assert wf._stage_label(order, {"parcel_status": "delivered"}, None, None) == "Delivered"
