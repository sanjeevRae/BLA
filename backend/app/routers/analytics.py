"""Analytics endpoints for the admin dashboard and cron jobs."""
from typing import Optional

from fastapi import APIRouter, Query

from app.services import analytics as analytics_service

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/overview")
def overview():
    return analytics_service.overview()


@router.get("/daily")
def daily(date: Optional[str] = Query(default=None, description="YYYY-MM-DD, defaults to today")):
    from datetime import datetime, timezone

    day = None
    if date:
        day = datetime.fromisoformat(date).replace(tzinfo=timezone.utc)
    return analytics_service.daily_summary(day)
