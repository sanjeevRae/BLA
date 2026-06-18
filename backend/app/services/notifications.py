"""Email (EmailJS) and SMS (Textlocal) notification helpers.

These are best-effort: failures are swallowed and logged so a flaky third-party
provider never blocks an order from being created or a status from updating.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

_EMAILJS_ENDPOINT = "https://api.emailjs.com/api/v1.0/email/send"
_TEXTLOCAL_ENDPOINT = "https://api.textlocal.in/send/"


async def send_email(template_params: dict[str, Any]) -> bool:
    """Send a transactional email through EmailJS (server-side / strict mode).

    ``template_params`` are merged into the configured EmailJS template, e.g.
    ``{"to_email": ..., "order_number": ..., "status": ...}``.
    """
    if not (settings.emailjs_service_id and settings.emailjs_template_id):
        logger.info("EmailJS not configured; skipping email.")
        return False

    payload: dict[str, Any] = {
        "service_id": settings.emailjs_service_id,
        "template_id": settings.emailjs_template_id,
        "user_id": settings.emailjs_user_id,
        "template_params": template_params,
    }
    # Strict mode (server-side) requires the private key as accessToken.
    if settings.emailjs_private_key:
        payload["accessToken"] = settings.emailjs_private_key

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(_EMAILJS_ENDPOINT, json=payload)
            resp.raise_for_status()
        return True
    except httpx.HTTPError as exc:
        logger.warning("EmailJS send failed: %s", exc)
        return False


async def send_sms(phone: str, message: str) -> bool:
    """Send an SMS through Textlocal."""
    if not settings.textlocal_api_key:
        logger.info("Textlocal not configured; skipping SMS.")
        return False

    data = {
        "apikey": settings.textlocal_api_key,
        "numbers": phone.lstrip("+"),
        "message": message,
        "sender": settings.textlocal_sender,
    }
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(_TEXTLOCAL_ENDPOINT, data=data)
            resp.raise_for_status()
            body = resp.json()
        if body.get("status") != "success":
            logger.warning("Textlocal returned non-success: %s", body)
            return False
        return True
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("Textlocal send failed: %s", exc)
        return False


# --- Convenience wrappers ----------------------------------------------------

async def notify_order_confirmation(order: dict[str, Any]) -> None:
    """Email + SMS the customer that their order was received."""
    recipient_email = order.get("recipient_email") or order.get("email")
    if recipient_email:
        await send_email(
            {
                "to_email": recipient_email,
                "recipient_name": order.get("recipient_name", "Customer"),
                "order_number": order.get("order_number"),
                "status": "received",
                "message": "We've received your order and it's being prepared.",
            }
        )
    phone = order.get("recipient_phone")
    if phone:
        await send_sms(
            phone,
            f"BLA: Order {order.get('order_number')} received. "
            f"Track it live from the link we sent you.",
        )


async def notify_status_update(order: dict[str, Any], status: str) -> None:
    """SMS the customer when their order status changes."""
    phone = order.get("recipient_phone")
    pretty = status.replace("_", " ").title()
    if phone:
        await send_sms(
            phone,
            f"BLA: Order {order.get('order_number')} is now '{pretty}'.",
        )


async def send_daily_summary(to_email: str, summary: dict[str, Any]) -> bool:
    """Email a daily operations summary (used by the cron job)."""
    return await send_email(
        {
            "to_email": to_email,
            "subject": "BLA daily delivery report",
            "order_number": "—",
            "status": "daily_summary",
            "message": (
                f"Orders today: {summary.get('total', 0)} | "
                f"Delivered: {summary.get('delivered', 0)} | "
                f"In transit: {summary.get('in_transit', 0)} | "
                f"Pending: {summary.get('pending', 0)}"
            ),
        }
    )
