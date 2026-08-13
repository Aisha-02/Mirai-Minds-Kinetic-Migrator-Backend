from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from validation_engine.constants import INFERRED_DATS_FIELDS


class RulesProvider(Protocol):
    def get_rules(self, rules_business_object: str) -> dict[str, Any] | None:
        ...


@dataclass
class InMemoryRulesProvider:
    by_business_object: dict[str, dict[str, Any]]

    def get_rules(self, rules_business_object: str) -> dict[str, Any] | None:
        if rules_business_object in self.by_business_object:
            return self.by_business_object[rules_business_object]
        upper = str(rules_business_object).upper()
        for key, value in self.by_business_object.items():
            if str(key).upper() == upper:
                return value
        return None


@dataclass
class PreparedField:
    field_name: str
    key: str
    data_type: str
    length: int | None
    rules: list[dict[str, Any]] = field(default_factory=list)


def extract_fields(rules_payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not rules_payload:
        return []
    if isinstance(rules_payload.get("fields"), list):
        return list(rules_payload["fields"])
    nested = rules_payload.get("rules")
    if isinstance(nested, dict) and isinstance(nested.get("fields"), list):
        return list(nested["fields"])
    return []


def field_key_flag(field: dict[str, Any]) -> str:
    raw = field.get("key")
    if raw is None and isinstance(field.get("metadata"), dict):
        raw = field["metadata"].get("key")
    return "X" if str(raw or "").strip().upper() == "X" else ""


def resolve_field_data_type(field: dict[str, Any]) -> str:
    explicit = str(
        field.get("dataType") or (field.get("metadata") or {}).get("dataType") or ""
    ).strip().upper()
    if explicit:
        return explicit
    name = str(field.get("fieldName") or "").strip().upper()
    return "DATS" if name in INFERRED_DATS_FIELDS else ""


def resolve_field_length(field: dict[str, Any]) -> int | None:
    raw = field.get("length")
    if raw in ("", None) and isinstance(field.get("metadata"), dict):
        raw = field["metadata"].get("length")
    if raw in ("", None):
        return None
    try:
        number = int(raw)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def rule_text(rule: dict[str, Any]) -> str:
    parts = [
        rule.get("ruleName"),
        rule.get("description"),
        rule.get("constraint"),
        rule.get("category"),
        rule.get("type"),
        rule.get("ruleId"),
        rule.get("source"),
    ]
    return " ".join(str(part) for part in parts if part).lower()


def is_duplicate_rule(rule: dict[str, Any]) -> bool:
    text = rule_text(rule)
    return (
        "duplicate" in text
        or rule.get("ruleId") == "COMMON-DUPLICATE"
        or rule.get("constraint") in ("UNIQUE_REQUIRED", "FLAG_DUPLICATES")
    )


def predefined_rules(field: dict[str, Any]) -> list[dict[str, Any]]:
    is_key = field_key_flag(field) == "X"
    rules: list[dict[str, Any]] = [
        {
            "ruleName": "Null/Empty Value Check",
            "source": "PREDEFINED",
            "ruleId": "COMMON-NULL-EMPTY",
            "type": "validation",
            "description": (
                "Key field must not contain null or empty values."
                if is_key
                else "Validate null or empty values for this field."
            ),
            "constraint": "NOT_NULL_OR_EMPTY" if is_key else "FLAG_NULL_OR_EMPTY",
            "severity": "error" if is_key else "warning",
            "category": "completeness",
        }
    ]
    if is_key:
        rules.append(
            {
                "ruleName": "Duplicate Check",
                "source": "PREDEFINED",
                "ruleId": "COMMON-DUPLICATE",
                "type": "validation",
                "description": "Key field must not contain duplicate values across the uploaded file.",
                "constraint": "UNIQUE_REQUIRED",
                "severity": "error",
                "category": "uniqueness",
            }
        )
    return rules


def type_rules_for_field(field: dict[str, Any]) -> list[dict[str, Any]]:
    data_type = resolve_field_data_type(field)
    length = resolve_field_length(field)
    rules: list[dict[str, Any]] = []
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


def prepare_fields(rules_payload: dict[str, Any] | None) -> list[PreparedField]:
    by_name: dict[str, PreparedField] = {}
    for field in extract_fields(rules_payload):
        name = str(field.get("fieldName") or "").strip()
        if not name:
            continue
        key_flag = field_key_flag(field)
        stored = list(field.get("rules") or [])
        if key_flag != "X":
            stored = [rule for rule in stored if not is_duplicate_rule(rule)]
        by_name[name.upper()] = PreparedField(
            field_name=name,
            key=key_flag,
            data_type=resolve_field_data_type(field),
            length=resolve_field_length(field),
            rules=stored,
        )

    merged: list[PreparedField] = []
    for prepared in by_name.values():
        names = {str(rule.get("ruleName") or "").lower() for rule in prepared.rules}
        ids = {str(rule.get("ruleId") or "") for rule in prepared.rules}
        as_dict = {
            "fieldName": prepared.field_name,
            "key": prepared.key,
            "dataType": prepared.data_type,
            "length": prepared.length,
            "metadata": {"key": prepared.key, "dataType": prepared.data_type},
        }
        extra = predefined_rules(as_dict) + type_rules_for_field(as_dict)
        rules = list(prepared.rules)
        for rule in extra:
            rule_id = str(rule.get("ruleId") or "")
            if rule_id in ids or rule["ruleName"].lower() in names:
                continue
            if rule_id == "COMMON-TRIM":
                continue
            rules.append(rule)
        merged.append(
            PreparedField(
                field_name=prepared.field_name,
                key=prepared.key,
                data_type=prepared.data_type,
                length=prepared.length,
                rules=rules,
            )
        )
    return merged
