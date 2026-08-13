"""Pydantic models for the comparison FastAPI service."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel

from comparator import ComparisonResult, MultiSheetComparisonResult


class ComparisonSummaryModel(BaseModel):
    source_row_count: int
    target_row_count: int
    only_in_source_count: int
    only_in_target_count: int
    matched_count: int
    field_mismatch_count: int


class FieldMismatchModel(BaseModel):
    key_values: dict[str, Any]
    column: str
    source_value: Any
    target_value: Any


class ComparisonResultModel(BaseModel):
    summary: ComparisonSummaryModel
    only_in_source: list[dict[str, Any]]
    only_in_target: list[dict[str, Any]]
    field_mismatches: list[FieldMismatchModel]
    only_in_source_total: int
    only_in_target_total: int
    field_mismatches_total: int
    key_columns: list[str]


class UnmatchedSheetModel(BaseModel):
    sheet_name: str
    present_in: Literal["source", "target"]


class MultiSheetComparisonResultModel(BaseModel):
    sheets: dict[str, ComparisonResultModel]
    unmatched_sheets: list[UnmatchedSheetModel]


class SingleSheetCompareResponse(BaseModel):
    mode: Literal["single"] = "single"
    result: ComparisonResultModel


class MultiSheetCompareResponse(BaseModel):
    mode: Literal["multi"] = "multi"
    result: MultiSheetComparisonResultModel


class CompareResponse(BaseModel):
    """Union-style response for single- or multi-sheet comparisons."""

    mode: Literal["single", "multi"]
    result: ComparisonResultModel | MultiSheetComparisonResultModel


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"


class ErrorResponse(BaseModel):
    detail: str


def comparison_result_to_model(result: ComparisonResult) -> ComparisonResultModel:
    return ComparisonResultModel(
        summary=ComparisonSummaryModel(**result.summary.__dict__),
        only_in_source=result.only_in_source,
        only_in_target=result.only_in_target,
        field_mismatches=[
            FieldMismatchModel(
                key_values=mismatch.key_values,
                column=mismatch.column,
                source_value=mismatch.source_value,
                target_value=mismatch.target_value,
            )
            for mismatch in result.field_mismatches
        ],
        only_in_source_total=result.only_in_source_total,
        only_in_target_total=result.only_in_target_total,
        field_mismatches_total=result.field_mismatches_total,
        key_columns=result.key_columns,
    )


def multi_sheet_result_to_model(
    result: MultiSheetComparisonResult,
) -> MultiSheetComparisonResultModel:
    return MultiSheetComparisonResultModel(
        sheets={
            sheet_name: comparison_result_to_model(sheet_result)
            for sheet_name, sheet_result in result.sheets.items()
        },
        unmatched_sheets=[
            UnmatchedSheetModel(
                sheet_name=sheet.sheet_name,
                present_in=sheet.present_in,
            )
            for sheet in result.unmatched_sheets
        ],
    )
