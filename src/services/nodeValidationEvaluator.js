/**
 * Local/Node fallback for validation findings evaluation.
 * Mirrors the Python Lambda contract (findings only — no transforms).
 */

import { findLatestValidationRulesByBusinessObject } from "../models/validationRules.js";
import { buildPredefinedRulesForField } from "./commonRules.js";

const PREVIEW_ROW_LIMIT = 20;
const AFFECTED_SAMPLE_LIMIT = 25;

function norm(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function isEmpty(value) {
  return value == null || String(value).trim() === "";
}

function ruleText(rule) {
  return [
    rule?.ruleName,
    rule?.description,
    rule?.constraint,
    rule?.category,
    rule?.type,
    rule?.ruleId,
    rule?.source,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function collectColumns(rows) {
  const columns = [];
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row || {})) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

function resolveColumn(fieldName, columns) {
  const target = norm(fieldName);
  const byNorm = new Map(columns.map((c) => [norm(c), c]));
  if (byNorm.has(target)) return byNorm.get(target);
  for (const [n, col] of byNorm) {
    if (n.includes(target) || target.includes(n)) return col;
  }
  return null;
}

/** Primary key only when validation_rules field has key = "X". */
function fieldKeyFlag(field) {
  const raw = field?.key ?? field?.metadata?.key ?? "";
  return String(raw).toUpperCase() === "X" ? "X" : "";
}

function extractFields(rulesPayload) {
  if (!rulesPayload) return [];
  if (Array.isArray(rulesPayload.fields)) return rulesPayload.fields;
  if (rulesPayload.rules && Array.isArray(rulesPayload.rules.fields)) {
    return rulesPayload.rules.fields;
  }
  return [];
}

function mergeFields(fields) {
  const byName = new Map();
  for (const field of fields || []) {
    const name = String(field?.fieldName || "").trim();
    if (!name) continue;
    byName.set(norm(name), {
      fieldName: name,
      key: fieldKeyFlag(field),
      rules: Array.isArray(field.rules) ? [...field.rules] : [],
    });
  }

  return [...byName.values()].map((field) => {
    const names = new Set(
      field.rules.map((r) => String(r.ruleName || "").toLowerCase()),
    );
    const ids = new Set(field.rules.map((r) => String(r.ruleId || "")));
    // Drop any duplicate rules on non-key fields — uniqueness is key=X only
    let rules =
      field.key === "X"
        ? [...field.rules]
        : field.rules.filter((r) => {
            const text = ruleText(r);
            return !(
              text.includes("duplicate") ||
              r?.ruleId === "COMMON-DUPLICATE" ||
              r?.constraint === "UNIQUE_REQUIRED" ||
              r?.constraint === "FLAG_DUPLICATES"
            );
          });

    for (const pre of buildPredefinedRulesForField({
      fieldName: field.fieldName,
      key: field.key,
    })) {
      if (pre.ruleId === "COMMON-TRIM") continue;
      // Duplicate Check only for primary keys (key = "X")
      if (pre.ruleId === "COMMON-DUPLICATE" && field.key !== "X") continue;
      if (ids.has(pre.ruleId) || names.has(pre.ruleName.toLowerCase())) continue;
      rules.push(pre);
    }
    return { fieldName: field.fieldName, key: field.key, rules };
  });
}

function duplicateRows(rows, column) {
  const groups = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const raw = rows[i]?.[column];
    if (isEmpty(raw)) continue;
    const value = String(raw).trim();
    const key = value.toUpperCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row: i + 1, value });
  }

  const affected = [];
  const samples = [];
  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    for (const entry of entries) {
      affected.push(entry.row);
      if (samples.length < 8) {
        samples.push({
          row: entry.row,
          value: entry.value,
          reason: `Duplicate key value "${entry.value}" appears ${entries.length} times`,
        });
      }
    }
  }
  affected.sort((a, b) => a - b);
  return { affected, samples };
}

function checkValue(rule, value) {
  const text = ruleText(rule);
  const empty = isEmpty(value);
  const s = empty ? "" : String(value).trim();

  if (text.includes("duplicate")) return { violated: false };

  if (
    text.includes("null/empty") ||
    text.includes("null check") ||
    rule?.constraint === "NOT_NULL_OR_EMPTY" ||
    rule?.constraint === "FLAG_NULL_OR_EMPTY" ||
    rule?.ruleId === "COMMON-NULL-EMPTY"
  ) {
    if (empty) return { violated: true, reason: "Value is null/empty" };
    return { violated: false };
  }

  const lengthMatch = text.match(/(\d+)\s*characters?\s*or\s*less/);
  if (lengthMatch && !empty && s.length > Number(lengthMatch[1])) {
    return {
      violated: true,
      reason: `Length ${s.length} exceeds max ${lengthMatch[1]}`,
    };
  }

  if (text.includes("leading zero") && !empty && /^0+\d/.test(s)) {
    return { violated: true, reason: "Value has leading zeros" };
  }

  if (
    (text.includes("greater than or equal to zero") ||
      text.includes("greater than or equal to 0")) &&
    !empty
  ) {
    const n = Number(String(s).replace(/,/g, ""));
    if (!Number.isFinite(n)) return { violated: true, reason: "Value is not numeric" };
    if (n < 0) return { violated: true, reason: `Value ${n} is less than zero` };
  }

  if (
    (text.includes("domain") ||
      String(rule?.category || "").toLowerCase() === "domain") &&
    String(rule?.severity || "").toLowerCase() === "error" &&
    empty
  ) {
    return { violated: true, reason: "Domain value is empty" };
  }

  return { violated: false };
}

function evaluate(rows, rulesPayload, businessObject) {
  const columns = collectColumns(rows);
  const fields = mergeFields(extractFields(rulesPayload));
  const findings = [];
  const fieldGroupsMap = new Map();

  for (const field of fields) {
    const fieldName = field.fieldName;
    const column = resolveColumn(fieldName, columns);
    if (!column) continue;

    for (const rule of field.rules || []) {
      const text = ruleText(rule);
      const severity =
        String(rule.severity || "error").toLowerCase() === "warning"
          ? "warning"
          : "error";

      let finding;
      if (text.includes("duplicate") || rule.ruleId === "COMMON-DUPLICATE") {
        // Duplicate Check is only for primary keys (key = "X")
        if (field.key !== "X") continue;
        const { affected, samples } = duplicateRows(rows, column);
        if (!affected.length) continue;
        finding = {
          fieldName,
          matchedColumn: column,
          ruleName: rule.ruleName || "Duplicate Check",
          ruleViolated: rule.ruleName || "Duplicate Check",
          severity,
          affectedCount: affected.length,
          affectedRows: affected.slice(0, AFFECTED_SAMPLE_LIMIT),
          sampleValues: samples,
          issue: samples[0]?.reason || "Duplicate values found",
          summary:
            field.key === "X"
              ? `${fieldName} has duplicate values in ${affected.length} rows — primary key fields must be unique in the preload file.`
              : `${fieldName} has duplicate values in ${affected.length} rows.`,
          rule: {
            ruleName: rule.ruleName,
            source: rule.source,
            description: rule.description,
            constraint: rule.constraint,
            severity: rule.severity,
            category: rule.category || "uniqueness",
          },
        };
      } else {
        const affectedRows = [];
        const samples = [];
        for (let i = 0; i < rows.length; i += 1) {
          const result = checkValue(rule, rows[i]?.[column]);
          if (!result.violated) continue;
          const rowNum = i + 1;
          affectedRows.push(rowNum);
          if (samples.length < 8) {
            samples.push({
              row: rowNum,
              value:
                rows[i]?.[column] == null ? null : String(rows[i][column]),
              reason: result.reason,
            });
          }
        }
        if (!affectedRows.length) continue;
        finding = {
          fieldName,
          matchedColumn: column,
          ruleName: rule.ruleName || "Unnamed rule",
          ruleViolated: rule.ruleName || "Unnamed rule",
          severity,
          affectedCount: affectedRows.length,
          affectedRows: affectedRows.slice(0, AFFECTED_SAMPLE_LIMIT),
          sampleValues: samples,
          issue: samples[0]?.reason || "Rule violated",
          summary: `${fieldName}: ${samples[0]?.reason || "rule violated"} in ${affectedRows.length} row(s) — ${rule.description || rule.constraint || "see validation rule"}.`,
          rule: {
            ruleName: rule.ruleName,
            source: rule.source,
            description: rule.description,
            constraint: rule.constraint,
            severity: rule.severity,
            category: rule.category,
          },
        };
      }

      findings.push(finding);
      if (!fieldGroupsMap.has(fieldName)) {
        fieldGroupsMap.set(fieldName, {
          fieldName,
          errorCount: 0,
          warningCount: 0,
          findingCount: 0,
          findings: [],
        });
      }
      const group = fieldGroupsMap.get(fieldName);
      group.findings.push({
        ruleName: finding.ruleName,
        severity: finding.severity,
        affectedCount: finding.affectedCount,
        affectedRowsSample: finding.affectedRows,
        affectedRowsLabel: finding.affectedRows.length
          ? `Rows ${finding.affectedRows.slice(0, 5).join(", ")}`
          : "",
        summary: finding.summary,
        whatToCorrect: finding.issue,
        rule: finding.rule,
      });
      group.findingCount += 1;
      if (finding.severity === "warning") {
        group.warningCount += finding.affectedCount;
      } else {
        group.errorCount += finding.affectedCount;
      }
    }
  }

  const fieldGroups = [...fieldGroupsMap.values()].sort(
    (a, b) => b.errorCount - a.errorCount || b.warningCount - a.warningCount,
  );

  return {
    summary: {
      totalRows: rows.length,
      fieldsChecked: fields.length,
      rulesChecked: fields.reduce((n, f) => n + (f.rules?.length || 0), 0),
      violationCount: findings.length,
      errorCount: findings
        .filter((f) => f.severity === "error")
        .reduce((n, f) => n + f.affectedCount, 0),
      warningCount: findings
        .filter((f) => f.severity === "warning")
        .reduce((n, f) => n + f.affectedCount, 0),
    },
    findings,
    report: {
      headline: findings.length
        ? `Found ${findings.length} rule issue(s) across ${fieldGroups.length} field(s).`
        : "No validation issues were found in the uploaded preload file.",
      businessObject,
      fieldGroups,
    },
    previewRows: rows.slice(0, PREVIEW_ROW_LIMIT),
  };
}

export async function runValidationRulesLocalNode({ businessObject, rows }) {
  const ruleSet = await findLatestValidationRulesByBusinessObject(
    businessObject,
  );
  if (!ruleSet) {
    const err = new Error(
      `No saved validation rules found for business object '${businessObject}'`,
    );
    err.status = 404;
    throw err;
  }

  const evaluation = evaluate(rows, ruleSet.rules, businessObject);
  return {
    ok: true,
    businessObject,
    ruleSet: {
      id: ruleSet.id,
      business_object: ruleSet.business_object,
      created_at: ruleSet.created_at,
    },
    ...evaluation,
  };
}
