/**
 * SAP ABAP type checks used during preload validation (DATS, TIMS, lengths).
 */

export const COMMON_TYPE_RULE_IDS = {
  DATS_FORMAT: "COMMON-DATS-FORMAT",
  TIMS_FORMAT: "COMMON-TIMS-FORMAT",
  FIELD_LENGTH: "COMMON-FIELD-LENGTH",
};

/** Common SAP date fields when dataType was not persisted with the ruleset. */
const INFERRED_DATS_FIELDS = new Set([
  "BEDAT",
  "AEDAT",
  "BUDAT",
  "BLDAT",
  "EINDT",
  "DATUM",
  "ERDAT",
  "LAEDA",
  "CPUDT",
  "BEGDA",
  "ENDDA",
  "GSTRP",
  "GLTRP",
  "FKDAT",
  "BILLDATE",
  "VALUT",
  "AUGDT",
]);

export function normalizeSapDataType(dataType) {
  return String(dataType ?? "")
    .trim()
    .toUpperCase();
}

export function resolveFieldDataType(field) {
  const explicit = normalizeSapDataType(
    field?.dataType ?? field?.metadata?.dataType,
  );
  if (explicit) return explicit;

  const name = String(field?.fieldName ?? "")
    .trim()
    .toUpperCase();
  if (INFERRED_DATS_FIELDS.has(name)) return "DATS";
  return "";
}

export function resolveFieldLength(field) {
  const raw = field?.length ?? field?.metadata?.length;
  if (raw === "" || raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function buildTypeRulesForField(field) {
  const dataType = resolveFieldDataType(field);
  const length = resolveFieldLength(field);
  const rules = [];

  if (dataType === "DATS") {
    rules.push({
      ruleName: "SAP DATS Format Check",
      source: "PREDEFINED",
      ruleId: COMMON_TYPE_RULE_IDS.DATS_FORMAT,
      type: "validation",
      description:
        "Date must be in SAP DATS format YYYYMMDD (8 numeric digits, valid calendar date).",
      constraint: "SAP_DATS_YYYYMMDD",
      severity: "error",
      category: "format",
    });
  }

  if (dataType === "TIMS") {
    rules.push({
      ruleName: "SAP TIMS Format Check",
      source: "PREDEFINED",
      ruleId: COMMON_TYPE_RULE_IDS.TIMS_FORMAT,
      type: "validation",
      description:
        "Time must be in SAP TIMS format HHMMSS (6 numeric digits, valid time).",
      constraint: "SAP_TIMS_HHMMSS",
      severity: "error",
      category: "format",
    });
  }

  if (length != null && dataType !== "DATS" && dataType !== "TIMS") {
    rules.push({
      ruleName: "Field Length Check",
      source: "PREDEFINED",
      ruleId: COMMON_TYPE_RULE_IDS.FIELD_LENGTH,
      type: "validation",
      description: `Value must not exceed ${length} characters for SAP type ${dataType || "CHAR"}.`,
      constraint: `MAX_LENGTH_${length}`,
      severity: "warning",
      category: "format",
      maxLength: length,
    });
  }

  return rules;
}

function isEmpty(value) {
  return value == null || String(value).trim() === "";
}

export function validateSapDats(value) {
  if (isEmpty(value)) return { violated: false };

  const raw = String(value).trim();
  if (/[-/.]/.test(raw)) {
    return {
      violated: true,
      reason: `Value "${raw}" is not in SAP DATS format (use YYYYMMDD, e.g. 20260801)`,
    };
  }

  const digits = raw.replace(/\s/g, "");
  if (!/^\d+$/.test(digits)) {
    return {
      violated: true,
      reason: `Value "${raw}" must contain only digits for SAP DATS`,
    };
  }

  if (digits.length !== 8) {
    return {
      violated: true,
      reason: `Value "${raw}" must be exactly 8 digits (YYYYMMDD); found ${digits.length}`,
    };
  }

  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;

  if (!valid) {
    return {
      violated: true,
      reason: `Value "${digits}" is not a valid calendar date`,
    };
  }

  return { violated: false, parsedDate: date };
}

export function validateSapTims(value) {
  if (isEmpty(value)) return { violated: false };

  const raw = String(value).trim().replace(/:/g, "");
  if (!/^\d{6}$/.test(raw)) {
    return {
      violated: true,
      reason: `Value "${String(value).trim()}" must be 6 digits (HHMMSS) for SAP TIMS`,
    };
  }

  const hours = Number(raw.slice(0, 2));
  const minutes = Number(raw.slice(2, 4));
  const seconds = Number(raw.slice(4, 6));
  if (hours > 23 || minutes > 59 || seconds > 59) {
    return {
      violated: true,
      reason: `Value "${raw}" is not a valid time (HHMMSS)`,
    };
  }

  return { violated: false };
}

function parseFlexibleDate(value) {
  const raw = String(value).trim();
  if (!raw) return null;

  const dats = validateSapDats(raw);
  if (!dats.violated && dats.parsedDate) return dats.parsedDate;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const date = new Date(
      Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])),
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const dmy = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmy) {
    const date = new Date(
      Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])),
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const mdy = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (mdy) {
    const date = new Date(
      Date.UTC(Number(mdy[3]), Number(mdy[1]) - 1, Number(mdy[2])),
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

export function validateDateNotInFuture(value) {
  if (isEmpty(value)) return { violated: false };

  const parsed = parseFlexibleDate(value);
  if (!parsed) {
    return {
      violated: true,
      reason: `Value "${String(value).trim()}" could not be parsed as a date`,
    };
  }

  const today = new Date();
  const todayUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  const valueUtc = Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth(),
    parsed.getUTCDate(),
  );

  if (valueUtc > todayUtc) {
    return {
      violated: true,
      reason: `Date ${String(value).trim()} is in the future`,
    };
  }

  return { violated: false };
}

export function checkSapTypeRule(rule, value, field) {
  const ruleId = String(rule?.ruleId || "");
  const dataType = resolveFieldDataType(field);

  if (
    ruleId === COMMON_TYPE_RULE_IDS.DATS_FORMAT ||
    rule?.constraint === "SAP_DATS_YYYYMMDD" ||
    (dataType === "DATS" && String(rule?.ruleName || "").toLowerCase().includes("dats"))
  ) {
    return validateSapDats(value);
  }

  if (
    ruleId === COMMON_TYPE_RULE_IDS.TIMS_FORMAT ||
    rule?.constraint === "SAP_TIMS_HHMMSS"
  ) {
    return validateSapTims(value);
  }

  if (ruleId === COMMON_TYPE_RULE_IDS.FIELD_LENGTH) {
    const max =
      Number(rule?.maxLength) ||
      Number(String(rule?.constraint || "").match(/(\d+)/)?.[1]);
    if (!max || isEmpty(value)) return { violated: false };
    const len = String(value).trim().length;
    if (len > max) {
      return {
        violated: true,
        reason: `Length ${len} exceeds max ${max} for field type ${dataType || "CHAR"}`,
      };
    }
    return { violated: false };
  }

  return null;
}

export function checkDateRelatedRule(rule, value) {
  const text = [
    rule?.ruleName,
    rule?.description,
    rule?.constraint,
    rule?.category,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    text.includes("not in future") ||
    text.includes("not in the future") ||
    text.includes("future date") ||
    (text.includes("future") && text.includes("date"))
  ) {
    return validateDateNotInFuture(value);
  }

  if (
    text.includes("yyyy-mm-dd") ||
    text.includes("yyyymmdd") ||
    (text.includes("date") &&
      text.includes("format") &&
      !text.includes("not in future"))
  ) {
    const dats = validateSapDats(value);
    if (dats.violated) {
      return {
        violated: true,
        reason: dats.reason,
      };
    }
    return { violated: false };
  }

  return null;
}
