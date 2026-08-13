/**
 * Client for the Python comparison-service (FastAPI /compare endpoint).
 *
 * Streams local files via multipart upload — does not buffer entire files in memory.
 */

import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { URL } from "node:url";
import FormData from "form-data";
import { downloadFileToPath } from "./s3Service.js";
import { buildIdentifier } from "./comparisonEngine.js";

const DEFAULT_BASE_URL = "http://localhost:8000";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * @typedef {Object} CompareFilesOptions
 * @property {string} [businessObject] SAP business object label (e.g. MATERIAL_MASTER)
 * @property {string[]} [overrideKeys] Key columns; overrides SAP resolution
 * @property {string[]} [compareColumns] Subset of columns to compare
 * @property {string} [baseUrl] FastAPI base URL (default COMPARISON_SERVICE_URL or localhost:8000)
 * @property {number} [timeoutMs] Request timeout (default 5 minutes)
 */

/**
 * @typedef {Object} CompareServiceErrorShape
 * @property {number} [status] HTTP status from FastAPI
 * @property {string} [code]
 * @property {unknown} [details]
 */

export class CompareServiceError extends Error {
  /**
   * @param {string} message
   * @param {CompareServiceErrorShape} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = "CompareServiceError";
    this.status = options.status;
    this.code = options.code || "COMPARE_SERVICE_ERROR";
    this.details = options.details;
  }
}

function resolveBaseUrl(override) {
  const value = String(override || process.env.COMPARISON_SERVICE_URL || DEFAULT_BASE_URL).trim();
  return value.replace(/\/+$/, "");
}

function resolveTimeoutMs(override) {
  const fromEnv = Number(process.env.COMPARISON_SERVICE_TIMEOUT_MS);
  const value = override ?? (Number.isFinite(fromEnv) ? fromEnv : DEFAULT_TIMEOUT_MS);
  return value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function appendCsvField(form, name, values) {
  if (!Array.isArray(values) || values.length === 0) return;
  const cleaned = values.map((value) => String(value).trim()).filter(Boolean);
  if (cleaned.length > 0) {
    form.append(name, cleaned.join(","));
  }
}

/**
 * @param {string} url
 * @param {import('form-data').default} form
 * @param {{ timeoutMs: number, signal?: AbortSignal }} options
 * @returns {Promise<{ status: number, body: string, headers: http.IncomingHttpHeaders }>}
 */
function postMultipartForm(url, form, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;

    const req = transport.request(
      {
        method: "POST",
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        headers: form.getHeaders(),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode || 500,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          });
        });
      },
    );

    const onAbort = () => {
      req.destroy(new CompareServiceError("Comparison service request aborted", {
        status: 499,
        code: "COMPARE_SERVICE_ABORTED",
      }));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      req.destroy(
        new CompareServiceError(
          `Comparison service request timed out after ${timeoutMs}ms`,
          { status: 504, code: "COMPARE_SERVICE_TIMEOUT" },
        ),
      );
    }, timeoutMs);

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.on("close", () => {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    });

    form.on("error", (err) => {
      clearTimeout(timer);
      req.destroy(err);
    });

    form.pipe(req);
  });
}

/**
 * @param {number} status
 * @param {string} body
 */
async function readErrorDetailFromBody(status, body) {
  const fallback = `Comparison service returned HTTP ${status}`;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.detail === "string" && parsed.detail.trim()) {
      return parsed.detail.trim();
    }
    if (Array.isArray(parsed?.detail)) {
      return parsed.detail
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object" && "msg" in item) {
            return String(item.msg);
          }
          return JSON.stringify(item);
        })
        .join("; ");
    }
  } catch {
    if (body.trim()) {
      return body.trim().slice(0, 500);
    }
  }
  return fallback;
}

/**
 * Compare two files on disk by streaming them to the FastAPI /compare endpoint.
 *
 * @param {string} sourceFilePath Preload / source file path
 * @param {string} targetFilePath Postload / target file path
 * @param {CompareFilesOptions} [options]
 * @returns {Promise<Record<string, unknown>>} Parsed FastAPI CompareResponse JSON
 */
export async function compareFiles(sourceFilePath, targetFilePath, options = {}) {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const url = `${baseUrl}/compare`;

  const form = new FormData();
  form.append("source_file", createReadStream(sourceFilePath), {
    filename: basename(sourceFilePath),
  });
  form.append("target_file", createReadStream(targetFilePath), {
    filename: basename(targetFilePath),
  });

  if (options.businessObject) {
    form.append("business_object", String(options.businessObject).trim());
  }
  appendCsvField(form, "override_keys", options.overrideKeys);
  appendCsvField(form, "compare_columns", options.compareColumns);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await postMultipartForm(url, form, {
      timeoutMs,
      signal: controller.signal,
    });

    if (response.status < 200 || response.status >= 300) {
      const detail = await readErrorDetailFromBody(response.status, response.body);
      throw new CompareServiceError(detail, {
        status: response.status,
        code:
          response.status >= 500
            ? "COMPARE_SERVICE_UNAVAILABLE"
            : "COMPARE_SERVICE_REJECTED",
        details: { url, status: response.status },
      });
    }

    try {
      return JSON.parse(response.body);
    } catch (parseErr) {
      throw new CompareServiceError("Comparison service returned invalid JSON", {
        status: 502,
        code: "COMPARE_SERVICE_INVALID_RESPONSE",
        details: parseErr,
      });
    }
  } catch (err) {
    if (err instanceof CompareServiceError) {
      throw err;
    }
    if (err?.name === "AbortError" || err?.code === "COMPARE_SERVICE_TIMEOUT") {
      throw new CompareServiceError(
        `Comparison service request timed out after ${timeoutMs}ms`,
        { status: 504, code: "COMPARE_SERVICE_TIMEOUT" },
      );
    }
    throw new CompareServiceError(
      err?.message || "Failed to reach comparison service",
      { status: 502, code: "COMPARE_SERVICE_UNREACHABLE", details: err },
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map a FastAPI single-sheet comparison result to the legacy comparisonEngine shape
 * used by AI report generation (preload = source, postload = target).
 *
 * @param {Record<string, unknown>} sheetResult
 * @param {string[]} identifierColumns
 */
export function mapSingleSheetResultToLegacySummary(sheetResult, identifierColumns) {
  const keyColumns = Array.isArray(sheetResult?.key_columns)
    ? sheetResult.key_columns.map(String)
    : identifierColumns;

  const onlyInSource = Array.isArray(sheetResult?.only_in_source)
    ? sheetResult.only_in_source
    : [];
  const onlyInTarget = Array.isArray(sheetResult?.only_in_target)
    ? sheetResult.only_in_target
    : [];
  const fieldMismatches = Array.isArray(sheetResult?.field_mismatches)
    ? sheetResult.field_mismatches
    : [];

  const missingRecords = [];
  const extraRecords = [];
  const valueMismatches = [];
  const missingValues = [];

  for (const record of onlyInSource) {
    const { identifier } = buildIdentifier(record, keyColumns);
    missingRecords.push({ identifier, record });
  }

  for (const record of onlyInTarget) {
    const { identifier } = buildIdentifier(record, keyColumns);
    extraRecords.push({ identifier, record });
  }

  for (const mismatch of fieldMismatches) {
    const identifier =
      mismatch?.key_values && typeof mismatch.key_values === "object"
        ? mismatch.key_values
        : buildIdentifier(
            /** @type {Record<string, unknown>} */ (mismatch?.key_values || {}),
            keyColumns,
          ).identifier;

    const expectedValue = mismatch?.source_value ?? null;
    const actualValue = mismatch?.target_value ?? null;

    const expectedEmpty =
      expectedValue == null ||
      (typeof expectedValue === "string" && expectedValue.trim() === "");
    const actualEmpty =
      actualValue == null ||
      (typeof actualValue === "string" && actualValue.trim() === "");

    if (!expectedEmpty && actualEmpty) {
      missingValues.push({
        identifier,
        field: mismatch?.column,
        expectedValue,
      });
      continue;
    }

    valueMismatches.push({
      identifier,
      field: mismatch?.column,
      expectedValue: expectedEmpty ? null : expectedValue,
      actualValue: actualEmpty ? null : actualValue,
    });
  }

  return {
    missingRecords,
    missingValues,
    valueMismatches,
    duplicateRecords: [],
    baselineDuplicates: [],
    extraRecords,
    comparisonEngine: "python",
    pythonSummary: sheetResult?.summary ?? null,
  };
}

/**
 * Convert a FastAPI CompareResponse into the legacy summary shape.
 *
 * @param {Record<string, unknown>} compareResponse
 * @param {string[]} identifierColumns
 */
export function mapCompareResponseToLegacySummary(compareResponse, identifierColumns) {
  if (compareResponse?.mode === "multi") {
    const sheets = compareResponse?.result?.sheets;
    if (!sheets || typeof sheets !== "object") {
      throw new CompareServiceError("Comparison service returned an invalid multi-sheet payload", {
        status: 502,
        code: "COMPARE_SERVICE_INVALID_RESPONSE",
      });
    }

    const perSheet = {};
    const aggregated = {
      missingRecords: [],
      missingValues: [],
      valueMismatches: [],
      duplicateRecords: [],
      baselineDuplicates: [],
      extraRecords: [],
      comparisonEngine: "python",
      mode: "multi",
      unmatchedSheets: compareResponse?.result?.unmatched_sheets ?? [],
      pythonSheets: {},
    };

    for (const [sheetName, sheetResult] of Object.entries(sheets)) {
      const mapped = mapSingleSheetResultToLegacySummary(sheetResult, identifierColumns);
      perSheet[sheetName] = mapped;
      aggregated.missingRecords.push(...mapped.missingRecords);
      aggregated.missingValues.push(...mapped.missingValues);
      aggregated.valueMismatches.push(...mapped.valueMismatches);
      aggregated.extraRecords.push(...mapped.extraRecords);
      aggregated.pythonSheets[sheetName] = sheetResult?.summary ?? null;
    }

    aggregated.perSheet = perSheet;
    return aggregated;
  }

  if (compareResponse?.mode === "single" && compareResponse?.result) {
    return mapSingleSheetResultToLegacySummary(
      compareResponse.result,
      identifierColumns,
    );
  }

  throw new CompareServiceError("Comparison service returned an unexpected response shape", {
    status: 502,
    code: "COMPARE_SERVICE_INVALID_RESPONSE",
  });
}

/**
 * @typedef {Object} StorageUploadRef
 * @property {string} storagePath S3 object key
 * @property {string} originalFilename Original upload filename (for extension detection)
 */

/**
 * Download preload/postload files from S3 to a temp directory and compare via FastAPI.
 *
 * @param {{
 *   preload: StorageUploadRef,
 *   postload: StorageUploadRef,
 *   options?: CompareFilesOptions,
 * }} params
 */
export async function compareBatchUploadsFromStorage({ preload, postload, options = {} }) {
  const tempDir = await mkdtemp(join(tmpdir(), "mirai-compare-"));
  const sourcePath = join(tempDir, sanitizeTempFilename(preload.originalFilename, "preload"));
  const targetPath = join(tempDir, sanitizeTempFilename(postload.originalFilename, "postload"));

  try {
    await downloadFileToPath(preload.storagePath, sourcePath);
    await downloadFileToPath(postload.storagePath, targetPath);
    return compareFiles(sourcePath, targetPath, options);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function sanitizeTempFilename(filename, fallback) {
  const base = basename(String(filename || fallback));
  return base.replace(/[^\w.\-()+ ]+/g, "_").slice(0, 180) || fallback;
}

/**
 * @returns {boolean}
 */
export function isComparisonServiceEnabled() {
  return Boolean(String(process.env.COMPARISON_SERVICE_URL || "").trim());
}
