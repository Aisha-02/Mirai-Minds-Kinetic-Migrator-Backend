"""In-memory async job tracking for large comparisons."""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any


class JobStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class ComparisonJob:
    job_id: str
    batch_id: str
    status: JobStatus = JobStatus.PENDING
    progress: int = 0
    result: dict[str, Any] | None = None
    error: str | None = None
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    updated_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "jobId": self.job_id,
            "batchId": self.batch_id,
            "status": self.status.value,
            "progress": self.progress,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }
        if self.result is not None:
            payload["result"] = self.result
        if self.error is not None:
            payload["error"] = self.error
        return payload


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, ComparisonJob] = {}
        self._lock = threading.Lock()

    def create(self, batch_id: str) -> ComparisonJob:
        job = ComparisonJob(job_id=str(uuid.uuid4()), batch_id=batch_id)
        with self._lock:
            self._jobs[job.job_id] = job
        return job

    def get(self, job_id: str) -> ComparisonJob | None:
        with self._lock:
            return self._jobs.get(job_id)

    def update(
        self,
        job_id: str,
        *,
        status: JobStatus | None = None,
        progress: int | None = None,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> ComparisonJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            if status is not None:
                job.status = status
            if progress is not None:
                job.progress = progress
            if result is not None:
                job.result = result
            if error is not None:
                job.error = error
            job.updated_at = datetime.now(timezone.utc).isoformat()
            return job
