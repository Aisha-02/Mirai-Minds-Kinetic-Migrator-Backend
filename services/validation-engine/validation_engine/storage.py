"""S3 download/upload used by the FastAPI service. Stateless — keys come from Node."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import boto3
from botocore.exceptions import ClientError

from validation_engine.writers import _slug


def get_bucket() -> str:
    return str(os.environ.get("AWS_S3_BUCKET") or "").strip()


def get_region() -> str:
    return (
        os.environ.get("AWS_REGION")
        or os.environ.get("BEDROCK_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or "us-east-1"
    )


def s3_client() -> Any:
    kwargs: dict[str, Any] = {"region_name": get_region()}
    access_key = str(os.environ.get("AWS_ACCESS_KEY_ID") or "").strip()
    secret_key = str(os.environ.get("AWS_SECRET_ACCESS_KEY") or "").strip()
    if access_key and secret_key:
        kwargs["aws_access_key_id"] = access_key
        kwargs["aws_secret_access_key"] = secret_key
    return boto3.client("s3", **kwargs)


def assert_s3_configured() -> str:
    bucket = get_bucket()
    if not bucket:
        raise RuntimeError("AWS_S3_BUCKET is not configured")
    return bucket


def safe_filename(name: str, fallback: str = "input") -> str:
    path = Path(name)
    suffix = path.suffix.lower()
    stem = _slug(path.stem) or fallback
    if suffix in {".csv", ".xlsx", ".xlsm", ".xls"}:
        return f"{stem}{suffix}"
    return f"{stem}{suffix or '.bin'}"


def download_object(key: str, dest: Path, client: Any | None = None) -> Path:
    bucket = assert_s3_configured()
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        (client or s3_client()).download_file(bucket, key, str(dest))
    except ClientError as err:
        raise FileNotFoundError(f"Could not download s3://{bucket}/{key}: {err}") from err
    return dest


def upload_file(
    path: Path,
    key: str,
    content_type: str | None = None,
    client: Any | None = None,
) -> str:
    bucket = assert_s3_configured()
    extra: dict[str, Any] = {}
    if content_type:
        extra["ContentType"] = content_type
    kwargs: dict[str, Any] = {}
    if extra:
        kwargs["ExtraArgs"] = extra
    (client or s3_client()).upload_file(str(path), bucket, key, **kwargs)
    return key


def content_type_for_path(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return "text/csv; charset=utf-8"
    if suffix in {".xlsx", ".xlsm"}:
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    return "application/octet-stream"


def parsed_output_key(job_id: str, filename: str) -> str:
    safe_job = _slug(job_id)
    return f"generated/validation/{safe_job}/parsed/{Path(filename).name}"
