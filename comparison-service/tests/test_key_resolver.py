"""Tests for SAP key-field resolution."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from key_exceptions import (
    AmbiguousSheetMappingError,
    BusinessObjectNotFoundError,
    SapApiConnectionError,
)
from key_resolver import (
    clear_key_field_cache,
    map_sheet_name_to_business_object,
    resolve_key_fields,
    resolve_key_fields_for_sheets,
)


class MockSapClient:
    """Mock SAP metadata client for tests."""

    def __init__(self, mapping: dict[str, list[str]] | None = None) -> None:
        self.mapping = mapping or {}
        self.calls: list[str] = []

    def get_identifier_columns(self, business_object: str) -> list[str]:
        self.calls.append(business_object)
        if business_object not in self.mapping:
            raise SapApiConnectionError("simulated SAP failure")
        return list(self.mapping[business_object])


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    clear_key_field_cache()
    yield
    clear_key_field_cache()


def test_resolve_key_fields_uses_override_without_calling_sap() -> None:
    client = MockSapClient({"MATERIAL_MASTER": ["MATNR"]})

    keys = resolve_key_fields(
        "MATERIAL_MASTER",
        override_keys=["CUSTOM_KEY"],
        client=client,
    )

    assert keys == ["CUSTOM_KEY"]
    assert client.calls == []


def test_resolve_key_fields_fetches_from_sap_and_caches() -> None:
    client = MockSapClient({"MATERIAL_MASTER": ["MATNR"]})

    first = resolve_key_fields("MATERIAL_MASTER", client=client)
    second = resolve_key_fields("MATERIAL_MASTER", client=client)

    assert first == ["MATNR"]
    assert second == ["MATNR"]
    assert client.calls == ["MATERIAL_MASTER"]


def test_resolve_key_fields_for_sheets_maps_each_sheet() -> None:
    client = MockSapClient(
        {
            "MATERIAL_MASTER": ["MATNR"],
            "BUSINESS_PARTNER": ["PARTNER"],
        }
    )

    result = resolve_key_fields_for_sheets(
        ["Material Master", "Customer Master"],
        client=client,
    )

    assert result == {
        "Material Master": ["MATNR"],
        "Customer Master": ["PARTNER"],
    }
    assert client.calls == ["MATERIAL_MASTER", "BUSINESS_PARTNER"]


def test_resolve_key_fields_for_sheets_supports_per_sheet_override() -> None:
    client = MockSapClient({"MATERIAL_MASTER": ["MATNR"]})

    result = resolve_key_fields_for_sheets(
        ["Material Master", "Customer Master"],
        override_keys={"Customer Master": ["BP_ID"]},
        client=client,
    )

    assert result["Material Master"] == ["MATNR"]
    assert result["Customer Master"] == ["BP_ID"]
    assert client.calls == ["MATERIAL_MASTER"]


def test_map_sheet_name_raises_for_unknown_sheet() -> None:
    with pytest.raises(BusinessObjectNotFoundError):
        map_sheet_name_to_business_object("Unknown Tab")


def test_map_sheet_name_raises_for_ambiguous_sheet() -> None:
    with pytest.raises(AmbiguousSheetMappingError):
        map_sheet_name_to_business_object("master")
