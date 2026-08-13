/**
 * Deterministic transforms derived from fetched validation rule definitions.
 * Does not invent new business logic beyond the rule constraint/description.
 */

import crypto from "crypto";
import { resolveFieldColumn } from "../constants/fieldColumnAliases.js";

function normalizeKey(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
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

function resolveColumn(fieldName, rows) {
  if (!rows.length) return null;
  const columns = Object.keys(rows[0] || {});
  return resolveFieldColumn(fieldName, columns);
}

function isEmpty(value) {
  return value == null || String(value).trim() === "";
}

function normalizeDatsValue(value) {
  if (isEmpty(value)) return value;
  const raw = String(value).trim();

  if (/^\d{8}$/.test(raw.replace(/\s/g, ""))) {
    return raw.replace(/\s/g, "");
  }

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return `${iso[1]}${iso[2]}${iso[3]}`;
  }

  const dmy = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmy) {
    return `${dmy[3]}${dmy[2]}${dmy[1]}`;
  }

  const mdy = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (mdy) {
    return `${mdy[3]}${mdy[1]}${mdy[2]}`;
  }

  const digits = raw.replace(/\D/g, "");
  if (digits.length === 8) return digits;
  if (digits.length === 7) return digits.padStart(8, "0");
  return raw;
}

/**
 * Infer a transform plan from a finding's rule text.
 * @returns {{ type: string, params?: object, label: string } | null}
 */
export function inferTransformFromRule(finding) {
  const rule = finding?.rule || finding;
  const text = ruleText(rule);
  const lengthMatch = text.match(/(\d+)\s*characters?\s*(?:or\s*less|long)/);
  const maxLengthMatch = text.match(/max(?:imum)?\s*length\s*(\d+)/i);

  if (
    text.includes("duplicate") ||
    rule?.ruleId === "COMMON-DUPLICATE" ||
    rule?.constraint === "UNIQUE_REQUIRED"
  ) {
    return {
      type: "remove_duplicate_rows",
      label: "Remove duplicate rows (keep first occurrence per key value)",
    };
  }

  if (
    text.includes("dats") ||
    rule?.ruleId === "COMMON-DATS-FORMAT" ||
    rule?.constraint === "SAP_DATS_YYYYMMDD" ||
    (text.includes("yyyymmdd") && text.includes("date"))
  ) {
    return {
      type: "normalize_dats",
      label: "Normalize date to SAP DATS format (YYYYMMDD)",
    };
  }

  if (text.includes("trim") || rule?.ruleId === "COMMON-TRIM") {
    return {
      type: "trim_whitespace",
      label: "Trim leading and trailing whitespace",
    };
  }

  if (text.includes("uppercase") || text.includes("upper case")) {
    return {
      type: "to_uppercase",
      label: "Convert value to uppercase (per format rule)",
    };
  }

  if (text.includes("leading zero")) {
    return {
      type: "strip_leading_zeros",
      label: "Strip leading zeros (per rule)",
    };
  }

  if (
    rule?.ruleId === "COMMON-FIELD-LENGTH" ||
    rule?.constraint?.startsWith("MAX_LENGTH_")
  ) {
    const max =
      Number(rule?.maxLength) ||
      Number(String(rule?.constraint || "").match(/(\d+)/)?.[1]);
    if (max) {
      return {
        type: "fit_length",
        params: { max },
        label: `Fit to max length ${max} (pad with leading zeros if shorter; trim if longer)`,
      };
    }
  }

  if (lengthMatch) {
    const max = Number(lengthMatch[1]);
    return {
      type: "fit_length",
      params: { max },
      label: `Fit to max length ${max} (pad with leading zeros if shorter; trim if longer)`,
    };
  }

  if (maxLengthMatch) {
    const max = Number(maxLengthMatch[1]);
    return {
      type: "fit_length",
      params: { max },
      label: `Fit to max length ${max}`,
    };
  }

  if (
    text.includes("greater than or equal to zero") ||
    text.includes("greater than or equal to 0") ||
    (text.includes("range") && text.includes("zero")) ||
    text.includes("non-negative")
  ) {
    return {
      type: "clamp_min_zero",
      label: "Set negative values to 0 (per range rule)",
    };
  }

  if (
    text.includes("gross") &&
    (text.includes("net") || text.includes("greater than or equal"))
  ) {
    return {
      type: "gross_gte_net",
      params: { netFieldHints: ["NET_WEIGHT", "NET WEIGHT", "NETWT", "NTGEW"] },
      label: "Raise gross weight to at least net weight (per consistency rule)",
    };
  }

  if (
    text.includes("start with a letter or a number") ||
    text.includes("start with letter or number")
  ) {
    return {
      type: "strip_invalid_prefix",
      label: "Remove leading non-alphanumeric characters (per format rule)",
    };
  }

  if (text.includes("decimal places") || text.includes("precision")) {
    const precisionMatch = text.match(/(\d+)\s*decimal/);
    if (precisionMatch) {
      return {
        type: "round_precision",
        params: { decimals: Number(precisionMatch[1]) },
        label: `Round to ${precisionMatch[1]} decimal places`,
      };
    }
  }

  return null;
}

function applyValueTransform(type, params, value, row) {
  const empty = value == null || String(value).trim() === "";

  switch (type) {
    case "normalize_dats": {
      if (empty) return value;
      return normalizeDatsValue(value);
    }
    case "trim_whitespace": {
      if (empty) return value;
      return String(value).trim();
    }
    case "to_uppercase": {
      if (empty) return value;
      return String(value).trim().toUpperCase();
    }
    case "strip_leading_zeros": {
      if (empty) return value;
      const str = String(value).trim();
      const stripped = str.replace(/^0+(?=\d)/, "");
      return stripped === "" ? "0" : stripped;
    }
    case "fit_length": {
      if (empty) return value;
      const max = Number(params?.max) || 18;
      let str = String(value).trim();
      if (/^\d+$/.test(str)) {
        if (str.length < max) str = str.padStart(max, "0");
        if (str.length > max) str = str.slice(-max);
        return str;
      }
      if (str.length > max) return str.slice(0, max);
      return str;
    }
    case "clamp_min_zero": {
      if (empty) return value;
      const n = toNumber(value);
      if (n == null) return value;
      return n < 0 ? 0 : n;
    }
    case "round_precision": {
      if (empty) return value;
      const n = toNumber(value);
      if (n == null) return value;
      const decimals = Number(params?.decimals) || 2;
      return Number(n.toFixed(decimals));
    }
    case "gross_gte_net": {
      const hints = params?.netFieldHints || ["NET_WEIGHT"];
      let netCol = null;
      for (const hint of hints) {
        const target = normalizeKey(hint);
        for (const col of Object.keys(row || {})) {
          if (
            normalizeKey(col) === target ||
            normalizeKey(col).includes(target)
          ) {
            netCol = col;
            break;
          }
        }
        if (netCol) break;
      }
      const gross = toNumber(value);
      const net = netCol ? toNumber(row[netCol]) : null;
      if (gross == null || net == null) return value;
      return gross < net ? net : gross;
    }
    case "strip_invalid_prefix": {
      if (empty) return value;
      return String(value).trim().replace(/^[^A-Za-z0-9]+/, "");
    }
    default:
      return value;
  }
}

function applyDuplicateRowFix(rows, column) {
  const seen = new Set();
  const result = [];

  for (const row of rows) {
    const raw = row?.[column];
    if (isEmpty(raw)) {
      result.push(row);
      continue;
    }
    const key = String(raw).trim().toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }

  return result;
}

/**
 * Build a preview proposal for a matched finding against current rows.
 */
export function buildFixProposal(finding, rows) {
  const transform = inferTransformFromRule(finding);
  if (!transform) {
    return {
      ok: false,
      error:
        "This rule cannot be auto-fixed with the current rule definition (no safe transform mapping).",
    };
  }

  const column =
    finding.matchedColumn || resolveColumn(finding.fieldName, rows);

  if (!column) {
    return {
      ok: false,
      error: `Could not find column for field ${finding.fieldName} in the uploaded file.`,
    };
  }

  if (transform.type === "remove_duplicate_rows") {
    const beforeCount = rows.length;
    const afterRows = applyDuplicateRowFix(rows, column);
    if (afterRows.length === beforeCount) {
      return {
        ok: false,
        error: "No duplicate rows would be removed for this field.",
      };
    }

    return {
      ok: true,
      proposal: {
        id: crypto.randomUUID(),
        fieldName: finding.fieldName,
        ruleName: finding.ruleName || finding.ruleViolated,
        matchedColumn: column,
        transform,
        rule: finding.rule || null,
        explanation: `Proposed fix for "${finding.ruleName || finding.ruleViolated}" on ${finding.fieldName}: ${transform.label}.`,
        affectedCount: beforeCount - afterRows.length,
        affectedRowIndexes: [],
        diffSample: [],
        rowLevel: false,
        afterRows,
      },
    };
  }

  const affectedRowIndexes = [];
  const diffSample = [];
  const data = Array.isArray(rows) ? rows : [];
  const applyToAllRows =
    transform.type === "normalize_dats" ||
    transform.type === "trim_whitespace" ||
    transform.type === "to_uppercase";

  for (let i = 0; i < data.length; i += 1) {
    const row = data[i];
    const before = row?.[column];
    const after = applyValueTransform(
      transform.type,
      transform.params,
      before,
      row,
    );

    const changed =
      String(before ?? "") !== String(after ?? "") &&
      !(before == null && after == null);

    const flagged =
      applyToAllRows ||
      !Array.isArray(finding.affectedRows) ||
      finding.affectedRows.length === 0 ||
      finding.affectedRows.includes(i + 1);

    if (!flagged || !changed) continue;

    affectedRowIndexes.push(i);
    if (diffSample.length < 15) {
      diffSample.push({
        row: i + 1,
        field: column,
        before: before == null ? null : String(before),
        after: after == null ? null : String(after),
      });
    }
  }

  if (affectedRowIndexes.length === 0 && !applyToAllRows) {
    return {
      ok: false,
      error:
        "No rows would change for this fix (values may already satisfy the transform).",
    };
  }

  return {
    ok: true,
    proposal: {
      id: crypto.randomUUID(),
      fieldName: finding.fieldName,
      ruleName: finding.ruleName || finding.ruleViolated,
      matchedColumn: column,
      transform,
      rule: finding.rule || null,
      explanation: `Proposed fix for "${finding.ruleName || finding.ruleViolated}" on ${finding.fieldName} using the stored validation rule only: ${transform.label}.`,
      affectedCount: applyToAllRows ? data.length : affectedRowIndexes.length,
      affectedRowIndexes: applyToAllRows
        ? data.map((_, idx) => idx)
        : affectedRowIndexes,
      diffSample,
      rowLevel: true,
    },
  };
}

export function applyProposalToRows(rows, proposal) {
  if (proposal.afterRows) {
    return proposal.afterRows.map((row) => ({ ...row }));
  }

  const data = (Array.isArray(rows) ? rows : []).map((row) => ({ ...row }));
  const column = proposal.matchedColumn;
  const indexes = proposal.affectedRowIndexes || [];
  const { type, params } = proposal.transform || {};

  for (const idx of indexes) {
    if (idx < 0 || idx >= data.length) continue;
    const before = data[idx][column];
    data[idx][column] = applyValueTransform(type, params, before, data[idx]);
  }

  return data;
}

/**
 * Apply deterministic fixes for every finding (errors first, then warnings).
 */
export function applyAllFindings(rows, findings) {
  let data = (Array.isArray(rows) ? rows : []).map((row) => ({ ...row }));
  const list = Array.isArray(findings) ? [...findings] : [];
  list.sort((a, b) => {
    const aErr = String(a.severity || "").toLowerCase() === "error" ? 0 : 1;
    const bErr = String(b.severity || "").toLowerCase() === "error" ? 0 : 1;
    return aErr - bErr;
  });

  const applied = [];
  const skipped = [];
  const seen = new Set();

  for (const finding of list) {
    const dedupeKey = `${finding.fieldName}::${finding.ruleName || finding.ruleViolated}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const result = buildFixProposal(finding, data);
    if (!result.ok) {
      skipped.push({
        fieldName: finding.fieldName,
        ruleName: finding.ruleName || finding.ruleViolated,
        reason: result.error,
      });
      continue;
    }

    data = applyProposalToRows(data, result.proposal);
    applied.push({
      fieldName: finding.fieldName,
      ruleName: finding.ruleName || finding.ruleViolated,
      transform: result.proposal.transform?.type,
      affectedCount: result.proposal.affectedCount,
    });
  }

  return { rows: data, applied, skipped };
}

/**
 * Match a user message to the best finding (keyword score).
 */
export function matchFindingFromMessage(message, findings) {
  const text = String(message || "").toLowerCase();
  const list = Array.isArray(findings) ? findings : [];
  if (list.length === 0) return null;

  let best = null;
  let bestScore = 0;

  for (const finding of list) {
    let score = 0;
    const field = String(finding.fieldName || "").toLowerCase();
    const rule = String(
      finding.ruleName || finding.ruleViolated || "",
    ).toLowerCase();
    const issue = String(finding.issue || "").toLowerCase();

    if (field && text.includes(field.toLowerCase())) score += 5;
    const fieldTokens = field.split(/[_\s]+/).filter((t) => t.length > 2);
    for (const token of fieldTokens) {
      if (text.includes(token)) score += 2;
    }
    if (rule && text.includes(rule)) score += 4;
    if (
      text.includes("length") &&
      (issue.includes("length") ||
        rule.includes("length") ||
        String(finding.rule?.constraint || "").includes("characters"))
    ) {
      score += 3;
    }
    if (
      text.includes("leading") &&
      (issue.includes("leading") || rule.includes("leading"))
    ) {
      score += 3;
    }
    if (text.includes("weight") && field.includes("weight")) score += 2;
    if (text.includes("gross") && field.includes("gross")) score += 3;
    if (
      text.includes("fix") ||
      text.includes("correct") ||
      text.includes("repair")
    ) {
      score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      best = finding;
    }
  }

  if (bestScore < 3) return null;
  return best;
}
