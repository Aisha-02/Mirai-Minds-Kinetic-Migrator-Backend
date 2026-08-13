"""Core dataset comparison engine using Polars."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

import polars as pl

from comparator_exceptions import MissingKeyColumnsError, SheetStructureMismatchError
from parsing import _normalize_column_name


DEFAULT_RESULT_LIMIT = 1000


@dataclass(frozen=True)
class ComparisonSummary:
    """High-level counts for a single dataset comparison."""

    source_row_count: int
    target_row_count: int
    only_in_source_count: int
    only_in_target_count: int
    matched_count: int
    field_mismatch_count: int


@dataclass(frozen=True)
class FieldMismatch:
    """A single field-level mismatch for a matched record."""

    key_values: dict[str, Any]
    column: str
    source_value: Any
    target_value: Any


@dataclass
class ComparisonResult:
    """Structured result for comparing two single-sheet datasets."""

    summary: ComparisonSummary
    only_in_source: list[dict[str, Any]] = field(default_factory=list)
    only_in_target: list[dict[str, Any]] = field(default_factory=list)
    field_mismatches: list[FieldMismatch] = field(default_factory=list)
    only_in_source_total: int = 0
    only_in_target_total: int = 0
    field_mismatches_total: int = 0
    key_columns: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class UnmatchedSheet:
    """A sheet present in only one workbook."""

    sheet_name: str
    present_in: Literal["source", "target"]


@dataclass
class MultiSheetComparisonResult:
    """Comparison results across multiple matched sheets."""

    sheets: dict[str, ComparisonResult] = field(default_factory=dict)
    unmatched_sheets: list[UnmatchedSheet] = field(default_factory=list)


def _normalize_key_expr(column: str) -> pl.Expr:
    """Cast a key column to trimmed string for stable joins."""
    return pl.col(column).cast(pl.String, strict=False).fill_null("").str.strip_chars()


def _normalize_keys_df(df: pl.DataFrame, key_columns: list[str]) -> pl.DataFrame:
    """Return a copy with normalized key columns for joining."""
    return df.with_columns(
        [_normalize_key_expr(column).alias(column) for column in key_columns]
    )


def _map_columns_to_dataframe(
    df: pl.DataFrame,
    columns: list[str],
    *,
    sheet_name: str | None = None,
) -> list[str]:
    """Map requested column names to actual DataFrame columns (snake_case aware)."""
    by_lower = {column.lower(): column for column in df.columns}
    by_normalized = {
        _normalize_column_name(column, enabled=True): column for column in df.columns
    }

    mapped: list[str] = []
    missing: list[str] = []
    for column in columns:
        normalized = _normalize_column_name(column, enabled=True)
        if normalized in df.columns:
            mapped.append(normalized)
            continue
        if normalized in by_normalized:
            mapped.append(by_normalized[normalized])
            continue
        lower = column.lower()
        if lower in by_lower:
            mapped.append(by_lower[lower])
            continue
        missing.append(column)

    if missing:
        raise MissingKeyColumnsError(missing, sheet_name=sheet_name)
    return mapped


def _resolve_compare_columns(
    source_df: pl.DataFrame,
    target_df: pl.DataFrame,
    key_columns: list[str],
    compare_columns: list[str] | None,
) -> list[str]:
    """Determine which non-key columns to compare."""
    if compare_columns:
        requested = _map_columns_to_dataframe(source_df, compare_columns)
        _map_columns_to_dataframe(target_df, compare_columns)
        return [column for column in requested if column not in key_columns]

    common = sorted(set(source_df.columns) & set(target_df.columns) - set(key_columns))
    return common


def _string_compare_expr(left: str, right: str) -> pl.Expr:
    """Compare two columns with null-safe string coercion."""
    left_expr = pl.col(left).cast(pl.String, strict=False).fill_null("").str.strip_chars()
    right_expr = pl.col(right).cast(pl.String, strict=False).fill_null("").str.strip_chars()
    return left_expr != right_expr


def _dataframe_to_records(df: pl.DataFrame, limit: int) -> tuple[list[dict[str, Any]], int]:
    """Convert a DataFrame to records with optional row cap."""
    total = df.height
    if total == 0:
        return [], 0
    capped = df.head(limit) if limit >= 0 else df
    return capped.to_dicts(), total


def _extract_key_values(row: dict[str, Any], key_columns: list[str]) -> dict[str, Any]:
    return {column: row.get(column) for column in key_columns}


def compare_datasets(
    source_df: pl.DataFrame,
    target_df: pl.DataFrame,
    key_columns: list[str],
    compare_columns: list[str] | None = None,
    *,
    result_limit: int = DEFAULT_RESULT_LIMIT,
) -> ComparisonResult:
    """
    Compare two datasets on key columns and report structural and field-level diffs.

    Key columns are normalized to trimmed strings before joining so numeric and
    string identifiers match reliably. Anti-joins identify records present in
    only one dataset; inner joins drive field-by-field mismatch detection.

    Args:
        source_df: Source-side records.
        target_df: Target-side records.
        key_columns: Columns that uniquely identify a record.
        compare_columns: Optional subset of columns to compare. Defaults to all
            common non-key columns present in both datasets.
        result_limit: Maximum rows returned in each diff list. Summary counts
            always reflect the full dataset.

    Returns:
        ComparisonResult with summary counts, capped diff lists, and totals.
    """
    resolved_keys = _map_columns_to_dataframe(source_df, key_columns)
    _map_columns_to_dataframe(target_df, key_columns)

    source_norm = _normalize_keys_df(source_df, resolved_keys)
    target_norm = _normalize_keys_df(target_df, resolved_keys)

    source_keys = source_norm.select(resolved_keys).unique()
    target_keys = target_norm.select(resolved_keys).unique()

    only_in_source_df = source_norm.join(target_keys, on=resolved_keys, how="anti")
    only_in_target_df = target_norm.join(source_keys, on=resolved_keys, how="anti")

    matched = source_norm.join(
        target_norm,
        on=resolved_keys,
        how="inner",
        suffix="_target",
    )

    columns_to_compare = _resolve_compare_columns(
        source_df,
        target_df,
        resolved_keys,
        compare_columns,
    )

    mismatch_frames: list[pl.DataFrame] = []
    for column in columns_to_compare:
        target_column = f"{column}_target"
        if target_column not in matched.columns:
            continue

        diff_frame = matched.filter(_string_compare_expr(column, target_column))
        if diff_frame.height == 0:
            continue

        mismatch_frames.append(
            diff_frame.select(
                *resolved_keys,
                pl.col(column).alias("_source_value"),
                pl.col(target_column).alias("_target_value"),
            ).with_columns(pl.lit(column).alias("_column"))
        )

    if mismatch_frames:
        all_mismatches = pl.concat(mismatch_frames, how="vertical_relaxed")
    else:
        all_mismatches = pl.DataFrame(
            schema={
                **{key: pl.String for key in resolved_keys},
                "_source_value": pl.String,
                "_target_value": pl.String,
                "_column": pl.String,
            }
        )

    field_mismatch_total = all_mismatches.height
    capped_mismatches = all_mismatches.head(result_limit)

    field_mismatches: list[FieldMismatch] = []
    for row in capped_mismatches.to_dicts():
        key_values = _extract_key_values(row, resolved_keys)
        field_mismatches.append(
            FieldMismatch(
                key_values=key_values,
                column=row["_column"],
                source_value=row["_source_value"],
                target_value=row["_target_value"],
            )
        )

    only_in_source_records, only_in_source_total = _dataframe_to_records(
        only_in_source_df,
        result_limit,
    )
    only_in_target_records, only_in_target_total = _dataframe_to_records(
        only_in_target_df,
        result_limit,
    )

    matched_count = matched.height
    summary = ComparisonSummary(
        source_row_count=source_df.height,
        target_row_count=target_df.height,
        only_in_source_count=only_in_source_total,
        only_in_target_count=only_in_target_total,
        matched_count=matched_count,
        field_mismatch_count=field_mismatch_total,
    )

    return ComparisonResult(
        summary=summary,
        only_in_source=only_in_source_records,
        only_in_target=only_in_target_records,
        field_mismatches=field_mismatches,
        only_in_source_total=only_in_source_total,
        only_in_target_total=only_in_target_total,
        field_mismatches_total=field_mismatch_total,
        key_columns=resolved_keys,
    )


def compare_multi_sheet(
    source_sheets: dict[str, pl.DataFrame],
    target_sheets: dict[str, pl.DataFrame],
    key_resolver_fn: Callable[[str], list[str]],
    compare_columns: list[str] | None = None,
    *,
    result_limit: int = DEFAULT_RESULT_LIMIT,
) -> MultiSheetComparisonResult:
    """
    Compare matched sheets between source and target workbooks.

    Sheets are matched by exact name. Any sheet present in only one workbook is
    reported in ``unmatched_sheets`` rather than silently skipped.

    Args:
        source_sheets: Parsed source workbook sheets.
        target_sheets: Parsed target workbook sheets.
        key_resolver_fn: Callable that returns key columns for a sheet name.
        compare_columns: Optional subset of columns to compare on every sheet.
        result_limit: Row cap for each sheet's diff lists.

    Returns:
        MultiSheetComparisonResult with per-sheet ComparisonResult values and
        unmatched sheet warnings.
    """
    source_names = set(source_sheets)
    target_names = set(target_sheets)
    common_names = sorted(source_names & target_names)

    unmatched: list[UnmatchedSheet] = []
    for sheet_name in sorted(source_names - target_names):
        unmatched.append(UnmatchedSheet(sheet_name=sheet_name, present_in="source"))
    for sheet_name in sorted(target_names - source_names):
        unmatched.append(UnmatchedSheet(sheet_name=sheet_name, present_in="target"))

    sheet_results: dict[str, ComparisonResult] = {}
    for sheet_name in common_names:
        key_columns = key_resolver_fn(sheet_name)
        sheet_results[sheet_name] = compare_datasets(
            source_sheets[sheet_name],
            target_sheets[sheet_name],
            key_columns,
            compare_columns=compare_columns,
            result_limit=result_limit,
        )

    return MultiSheetComparisonResult(
        sheets=sheet_results,
        unmatched_sheets=unmatched,
    )


def ensure_matching_structure(
    source_parsed: pl.DataFrame | dict[str, pl.DataFrame],
    target_parsed: pl.DataFrame | dict[str, pl.DataFrame],
) -> tuple[bool, bool]:
    """
    Return whether source and target are multi-sheet dicts vs single DataFrames.

    Raises:
        SheetStructureMismatchError: One side is multi-sheet and the other is not.
    """
    source_multi = isinstance(source_parsed, dict)
    target_multi = isinstance(target_parsed, dict)
    if source_multi != target_multi:
        raise SheetStructureMismatchError(
            "Source and target must both be single-sheet or both be multi-sheet workbooks"
        )
    return source_multi, target_multi
