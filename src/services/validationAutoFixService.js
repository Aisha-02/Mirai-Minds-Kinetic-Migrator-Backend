/**
 * Auto-fix orchestration: apply rule-based transforms to SAP-mapped preload rows
 * and produce a downloadable refined preload file.
 */

import {
  buildRefinedFilename,
  serializeRowsToBuffer,
} from "../lib/uploadParse.js";
import { remapRowsToPreloadColumns, remapRowsToSapColumns } from "../constants/fieldColumnAliases.js";
import { applyAllFindings } from "./ruleFixService.js";

/**
 * Rows are expected to already use SAP field names (mapped before validation).
 *
 * @param {{
 *   rows: Record<string, unknown>[],
 *   findings: object[],
 *   filename: string,
 *   columnMapping?: Record<string, string>,
 *   originalColumns?: string[],
 *   sapFieldNames?: string[],
 * }} params
 */
export async function runValidationAutoFix({
  rows,
  findings,
  filename,
  columnMapping = {},
  originalColumns = [],
  sapFieldNames = [],
}) {
  const { rows: fixedRows, applied, skipped } = applyAllFindings(rows, findings);

  const refinedRows = remapRowsToSapColumns(
    fixedRows,
    columnMapping,
    sapFieldNames,
  );
  const refinedFilename = buildRefinedFilename(filename);
  const fileBuffer = serializeRowsToBuffer(refinedRows, filename);
  const previewRefinedRows = remapRowsToPreloadColumns(
    refinedRows.slice(0, 20),
    columnMapping,
    originalColumns,
  );

  return {
    ok: true,
    refinedRows,
    refinedFilename,
    fileBuffer,
    columnMapping,
    sapMetadataUsed: true,
    fixesApplied: applied.length,
    fixesSkipped: skipped.length,
    appliedFixes: applied,
    skippedFixes: skipped,
    rowCount: refinedRows.length,
    previewRefinedRows,
  };
}
