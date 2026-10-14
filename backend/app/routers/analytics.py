"""Analytics endpoints for the admin dashboard and cron jobs."""
from typing import Optional

from fastapi import APIRouter, Query

from app.services import analytics as analytics_service

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/overview")
def overview():
    return analytics_service.overview()


@router.get("/cashflow")
def cashflow():
    return analytics_service.cashflow_summary()


@router.get("/admin-feed")
def admin_feed():
    return analytics_service.admin_feed()


@router.get("/daily")
def daily(date: Optional[str] = Query(default=None, description="YYYY-MM-DD, defaults to today")):
    from datetime import datetime, timezone

    day = None
    if date:
        day = datetime.fromisoformat(date).replace(tzinfo=timezone.utc)
    return analytics_service.daily_summary(day)


@router.get("/revenue")
def revenue(days: int = Query(default=7, ge=1, le=120)):
    """Revenue + order series for the dashboard chart (oldest to newest)."""
    return analytics_service.revenue_and_orders(days)


@router.get("/trends")
def trends(days: int = Query(default=7, ge=1, le=120)):
    """Metric cards: totals, % change vs previous window, spark series."""
    return analytics_service.weekly_trends(days)


@router.get("/activity")
def activity(limit: int = Query(default=8, ge=1, le=50)):
    """Recent activity rows: orders joined to payments + status notes."""
    return analytics_service.activity_feed(limit)


@router.get("/payments-summary")
def payments_summary():
    """Payment status counts for the donut widget."""
    return analytics_service.payments_summary()
