"""Application configuration from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    internal_api_key: str
    aws_region: str
    download_dir: Path
    async_row_threshold: int
    async_file_size_bytes: int

    @classmethod
    def from_env(cls) -> Settings:
        download_dir = Path(
            os.getenv("COMPARISON_DOWNLOAD_DIR", "/tmp/comparison-engine")
        )
        return cls(
            host=os.getenv("COMPARISON_HOST", "0.0.0.0"),
            port=int(os.getenv("COMPARISON_PORT", "8080")),
            internal_api_key=os.getenv("COMPARISON_INTERNAL_API_KEY", ""),
            aws_region=os.getenv("AWS_REGION", "ap-northeast-1"),
            download_dir=download_dir,
            async_row_threshold=int(
                os.getenv("COMPARISON_ASYNC_ROW_THRESHOLD", "50000")
            ),
            async_file_size_bytes=int(
                os.getenv("COMPARISON_ASYNC_FILE_SIZE_BYTES", str(10 * 1024 * 1024))
            ),
        )
