/**
 * SAP OData V2 business-object metadata client.
 * Standalone — not wired into upload/comparison routes yet.
 *
 * Security note: the configured base URL uses plain HTTP (not HTTPS) in the
 * demo environment. Credentials travel in Basic Auth headers over that channel.
 * Worth raising with the SAP team if this remains unencrypted outside a private network.
 */

import { XMLParser } from "fast-xml-parser";

export const SUPPORTED_BUSINESS_OBJECTS = Object.freeze([
  "MATERIAL_MASTER",
  "SALES_ORDER",
  "GL_ACCOUNT",
  "BUSINESS_PARTNER",
  "PURCHASE_ORDER",
]);

/**
 * SAP client/mandant columns — appear as IsKey=true in ZSB_BUSOBJ_CONFIG but are
 * not present in migration preload extracts and are not useful as row match keys.
 */
const SYSTEM_CLIENT_FIELDS = new Set(["CLIENT", "MANDT"]);

/**
 * When SAP only marks CLIENT/MANDT as keys (current demo gateway behavior),
 * use these business identifiers for comparison matching.
 */
export const FALLBACK_IDENTIFIER_COLUMNS = Object.freeze({
  MATERIAL_MASTER: ["MATNR"],
  BUSINESS_PARTNER: ["PARTNER"],
  SALES_ORDER: ["VBELN", "POSNR"],
  GL_ACCOUNT: ["SAKNR"],
  PURCHASE_ORDER: ["EBELN", "EBELP"],
});

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_TIMEOUT_MS = 15_000;

/** @typedef {{
 *   fieldName: string,
 *   dataType: string | null,
 *   length: number | null,
 *   decimals: number | null,
 *   isKey: boolean,
 * }} SapMetadataField */

/** @typedef {{
 *   ok: true,
 *   businessObject: string,
 *   fields: SapMetadataField[],
 *   identifierColumns: string[],
 *   cached: boolean,
 *   fetchedAt: string,
 * }} SapMetadataSuccess */

/** @typedef {{
 *   ok: false,
 *   error: {
 *     code: 'CONFIG' | 'UNSUPPORTED_BUSINESS_OBJECT' | 'AUTH' | 'NETWORK' | 'TIMEOUT' | 'PARSE' | 'EMPTY' | 'SAP_ERROR',
 *     message: string,
 *     details?: string,
 *   },
 * }} SapMetadataFailure */

/** @typedef {SapMetadataSuccess | SapMetadataFailure} SapMetadataResult */

/** @type {Map<string, { expiresAt: number, payload: Omit<SapMetadataSuccess, 'cached'> }>} */
const metadataCache = new Map();

function readConfig(overrides = {}) {
  const baseUrl = String(
    overrides.baseUrl ?? process.env.SAP_ODATA_BASE_URL ?? "",
  )
    .trim()
    .replace(/\/$/, "");
  const username = String(
    overrides.username ?? process.env.SAP_ODATA_USERNAME ?? "",
  ).trim();
  const password = String(
    overrides.password ?? process.env.SAP_ODATA_PASSWORD ?? "",
  );
  const timeoutMs = Number(
    overrides.timeoutMs ??
      process.env.SAP_ODATA_TIMEOUT_MS ??
      DEFAULT_TIMEOUT_MS,
  );
  const cacheTtlMs = Number(
    overrides.cacheTtlMs ??
      process.env.SAP_METADATA_CACHE_TTL_MS ??
      DEFAULT_CACHE_TTL_MS,
  );

  return { baseUrl, username, password, timeoutMs, cacheTtlMs };
}

function normalizeBusinessObject(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function buildBasicAuthHeader(username, password) {
  const token = Buffer.from(`${username}:${password}`, "utf8").toString(
    "base64",
  );
  return `Basic ${token}`;
}

function buildMetadataUrl(baseUrl, businessObject, { formatJson }) {
  // Keep OData V2 quoting: BusObj='MATERIAL_MASTER'
  const encodedBusObj = encodeURIComponent(`'${businessObject}'`);
  let query = `BusObj=${encodedBusObj}`;
  if (formatJson) {
    query += "&$format=json";
  }
  return `${baseUrl}/getMetadata?${query}`;
}

function isSystemClientField(fieldName) {
  return SYSTEM_CLIENT_FIELDS.has(String(fieldName || "").trim().toUpperCase());
}

/**
 * Prefer SAP IsKey flags, but ignore CLIENT/MANDT. If nothing remains, use
 * known business-object fallbacks that exist in the returned field list.
 *
 * @param {string} businessObject
 * @param {SapMetadataField[]} fields
 * @returns {{ fields: SapMetadataField[], identifierColumns: string[] }}
 */
export function resolveIdentifierColumns(businessObject, fields) {
  const list = Array.isArray(fields) ? fields : [];
  const byUpper = new Map(
    list.map((field) => [field.fieldName.toUpperCase(), field.fieldName]),
  );

  const fromSap = list
    .filter((field) => field.isKey && !isSystemClientField(field.fieldName))
    .map((field) => field.fieldName);

  let identifierColumns = fromSap;
  if (identifierColumns.length === 0) {
    const fallback = FALLBACK_IDENTIFIER_COLUMNS[businessObject] || [];
    identifierColumns = fallback
      .map((name) => byUpper.get(String(name).toUpperCase()))
      .filter(Boolean);
  }

  const keySet = new Set(
    identifierColumns.map((name) => String(name).toUpperCase()),
  );
  const adjustedFields = list.map((field) => ({
    ...field,
    // Effective comparison keys — CLIENT stays in schema but is not required
    isKey: keySet.has(field.fieldName.toUpperCase()),
  }));

  return { fields: adjustedFields, identifierColumns };
}

function toNumberOrNull(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["true", "x", "yes", "1", "key"].includes(normalized);
}

function pick(object, keys) {
  for (const key of keys) {
    if (object?.[key] != null && object[key] !== "") return object[key];
  }
  return undefined;
}

/**
 * Normalize a single raw field record from JSON/XML into SapMetadataField.
 * @param {Record<string, unknown>} raw
 * @returns {SapMetadataField | null}
 */
export function normalizeFieldRecord(raw) {
  if (!raw || typeof raw !== "object") return null;

  const fieldName = pick(raw, [
    "fieldName",
    "FieldName",
    "FIELD_NAME",
    "name",
    "Name",
    "PropertyName",
    "propertyName",
    "COLUMN_NAME",
    "ColumnName",
  ]);

  if (fieldName == null || String(fieldName).trim() === "") return null;

  const dataTypeRaw = pick(raw, [
    "dataType",
    "DataType",
    "DATA_TYPE",
    "type",
    "Type",
    "EdmType",
    "ABAPType",
    "AbapType",
  ]);

  const lengthRaw = pick(raw, [
    "length",
    "Length",
    "LENGTH",
    "maxLength",
    "MaxLength",
    "Precision",
    "precision",
  ]);

  const decimalsRaw = pick(raw, [
    "decimals",
    "Decimals",
    "DECIMALS",
    "scale",
    "Scale",
  ]);

  const isKeyRaw = pick(raw, [
    "isKey",
    "IsKey",
    "IS_KEY",
    "key",
    "Key",
    "iskey",
    "IsPrimaryKey",
    "primaryKey",
  ]);

  return {
    fieldName: String(fieldName).trim(),
    dataType: dataTypeRaw == null ? null : String(dataTypeRaw).trim(),
    length: toNumberOrNull(lengthRaw),
    decimals: toNumberOrNull(decimalsRaw),
    isKey: toBoolean(isKeyRaw),
  };
}

function collectCandidateArrays(node, out = []) {
  if (Array.isArray(node)) {
    out.push(node);
    for (const item of node) collectCandidateArrays(item, out);
    return out;
  }
  if (node && typeof node === "object") {
    // OData/XML often returns a single object instead of a one-element array
    if (normalizeFieldRecord(node)) {
      out.push([node]);
    }
    for (const value of Object.values(node)) {
      collectCandidateArrays(value, out);
    }
  }
  return out;
}

/**
 * Find the most plausible array of field metadata objects in a parsed payload.
 * @param {unknown} payload
 * @returns {Record<string, unknown>[]}
 */
export function extractFieldRecords(payload) {
  const arrays = collectCandidateArrays(payload);
  let best = [];
  let bestScore = -1;

  for (const arr of arrays) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const objects = arr.filter(
      (item) => item && typeof item === "object" && !Array.isArray(item),
    );
    if (objects.length === 0) continue;

    let score = 0;
    for (const item of objects) {
      if (normalizeFieldRecord(item)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = objects;
    }
  }

  if (bestScore <= 0) return [];
  return best;
}

/**
 * Parse OData/Atom-style Property + Key/PropertyRef XML into field records.
 * @param {unknown} parsedXml
 */
function extractFromEdmxStyle(parsedXml) {
  const properties = [];
  const keyNames = new Set();

  function walk(node) {
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      const local = key.includes(":") ? key.split(":").pop() : key;

      if (local === "PropertyRef" && value) {
        const refs = Array.isArray(value) ? value : [value];
        for (const ref of refs) {
          const name = ref?.["@_Name"] ?? ref?.Name ?? ref?.name;
          if (name) keyNames.add(String(name));
        }
      }

      if (local === "Property" && value) {
        const props = Array.isArray(value) ? value : [value];
        for (const prop of props) {
          properties.push({
            Name: prop?.["@_Name"] ?? prop?.Name,
            Type: prop?.["@_Type"] ?? prop?.Type,
            MaxLength: prop?.["@_MaxLength"] ?? prop?.MaxLength,
            Precision: prop?.["@_Precision"] ?? prop?.Precision,
            Scale: prop?.["@_Scale"] ?? prop?.Scale,
            IsKey: false,
          });
        }
      }

      walk(value);
    }
  }

  walk(parsedXml);

  return properties.map((prop) => ({
    ...prop,
    IsKey: keyNames.has(String(prop.Name ?? "")),
  }));
}

/**
 * @param {string} bodyText
 * @param {string} contentType
 * @returns {SapMetadataField[]}
 */
export function parseMetadataBody(bodyText, contentType = "") {
  const trimmed = String(bodyText ?? "").trim();
  if (!trimmed) {
    const err = new Error("SAP metadata response was empty");
    err.code = "EMPTY";
    throw err;
  }

  const lowerType = String(contentType).toLowerCase();
  const looksJson =
    lowerType.includes("json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[");

  if (looksJson) {
    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch (err) {
      const parseErr = new Error("SAP metadata JSON could not be parsed");
      parseErr.code = "PARSE";
      parseErr.cause = err;
      throw parseErr;
    }

    const records = extractFieldRecords(payload);
    const fields = records
      .map((record) => normalizeFieldRecord(record))
      .filter(Boolean);

    if (fields.length === 0) {
      const err = new Error(
        "SAP metadata JSON did not contain recognizable field definitions",
      );
      err.code = "PARSE";
      throw err;
    }
    return dedupeFields(fields);
  }

  // XML fallback (OData V2 default)
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      removeNSPrefix: false,
      trimValues: true,
    });
    const parsed = parser.parse(trimmed);

    let records = extractFieldRecords(parsed);
    if (records.length === 0) {
      records = extractFromEdmxStyle(parsed);
    }

    const fields = records
      .map((record) => normalizeFieldRecord(record))
      .filter(Boolean);

    if (fields.length === 0) {
      const err = new Error(
        "SAP metadata XML did not contain recognizable field definitions",
      );
      err.code = "PARSE";
      throw err;
    }
    return dedupeFields(fields);
  } catch (err) {
    if (err?.code === "PARSE" || err?.code === "EMPTY") throw err;
    const parseErr = new Error("SAP metadata XML could not be parsed");
    parseErr.code = "PARSE";
    parseErr.cause = err;
    throw parseErr;
  }
}

function dedupeFields(fields) {
  const seen = new Set();
  const out = [];
  for (const field of fields) {
    const key = field.fieldName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(field);
  }
  return out;
}

async function fetchMetadataOnce({
  url,
  authHeader,
  timeoutMs,
  fetchImpl,
  accept,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: accept,
      },
      signal: controller.signal,
    });

    const bodyText = await response.text();
    return { response, bodyText };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and normalize metadata for a SAP business object.
 * Returns a typed result — never throws for expected SAP/network failures.
 *
 * @param {string} businessObject
 * @param {{
 *   baseUrl?: string,
 *   username?: string,
 *   password?: string,
 *   timeoutMs?: number,
 *   cacheTtlMs?: number,
 *   skipCache?: boolean,
 *   fetchImpl?: typeof fetch,
 * }} [options]
 * @returns {Promise<SapMetadataResult>}
 */
export async function getBusinessObjectMetadata(businessObject, options = {}) {
  const config = readConfig(options);
  const normalized = normalizeBusinessObject(businessObject);

  if (!SUPPORTED_BUSINESS_OBJECTS.includes(normalized)) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_BUSINESS_OBJECT",
        message: `Unsupported business object '${businessObject}'. Expected one of: ${SUPPORTED_BUSINESS_OBJECTS.join(", ")}`,
      },
    };
  }

  if (!config.baseUrl || !config.username || !config.password) {
    return {
      ok: false,
      error: {
        code: "CONFIG",
        message:
          "SAP_ODATA_BASE_URL, SAP_ODATA_USERNAME, and SAP_ODATA_PASSWORD are required",
      },
    };
  }

  if (!options.skipCache) {
    const cached = metadataCache.get(normalized);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.payload, cached: true };
    }
  }

  const fetchImpl = options.fetchImpl || fetch;
  const authHeader = buildBasicAuthHeader(config.username, config.password);
  // authHeader intentionally never logged

  try {
    let lastBody = "";
    let lastContentType = "";
    let lastStatus = 0;

    // Prefer JSON; fall back to default (often XML) if JSON is rejected/unusable
    const attempts = [
      {
        url: buildMetadataUrl(config.baseUrl, normalized, { formatJson: true }),
        accept: "application/json",
      },
      {
        url: buildMetadataUrl(config.baseUrl, normalized, { formatJson: false }),
        accept: "application/xml, application/atom+xml, text/xml, */*",
      },
    ];

    let fields = null;

    for (const attempt of attempts) {
      console.log(
        `[sap-metadata] GET ${attempt.url} (Accept: ${attempt.accept})`,
      );
      const { response, bodyText } = await fetchMetadataOnce({
        url: attempt.url,
        authHeader,
        timeoutMs: config.timeoutMs,
        fetchImpl,
        accept: attempt.accept,
      });

      lastStatus = response.status;
      lastBody = bodyText;
      lastContentType = response.headers.get("content-type") || "";
      console.log(
        `[sap-metadata] ← HTTP ${response.status} content-type=${lastContentType || "-"} bytes=${bodyText.length}`,
      );

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          error: {
            code: "AUTH",
            message: "SAP metadata authentication failed",
            details: `HTTP ${response.status}`,
          },
        };
      }

      if (!response.ok) {
        // Try next attempt for 406/415/501 etc.; otherwise keep last error
        if ([406, 415, 501, 400].includes(response.status)) {
          continue;
        }
        return {
          ok: false,
          error: {
            code: "SAP_ERROR",
            message: `SAP metadata request failed (HTTP ${response.status})`,
            details: bodyText.slice(0, 300),
          },
        };
      }

      try {
        fields = parseMetadataBody(bodyText, lastContentType);
        break;
      } catch (parseErr) {
        // JSON attempt may return XML despite $format=json — try next
        if (parseErr?.code === "PARSE" || parseErr?.code === "EMPTY") {
          continue;
        }
        throw parseErr;
      }
    }

    if (!fields) {
      return {
        ok: false,
        error: {
          code: lastStatus && lastStatus >= 400 ? "SAP_ERROR" : "PARSE",
          message:
            "Could not parse SAP metadata as JSON or XML into field definitions",
          details: `HTTP ${lastStatus}; content-type=${lastContentType}; body=${lastBody.slice(0, 300)}`,
        },
      };
    }

    const resolved = resolveIdentifierColumns(normalized, fields);
    if (resolved.identifierColumns.length === 0) {
      console.warn(
        `[sap-metadata] no usable identifier columns for ${normalized} (SAP IsKey may only mark CLIENT)`,
      );
    } else {
      console.log(
        `[sap-metadata] identifiers for ${normalized}: ${resolved.identifierColumns.join(",")}`,
      );
    }

    const fetchedAt = new Date().toISOString();
    const payload = {
      ok: true,
      businessObject: normalized,
      fields: resolved.fields,
      identifierColumns: resolved.identifierColumns,
      fetchedAt,
    };

    metadataCache.set(normalized, {
      expiresAt: Date.now() + config.cacheTtlMs,
      payload,
    });

    return { ...payload, cached: false };
  } catch (err) {
    const message = err?.message || "SAP metadata request failed";
    const lower = String(message).toLowerCase();

    if (
      err?.name === "AbortError" ||
      lower.includes("timeout") ||
      lower.includes("aborted")
    ) {
      return {
        ok: false,
        error: {
          code: "TIMEOUT",
          message: "SAP metadata request timed out",
          details: message,
        },
      };
    }

    if (err?.code === "PARSE" || err?.code === "EMPTY") {
      return {
        ok: false,
        error: {
          code: err.code,
          message,
        },
      };
    }

    return {
      ok: false,
      error: {
        code: "NETWORK",
        message: "SAP metadata endpoint is unreachable or returned a network error",
        details: message,
      },
    };
  }
}

/** Test helper — clears the in-memory metadata cache. */
export function clearSapMetadataCache() {
  metadataCache.clear();
}
