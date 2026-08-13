"""File parsing utilities for SAP migration data validation."""

from __future__ import annotations

import io
import re
from pathlib import Path
from typing import IO, BinaryIO, Union

import polars as pl

from exceptions import (
    CorruptedFileError,
    EmptySheetError,
    LazyModeNotSupportedError,
    MissingFilenameError,
    ParseError,
    ParseFileNotFoundError,
    UnsupportedFileTypeError,
)

ALLOWED_EXTENSIONS: tuple[str, ...] = (".csv", ".xlsx", ".xls")
CSV_EXTENSIONS: frozenset[str] = frozenset({".csv"})
EXCEL_EXTENSIONS: frozenset[str] = frozenset({".xlsx", ".xls"})

FileSource = Union[str, Path, bytes, IO[bytes], BinaryIO]
ReadableSource = Union[str, Path, bytes, IO[bytes], BinaryIO]


def parse_file(
    source: FileSource,
    *,
    filename: str | None = None,
    lazy: bool = False,
    normalize_columns: bool = True,
) -> pl.DataFrame | dict[str, pl.DataFrame] | pl.LazyFrame:
    """
    Parse a CSV or Excel file into Polars DataFrame(s).

    Args:
        source: File path or raw bytes. When bytes, ``filename`` must be provided.
        filename: Original filename used to detect extension for bytes input.
        lazy: When True, CSV files are returned as a ``LazyFrame`` via ``scan_csv``.
            Excel does not support lazy mode.
        normalize_columns: Strip whitespace and convert headers to snake_case.

    Returns:
        A single ``DataFrame`` for CSV or single-sheet Excel, a ``LazyFrame`` for
        lazy CSV, or a ``dict[str, DataFrame]`` for multi-sheet Excel workbooks.

    Raises:
        MissingFilenameError: bytes input without ``filename``.
        ParseFileNotFoundError: Path does not exist.
        UnsupportedFileTypeError: Extension is not .csv, .xlsx, or .xls.
        LazyModeNotSupportedError: ``lazy=True`` with Excel input.
        CorruptedFileError: File cannot be parsed.
        EmptySheetError: A sheet contains no data rows.
    """
    extension = _resolve_extension(source, filename)
    resolved = _open_source(source, filename, extension=extension)

    if extension in CSV_EXTENSIONS:
        return _parse_csv(resolved, lazy=lazy, normalize_columns=normalize_columns)

    if extension in EXCEL_EXTENSIONS:
        if lazy:
            raise LazyModeNotSupportedError(extension)
        return _parse_excel(resolved, normalize_columns=normalize_columns)

    raise UnsupportedFileTypeError(extension, allowed=ALLOWED_EXTENSIONS)


def _is_file_like(source: FileSource) -> bool:
    return hasattr(source, "read") and not isinstance(source, (str, Path, bytes))


def _resolve_extension(source: FileSource, filename: str | None) -> str:
    """Return a lowercase file extension including the leading dot."""
    if isinstance(source, bytes) or _is_file_like(source):
        if not filename:
            raise MissingFilenameError()
        return Path(filename).suffix.lower()

    path = Path(source)
    extension = path.suffix.lower()
    if not extension and filename:
        extension = Path(filename).suffix.lower()
    return extension


def _open_source(
    source: FileSource,
    filename: str | None,
    *,
    extension: str | None = None,
) -> ReadableSource:
    """Validate and return a source Polars can read."""
    if isinstance(source, bytes):
        return io.BytesIO(source)

    if _is_file_like(source):
        if extension in EXCEL_EXTENSIONS:
            source.seek(0)
            return io.BytesIO(source.read())
        source.seek(0)
        return source

    path = Path(source)
    if not path.exists():
        raise ParseFileNotFoundError(str(path))
    return path


def _normalize_column_name(name: str, *, enabled: bool) -> str:
    """Strip whitespace and optionally convert a header to snake_case."""
    stripped = str(name).strip()
    if not enabled:
        return stripped

    lowered = stripped.lower()
    snake = re.sub(r"[^a-z0-9]+", "_", lowered)
    return snake.strip("_")


def _normalize_columns(df: pl.DataFrame, enabled: bool) -> pl.DataFrame:
    """Rename DataFrame columns after stripping and optional snake_case conversion."""
    if not df.columns:
        return df

    renamed = {
        column: _normalize_column_name(column, enabled=enabled)
        for column in df.columns
    }
    return df.rename(renamed)


def _ensure_not_empty(df: pl.DataFrame, *, sheet_name: str | None = None) -> pl.DataFrame:
    """Raise when a parsed sheet has no rows."""
    if df.height == 0:
        raise EmptySheetError(sheet_name=sheet_name)
    return df


def _parse_csv(
    source: ReadableSource,
    *,
    lazy: bool,
    normalize_columns: bool,
) -> pl.DataFrame | pl.LazyFrame:
    """Parse a CSV file eagerly or lazily."""
    read_kwargs = {
        "infer_schema_length": 10_000,
        "try_parse_dates": True,
    }

    try:
        if lazy:
            lazy_frame = pl.scan_csv(source, **read_kwargs)
            if not normalize_columns:
                return lazy_frame

            schema = lazy_frame.collect_schema()
            renamed = {
                column: _normalize_column_name(column, enabled=True)
                for column in schema.names()
            }
            return lazy_frame.rename(renamed)

        df = pl.read_csv(source, **read_kwargs)
        df = _normalize_columns(df, normalize_columns)
        return _ensure_not_empty(df)
    except ParseError:
        raise
    except Exception as exc:
        raise CorruptedFileError(
            "Failed to parse CSV file",
            cause=exc,
        ) from exc


def _parse_excel(
    source: ReadableSource,
    *,
    normalize_columns: bool,
) -> pl.DataFrame | dict[str, pl.DataFrame]:
    """Parse all sheets from an Excel workbook without merging them."""
    try:
        sheets = pl.read_excel(
            source,
            sheet_id=0,
            engine="calamine",
            raise_if_empty=True,
        )
    except ParseError:
        raise
    except Exception as exc:
        raise CorruptedFileError(
            "Failed to parse Excel file",
            cause=exc,
        ) from exc

    if not isinstance(sheets, dict):
        sheets = {"Sheet1": sheets}

    normalized: dict[str, pl.DataFrame] = {}
    for sheet_name, frame in sheets.items():
        if not isinstance(frame, pl.DataFrame):
            raise CorruptedFileError(
                f"Unexpected sheet payload for '{sheet_name}'"
            )
        frame = _normalize_columns(frame, normalize_columns)
        normalized[sheet_name] = _ensure_not_empty(frame, sheet_name=sheet_name)

    if len(normalized) == 1:
        return next(iter(normalized.values()))

    return normalized
