/**
 * AI comparison reports via Amazon Bedrock.
 */

import { generateComparisonReport as generateBedrockReport } from "./bedrockReportService.js";

/**
 * @param {Record<string, unknown>} diff
 * @param {Record<string, unknown>} [options]
 */
export async function generateComparisonReport(diff, options = {}) {
  return generateBedrockReport(diff, options);
}
