/**
 * Compare preload file columns to SAP metadata fields.
 * Missing optional fields / unexpected columns → warnings.
 * Missing SAP key fields → hard error (comparison cannot run without keys).
 */

/**
 * @param {string[]} fileColumns
 * @param {import('./sapMetadataService.js').SapMetadataField[] | Array<{fieldName: string, isKey?: boolean}>} schemaFields
 */
export function validateColumnsAgainstSchema(fileColumns, schemaFields) {
  const fileSet = new Set(
    (fileColumns || []).map((col) => String(col).trim()).filter(Boolean),
  );
  const fileLower = new Map(
    [...fileSet].map((name) => [name.toLowerCase(), name]),
  );

  const schemaNames = (schemaFields || [])
    .map((field) => String(field.fieldName || "").trim())
    .filter(Boolean);
  const schemaLower = new Map(
    schemaNames.map((name) => [name.toLowerCase(), name]),
  );

  const keyFields = (schemaFields || [])
    .filter((field) => field.isKey)
    .map((field) => String(field.fieldName).trim())
    .filter(Boolean);

  const missingColumns = schemaNames.filter(
    (name) => !fileLower.has(name.toLowerCase()),
  );
  const unexpectedColumns = [...fileSet].filter(
    (name) => !schemaLower.has(name.toLowerCase()),
  );
  const missingKeyColumns = keyFields.filter(
    (name) => !fileLower.has(name.toLowerCase()),
  );

  const warnings = [];
  if (missingColumns.length > 0) {
    warnings.push({
      code: "MISSING_SCHEMA_COLUMNS",
      message: "Preload is missing some SAP schema columns",
      columns: missingColumns,
    });
  }
  if (unexpectedColumns.length > 0) {
    warnings.push({
      code: "UNEXPECTED_COLUMNS",
      message: "Preload has columns not present in the SAP schema",
      columns: unexpectedColumns,
    });
  }

  // Resolve identifier columns to the file's actual casing when possible
  const identifierColumns = keyFields.map(
    (name) => fileLower.get(name.toLowerCase()) || name,
  );

  return {
    ok: missingKeyColumns.length === 0 && identifierColumns.length > 0,
    identifierColumns,
    warnings,
    missingKeyColumns,
    missingColumns,
    unexpectedColumns,
  };
}
