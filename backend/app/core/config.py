"""Application configuration via pydantic-settings.

All secrets are read from environment variables (see .env.example).
Nothing is hardcoded. In production these are set in the Render dashboard.
"""
from functools import lru_cache
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- App ---------------------------------------------------------------
    app_name: str = "BLA Delivery Operations API"
    environment: str = Field(default="development")
    debug: bool = Field(default=False)
    # Comma-separated list of allowed CORS origins (frontends).
    cors_origins: str = Field(default="*")

    # --- Supabase ----------------------------------------------------------
    supabase_url: str = Field(default="", validation_alias="SUPABASE_URL")
    supabase_anon_key: str = Field(default="", validation_alias="SUPABASE_ANON_KEY")
    # Service key bypasses RLS — used ONLY by this trusted backend.
    supabase_service_key: str = Field(default="", validation_alias="SUPABASE_SERVICE_KEY")

    # --- Mapping / routing -------------------------------------------------
    maptiler_api_key: str = Field(default="", validation_alias="MAPTILER_API_KEY")
    openrouteservice_api_key: str = Field(
        default="", validation_alias="OPENROUTESERVICE_API_KEY"
    )

    # --- Cloudinary (proof-of-delivery photos) -----------------------------
    # Either provide CLOUDINARY_URL or the individual cloud name/key/secret.
    cloudinary_url: Optional[str] = Field(default=None, validation_alias="CLOUDINARY_URL")
    cloudinary_cloud_name: Optional[str] = Field(
        default=None, validation_alias="CLOUDINARY_CLOUD_NAME"
    )
    cloudinary_api_key: Optional[str] = Field(
        default=None, validation_alias="CLOUDINARY_API_KEY"
    )
    cloudinary_api_secret: Optional[str] = Field(
        default=None, validation_alias="CLOUDINARY_API_SECRET"
    )

    # --- EmailJS (transactional email) -------------------------------------
    emailjs_service_id: str = Field(default="", validation_alias="EMAILJS_SERVICE_ID")
    emailjs_template_id: str = Field(default="", validation_alias="EMAILJS_TEMPLATE_ID")
    emailjs_user_id: str = Field(default="", validation_alias="EMAILJS_USER_ID")
    # Private key is required for server-side ("strict mode") API calls.
    emailjs_private_key: str = Field(default="", validation_alias="EMAILJS_PRIVATE_KEY")

    # --- Textlocal (SMS) ---------------------------------------------------
    textlocal_api_key: str = Field(default="", validation_alias="TEXTLOCAL_API_KEY")
    textlocal_sender: str = Field(default="TXTLCL", validation_alias="TEXTLOCAL_SENDER")

    # --- Redis (DEFERRED — only needed for multi-instance scaling) ---------
    # When you add a Render load balancer + multiple web instances, set this to
    # the Render-managed Redis URL. Until then it stays empty and the app runs
    # as a single instance with in-process state only.
    redis_url: Optional[str] = Field(default=None, validation_alias="REDIS_URL")

    @property
    def cors_origin_list(self) -> list[str]:
        if self.cors_origins.strip() == "*":
            return ["*"]
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
