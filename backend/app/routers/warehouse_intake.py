from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import get_current_user
from app.core.supabase_client import get_supabase
from app.services.warehouse_intake import intake_parcel, WarehouseIntakeCreate, WarehouseIntakeOut

router = APIRouter(prefix="/warehouse-intake", tags=["warehouse-intake"])


@router.post("/", response_model=WarehouseIntakeOut)
async def create_parcel_intake(
    payload: WarehouseIntakeCreate,
    user: dict = Depends(get_current_user),
):
    """Create a new parcel intake with district-based routing."""
    sb = get_supabase()
    result = intake_parcel(payload, user)
    return result