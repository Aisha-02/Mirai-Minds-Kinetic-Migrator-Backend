const DEFAULT_SAMPLE_SIZE = 5;

/**
 * @param {unknown[]} items
 * @param {number} sampleSize
 */
function sampleItems(items, sampleSize) {
  const list = Array.isArray(items) ? items : [];
  return {
    count: list.length,
    sample: list.slice(0, sampleSize),
    truncated: list.length > sampleSize,
  };
}

/**
 * Shrink a full comparisonEngine diff into a prompt-safe summary with samples.
 * @param {Record<string, unknown>} diff
 * @param {number} sampleSize
 */
export function buildDiffSummaryForPrompt(diff, sampleSize = DEFAULT_SAMPLE_SIZE) {
  const source = diff && typeof diff === "object" ? diff : {};

  return {
    missingRecords: sampleItems(source.missingRecords, sampleSize),
    missingValues: sampleItems(source.missingValues, sampleSize),
    valueMismatches: sampleItems(source.valueMismatches, sampleSize),
    duplicateRecords: sampleItems(source.duplicateRecords, sampleSize),
    baselineDuplicates: sampleItems(source.baselineDuplicates, sampleSize),
    extraRecords: sampleItems(source.extraRecords, sampleSize),
  };
}

/**
 * @param {ReturnType<typeof buildDiffSummaryForPrompt>} summary
 */
export function buildReportPrompt(summary) {
  return `You are a data-migration validation analyst. The structured diff below compares a POSTLOAD file against a PRELOAD baseline (directional check: postload is validated against preload).

Write a clear human-readable report with:
1. Executive summary — overall health and the most important risks first (missing records are highest priority).
2. Breakdown by issue type with counts:
   - Missing records (in preload, absent from postload)
   - Missing values (field had data in preload, empty/null in postload)
   - Value mismatches (postload value differs from preload)
   - Duplicate records in postload
   - Baseline duplicates in preload (informational — baseline may be unreliable)
   - Extra records in postload (informational / lower priority)
3. For each section with findings, include a few notable examples from the provided samples only. Do not invent rows. If a section's truncated flag is true, say that the samples are illustrative and the full list is available in the stored summary_json from the comparison job.
4. Keep the tone professional and concise. Use markdown headings and bullet lists.

STRUCTURED DIFF SUMMARY (JSON):
${JSON.stringify(summary, null, 2)}`;
}

export { DEFAULT_SAMPLE_SIZE };
