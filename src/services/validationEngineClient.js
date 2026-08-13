/**
 * HTTP client for the internal FastAPI validation-engine.
 * Auth: X-Internal-Service-Key (same contract as the comparison engine).
 */

const DEFAULT_TIMEOUT_MS = 120_000;

function getBaseUrl() {
  return String(process.env.VALIDATION_ENGINE_URL || "").replace(/\/$/, "");
}

export function isValidationEngineConfigured() {
  return Boolean(getBaseUrl() && process.env.INTERNAL_SERVICE_KEY);
}

export async function runValidationEngine(payload, options = {}) {
  const baseUrl = getBaseUrl();
  const secret = String(process.env.INTERNAL_SERVICE_KEY || "").trim();
  if (!baseUrl || !secret) {
    const err = new Error(
      "Validation engine is not configured. Set VALIDATION_ENGINE_URL and INTERNAL_SERVICE_KEY.",
    );
    err.status = 503;
    err.code = "VALIDATION_ENGINE_NOT_CONFIGURED";
    throw err;
  }

  const timeoutMs = Number(
    options.timeoutMs ?? process.env.VALIDATION_ENGINE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/validate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Service-Key": secret,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text || "{}");
    } catch {
      const err = new Error("Validation engine returned non-JSON");
      err.status = 502;
      err.details = text.slice(0, 500);
      throw err;
    }

    if (!response.ok) {
      const err = new Error(parsed?.detail || parsed?.error || "Validation engine request failed");
      err.status = response.status === 401 ? 502 : response.status;
      err.details = parsed;
      throw err;
    }

    return parsed;
  } catch (err) {
    if (err?.name === "AbortError") {
      const timeout = new Error("Validation engine request timed out");
      timeout.status = 504;
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
