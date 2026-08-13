import { compareDatasets } from "./comparisonEngine.js";
import {
  ensureComparisonFileInS3,
} from "./comparisonS3.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_ASYNC_TIMEOUT_MS = 30 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getComparisonEngineUrl() {
  return String(process.env.COMPARISON_ENGINE_URL || "").replace(/\/$/, "");
}

function getComparisonMode() {
  return String(process.env.COMPARISON_ENGINE_MODE || "local").toLowerCase();
}

function getRequestTimeoutMs() {
  return (
    Number(process.env.COMPARISON_ENGINE_TIMEOUT_MS) || DEFAULT_REQUEST_TIMEOUT_MS
  );
}

function getPollIntervalMs() {
  return (
    Number(process.env.COMPARISON_ENGINE_POLL_INTERVAL_MS) ||
    DEFAULT_POLL_INTERVAL_MS
  );
}

function getAsyncTimeoutMs() {
  return (
    Number(process.env.COMPARISON_ENGINE_ASYNC_TIMEOUT_MS) ||
    DEFAULT_ASYNC_TIMEOUT_MS
  );
}

function runLocalComparison({ preloadRows, postloadRows, identifierColumns, compareColumns }) {
  return compareDatasets(preloadRows, postloadRows, {
    identifierColumns,
    ...(compareColumns ? { compareColumns } : {}),
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = getRequestTimeoutMs()) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw Object.assign(
        new Error(`Comparison engine request timed out after ${timeoutMs}ms`),
        { status: 504, cause: err },
      );
    }
    throw Object.assign(
      new Error(
        err?.cause?.code === "ECONNREFUSED"
          ? "Comparison engine is unreachable"
          : err?.message || "Comparison engine request failed",
      ),
      { status: 503, cause: err },
    );
  } finally {
    clearTimeout(timer);
  }
}

function buildServiceHeaders() {
  const apiKey = process.env.COMPARISON_INTERNAL_API_KEY;
  if (!apiKey) {
    throw Object.assign(
      new Error("COMPARISON_INTERNAL_API_KEY is not configured"),
      { status: 500 },
    );
  }

  return {
    "Content-Type": "application/json",
    "X-Internal-Api-Key": apiKey,
  };
}

async function parseServiceError(response) {
  const raw = await response.text();
  let detail = raw;
  try {
    const parsed = JSON.parse(raw);
    detail =
      typeof parsed?.detail === "string"
        ? parsed.detail
        : JSON.stringify(parsed?.detail ?? parsed);
  } catch {
    // keep raw text
  }

  const error = new Error(
    detail || `Comparison engine returned HTTP ${response.status}`,
  );
  error.status = response.status >= 400 && response.status < 600 ? response.status : 502;
  return error;
}

async function pollComparisonJob({ baseUrl, jobId }) {
  const headers = buildServiceHeaders();
  const started = Date.now();
  const timeoutMs = getAsyncTimeoutMs();
  const intervalMs = getPollIntervalMs();

  while (Date.now() - started < timeoutMs) {
    const response = await fetchWithTimeout(
      `${baseUrl}/compare/${encodeURIComponent(jobId)}/status`,
      { method: "GET", headers },
    );

    if (!response.ok) {
      throw await parseServiceError(response);
    }

    const statusPayload = await response.json();
    const status = String(statusPayload?.status || "").toLowerCase();

    if (status === "completed") {
      if (!statusPayload?.result) {
        throw Object.assign(
          new Error("Comparison engine completed without a result payload"),
          { status: 502 },
        );
      }
      return statusPayload.result;
    }

    if (status === "failed") {
      throw Object.assign(
        new Error(statusPayload?.error || "Comparison engine job failed"),
        { status: 502 },
      );
    }

    await sleep(intervalMs);
  }

  throw Object.assign(
    new Error(
      `Comparison engine job ${jobId} did not complete within ${timeoutMs}ms`,
    ),
    { status: 504 },
  );
}

async function runServiceComparison({
  batchId,
  preload,
  postload,
  identifierColumns,
  compareColumns,
}) {
  const baseUrl = getComparisonEngineUrl();
  if (!baseUrl) {
    throw Object.assign(new Error("COMPARISON_ENGINE_URL is not configured"), {
      status: 500,
    });
  }

  const bucket = process.env.COMPARISON_S3_BUCKET;
  if (!bucket) {
    throw Object.assign(new Error("COMPARISON_S3_BUCKET is not configured"), {
      status: 500,
    });
  }

  const preloadS3Key = await ensureComparisonFileInS3({
    bucket,
    userId: preload.user_id,
    batchId,
    storagePath: preload.storage_path,
  });
  const postloadS3Key = await ensureComparisonFileInS3({
    bucket,
    userId: postload.user_id,
    batchId,
    storagePath: postload.storage_path,
  });

  const body = {
    preloadS3Key,
    postloadS3Key,
    keyField: identifierColumns[0],
    identifierColumns,
    bucket,
    batchId,
    ...(compareColumns ? { compareColumns } : {}),
  };

  const response = await fetchWithTimeout(`${baseUrl}/compare`, {
    method: "POST",
    headers: buildServiceHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw await parseServiceError(response);
  }

  const payload = await response.json();
  if (payload?.async && payload?.jobId) {
    return pollComparisonJob({ baseUrl, jobId: payload.jobId });
  }

  if (!payload?.result) {
    throw Object.assign(
      new Error("Comparison engine returned an unexpected response shape"),
      { status: 502 },
    );
  }

  return payload.result;
}

/**
 * Run directional comparison via the Python EC2 service when enabled,
 * otherwise (or on service failure) fall back to in-process comparisonEngine.js.
 */
export async function runComparison({
  batchId,
  preload,
  postload,
  identifierColumns,
  compareColumns,
}) {
  const preloadRows = Array.isArray(preload?.parsed_data) ? preload.parsed_data : [];
  const postloadRows = Array.isArray(postload?.parsed_data)
    ? postload.parsed_data
    : [];

  const mode = getComparisonMode();
  if (mode !== "service") {
    return {
      summary: runLocalComparison({
        preloadRows,
        postloadRows,
        identifierColumns,
        compareColumns,
      }),
      evaluator: "node-local",
    };
  }

  try {
    const summary = await runServiceComparison({
      batchId,
      preload,
      postload,
      identifierColumns,
      compareColumns,
    });
    return { summary, evaluator: "comparison-engine-service" };
  } catch (err) {
    console.warn(
      "[comparison] Python comparison-engine service unavailable; using in-process fallback:",
      String(err?.message || err).slice(0, 300),
    );
    return {
      summary: runLocalComparison({
        preloadRows,
        postloadRows,
        identifierColumns,
        compareColumns,
      }),
      evaluator: "node-local-fallback",
      fallbackReason: err?.message || "service unavailable",
    };
  }
}
