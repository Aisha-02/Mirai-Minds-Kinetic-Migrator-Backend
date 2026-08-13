/**
 * Evaluates validation rules against preload rows.
 * - Applies stored AI rules from validation_rules
 * - Also applies application predefined checks (null/empty + duplicate)
 * - Primary keys come only from stored field.key === "X" (not name heuristics)
 */

import {
  buildPredefinedRulesForField,
  COMMON_RULE_IDS,
  RULE_SOURCE,
} from "./commonRules.js";

const MAX_AFFECTED_ROWS_SAMPLE = 25;
const MAX_SAMPLE_VALUES = 8;

function normalizeKey(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function isEmpty(value) {
  return value == null || String(value).trim() === "";
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "").trim();
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function buildColumnIndex(rows) {
  const columns = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row || {})) {
      columns.add(key);
    }
  }
  const list = [...columns];
  const byNorm = new Map();
  for (const col of list) {
    byNorm.set(normalizeKey(col), col);
  }
  return { columns: list, byNorm };
}

function resolveColumn(fieldName, columnIndex) {
  const exact = columnIndex.byNorm.get(normalizeKey(fieldName));
  if (exact) return exact;

  const target = normalizeKey(fieldName);
  for (const [norm, col] of columnIndex.byNorm) {
    if (norm.includes(target) || target.includes(norm)) {
      return col;
    }
  }
  return null;
}

function ruleText(rule) {
  return [
    rule?.ruleName,
    rule?.description,
    rule?.constraint,
    rule?.category,
    rule?.type,
    rule?.ruleId,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function fieldKeyFlag(field) {
  const raw = field?.key ?? field?.metadata?.key ?? "";
  return String(raw).toUpperCase() === "X" ? "X" : "";
}

function isDuplicateRule(rule) {
  const text = ruleText(rule);
  return (
    text.includes("duplicate") ||
    rule?.ruleId === COMMON_RULE_IDS.DUPLICATE ||
    rule?.constraint === "UNIQUE_REQUIRED" ||
    rule?.constraint === "FLAG_DUPLICATES"
  );
}

function isNullEmptyRule(rule) {
  const text = ruleText(rule);
  return (
    text.includes("null/empty") ||
    text.includes("null check") ||
    rule?.ruleId === COMMON_RULE_IDS.NULL_EMPTY ||
    rule?.constraint === "NOT_NULL_OR_EMPTY" ||
    rule?.constraint === "FLAG_NULL_OR_EMPTY"
  );
}

function isTrimRule(rule) {
  const text = ruleText(rule);
  return text.includes("trim whitespace") || rule?.ruleId === COMMON_RULE_IDS.TRIM;
}

/**
 * Deterministic checks derived from AI / predefined rule text.
 */
function checkValueAgainstRule(rule, value, row, fieldName, columnIndex) {
  const text = ruleText(rule);
  const empty = isEmpty(value);
  const str = empty ? "" : String(value).trim();

  if (isNullEmptyRule(rule)) {
    if (empty) {
      return { violated: true, reason: "Value is null/empty" };
    }
    return { violated: false };
  }

  if (isTrimRule(rule)) {
    if (!empty && String(value) !== String(value).trim()) {
      return {
        violated: true,
        reason: "Value has leading or trailing whitespace",
      };
    }
    return { violated: false };
  }

  if (
    text.includes("must not be empty") ||
    text.includes("should not be empty") ||
    (text.includes("required") && !text.includes("characters"))
  ) {
    if (empty) {
      return { violated: true, reason: "Value is null/empty" };
    }
  }

  const lengthMatch = text.match(/(\d+)\s*characters?\s*or\s*less/);
  if (lengthMatch && !empty) {
    const max = Number(lengthMatch[1]);
    if (str.length > max) {
      return {
        violated: true,
        reason: `Length ${str.length} exceeds max ${max}`,
      };
    }
  }

  if (
    (text.includes("leading zero") || text.includes("leading zeros")) &&
    !empty
  ) {
    if (/^0+\d/.test(str)) {
      return { violated: true, reason: "Value has leading zeros" };
    }
  }

  if (
    text.includes("start with a letter or a number") ||
    text.includes("start with letter or number")
  ) {
    if (!empty && !/^[A-Za-z0-9]/.test(str)) {
      return {
        violated: true,
        reason: "Value must start with a letter or number",
      };
    }
  }

  if (
    text.includes("greater than or equal to zero") ||
    text.includes("greater than or equal to 0") ||
    (text.includes("range") && text.includes("zero"))
  ) {
    if (!empty) {
      const n = toNumber(str);
      if (n == null) {
        return { violated: true, reason: "Value is not numeric" };
      }
      if (n < 0) {
        return { violated: true, reason: `Value ${n} is less than zero` };
      }
    }
  }

  if (
    text.includes("vs net") ||
    text.includes("gross weight should be greater than or equal to net") ||
    (text.includes("gross") && text.includes("net weight"))
  ) {
    const netCol =
      resolveColumn("NET_WEIGHT", columnIndex) ||
      resolveColumn("NET WEIGHT", columnIndex);
    if (netCol) {
      const gross = toNumber(value);
      const net = toNumber(row?.[netCol]);
      if (gross != null && net != null && gross < net) {
        return {
          violated: true,
          reason: `Gross (${gross}) is less than net (${net})`,
        };
      }
    }
  }

  if (
    (text.includes("domain") ||
      String(rule?.category || "").toLowerCase() === "domain") &&
    String(rule?.severity || "").toLowerCase() === "error" &&
    empty
  ) {
    return {
      violated: true,
      reason: "Domain value is empty (SAP domain lookup not available)",
    };
  }

  if (
    String(rule?.category || "").toLowerCase() === "format" &&
    String(rule?.severity || "").toLowerCase() === "error" &&
    empty
  ) {
    return { violated: true, reason: "Required format field is empty" };
  }

  return { violated: false };
}

function extractFields(rulesPayload) {
  if (!rulesPayload) return [];
  if (Array.isArray(rulesPayload.fields)) return rulesPayload.fields;
  if (rulesPayload.rules && Array.isArray(rulesPayload.rules.fields)) {
    return rulesPayload.rules.fields;
  }
  return [];
}

function extractBusinessObject(rulesPayload) {
  return (
    rulesPayload?.businessObject ||
    rulesPayload?.business_object ||
    rulesPayload?.rules?.businessObject ||
    null
  );
}

function hasRule(rules, predicate) {
  return (rules || []).some(predicate);
}

/**
 * Merge AI rules with predefined Null / Duplicate checks.
 * Duplicate Check is injected only when field.key === "X".
 */
function enrichFieldsWithPredefined(fields) {
  const byName = new Map();

  for (const field of fields || []) {
    const fieldName = String(field?.fieldName || "").trim();
    if (!fieldName) continue;
    const key = fieldKeyFlag(field);
    let rules = Array.isArray(field.rules) ? [...field.rules] : [];
    if (key !== "X") {
      rules = rules.filter((r) => !isDuplicateRule(r));
    }
    byName.set(normalizeKey(fieldName), {
      fieldName,
      key,
      rules,
    });
  }

  return [...byName.values()].map((field) => {
    const isKey = field.key === "X";
    const predefined = buildPredefinedRulesForField({
      fieldName: field.fieldName,
      key: field.key,
    }).filter((rule) => {
      if (rule.ruleId === COMMON_RULE_IDS.TRIM) return false;
      if (rule.ruleId === COMMON_RULE_IDS.DUPLICATE && !isKey) return false;
      return true;
    });

    const merged = [...field.rules];
    for (const rule of predefined) {
      const already = hasRule(merged, (existing) => {
        if (existing.ruleId && rule.ruleId && existing.ruleId === rule.ruleId) {
          return true;
        }
        return (
          String(existing.ruleName || "").toLowerCase() ===
          String(rule.ruleName || "").toLowerCase()
        );
      });
      if (!already) merged.push(rule);
    }

    return { ...field, rules: merged, _isKey: isKey };
  });
}

function collectDuplicateRowNumbers(data, column) {
  const groups = new Map();
  for (let i = 0; i < data.length; i += 1) {
    const raw = data[i]?.[column];
    if (isEmpty(raw)) continue;
    const key = String(raw).trim().toUpperCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ rowNumber: i + 1, value: String(raw).trim() });
  }

  const affected = [];
  const samples = [];
  for (const [, entries] of groups) {
    if (entries.length < 2) continue;
    for (const entry of entries) {
      affected.push(entry.rowNumber);
      if (samples.length < MAX_SAMPLE_VALUES) {
        samples.push({
          row: entry.rowNumber,
          value: entry.value,
          reason: `Duplicate key value "${entry.value}" appears ${entries.length} times`,
        });
      }
    }
  }

  affected.sort((a, b) => a - b);
  return { affectedRowNumbers: affected, samples };
}

function pushFinding(findings, payload) {
  findings.push(payload);
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {{ businessObject?: string, fields?: Array<{ fieldName: string, rules: object[] }> }} rulesPayload
 */
export function evaluateValidationRules(rows, rulesPayload) {
  const data = Array.isArray(rows) ? rows : [];
  const businessObject = extractBusinessObject(rulesPayload);
  const columnIndex = buildColumnIndex(data);
  const fields = enrichFieldsWithPredefined(extractFields(rulesPayload));
  const findings = [];
  const unmatchedFields = [];
  let rulesChecked = 0;

  for (const field of fields) {
    const fieldName = String(field?.fieldName || "").trim();
    if (!fieldName) continue;

    const column = resolveColumn(fieldName, columnIndex);
    if (!column) {
      unmatchedFields.push(fieldName);
      continue;
    }

    const fieldRules = Array.isArray(field.rules) ? field.rules : [];
    for (const rule of fieldRules) {
      rulesChecked += 1;

      if (isDuplicateRule(rule)) {
        // Duplicate Check only for primary keys (key = "X")
        if (field.key !== "X" && !field._isKey) continue;
        const { affectedRowNumbers, samples } = collectDuplicateRowNumbers(
          data,
          column,
        );
        if (affectedRowNumbers.length === 0) continue;

        const severity =
          String(rule.severity || "error").toLowerCase() === "warning"
            ? "warning"
            : "error";

        pushFinding(findings, {
          fieldName,
          matchedColumn: column,
          ruleName: rule.ruleName || "Duplicate Check",
          ruleViolated: rule.ruleName || "Duplicate Check",
          severity,
          affectedCount: affectedRowNumbers.length,
          affectedRows: affectedRowNumbers.slice(0, MAX_AFFECTED_ROWS_SAMPLE),
          sampleValues: samples,
          issue:
            samples[0]?.reason ||
            "Duplicate values found for this field",
          rule: {
            ruleName: rule.ruleName,
            source: rule.source || RULE_SOURCE.PREDEFINED,
            type: rule.type,
            description: rule.description,
            constraint: rule.constraint,
            severity: rule.severity,
            category: rule.category || "uniqueness",
            ruleId: rule.ruleId,
          },
        });
        continue;
      }

      const affectedRows = [];
      const sampleValues = [];
      let affectedCount = 0;

      for (let i = 0; i < data.length; i += 1) {
        const row = data[i];
        const value = row?.[column];
        const result = checkValueAgainstRule(
          rule,
          value,
          row,
          fieldName,
          columnIndex,
        );
        if (!result.violated) continue;

        affectedCount += 1;
        const rowNumber = i + 1;
        if (affectedRows.length < MAX_AFFECTED_ROWS_SAMPLE) {
          affectedRows.push(rowNumber);
        }
        if (sampleValues.length < MAX_SAMPLE_VALUES) {
          sampleValues.push({
            row: rowNumber,
            value: value == null ? null : String(value),
            reason: result.reason,
          });
        }
      }

      if (affectedCount === 0) continue;

      const severity =
        String(rule.severity || "error").toLowerCase() === "warning"
          ? "warning"
          : "error";

      pushFinding(findings, {
        fieldName,
        matchedColumn: column,
        ruleName: rule.ruleName || "Unnamed rule",
        ruleViolated: rule.ruleName || "Unnamed rule",
        severity,
        affectedCount,
        affectedRows,
        sampleValues,
        issue:
          sampleValues[0]?.reason ||
          rule.description ||
          rule.constraint ||
          "Rule violated",
        rule: {
          ruleName: rule.ruleName,
          source: rule.source,
          type: rule.type,
          description: rule.description,
          constraint: rule.constraint,
          severity: rule.severity,
          category: rule.category,
          ruleId: rule.ruleId,
        },
      });
    }
  }

  const errorCount = findings
    .filter((f) => f.severity === "error")
    .reduce((sum, f) => sum + f.affectedCount, 0);
  const warningCount = findings
    .filter((f) => f.severity === "warning")
    .reduce((sum, f) => sum + f.affectedCount, 0);

  return {
    findings,
    summary: {
      totalRows: data.length,
      fieldsChecked: fields.length - unmatchedFields.length,
      rulesChecked,
      violationCount: findings.length,
      errorCount,
      warningCount,
      unmatchedFields,
    },
  };
}
