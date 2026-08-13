"""Comparison orchestration — ties together S3, file reading, and core logic."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Any

from app.config import Settings
from app.s3 import download_s3_object
from comparison_engine.core import ComparisonError, compare_datasets, dataframe_to_rows
from comparison_engine.file_reader import read_file_to_dataframe


def should_run_async(
    settings: Settings,
    *,
    preload_size_bytes: int,
    postload_size_bytes: int,
    estimated_rows: int | None = None,
) -> bool:
    total_size = preload_size_bytes + postload_size_bytes
    if total_size >= settings.async_file_size_bytes:
        return True
    if estimated_rows is not None and estimated_rows >= settings.async_row_threshold:
        return True
    return False


def run_comparison(
    *,
    settings: Settings,
    bucket: str,
    preload_s3_key: str,
    postload_s3_key: str,
    identifier_columns: list[str],
    compare_columns: list[str] | None = None,
) -> dict[str, Any]:
    work_dir = Path(
        tempfile.mkdtemp(prefix="comparison-", dir=str(settings.download_dir))
    )

    try:
        preload_path = work_dir / Path(preload_s3_key).name
        postload_path = work_dir / Path(postload_s3_key).name

        download_s3_object(bucket, preload_s3_key, preload_path, settings.aws_region)
        download_s3_object(bucket, postload_s3_key, postload_path, settings.aws_region)

        preload_df = read_file_to_dataframe(preload_path)
        postload_df = read_file_to_dataframe(postload_path)

        preload_rows = dataframe_to_rows(preload_df)
        postload_rows = dataframe_to_rows(postload_df)

        config: dict[str, Any] = {"identifierColumns": identifier_columns}
        if compare_columns:
            config["compareColumns"] = compare_columns

        return compare_datasets(preload_rows, postload_rows, config)
    except ComparisonError:
        raise
    except Exception as exc:
        raise ComparisonError(f"Comparison failed: {exc}") from exc
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
