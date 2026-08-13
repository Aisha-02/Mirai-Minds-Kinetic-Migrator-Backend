"""Unit tests for directional comparison logic (mirrors Node comparisonEngine.js scenarios)."""

from __future__ import annotations

import pytest

from comparison_engine.core import ComparisonError, compare_datasets

IDENTIFIER_CONFIG = {"identifierColumns": ["MATNR"]}


class TestCompareDatasets:
    def test_no_differences(self) -> None:
        preload = [
            {"MATNR": "100", "NAME": "Alpha", "QTY": 5},
            {"MATNR": "200", "NAME": "Beta", "QTY": 10},
        ]
        postload = [
            {"MATNR": "100", "NAME": "Alpha", "QTY": 5},
            {"MATNR": "200", "NAME": "Beta", "QTY": 10},
        ]

        result = compare_datasets(preload, postload, IDENTIFIER_CONFIG)

        assert result["missingRecords"] == []
        assert result["missingValues"] == []
        assert result["valueMismatches"] == []
        assert result["duplicateRecords"] == []
        assert result["baselineDuplicates"] == []
        assert result["extraRecords"] == []

    def test_missing_records(self) -> None:
        preload = [
            {"MATNR": "100", "NAME": "Alpha"},
            {"MATNR": "300", "NAME": "Gamma"},
        ]
        postload = [{"MATNR": "100", "NAME": "Alpha"}]

        result = compare_datasets(preload, postload, IDENTIFIER_CONFIG)

        assert len(result["missingRecords"]) == 1
        assert result["missingRecords"][0]["identifier"] == "300"
        assert result["missingRecords"][0]["record"]["NAME"] == "Gamma"

    def test_missing_values(self) -> None:
        preload = [{"MATNR": "100", "NAME": "Alpha", "QTY": 5}]
        postload = [{"MATNR": "100", "NAME": "Alpha", "QTY": ""}]

        result = compare_datasets(preload, postload, IDENTIFIER_CONFIG)

        assert len(result["missingValues"]) == 1
        assert result["missingValues"][0]["field"] == "QTY"
        assert result["missingValues"][0]["expectedValue"] == 5

    def test_value_mismatches(self) -> None:
        preload = [{"MATNR": "100", "NAME": "Alpha", "QTY": 5}]
        postload = [{"MATNR": "100", "NAME": "Alpha", "QTY": 9}]

        result = compare_datasets(preload, postload, IDENTIFIER_CONFIG)

        assert len(result["valueMismatches"]) == 1
        assert result["valueMismatches"][0]["field"] == "QTY"
        assert result["valueMismatches"][0]["expectedValue"] == 5
        assert result["valueMismatches"][0]["actualValue"] == 9

    def test_duplicate_records_in_postload(self) -> None:
        preload = [{"MATNR": "100", "NAME": "Alpha"}]
        postload = [
            {"MATNR": "100", "NAME": "Alpha"},
            {"MATNR": "100", "NAME": "Alpha Copy"},
        ]

        result = compare_datasets(preload, postload, IDENTIFIER_CONFIG)

        assert len(result["duplicateRecords"]) == 1
        assert result["duplicateRecords"][0]["count"] == 2
        assert len(result["duplicateRecords"][0]["records"]) == 2

    def test_baseline_duplicates_in_preload(self) -> None:
        preload = [
            {"MATNR": "100", "NAME": "Alpha", "QTY": 5},
            {"MATNR": "100", "NAME": "Alpha Duplicate", "QTY": 5},
        ]
        postload = [{"MATNR": "100", "NAME": "Alpha", "QTY": 5}]

        result = compare_datasets(preload, postload, IDENTIFIER_CONFIG)

        assert len(result["baselineDuplicates"]) == 1
        assert result["valueMismatches"] == []
        assert result["missingValues"] == []

    def test_extra_records(self) -> None:
        preload = [{"MATNR": "100", "NAME": "Alpha"}]
        postload = [
            {"MATNR": "100", "NAME": "Alpha"},
            {"MATNR": "999", "NAME": "Unexpected"},
        ]

        result = compare_datasets(preload, postload, IDENTIFIER_CONFIG)

        assert len(result["extraRecords"]) == 1
        assert result["extraRecords"][0]["identifier"] == "999"

    def test_missing_key_field_raises(self) -> None:
        preload = [{"MATNR": "100", "NAME": "Alpha"}]
        postload = [{"NAME": "Alpha"}]

        with pytest.raises(ComparisonError, match="missing required key field"):
            compare_datasets(preload, postload, IDENTIFIER_CONFIG)

    def test_extra_data_in_postload_field_is_not_flagged(self) -> None:
        preload = [{"MATNR": "100", "NAME": "Alpha", "NOTES": ""}]
        postload = [{"MATNR": "100", "NAME": "Alpha", "NOTES": "filled in postload"}]

        result = compare_datasets(preload, postload, IDENTIFIER_CONFIG)

        assert result["missingValues"] == []
        assert result["valueMismatches"] == []

    def test_mismatched_columns_uses_shared_non_key_columns(self) -> None:
        preload = [
            {
                "MATNR": "100",
                "NAME": "Alpha",
                "ONLY_PRELOAD": "x",
            }
        ]
        postload = [
            {
                "MATNR": "100",
                "NAME": "Changed",
                "ONLY_POSTLOAD": "y",
            }
        ]

        result = compare_datasets(preload, postload, IDENTIFIER_CONFIG)

        assert len(result["valueMismatches"]) == 1
        assert result["valueMismatches"][0]["field"] == "NAME"
