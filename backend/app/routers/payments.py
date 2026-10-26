"""Online payments via Stripe."""

from __future__ import annotations

import logging
from typing import Optional

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from app.core.auth import require_user
from app.core.config import settings
from app.core.supabase_client import get_supabase

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/payments", tags=["payments"])

if settings.stripe_secret_key:
    stripe.api_key = settings.stripe_secret_key
else:
    logger.warning(
        "STRIPE_SECRET_KEY not set — /payments/intent will return 503 in dev."
    )


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class PaymentConfigOut(BaseModel):
    publishable_key: Optional[str]
    environment: str


class PaymentIntentOut(BaseModel):
    client_secret: str
    payment_intent_id: str
    status: str
    amount: int
    currency: str


class PaymentStatusOut(BaseModel):
    payment_intent_id: str
    status: str
    amount: int
    currency: str
    order_id: Optional[str] = None


class PaymentIntentCreate(BaseModel):
    order_id: str
    amount_minor_units: Optional[int] = None

    model_config = {"extra": "ignore"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _stripe_configured() -> bool:
    return bool(settings.stripe_secret_key)


def _currency_for_env() -> str:
    import os

    return os.getenv("STRIPE_CURRENCY", "inr")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@router.get("/config", response_model=PaymentConfigOut)
def payments_config():
    return {
        "publishable_key": settings.stripe_publishable_key,
        "environment": settings.environment,
    }


@router.post("/intent", response_model=PaymentIntentOut, status_code=201)
async def create_payment_intent(
    payload: PaymentIntentCreate,
    user: dict = Depends(require_user),
):
    if not _stripe_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe not configured on the backend.",
        )

    sb = get_supabase()

    order_res = (
        sb.table("orders")
        .select("id, customer_id, total_amount, payment_method, payment_status")
        .eq("id", payload.order_id)
        .limit(1)
        .execute()
    )
    if not order_res.data:
        raise HTTPException(status_code=404, detail="order not found")
    order = order_res.data[0]

    user_id = user.get("sub") or user.get("id")
    role = user.get("role", "") if isinstance(user, dict) else ""
    staff_roles = {
        "super_admin", "admin", "staff", "dispatcher", "warehouse", "service_role",
    }
    if role not in staff_roles:
        if not user_id or str(order.get("customer_id") or "") != str(user_id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="not authorized to pay for this order",
            )

    existing_pi = order.get("payment_intent_id")
    if existing_pi and order.get("payment_status") in ("pending",):
        try:
            existing = stripe.PaymentIntent.retrieve(existing_pi)
            if existing.status in (
                "requires_payment_method",
                "requires_confirmation",
                "requires_action",
            ):
                return {
                    "client_secret": existing.client_secret,
                    "payment_intent_id": existing.id,
                    "status": existing.status,
                    "amount": existing.amount,
                    "currency": existing.currency,
                }
        except stripe.error.StripeError:
            pass

    amount = payload.amount_minor_units or int(float(order.get("total_amount") or 0) * 100)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="order amount must be greater than zero")

    try:
        intent = stripe.PaymentIntent.create(
            amount=amount,
            currency=_currency_for_env(),
            metadata={"order_id": order["id"], "order_number": order.get("order_number", "")},
            automatic_payment_methods={"enabled": True},
        )
    except stripe.error.StripeError as exc:
        logger.exception("Stripe PaymentIntent creation failed")
        raise HTTPException(
            status_code=status.HTTP_400,
            detail=f"payment setup failed: {exc.user_message or str(exc)}",
        ) from exc

    sb.table("orders").update(
        {
            "payment_intent_id": intent.id,
            "payment_method": "online",
            "payment_status": "pending",
        }
    ).eq("id", order["id"]).execute()

    return {
        "client_secret": intent.client_secret,
        "payment_intent_id": intent.id,
        "status": intent.status,
        "amount": intent.amount,
        "currency": intent.currency,
    }


@router.get("/{payment_intent_id}", response_model=PaymentStatusOut)
def get_payment_status(payment_intent_id: str):
    if not _stripe_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe not configured on the backend.",
        )
    try:
        intent = stripe.PaymentIntent.retrieve(payment_intent_id)
    except stripe.error.StripeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    order_id = (intent.get("metadata") or {}).get("order_id")

    return {
        "payment_intent_id": intent.id,
        "status": intent.status,
        "amount": intent.amount,
        "currency": intent.currency,
        "order_id": order_id,
    }


@router.post("/webhook")
async def stripe_webhook(request: Request):
    if not settings.stripe_webhook_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe webhook secret not configured.",
        )

    payload = await request.body()
    sig_header = request.headers.get("stripe-signature")
    if not sig_header:
        raise HTTPException(status_code=400, detail="missing stripe-signature header")

    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, settings.stripe_webhook_secret
        )
    except ValueError as exc:
        logger.warning("Stripe webhook: invalid payload — %s", exc)
        raise HTTPException(status_code=400, detail="invalid payload") from exc
    except stripe.error.SignatureVerificationError as exc:
        logger.warning("Stripe webhook: bad signature — %s", exc)
        raise HTTPException(status_code=400, detail="invalid signature") from exc

    event_type = event["type"]
    data_obj = event["data"]["object"]

    sb = get_supabase()

    if event_type == "payment_intent.succeeded":
        _fulfill_order(sb, data_obj, "paid")
    elif event_type == "payment_intent.payment_failed":
        _fulfill_order(sb, data_obj, "failed")
    elif event_type == "payment_intent.canceled":
        _fulfill_order(sb, data_obj, "canceled")
    else:
        logger.info("Stripe webhook: unhandled event %s", event_type)

    return {"received": True}


def _fulfill_order(sb, intent: dict, new_status: str):
    order_id = (intent.get("metadata") or {}).get("order_id")
    if not order_id:
        logger.warning("Stripe intent %s has no order_id metadata", intent.get("id"))
        return

    current = (
        sb.table("orders")
        .select("payment_status")
        .eq("id", order_id)
        .limit(1)
        .execute()
    )
    if current.data and current.data[0].get("payment_status") == new_status:
        return

    sb.table("orders").update(
        {"payment_status": new_status}
    ).eq("id", order_id).execute()

    logger.info(
        "Order %s payment marked %s via Stripe intent %s",
        order_id,
        new_status,
        intent.get("id"),
    )