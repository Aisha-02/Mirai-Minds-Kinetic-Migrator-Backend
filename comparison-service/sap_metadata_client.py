"""
SAP OData V2 business-object metadata client.

Python port of the Node.js integration in src/services/sapMetadataService.js.
Uses the same environment variables and key-field resolution rules.
"""

from __future__ import annotations

import base64
import json
import os
import ssl
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol

from key_exceptions import (
    BusinessObjectNotFoundError,
    MissingKeyFieldsError,
    SapApiConnectionError,
    SapApiResponseError,
)

SUPPORTED_BUSINESS_OBJECTS: tuple[str, ...] = (
    "MATERIAL_MASTER",
    "SALES_ORDER",
    "GL_ACCOUNT",
    "BUSINESS_PARTNER",
    "PURCHASE_ORDER",
)

SYSTEM_CLIENT_FIELDS = frozenset({"CLIENT", "MANDT"})

FALLBACK_IDENTIFIER_COLUMNS: dict[str, tuple[str, ...]] = {
    "MATERIAL_MASTER": ("MATNR",),
    "BUSINESS_PARTNER": ("PARTNER",),
    "SALES_ORDER": ("VBELN", "POSNR"),
    "GL_ACCOUNT": ("SAKNR",),
    "PURCHASE_ORDER": ("EBELN", "EBELP"),
}

DEFAULT_TIMEOUT_SEC = 15.0


@dataclass(frozen=True)
class SapMetadataField:
    field_name: str
    data_type: str | None
    length: int | None
    decimals: int | None
    is_key: bool


class SapMetadataClientProtocol(Protocol):
    """Protocol for fetching SAP identifier columns (enables mocking in tests)."""

    def get_identifier_columns(self, business_object: str) -> list[str]:
        """Return key field names for a SAP business object."""


@dataclass
class SapClientConfig:
    base_url: str
    username: str
    password: str
    timeout_sec: float = DEFAULT_TIMEOUT_SEC

    @classmethod
    def from_env(cls) -> "SapClientConfig":
        return cls(
            base_url=str(os.getenv("SAP_ODATA_BASE_URL", "")).strip().rstrip("/"),
            username=str(os.getenv("SAP_ODATA_USERNAME", "")).strip(),
            password=str(os.getenv("SAP_ODATA_PASSWORD", "")),
            timeout_sec=float(
                os.getenv("SAP_ODATA_TIMEOUT_MS", str(int(DEFAULT_TIMEOUT_SEC * 1000)))
            )
            / 1000.0,
        )


def normalize_business_object(value: str) -> str:
    """Normalize a business object label to SAP detector form."""
    return (
        str(value or "")
        .strip()
        .upper()
        .replace(" ", "_")
    )


def _pick(record: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        value = record.get(key)
        if value is not None and value != "":
            return value
    return None


def _to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value == 1
    normalized = str(value or "").strip().lower()
    return normalized in {"true", "x", "yes", "1", "key"}


def normalize_field_record(raw: dict[str, Any]) -> SapMetadataField | None:
    """Normalize a raw SAP metadata field record."""
    field_name = _pick(
        raw,
        (
            "fieldName",
            "FieldName",
            "FIELD_NAME",
            "name",
            "Name",
            "PropertyName",
            "propertyName",
            "COLUMN_NAME",
            "ColumnName",
        ),
    )
    if field_name is None or str(field_name).strip() == "":
        return None

    data_type_raw = _pick(
        raw,
        (
            "dataType",
            "DataType",
            "DATA_TYPE",
            "type",
            "Type",
            "EdmType",
            "ABAPType",
            "AbapType",
        ),
    )
    length_raw = _pick(
        raw,
        ("length", "Length", "LENGTH", "maxLength", "MaxLength", "Precision", "precision"),
    )
    decimals_raw = _pick(
        raw,
        ("decimals", "Decimals", "DECIMALS", "scale", "Scale"),
    )
    is_key_raw = _pick(
        raw,
        (
            "isKey",
            "IsKey",
            "IS_KEY",
            "key",
            "Key",
            "iskey",
            "IsPrimaryKey",
            "primaryKey",
        ),
    )

    length = None if length_raw in (None, "") else int(length_raw) if str(length_raw).isdigit() else None
    decimals = (
        None
        if decimals_raw in (None, "")
        else int(decimals_raw)
        if str(decimals_raw).isdigit()
        else None
    )

    return SapMetadataField(
        field_name=str(field_name).strip(),
        data_type=None if data_type_raw is None else str(data_type_raw).strip(),
        length=length,
        decimals=decimals,
        is_key=_to_bool(is_key_raw),
    )


def _collect_candidate_arrays(node: Any, out: list[list[Any]] | None = None) -> list[list[Any]]:
    if out is None:
        out = []
    if isinstance(node, list):
        out.append(node)
        for item in node:
            _collect_candidate_arrays(item, out)
        return out
    if isinstance(node, dict):
        if normalize_field_record(node):
            out.append([node])
        for value in node.values():
            _collect_candidate_arrays(value, out)
    return out


def extract_field_records(payload: Any) -> list[dict[str, Any]]:
    """Find the most plausible array of field metadata objects in a payload."""
    arrays = _collect_candidate_arrays(payload)
    best: list[dict[str, Any]] = []
    best_score = -1

    for arr in arrays:
        if not isinstance(arr, list) or not arr:
            continue
        objects = [item for item in arr if isinstance(item, dict)]
        if not objects:
            continue
        score = sum(1 for item in objects if normalize_field_record(item))
        if score > best_score:
            best_score = score
            best = objects

    return best if best_score > 0 else []


def resolve_identifier_columns(
    business_object: str,
    fields: list[SapMetadataField],
) -> list[str]:
    """
    Prefer SAP IsKey flags (excluding CLIENT/MANDT), then known fallbacks.
    Mirrors resolveIdentifierColumns() in sapMetadataService.js.
    """
    by_upper = {field.field_name.upper(): field.field_name for field in fields}
    from_sap = [
        field.field_name
        for field in fields
        if field.is_key and field.field_name.upper() not in SYSTEM_CLIENT_FIELDS
    ]
    if from_sap:
        return from_sap

    fallback = FALLBACK_IDENTIFIER_COLUMNS.get(business_object, ())
    return [
        by_upper[name.upper()]
        for name in fallback
        if name.upper() in by_upper
    ]


def _dedupe_fields(fields: list[SapMetadataField]) -> list[SapMetadataField]:
    seen: set[str] = set()
    out: list[SapMetadataField] = []
    for field in fields:
        key = field.field_name.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(field)
    return out


def parse_metadata_json(body_text: str) -> list[SapMetadataField]:
    """Parse a JSON SAP metadata response into normalized fields."""
    trimmed = body_text.strip()
    if not trimmed:
        raise SapApiResponseError("SAP metadata response was empty", code="EMPTY")

    try:
        payload = json.loads(trimmed)
    except json.JSONDecodeError as exc:
        raise SapApiResponseError(
            "SAP metadata JSON could not be parsed",
            code="PARSE",
        ) from exc

    records = extract_field_records(payload)
    fields = [
        field
        for record in records
        if (field := normalize_field_record(record)) is not None
    ]
    if not fields:
        raise SapApiResponseError(
            "SAP metadata JSON did not contain recognizable field definitions",
            code="PARSE",
        )
    return _dedupe_fields(fields)


def build_metadata_url(base_url: str, business_object: str, *, format_json: bool) -> str:
    """Build the OData V2 getMetadata URL for a business object."""
    encoded_bus_obj = urllib.parse.quote(f"'{business_object}'", safe="")
    query = f"BusObj={encoded_bus_obj}"
    if format_json:
        query += "&$format=json"
    return f"{base_url}/getMetadata?{query}"


def _build_basic_auth_header(username: str, password: str) -> str:
    token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


class SapMetadataClient:
    """Fetches SAP business-object metadata and resolves identifier columns."""

    def __init__(self, config: SapClientConfig | None = None) -> None:
        self._config = config or SapClientConfig.from_env()

    def get_identifier_columns(self, business_object: str) -> list[str]:
        """
        Fetch key fields for a business object from SAP OData metadata.

        Raises:
            BusinessObjectNotFoundError: Unsupported business object label.
            SapApiConnectionError: Network failure or timeout.
            SapApiResponseError: SAP HTTP/auth/parse errors.
            MissingKeyFieldsError: Metadata returned no identifier columns.
        """
        normalized = normalize_business_object(business_object)
        if normalized not in SUPPORTED_BUSINESS_OBJECTS:
            raise BusinessObjectNotFoundError(
                business_object,
                supported=SUPPORTED_BUSINESS_OBJECTS,
            )

        if not self._config.base_url or not self._config.username or not self._config.password:
            raise SapApiResponseError(
                "SAP_ODATA_BASE_URL, SAP_ODATA_USERNAME, and SAP_ODATA_PASSWORD are required",
                code="CONFIG",
            )

        fields = self._fetch_fields(normalized)
        identifier_columns = resolve_identifier_columns(normalized, fields)
        if not identifier_columns:
            raise MissingKeyFieldsError(normalized)
        return identifier_columns

    def _fetch_fields(self, business_object: str) -> list[SapMetadataField]:
        auth_header = _build_basic_auth_header(
            self._config.username,
            self._config.password,
        )
        attempts = (
            (build_metadata_url(self._config.base_url, business_object, format_json=True), "application/json"),
            (
                build_metadata_url(self._config.base_url, business_object, format_json=False),
                "application/json",
            ),
        )

        last_error: Exception | None = None
        for url, accept in attempts:
            try:
                body_text, status, content_type = self._http_get(url, auth_header, accept)
            except SapApiConnectionError:
                raise
            except Exception as exc:
                last_error = exc
                continue

            if status in (401, 403):
                raise SapApiResponseError(
                    "SAP metadata authentication failed",
                    code="AUTH",
                )
            if status >= 400:
                last_error = SapApiResponseError(
                    f"SAP metadata request failed (HTTP {status})",
                    code="SAP_ERROR",
                )
                continue

            try:
                if "json" in content_type.lower() or body_text.lstrip().startswith(("{", "[")):
                    return parse_metadata_json(body_text)
            except SapApiResponseError as exc:
                last_error = exc
                continue

        if isinstance(last_error, SapApiResponseError):
            raise last_error
        if isinstance(last_error, Exception):
            raise SapApiResponseError(
                "Could not parse SAP metadata response",
                code="PARSE",
            ) from last_error
        raise SapApiResponseError(
            "Could not parse SAP metadata as JSON into field definitions",
            code="PARSE",
        )

    def _http_get(
        self,
        url: str,
        auth_header: str,
        accept: str,
    ) -> tuple[str, int, str]:
        request = urllib.request.Request(
            url,
            headers={
                "Authorization": auth_header,
                "Accept": accept,
            },
            method="GET",
        )
        context = ssl.create_default_context()
        try:
            with urllib.request.urlopen(
                request,
                timeout=self._config.timeout_sec,
                context=context,
            ) as response:
                body = response.read().decode("utf-8", errors="replace")
                content_type = response.headers.get("Content-Type", "")
                return body, response.status, content_type
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            return body, exc.code, exc.headers.get("Content-Type", "")
        except TimeoutError as exc:
            raise SapApiConnectionError(
                "SAP metadata request timed out",
                cause=exc,
            ) from exc
        except urllib.error.URLError as exc:
            reason = str(exc.reason).lower()
            if "timed out" in reason:
                raise SapApiConnectionError(
                    "SAP metadata request timed out",
                    cause=exc,
                ) from exc
            raise SapApiConnectionError(
                "SAP metadata endpoint is unreachable",
                cause=exc,
            ) from exc
