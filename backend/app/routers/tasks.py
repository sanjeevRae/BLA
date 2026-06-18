"""Background-task endpoints triggered by cron (GitHub Actions / Render Cron).

These are protected by a shared secret header (X-Cron-Token) so they can be
called from a scheduler without a full user session.
"""
import os

from fastapi import APIRouter, Header, HTTPException, Query

from app.core.config import settings
from app.core.supabase_client import get_supabase
from app.services import analytics as analytics_service
from app.services import notifications

router = APIRouter(prefix="/tasks", tags=["tasks"])

# Optional shared secret; set CRON_TOKEN in the environment to require it.
_CRON_TOKEN = os.getenv("CRON_TOKEN", "")


def _check_token(token: str | None) -> None:
    if _CRON_TOKEN and token != _CRON_TOKEN:
        raise HTTPException(status_code=401, detail="invalid cron token")


@router.post("/daily-report")
async def daily_report(
    to_email: str = Query(..., description="recipient for the summary email"),
    x_cron_token: str | None = Header(default=None),
):
    """Compute today's summary and email it. Called by the daily cron job."""
    _check_token(x_cron_token)
    summary = analytics_service.daily_summary()
    sent = await notifications.send_daily_summary(to_email, summary)
    return {"summary": summary, "email_sent": sent}


@router.post("/cleanup-gps")
def cleanup_gps(
    retention_days: int = Query(default=7, ge=1, le=365),
    x_cron_token: str | None = Header(default=None),
):
    """Delete old GPS pings to stay within the Supabase free-tier 500 MB cap.

    Uses the ``cleanup_gps_tracking`` SQL function defined in db/schema.sql.
    """
    _check_token(x_cron_token)
    sb = get_supabase()
    res = sb.rpc("cleanup_gps_tracking", {"retention_days": retention_days}).execute()
    deleted = res.data if isinstance(res.data, int) else res.data
    return {"deleted": deleted, "retention_days": retention_days}
