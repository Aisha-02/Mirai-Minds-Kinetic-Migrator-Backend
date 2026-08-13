"""Read xlsx/csv files into pandas DataFrames via python-calamine."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
from python_calamine import CalamineWorkbook

from comparison_engine.core import ComparisonError


def read_file_to_dataframe(path: str | Path) -> pd.DataFrame:
    file_path = Path(path)
    if not file_path.exists():
        raise ComparisonError(f"File not found: {file_path}")

    suffix = file_path.suffix.lower()
    if suffix not in {".xlsx", ".xls", ".xlsm", ".csv", ".tsv"}:
        raise ComparisonError(
            f"Unsupported file type '{suffix}'. Expected .xlsx, .xls, .csv, or .tsv."
        )

    try:
        workbook = CalamineWorkbook.from_path(str(file_path))
        sheet = workbook.get_sheet_by_index(0)
        raw_rows = sheet.to_python()
    except Exception as exc:
        raise ComparisonError(f"Failed to read file '{file_path.name}': {exc}") from exc

    if not raw_rows:
        return pd.DataFrame()

    header_row = raw_rows[0]
    headers = [
        str(cell).strip() if cell is not None and str(cell).strip() != "" else f"column_{index}"
        for index, cell in enumerate(header_row)
    ]
    data_rows = raw_rows[1:] if len(raw_rows) > 1 else []

    try:
        frame = pd.DataFrame(data_rows, columns=headers)
    except Exception as exc:
        raise ComparisonError(
            f"Failed to parse tabular data from '{file_path.name}': {exc}"
        ) from exc

    return frame
