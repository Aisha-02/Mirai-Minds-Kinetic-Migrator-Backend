import {
  BedrockRuntimeClient,
  ConversationRole,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  DEFAULT_SAMPLE_SIZE,
  buildDiffSummaryForPrompt,
  buildReportPrompt,
} from "./reportPrompt.js";

export { buildDiffSummaryForPrompt, buildReportPrompt };

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 60_000;

/** @typedef {'TIMEOUT' | 'THROTTLED' | 'MALFORMED_RESPONSE' | 'CONFIG' | 'BEDROCK_ERROR'} BedrockReportErrorCode */

/**
 * @typedef {{
 *   ok: true,
 *   reportText: string,
 *   modelId: string,
 * }} BedrockReportSuccess
 *
 * @typedef {{
 *   ok: false,
 *   error: {
 *     code: BedrockReportErrorCode,
 *     message: string,
 *     details?: string,
 *   },
 * }} BedrockReportFailure
 *
 * @typedef {BedrockReportSuccess | BedrockReportFailure} BedrockReportResult
 */

function readConfig(overrides = {}) {
  const region =
    overrides.region ||
    process.env.BEDROCK_REGION ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION;

  const modelId = overrides.modelId || process.env.BEDROCK_MODEL_ID;

  const maxTokens = Number(
    overrides.maxTokens ?? process.env.BEDROCK_MAX_TOKENS ?? DEFAULT_MAX_TOKENS,
  );
  const temperature = Number(
    overrides.temperature ??
      process.env.BEDROCK_TEMPERATURE ??
      DEFAULT_TEMPERATURE,
  );
  const timeoutMs = Number(
    overrides.timeoutMs ?? process.env.BEDROCK_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
  );
  const sampleSize = Number(
    overrides.sampleSize ?? process.env.BEDROCK_SAMPLE_SIZE ?? DEFAULT_SAMPLE_SIZE,
  );

  return { region, modelId, maxTokens, temperature, timeoutMs, sampleSize };
}

/**
 * @param {unknown} err
 * @returns {BedrockReportFailure}
 */
export function mapBedrockError(err) {
  const name = err?.name || err?.constructor?.name || "";
  const message = err?.message || "Bedrock request failed";
  const httpStatus = err?.$metadata?.httpStatusCode;
  const lower = String(message).toLowerCase();

  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    lower.includes("timeout") ||
    lower.includes("aborted")
  ) {
    return {
      ok: false,
      error: {
        code: "TIMEOUT",
        message: "Bedrock request timed out",
        details: message,
      },
    };
  }

  if (
    name === "ThrottlingException" ||
    httpStatus === 429 ||
    lower.includes("throttl") ||
    lower.includes("too many requests")
  ) {
    return {
      ok: false,
      error: {
        code: "THROTTLED",
        message: "Bedrock request was throttled",
        details: message,
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "BEDROCK_ERROR",
      message: "Bedrock request failed",
      details: message,
    },
  };
}

/**
 * @param {import('@aws-sdk/client-bedrock-runtime').ConverseCommandOutput} response
 * @returns {string | null}
 */
export function extractReportText(response) {
  const blocks = response?.output?.message?.content;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return null;
  }

  const text = blocks
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join("")
    .trim();

  return text || null;
}

function createClient({ region, timeoutMs, client }) {
  if (client) return client;

  const bearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  const config = {
    region,
    ...(bearerToken
      ? {
          authSchemePreference: ["httpBearerAuth"],
          token: { token: bearerToken },
        }
      : {}),
  };

  if (timeoutMs) {
    config.requestHandler = { requestTimeout: timeoutMs };
  }

  return new BedrockRuntimeClient(config);
}

/**
 * Generate a human-readable comparison report via Amazon Bedrock (Converse API).
 * Prefer `aiReportService.generateComparisonReport` (defaults to Groq).
 *
 * @param {Record<string, unknown>} diff
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<BedrockReportResult>}
 */
export async function generateComparisonReport(diff, options = {}) {
  const config = readConfig(options);

  if (!config.region) {
    return {
      ok: false,
      error: {
        code: "CONFIG",
        message:
          "BEDROCK_REGION (or AWS_REGION) is required to call Amazon Bedrock",
      },
    };
  }

  if (!config.modelId) {
    return {
      ok: false,
      error: {
        code: "CONFIG",
        message: "BEDROCK_MODEL_ID is required to call Amazon Bedrock",
      },
    };
  }

  const summary = buildDiffSummaryForPrompt(diff, config.sampleSize);
  const inputText = buildReportPrompt(summary);

  const message = {
    content: [{ text: inputText }],
    role: ConversationRole.USER,
  };

  const request = {
    modelId: config.modelId,
    messages: [message],
    inferenceConfig: {
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    },
  };

  const client = createClient({
    region: config.region,
    timeoutMs: config.timeoutMs,
    client: options.client,
  });

  try {
    const response = await client.send(new ConverseCommand(request));
    const reportText = extractReportText(response);
    if (!reportText) {
      return {
        ok: false,
        error: {
          code: "MALFORMED_RESPONSE",
          message: "Bedrock returned an empty or unreadable message",
        },
      };
    }

    return {
      ok: true,
      reportText,
      modelId: config.modelId,
    };
  } catch (err) {
    return mapBedrockError(err);
  }
}
