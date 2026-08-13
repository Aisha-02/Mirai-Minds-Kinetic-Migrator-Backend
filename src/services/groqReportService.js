import {
  DEFAULT_SAMPLE_SIZE,
  buildDiffSummaryForPrompt,
  buildReportPrompt,
} from "./reportPrompt.js";

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

/** @typedef {'TIMEOUT' | 'THROTTLED' | 'MALFORMED_RESPONSE' | 'CONFIG' | 'GROQ_ERROR'} GroqReportErrorCode */

/**
 * @typedef {{
 *   ok: true,
 *   reportText: string,
 *   modelId: string,
 *   provider: 'groq',
 * }} GroqReportSuccess
 *
 * @typedef {{
 *   ok: false,
 *   error: {
 *     code: GroqReportErrorCode,
 *     message: string,
 *     details?: string,
 *   },
 * }} GroqReportFailure
 *
 * @typedef {GroqReportSuccess | GroqReportFailure} GroqReportResult
 */

function readConfig(overrides = {}) {
  const apiKey = overrides.apiKey || process.env.GROQ_API_KEY;
  const modelId =
    overrides.modelId || process.env.GROQ_MODEL_ID || DEFAULT_MODEL;
  const maxTokens = Number(
    overrides.maxTokens ?? process.env.GROQ_MAX_TOKENS ?? DEFAULT_MAX_TOKENS,
  );
  const temperature = Number(
    overrides.temperature ??
      process.env.GROQ_TEMPERATURE ??
      DEFAULT_TEMPERATURE,
  );
  const timeoutMs = Number(
    overrides.timeoutMs ?? process.env.GROQ_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
  );
  const sampleSize = Number(
    overrides.sampleSize ?? process.env.GROQ_SAMPLE_SIZE ?? DEFAULT_SAMPLE_SIZE,
  );

  return { apiKey, modelId, maxTokens, temperature, timeoutMs, sampleSize };
}

/**
 * @param {number} status
 * @param {string} bodyText
 * @returns {GroqReportFailure}
 */
export function mapGroqHttpError(status, bodyText) {
  const details = String(bodyText || "").slice(0, 500);

  if (status === 429) {
    return {
      ok: false,
      error: {
        code: "THROTTLED",
        message: "Groq request was rate-limited",
        details,
      },
    };
  }

  if (status === 408 || status === 504) {
    return {
      ok: false,
      error: {
        code: "TIMEOUT",
        message: "Groq request timed out",
        details,
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "GROQ_ERROR",
      message: `Groq request failed (HTTP ${status})`,
      details,
    },
  };
}

/**
 * @param {unknown} payload
 * @returns {string | null}
 */
export function extractGroqReportText(payload) {
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed || null;
}

/**
 * Generate a human-readable comparison report via Groq (OpenAI-compatible Chat Completions).
 * No DB access — diff in, typed result out.
 *
 * @param {Record<string, unknown>} diff
 * @param {{
 *   apiKey?: string,
 *   modelId?: string,
 *   maxTokens?: number,
 *   temperature?: number,
 *   timeoutMs?: number,
 *   sampleSize?: number,
 *   fetchImpl?: typeof fetch,
 * }} [options]
 * @returns {Promise<GroqReportResult>}
 */
export async function generateComparisonReport(diff, options = {}) {
  const config = readConfig(options);

  if (!config.apiKey?.trim()) {
    return {
      ok: false,
      error: {
        code: "CONFIG",
        message: "GROQ_API_KEY is required to call Groq",
      },
    };
  }

  const summary = buildDiffSummaryForPrompt(diff, config.sampleSize);
  const prompt = buildReportPrompt(summary);
  const fetchImpl = options.fetchImpl || fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(GROQ_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.modelId,
        messages: [{ role: "user", content: prompt }],
        temperature: config.temperature,
        max_tokens: config.maxTokens,
      }),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    let payload = null;
    try {
      payload = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      return mapGroqHttpError(response.status, bodyText);
    }

    const reportText = extractGroqReportText(payload);
    if (!reportText) {
      return {
        ok: false,
        error: {
          code: "MALFORMED_RESPONSE",
          message: "Groq returned an empty or unreadable message",
          details: bodyText?.slice(0, 500),
        },
      };
    }

    return {
      ok: true,
      reportText,
      modelId: config.modelId,
      provider: "groq",
    };
  } catch (err) {
    const message = err?.message || "Groq request failed";
    const lower = String(message).toLowerCase();
    if (
      err?.name === "AbortError" ||
      lower.includes("timeout") ||
      lower.includes("aborted")
    ) {
      return {
        ok: false,
        error: {
          code: "TIMEOUT",
          message: "Groq request timed out",
          details: message,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "GROQ_ERROR",
        message: "Groq request failed",
        details: message,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export { buildDiffSummaryForPrompt, buildReportPrompt };
