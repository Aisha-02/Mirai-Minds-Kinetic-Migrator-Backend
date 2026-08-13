"""Tests for the parsing module."""

from __future__ import annotations

import sys
from pathlib import Path

import polars as pl
import pytest

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from exceptions import UnsupportedFileTypeError
from parsing import parse_file


def test_parse_single_sheet_csv(tmp_path: Path) -> None:
  """CSV files return a single normalized DataFrame."""
  csv_path = tmp_path / "customers.csv"
  csv_path.write_text(
    "Customer Name,Record Count\nAcme Corp,3\nBeta LLC,5\nGamma Inc,2\n",
    encoding="utf-8",
  )

  result = parse_file(csv_path)

  assert isinstance(result, pl.DataFrame)
  assert result.columns == ["customer_name", "record_count"]
  assert result.shape == (3, 2)
  assert result["customer_name"].to_list() == ["Acme Corp", "Beta LLC", "Gamma Inc"]


def test_parse_single_sheet_excel(tmp_path: Path) -> None:
  """Single-sheet Excel workbooks unwrap to a DataFrame."""
  excel_path = tmp_path / "customer_master.xlsx"
  pl.DataFrame(
    {
      " Material Number ": ["1001", "1002"],
      "Plant Code": ["1000", "2000"],
    }
  ).write_excel(excel_path)

  result = parse_file(excel_path)

  assert isinstance(result, pl.DataFrame)
  assert result.columns == ["material_number", "plant_code"]
  assert result.shape == (2, 2)


def _write_multi_sheet_excel(
  path: Path,
  sheets: dict[str, pl.DataFrame],
) -> None:
  """Create a multi-sheet workbook for tests using xlsxwriter."""
  import xlsxwriter

  workbook = xlsxwriter.Workbook(str(path))
  try:
    for sheet_name, frame in sheets.items():
      worksheet = workbook.add_worksheet(sheet_name)
      worksheet.write_row(0, 0, frame.columns)
      for row_index, row in enumerate(frame.rows(), start=1):
        worksheet.write_row(row_index, 0, list(row))
  finally:
    workbook.close()


def test_parse_multi_sheet_excel(tmp_path: Path) -> None:
  """Multi-sheet Excel workbooks return one DataFrame per sheet."""
  excel_path = tmp_path / "business_objects.xlsx"
  customer_df = pl.DataFrame({"Customer ID": ["C1", "C2"], "Name": ["Alice", "Bob"]})
  vendor_df = pl.DataFrame({"Vendor ID": ["V1"], "Name": ["SupplyCo"]})

  _write_multi_sheet_excel(
    excel_path,
    {
      "Customer Master": customer_df,
      "Vendor Master": vendor_df,
    },
  )

  result = parse_file(excel_path)

  assert isinstance(result, dict)
  assert set(result.keys()) == {"Customer Master", "Vendor Master"}
  assert result["Customer Master"].shape == (2, 2)
  assert result["Vendor Master"].shape == (1, 2)
  assert result["Customer Master"].columns == ["customer_id", "name"]
  assert result["Vendor Master"].columns == ["vendor_id", "name"]
  assert result["Customer Master"]["customer_id"].to_list() == ["C1", "C2"]
  assert result["Vendor Master"]["vendor_id"].to_list() == ["V1"]


def test_unsupported_file_type(tmp_path: Path) -> None:
  """Unsupported extensions raise a descriptive error."""
  txt_path = tmp_path / "notes.txt"
  txt_path.write_text("not a spreadsheet", encoding="utf-8")

  with pytest.raises(UnsupportedFileTypeError) as exc_info:
    parse_file(txt_path)

  assert exc_info.value.extension == ".txt"


def test_parse_csv_from_bytes_with_filename() -> None:
  """Bytes input uses filename to detect CSV format."""
  payload = b"Status,Count\nOpen,4\nClosed,9\n"

  result = parse_file(payload, filename="status.csv")

  assert isinstance(result, pl.DataFrame)
  assert result.columns == ["status", "count"]
  assert result.shape == (2, 2)


def test_parse_csv_lazy_returns_lazy_frame(tmp_path: Path) -> None:
  """Lazy CSV parsing returns a LazyFrame without loading all rows."""
  csv_path = tmp_path / "large.csv"
  csv_path.write_text("Value\n1\n2\n3\n", encoding="utf-8")

  result = parse_file(csv_path, lazy=True)

  assert isinstance(result, pl.LazyFrame)
  collected = result.collect()
  assert collected.shape == (3, 1)
  assert collected.columns == ["value"]
