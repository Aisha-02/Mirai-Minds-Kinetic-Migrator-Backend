import {
  DEFAULT_SAMPLE_SIZE,
  buildDiffSummaryForPrompt,
  buildReportPrompt,
} from "./reportPrompt.js";
import {
  createBedrockClient,
  extractConverseText,
  mapBedrockError,
  readBedrockConfig,
  buildInferenceConfig,
} from "./bedrockClient.js";
import { ConversationRole, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

export { buildDiffSummaryForPrompt, buildReportPrompt };

/** @typedef {'TIMEOUT' | 'THROTTLED' | 'MALFORMED_RESPONSE' | 'CONFIG' | 'BEDROCK_ERROR'} BedrockReportErrorCode */

/**
 * @typedef {{
 *   ok: true,
 *   reportText: string,
 *   modelId: string,
 *   provider: 'bedrock',
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

function readReportConfig(overrides = {}) {
  const base = readBedrockConfig(overrides);
  const sampleSize = Number(
    overrides.sampleSize ?? process.env.BEDROCK_SAMPLE_SIZE ?? DEFAULT_SAMPLE_SIZE,
  );
  return { ...base, sampleSize };
}

/**
 * Generate a human-readable comparison report via Amazon Bedrock (Converse API).
 *
 * @param {Record<string, unknown>} diff
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<BedrockReportResult>}
 */
export async function generateComparisonReport(diff, options = {}) {
  const config = readReportConfig(options);

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

  const request = {
    modelId: config.modelId,
    messages: [
      {
        role: ConversationRole.USER,
        content: [{ text: inputText }],
      },
    ],
    inferenceConfig: buildInferenceConfig({
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      modelId: config.modelId,
    }),
  };

  const client = createBedrockClient({
    region: config.region,
    timeoutMs: config.timeoutMs,
    client: options.client,
  });

  try {
    const response = await client.send(new ConverseCommand(request));
    const reportText = extractConverseText(response);
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
      provider: "bedrock",
    };
  } catch (err) {
    const mapped = mapBedrockError(err);
    return {
      ok: false,
      error: mapped,
    };
  }
}
