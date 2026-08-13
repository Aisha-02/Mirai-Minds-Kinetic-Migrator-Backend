"""Shared-secret authentication for internal service-to-service calls."""

from __future__ import annotations

from fastapi import Header, HTTPException, status

from app.config import Settings


def require_internal_api_key(
    settings: Settings,
    x_internal_api_key: str | None = Header(default=None, alias="X-Internal-Api-Key"),
) -> None:
    if not settings.internal_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Comparison service API key is not configured",
        )

    if not x_internal_api_key or x_internal_api_key != settings.internal_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-Internal-Api-Key",
        )
