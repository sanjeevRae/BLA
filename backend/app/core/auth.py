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


def role_of(user: dict | None) -> str | None:
    """Extract the BLA role from JWT claims (user_metadata wins, then role)."""
    if not user:
        return None
    return (user.get("user_metadata") or {}).get("role") or user.get("role")


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
        role = role_of(user)
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
    role = role_of(user)
    if role not in STAFF_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="staff only")
    return user


def require_super_admin(user: dict = Depends(require_user)) -> dict:
    if not settings.require_auth:
        return user
    role = role_of(user)
    if role not in SUPER_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="super admin only")
    return user
