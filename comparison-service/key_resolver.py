"""Resolve SAP key fields for dataset comparison."""

from __future__ import annotations

from typing import Protocol

from key_exceptions import (
    AmbiguousSheetMappingError,
    BusinessObjectNotFoundError,
    KeyResolverError,
    MissingKeyFieldsError,
    SapApiConnectionError,
    SapApiResponseError,
)
from sap_metadata_client import (
    SUPPORTED_BUSINESS_OBJECTS,
    SapMetadataClient,
    SapMetadataClientProtocol,
    normalize_business_object,
)

# Human-readable sheet names -> SAP detector labels (mirrors app business objects).
SHEET_NAME_ALIASES: dict[str, str] = {
    "material_master": "MATERIAL_MASTER",
    "material master": "MATERIAL_MASTER",
    "sales_order": "SALES_ORDER",
    "sales order": "SALES_ORDER",
    "gl_account": "GL_ACCOUNT",
    "gl account": "GL_ACCOUNT",
    "business_partner": "BUSINESS_PARTNER",
    "business partner": "BUSINESS_PARTNER",
    "customer_master": "BUSINESS_PARTNER",
    "customer master": "BUSINESS_PARTNER",
    "vendor_master": "BUSINESS_PARTNER",
    "vendor master": "BUSINESS_PARTNER",
    "purchase_order": "PURCHASE_ORDER",
    "purchase order": "PURCHASE_ORDER",
}

_KEY_FIELD_CACHE: dict[str, list[str]] = {}


class KeyFieldClient(Protocol):
    """Minimal client surface used by the key resolver."""

    def get_identifier_columns(self, business_object: str) -> list[str]:
        """Return SAP identifier columns for a business object."""


def clear_key_field_cache() -> None:
    """Clear the in-memory key-field cache (useful between comparison runs/tests)."""
    _KEY_FIELD_CACHE.clear()


def _normalize_sheet_name(sheet_name: str) -> str:
    return str(sheet_name or "").strip().lower()


def map_sheet_name_to_business_object(sheet_name: str) -> str:
    """
    Map an Excel sheet name to a SAP business object detector label.

    Sheet names are normalized and matched against supported SAP objects and
    known human-readable aliases.

    Raises:
        BusinessObjectNotFoundError: No supported business object matches.
        AmbiguousSheetMappingError: Multiple business objects match the sheet name.
    """
    normalized_sheet = _normalize_sheet_name(sheet_name)
    if not normalized_sheet:
        raise BusinessObjectNotFoundError(
            sheet_name,
            supported=SUPPORTED_BUSINESS_OBJECTS,
        )

    direct = normalize_business_object(normalized_sheet)
    if direct in SUPPORTED_BUSINESS_OBJECTS:
        return direct

    if normalized_sheet in SHEET_NAME_ALIASES:
        return SHEET_NAME_ALIASES[normalized_sheet]

    candidates: list[str] = []
    for alias, business_object in SHEET_NAME_ALIASES.items():
        if alias in normalized_sheet or normalized_sheet in alias:
            candidates.append(business_object)

    unique_candidates = list(dict.fromkeys(candidates))
    if len(unique_candidates) > 1:
        raise AmbiguousSheetMappingError(sheet_name, unique_candidates)
    if len(unique_candidates) == 1:
        return unique_candidates[0]

    raise BusinessObjectNotFoundError(
        sheet_name,
        supported=SUPPORTED_BUSINESS_OBJECTS,
    )


def resolve_key_fields(
    business_object: str,
    override_keys: list[str] | None = None,
    *,
    client: KeyFieldClient | None = None,
) -> list[str]:
    """
    Resolve comparison key fields for a SAP business object.

    When ``override_keys`` is provided and non-empty, those values are returned
    immediately without calling SAP. Otherwise the SAP metadata client is used,
    with results cached in memory for the lifetime of the process (or until
    ``clear_key_field_cache()`` is called).

    Args:
        business_object: SAP detector label (e.g. ``MATERIAL_MASTER``).
        override_keys: Explicit key columns that take precedence over SAP.
        client: Optional metadata client (defaults to ``SapMetadataClient``).

    Returns:
        List of key field column names.

    Raises:
        BusinessObjectNotFoundError: Unsupported business object.
        SapApiConnectionError: SAP endpoint unreachable or timed out.
        SapApiResponseError: SAP returned an error response.
        MissingKeyFieldsError: SAP metadata contained no identifier columns.
    """
    if override_keys:
        cleaned = [str(key).strip() for key in override_keys if str(key).strip()]
        if cleaned:
            return cleaned

    normalized = normalize_business_object(business_object)
    if normalized in _KEY_FIELD_CACHE:
        return list(_KEY_FIELD_CACHE[normalized])

    metadata_client = client or SapMetadataClient()
    try:
        key_fields = metadata_client.get_identifier_columns(normalized)
    except KeyResolverError:
        raise
    except Exception as exc:
        raise SapApiConnectionError(
            "Unexpected error while resolving SAP key fields",
            cause=exc,
        ) from exc

    _KEY_FIELD_CACHE[normalized] = list(key_fields)
    return list(key_fields)


def resolve_key_fields_for_sheets(
    sheet_names: list[str],
    override_keys: dict[str, list[str]] | None = None,
    *,
    client: KeyFieldClient | None = None,
) -> dict[str, list[str]]:
    """
    Resolve comparison key fields for each sheet in a multi-sheet workbook.

    Sheet names are mapped to SAP business objects via ``map_sheet_name_to_business_object``.
    Per-sheet overrides in ``override_keys`` take precedence over SAP for that sheet.

    Args:
        sheet_names: Excel worksheet names from the parsed workbook.
        override_keys: Optional mapping of sheet name -> explicit key columns.
        client: Optional SAP metadata client.

    Returns:
        Mapping of sheet name to resolved key field names.

    Raises:
        BusinessObjectNotFoundError: A sheet cannot be mapped to SAP.
        AmbiguousSheetMappingError: A sheet maps to multiple business objects.
        SapApiConnectionError: SAP endpoint unreachable or timed out.
        SapApiResponseError: SAP returned an error response.
        MissingKeyFieldsError: SAP metadata contained no identifier columns.
    """
    overrides = override_keys or {}
    resolved: dict[str, list[str]] = {}

    for sheet_name in sheet_names:
        sheet_override = overrides.get(sheet_name)
        if sheet_override:
            cleaned = [str(key).strip() for key in sheet_override if str(key).strip()]
            if cleaned:
                resolved[sheet_name] = cleaned
                continue

        business_object = map_sheet_name_to_business_object(sheet_name)
        resolved[sheet_name] = resolve_key_fields(
            business_object,
            client=client,
        )

    return resolved
