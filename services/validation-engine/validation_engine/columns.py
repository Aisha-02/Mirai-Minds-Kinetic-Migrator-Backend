from __future__ import annotations

from validation_engine.constants import FIELD_EQUIVALENCE_GROUPS


def normalize_field_key(value: object) -> str:
    return "".join(ch for ch in str(value or "").strip().upper() if ch.isalnum())


def _equivalence_index() -> dict[str, set[str]]:
    index: dict[str, set[str]] = {}
    for group in FIELD_EQUIVALENCE_GROUPS:
        norms = [normalize_field_key(name) for name in group]
        for name in norms:
            index.setdefault(name, set()).update(norms)
    return index


_EQUIVALENCE_INDEX = _equivalence_index()


def resolve_field_column(field_name: str, columns: list[str]) -> str | None:
    target = normalize_field_key(field_name)
    if not target:
        return None
    by_norm = {normalize_field_key(col): col for col in columns}
    if target in by_norm:
        return by_norm[target]
    for norm, col in by_norm.items():
        if target in norm or norm in target:
            return col
    equivalents = _EQUIVALENCE_INDEX.get(target)
    if equivalents:
        for norm, col in by_norm.items():
            if norm in equivalents:
                return col
    return None
