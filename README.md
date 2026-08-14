# Kinetic Migrator — Backend

Express API for Kinetic Migrator: authentication, admin workspace, validation rules, preload cleaning, preload/postload comparison, and PDF reports.

## Stack

- Node.js (ES modules) + Express 5
- PostgreSQL (`pg`; IAM RDS auth or `DATABASE_URL`)
- AWS S3 (uploads), Amazon Bedrock (AI rules / reports)
- Optional Python FastAPI services: comparison (`comparison-service`, port 8000) and validation engine (port 8001)
- Optional local Python Lambda for cleanup (`VALIDATION_LAMBDA_MODE=local`)

Default listen port: **4000**.

## Setup

```bash
npm install
cp .env.example .env
```

Fill `.env` (see **Environment** below). Then:

```bash
npm run db:migrate
npm run dev
```

API: [http://localhost:4000](http://localhost:4000)  
Health: [http://localhost:4000/health](http://localhost:4000/health)

Set `CORS_ORIGIN` to the frontend origin (`http://localhost:3000`, or `http://localhost:3002` if Next.js moved ports).

| Script | Description |
| --- | --- |
| `npm run dev` | Watch mode (`node --watch src/index.js`) |
| `npm start` | Production process |
| `npm run db:migrate` | Apply SQL migrations |
| `npm run db:query` | Ad-hoc DB helper |
| `npm run db:rules` | Inspect stored validation rules |

## Environment

Copy `.env.example`. Required for a local API:

- `JWT_SECRET`
- Database: `RDSHOST` + IAM (`DB_AUTH=iam`) **or** `DATABASE_URL` with `DB_AUTH=password`
- `CORS_ORIGIN` matching the frontend
- `AWS_S3_BUCKET` (and AWS credentials or instance role) for file storage
- Bedrock (`BEDROCK_REGION`, `BEDROCK_MODEL_ID`, AWS credentials or bearer token) for AI rules and comparison narratives
- `SAP_ODATA_*` for SAP business-object metadata / key fields
- `INTERNAL_SERVICE_KEY` plus `VALIDATION_ENGINE_URL` / `COMPARISON_SERVICE_URL` when those Python services are running

Do not commit real secrets. Prefer IAM roles in deployed environments.

## Auth

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Body: `email`, `password`, `role` (`admin` \| `normal_user`), `fullName`, `termsAccepted` |
| `POST` | `/api/auth/login` | Returns `{ token, user }` |
| `GET` | `/api/auth/me` | Bearer token |

Protected routes send `Authorization: Bearer <token>`.

## API surface

| Prefix | Purpose |
| --- | --- |
| `/api/auth` | Register, login, current user |
| `/api/admin` | Source schema, workspace, schema mapping |
| `/api/rules` | Business objects, generate/save rules, list rules |
| `/api/admin/validation-rules` | Create / update / delete **custom** rules only |
| `/api/validation` | Execute cleaning, auto-fix, refined file download |
| `/api/comparisons` | Preload/postload upload, run comparison, report, PDF |
| `/api/documents` | Transformation documents |

### Rules payload

Saved rule sets (`POST /api/rules/save`) store:

- `businessObject`, field metadata, AI + custom rules
- `predefinedChecks`: `{ trim, nullCheck, duplicates }` — admin toggles for the three standard checks
- Per-rule `selected`: `true` (apply), `false` (rejected), `null` (AI pending review). Omitted `selected` is treated as apply (legacy sets)

Cleaning evaluation (`rulesEvaluationService`) injects predefined trim / null / duplicate checks only when the matching toggle is on, and skips rejected or pending AI/custom rules.

PDF comparison reports use the same light palette as the frontend (`src/services/pdfReportService.js`).

## Python services

**Comparison** (optional; in-process engine is used if `COMPARISON_SERVICE_URL` is unset):

See [`comparison-service/README.md`](comparison-service/README.md). Typical local URL: `http://localhost:8000`.

**Validation engine** (if configured):

```
VALIDATION_ENGINE_URL=http://localhost:8001
INTERNAL_SERVICE_KEY=...
```

## Layout

```
src/
  index.js              HTTP entry
  routes/               Express routers
  services/             Rules, comparison, PDF, Bedrock, S3
  models/               Postgres access
  middleware/           Auth, logging
comparison-service/     FastAPI comparison worker
```
