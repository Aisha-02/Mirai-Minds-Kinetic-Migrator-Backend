import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse as parseCsv } from "csv-parse/sync";
import * as XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const UPLOADS_ROOT = path.resolve(
  process.env.UPLOAD_DIR || path.join(__dirname, "..", "..", "uploads"),
);

const ALLOWED_EXTENSIONS = new Set([".csv", ".xlsx"]);

export function getFileExtension(filename) {
  return path.extname(String(filename || "")).toLowerCase();
}

export function isAllowedUploadFilename(filename) {
  return ALLOWED_EXTENSIONS.has(getFileExtension(filename));
}

function normalizeCell(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function normalizeRows(rows) {
  return rows.map((row) => {
    const normalized = {};
    for (const [key, value] of Object.entries(row)) {
      const header = String(key ?? "").trim();
      if (!header) continue;
      normalized[header] = normalizeCell(value);
    }
    return normalized;
  });
}

function parseCsvText(content) {
  const records = parseCsv(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
  return normalizeRows(records);
}

function parseXlsxWorkbook(workbook) {
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return [];
  }
  const sheet = workbook.Sheets[sheetName];
  const records = XLSX.utils.sheet_to_json(sheet, {
    defval: null,
    raw: false,
  });
  return normalizeRows(records);
}

export function parseUploadedBuffer(buffer, originalFilename) {
  const ext = getFileExtension(originalFilename);

  if (ext === ".csv") {
    return parseCsvText(Buffer.from(buffer).toString("utf8"));
  }

  if (ext === ".xlsx") {
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
    return parseXlsxWorkbook(workbook);
  }

  const err = new Error("Only .csv and .xlsx files are allowed");
  err.status = 400;
  throw err;
}

export function parseUploadedFile(filePath, originalFilename) {
  const ext = getFileExtension(originalFilename);

  if (ext === ".csv") {
    return parseCsvText(fs.readFileSync(filePath, "utf8"));
  }

  if (ext === ".xlsx") {
    const workbook = XLSX.readFile(filePath, { cellDates: true });
    return parseXlsxWorkbook(workbook);
  }

  const err = new Error("Only .csv and .xlsx files are allowed");
  err.status = 400;
  throw err;
}

export function ensureUploadDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function removeFileQuietly(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore cleanup failures
  }
}

export function buildStoragePath({ userId, batchId, fileType, originalFilename }) {
  const ext = getFileExtension(originalFilename) || ".bin";
  const safeBase = path
    .basename(originalFilename, ext)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 80);
  const filename = `${fileType}-${Date.now()}-${safeBase}${ext}`;
  return path.join(UPLOADS_ROOT, String(userId), String(batchId), filename);
}

export function buildRefinedFilename(originalFilename) {
  const ext = getFileExtension(originalFilename) || ".xlsx";
  return `preload_refined${ext}`;
}

/**
 * Serialize normalized row objects to CSV or XLSX buffer (matches upload format).
 * @param {Record<string, unknown>[]} rows
 * @param {string} originalFilename
 * @returns {Buffer}
 */
export function serializeRowsToBuffer(rows, originalFilename) {
  const ext = getFileExtension(originalFilename);
  const data = Array.isArray(rows) ? rows : [];

  if (ext === ".csv") {
    if (!data.length) return Buffer.from("", "utf8");
    const columns = Object.keys(data[0]);
    const escape = (value) => {
      if (value == null) return "";
      const str = String(value);
      if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
      return str;
    };
    const lines = [
      columns.join(","),
      ...data.map((row) => columns.map((col) => escape(row[col])).join(",")),
    ];
    return Buffer.from(lines.join("\n"), "utf8");
  }

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "preload_refined");
  return Buffer.from(
    XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
  );
}
