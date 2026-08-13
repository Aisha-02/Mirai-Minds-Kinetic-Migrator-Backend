"""End-to-end check: S3 upload -> POST /validate -> download parsed outputs.

Loads the backend .env, starts the FastAPI app if needed, uploads a mixed
workbook (MM + SO + unclassifiable sheet), and prints the engine response.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SERVICE_DIR = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT / ".env"


def load_dotenv(path: Path) -> None:
    if not path.exists():
        raise SystemExit(f"Missing {path}")
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        os.environ.setdefault(key, value)


def port_open(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex((host, port)) == 0


def wait_health(url: str, timeout_s: float = 30) -> None:
    deadline = time.time() + timeout_s
    last_error = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return
        except Exception as err:  # noqa: BLE001
            last_error = err
        time.sleep(0.4)
    raise SystemExit(f"Service did not become healthy at {url}: {last_error}")


def json_request(url: str, payload: dict, headers: dict, timeout: int = 180) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HTTP {err.code} from {url}: {body[:800]}") from err


def build_workbook(path: Path) -> None:
    import pandas as pd

    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        pd.DataFrame(
            {
                "MATERIAL_NUMBER": ["100", "100", "200"],
                "MATERIAL_TYPE": ["FERT", "ROH", "HALB"],
                "GROSS_WEIGHT": ["10", "5", "8"],
                "NET_WEIGHT": ["4", "9", "2"],
                "BEDAT": ["20240101", "2024-01-01", "20240201"],
            }
        ).to_excel(writer, index=False, sheet_name="Materials")
        pd.DataFrame(
            {
                "VBELN": ["9001", "9002"],
                "POSNR": ["10", "20"],
            }
        ).to_excel(writer, index=False, sheet_name="SalesOrders")
        pd.DataFrame({"FOO": ["a"], "BAR": ["b"]}).to_excel(
            writer, index=False, sheet_name="Notes"
        )


def default_rules() -> dict:
    return {
        "MM": {
            "businessObject": "MM",
            "fields": [
                {
                    "fieldName": "MATERIAL_NUMBER",
                    "key": "X",
                    "dataType": "CHAR",
                    "length": 18,
                    "rules": [],
                },
                {
                    "fieldName": "MATERIAL_TYPE",
                    "key": "",
                    "dataType": "CHAR",
                    "rules": [
                        {
                            "ruleName": "MTART_Valid_Domain_Value",
                            "source": "AI",
                            "type": "validation",
                            "description": "Must match a valid SAP MTART value.",
                            "constraint": "Check MATERIAL_TYPE against T134.",
                            "severity": "error",
                            "category": "domain",
                        }
                    ],
                },
                {
                    "fieldName": "GROSS_WEIGHT",
                    "key": "",
                    "dataType": "QUAN",
                    "rules": [
                        {
                            "ruleName": "Non-Negative Weight Enforcement",
                            "source": "AI",
                            "description": "Negative gross weight is invalid.",
                            "constraint": "GROSS_WEIGHT must be >= 0",
                            "severity": "error",
                            "category": "range",
                        }
                    ],
                },
                {
                    "fieldName": "NET_WEIGHT",
                    "key": "",
                    "dataType": "QUAN",
                    "rules": [
                        {
                            "ruleName": "Net Weight Not Exceeding Gross Weight",
                            "source": "AI",
                            "description": "Net cannot exceed gross.",
                            "constraint": "NET_WEIGHT must be <= GROSS_WEIGHT",
                            "severity": "error",
                            "category": "consistency",
                        }
                    ],
                },
                {"fieldName": "BEDAT", "key": "", "dataType": "DATS", "rules": []},
            ],
        },
        "SO": {
            "businessObject": "SO",
            "fields": [
                {"fieldName": "VBELN", "key": "X", "dataType": "CHAR", "rules": []},
                {"fieldName": "POSNR", "key": "", "dataType": "NUMC", "rules": []},
            ],
        },
    }


def main() -> None:
    load_dotenv(ENV_PATH)
    os.chdir(SERVICE_DIR)

    secret = os.environ.get("INTERNAL_SERVICE_KEY", "").strip()
    if not secret:
        raise SystemExit("INTERNAL_SERVICE_KEY is not set in .env")
    if not os.environ.get("AWS_S3_BUCKET", "").strip():
        raise SystemExit("AWS_S3_BUCKET is not set in .env")

    base_url = os.environ.get("VALIDATION_ENGINE_URL", "http://localhost:8001").rstrip("/")
    host, port = "127.0.0.1", 8001
    proc = None
    if not port_open(host, port):
        print(f"Starting validation-engine on {base_url} ...")
        proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8001"],
            cwd=str(SERVICE_DIR),
            env=os.environ.copy(),
        )
    else:
        print(f"Using already-running service at {base_url}")

    try:
        wait_health(f"{base_url}/health")
        print("Health: ok")

        from validation_engine.storage import download_object, s3_client, upload_file

        work = SERVICE_DIR / ".e2e-tmp"
        work.mkdir(exist_ok=True)
        workbook = work / "preload_mixed.xlsx"
        build_workbook(workbook)
        key = f"e2e/validation/preload_mixed.xlsx"
        upload_file(workbook, key, content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        print(f"Uploaded s3://{os.environ['AWS_S3_BUCKET']}/{key}")

        result = json_request(
            f"{base_url}/validate",
            {
                "jobId": "e2e-local",
                "inputs": [{"s3Key": key, "filename": "preload_mixed.xlsx"}],
                "rulesByBusinessObject": default_rules(),
                "outputFormat": "xlsx",
            },
            {"X-Internal-Service-Key": secret},
        )

        print(json.dumps(
            {
                "ok": result.get("ok"),
                "jobId": result.get("jobId"),
                "scenarios": [
                    {
                        "scenario": item.get("scenario"),
                        "sourceName": item.get("sourceName"),
                        "s3Key": item.get("s3Key"),
                        "rowCount": item.get("rowCount"),
                        "summary": item.get("summary"),
                        "findingCount": len(item.get("findings") or []),
                        "detection": {
                            "businessObject": (item.get("detection") or {}).get("businessObject"),
                            "confidence": (item.get("detection") or {}).get("confidence"),
                            "ok": (item.get("detection") or {}).get("ok"),
                        },
                    }
                    for item in result.get("scenarios") or []
                ],
                "unclassified": [
                    {
                        "sourceName": item.get("sourceName"),
                        "reason": item.get("reason"),
                        "businessObject": (item.get("detection") or {}).get("businessObject"),
                    }
                    for item in result.get("unclassified") or []
                ],
                "errors": result.get("errors"),
            },
            indent=2,
        ))

        out_dir = work / "parsed"
        out_dir.mkdir(exist_ok=True)
        for item in result.get("scenarios") or []:
            dest = out_dir / Path(item["filename"]).name
            download_object(item["s3Key"], dest)
            print(f"Downloaded parsed file -> {dest}")

        client = s3_client()
        bucket = os.environ["AWS_S3_BUCKET"]
        for object_key in [key, *[item["s3Key"] for item in result.get("scenarios") or []]]:
            try:
                client.delete_object(Bucket=bucket, Key=object_key)
            except Exception as err:  # noqa: BLE001
                print(f"S3 cleanup skipped for {object_key}: {err.__class__.__name__}")
        print("E2E finished.")
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    main()
