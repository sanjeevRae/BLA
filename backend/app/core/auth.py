"""Supabase JWT auth dependency (optional in dev, required in prod).

Usage:
    from app.core.auth import require_staff, require_role
    @router.post("", dependencies=[Depends(require_staff)])
    @router.post("", dependencies=[Depends(require_role("super_admin"))])

Role catalog (BLA Logistics v2):
    super_admin      full system control (vendors, staff, COD, settings)
    warehouse_admin  parcel registration / scanning / transfers / handovers
    admin, dispatcher, warehouse  legacy staff aliases (still valid)
    vendor           business vendor staff (own shipments + COD only)
    micro_driver     last-mile rider (task updates only, no live map)
    big_driver       inter-warehouse driver (trips, shown on admin map)
    customer         end customer (tracking page; no dashboard)

SECURITY MODEL (no hardcoded credentials, no backdoors):
    * Passwords are verified ONLY by Supabase Auth. This backend never
      sees, stores, or compares passwords.
    * The authoritative role is the ``public.users.role`` column (mirrors
      auth.users 1:1 by id). JWT ``user_metadata.role`` is client-editable
      and therefore UNTRUSTED — display hint only, never an access decision
      when the database is reachable.
    * ``REQUIRE_AUTH=false`` is local-dev only. Production sets
      ``REQUIRE_AUTH=true`` + ``SUPABASE_JWT_SECRET``.
    * No bypass token, no master password, no hard-coded user exists.
"""
from __future__ import annotations

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import settings

_bearer = HTTPBearer(auto_error=False)

# Roles allowed on staff-facing write routes.
STAFF_ROLES = frozenset(
    {
        "super_admin",
        "warehouse_admin",
        "admin",
        "dispatcher",
        "warehouse",
        "service_role",
    }
)

# Staff + vendors: read routes a Business Vendor may reach for its OWN data
# (parcels, settlements) — handlers must scope rows to current_vendor_id().
STAFF_OR_VENDOR_ROLES = STAFF_ROLES | frozenset({"vendor"})

# Roles allowed to manage vendors / system settings (super-admin tier).
SUPER_ROLES = frozenset({"super_admin", "admin", "service_role"})

# Driver roles (JWT-authenticated riders).
DRIVER_ROLES = frozenset({"driver", "micro_driver", "big_driver", "service_role"})

# Canonical role catalog — surfaced to the UI by GET /ops/profile.
ROLE_CATALOG = [
    {"id": "super_admin", "label": "Super Admin", "scope": "system"},
    {"id": "warehouse_admin", "label": "Warehouse Admin", "scope": "warehouse"},
    {"id": "vendor", "label": "Business Vendor", "scope": "vendor"},
    {"id": "micro_driver", "label": "Micro Driver", "scope": "driver"},
    {"id": "big_driver", "label": "Big Driver", "scope": "driver"},
    {"id": "customer", "label": "Customer", "scope": "customer"},
    {"id": "dispatcher", "label": "Dispatcher", "scope": "staff"},
    {"id": "warehouse", "label": "Warehouse Staff", "scope": "staff"},
    {"id": "admin", "label": "Admin", "scope": "staff"},
]


# Roles permitted to open the ADMIN console (frontend gate + backend ops).
# Vendors / drivers / customers each have their own portal/app — they must
# NEVER see the admin dashboard, even when authenticated.
ADMIN_CONSOLE_ROLES = frozenset(
    {"super_admin", "warehouse_admin", "admin", "dispatcher", "warehouse"}
)


def role_of(user: dict | None) -> str | None:
    """UNTRUSTED display hint from JWT claims (user_metadata wins, then role).

    NEVER use this alone for access control in production: ``user_metadata``
    is editable by the account owner, so a user could self-promote. The
    enforced check is :func:`db_role_of` (the ``users.role`` column).
    """
    if not user:
        return None
    return (user.get("user_metadata") or {}).get("role") or user.get("role")


def db_role_of(sub: str | None) -> tuple[str | None, bool | None, dict | None]:
    """Authoritative role lookup from ``public.users`` (service-role client).

    Returns ``(role, is_active, row)``; ``(None, None, None)`` when there is
    no sub, no DB configured, or no row — callers fail CLOSED in production.
    """
    if not sub:
        return None, None, None
    try:
        from app.core.supabase_client import get_supabase

        sb = get_supabase()
    except Exception:
        return None, None, None
    try:
        try:
            res = (
                sb.table("users")
                .select("id, email, full_name, role, is_active, vendor_id")
                .eq("id", str(sub))
                .limit(1)
                .execute()
            )
        except Exception:
            res = (
                sb.table("users")
                .select("id, email, full_name, role, is_active")
                .eq("id", str(sub))
                .limit(1)
                .execute()
            )
        rows = res.data or []
        if not rows:
            return None, None, None
        row = rows[0]
        return row.get("role"), row.get("is_active", True), row
    except Exception:
        return None, None, None


def _effective_role(user: dict | None) -> tuple[str | None, dict | None]:
    """Role to enforce: DB ``users.role`` wins when the DB is reachable.

    Service-role JWTs (backend-to-backend) are trusted without a DB row.
    With a reachable DB + JWT ``sub`` the DB row is authoritative — a
    missing row or ``is_active = false`` denies access in production.
    Offline (tests / unconfigured dev) falls back to the JWT hint.
    """
    if not user:
        return None, None
    if user.get("role") == "service_role":
        return "service_role", None
    sub = user.get("sub")
    if sub:
        try:
            from app.core.supabase_client import get_supabase

            get_supabase()
            db_ok = True
        except Exception:
            db_ok = False
        if db_ok:
            role, is_active, row = db_role_of(sub)
            if row is None:
                if settings.require_auth:
                    return None, None
                return role_of(user), None
            if is_active is False and settings.require_auth:
                return None, row
            return role, row
    return role_of(user), None


def _decode(token: str) -> dict:
    secret = settings.supabase_jwt_secret or ""
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="SUPABASE_JWT_SECRET not configured",
        )
    try:
        return jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            options={"verify_aud": False},
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=f"invalid token: {exc}"
        ) from exc


def decode_optional(token: str) -> dict | None:
    """Best-effort decode for endpoints that must stay reachable when logged out."""
    try:
        return _decode(token)
    except HTTPException:
        return None


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict | None:
    """Return JWT claims, or None when auth disabled and no token sent."""
    if not settings.require_auth:
        if not creds:
            return None
        return _decode(creds.credentials)
    if not creds:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing token")
    return _decode(creds.credentials)


def require_user(user: dict | None = Depends(get_current_user)) -> dict:
    if not settings.require_auth:
        return user or {"role": "dev-bypass"}
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="login required")
    return user


def require_role(*allowed: str):
    """Dependency factory: the caller's role must be in ``allowed``.

    Dev bypass: when REQUIRE_AUTH=false the check is skipped entirely so local
    tooling keeps working. In production the JWT role claim (user_metadata.role)
    decides access.
    """
    allowed_set = frozenset(allowed)

    def dependency(user: dict = Depends(require_user)) -> dict:
        if not settings.require_auth:
            return user
        role, _row = _effective_role(user)
        if role not in allowed_set:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"role '{role}' not in {sorted(allowed_set)}",
            )
        return user

    return dependency


def require_staff(user: dict = Depends(require_user)) -> dict:
    if not settings.require_auth:
        return user
    role, _row = _effective_role(user)
    if role not in STAFF_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="staff only")
    return user


def require_super_admin(user: dict = Depends(require_user)) -> dict:
    if not settings.require_auth:
        return user
    role, _row = _effective_role(user)
    if role not in SUPER_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="super admin only")
    return user


def require_admin_console(user: dict = Depends(require_user)) -> dict:
    """Gate for the ADMIN dashboard data itself (GET /ops/profile, /auth/me).

    Only staff roles in ADMIN_CONSOLE_ROLES pass. Vendors, drivers and
    customers are rejected HERE with 403 — even though they hold valid
    JWTs — so a leaked/stolen non-staff login can never open the console.
    """
    if not settings.require_auth:
        return user
    role, _row = _effective_role(user)
    if role not in ADMIN_CONSOLE_ROLES and role != "service_role":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"role '{role}' is not authorized for the admin console",
        )
    return user
