"""FastAPI validation-engine service."""

from __future__ import annotations

import os
import secrets
import tempfile
import uuid
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from validation_engine.classify import BedrockClassifier, ForcedClassifier
from validation_engine.constants import DEFAULT_CHUNKSIZE, INTERNAL_API_HEADER
from validation_engine.engine import validate_preload
from validation_engine.payload import rules_provider_from_payload
from validation_engine.readers import TableRef
from validation_engine.storage import (
    content_type_for_path,
    download_object,
    parsed_output_key,
    safe_filename,
    upload_file,
)

app = FastAPI(title="Kinetic Validation Engine", version="0.1.0")


class InputRef(BaseModel):
    s3Key: str
    filename: str | None = None
    businessObject: str | None = None


class ValidateRequest(BaseModel):
    jobId: str | None = None
    s3Key: str | None = None
    s3Keys: list[str] = Field(default_factory=list)
    inputs: list[InputRef] = Field(default_factory=list)
    rules: Any = None
    rulesByBusinessObject: Any = None
    outputFormat: str | None = None
    chunksize: int | None = None


def require_internal_key(
    x_internal_service_key: str | None = Header(default=None, alias=INTERNAL_API_HEADER),
) -> None:
    expected = str(os.environ.get("INTERNAL_SERVICE_KEY") or "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="INTERNAL_SERVICE_KEY is not configured")
    provided = str(x_internal_service_key or "")
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "validation-engine"}


@app.post("/validate")
def validate(body: ValidateRequest, _: None = Depends(require_internal_key)) -> dict[str, Any]:
    inputs = _collect_inputs(body)
    if not inputs:
        raise HTTPException(status_code=400, detail="s3Key, s3Keys, or inputs[] is required")

    rules_raw = body.rulesByBusinessObject if body.rulesByBusinessObject is not None else body.rules
    provider = rules_provider_from_payload(rules_raw)
    if not provider.by_business_object:
        raise HTTPException(
            status_code=400,
            detail="rules (or rulesByBusinessObject) must include at least one business-object ruleset",
        )

    job_id = str(body.jobId or uuid.uuid4())
    chunksize = int(body.chunksize or DEFAULT_CHUNKSIZE)
    if chunksize < 1:
        raise HTTPException(status_code=400, detail="chunksize must be >= 1")

    forced_by_path: dict[str, str] = {}
    local_paths: list[Path] = []
    download_errors: list[dict[str, Any]] = []

    with tempfile.TemporaryDirectory(prefix="kinetic-validate-") as tmp:
        tmp_dir = Path(tmp)
        input_dir = tmp_dir / "in"
        output_dir = tmp_dir / "out"
        input_dir.mkdir()
        output_dir.mkdir()

        for index, item in enumerate(inputs):
            filename = safe_filename(
                item.filename or Path(item.s3Key).name,
                fallback=f"input_{index + 1}",
            )
            dest = input_dir / f"{index:03d}_{filename}"
            try:
                download_object(item.s3Key, dest)
            except Exception as err:  # noqa: BLE001
                download_errors.append(
                    {
                        "sourceName": Path(item.filename or item.s3Key).name,
                        "sheetName": None,
                        "error": str(err),
                    }
                )
                continue
            local_paths.append(dest)
            if item.businessObject:
                forced_by_path[str(dest)] = item.businessObject

        scenarios: list[dict[str, Any]] = []
        unclassified: list[dict[str, Any]] = []
        errors = list(download_errors)

        if local_paths:
            run = validate_preload(
                local_paths,
                rules_provider=provider,
                classifier=RequestClassifier(forced_by_path),
                output_dir=output_dir,
                output_format=body.outputFormat,
                chunksize=chunksize,
            )
            for item in run.unclassified:
                unclassified.append(
                    {
                        "sourceName": item.source_name,
                        "sheetName": item.sheet_name,
                        "columns": item.columns,
                        "detection": item.detection.to_dict(),
                        "reason": item.detection.message
                        or "Could not confidently classify this sheet/file",
                    }
                )
            for item in run.errors:
                errors.append(
                    {
                        "sourceName": item.source_name,
                        "sheetName": item.sheet_name,
                        "error": item.error,
                    }
                )
            for scenario in run.scenarios:
                key = parsed_output_key(job_id, scenario.output_path.name)
                try:
                    upload_file(
                        scenario.output_path,
                        key,
                        content_type=content_type_for_path(scenario.output_path),
                    )
                except Exception as err:  # noqa: BLE001
                    errors.append(
                        {
                            "sourceName": scenario.source_name,
                            "sheetName": scenario.sheet_name,
                            "error": f"Failed to upload parsed file: {err}",
                        }
                    )
                    continue
                scenarios.append(
                    {
                        "scenario": scenario.scenario,
                        "rulesBusinessObject": scenario.rules_business_object,
                        "sourceName": scenario.source_name,
                        "sheetName": scenario.sheet_name,
                        "filename": scenario.output_path.name,
                        "s3Key": key,
                        "rowCount": scenario.row_count,
                        "chunksProcessed": scenario.chunks_processed,
                        "unmatchedRuleFields": scenario.unmatched_rule_fields,
                        "detection": scenario.detection.to_dict(),
                        "findings": scenario.findings,
                        "summary": scenario.summary,
                        "report": scenario.report,
                    }
                )

        return {
            "ok": True,
            "jobId": job_id,
            "scenarios": scenarios,
            "unclassified": unclassified,
            "errors": errors,
        }


def _collect_inputs(body: ValidateRequest) -> list[InputRef]:
    collected: list[InputRef] = []
    if body.s3Key:
        collected.append(InputRef(s3Key=body.s3Key))
    for key in body.s3Keys:
        collected.append(InputRef(s3Key=key))
    collected.extend(body.inputs)
    seen: set[str] = set()
    unique: list[InputRef] = []
    for item in collected:
        key = str(item.s3Key or "").strip()
        if not key or key in seen:
            continue
        if ".." in Path(key).parts:
            raise HTTPException(status_code=400, detail="Invalid s3Key")
        seen.add(key)
        unique.append(
            InputRef(
                s3Key=key,
                filename=item.filename,
                businessObject=item.businessObject,
            )
        )
    return unique


class RequestClassifier:
    """Per-file ForcedClassifier when Node sends a label; otherwise Bedrock."""

    def __init__(self, forced_by_path: dict[str, str]) -> None:
        self.forced_by_path = forced_by_path
        self._bedrock = BedrockClassifier()

    def classify(
        self,
        columns: list[str],
        sample_rows: list[dict[str, Any]] | None = None,
        table: TableRef | None = None,
    ):
        forced = None
        if table is not None:
            forced = self.forced_by_path.get(str(table.path))
        if forced:
            return ForcedClassifier(forced).classify(columns, sample_rows)
        return self._bedrock.classify(columns, sample_rows)
