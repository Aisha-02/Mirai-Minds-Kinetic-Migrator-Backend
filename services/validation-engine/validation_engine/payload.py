"""Normalize Node's rule payload into InMemoryRulesProvider maps."""

from __future__ import annotations

from typing import Any

from validation_engine.constants import DETECTOR_TO_RULES_BO, RULES_BO_TO_DETECTOR
from validation_engine.rules import InMemoryRulesProvider


def normalize_rules_map(raw: Any) -> dict[str, dict[str, Any]]:
    """
    Accept any of:
      { "MM": { fields: [...] }, "SO": {...} }
      { "MATERIAL_MASTER": { fields: [...] } }
      [ { "businessObject": "MM", "fields": [...] } ]
      { "rules": [ ...same... ] }
    """
    if raw is None:
        return {}
    if isinstance(raw, dict) and isinstance(raw.get("rules"), list) and "fields" not in raw:
        raw = raw["rules"]
    if isinstance(raw, list):
        mapped: dict[str, dict[str, Any]] = {}
        for item in raw:
            if not isinstance(item, dict):
                continue
            key = _rules_bo_key(item.get("businessObject") or item.get("business_object"))
            if key:
                mapped[key] = item
        return mapped
    if not isinstance(raw, dict):
        return {}

    if isinstance(raw.get("fields"), list) and raw.get("businessObject"):
        key = _rules_bo_key(raw.get("businessObject"))
        return {key: raw} if key else {}

    mapped = {}
    for key, value in raw.items():
        if not isinstance(value, dict):
            continue
        rules_bo = _rules_bo_key(key) or _rules_bo_key(
            value.get("businessObject") or value.get("business_object")
        )
        if rules_bo:
            mapped[rules_bo] = value
    return mapped


def rules_provider_from_payload(raw: Any) -> InMemoryRulesProvider:
    return InMemoryRulesProvider(normalize_rules_map(raw))


def _rules_bo_key(value: object) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    detector = text.upper().replace(" ", "_")
    if detector in DETECTOR_TO_RULES_BO:
        return DETECTOR_TO_RULES_BO[detector]
    if text in RULES_BO_TO_DETECTOR:
        return text
    upper = {k.upper(): k for k in RULES_BO_TO_DETECTOR}
    return upper.get(text.upper())
