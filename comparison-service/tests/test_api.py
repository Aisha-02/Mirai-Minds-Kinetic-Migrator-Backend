"""Tests for the FastAPI comparison service."""

from __future__ import annotations

import io
import sys
from pathlib import Path

import polars as pl
import pytest
from fastapi.testclient import TestClient

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from main import app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _csv_bytes(rows: str) -> io.BytesIO:
    return io.BytesIO(rows.encode("utf-8"))


def test_health_endpoint(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_compare_single_sheet_csv(client: TestClient) -> None:
    source_csv = "id,name\n1,Alpha\n2,Beta\n"
    target_csv = "id,name\n1,Alpha\n2,Bravo\n"

    response = client.post(
        "/compare",
        data={"override_keys": "id"},
        files={
            "source_file": ("source.csv", _csv_bytes(source_csv), "text/csv"),
            "target_file": ("target.csv", _csv_bytes(target_csv), "text/csv"),
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["mode"] == "single"
    assert payload["result"]["summary"]["matched_count"] == 2
    assert payload["result"]["summary"]["field_mismatch_count"] == 1


def test_compare_requires_keys_for_single_sheet(client: TestClient) -> None:
    source_csv = "id,name\n1,Alpha\n"
    target_csv = "id,name\n1,Alpha\n"

    response = client.post(
        "/compare",
        files={
            "source_file": ("source.csv", _csv_bytes(source_csv), "text/csv"),
            "target_file": ("target.csv", _csv_bytes(target_csv), "text/csv"),
        },
    )

    assert response.status_code == 400
    assert "override_keys" in response.json()["detail"]


def test_compare_mixed_csv_and_excel(client: TestClient, tmp_path: Path) -> None:
    excel_path = tmp_path / "target.xlsx"
    pl.DataFrame({"id": ["1"], "name": ["Alpha"]}).write_excel(excel_path)

    source_csv = "id,name\n1,Alpha\n"
    with excel_path.open("rb") as excel_file:
        response = client.post(
            "/compare",
            data={"override_keys": "id"},
            files={
                "source_file": ("source.csv", _csv_bytes(source_csv), "text/csv"),
                "target_file": ("target.xlsx", excel_file, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            },
        )

    assert response.status_code == 200
    assert response.json()["mode"] == "single"
