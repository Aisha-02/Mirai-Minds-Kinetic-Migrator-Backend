/**
 * Equivalent SAP / preload column names for validation rule field matching.
 * Rule field names from Admin (e.g. MATERIAL_NUMBER) often differ from
 * preload extract headers (e.g. MATNR).
 */

/** @type {readonly (readonly string[])[]} */
export const FIELD_EQUIVALENCE_GROUPS = Object.freeze([
  // Material Master (MM)
  ["MATERIALNUMBER", "MATNR"],
  ["MATERIALTYPE", "MTART"],
  ["MATERIALGROUP", "MATKL"],
  ["MATERIALDESC", "MAKTX", "MATERIALDESCRIPTION"],
  ["UOMCODE", "MEINS", "BASEUNITOFMEASURE"],
  ["PLANTCODE", "WERKS", "PLANT"],
  ["LANGUAGECODE", "SPRAS", "LANGUAGEKEY"],
  ["GROSSWEIGHT", "BRGEW"],
  ["NETWEIGHT", "NTGEW"],
  ["WEIGHTUNIT", "GEWEI"],
  // Purchase Order (PO)
  ["PONUMBER", "EBELN", "PURCHASEORDER"],
  ["POITEM", "EBELP", "ITEMNUMBER"],
  ["VENDORNUMBER", "LIFNR", "VENDOR"],
  // Business Partner (BP)
  ["PARTNERNUMBER", "PARTNER", "BPNUMBER", "KUNNR", "LIFNR"],
  // Sales Order (SO)
  ["SALESORDERNUMBER", "VBELN", "SALESORDER"],
  ["SALESORDERITEM", "POSNR", "ITEM"],
  // GL Account
  ["GLACCOUNT", "SAKNR", "GLACCOUNTNUMBER", "HKONT"],
]);

function normalizeFieldKey(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function buildEquivalenceIndex() {
  /** @type {Map<string, Set<string>>} */
  const index = new Map();

  for (const group of FIELD_EQUIVALENCE_GROUPS) {
    const norms = group.map((name) => normalizeFieldKey(name));
    for (const norm of norms) {
      if (!index.has(norm)) index.set(norm, new Set());
      for (const other of norms) {
        index.get(norm).add(other);
      }
    }
  }

  return index;
}

const EQUIVALENCE_INDEX = buildEquivalenceIndex();

function areEquivalent(fieldNorm, columnNorm) {
  if (fieldNorm === columnNorm) return true;
  const equivalents = EQUIVALENCE_INDEX.get(fieldNorm);
  return equivalents?.has(columnNorm) ?? false;
}

/**
 * Resolve a rule field name to an uploaded column header.
 * @param {string} fieldName
 * @param {string[]} columns
 * @returns {string | null}
 */
export function resolveFieldColumn(fieldName, columns) {
  const target = normalizeFieldKey(fieldName);
  if (!target) return null;

  const byNorm = new Map(columns.map((col) => [normalizeFieldKey(col), col]));

  if (byNorm.has(target)) return byNorm.get(target);

  for (const [norm, col] of byNorm) {
    if (norm.includes(target) || target.includes(norm)) return col;
  }

  for (const [norm, col] of byNorm) {
    if (areEquivalent(target, norm)) return col;
  }

  return null;
}

function pickCanonicalSapNameFromGroup(group) {
  const sorted = [...group].sort(
    (a, b) => normalizeFieldKey(a).length - normalizeFieldKey(b).length,
  );
  return sorted[0];
}

/**
 * Resolve a single preload/descriptive column header to a SAP technical field name.
 */
export function resolveSapNameForPreloadColumn(column, sapFieldNames = []) {
  const norm = normalizeFieldKey(column);

  for (const sap of sapFieldNames) {
    if (normalizeFieldKey(sap) === norm) return sap;
  }

  for (const sap of sapFieldNames) {
    if (resolveFieldColumn(sap, [column]) === column) return sap;
  }

  for (const group of FIELD_EQUIVALENCE_GROUPS) {
    if (group.some((name) => normalizeFieldKey(name) === norm)) {
      const canonical = pickCanonicalSapNameFromGroup(group);
      const metadataMatch = sapFieldNames.find(
        (sap) => normalizeFieldKey(sap) === normalizeFieldKey(canonical),
      );
      return metadataMatch || canonical;
    }
  }

  for (const sap of sapFieldNames) {
    if (areEquivalent(norm, normalizeFieldKey(sap))) return sap;
  }

  return String(column).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
}

/**
 * Map preload column headers to canonical SAP field names using SAP metadata.
 * Every preload column is mapped — descriptive names are never kept as-is.
 * @param {string[]} preloadColumns
 * @param {string[]} sapFieldNames
 * @returns {Record<string, string>}
 */
export function buildPreloadToSapColumnMap(preloadColumns, sapFieldNames) {
  /** @type {Record<string, string>} */
  const mapping = {};
  const assignedSources = new Set();

  for (const sapField of sapFieldNames || []) {
    const sourceCol = resolveFieldColumn(sapField, preloadColumns);
    if (sourceCol && !assignedSources.has(sourceCol)) {
      mapping[sourceCol] = sapField;
      assignedSources.add(sourceCol);
    }
  }

  for (const col of preloadColumns || []) {
    if (mapping[col]) continue;
    mapping[col] = resolveSapNameForPreloadColumn(col, sapFieldNames);
  }

  return mapping;
}

/**
 * Rename row keys to SAP field names only (no descriptive headers remain).
 * @param {Record<string, unknown>[]} rows
 * @param {Record<string, string>} columnMapping
 * @param {string[]} [sapFieldNames] optional column order for export
 */
export function remapRowsToSapColumns(rows, columnMapping, sapFieldNames = []) {
  const sapColumns =
    sapFieldNames.length > 0
      ? [
          ...sapFieldNames.filter((sap) =>
            Object.values(columnMapping).includes(sap),
          ),
          ...[
            ...new Set(
              Object.values(columnMapping).filter(
                (sap) => !sapFieldNames.includes(sap),
              ),
            ),
          ],
        ]
      : [...new Set(Object.values(columnMapping))];

  return (rows || []).map((row) => {
    const remapped = {};
    for (const sapCol of sapColumns) {
      if (row?.[sapCol] !== undefined) {
        remapped[sapCol] = row[sapCol];
        continue;
      }
      const sourceCol = Object.entries(columnMapping).find(
        ([, sap]) => sap === sapCol,
      )?.[0];
      remapped[sapCol] =
        sourceCol && row?.[sourceCol] !== undefined ? row[sourceCol] : null;
    }
    return remapped;
  });
}

/**
 * Map SAP-keyed row data back to the original preload column headers for UI preview.
 * @param {Record<string, unknown>[]} rows
 * @param {Record<string, string>} columnMapping source preload column → SAP field
 * @param {string[]} [originalColumns] preserve upload column order
 */
export function remapRowsToPreloadColumns(
  rows,
  columnMapping,
  originalColumns = [],
) {
  const order =
    originalColumns.length > 0
      ? originalColumns
      : Object.keys(columnMapping || {});

  return (rows || []).map((row) => {
    const preview = {};
    for (const originalCol of order) {
      const sapCol = columnMapping?.[originalCol] || originalCol;
      preview[originalCol] =
        row?.[sapCol] !== undefined ? row[sapCol] : (row?.[originalCol] ?? null);
    }
    return preview;
  });
}

export { normalizeFieldKey };
