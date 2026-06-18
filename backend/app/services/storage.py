"""Cloudinary upload helper for proof-of-delivery photos."""
from __future__ import annotations

import logging
from typing import Optional

import cloudinary
import cloudinary.uploader

from app.core.config import settings

logger = logging.getLogger(__name__)

_configured = False


def _configure() -> bool:
    """Configure the Cloudinary SDK once, from env vars."""
    global _configured
    if _configured:
        return True
    if settings.cloudinary_url:
        # The SDK auto-parses CLOUDINARY_URL from the environment.
        cloudinary.config(cloudinary_url=settings.cloudinary_url)
        _configured = True
    elif (
        settings.cloudinary_cloud_name
        and settings.cloudinary_api_key
        and settings.cloudinary_api_secret
    ):
        cloudinary.config(
            cloud_name=settings.cloudinary_cloud_name,
            api_key=settings.cloudinary_api_key,
            api_secret=settings.cloudinary_api_secret,
            secure=True,
        )
        _configured = True
    else:
        logger.info("Cloudinary not configured.")
    return _configured


def upload_pod_photo(file_bytes: bytes, *, public_id: Optional[str] = None) -> Optional[str]:
    """Upload a proof-of-delivery photo and return the secure CDN URL."""
    if not _configure():
        return None
    result = cloudinary.uploader.upload(
        file_bytes,
        folder="bla/pod",
        public_id=public_id,
        resource_type="image",
        overwrite=True,
    )
    return result.get("secure_url")
