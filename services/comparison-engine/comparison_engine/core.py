"""
Directional comparison: postload is validated against preload (baseline).
Pure functions — no S3, HTTP, or FastAPI dependencies.
Mirrors src/services/comparisonEngine.js output shape.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

import pandas as pd

IDENTIFIER_SEPARATOR = "\u0001"


class ComparisonError(ValueError):
    """Raised when comparison inputs are invalid."""


@dataclass
class ComparisonConfig:
    identifier_columns: list[str]
    compare_columns: list[str] | None = None

    @classmethod
    def from_dict(cls, config: Mapping[str, Any] | None) -> ComparisonConfig:
        if not config:
            raise ComparisonError("config.identifierColumns is required")

        raw_id = config.get("identifierColumns") or config.get("identifier_columns")
        if raw_id is None:
            raise ComparisonError("config.identifierColumns is required")

        identifier_columns = _as_list(raw_id)
        if not identifier_columns:
            raise ComparisonError("config.identifierColumns is required")

        raw_compare = config.get("compareColumns") or config.get("compare_columns")
        compare_columns = _as_list(raw_compare) if raw_compare is not None else None

        return cls(
            identifier_columns=identifier_columns,
            compare_columns=compare_columns or None,
        )


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    return [str(item) for item in value]


def is_empty_value(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, float) and math.isnan(value):
        return True
    if pd.isna(value):
        return True
    if isinstance(value, str) and value.strip() == "":
        return True
    return False


def values_equal(a: Any, b: Any) -> bool:
    if is_empty_value(a) and is_empty_value(b):
        return True
    if is_empty_value(a) or is_empty_value(b):
        return False
    return str(a) == str(b)


def build_identifier(
    row: Mapping[str, Any], identifier_columns: Sequence[str]
) -> tuple[str, Any]:
    columns = list(identifier_columns)
    if not columns:
        raise ComparisonError("config.identifierColumns is required")

    parts: list[str] = []
    for col in columns:
        value = row.get(col) if row else None
        parts.append("" if is_empty_value(value) else str(value))

    key = IDENTIFIER_SEPARATOR.join(parts)

    if len(columns) == 1:
        col = columns[0]
        raw = row.get(col) if row else None
        identifier = None if is_empty_value(raw) else raw
    else:
        identifier = {
            col: (None if is_empty_value(row.get(col)) else row.get(col))
            for col in columns
        }

    return key, identifier


def normalize_cell(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if pd.isna(value):
        return None
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if hasattr(value, "item") and callable(value.item):
        try:
            return normalize_cell(value.item())
        except (ValueError, TypeError):
            pass
    if isinstance(value, str) and value.strip() == "":
        return None
    return value


def dataframe_to_rows(df: pd.DataFrame) -> list[dict[str, Any]]:
    if df.empty:
        return []

    rows: list[dict[str, Any]] = []
    for record in df.to_dict(orient="records"):
        rows.append({str(k): normalize_cell(v) for k, v in record.items()})
    return rows


def validate_identifier_columns(
    preload_rows: Sequence[Mapping[str, Any]],
    postload_rows: Sequence[Mapping[str, Any]],
    identifier_columns: Sequence[str],
) -> None:
    for label, rows in (("preload", preload_rows), ("postload", postload_rows)):
        if not rows:
            continue
        sample = rows[0]
        missing = [col for col in identifier_columns if col not in sample]
        if missing:
            joined = ", ".join(missing)
            raise ComparisonError(
                f"{label} is missing required key field column(s): {joined}"
            )


def _collect_columns(rows: Sequence[Mapping[str, Any]]) -> set[str]:
    columns: set[str] = set()
    for row in rows:
        if not row or not isinstance(row, Mapping):
            continue
        columns.update(str(key) for key in row.keys())
    return columns


def _index_by_identifier(
    rows: Sequence[Mapping[str, Any]], identifier_columns: Sequence[str]
) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for row in rows:
        key, identifier = build_identifier(row, identifier_columns)
        entry = index.get(key)
        if entry:
            entry["rows"].append(dict(row))
        else:
            index[key] = {"identifier": identifier, "rows": [dict(row)]}
    return index


def _resolve_compare_columns(
    preload_rows: Sequence[Mapping[str, Any]],
    postload_rows: Sequence[Mapping[str, Any]],
    config: ComparisonConfig,
) -> list[str]:
    id_set = set(config.identifier_columns)

    if config.compare_columns is not None:
        return [col for col in config.compare_columns if col not in id_set]

    preload_columns = _collect_columns(preload_rows)
    postload_columns = _collect_columns(postload_rows)
    shared = [
        col
        for col in preload_columns
        if col not in id_set and col in postload_columns
    ]

    if not shared:
        return [col for col in preload_columns if col not in id_set]

    return shared


def compare_datasets(
    preload_rows: Sequence[Mapping[str, Any]] | None,
    postload_rows: Sequence[Mapping[str, Any]] | None,
    config: Mapping[str, Any] | ComparisonConfig | None = None,
) -> dict[str, list[dict[str, Any]]]:
    parsed = (
        config
        if isinstance(config, ComparisonConfig)
        else ComparisonConfig.from_dict(config)
    )

    preload = list(preload_rows or [])
    postload = list(postload_rows or [])

    validate_identifier_columns(preload, postload, parsed.identifier_columns)

    compare_columns = _resolve_compare_columns(preload, postload, parsed)
    preload_index = _index_by_identifier(preload, parsed.identifier_columns)
    postload_index = _index_by_identifier(postload, parsed.identifier_columns)

    missing_records: list[dict[str, Any]] = []
    missing_values: list[dict[str, Any]] = []
    value_mismatches: list[dict[str, Any]] = []
    duplicate_records: list[dict[str, Any]] = []
    baseline_duplicates: list[dict[str, Any]] = []
    extra_records: list[dict[str, Any]] = []

    for key, entry in preload_index.items():
        if len(entry["rows"]) > 1:
            baseline_duplicates.append(
                {
                    "identifier": entry["identifier"],
                    "count": len(entry["rows"]),
                    "records": entry["rows"],
                }
            )

        post_entry = postload_index.get(key)
        if not post_entry:
            missing_records.append(
                {
                    "identifier": entry["identifier"],
                    "record": entry["rows"][0],
                }
            )
            continue

        expected = entry["rows"][0]
        actual = post_entry["rows"][0]

        for field_name in compare_columns:
            expected_value = expected.get(field_name)
            actual_value = actual.get(field_name)

            if not is_empty_value(expected_value) and is_empty_value(actual_value):
                missing_values.append(
                    {
                        "identifier": entry["identifier"],
                        "field": field_name,
                        "expectedValue": expected_value,
                    }
                )
                continue

            if not values_equal(expected_value, actual_value):
                if is_empty_value(expected_value) and not is_empty_value(actual_value):
                    continue
                value_mismatches.append(
                    {
                        "identifier": entry["identifier"],
                        "field": field_name,
                        "expectedValue": None if is_empty_value(expected_value) else expected_value,
                        "actualValue": None if is_empty_value(actual_value) else actual_value,
                    }
                )

    for key, entry in postload_index.items():
        if len(entry["rows"]) > 1:
            duplicate_records.append(
                {
                    "identifier": entry["identifier"],
                    "count": len(entry["rows"]),
                    "records": entry["rows"],
                }
            )

        if key not in preload_index:
            extra_records.append(
                {
                    "identifier": entry["identifier"],
                    "record": entry["rows"][0],
                }
            )

    return {
        "missingRecords": missing_records,
        "missingValues": missing_values,
        "valueMismatches": value_mismatches,
        "duplicateRecords": duplicate_records,
        "baselineDuplicates": baseline_duplicates,
        "extraRecords": extra_records,
    }
