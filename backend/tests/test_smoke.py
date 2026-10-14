"""Smoke tests that don't need Supabase: schemas, routing fallback, auth bypass."""
import pytest
import respx
import httpx

from app.schemas.orders import OrderCreate
from app.schemas.common import OrderStatus
from app.services import routing


def test_order_create_schema_minimal():
    o = OrderCreate(delivery_address="42 Main St")
    assert o.delivery_address == "42 Main St"
    assert o.items == []


def test_order_status_flow_values():
    assert OrderStatus.received.value == "received"
    assert OrderStatus.delivered.value == "delivered"


@pytest.mark.asyncio
async def test_calculate_route_returns_none_when_unconfigured(monkeypatch):
    monkeypatch.setattr("app.services.routing.settings.maptiler_api_key", "")
    monkeypatch.setattr("app.services.routing.settings.openrouteservice_api_key", "")
    result = await routing.calculate_route((12.97, 77.59), (12.93, 77.62))
    assert result is None


@pytest.mark.asyncio
async def test_calculate_route_maptiler_success(monkeypatch):
    monkeypatch.setattr("app.services.routing.settings.maptiler_api_key", "k")
    monkeypatch.setattr("app.services.routing.settings.openrouteservice_api_key", "")
    with respx.mock:
        respx.get(url__regex=r".*maptiler.*").mock(
            return_value=httpx.Response(
                200,
                json={"routes": [{"distance": 1000, "duration": 300, "geometry": {"type": "LineString", "coordinates": []}}]},
            )
        )
        result = await routing.calculate_route((12.97, 77.59), (12.93, 77.62))
    assert result["distance_m"] == 1000
    assert result["provider"] == "maptiler"


def test_auth_bypass_in_dev(monkeypatch):
    monkeypatch.setattr("app.core.auth.settings.require_auth", False)
    from app.core.auth import require_user

    assert require_user(None) == {"role": "dev-bypass"}
