"""Authentication endpoints — email/password login + signup via Supabase Auth.

* ``POST /auth/login`` — verifies email/password against Supabase Auth,
  then returns the user's role from ``public.users``.
* ``POST /auth/signup`` — creates a new Supabase Auth user + profile row
  in ``public.users`` with the requested role.
* ``GET /auth/config`` — public login-page config.
* ``GET /auth/me`` — resolves caller's DB identity + console authorization.
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
from app.core.supabase_client import get_supabase

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

_DASHBOARD_MAP = {
    "super_admin": "/super-admin-dashboard",
    "admin": "/admin-dashboard",
    "vendor": "/vendor-portal",
    "driver": "/driver-app",
    "customer": "/customer-tracking",
    "warehouse_admin": "/warehouse-dashboard",
    "dispatcher": "/dispatcher-dashboard",
    "warehouse": "/warehouse-dashboard",
    "micro_driver": "/driver-app",
    "big_driver": "/driver-app",
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


@router.post("/login")
def login(payload: dict):
    """Email/password login.
    
    Dev mode (REQUIRE_AUTH=false): Checks public.users by email — no Supabase Auth
    required. Useful for local development with pre-seeded users.
    
    Production mode (REQUIRE_AUTH=true): Verifies via Supabase Auth, then role lookup
    from public.users table.
    """
    email = payload.get("email")
    password = payload.get("password")

    if not email or not password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email and password are required",
        )

    supabase = get_supabase()

    try:
        # 1. Check public.users table for this email (get role from DB)
        profile = (
            supabase.table("users")
            .select("role, email, is_active, full_name")
            .eq("email", email)
            .single()
            .execute()
        )

        row = profile.data
        if not row:
            return {
                "role": None,
                "dashboard_path": None,
                "access": "denied",
                "reason": "unknown_user",
                "detail": f"No account found for {email}. Please signup first.",
            }

        if not row.get("is_active", True):
            return {
                "role": None,
                "dashboard_path": None,
                "access": "denied",
                "reason": "account_disabled",
                "detail": "Your account has been disabled. Contact support.",
            }

        # 2. Verify password
        if settings.require_auth:
            # Production: verify via Supabase Auth
            try:
                auth_result = supabase.auth.sign_in_with_password({
                    "email": email,
                    "password": password,
                })
                if not auth_result.user:
                    return {
                        "role": None,
                        "dashboard_path": None,
                        "access": "denied",
                        "reason": "invalid_credentials",
                        "detail": "Invalid email or password.",
                    }
            except Exception as auth_err:
                msg = str(auth_err).lower()
                if "invalid" in msg or "wrong" in msg or "credentials" in msg:
                    return {
                        "role": None,
                        "dashboard_path": None,
                        "access": "denied",
                        "reason": "invalid_credentials",
                        "detail": "Invalid email or password.",
                    }
                raise auth_err
        else:
            # Dev mode: accept login if user exists in public.users (password not
            # verified against Supabase Auth — local development only)
            pass

        role = row.get("role")
        dashboard_path = _DASHBOARD_MAP.get(role, "/dashboard")

        return {
            "role": role,
            "dashboard_path": dashboard_path,
            "email": row.get("email"),
            "full_name": row.get("full_name"),
            "access": "granted",
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"Login error: {str(e)}")
        return {
            "role": None,
            "dashboard_path": None,
            "access": "denied",
            "reason": "login_error",
            "detail": str(e),
        }


@router.post("/signup")
def signup(payload: dict):
    """Create a new user account via Supabase Auth + profile row."""
    email = payload.get("email")
    password = payload.get("password")
    full_name = payload.get("full_name", "")
    role = payload.get("role", "customer")

    if not email or not password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email and password are required",
        )

    if len(password) < 6:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password must be at least 6 characters",
        )

    # Validate role
    valid_roles = {
        "super_admin", "admin", "vendor", "driver", "customer",
        "warehouse_admin", "dispatcher", "warehouse",
        "micro_driver", "big_driver",
    }
    if role not in valid_roles:
        role = "customer"

    supabase = get_supabase()

    try:
        # 1. Create Supabase Auth user
        auth_result = supabase.auth.sign_up({
            "email": email,
            "password": password,
        })

        auth_user = auth_result.user
        if not auth_user:
            return {
                "access": "denied",
                "reason": "signup_failed",
                "detail": "Failed to create auth user",
            }

        # 2. Insert profile into public.users table
        supabase.table("users").insert({
            "id": auth_user.id,
            "email": email,
            "full_name": full_name,
            "role": role,
            "is_active": True,
        }).execute()

        return {
            "access": "granted",
            "role": role,
            "email": email,
            "full_name": full_name,
            "dashboard_path": _DASHBOARD_MAP.get(role, "/dashboard"),
            "detail": "Account created successfully",
        }

    except Exception as e:
        msg = str(e).lower()
        if "already exists" in msg or "duplicate" in msg or "already registered" in msg:
            return {
                "access": "denied",
                "reason": "email_exists",
                "detail": "An account with this email already exists",
            }
        print(f"Signup error: {str(e)}")
        return {
            "access": "denied",
            "reason": "signup_error",
            "detail": str(e),
        }

