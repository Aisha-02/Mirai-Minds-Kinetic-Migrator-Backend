"""FastAPI application entrypoint."""

from __future__ import annotations

from fastapi import FastAPI

from app.config import Settings
from app.jobs import JobStore
from app.routes import router


def create_app(settings: Settings | None = None) -> FastAPI:
    app_settings = settings or Settings.from_env()
    app = FastAPI(
        title="Comparison Engine",
        description="Directional preload/postload comparison service",
        version="1.0.0",
    )
    app.state.settings = app_settings
    app.state.job_store = JobStore()
    app.include_router(router)
    return app


app = create_app()
