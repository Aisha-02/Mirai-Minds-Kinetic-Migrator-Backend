"""
AWS Lambda: fetch validation_rules for a business object and evaluate
preload rows against that ruleset (any BO). Optionally apply stored-rule
transforms and return refined rows. Uniqueness is only for fields with key=X.
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


# Equivalent SAP / preload column names (mirrors src/constants/fieldColumnAliases.js)
FIELD_EQUIVALENCE_GROUPS: list[list[str]] = [
    ["MATERIALNUMBER", "MATNR"],
    ["MATERIALTYPE", "MTART"],
    ["MATERIALGROUP", "MATKL"],
    ["MATERIALDESC", "MAKTX", "MATERIALDESCRIPTION"],
    ["UOMCODE", "MEINS", "BASEUNITOFMEASURE"],
    ["PLANTCODE", "WERKS", "PLANT"],
    ["LANGUAGECODE", "SPRAS", "LANGUAGEKEY"],
    ["GROSSWEIGHT", "BRGEW"],
    ["NETWEIGHT", "NTGEW"],
    ["WEIGHTUNIT", "GEWEI"],
    ["PONUMBER", "EBELN", "PURCHASEORDER"],
    ["POITEM", "EBELP", "ITEMNUMBER"],
    ["VENDORNUMBER", "LIFNR", "VENDOR"],
    ["PARTNERNUMBER", "PARTNER", "BPNUMBER", "KUNNR", "LIFNR"],
    ["SALESORDERNUMBER", "VBELN", "SALESORDER"],
    ["SALESORDERTYPE", "AUART", "DOCTYPE"],
    ["SALESORDERITEM", "POSNR", "ITEM"],
    ["GLACCOUNT", "SAKNR", "GLACCOUNTNUMBER", "HKONT"],
]

_EQUIVALENCE_INDEX: dict[str, set[str]] = {}
for _group in FIELD_EQUIVALENCE_GROUPS:
    _norms = [_norm(name) for name in _group]
    for _name in _norms:
        _EQUIVALENCE_INDEX.setdefault(_name, set()).update(_norms)


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


def _rule_source_rank(source: Any) -> int:
    value = str(source or "").strip().upper()
    if value in {"CUSTOM", "ADMIN"}:
        return 0
    if value == "PREDEFINED":
        return 1
    if value == "AI":
        return 2
    return 3


def _is_transformation_rule(rule: dict) -> bool:
    rule_type = str(rule.get("type") or "").lower()
    category = str(rule.get("category") or "").lower()
    return rule_type == "transformation" or category == "transformation"


def _rule_conflict_key(rule: dict) -> str:
    if _is_transformation_rule(rule):
        return "transformation"
    text = _rule_text(rule)
    rule_id = str(rule.get("ruleId") or "")
    if (
        "duplicate" in text
        or rule_id == "COMMON-DUPLICATE"
        or rule.get("constraint") in ("UNIQUE_REQUIRED", "FLAG_DUPLICATES")
    ):
        return "duplicate"
    if (
        "null/empty" in text
        or "null check" in text
        or rule_id == "COMMON-NULL-EMPTY"
        or rule.get("constraint") in ("NOT_NULL_OR_EMPTY", "FLAG_NULL_OR_EMPTY")
    ):
        return "null_empty"
    return f"unique:{rule_id or rule.get('ruleName') or text}"


def _prioritize_field_rules(rules: list[dict]) -> list[dict]:
    items = list(rules or [])
    best_rank: dict[str, int] = {}
    for rule in items:
        key = _rule_conflict_key(rule)
        rank = _rule_source_rank(rule.get("source"))
        current = best_rank.get(key)
        if current is None or rank < current:
            best_rank[key] = rank

    filtered = [
        rule
        for rule in items
        if _rule_source_rank(rule.get("source")) == best_rank[_rule_conflict_key(rule)]
    ]

    def sort_key(rule: dict) -> tuple[int, int]:
        transform = 0 if _is_transformation_rule(rule) else 1
        return (_rule_source_rank(rule.get("source")), transform)

    filtered.sort(key=sort_key)
    return filtered


def _parse_pad_to_length(text: str) -> int | None:
    haystack = str(text or "").lower()
    pads = any(token in haystack for token in ("leading", "pad", "append", "add"))
    if not pads:
        return None
    match = (
        re.search(r"(\d+)\s*characters?\s*long", haystack)
        or re.search(r"make it\s*(\d+)", haystack)
        or re.search(r"pad(?:ded)?(?: with leading zeros?)? to\s*(\d+)", haystack)
        or re.search(r"(\d+)\s*characters?", haystack)
    )
    return int(match.group(1)) if match else None


def _resolve_column(field_name: str, columns: list[str]) -> str | None:
    """Map a stored rule field to a file column for any business object.

    Exact name or declared SAP alias only. Never substring-match a parent
    field onto a sibling (salesOrder vs salesOrderType, material vs
    materialType, po vs poItem, …). Uniqueness still uses key == 'X'.
    """
    target = _norm(field_name)
    if not target:
        return None
    by_norm: dict[str, str] = {}
    for col in columns or []:
        norm = _norm(col)
        if norm and norm not in by_norm:
            by_norm[norm] = col
    if target in by_norm:
        return by_norm[target]
    equivalents = _EQUIVALENCE_INDEX.get(target)
    if equivalents:
        for norm, col in by_norm.items():
            if norm in equivalents:
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
    rule_id = str(rule.get("ruleId") or "")
    constraint = str(rule.get("constraint") or "")
    name = str(rule.get("ruleName") or "").strip().lower()
    return (
        rule_id == "COMMON-DUPLICATE"
        or constraint in ("UNIQUE_REQUIRED", "FLAG_DUPLICATES")
        or name == "duplicate check"
        or name.startswith("duplicate check")
    )


INFERRED_DATS_FIELDS = {
    "BEDAT", "AEDAT", "BUDAT", "BLDAT", "EINDT", "DATUM", "ERDAT", "LAEDA",
    "CPUDT", "BEGDA", "ENDDA", "GSTRP", "GLTRP", "FKDAT", "BILLDATE", "VALUT", "AUGDT",
}


def _resolve_field_data_type(field: dict) -> str:
    explicit = _norm(field.get("dataType") or (field.get("metadata") or {}).get("dataType"))
    if explicit:
        return explicit
    if str(field.get("fieldName") or "").strip().upper() in INFERRED_DATS_FIELDS:
        return "DATS"
    return ""


def _resolve_field_length(field: dict) -> int | None:
    raw = field.get("length")
    if raw in ("", None) and isinstance(field.get("metadata"), dict):
        raw = field["metadata"].get("length")
    if raw in ("", None):
        return None
    try:
        n = int(raw)
        return n if n > 0 else None
    except (TypeError, ValueError):
        return None


def _type_rules_for_field(field: dict) -> list[dict]:
    data_type = _resolve_field_data_type(field)
    length = _resolve_field_length(field)
    rules: list[dict] = []

    if data_type == "DATS":
        rules.append(
            {
                "ruleName": "SAP DATS Format Check",
                "source": "PREDEFINED",
                "ruleId": "COMMON-DATS-FORMAT",
                "type": "validation",
                "description": "Date must be in SAP DATS format YYYYMMDD (8 numeric digits, valid calendar date).",
                "constraint": "SAP_DATS_YYYYMMDD",
                "severity": "error",
                "category": "format",
            }
        )

    if data_type == "TIMS":
        rules.append(
            {
                "ruleName": "SAP TIMS Format Check",
                "source": "PREDEFINED",
                "ruleId": "COMMON-TIMS-FORMAT",
                "type": "validation",
                "description": "Time must be in SAP TIMS format HHMMSS (6 numeric digits, valid time).",
                "constraint": "SAP_TIMS_HHMMSS",
                "severity": "error",
                "category": "format",
            }
        )

    if length is not None and data_type not in ("DATS", "TIMS"):
        rules.append(
            {
                "ruleName": "Field Length Check",
                "source": "PREDEFINED",
                "ruleId": "COMMON-FIELD-LENGTH",
                "type": "validation",
                "description": f"Value must not exceed {length} characters for SAP type {data_type or 'CHAR'}.",
                "constraint": f"MAX_LENGTH_{length}",
                "severity": "warning",
                "category": "format",
                "maxLength": length,
            }
        )

    return rules


def _validate_sap_dats(value: Any) -> tuple[bool, str | None]:
    if _empty(value):
        return False, None
    raw = str(value).strip()
    if re.search(r"[-/.]", raw):
        return True, f'Value "{raw}" is not in SAP DATS format (use YYYYMMDD, e.g. 20260801)'
    digits = raw.replace(" ", "")
    if not re.fullmatch(r"\d+", digits):
        return True, f'Value "{raw}" must contain only digits for SAP DATS'
    if len(digits) != 8:
        return True, f'Value "{raw}" must be exactly 8 digits (YYYYMMDD); found {len(digits)}'
    year, month, day = int(digits[:4]), int(digits[4:6]), int(digits[6:8])
    try:
        from datetime import date

        date(year, month, day)
    except ValueError:
        return True, f'Value "{digits}" is not a valid calendar date'
    return False, None


def _parse_flexible_date(value: Any):
    from datetime import date

    raw = str(value).strip()
    if not raw:
        return None
    violated, _ = _validate_sap_dats(raw)
    if not violated:
        digits = raw.replace(" ", "")
        if re.fullmatch(r"\d{8}", digits):
            return date(int(digits[:4]), int(digits[4:6]), int(digits[6:8]))

    iso = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", raw)
    if iso:
        try:
            return date(int(iso.group(1)), int(iso.group(2)), int(iso.group(3)))
        except ValueError:
            return None

    dmy = re.fullmatch(r"(\d{2})-(\d{2})-(\d{4})", raw)
    if dmy:
        try:
            return date(int(dmy.group(3)), int(dmy.group(2)), int(dmy.group(1)))
        except ValueError:
            return None

    return None


def _validate_date_not_in_future(value: Any) -> tuple[bool, str | None]:
    if _empty(value):
        return False, None
    parsed = _parse_flexible_date(value)
    if not parsed:
        return True, f'Value "{str(value).strip()}" could not be parsed as a date'
    from datetime import date

    if parsed > date.today():
        return True, f'Date {str(value).strip()} is in the future'
    return False, None


def _check_sap_type_rule(rule: dict, value: Any, field: dict) -> tuple[bool, str | None] | None:
    rule_id = str(rule.get("ruleId") or "")
    data_type = _resolve_field_data_type(field)

    if (
        rule_id == "COMMON-DATS-FORMAT"
        or rule.get("constraint") == "SAP_DATS_YYYYMMDD"
        or (data_type == "DATS" and "dats" in str(rule.get("ruleName") or "").lower())
    ):
        return _validate_sap_dats(value)

    if rule_id == "COMMON-TIMS-FORMAT" or rule.get("constraint") == "SAP_TIMS_HHMMSS":
        if _empty(value):
            return False, None
        raw = str(value).strip().replace(":", "")
        if not re.fullmatch(r"\d{6}", raw):
            return True, f'Value "{str(value).strip()}" must be 6 digits (HHMMSS) for SAP TIMS'
        hours, minutes, seconds = int(raw[:2]), int(raw[2:4]), int(raw[4:6])
        if hours > 23 or minutes > 59 or seconds > 59:
            return True, f'Value "{raw}" is not a valid time (HHMMSS)'
        return False, None

    if rule_id == "COMMON-FIELD-LENGTH":
        max_len = rule.get("maxLength")
        if not max_len:
            match = re.search(r"(\d+)", str(rule.get("constraint") or ""))
            max_len = int(match.group(1)) if match else None
        if not max_len or _empty(value):
            return False, None
        length = len(str(value).strip())
        if length > int(max_len):
            return True, f"Length {length} exceeds max {max_len} for field type {data_type or 'CHAR'}"
        return False, None

    return None


def _check_date_related_rule(rule: dict, value: Any) -> tuple[bool, str | None] | None:
    text = _rule_text(rule)
    if (
        "not in future" in text
        or "not in the future" in text
        or "future date" in text
        or ("future" in text and "date" in text)
    ):
        return _validate_date_not_in_future(value)

    if "yyyy-mm-dd" in text or "yyyymmdd" in text or (
        "date" in text and "format" in text and "not in future" not in text
    ):
        return _validate_sap_dats(value)

    return None


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
            "dataType": field.get("dataType") or (field.get("metadata") or {}).get("dataType") or "",
            "length": field.get("length") if field.get("length") not in (None, "") else (field.get("metadata") or {}).get("length", ""),
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
        for type_rule in _type_rules_for_field(field):
            rid = type_rule.get("ruleId") or ""
            if rid in existing_ids or type_rule["ruleName"].lower() in existing_names:
                continue
            rules.append(type_rule)
        merged.append(
            {
                "fieldName": field["fieldName"],
                "key": field["key"],
                "dataType": field.get("dataType", ""),
                "length": field.get("length", ""),
                "rules": _prioritize_field_rules(rules),
            }
        )
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


def _check_value(rule: dict, value: Any, field: dict | None = None) -> tuple[bool, str | None]:
    text = _rule_text(rule)
    empty = _empty(value)
    s = "" if empty else str(value).strip()

    if "duplicate" in text:
        return False, None

    if field is not None:
        sap_result = _check_sap_type_rule(rule, value, field)
        if sap_result is not None:
            return sap_result
        date_result = _check_date_related_rule(rule, value)
        if date_result is not None:
            return date_result

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

    pad_length = _parse_pad_to_length(text)
    if pad_length and not empty and s.isdigit() and len(s) < pad_length:
        return True, f"Length {len(s)} is shorter than {pad_length}; pad with leading zeros"

    if "leading zero" in text and not pad_length and not empty and re.match(r"^0+\d", s):
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

            if _is_duplicate_rule(rule):
                # Duplicate uniqueness only when this field is stored as key = "X"
                # on the loaded validation_rules row (any business object).
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
                        "type": rule.get("type"),
                        "description": rule.get("description"),
                        "constraint": rule.get("constraint"),
                        "severity": rule.get("severity"),
                        "category": rule.get("category") or "uniqueness",
                        "ruleId": rule.get("ruleId"),
                    },
                }
            else:
                affected_rows: list[int] = []
                samples = []
                for idx, row in enumerate(rows):
                    violated, reason = _check_value(rule, row.get(column), field)
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
                        "type": rule.get("type"),
                        "description": rule.get("description"),
                        "constraint": rule.get("constraint"),
                        "severity": rule.get("severity"),
                        "category": rule.get("category"),
                        "ruleId": rule.get("ruleId"),
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

    for group in field_groups_map.values():
        group["findings"].sort(
            key=lambda item: _rule_source_rank((item.get("rule") or {}).get("source"))
        )

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


def _source_rank(source: Any) -> int:
    return _rule_source_rank(source)


def _infer_transform(finding: dict) -> dict | None:
    rule = finding.get("rule") or finding
    text = _rule_text(rule)
    if _is_duplicate_rule(rule):
        return {"type": "remove_duplicate_rows", "label": "Remove duplicate key rows (keep first)"}
    if (
        rule.get("ruleId") == "COMMON-DATS-FORMAT"
        or rule.get("constraint") == "SAP_DATS_YYYYMMDD"
        or "dats" in text
        or ("yyyymmdd" in text and "date" in text)
    ):
        return {"type": "normalize_dats", "label": "Normalize date to SAP DATS YYYYMMDD"}
    if "trim" in text or rule.get("ruleId") == "COMMON-TRIM":
        return {"type": "trim_whitespace", "label": "Trim whitespace"}
    if "uppercase" in text or "upper case" in text:
        return {"type": "to_uppercase", "label": "Uppercase"}
    pad_length = _parse_pad_to_length(text)
    if pad_length:
        return {"type": "fit_length", "params": {"max": pad_length}, "label": f"Pad/fit length {pad_length}"}
    if ("leading zero" in text or "leading zeros" in text) and not pad_length:
        return {"type": "strip_leading_zeros", "label": "Strip leading zeros"}
    if rule.get("ruleId") == "COMMON-FIELD-LENGTH" or str(rule.get("constraint") or "").startswith("MAX_LENGTH_"):
        match = re.search(r"(\d+)", str(rule.get("maxLength") or rule.get("constraint") or text))
        if match:
            max_len = int(match.group(1))
            return {"type": "fit_length", "params": {"max": max_len}, "label": f"Fit length {max_len}"}
    return None


def _normalize_dats(value: Any) -> Any:
    if _empty(value):
        return value
    raw = str(value).strip()
    digits = re.sub(r"\D", "", raw)
    if re.fullmatch(r"\d{8}", digits):
        return digits
    iso = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", raw)
    if iso:
        return f"{iso.group(1)}{iso.group(2)}{iso.group(3)}"
    dmy = re.fullmatch(r"(\d{2})-(\d{2})-(\d{4})", raw)
    if dmy:
        return f"{dmy.group(3)}{dmy.group(2)}{dmy.group(1)}"
    if re.fullmatch(r"\d{7}", digits):
        return digits.zfill(8)
    return value


def _apply_value(transform: dict, value: Any) -> Any:
    kind = transform.get("type")
    if _empty(value) and kind != "remove_duplicate_rows":
        return value
    raw = "" if _empty(value) else str(value).strip()
    if kind == "trim_whitespace":
        return raw
    if kind == "to_uppercase":
        return raw.upper()
    if kind == "strip_leading_zeros":
        stripped = re.sub(r"^0+(?=\d)", "", raw)
        return stripped or "0"
    if kind == "normalize_dats":
        return _normalize_dats(value)
    if kind == "fit_length":
        max_len = int((transform.get("params") or {}).get("max") or 18)
        if raw.isdigit():
            if len(raw) < max_len:
                raw = raw.zfill(max_len)
            if len(raw) > max_len:
                raw = raw[-max_len:]
            return raw
        return raw[:max_len] if len(raw) > max_len else raw
    return value


def _remove_duplicate_rows(rows: list[dict], column: str) -> list[dict]:
    seen: set[str] = set()
    result: list[dict] = []
    for row in rows:
        raw = row.get(column)
        if _empty(raw):
            result.append(dict(row))
            continue
        key = str(raw).strip().upper()
        if key in seen:
            continue
        seen.add(key)
        result.append(dict(row))
    return result


def apply_findings(rows: list[dict], findings: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    data = [dict(row) for row in (rows or [])]
    applied: list[dict] = []
    skipped: list[dict] = []
    seen: set[str] = set()

    ordered = sorted(
        findings or [],
        key=lambda item: (
            _source_rank((item.get("rule") or item).get("source")),
            0 if _is_transformation_rule(item.get("rule") or item) else 1,
        ),
    )

    winning_transform: dict[str, int] = {}
    for finding in ordered:
        rule = finding.get("rule") or finding
        if not _is_transformation_rule(rule):
            continue
        field_key = str(finding.get("fieldName") or "").upper()
        rank = _source_rank(rule.get("source"))
        current = winning_transform.get(field_key)
        if current is None or rank < current:
            winning_transform[field_key] = rank

    for finding in ordered:
        rule = finding.get("rule") or finding
        field_name = finding.get("fieldName")
        field_key = str(field_name or "").upper()
        rank = _source_rank(rule.get("source"))
        winning = winning_transform.get(field_key)
        if _is_transformation_rule(rule) and winning is not None and rank > winning:
            skipped.append(
                {
                    "fieldName": field_name,
                    "ruleName": finding.get("ruleName") or finding.get("ruleViolated"),
                    "reason": "Skipped because a higher-priority rule already applies to this field",
                }
            )
            continue

        dedupe_key = f"{field_name}::{finding.get('ruleName') or finding.get('ruleViolated')}"
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        transform = _infer_transform(finding)
        if not transform:
            skipped.append(
                {
                    "fieldName": field_name,
                    "ruleName": finding.get("ruleName") or finding.get("ruleViolated"),
                    "reason": "No safe Python transform mapping for this stored rule",
                }
            )
            continue

        column = finding.get("matchedColumn") or _resolve_column(
            field_name, list(data[0].keys()) if data else []
        )
        if not column:
            skipped.append(
                {
                    "fieldName": field_name,
                    "ruleName": finding.get("ruleName") or finding.get("ruleViolated"),
                    "reason": f"Could not find column for field {field_name}",
                }
            )
            continue

        if transform["type"] == "remove_duplicate_rows":
            before = len(data)
            data = _remove_duplicate_rows(data, column)
            if len(data) == before:
                skipped.append(
                    {
                        "fieldName": field_name,
                        "ruleName": finding.get("ruleName") or finding.get("ruleViolated"),
                        "reason": "No duplicate rows would be removed",
                    }
                )
                continue
            applied.append(
                {
                    "fieldName": field_name,
                    "ruleName": finding.get("ruleName") or finding.get("ruleViolated"),
                    "transform": transform["type"],
                    "source": rule.get("source"),
                    "affectedCount": before - len(data),
                }
            )
            continue

        changed = 0
        for row in data:
            before_value = row.get(column)
            after_value = _apply_value(transform, before_value)
            if str(before_value or "") != str(after_value or ""):
                row[column] = after_value
                changed += 1
        if not changed:
            skipped.append(
                {
                    "fieldName": field_name,
                    "ruleName": finding.get("ruleName") or finding.get("ruleViolated"),
                    "reason": "Values already satisfy the stored rule",
                }
            )
            continue
        applied.append(
            {
                "fieldName": field_name,
                "ruleName": finding.get("ruleName") or finding.get("ruleViolated"),
                "transform": transform["type"],
                "source": rule.get("source"),
                "affectedCount": changed,
            }
        )

    return data, applied, skipped


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
    apply_fixes = str(event.get("applyFixes", True)).lower() not in ("false", "0", "no")
    refined_rows = rows
    applied_fixes: list[dict] = []
    skipped_fixes: list[dict] = []
    if apply_fixes:
        refined_rows, applied_fixes, skipped_fixes = apply_findings(rows, evaluation["findings"])

    return {
        "ok": True,
        "businessObject": business_object,
        "ruleSet": {
            "id": rule_set["id"],
            "business_object": rule_set["business_object"],
            "created_at": rule_set["created_at"],
        },
        **evaluation,
        "refinedRows": refined_rows,
        "appliedFixes": applied_fixes,
        "skippedFixes": skipped_fixes,
        "fixesApplied": len(applied_fixes),
        "fixesSkipped": len(skipped_fixes),
    }


if __name__ == "__main__":
    import sys

    payload = json.load(sys.stdin)
    result = handler(payload)
    json.dump(result, sys.stdout)
