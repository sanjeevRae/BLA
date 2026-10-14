"""Supabase JWT auth dependency (optional in dev, required in prod).

Usage:
    from app.core.auth import require_staff  # or require_user
    @router.post("", dependencies=[Depends(require_staff)])
"""
from __future__ import annotations

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import settings

_bearer = HTTPBearer(auto_error=False)


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


def require_staff(user: dict = Depends(require_user)) -> dict:
    if not settings.require_auth:
        return user
    role = (user.get("user_metadata") or {}).get("role") or user.get("role")
    if role not in ("admin", "dispatcher", "warehouse", "service_role"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="staff only")
    return user
