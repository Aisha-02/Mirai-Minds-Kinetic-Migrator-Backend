# Comparison Service

Python service that parses source/target migration files, resolves SAP key fields, and compares datasets with Polars.

## Local setup

```bash
cd comparison-service
py -m pip install -r requirements.txt
```

## Run the API

```bash
cd comparison-service
py -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Interactive docs: [http://localhost:8000/docs](http://localhost:8000/docs)

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FRONTEND_ORIGIN` | No | `http://localhost:3000` | Allowed CORS origin for the Node.js app |
| `COMPARISON_RESULT_LIMIT` | No | `1000` | Max diff rows returned per list (totals are always full) |
| `SAP_ODATA_BASE_URL` | For SAP key resolution | — | SAP OData metadata base URL |
| `SAP_ODATA_USERNAME` | For SAP key resolution | — | SAP basic-auth username |
| `SAP_ODATA_PASSWORD` | For SAP key resolution | — | SAP basic-auth password |
| `SAP_ODATA_TIMEOUT_MS` | No | `15000` | SAP metadata request timeout |

For single-sheet comparisons without SAP, pass `override_keys` in the request (comma-separated).

## API

### `GET /health`

Returns `{"status": "ok"}`.

### `POST /compare`

`multipart/form-data` fields:

- `source_file` (required): CSV or Excel upload
- `target_file` (required): CSV or Excel upload
- `business_object` (optional): SAP business object for key resolution
- `override_keys` (optional): comma-separated key columns (overrides SAP)
- `compare_columns` (optional): comma-separated columns to compare

The service auto-detects single-sheet vs multi-sheet workbooks and routes to the appropriate comparator. Mixed structures (single-sheet source + multi-sheet target) return HTTP 400.

## Tests

```bash
cd comparison-service
py -m pytest -q
```

## Modules

- `parsing.py` — CSV/Excel parsing
- `key_resolver.py` — SAP key-field resolution
- `comparator.py` — Polars-based comparison engine
- `main.py` — FastAPI app
