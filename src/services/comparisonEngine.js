/**
 * Directional comparison: postload is validated against preload (baseline).
 * Pure functions — no DB or HTTP dependencies.
 */

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function isEmptyValue(value) {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function valuesEqual(a, b) {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  if (isEmptyValue(a) || isEmptyValue(b)) return false;
  return String(a) === String(b);
}

/**
 * @param {Record<string, unknown>} row
 * @param {string[]} identifierColumns
 * @returns {{ key: string, identifier: unknown }}
 */
export function buildIdentifier(row, identifierColumns) {
  const columns = asArray(identifierColumns);
  if (columns.length === 0) {
    throw new Error("config.identifierColumns is required");
  }

  const parts = columns.map((col) => {
    const value = row?.[col];
    if (isEmptyValue(value)) return "";
    return String(value);
  });

  const key = parts.join("\u0001");

  const identifier =
    columns.length === 1
      ? (isEmptyValue(row?.[columns[0]]) ? null : row[columns[0]])
      : Object.fromEntries(
          columns.map((col) => [
            col,
            isEmptyValue(row?.[col]) ? null : row[col],
          ]),
        );

  return { key, identifier };
}

function collectColumns(rows) {
  const columns = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const key of Object.keys(row)) {
      columns.add(key);
    }
  }
  return columns;
}

function indexByIdentifier(rows, identifierColumns) {
  /** @type {Map<string, { identifier: unknown, rows: Record<string, unknown>[] }>} */
  const index = new Map();

  for (const row of rows) {
    const { key, identifier } = buildIdentifier(row, identifierColumns);
    const existing = index.get(key);
    if (existing) {
      existing.rows.push(row);
    } else {
      index.set(key, { identifier, rows: [row] });
    }
  }

  return index;
}

function resolveCompareColumns(preloadRows, postloadRows, config) {
  const identifierColumns = asArray(config.identifierColumns);
  const idSet = new Set(identifierColumns);

  if (config.compareColumns != null) {
    return asArray(config.compareColumns).filter((col) => !idSet.has(col));
  }

  const preloadColumns = collectColumns(preloadRows);
  const postloadColumns = collectColumns(postloadRows);
  const shared = [];

  for (const col of preloadColumns) {
    if (idSet.has(col)) continue;
    if (postloadColumns.has(col)) {
      shared.push(col);
    }
  }

  // If postload has no overlapping non-id columns yet (e.g. empty postload),
  // fall back to preload's non-id columns so missingValues can still be expressed
  // when rows do match in other scenarios.
  if (shared.length === 0) {
    return [...preloadColumns].filter((col) => !idSet.has(col));
  }

  return shared;
}

/**
 * Compare postload against preload (baseline).
 *
 * @param {Record<string, unknown>[]} preloadRows
 * @param {Record<string, unknown>[]} postloadRows
 * @param {{
 *   identifierColumns: string | string[],
 *   compareColumns?: string | string[],
 * }} config
 */
export function compareDatasets(preloadRows, postloadRows, config = {}) {
  if (!config || config.identifierColumns == null) {
    throw new Error("config.identifierColumns is required");
  }

  const identifierColumns = asArray(config.identifierColumns);
  if (identifierColumns.length === 0) {
    throw new Error("config.identifierColumns is required");
  }

  const preload = Array.isArray(preloadRows) ? preloadRows : [];
  const postload = Array.isArray(postloadRows) ? postloadRows : [];
  const compareColumns = resolveCompareColumns(preload, postload, {
    ...config,
    identifierColumns,
  });

  const preloadIndex = indexByIdentifier(preload, identifierColumns);
  const postloadIndex = indexByIdentifier(postload, identifierColumns);

  const missingRecords = [];
  const missingValues = [];
  const valueMismatches = [];
  const duplicateRecords = [];
  const baselineDuplicates = [];
  const extraRecords = [];

  for (const [key, entry] of preloadIndex) {
    if (entry.rows.length > 1) {
      baselineDuplicates.push({
        identifier: entry.identifier,
        count: entry.rows.length,
        records: entry.rows,
      });
    }

    const postEntry = postloadIndex.get(key);
    if (!postEntry) {
      missingRecords.push({
        identifier: entry.identifier,
        record: entry.rows[0],
      });
      continue;
    }

    // Directional field checks use the first row of each side when duplicates exist.
    const expected = entry.rows[0];
    const actual = postEntry.rows[0];

    for (const field of compareColumns) {
      const expectedValue = expected?.[field] ?? null;
      const actualValue = actual?.[field] ?? null;

      if (!isEmptyValue(expectedValue) && isEmptyValue(actualValue)) {
        missingValues.push({
          identifier: entry.identifier,
          field,
          expectedValue,
        });
        continue;
      }

      if (!valuesEqual(expectedValue, actualValue)) {
        // Skip reporting a "mismatch" when both empty — already treated equal.
        // Also skip when expected empty and actual has data (extra data in postload field).
        // Only flag when values differ and expected was non-empty or both non-empty differ.
        if (isEmptyValue(expectedValue) && !isEmptyValue(actualValue)) {
          continue;
        }
        valueMismatches.push({
          identifier: entry.identifier,
          field,
          expectedValue: isEmptyValue(expectedValue) ? null : expectedValue,
          actualValue: isEmptyValue(actualValue) ? null : actualValue,
        });
      }
    }
  }

  for (const [key, entry] of postloadIndex) {
    if (entry.rows.length > 1) {
      duplicateRecords.push({
        identifier: entry.identifier,
        count: entry.rows.length,
        records: entry.rows,
      });
    }

    if (!preloadIndex.has(key)) {
      extraRecords.push({
        identifier: entry.identifier,
        record: entry.rows[0],
      });
    }
  }

  return {
    missingRecords,
    missingValues,
    valueMismatches,
    duplicateRecords,
    baselineDuplicates,
    extraRecords,
  };
}
