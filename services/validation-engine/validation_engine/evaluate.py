"""Apply admin validation rules to pandas DataFrame chunks."""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import date, datetime
from typing import Any

import pandas as pd

from validation_engine.columns import resolve_field_column
from validation_engine.constants import (
    AFFECTED_SAMPLE_LIMIT,
    SAMPLE_VALUE_LIMIT,
    STATUS_FAIL,
    STATUS_PASS,
    STATUS_WARNING,
    VALIDATION_ERRORS_COL,
    VALIDATION_STATUS_COL,
)
from validation_engine.rules import PreparedField, is_duplicate_rule, rule_text

_LENGTH_LESS_RE = re.compile(r"(\d+)\s*characters?\s*or\s*less")
_LEADING_ZERO_RE = re.compile(r"^0+\d")


def is_empty_value(value: object) -> bool:
    if value is None or value is pd.NA:
        return True
    if isinstance(value, float) and pd.isna(value):
        return True
    text = str(value).strip()
    return text == "" or text.lower() == "<na>"


def empty_mask(series: pd.Series) -> pd.Series:
    as_str = series.astype("string")
    stripped = as_str.str.strip()
    return as_str.isna() | stripped.eq("") | stripped.str.lower().eq("<na>")


class FindingAccumulator:
    def __init__(self) -> None:
        self._items: dict[tuple[str, str], dict[str, Any]] = {}

    def add(
        self,
        *,
        field_name: str,
        matched_column: str,
        rule: dict[str, Any],
        row_number: int,
        value: object,
        reason: str,
        is_key: bool = False,
    ) -> None:
        key = (field_name, str(rule.get("ruleName") or "Unnamed rule"))
        severity = (
            "warning" if str(rule.get("severity") or "error").lower() == "warning" else "error"
        )
        entry = self._items.get(key)
        if entry is None:
            entry = {
                "fieldName": field_name,
                "matchedColumn": matched_column,
                "ruleName": rule.get("ruleName") or "Unnamed rule",
                "ruleViolated": rule.get("ruleName") or "Unnamed rule",
                "severity": severity,
                "affectedRows": [],
                "sampleValues": [],
                "rule": {
                    "ruleName": rule.get("ruleName"),
                    "source": rule.get("source"),
                    "description": rule.get("description"),
                    "constraint": rule.get("constraint"),
                    "severity": rule.get("severity"),
                    "category": rule.get("category"),
                },
                "_is_key": is_key,
            }
            self._items[key] = entry
        if row_number not in entry["affectedRows"]:
            entry["affectedRows"].append(row_number)
        if len(entry["sampleValues"]) < SAMPLE_VALUE_LIMIT:
            entry["sampleValues"].append(
                {
                    "row": row_number,
                    "value": None if is_empty_value(value) else str(value),
                    "reason": reason,
                }
            )

    def to_findings(self) -> list[dict[str, Any]]:
        findings = []
        for entry in self._items.values():
            affected = sorted(entry["affectedRows"])
            samples = entry["sampleValues"]
            issue = samples[0]["reason"] if samples else "Rule violated"
            field_name = entry["fieldName"]
            if "duplicate" in entry["ruleName"].lower():
                summary = (
                    f"{field_name} has duplicate values in {len(affected)} rows — "
                    "primary key fields must be unique in the preload file."
                    if entry.get("_is_key")
                    else f"{field_name} has duplicate values in {len(affected)} rows."
                )
            else:
                description = (
                    entry["rule"].get("description")
                    or entry["rule"].get("constraint")
                    or "see validation rule"
                )
                summary = f"{field_name}: {issue} in {len(affected)} row(s) — {description}."
            findings.append(
                {
                    **{k: v for k, v in entry.items() if k != "_is_key"},
                    "affectedCount": len(affected),
                    "affectedRows": affected[:AFFECTED_SAMPLE_LIMIT],
                    "issue": issue,
                    "summary": summary,
                }
            )
        return findings


def annotate_and_collect(
    chunk: pd.DataFrame,
    fields: list[PreparedField],
    *,
    row_offset: int,
    accumulator: FindingAccumulator,
    duplicate_values: dict[str, set[str]] | None = None,
) -> pd.DataFrame:
    frame = chunk.copy()
    columns = [str(c) for c in frame.columns]
    error_lists: list[list[str]] = [[] for _ in range(len(frame))]
    fail_flags = [False] * len(frame)
    warn_flags = [False] * len(frame)

    for field in fields:
        column = resolve_field_column(field.field_name, columns)
        if column is None:
            continue
        series = frame[column]
        for rule in field.rules:
            if is_duplicate_rule(rule):
                if field.key != "X":
                    continue
                dup_set = (duplicate_values or {}).get(field.field_name, set())
                mask, reason = _duplicate_mask(series, dup_set)
            else:
                mask, reason = evaluate_rule_mask(rule, series, field, frame, columns)
            if mask is None or not bool(mask.any()):
                continue
            severity = str(rule.get("severity") or "error").lower()
            positions = [idx for idx, flag in enumerate(mask.tolist()) if flag]
            for pos in positions:
                row_number = row_offset + pos + 1
                accumulator.add(
                    field_name=field.field_name,
                    matched_column=column,
                    rule=rule,
                    row_number=row_number,
                    value=series.iloc[pos],
                    reason=reason,
                    is_key=field.key == "X",
                )
                error_lists[pos].append(f"{field.field_name} [{rule.get('ruleName')}]: {reason}")
                if severity == "warning":
                    warn_flags[pos] = True
                else:
                    fail_flags[pos] = True

    statuses = []
    messages = []
    for errors, failed, warned in zip(error_lists, fail_flags, warn_flags, strict=False):
        if failed:
            statuses.append(STATUS_FAIL)
        elif warned:
            statuses.append(STATUS_WARNING)
        else:
            statuses.append(STATUS_PASS)
        messages.append(" | ".join(errors))
    frame[VALIDATION_STATUS_COL] = statuses
    frame[VALIDATION_ERRORS_COL] = messages
    return frame


def collect_key_values(
    chunk: pd.DataFrame,
    fields: list[PreparedField],
    store: dict[str, dict[str, list[int]]],
    row_offset: int,
) -> None:
    columns = [str(c) for c in chunk.columns]
    for field in fields:
        if field.key != "X" or not any(is_duplicate_rule(rule) for rule in field.rules):
            continue
        column = resolve_field_column(field.field_name, columns)
        if column is None:
            continue
        bucket = store.setdefault(field.field_name, defaultdict(list))
        for pos, value in enumerate(chunk[column].tolist()):
            if is_empty_value(value):
                continue
            bucket[str(value).strip().upper()].append(row_offset + pos + 1)


def duplicate_value_sets(store: dict[str, dict[str, list[int]]]) -> dict[str, set[str]]:
    return {
        field_name: {value for value, rows in groups.items() if len(rows) >= 2}
        for field_name, groups in store.items()
    }


def evaluate_rule_mask(
    rule: dict[str, Any],
    series: pd.Series,
    field: PreparedField,
    frame: pd.DataFrame,
    columns: list[str],
) -> tuple[pd.Series | None, str]:
    text = rule_text(rule)
    empty = empty_mask(series)
    as_str = series.astype("string").str.strip()

    sap = _sap_type_mask(rule, field, empty, as_str)
    if sap is not None:
        return sap

    date_related = _date_related_mask(empty, as_str, text)
    if date_related is not None:
        return date_related

    if (
        "null/empty" in text
        or "null check" in text
        or rule.get("constraint") in ("NOT_NULL_OR_EMPTY", "FLAG_NULL_OR_EMPTY")
        or rule.get("ruleId") == "COMMON-NULL-EMPTY"
        or "must not be empty" in text
        or "should not be empty" in text
    ):
        return empty, "Value is null/empty"

    length_match = _LENGTH_LESS_RE.search(text)
    if length_match is not None:
        max_len = int(length_match.group(1))
        mask = (~empty) & (as_str.fillna("").str.len() > max_len)
        return mask, f"Length exceeds max {max_len}"

    if "leading zero" in text:
        return (~empty) & as_str.fillna("").str.match(_LEADING_ZERO_RE), "Value has leading zeros"

    if "start with a letter or a number" in text or "start with letter or number" in text:
        mask = (~empty) & ~as_str.fillna("").str.match(r"^[A-Za-z0-9]")
        return mask, "Value must start with a letter or number"

    if (
        "greater than or equal to zero" in text
        or "greater than or equal to 0" in text
        or "must be >= 0" in text
        or "non-negative" in text
    ):
        numeric = pd.to_numeric(as_str.str.replace(",", "", regex=False), errors="coerce")
        non_numeric = (~empty) & numeric.isna()
        negative = (~empty) & numeric.notna() & (numeric < 0)
        combined = non_numeric | negative
        if bool(non_numeric.any()) and not bool(negative.any()):
            return combined, "Value is not numeric"
        if bool(negative.any()) and not bool(non_numeric.any()):
            return combined, "Value is less than zero"
        return combined, "Value is not numeric or is less than zero"

    if "gross" in text and "net" in text:
        gross_col = resolve_field_column("GROSS_WEIGHT", columns)
        net_col = resolve_field_column("NET_WEIGHT", columns) or resolve_field_column(
            "NET WEIGHT", columns
        )
        if gross_col and net_col:
            gross = pd.to_numeric(
                frame[gross_col].astype("string").str.strip().str.replace(",", "", regex=False),
                errors="coerce",
            )
            net = pd.to_numeric(
                frame[net_col].astype("string").str.strip().str.replace(",", "", regex=False),
                errors="coerce",
            )
            return gross.notna() & net.notna() & (net > gross), "Net weight exceeds gross weight"

    if ("domain" in text or str(rule.get("category") or "").lower() == "domain") and str(
        rule.get("severity") or ""
    ).lower() == "error":
        return empty, "Domain value is empty"

    if str(rule.get("category") or "").lower() == "format" and str(
        rule.get("severity") or ""
    ).lower() == "error":
        return empty, "Required format field is empty"

    return pd.Series(False, index=series.index), ""


def _duplicate_mask(series: pd.Series, duplicate_keys: set[str]) -> tuple[pd.Series, str]:
    keys = series.astype("string").str.strip().str.upper()
    return (~empty_mask(series)) & keys.isin(duplicate_keys), "Duplicate key value"


def _sap_type_mask(
    rule: dict[str, Any],
    field: PreparedField,
    empty: pd.Series,
    as_str: pd.Series,
) -> tuple[pd.Series, str] | None:
    rule_id = str(rule.get("ruleId") or "")
    if (
        rule_id == "COMMON-DATS-FORMAT"
        or rule.get("constraint") == "SAP_DATS_YYYYMMDD"
        or (field.data_type == "DATS" and "dats" in str(rule.get("ruleName") or "").lower())
    ):
        return _dats_mask(as_str, empty)
    if rule_id == "COMMON-TIMS-FORMAT" or rule.get("constraint") == "SAP_TIMS_HHMMSS":
        return _tims_mask(as_str, empty)
    if rule_id == "COMMON-FIELD-LENGTH":
        max_len = rule.get("maxLength")
        if not max_len:
            match = re.search(r"(\d+)", str(rule.get("constraint") or ""))
            max_len = int(match.group(1)) if match else None
        if not max_len:
            return None
        mask = (~empty) & (as_str.fillna("").str.len() > int(max_len))
        return mask, f"Length exceeds max {max_len} for field type {field.data_type or 'CHAR'}"
    return None


def _dats_mask(as_str: pd.Series, empty: pd.Series) -> tuple[pd.Series, str]:
    raw = as_str.fillna("")
    has_sep = raw.str.contains(r"[-/.]", regex=True)
    digits = raw.str.replace(r"\s", "", regex=True)
    not_digits = ~digits.str.fullmatch(r"\d+")
    bad_len = digits.str.len().ne(8)
    calendar_bad = pd.Series(False, index=as_str.index)
    candidates = (~empty) & ~has_sep & ~not_digits & ~bad_len
    for idx, value in digits[candidates].items():
        try:
            datetime.strptime(str(value), "%Y%m%d")
        except ValueError:
            calendar_bad.loc[idx] = True
    return (~empty) & (has_sep | not_digits | bad_len | calendar_bad), "Value is not in SAP DATS format (YYYYMMDD)"


def _tims_mask(as_str: pd.Series, empty: pd.Series) -> tuple[pd.Series, str]:
    raw = as_str.fillna("").str.replace(":", "", regex=False)
    not_six = ~raw.str.fullmatch(r"\d{6}")
    hours = pd.to_numeric(raw.str.slice(0, 2), errors="coerce")
    minutes = pd.to_numeric(raw.str.slice(2, 4), errors="coerce")
    seconds = pd.to_numeric(raw.str.slice(4, 6), errors="coerce")
    invalid_time = (hours > 23) | (minutes > 59) | (seconds > 59)
    return (~empty) & (not_six | invalid_time.fillna(True)), "Value is not a valid SAP TIMS time (HHMMSS)"


def _date_related_mask(
    empty: pd.Series,
    as_str: pd.Series,
    text: str,
) -> tuple[pd.Series, str] | None:
    if (
        "not in future" in text
        or "not in the future" in text
        or "future date" in text
        or ("future" in text and "date" in text)
    ):
        today = date.today()
        future = pd.Series(False, index=as_str.index)
        unparsed = pd.Series(False, index=as_str.index)
        for idx, value in as_str.items():
            if empty.loc[idx]:
                continue
            parsed = _parse_flexible_date(value)
            if parsed is None:
                unparsed.loc[idx] = True
            elif parsed > today:
                future.loc[idx] = True
        if bool(unparsed.any()) and not bool(future.any()):
            return unparsed, "Value could not be parsed as a date"
        return future | unparsed, "Date is in the future"
    if "yyyy-mm-dd" in text or "yyyymmdd" in text or (
        "date" in text and "format" in text and "not in future" not in text
    ):
        return _dats_mask(as_str, empty)
    return None


def _parse_flexible_date(value: object) -> date | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    for fmt in ("%Y%m%d", "%Y-%m-%d", "%d-%m-%Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(raw.replace(" ", ""), fmt).date()
        except ValueError:
            continue
    return None


def summarize_findings(
    findings: list[dict[str, Any]],
    *,
    total_rows: int,
    fields_checked: int,
    rules_checked: int,
    business_object: str,
) -> dict[str, Any]:
    error_count = sum(item["affectedCount"] for item in findings if item.get("severity") == "error")
    warning_count = sum(
        item["affectedCount"] for item in findings if item.get("severity") == "warning"
    )
    groups: dict[str, dict[str, Any]] = {}
    for finding in findings:
        name = finding["fieldName"]
        group = groups.setdefault(
            name,
            {
                "fieldName": name,
                "errorCount": 0,
                "warningCount": 0,
                "findingCount": 0,
                "findings": [],
            },
        )
        group["findingCount"] += 1
        if finding.get("severity") == "warning":
            group["warningCount"] += finding["affectedCount"]
        else:
            group["errorCount"] += finding["affectedCount"]
        group["findings"].append(
            {
                "ruleName": finding["ruleName"],
                "severity": finding["severity"],
                "affectedCount": finding["affectedCount"],
                "affectedRowsSample": finding["affectedRows"],
                "affectedRowsLabel": (
                    f"Rows {', '.join(str(n) for n in finding['affectedRows'][:5])}"
                    if finding["affectedRows"]
                    else ""
                ),
                "summary": finding["summary"],
                "whatToCorrect": finding["issue"],
                "rule": finding.get("rule"),
            }
        )
    field_groups = sorted(groups.values(), key=lambda g: (-g["errorCount"], -g["warningCount"]))
    return {
        "summary": {
            "totalRows": total_rows,
            "fieldsChecked": fields_checked,
            "rulesChecked": rules_checked,
            "violationCount": len(findings),
            "errorCount": error_count,
            "warningCount": warning_count,
        },
        "report": {
            "headline": (
                f"Found {len(findings)} rule issue(s) across {len(field_groups)} field(s)."
                if findings
                else "No validation issues were found in the uploaded preload file."
            ),
            "businessObject": business_object,
            "fieldGroups": field_groups,
        },
    }
