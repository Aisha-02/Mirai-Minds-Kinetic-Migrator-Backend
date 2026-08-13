import {
  BedrockRuntimeClient,
  ConversationRole,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { extractReportText, mapBedrockError } from "./bedrockReportService.js";

const DEFAULT_TIMEOUT_MS = 45_000;

function readConfig(overrides = {}) {
  const region =
    overrides.region ||
    process.env.BEDROCK_REGION ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION;

  const modelId =
    overrides.modelId ||
    process.env.BEDROCK_MODEL_ID ||
    "apac.anthropic.claude-sonnet-5-v1:0";

  const maxTokens = Number(
    overrides.maxTokens ?? process.env.BEDROCK_MAX_TOKENS ?? 4096,
  );
  const temperature = Number(
    overrides.temperature ?? process.env.BEDROCK_TEMPERATURE ?? 0,
  );
  const timeoutMs = Number(
    overrides.timeoutMs ?? process.env.BEDROCK_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
  );

  return { region, modelId, maxTokens, temperature, timeoutMs };
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
 * Send a single user prompt to Bedrock Converse and return plain text.
 *
 * @param {string} prompt
 * @param {Record<string, unknown>} [options]
 */
export async function converseText(prompt, options = {}) {
  const config = readConfig(options);

  if (!config.region) {
    return {
      ok: false,
      error: {
        code: "CONFIG",
        message: "BEDROCK_REGION (or AWS_REGION) is required",
      },
    };
  }

  if (!config.modelId) {
    return {
      ok: false,
      error: {
        code: "CONFIG",
        message: "BEDROCK_MODEL_ID is required",
      },
    };
  }

  const client = createClient({
    region: config.region,
    timeoutMs: config.timeoutMs,
    client: options.client,
  });

  try {
    const response = await client.send(
      new ConverseCommand({
        modelId: config.modelId,
        messages: [
          {
            role: ConversationRole.USER,
            content: [{ text: prompt }],
          },
        ],
        inferenceConfig: {
          maxTokens: config.maxTokens,
          temperature: config.temperature,
        },
      }),
    );

    const text = extractReportText(response);
    if (!text) {
      return {
        ok: false,
        error: {
          code: "MALFORMED_RESPONSE",
          message: "Bedrock returned an empty response",
        },
      };
    }

    return { ok: true, text, modelId: config.modelId };
  } catch (err) {
    return mapBedrockError(err);
  }
}
