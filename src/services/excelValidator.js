/**
 * Validate parsed field metadata before JSON / rule generation.
 */
export function validateFieldMetadata(fields) {
  const errors = [];

  if (!Array.isArray(fields) || fields.length === 0) {
    errors.push("At least one field row is required");
  }

  const seen = new Map();

  for (const [index, field] of (fields || []).entries()) {
    const label = field?.fieldName || `row ${index + 1}`;

    if (!field?.fieldName?.trim()) {
      errors.push(`Field at index ${index} is missing Field Name`);
      continue;
    }

    if (!field?.dataType?.trim()) {
      errors.push(`Field '${label}' is missing Data Type`);
    }

    if (field.key && field.key !== "X" && field.key !== "") {
      errors.push(`Field '${label}' has invalid Key value (use 'X' or blank)`);
    }

    const key = field.fieldName.trim().toUpperCase();
    if (seen.has(key)) {
      errors.push(
        `Duplicate Field Name '${field.fieldName}' (also at earlier row)`,
      );
    } else {
      seen.set(key, true);
    }

    if (
      field.length !== "" &&
      field.length != null &&
      typeof field.length !== "number" &&
      Number.isNaN(Number(field.length))
    ) {
      errors.push(`Field '${label}' has invalid Length '${field.length}'`);
    }
  }

  if (errors.length) {
    const error = new Error(errors.join("; "));
    error.status = 400;
    throw error;
  }

  return true;
}
