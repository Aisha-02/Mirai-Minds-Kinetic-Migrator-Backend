"""FastAPI service exposing dataset comparison."""

from __future__ import annotations

import logging
import os
from typing import Annotated

import polars as pl
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from comparator import (
    compare_datasets,
    compare_multi_sheet,
    ensure_matching_structure,
)
from comparator_exceptions import ComparisonError, MissingKeyColumnsError, SheetStructureMismatchError
from exceptions import ParseError
from key_exceptions import KeyResolverError, MissingKeyFieldsError
from key_resolver import resolve_key_fields, resolve_key_fields_for_sheets
from parsing import parse_file
from schemas import CompareResponse, ErrorResponse, HealthResponse, comparison_result_to_model, multi_sheet_result_to_model

logger = logging.getLogger("comparison_service")
logging.basicConfig(level=logging.INFO)

DEFAULT_FRONTEND_ORIGIN = "http://localhost:3000"
DEFAULT_RESULT_LIMIT = int(os.getenv("COMPARISON_RESULT_LIMIT", "1000"))


def _frontend_origin() -> str:
    return os.getenv("FRONTEND_ORIGIN", DEFAULT_FRONTEND_ORIGIN).strip()


def _parse_csv_list(value: str | None) -> list[str] | None:
    if value is None:
        return None
    items = [item.strip() for item in value.split(",") if item.strip()]
    return items or None


app = FastAPI(
    title="Mirai Comparison Service",
    description="Compare SAP migration source and target datasets.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[_frontend_origin()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _parse_upload(upload: UploadFile):
    """Parse an uploaded file, rewinding the stream before read."""
    upload.file.seek(0)
    return parse_file(upload.file, filename=upload.filename)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Liveness probe."""
    return HealthResponse()


@app.post(
    "/compare",
    response_model=CompareResponse,
    responses={
        400: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
    },
)
async def compare(
    source_file: Annotated[UploadFile, File(description="Source CSV or Excel file")],
    target_file: Annotated[UploadFile, File(description="Target CSV or Excel file")],
    business_object: Annotated[
        str | None,
        Form(description="SAP business object used to resolve key fields"),
    ] = None,
    override_keys: Annotated[
        str | None,
        Form(description="Comma-separated key columns; overrides SAP resolution"),
    ] = None,
    compare_columns: Annotated[
        str | None,
        Form(description="Comma-separated columns to compare"),
    ] = None,
) -> CompareResponse:
    """
    Compare uploaded source and target files.

    Files are parsed with ``parsing.py``. Single-sheet files are compared
    directly; multi-sheet Excel workbooks are matched by sheet name. Key fields
    are resolved via ``key_resolver.py`` unless ``override_keys`` is provided.
    """
    if not source_file.filename or not target_file.filename:
        raise HTTPException(status_code=422, detail="Both source_file and target_file are required")

    override_key_list = _parse_csv_list(override_keys)
    compare_column_list = _parse_csv_list(compare_columns)
    business_object_value = business_object.strip() if business_object else None

    try:
        source_parsed = _parse_upload(source_file)
        target_parsed = _parse_upload(target_file)
    except ParseError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Failed to parse uploaded files")
        raise HTTPException(status_code=400, detail="Failed to parse uploaded files") from exc

    try:
        is_multi, _ = ensure_matching_structure(source_parsed, target_parsed)
    except SheetStructureMismatchError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        if not is_multi:
            assert isinstance(source_parsed, pl.DataFrame)
            assert isinstance(target_parsed, pl.DataFrame)

            if override_key_list:
                key_columns = override_key_list
            elif business_object_value:
                key_columns = resolve_key_fields(business_object_value)
            else:
                raise HTTPException(
                    status_code=400,
                    detail="business_object or override_keys is required for single-sheet comparisons",
                )

            result = compare_datasets(
                source_parsed,
                target_parsed,
                key_columns,
                compare_columns=compare_column_list,
                result_limit=DEFAULT_RESULT_LIMIT,
            )
            return CompareResponse(
                mode="single",
                result=comparison_result_to_model(result),
            )

        assert isinstance(source_parsed, dict)
        assert isinstance(target_parsed, dict)
        matched_sheet_names = sorted(set(source_parsed) & set(target_parsed))

        if override_key_list:
            resolved_keys = {sheet_name: override_key_list for sheet_name in matched_sheet_names}
        elif business_object_value:
            shared_keys = resolve_key_fields(business_object_value)
            resolved_keys = {sheet_name: shared_keys for sheet_name in matched_sheet_names}
        else:
            resolved_keys = resolve_key_fields_for_sheets(matched_sheet_names)

        def key_resolver(sheet_name: str) -> list[str]:
            return resolved_keys[sheet_name]

        multi_result = compare_multi_sheet(
            source_parsed,
            target_parsed,
            key_resolver,
            compare_columns=compare_column_list,
            result_limit=DEFAULT_RESULT_LIMIT,
        )
        return CompareResponse(
            mode="multi",
            result=multi_sheet_result_to_model(multi_result),
        )
    except MissingKeyColumnsError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except MissingKeyFieldsError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except KeyResolverError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ComparisonError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception:
        logger.exception("Unexpected comparison failure")
        raise HTTPException(
            status_code=500,
            detail="An unexpected error occurred during comparison",
        )


@app.exception_handler(HTTPException)
async def http_exception_handler(_request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content=ErrorResponse(detail=str(exc.detail)).model_dump(),
    )
