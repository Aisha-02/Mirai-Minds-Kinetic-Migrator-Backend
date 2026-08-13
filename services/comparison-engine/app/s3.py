"""S3 download helpers."""

from __future__ import annotations

from pathlib import Path

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from comparison_engine.core import ComparisonError


def _s3_client(region: str):
    return boto3.client("s3", region_name=region)


def get_s3_object_size(bucket: str, key: str, region: str) -> int:
    client = _s3_client(region)
    try:
        response = client.head_object(Bucket=bucket, Key=key)
    except (BotoCoreError, ClientError) as exc:
        raise ComparisonError(f"Failed to inspect s3://{bucket}/{key}: {exc}") from exc
    return int(response.get("ContentLength") or 0)


def download_s3_object(bucket: str, key: str, destination: Path, region: str) -> Path:
    if not bucket or not key:
        raise ComparisonError("bucket and S3 key are required")

    destination.parent.mkdir(parents=True, exist_ok=True)

    client = _s3_client(region)
    try:
        client.download_file(bucket, key, str(destination))
    except (BotoCoreError, ClientError) as exc:
        raise ComparisonError(f"Failed to download s3://{bucket}/{key}: {exc}") from exc

    if not destination.exists() or destination.stat().st_size == 0:
        raise ComparisonError(f"Downloaded file is empty: s3://{bucket}/{key}")

    return destination
