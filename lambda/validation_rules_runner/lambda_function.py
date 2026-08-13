"""
AWS Lambda: fetch validation_rules for a business object and evaluate
preload rows. Returns findings only — does not transform/clean data.
"""

from __future__ import annotations

import json
import os
import re
import ssl
from collections import defaultdict
from typing import Any

try:
    import pg8000.native as pg  # type: ignore
except ImportError:  # pragma: no cover
    pg = None


PREVIEW_ROW_LIMIT = 20
AFFECTED_SAMPLE_LIMIT = 25


def _norm(value: Any) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(value or "").strip().upper())


def _empty(value: Any) -> bool:
    return value is None or str(value).strip() == ""


def _field_key_flag(field: dict) -> str:
    """Primary key only when validation_rules field has key = 'X'."""
    raw = field.get("key")
    if raw is None and isinstance(field.get("metadata"), dict):
        raw = field["metadata"].get("key")
    return "X" if str(raw or "").strip().upper() == "X" else ""


def _rule_text(rule: dict) -> str:
    parts = [
        rule.get("ruleName"),
        rule.get("description"),
        rule.get("constraint"),
        rule.get("category"),
        rule.get("type"),
        rule.get("ruleId"),
        rule.get("source"),
    ]
    return " ".join(str(p) for p in parts if p).lower()


def _resolve_column(field_name: str, columns: list[str]) -> str | None:
    target = _norm(field_name)
    by_norm = {_norm(c): c for c in columns}
    if target in by_norm:
        return by_norm[target]
    for norm, col in by_norm.items():
        if target in norm or norm in target:
            return col
    return None


def _connect(db_cfg: dict):
    if pg is None:
        raise RuntimeError("pg8000 is required in the Lambda runtime")

    host = db_cfg.get("host") or os.environ.get("RDSHOST") or os.environ.get("DB_HOST")
    user = db_cfg.get("user") or os.environ.get("RDSUSER") or os.environ.get("DB_USER", "postgres")
    password = db_cfg.get("password") or os.environ.get("DB_PASSWORD") or os.environ.get("PGPASSWORD")
    database = db_cfg.get("database") or os.environ.get("RDSDATABASE") or os.environ.get("DB_NAME", "postgres")
    port = int(db_cfg.get("port") or os.environ.get("RDSPORT") or os.environ.get("DB_PORT") or 5432)
    ssl_mode = str(db_cfg.get("ssl") or os.environ.get("DB_SSL") or "require").lower()

    kwargs: dict[str, Any] = {
        "host": host,
        "user": user,
        "password": password,
        "database": database,
        "port": port,
    }
    if ssl_mode and ssl_mode not in ("disable", "false", "0"):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        kwargs["ssl_context"] = ctx

    if not host or not password:
        raise RuntimeError("Database host/password missing for validation_rules lookup")

    return pg.Connection(**kwargs)


def fetch_latest_rules(conn, business_object: str) -> dict | None:
    rows = conn.run(
        """
        SELECT id, business_object, rules, created_at
        FROM validation_rules
        WHERE business_object = :bo
        ORDER BY created_at DESC
        LIMIT 1
        """,
        bo=business_object,
    )
    if not rows:
        return None
    row = rows[0]
    rules = row[2]
    if isinstance(rules, str):
        rules = json.loads(rules)
    return {
        "id": str(row[0]),
        "business_object": row[1],
        "rules": rules,
        "created_at": row[3].isoformat() if hasattr(row[3], "isoformat") else str(row[3]),
    }


def _predefined_rules(field: dict) -> list[dict]:
    key = _field_key_flag(field) == "X"
    rules = [
        {
            "ruleName": "Null/Empty Value Check",
            "source": "PREDEFINED",
            "ruleId": "COMMON-NULL-EMPTY",
            "type": "validation",
            "description": (
                "Key field must not contain null or empty values."
                if key
                else "Validate null or empty values for this field."
            ),
            "constraint": "NOT_NULL_OR_EMPTY" if key else "FLAG_NULL_OR_EMPTY",
            "severity": "error" if key else "warning",
        },
    ]
    # Duplicate Check only when key = "X"
    if key:
        rules.append(
            {
                "ruleName": "Duplicate Check",
                "source": "PREDEFINED",
                "ruleId": "COMMON-DUPLICATE",
                "type": "validation",
                "description": "Key field must not contain duplicate values across the uploaded file.",
                "constraint": "UNIQUE_REQUIRED",
                "severity": "error",
            }
        )
    return rules


def _is_duplicate_rule(rule: dict) -> bool:
    text = _rule_text(rule)
    return (
        "duplicate" in text
        or rule.get("ruleId") == "COMMON-DUPLICATE"
        or rule.get("constraint") in ("UNIQUE_REQUIRED", "FLAG_DUPLICATES")
    )


def _extract_fields(rules_payload: dict) -> list[dict]:
    if not rules_payload:
        return []
    if isinstance(rules_payload.get("fields"), list):
        return rules_payload["fields"]
    nested = rules_payload.get("rules")
    if isinstance(nested, dict) and isinstance(nested.get("fields"), list):
        return nested["fields"]
    return []


def _merge_fields(fields: list[dict]) -> list[dict]:
    by_name: dict[str, dict] = {}
    for field in fields:
        name = str(field.get("fieldName") or "").strip()
        if not name:
            continue
        key_flag = _field_key_flag(field)
        stored_rules = list(field.get("rules") or [])
        # Strip duplicate rules from non-key fields
        if key_flag != "X":
            stored_rules = [r for r in stored_rules if not _is_duplicate_rule(r)]
        by_name[_norm(name)] = {
            "fieldName": name,
            "key": key_flag,
            "rules": stored_rules,
        }

    merged = []
    for field in by_name.values():
        existing_names = {str(r.get("ruleName") or "").lower() for r in field["rules"]}
        existing_ids = {str(r.get("ruleId") or "") for r in field["rules"]}
        rules = list(field["rules"])
        for pre in _predefined_rules(field):
            rid = pre.get("ruleId") or ""
            if rid in existing_ids or pre["ruleName"].lower() in existing_names:
                continue
            rules.append(pre)
        merged.append({"fieldName": field["fieldName"], "key": field["key"], "rules": rules})
    return merged


def _duplicate_rows(rows: list[dict], column: str) -> tuple[list[int], list[dict]]:
    groups: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for idx, row in enumerate(rows):
        raw = row.get(column)
        if _empty(raw):
            continue
        value = str(raw).strip()
        groups[value.upper()].append((idx + 1, value))

    affected: list[int] = []
    samples: list[dict] = []
    for entries in groups.values():
        if len(entries) < 2:
            continue
        for row_num, value in entries:
            affected.append(row_num)
            if len(samples) < 8:
                samples.append(
                    {
                        "row": row_num,
                        "value": value,
                        "reason": f'Duplicate key value "{value}" appears {len(entries)} times',
                    }
                )
    affected.sort()
    return affected, samples


def _check_value(rule: dict, value: Any) -> tuple[bool, str | None]:
    text = _rule_text(rule)
    empty = _empty(value)
    s = "" if empty else str(value).strip()

    if "duplicate" in text:
        return False, None

    if (
        "null/empty" in text
        or "null check" in text
        or rule.get("constraint") in ("NOT_NULL_OR_EMPTY", "FLAG_NULL_OR_EMPTY")
        or rule.get("ruleId") == "COMMON-NULL-EMPTY"
    ):
        if empty:
            return True, "Value is null/empty"
        return False, None

    length_match = re.search(r"(\d+)\s*characters?\s*or\s*less", text)
    if length_match and not empty and len(s) > int(length_match.group(1)):
        return True, f"Length {len(s)} exceeds max {length_match.group(1)}"

    if "leading zero" in text and not empty and re.match(r"^0+\d", s):
        return True, "Value has leading zeros"

    if ("greater than or equal to zero" in text or "greater than or equal to 0" in text) and not empty:
        try:
            n = float(str(s).replace(",", ""))
            if n < 0:
                return True, f"Value {n} is less than zero"
        except ValueError:
            return True, "Value is not numeric"

    if ("domain" in text or str(rule.get("category") or "").lower() == "domain") and str(
        rule.get("severity") or ""
    ).lower() == "error" and empty:
        return True, "Domain value is empty"

    return False, None


def evaluate(rows: list[dict], rules_payload: dict, business_object: str) -> dict:
    columns: list[str] = []
    seen = set()
    for row in rows:
        for key in row.keys():
            if key not in seen:
                seen.add(key)
                columns.append(key)

    fields = _merge_fields(_extract_fields(rules_payload))
    findings: list[dict] = []
    field_groups_map: dict[str, dict] = {}

    for field in fields:
        field_name = field["fieldName"]
        column = _resolve_column(field_name, columns)
        if not column:
            continue

        for rule in field.get("rules") or []:
            text = _rule_text(rule)
            severity = "warning" if str(rule.get("severity") or "").lower() == "warning" else "error"

            if "duplicate" in text or rule.get("ruleId") == "COMMON-DUPLICATE":
                # Duplicate Check only for primary keys (key = "X")
                if field.get("key") != "X":
                    continue
                affected, samples = _duplicate_rows(rows, column)
                if not affected:
                    continue
                finding = {
                    "fieldName": field_name,
                    "matchedColumn": column,
                    "ruleName": rule.get("ruleName") or "Duplicate Check",
                    "ruleViolated": rule.get("ruleName") or "Duplicate Check",
                    "severity": severity,
                    "affectedCount": len(affected),
                    "affectedRows": affected[:AFFECTED_SAMPLE_LIMIT],
                    "sampleValues": samples,
                    "issue": samples[0]["reason"] if samples else "Duplicate values found",
                    "summary": (
                        f"{field_name} has duplicate values in {len(affected)} rows — "
                        "primary key fields must be unique in the preload file."
                        if field.get("key") == "X"
                        else f"{field_name} has duplicate values in {len(affected)} rows."
                    ),
                    "rule": {
                        "ruleName": rule.get("ruleName"),
                        "source": rule.get("source"),
                        "description": rule.get("description"),
                        "constraint": rule.get("constraint"),
                        "severity": rule.get("severity"),
                        "category": rule.get("category") or "uniqueness",
                    },
                }
            else:
                affected_rows: list[int] = []
                samples = []
                for idx, row in enumerate(rows):
                    violated, reason = _check_value(rule, row.get(column))
                    if not violated:
                        continue
                    row_num = idx + 1
                    affected_rows.append(row_num)
                    if len(samples) < 8:
                        samples.append(
                            {
                                "row": row_num,
                                "value": None if row.get(column) is None else str(row.get(column)),
                                "reason": reason,
                            }
                        )
                if not affected_rows:
                    continue
                finding = {
                    "fieldName": field_name,
                    "matchedColumn": column,
                    "ruleName": rule.get("ruleName") or "Unnamed rule",
                    "ruleViolated": rule.get("ruleName") or "Unnamed rule",
                    "severity": severity,
                    "affectedCount": len(affected_rows),
                    "affectedRows": affected_rows[:AFFECTED_SAMPLE_LIMIT],
                    "sampleValues": samples,
                    "issue": samples[0]["reason"] if samples else "Rule violated",
                    "summary": (
                        f"{field_name}: {samples[0]['reason'] if samples else 'rule violated'} "
                        f"in {len(affected_rows)} row(s) — {rule.get('description') or rule.get('constraint') or 'see validation rule'}."
                    ),
                    "rule": {
                        "ruleName": rule.get("ruleName"),
                        "source": rule.get("source"),
                        "description": rule.get("description"),
                        "constraint": rule.get("constraint"),
                        "severity": rule.get("severity"),
                        "category": rule.get("category"),
                    },
                }

            findings.append(finding)
            group = field_groups_map.setdefault(
                field_name,
                {
                    "fieldName": field_name,
                    "errorCount": 0,
                    "warningCount": 0,
                    "findingCount": 0,
                    "findings": [],
                },
            )
            group["findings"].append(
                {
                    "ruleName": finding["ruleName"],
                    "severity": finding["severity"],
                    "affectedCount": finding["affectedCount"],
                    "affectedRowsSample": finding["affectedRows"],
                    "affectedRowsLabel": (
                        f"Rows {', '.join(str(r) for r in finding['affectedRows'][:5])}"
                        if finding["affectedRows"]
                        else ""
                    ),
                    "summary": finding["summary"],
                    "whatToCorrect": finding["issue"],
                    "rule": finding["rule"],
                }
            )
            group["findingCount"] += 1
            if finding["severity"] == "warning":
                group["warningCount"] += finding["affectedCount"]
            else:
                group["errorCount"] += finding["affectedCount"]

    field_groups = sorted(
        field_groups_map.values(),
        key=lambda g: (-g["errorCount"], -g["warningCount"], g["fieldName"]),
    )

    error_count = sum(f["affectedCount"] for f in findings if f["severity"] == "error")
    warning_count = sum(f["affectedCount"] for f in findings if f["severity"] == "warning")

    return {
        "summary": {
            "totalRows": len(rows),
            "fieldsChecked": len(fields),
            "rulesChecked": sum(len(f.get("rules") or []) for f in fields),
            "violationCount": len(findings),
            "errorCount": error_count,
            "warningCount": warning_count,
        },
        "findings": findings,
        "report": {
            "headline": (
                f"Found {len(findings)} rule issue(s) across {len(field_groups)} field(s)."
                if findings
                else "No validation issues were found in the uploaded preload file."
            ),
            "businessObject": business_object,
            "fieldGroups": field_groups,
        },
        "previewRows": rows[:PREVIEW_ROW_LIMIT],
    }


def handler(event, context=None):
    if isinstance(event, str):
        event = json.loads(event)
    if event.get("body") and isinstance(event["body"], str):
        event = {**event, **json.loads(event["body"])}

    business_object = str(event.get("businessObject") or "").strip()
    rows = event.get("rows") or []
    if not business_object:
        return {"ok": False, "error": "businessObject is required"}
    if not isinstance(rows, list) or not rows:
        return {"ok": False, "error": "rows[] with preload data is required"}

    db_cfg = event.get("db") or {}
    conn = _connect(db_cfg)
    try:
        rule_set = fetch_latest_rules(conn, business_object)
    finally:
        try:
            conn.close()
        except Exception:
            pass

    if not rule_set:
        return {
            "ok": False,
            "error": f"No saved validation rules found for business object '{business_object}'",
            "businessObject": business_object,
        }

    evaluation = evaluate(rows, rule_set["rules"], business_object)
    return {
        "ok": True,
        "businessObject": business_object,
        "ruleSet": {
            "id": rule_set["id"],
            "business_object": rule_set["business_object"],
            "created_at": rule_set["created_at"],
        },
        **evaluation,
    }


if __name__ == "__main__":
    import sys

    payload = json.load(sys.stdin)
    result = handler(payload)
    json.dump(result, sys.stdout)
