"""Tests for the comparator module."""

from __future__ import annotations

import sys
from pathlib import Path

import polars as pl
import pytest

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from comparator import compare_datasets, compare_multi_sheet


def _sample_frames() -> tuple[pl.DataFrame, pl.DataFrame]:
    source = pl.DataFrame(
        {
            "id": ["1", "2", "3"],
            "name": ["Alpha", "Beta", "Gamma"],
            "amount": [100, 200, 300],
        }
    )
    target = pl.DataFrame(
        {
            "id": ["1", "2", "3"],
            "name": ["Alpha", "Beta", "Gamma"],
            "amount": [100, 200, 300],
        }
    )
    return source, target


def test_compare_datasets_exact_match() -> None:
    source, target = _sample_frames()

    result = compare_datasets(source, target, key_columns=["id"])

    assert result.summary.only_in_source_count == 0
    assert result.summary.only_in_target_count == 0
    assert result.summary.matched_count == 3
    assert result.summary.field_mismatch_count == 0
    assert result.field_mismatches == []


def test_compare_datasets_missing_in_target() -> None:
    source, target = _sample_frames()
    target = target.filter(pl.col("id") != "3")

    result = compare_datasets(source, target, key_columns=["id"])

    assert result.summary.only_in_source_count == 1
    assert result.summary.only_in_target_count == 0
    assert result.only_in_source_total == 1
    assert result.only_in_source[0]["id"] == "3"


def test_compare_datasets_missing_in_source() -> None:
    source, target = _sample_frames()
    source = source.filter(pl.col("id") != "1")

    result = compare_datasets(source, target, key_columns=["id"])

    assert result.summary.only_in_source_count == 0
    assert result.summary.only_in_target_count == 1
    assert result.only_in_target_total == 1
    assert result.only_in_target[0]["id"] == "1"


def test_compare_datasets_field_mismatches() -> None:
    source, target = _sample_frames()
    target = target.with_columns(
        pl.when(pl.col("id") == "2")
        .then(pl.lit("Bravo"))
        .otherwise(pl.col("name"))
        .alias("name")
    )

    result = compare_datasets(source, target, key_columns=["id"])

    assert result.summary.field_mismatch_count == 1
    assert len(result.field_mismatches) == 1
    mismatch = result.field_mismatches[0]
    assert mismatch.column == "name"
    assert mismatch.key_values == {"id": "2"}
    assert mismatch.source_value == "Beta"
    assert mismatch.target_value == "Bravo"


def test_compare_datasets_normalizes_key_types() -> None:
    source = pl.DataFrame({"id": [1, 2], "name": ["A", "B"]})
    target = pl.DataFrame({"id": ["1", "2"], "name": ["A", "B"]})

    result = compare_datasets(source, target, key_columns=["id"])

    assert result.summary.matched_count == 2
    assert result.summary.only_in_source_count == 0
    assert result.summary.only_in_target_count == 0


def test_compare_datasets_caps_results_but_returns_totals() -> None:
    source = pl.DataFrame({"id": [str(i) for i in range(5)], "name": ["A"] * 5})
    target = pl.DataFrame({"id": ["99"], "name": ["Z"]})

    result = compare_datasets(source, target, key_columns=["id"], result_limit=2)

    assert result.only_in_source_total == 5
    assert len(result.only_in_source) == 2


def test_compare_multi_sheet_with_unmatched_sheet() -> None:
    source_sheets = {
        "Material Master": pl.DataFrame({"matnr": ["100"], "name": ["Bolt"]}),
        "Sales Order": pl.DataFrame({"vbeln": ["500"], "amount": [10]}),
    }
    target_sheets = {
        "Material Master": pl.DataFrame({"matnr": ["100"], "name": ["Bolt"]}),
    }

    def resolver(sheet_name: str) -> list[str]:
        return {"Material Master": ["matnr"], "Sales Order": ["vbeln"]}[sheet_name]

    result = compare_multi_sheet(source_sheets, target_sheets, resolver)

    assert set(result.sheets.keys()) == {"Material Master"}
    assert result.sheets["Material Master"].summary.matched_count == 1
    assert len(result.unmatched_sheets) == 1
    assert result.unmatched_sheets[0].sheet_name == "Sales Order"
    assert result.unmatched_sheets[0].present_in == "source"
