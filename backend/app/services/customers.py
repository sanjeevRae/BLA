"""Customer data access for admin views."""
from __future__ import annotations

from typing import Any

from app.core.supabase_client import get_supabase


def list_customers(search: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    sb = get_supabase()
    query = (
        sb.table("customers")
        .select(
            "id, name, email, phone, city, state, country, address_line1, address_line2, postal_code, latitude, longitude, created_at"
        )
        .order("created_at", desc=True)
        .limit(limit)
    )

    if search:
        term = search.strip()
        if term:
            query = query.or_(
                f"name.ilike.%{term}%,email.ilike.%{term}%,phone.ilike.%{term}%,city.ilike.%{term}%"
            )

    res = query.execute()
    return res.data or []


_ALLOWED_CUSTOMER_FIELDS = {
    "name",
    "email",
    "phone",
    "city",
    "state",
    "country",
    "address_line1",
    "address_line2",
    "postal_code",
    "latitude",
    "longitude",
    "user_id",
}


def _clean_customer_payload(payload: dict[str, Any]) -> dict[str, Any]:
    cleaned = {k: v for k, v in (payload or {}).items() if k in _ALLOWED_CUSTOMER_FIELDS}
    if cleaned.get("user_id") is not None:
        cleaned["user_id"] = str(cleaned["user_id"])
    return cleaned


def create_customer(payload: dict[str, Any]) -> dict[str, Any]:
    sb = get_supabase()
    res = sb.table("customers").insert(_clean_customer_payload(payload)).execute()
    return res.data[0] if res.data else {}


def update_customer(customer_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    sb = get_supabase()
    res = (
        sb.table("customers")
        .update(_clean_customer_payload(payload))
        .eq("id", customer_id)
        .execute()
    )
    return res.data[0] if res.data else None


def delete_customer(customer_id: str) -> bool:
    sb = get_supabase()
    res = sb.table("customers").delete().eq("id", customer_id).execute()
    return bool(res.data)
