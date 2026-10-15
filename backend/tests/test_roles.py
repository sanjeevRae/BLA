"""Phase 1 role/permission tests (no database needed).

Covers the role catalog, role extraction from JWT claims, the dev-bypass
behaviour (REQUIRE_AUTH=false) and production enforcement.
"""
import pytest
from fastapi import HTTPException

from app.core import auth
from app.core.config import settings


def test_role_catalog_covers_platform_roles():
    ids = {r["id"] for r in auth.ROLE_CATALOG}
    assert {
        "super_admin",
        "warehouse_admin",
        "vendor",
        "micro_driver",
        "big_driver",
        "customer",
    } <= ids


def test_staff_roles_include_new_staff_roles():
    assert {"super_admin", "warehouse_admin"} <= auth.STAFF_ROLES
    assert "vendor" not in auth.STAFF_ROLES
    assert "micro_driver" not in auth.STAFF_ROLES


def test_role_of_metadata_precedence():
    assert (
        auth.role_of({"role": "customer", "user_metadata": {"role": "vendor"}}) == "vendor"
    )
    assert auth.role_of({"role": "super_admin"}) == "super_admin"
    assert auth.role_of(None) is None


def test_dev_bypass_allows_any_role(monkeypatch):
    monkeypatch.setattr(settings, "require_auth", False)
    assert auth.require_staff({"role": "customer"}) == {"role": "customer"}
    dep = auth.require_role("super_admin")
    assert dep({"role": "customer"}) == {"role": "customer"}
    assert auth.require_super_admin({"role": "customer"})


def test_role_guard_enforced_in_prod(monkeypatch):
    monkeypatch.setattr(settings, "require_auth", True)
    dep = auth.require_role("super_admin")
    with pytest.raises(HTTPException) as exc:
        dep({"user_metadata": {"role": "warehouse_admin"}})
    assert exc.value.status_code == 403
    assert dep({"user_metadata": {"role": "super_admin"}})


def test_require_staff_enforced_in_prod(monkeypatch):
    monkeypatch.setattr(settings, "require_auth", True)
    with pytest.raises(HTTPException):
        auth.require_staff({"user_metadata": {"role": "vendor"}})
    with pytest.raises(HTTPException):
        auth.require_staff({"user_metadata": {"role": "big_driver"}})
    assert auth.require_staff({"user_metadata": {"role": "warehouse_admin"}})
    assert auth.require_super_admin({"user_metadata": {"role": "super_admin"}})
