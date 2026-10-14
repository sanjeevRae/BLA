"""Operational analytics derived from orders, payments, customers, and drivers."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from app.core.supabase_client import get_supabase

_IN_TRANSIT = ("went_for_delivery", "out_for_delivery")
_PENDING = ("received", "on_place")


def _count(table_query) -> int:
    res = table_query.execute()
    return res.count or 0


def _sum_amount(rows: list[dict[str, Any]], key: str) -> float:
    total = 0.0
    for row in rows or []:
        value = row.get(key)
        if value is not None:
            total += float(value)
    return round(total, 2)


def overview() -> dict[str, Any]:
    sb = get_supabase()

    def status_count(statuses: tuple[str, ...]) -> int:
        return _count(
            sb.table("orders").select("id", count="exact").in_("status", list(statuses))
        )

    total = _count(sb.table("orders").select("id", count="exact"))
    delivered = status_count(("delivered",))
    in_transit = status_count(_IN_TRANSIT)
    pending = status_count(_PENDING)
    active_drivers = _count(
        sb.table("drivers").select("id", count="exact").eq("is_available", True)
    )
    customers = _count(sb.table("customers").select("id", count="exact"))

    payments = sb.table("payments").select("amount, status").execute().data or []
    collected_revenue = _sum_amount([p for p in payments if p.get("status") == "paid"], "amount")
    pending_revenue = _sum_amount([p for p in payments if p.get("status") == "pending"], "amount")

    return {
        "total": total,
        "delivered": delivered,
        "in_transit": in_transit,
        "pending": pending,
        "active_drivers": active_drivers,
        "customers": customers,
        "collected_revenue": collected_revenue,
        "pending_revenue": pending_revenue,
    }


def cashflow_summary() -> dict[str, Any]:
    sb = get_supabase()
    orders = (
        sb.table("orders")
        .select("id, order_number, status, total_amount, created_at, delivered_at")
        .order("created_at", desc=True)
        .limit(12)
        .execute()
        .data
        or []
    )
    payments = sb.table("payments").select("order_id, amount, status, method, paid_at").execute().data or []
    payment_by_order = {payment.get("order_id"): payment for payment in payments if payment.get("order_id")}

    deliveries = []
    total_earnings = 0.0
    paid_count = 0
    for order in orders:
        payment = payment_by_order.get(order.get("id"), {})
        amount = payment.get("amount") if payment.get("amount") is not None else order.get("total_amount")
        amount = float(amount or 0)
        if payment.get("status") == "paid":
            total_earnings += amount
            paid_count += 1
        deliveries.append(
            {
                "order_id": order.get("id"),
                "order_number": order.get("order_number"),
                "status": order.get("status"),
                "amount": round(amount, 2),
                "payment_status": payment.get("status") or "pending",
                "payment_method": payment.get("method") or "cod",
                "date": payment.get("paid_at") or order.get("delivered_at") or order.get("created_at"),
                "earning_per_delivery": round(amount if payment.get("status") == "paid" else 0, 2),
            }
        )

    average_per_delivery = round(total_earnings / paid_count, 2) if paid_count else 0.0
    return {
        "total_earnings": round(total_earnings, 2),
        "average_per_delivery": average_per_delivery,
        "paid_deliveries": paid_count,
        "deliveries": deliveries,
    }


def admin_feed() -> dict[str, Any]:
    sb = get_supabase()

    def _safe_list(table: str, select: str, order_col: str, limit: int) -> list[dict[str, Any]]:
        try:
            return (
                sb.table(table)
                .select(select)
                .order(order_col, desc=True)
                .limit(limit)
                .execute()
                .data
                or []
            )
        except Exception:
            return []

    notifications = _safe_list("admin_notifications", "id, title, body, type", "created_at", 10)
    messages_raw = _safe_list("admin_messages", "id, sender_name, body", "created_at", 10)
    settings_raw = _safe_list("admin_settings", "id, setting_key, setting_value", "updated_at", 20)
    help_raw = _safe_list("admin_help", "id, title, link", "created_at", 10)
    recent_orders = _safe_list(
        "orders", "id, order_number, status, delivery_address", "created_at", 5
    )

    messages = [
        {"id": m.get("id"), "from": m.get("sender_name"), "body": m.get("body")}
        for m in messages_raw
    ]
    settings = [
        {
            "id": s.get("id"),
            "label": (s.get("setting_key") or "").replace("_", " ").title(),
            "enabled": bool((s.get("setting_value") or {}).get("enabled", True))
            if isinstance(s.get("setting_value"), dict)
            else True,
        }
        for s in settings_raw
    ]

    if not notifications:
        notifications = [
            {
                "id": "notif-fallback",
                "title": "No notifications yet",
                "body": "Seed admin_notifications to show ops alerts here.",
                "type": "info",
            }
        ]
    if not messages:
        messages = [
            {"id": "msg-fallback", "from": "System", "body": "No messages yet."}
        ]
    if not settings:
        settings = [
            {"id": "set-rt", "label": "Realtime tracking", "enabled": True},
            {"id": "set-alerts", "label": "Customer alerts", "enabled": True},
        ]
    if not help_raw:
        help_raw = [
            {"id": "help-1", "title": "How cashflow is calculated", "link": "/analytics/cashflow"},
            {"id": "help-2", "title": "How to manage customers", "link": "/customers"},
        ]

    return {
        "notifications": notifications,
        "messages": messages,
        "settings": settings,
        "help_center": help_raw,
        "recent_orders": recent_orders,
    }


def revenue_and_orders(days: int = 7) -> dict[str, Any]:
    """Per-day revenue + order counts for the revenue chart (oldest to newest).

    Reads at most 2000 recent rows per table to stay free-tier friendly.
    """
    sb = get_supabase()
    days = max(1, min(int(days or 7), 120))
    keys = _day_keys(days)
    labels = [d.strftime("%b %d") for d in keys]

    orders = (
        sb.table("orders")
        .select("status, total_amount, created_at")
        .order("created_at", desc=True)
        .limit(2000)
        .execute()
        .data
        or []
    )
    payments = (
        sb.table("payments")
        .select("amount, status, paid_at, created_at")
        .order("created_at", desc=True)
        .limit(2000)
        .execute()
        .data
        or []
    )
    paid = [p for p in payments if str(p.get("status") or "").lower() == "paid"]

    order_counts, _ = _bucket(orders, "created_at", keys)
    _, revenue_sums = _bucket(paid, "paid_at", keys, amount_field="amount")
    return {
        "days": days,
        "labels": labels,
        "revenue": revenue_sums,
        "orders": order_counts,
        "total_revenue": round(sum(revenue_sums), 2),
        "total_orders": sum(order_counts),
    }


def _split_window(rows, date_field, keys):
    """Split fetched rows into current-window vs previous-window lists."""
    start = min(keys)
    curr, prev = [], []
    for row in rows or []:
        day = _parse_day(row.get(date_field)) or start
        (curr if day >= start else prev).append(row)
    return curr, prev


def daily_summary(day: datetime | None = None) -> dict[str, Any]:
    sb = get_supabase()
    day = day or datetime.now(timezone.utc)
    start = day.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)

    base = (
        sb.table("orders")
        .select("id", count="exact")
        .gte("created_at", start.isoformat())
        .lt("created_at", end.isoformat())
    )
    total = _count(base)

    def status_count(statuses: tuple[str, ...]) -> int:
        return _count(
            sb.table("orders")
            .select("id", count="exact")
            .gte("created_at", start.isoformat())
            .lt("created_at", end.isoformat())
            .in_("status", list(statuses))
        )

    return {
        "date": start.date().isoformat(),
        "total": total,
        "delivered": status_count(("delivered",)),
        "in_transit": status_count(_IN_TRANSIT),
        "pending": status_count(_PENDING),
        "failed": status_count(("failed", "cancelled")),
    }


def _parse_day(value: Any):
    """Parse a date/datetime/ISO string into a ``date`` (UTC). None if unparseable."""
    if not value:
        return None
    try:
        if isinstance(value, datetime):
            dt = value
        else:
            text = str(value).strip()
            if text.endswith("Z"):
                text = text[:-1] + "+00:00"
            dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.date()
    except (ValueError, TypeError):
        return None


def _day_keys(total_days: int) -> list:
    """Oldest→newest date keys ending today (UTC)."""
    total_days = max(1, int(total_days or 1))
    today = datetime.now(timezone.utc).date()
    return [today - timedelta(days=i) for i in range(total_days - 1, -1, -1)]


def _bucket(rows: list[dict[str, Any]], date_field: str, keys: list, amount_field: str | None = None):
    """Per-day counts (and optional amount sums) aligned to ``keys``."""
    pos = {d: i for i, d in enumerate(keys)}
    counts = [0] * len(keys)
    sums = [0.0] * len(keys)
    for row in rows or []:
        day = _parse_day(row.get(date_field))
        if day is None or day not in pos:
            continue
        i = pos[day]
        counts[i] += 1
        if amount_field:
            try:
                sums[i] += float(row.get(amount_field) or 0)
            except (TypeError, ValueError):
                pass
    return counts, [round(s, 2) for s in sums]


def _bucket_distinct(rows: list[dict[str, Any]], date_field: str, id_field: str, keys: list) -> list[int]:
    """Per-day distinct id_field counts (e.g. active drivers from GPS pings)."""
    pos = {d: i for i, d in enumerate(keys)}
    sets = [set() for _ in keys]
    for row in rows or []:
        day = _parse_day(row.get(date_field))
        if day is None or day not in pos:
            continue
        if row.get(id_field) is not None:
            sets[pos[day]].add(row.get(id_field))
    return [len(s) for s in sets]


def pct_change(current: float, previous: float) -> int:
    """Week-over-week style % change. From-zero baseline counts as +100%."""
    try:
        if previous:
            return round((float(current) - float(previous)) / float(previous) * 100)
    except (TypeError, ValueError, ZeroDivisionError):
        pass
    return 100 if (current or 0) else 0



def activity_feed(limit: int = 8) -> dict[str, Any]:
    """Recent activity rows: latest orders joined to payments + status notes."""
    sb = get_supabase()
    limit = max(1, min(int(limit or 8), 50))
    orders = (
        sb.table("orders")
        .select("id, order_number, status, total_amount, created_at, updated_at, recipient_name")
        .order("updated_at", desc=True)
        .limit(limit)
        .execute()
        .data
        or []
    )
    if not orders:
        return {"activity": []}

    ids = [o.get("id") for o in orders if o.get("id")]
    payments: list[dict[str, Any]] = []
    history: list[dict[str, Any]] = []
    try:
        payments = (
            sb.table("payments")
            .select("order_id, method, status, paid_at, created_at")
            .in_("order_id", ids)
            .execute()
            .data
            or []
        )
    except Exception:
        payments = []
    try:
        history = (
            sb.table("delivery_status_history")
            .select("order_id, status, note, created_at")
            .in_("order_id", ids)
            .order("created_at", desc=True)
            .limit(limit * 4)
            .execute()
            .data
            or []
        )
    except Exception:
        history = []

    pay_by_order = {p.get("order_id"): p for p in payments if p.get("order_id")}
    note_by_order: dict[str, str] = {}
    for h in history:
        if h.get("order_id") not in note_by_order and h.get("note"):
            note_by_order[h.get("order_id")] = str(h.get("note"))

    activity = []
    for o in orders:
        created = str(o.get("created_at") or "")
        updated = str(o.get("updated_at") or "")
        status = str(o.get("status") or "")
        detail = note_by_order.get(o.get("id")) or (
            "Order created" if created[:16] == updated[:16] else f"Order {status.replace('_', ' ')}"
        )
        payment = pay_by_order.get(o.get("id"), {})
        activity.append(
            {
                "time": str(o.get("updated_at") or o.get("created_at") or ""),
                "order_id": o.get("id"),
                "order_number": o.get("order_number"),
                "status": status,
                "amount": o.get("total_amount"),
                "payment_method": payment.get("method") or "cod",
                "payment_status": payment.get("status") or "pending",
                "customer": o.get("recipient_name") or "—",
                "details": detail,
            }
        )
    return {"activity": activity}


def payments_summary() -> dict[str, Any]:
    """Payment status counts for the donut (all time)."""
    sb = get_supabase()
    payments = sb.table("payments").select("amount, currency, status").execute().data or []

    counts = {"paid": 0, "pending": 0, "failed": 0}
    total_paid = 0.0
    for p in payments or []:
        status = str(p.get("status") or "pending").lower()
        if status == "paid":
            counts["paid"] += 1
            try:
                total_paid += float(p.get("amount") or 0)
            except (TypeError, ValueError):
                pass
        elif status == "pending":
            counts["pending"] += 1
        else:
            counts["failed"] += 1
    return {
        "paid": counts["paid"],
        "pending": counts["pending"],
        "failed": counts["failed"],
        "total_paid": round(total_paid, 2),
    }


def weekly_trends(days: int = 7) -> dict[str, Any]:
    """Metric cards: current-window totals, % change vs previous window, sparks.

    Window = last ``days`` ending today. Active drivers = distinct GPS
    drivers inside the window (not the roster availability flag).
    """
    sb = get_supabase()
    days = max(1, min(int(days or 7), 120))
    keys = _day_keys(days)
    labels = [d.strftime("%b %d") for d in keys]
    prev_start = (min(keys) - timedelta(days=days)).isoformat()

    orders = (
        sb.table("orders").select("status, created_at")
        .gte("created_at", prev_start).order("created_at", desc=True)
        .limit(2000).execute().data or []
    )
    pings = (
        sb.table("gps_tracking").select("driver_id, recorded_at")
        .gte("recorded_at", prev_start).order("recorded_at", desc=True)
        .limit(5000).execute().data or []
    )
    customers = (
        sb.table("customers").select("id, created_at")
        .gte("created_at", prev_start).order("created_at", desc=True)
        .limit(2000).execute().data or []
    )
    payments = (
        sb.table("payments").select("amount, status, paid_at")
        .order("created_at", desc=True).limit(2000).execute().data or []
    )
    paid = [p for p in payments if str(p.get("status") or "").lower() == "paid"]
    pending_payment = [p for p in payments if str(p.get("status") or "").lower() == "pending"]

    curr_orders, prev_orders = _split_window(orders, "created_at", keys)
    curr_pings, prev_pings = _split_window(pings, "recorded_at", keys)
    curr_customers, prev_customers = _split_window(customers, "created_at", keys)
    curr_paid, prev_paid = _split_window(paid, "paid_at", keys)

    def in_statuses(rows, want) -> int:
        return sum(1 for o in rows if str(o.get("status") or "") in want)

    def money(rows) -> float:
        s = 0.0
        for p in rows:
            try:
                s += float(p.get("amount") or 0)
            except (TypeError, ValueError):
                pass
        return round(s, 2)

    curr_drivers = len({g.get("driver_id") for g in curr_pings if g.get("driver_id")})
    prev_drivers = len({g.get("driver_id") for g in prev_pings if g.get("driver_id")})
    pending_cash = money(pending_payment)

    curr_delivered = in_statuses(curr_orders, ("delivered",))
    prev_delivered = in_statuses(prev_orders, ("delivered",))
    curr_transit = in_statuses(curr_orders, _IN_TRANSIT)
    prev_transit = in_statuses(prev_orders, _IN_TRANSIT)
    curr_pending = in_statuses(curr_orders, (*_PENDING, "cancelled", "failed"))
    prev_pending = in_statuses(prev_orders, (*_PENDING, "cancelled", "failed"))
    curr_collected = money(curr_paid)
    prev_collected = money(prev_paid)

    total_counts, _ = _bucket(curr_orders, "created_at", keys)
    pending_series, _ = _bucket(
        [o for o in curr_orders if str(o.get("status") or "") in (*_PENDING, "cancelled", "failed")],
        "created_at", keys,
    )
    transit_series, _ = _bucket(
        [o for o in curr_orders if str(o.get("status") or "") in _IN_TRANSIT],
        "created_at", keys,
    )
    delivered_series, _ = _bucket(
        [o for o in curr_orders if str(o.get("status") or "") == "delivered"],
        "created_at", keys,
    )
    drivers_series = _bucket_distinct(curr_pings, "recorded_at", "driver_id", keys)
    customers_series, _ = _bucket(curr_customers, "created_at", keys)
    collected_series, _ = _bucket(curr_paid, "paid_at", keys, amount_field="amount")
    flat_pending = [pending_cash / days if days else 0] * days

    return {
        "days": days,
        "labels": labels,
        "metrics": {
            "total": {"value": len(curr_orders), "change": pct_change(len(curr_orders), len(prev_orders)), "spark": total_counts},
            "pending": {"value": curr_pending, "change": pct_change(curr_pending, prev_pending), "spark": pending_series},
            "in_transit": {"value": curr_transit, "change": pct_change(curr_transit, prev_transit), "spark": transit_series},
            "delivered": {"value": curr_delivered, "change": pct_change(curr_delivered, prev_delivered), "spark": delivered_series},
            "active_drivers": {"value": curr_drivers, "change": pct_change(curr_drivers, prev_drivers), "spark": drivers_series},
            "customers": {"value": len(curr_customers), "change": pct_change(len(curr_customers), len(prev_customers)), "spark": customers_series},
            "collected_revenue": {"value": curr_collected, "change": pct_change(curr_collected, prev_collected), "spark": collected_series},
            "pending_revenue": {"value": pending_cash, "change": 0, "spark": flat_pending},
        },
    }

