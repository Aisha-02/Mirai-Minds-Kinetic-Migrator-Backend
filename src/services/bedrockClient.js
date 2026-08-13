import {
  BedrockRuntimeClient,
  ConversationRole,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 60_000;

/** @typedef {'TIMEOUT' | 'THROTTLED' | 'MALFORMED_RESPONSE' | 'CONFIG' | 'BEDROCK_ERROR'} BedrockErrorCode */

/**
 * @param {Record<string, unknown>} [overrides]
 */
export function readBedrockConfig(overrides = {}) {
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

  return { region, modelId, maxTokens, temperature, timeoutMs };
}

/**
 * Build Converse inferenceConfig. Some models (e.g. claude-sonnet-5) reject temperature.
 * @param {{ maxTokens: number, temperature?: number, modelId?: string }} params
 */
export function buildInferenceConfig({ maxTokens, temperature, modelId } = {}) {
  const config = { maxTokens };
  const model = String(modelId || process.env.BEDROCK_MODEL_ID || "");
  const skipTemperature =
    process.env.BEDROCK_SKIP_TEMPERATURE === "true" ||
    /claude-sonnet-5/i.test(model);

  if (
    !skipTemperature &&
    temperature != null &&
    !Number.isNaN(temperature)
  ) {
    config.temperature = temperature;
  }

  return config;
}

/**
 * @param {unknown} err
 * @returns {{ code: BedrockErrorCode, message: string, details?: string }}
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
      code: "TIMEOUT",
      message: "Bedrock request timed out",
      details: message,
    };
  }

  if (
    name === "ThrottlingException" ||
    httpStatus === 429 ||
    lower.includes("throttl") ||
    lower.includes("too many requests")
  ) {
    return {
      code: "THROTTLED",
      message: "Bedrock request was throttled",
      details: message,
    };
  }

  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    lower.includes("access denied") ||
    lower.includes("not authorized")
  ) {
    return {
      code: "BEDROCK_ERROR",
      message: "Bedrock access denied. Check AWS credentials and model access.",
      details: message,
    };
  }

  return {
    code: "BEDROCK_ERROR",
    message: "Bedrock request failed",
    details: message,
  };
}

/**
 * @param {import('@aws-sdk/client-bedrock-runtime').ConverseCommandOutput} response
 * @returns {string | null}
 */
export function extractConverseText(response) {
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

/**
 * @param {{ region?: string, timeoutMs?: number, client?: import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient }} params
 */
export function createBedrockClient({ region, timeoutMs, client }) {
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

function assertBedrockConfig(config) {
  if (!config.region) {
    const error = new Error(
      "BEDROCK_REGION (or AWS_REGION) is required to call Amazon Bedrock",
    );
    error.code = "CONFIG";
    error.status = 500;
    throw error;
  }

  if (!config.modelId) {
    const error = new Error("BEDROCK_MODEL_ID is required to call Amazon Bedrock");
    error.code = "CONFIG";
    error.status = 500;
    throw error;
  }
}

function throwFromBedrockFailure(mapped) {
  const error = new Error(mapped.message);
  error.code = mapped.code;
  error.details = mapped.details;
  error.status =
    mapped.code === "THROTTLED"
      ? 429
      : mapped.code === "CONFIG"
        ? 500
        : 502;
  throw error;
}

/**
 * Call Amazon Bedrock Converse API and return the assistant text.
 *
 * @param {{
 *   systemText?: string,
 *   userText: string,
 *   maxTokens?: number,
 *   temperature?: number,
 *   modelId?: string,
 *   region?: string,
 *   timeoutMs?: number,
 *   client?: import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient,
 * }} params
 * @returns {Promise<{ text: string, modelId: string }>}
 */
export async function converseText({
  systemText,
  userText,
  maxTokens,
  temperature,
  modelId,
  region,
  timeoutMs,
  client,
} = {}) {
  const config = readBedrockConfig({
    modelId,
    region,
    maxTokens,
    temperature,
    timeoutMs,
  });
  assertBedrockConfig(config);

  const request = {
    modelId: config.modelId,
    messages: [
      {
        role: ConversationRole.USER,
        content: [{ text: userText }],
      },
    ],
    ...(systemText ? { system: [{ text: systemText }] } : {}),
    inferenceConfig: buildInferenceConfig({
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      modelId: config.modelId,
    }),
  };

  const bedrockClient = createBedrockClient({
    region: config.region,
    timeoutMs: config.timeoutMs,
    client,
  });

  try {
    const response = await bedrockClient.send(new ConverseCommand(request));
    const text = extractConverseText(response);
    if (!text) {
      const error = new Error("Bedrock returned an empty or unreadable message");
      error.code = "MALFORMED_RESPONSE";
      error.status = 502;
      throw error;
    }

    return { text, modelId: config.modelId };
  } catch (err) {
    if (err?.code) throw err;
    throwFromBedrockFailure(mapBedrockError(err));
  }
}
