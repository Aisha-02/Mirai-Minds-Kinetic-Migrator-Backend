"""Orchestrate table discovery, classification, rule application, and per-scenario output."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from validation_engine.classify import BusinessObjectClassifier, DetectionResult
from validation_engine.columns import resolve_field_column
from validation_engine.constants import DEFAULT_CHUNKSIZE, DETECTOR_TO_RULES_BO, NONE_MATCHED
from validation_engine.evaluate import (
    FindingAccumulator,
    annotate_and_collect,
    collect_key_values,
    duplicate_value_sets,
    summarize_findings,
)
from validation_engine.readers import (
    TableRef,
    discover_tables,
    iter_table_chunks,
    peek_table,
)
from validation_engine.rules import PreparedField, RulesProvider, prepare_fields
from validation_engine.writers import (
    normalize_output_format,
    scenario_output_filename,
    write_frames,
)


@dataclass
class UnclassifiedTable:
    source_name: str
    path: str
    sheet_name: str | None
    columns: list[str]
    detection: DetectionResult


@dataclass
class FailedTable:
    source_name: str
    path: str
    sheet_name: str | None
    error: str


@dataclass
class ScenarioResult:
    scenario: str
    rules_business_object: str
    source_name: str
    path: str
    sheet_name: str | None
    detection: DetectionResult
    findings: list[dict[str, Any]]
    summary: dict[str, Any]
    report: dict[str, Any]
    output_path: Path
    row_count: int
    chunks_processed: int
    unmatched_rule_fields: list[str] = field(default_factory=list)


@dataclass
class ValidationRunResult:
    scenarios: list[ScenarioResult] = field(default_factory=list)
    unclassified: list[UnclassifiedTable] = field(default_factory=list)
    errors: list[FailedTable] = field(default_factory=list)


def validate_preload(
    source: Path | Sequence[Path],
    rules_provider: RulesProvider,
    classifier: BusinessObjectClassifier,
    output_dir: Path,
    output_format: str | None = None,
    chunksize: int = DEFAULT_CHUNKSIZE,
) -> ValidationRunResult:
    """
    Validate every CSV/Excel table in ``source``.

    Classified tables produce one downloadable file each (xlsx or csv).
    Sheets that do not confidently match a business object are listed as
    unclassified and are not forced into a ruleset. A failure on one table
    does not abort the rest of the batch.
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    result = ValidationRunResult()

    for table in discover_tables(source):
        try:
            columns, sample_rows = peek_table(table)
            detection = _classify(classifier, columns, sample_rows, table)
            if not detection.classified:
                result.unclassified.append(
                    UnclassifiedTable(
                        source_name=table.name,
                        path=str(table.path),
                        sheet_name=table.sheet_name,
                        columns=columns,
                        detection=detection,
                    )
                )
                continue

            scenario = detection.business_object or NONE_MATCHED
            rules_bo = DETECTOR_TO_RULES_BO.get(scenario)
            if not rules_bo:
                result.unclassified.append(
                    UnclassifiedTable(
                        source_name=table.name,
                        path=str(table.path),
                        sheet_name=table.sheet_name,
                        columns=columns,
                        detection=detection,
                    )
                )
                continue

            payload = rules_provider.get_rules(rules_bo)
            if not payload:
                result.errors.append(
                    FailedTable(
                        source_name=table.name,
                        path=str(table.path),
                        sheet_name=table.sheet_name,
                        error=f"No saved validation rules found for business object '{rules_bo}'",
                    )
                )
                continue

            fields = prepare_fields(payload)
            fmt = normalize_output_format(output_format, table.source_suffix)
            filename = scenario_output_filename(scenario, table.name, fmt)
            output_path = output_dir / filename
            result.scenarios.append(
                _validate_table(
                    table,
                    fields=fields,
                    scenario=scenario,
                    rules_bo=rules_bo,
                    detection=detection,
                    output_path=output_path,
                    output_format=fmt,
                    chunksize=chunksize,
                )
            )
        except Exception as err:  # noqa: BLE001
            result.errors.append(
                FailedTable(
                    source_name=table.name,
                    path=str(table.path),
                    sheet_name=table.sheet_name,
                    error=str(err) or "Validation failed for this sheet/file",
                )
            )

    return result


def _classify(
    classifier: BusinessObjectClassifier,
    columns: list[str],
    sample_rows: list[dict[str, Any]],
    table: TableRef,
) -> DetectionResult:
    try:
        return classifier.classify(columns, sample_rows, table=table)  # type: ignore[call-arg]
    except TypeError:
        return classifier.classify(columns, sample_rows)


def _validate_table(
    table: TableRef,
    fields: list[PreparedField],
    scenario: str,
    rules_bo: str,
    detection: DetectionResult,
    output_path: Path,
    output_format: str,
    chunksize: int,
) -> ScenarioResult:
    key_store: dict[str, dict[str, list[int]]] = {}
    chunks_processed = 0
    row_offset = 0
    first_columns: list[str] = []
    for chunk in iter_table_chunks(table, chunksize=chunksize):
        if not first_columns:
            first_columns = [str(c) for c in chunk.columns]
        collect_key_values(chunk, fields, key_store, row_offset)
        chunks_processed += 1
        row_offset += len(chunk)

    total_rows = row_offset
    dup_values = duplicate_value_sets(key_store)
    accumulator = FindingAccumulator()
    annotated: list[Any] = []
    row_offset = 0
    for chunk in iter_table_chunks(table, chunksize=chunksize):
        annotated.append(
            annotate_and_collect(
                chunk,
                fields,
                row_offset=row_offset,
                accumulator=accumulator,
                duplicate_values=dup_values,
            )
        )
        row_offset += len(chunk)

    write_frames(annotated, output_path, output_format)
    findings = accumulator.to_findings()
    rules_checked = sum(len(field.rules) for field in fields)
    rolled = summarize_findings(
        findings,
        total_rows=total_rows,
        fields_checked=len(fields),
        rules_checked=rules_checked,
        business_object=scenario,
    )
    unmatched = [
        field.field_name
        for field in fields
        if resolve_field_column(field.field_name, first_columns) is None
    ]
    return ScenarioResult(
        scenario=scenario,
        rules_business_object=rules_bo,
        source_name=table.name,
        path=str(table.path),
        sheet_name=table.sheet_name,
        detection=detection,
        findings=findings,
        summary=rolled["summary"],
        report=rolled["report"],
        output_path=output_path,
        row_count=total_rows,
        chunks_processed=chunks_processed,
        unmatched_rule_fields=unmatched,
    )
