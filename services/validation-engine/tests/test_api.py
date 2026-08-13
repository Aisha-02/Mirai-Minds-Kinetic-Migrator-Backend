from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import mm_rules
from validation_engine.constants import INTERNAL_API_HEADER


def test_health_is_public():
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_validate_requires_internal_key(monkeypatch):
    monkeypatch.setenv("INTERNAL_SERVICE_KEY", "secret")
    client = TestClient(app)
    response = client.post("/validate", json={"s3Key": "a.csv", "rules": mm_rules()})
    assert response.status_code == 401


def test_validate_rejects_empty_inputs(monkeypatch):
    monkeypatch.setenv("INTERNAL_SERVICE_KEY", "secret")
    client = TestClient(app)
    response = client.post(
        "/validate",
        json={"rules": {"MM": mm_rules()}},
        headers={INTERNAL_API_HEADER: "secret"},
    )
    assert response.status_code == 400
