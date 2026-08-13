import * as XLSX from "xlsx";

const HEADER_ALIASES = {
  key: ["key", "is key", "iskey", "primary key", "pk", "key field"],
  fieldName: ["field name", "fieldname", "field", "name", "column", "column name"],
  dataType: ["data type", "datatype", "type", "field type"],
  length: ["length", "len", "size", "max length", "maxlen"],
  defaultValue: ["default value", "defaultvalue", "default", "def", "default val"],
};

function normalizeHeader(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function mapHeaders(headers) {
  const mapping = {};
  for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
    const index = headers.findIndex((header) =>
      aliases.includes(normalizeHeader(header)),
    );
    if (index >= 0) mapping[canonical] = index;
  }
  return mapping;
}

function cellToString(value) {
  if (value == null) return "";
  return String(value).trim();
}

function normalizeKeyFlag(value) {
  const raw = cellToString(value).toUpperCase();
  if (!raw) return "";
  if (["X", "Y", "YES", "TRUE", "1", "PK", "KEY"].includes(raw)) return "X";
  return "";
}

function normalizeLength(value) {
  const raw = cellToString(value);
  if (!raw) return "";
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && String(asNumber) === raw.replace(/^0+(?=\d)/, "")) {
    return asNumber;
  }
  if (Number.isFinite(asNumber) && /^\d+(\.\d+)?$/.test(raw)) {
    return Number.isInteger(asNumber) ? asNumber : asNumber;
  }
  const intMatch = raw.match(/^\d+/);
  return intMatch ? Number(intMatch[0]) : raw;
}

/**
 * Parse Excel buffer into field metadata rows.
 * Required columns: Field Name, Data Type
 * Optional: Length, Default Value, Key
 */
export function parseFieldMetadataExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames[0];

  if (!sheetName) {
    const error = new Error("Excel file has no sheets");
    error.status = 400;
    throw error;
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: false,
  });

  if (!rows.length) {
    const error = new Error("Excel sheet is empty");
    error.status = 400;
    throw error;
  }

  const headers = (rows[0] || []).map((h) => (h == null ? "" : String(h)));
  const mapping = mapHeaders(headers);

  if (mapping.fieldName == null || mapping.dataType == null) {
    const error = new Error(
      "Excel must include 'Field Name' and 'Data Type' columns. Optional: Length, Default Value, Key",
    );
    error.status = 400;
    throw error;
  }

  const fields = [];
  const issues = [];

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i] || [];
    const excelRow = i + 1;
    const fieldName = cellToString(row[mapping.fieldName]);
    if (!fieldName) continue;

    const dataType = cellToString(row[mapping.dataType]);
    if (!dataType) {
      issues.push(`Row ${excelRow}: Data Type is required for field '${fieldName}'`);
      continue;
    }

    fields.push({
      key:
        mapping.key == null ? "" : normalizeKeyFlag(row[mapping.key]),
      fieldName,
      dataType,
      length:
        mapping.length == null ? "" : normalizeLength(row[mapping.length]),
      defaultValue:
        mapping.defaultValue == null
          ? ""
          : cellToString(row[mapping.defaultValue]),
    });
  }

  if (issues.length) {
    const error = new Error(issues.join("; "));
    error.status = 400;
    throw error;
  }

  if (!fields.length) {
    const error = new Error("No valid field rows found in Excel file");
    error.status = 400;
    throw error;
  }

  return fields;
}

/**
 * Wrap parsed fields under the selected Business Object key.
 * Shape: { "PO": { "fields": [ ... ] } }
 */
export function toBusinessObjectJson(businessObject, fields) {
  return {
    [businessObject]: {
      fields,
    },
  };
}

export function getFieldsFromSourceJson(businessObject, sourceFields) {
  const block = sourceFields?.[businessObject];
  if (Array.isArray(block)) return block;
  if (block && Array.isArray(block.fields)) return block.fields;
  return [];
}
