"""Chunked CSV and sheet-by-sheet Excel readers (python-calamine)."""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd

from validation_engine.constants import (
    CSV_CHUNK_THRESHOLD_BYTES,
    DEFAULT_CHUNKSIZE,
    DEFAULT_SAMPLE_ROWS,
)

EXCEL_SUFFIXES = {".xlsx", ".xlsm", ".xls"}
CSV_SUFFIXES = {".csv"}


@dataclass(frozen=True)
class TableRef:
    name: str
    path: Path
    sheet_name: str | None = None

    @property
    def kind(self) -> str:
        return "excel_sheet" if self.sheet_name is not None else "csv"

    @property
    def source_suffix(self) -> str:
        return self.path.suffix.lower() or ".csv"


def discover_tables(source: Path | Sequence[Path]) -> list[TableRef]:
    paths = [source] if isinstance(source, Path) else list(source)
    tables: list[TableRef] = []
    for path in paths:
        path = Path(path)
        if path.is_dir():
            children = sorted(
                p
                for p in path.iterdir()
                if p.suffix.lower() in CSV_SUFFIXES | EXCEL_SUFFIXES
            )
            tables.extend(discover_tables(children))
            continue
        suffix = path.suffix.lower()
        if suffix in CSV_SUFFIXES:
            tables.append(TableRef(name=path.stem, path=path, sheet_name=None))
        elif suffix in EXCEL_SUFFIXES:
            for sheet_name in _excel_sheet_names(path):
                tables.append(TableRef(name=sheet_name, path=path, sheet_name=sheet_name))
        else:
            raise ValueError(f"Unsupported file type: {path}")
    return tables


def peek_table(
    table: TableRef,
    sample_rows: int = DEFAULT_SAMPLE_ROWS,
) -> tuple[list[str], list[dict[str, Any]]]:
    chunk_iter = iter_table_chunks(table, chunksize=max(sample_rows, 1))
    try:
        first = next(chunk_iter)
    except StopIteration:
        return [], []
    columns = [str(c) for c in first.columns]
    records = _records_from_frame(first.head(sample_rows))
    return columns, records


def iter_table_chunks(
    table: TableRef,
    chunksize: int = DEFAULT_CHUNKSIZE,
) -> Iterator[pd.DataFrame]:
    if table.sheet_name is None:
        yield from _iter_csv_chunks(table.path, chunksize)
        return
    yield from _iter_excel_sheet_chunks(table.path, table.sheet_name, chunksize)


def _iter_csv_chunks(path: Path, chunksize: int) -> Iterator[pd.DataFrame]:
    size = path.stat().st_size
    if size <= CSV_CHUNK_THRESHOLD_BYTES:
        frame = pd.read_csv(
            path,
            dtype="string",
            keep_default_na=True,
            skip_blank_lines=True,
        )
        frame = frame.copy()
        frame.columns = [_clean_header(col, idx) for idx, col in enumerate(frame.columns)]
        yield frame
        return

    reader = pd.read_csv(
        path,
        chunksize=chunksize,
        dtype="string",
        keep_default_na=True,
        skip_blank_lines=True,
    )
    for chunk in reader:
        chunk = chunk.copy()
        chunk.columns = [_clean_header(col, idx) for idx, col in enumerate(chunk.columns)]
        yield chunk


def _excel_sheet_names(path: Path) -> list[str]:
    from python_calamine import CalamineWorkbook

    workbook = CalamineWorkbook.from_path(str(path))
    return list(workbook.sheet_names)


def _iter_calamine_rows(path: Path, sheet_name: str) -> Iterator[list[Any]]:
    from python_calamine import CalamineWorkbook

    workbook = CalamineWorkbook.from_path(str(path))
    sheet = workbook.get_sheet_by_name(sheet_name)
    if hasattr(sheet, "iter_rows"):
        for row in sheet.iter_rows():
            yield list(row)
        return
    for row in sheet.to_python(skip_empty_area=True):
        yield list(row)


def _iter_excel_sheet_chunks(
    path: Path,
    sheet_name: str,
    chunksize: int,
) -> Iterator[pd.DataFrame]:
    rows = _iter_calamine_rows(path, sheet_name)
    header_row = None
    for row in rows:
        if _row_has_value(row):
            header_row = row
            break
    if header_row is None:
        return

    columns = [_clean_header(value, idx) for idx, value in enumerate(header_row)]
    batch: list[dict[str, Any]] = []
    for row in rows:
        if not _row_has_value(row):
            continue
        batch.append(_row_to_dict(columns, row))
        if len(batch) >= chunksize:
            yield pd.DataFrame(batch, columns=columns).astype("string")
            batch = []
    if batch:
        yield pd.DataFrame(batch, columns=columns).astype("string")


def _clean_header(value: object, index: int) -> str:
    text = str(value).strip() if value is not None else ""
    return text or f"column_{index + 1}"


def _row_has_value(row: Sequence[Any]) -> bool:
    return any(cell is not None and str(cell).strip() != "" for cell in row)


def _row_to_dict(columns: list[str], row: Sequence[Any]) -> dict[str, Any]:
    record: dict[str, Any] = {}
    for idx, column in enumerate(columns):
        value = row[idx] if idx < len(row) else None
        if value is None:
            record[column] = pd.NA
        else:
            text = str(value).strip()
            record[column] = pd.NA if text == "" else text
    return record


def _records_from_frame(frame: pd.DataFrame) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for row in frame.itertuples(index=False):
        item: dict[str, Any] = {}
        for column, value in zip(frame.columns, row, strict=False):
            item[str(column)] = None if pd.isna(value) else str(value)
        records.append(item)
    return records
