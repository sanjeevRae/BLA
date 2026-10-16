"""Authentication endpoints — Supabase-backed, no passwords handled here.

* ``GET /auth/config`` — public: tells the login page whether auth is
  enforced and which Supabase project to sign in against. Contains no
  secrets (anon key is public by design; the service key NEVER leaves
  the backend).
* ``GET /auth/me`` — authenticated: resolves the caller against the
  ``public.users`` table (the ``role`` column is authoritative) and
  reports whether this identity may open the ADMIN console. Unknown or
  inactive users are denied. Vendors / drivers / customers get a
  structured ``access: denied`` with a redirect hint — never the console.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.auth import (
    ADMIN_CONSOLE_ROLES,
    ROLE_CATALOG,
    _effective_role,
    db_role_of,
    decode_optional,
    require_user,
)
from app.core.config import settings

router = APIRouter(prefix="/auth", tags=["auth"])

_bearer = HTTPBearer(auto_error=False)

# Where each non-admin role belongs. The frontend uses this to bounce a
# correctly-authenticated but wrong-portal login to the right app.
_PORTAL_HINTS = {
    "vendor": "/vendor-portal",
    "micro_driver": "/driver-app",
    "big_driver": "/driver-app",
    "driver": "/driver-app",
    "customer": "/customer-tracking",
}


@router.get("/config")
def auth_config():
    """Public login-page config. Safe to expose — no secrets inside."""
    return {
        "auth_required": settings.require_auth,
        "environment": settings.environment,
        "supabase_url": settings.supabase_url or None,
        "supabase_anon_key": settings.supabase_anon_key or None,
        "admin_roles": sorted(ADMIN_CONSOLE_ROLES),
        "roles": ROLE_CATALOG,
    }


@router.get("/me", dependencies=[Depends(require_user)])
def auth_me(
    user: dict = Depends(require_user),
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
):
    """Resolve the caller's DB identity + console authorization.

    The role comes from ``public.users.role`` when the DB is reachable
    (JWT ``user_metadata.role`` is untrusted and used as hint only).
    Fails CLOSED in production: no token / unknown user / inactive user
    -> 401/403, never console access.
    """
    if not settings.require_auth:
        return {
            "access": "granted",
            "mode": "dev",
            "detail": "REQUIRE_AUTH=false — local development only.",
        }
    if creds:
        claims = _decode_or_401(creds.credentials)
    else:
        claims = user
    if not claims:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="login required")
    sub = claims.get("sub")
    if not sub:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="login required")
    role, is_active, row = db_role_of(sub)
    hint_role = (claims.get("user_metadata") or {}).get("role") or claims.get("role")
    if row is None:
        return {
            "access": "denied",
            "reason": "unknown_user",
            "detail": "This login has no BLA user profile. Ask an admin to create one.",
            "role_claim": hint_role,
        }
    if is_active is False:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="account disabled")
    effective, _r = _effective_role(claims)
    role = effective or role
    if role in ADMIN_CONSOLE_ROLES or role == "service_role":
        return {
            "access": "granted",
            "user_id": sub,
            "email": (row or {}).get("email"),
            "full_name": (row or {}).get("full_name"),
            "role": role,
            "vendor_id": (row or {}).get("vendor_id"),
        }
    return {
        "access": "denied",
        "reason": "wrong_portal",
        "role": role,
        "detail": f"Role '{role}' cannot open the admin console.",
        "portal_hint": _PORTAL_HINTS.get(role),
    }


def _decode_or_401(token: str) -> dict:
    claims = decode_optional(token)
    if not claims:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid or expired token")
    return claims

