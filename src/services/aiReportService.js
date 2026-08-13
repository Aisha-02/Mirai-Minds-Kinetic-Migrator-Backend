/**
 * Provider facade for AI comparison reports.
 * Default: Groq (free). Set AI_REPORT_PROVIDER=bedrock to use Bedrock instead.
 */

import { generateComparisonReport as generateGroqReport } from "./groqReportService.js";
import { generateComparisonReport as generateBedrockReport } from "./bedrockReportService.js";

function resolveProvider(explicit) {
  const value = String(
    explicit || process.env.AI_REPORT_PROVIDER || "groq",
  )
    .trim()
    .toLowerCase();
  return value === "bedrock" ? "bedrock" : "groq";
}

/**
 * @param {Record<string, unknown>} diff
 * @param {{ provider?: 'groq' | 'bedrock' } & Record<string, unknown>} [options]
 */
export async function generateComparisonReport(diff, options = {}) {
  const provider = resolveProvider(options.provider);

  if (provider === "bedrock") {
    const result = await generateBedrockReport(diff, options);
    if (result.ok) {
      return { ...result, provider: "bedrock" };
    }
    return result;
  }

  return generateGroqReport(diff, options);
}

export { resolveProvider };
