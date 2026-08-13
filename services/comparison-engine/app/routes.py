"""FastAPI route handlers."""

from __future__ import annotations

import threading
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.auth import require_internal_api_key
from app.config import Settings
from app.jobs import JobStatus, JobStore
from app.s3 import get_s3_object_size
from app.service import run_comparison, should_run_async
from comparison_engine.core import ComparisonError

router = APIRouter()


class CompareRequest(BaseModel):
    preloadS3Key: str = Field(..., min_length=1)
    postloadS3Key: str = Field(..., min_length=1)
    keyField: str = Field(..., min_length=1)
    bucket: str = Field(..., min_length=1)
    batchId: str = Field(..., min_length=1)
    identifierColumns: list[str] | None = None
    compareColumns: list[str] | None = None
    forceAsync: bool = False

    def resolved_identifier_columns(self) -> list[str]:
        if self.identifierColumns:
            return self.identifierColumns
        return [self.keyField]


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_job_store(request: Request) -> JobStore:
    return request.app.state.job_store


def _verify_api_key(
    settings: Settings = Depends(get_settings),
    x_internal_api_key: str | None = Header(default=None, alias="X-Internal-Api-Key"),
) -> None:
    require_internal_api_key(settings, x_internal_api_key)


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/compare", dependencies=[Depends(_verify_api_key)])
def compare(
    body: CompareRequest,
    settings: Settings = Depends(get_settings),
    job_store: JobStore = Depends(get_job_store),
) -> dict[str, Any]:
    try:
        preload_size = get_s3_object_size(
            body.bucket, body.preloadS3Key, settings.aws_region
        )
        postload_size = get_s3_object_size(
            body.bucket, body.postloadS3Key, settings.aws_region
        )
    except ComparisonError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    run_async = body.forceAsync or should_run_async(
        settings,
        preload_size_bytes=preload_size,
        postload_size_bytes=postload_size,
    )

    if run_async:
        job = job_store.create(body.batchId)
        thread = threading.Thread(
            target=_run_job,
            args=(job.job_id, body, settings, job_store),
            daemon=True,
        )
        thread.start()
        return {
            "async": True,
            "jobId": job.job_id,
            "batchId": body.batchId,
            "status": JobStatus.PENDING.value,
        }

    try:
        result = run_comparison(
            settings=settings,
            bucket=body.bucket,
            preload_s3_key=body.preloadS3Key,
            postload_s3_key=body.postloadS3Key,
            identifier_columns=body.resolved_identifier_columns(),
            compare_columns=body.compareColumns,
        )
    except ComparisonError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    return {
        "async": False,
        "batchId": body.batchId,
        "result": result,
    }


@router.get("/compare/{job_id}/status", dependencies=[Depends(_verify_api_key)])
def compare_status(
    job_id: str,
    job_store: JobStore = Depends(get_job_store),
) -> dict[str, Any]:
    job = job_store.get(job_id)
    if not job:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Job not found: {job_id}",
        )
    return job.to_dict()


def _run_job(
    job_id: str,
    body: CompareRequest,
    settings: Settings,
    job_store: JobStore,
) -> None:
    job_store.update(job_id, status=JobStatus.PROCESSING, progress=10)
    try:
        result = run_comparison(
            settings=settings,
            bucket=body.bucket,
            preload_s3_key=body.preloadS3Key,
            postload_s3_key=body.postloadS3Key,
            identifier_columns=body.resolved_identifier_columns(),
            compare_columns=body.compareColumns,
        )
        job_store.update(
            job_id,
            status=JobStatus.COMPLETED,
            progress=100,
            result=result,
        )
    except ComparisonError as exc:
        job_store.update(
            job_id,
            status=JobStatus.FAILED,
            progress=100,
            error=str(exc),
        )
    except Exception as exc:
        job_store.update(
            job_id,
            status=JobStatus.FAILED,
            progress=100,
            error=f"Unexpected error: {exc}",
        )
