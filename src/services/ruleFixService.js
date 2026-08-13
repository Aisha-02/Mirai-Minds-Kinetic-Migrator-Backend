/**
 * Deterministic transforms derived from fetched validation rule definitions.
 * Does not invent new business logic beyond the rule constraint/description.
 */

import crypto from "crypto";

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
  const target = normalizeKey(fieldName);
  if (!rows.length) return null;
  const columns = Object.keys(rows[0] || {});
  for (const col of columns) {
    if (normalizeKey(col) === target) return col;
  }
  for (const col of columns) {
    const n = normalizeKey(col);
    if (n.includes(target) || target.includes(n)) return col;
  }
  return null;
}

/**
 * Infer a transform plan from a finding's rule text.
 * @returns {{ type: string, params?: object, label: string } | null}
 */
export function inferTransformFromRule(finding) {
  const text = ruleText(finding?.rule || finding);
  const lengthMatch = text.match(/(\d+)\s*characters?\s*or\s*less/);

  if (text.includes("leading zero")) {
    return {
      type: "strip_leading_zeros",
      label: "Strip leading zeros (per rule)",
    };
  }

  if (lengthMatch) {
    const max = Number(lengthMatch[1]);
    // SAP material numbers are commonly left zero-padded to fixed width.
    // If value is too long, keep the rightmost max characters (numeric-pad style).
    return {
      type: "fit_length",
      params: { max },
      label: `Fit to max length ${max} (pad with leading zeros if shorter; trim if longer)`,
    };
  }

  if (
    text.includes("greater than or equal to zero") ||
    text.includes("greater than or equal to 0") ||
    (text.includes("range") && text.includes("zero"))
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
      params: { netFieldHints: ["NET_WEIGHT", "NET WEIGHT", "NETWT"] },
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

  return null;
}

function applyValueTransform(type, params, value, row, columnIndexHints) {
  const empty = value == null || String(value).trim() === "";

  switch (type) {
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
    case "gross_gte_net": {
      const hints = params?.netFieldHints || ["NET_WEIGHT"];
      let netCol = null;
      for (const hint of hints) {
        const target = normalizeKey(hint);
        for (const col of Object.keys(row || {})) {
          if (normalizeKey(col) === target || normalizeKey(col).includes(target)) {
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
    finding.matchedColumn ||
    resolveColumn(finding.fieldName, rows);

  if (!column) {
    return {
      ok: false,
      error: `Could not find column for field ${finding.fieldName} in the uploaded file.`,
    };
  }

  const affectedRowIndexes = [];
  const diffSample = [];
  const data = Array.isArray(rows) ? rows : [];

  for (let i = 0; i < data.length; i += 1) {
    const row = data[i];
    const before = row?.[column];
    const after = applyValueTransform(
      transform.type,
      transform.params,
      before,
      row,
      null,
    );

    const changed =
      String(before ?? "") !== String(after ?? "") &&
      !(before == null && after == null);

    // Only include rows that the finding flagged, when available
    const flagged =
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

  if (affectedRowIndexes.length === 0) {
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
      affectedCount: affectedRowIndexes.length,
      affectedRowIndexes,
      diffSample,
    },
  };
}

export function applyProposalToRows(rows, proposal) {
  const data = (Array.isArray(rows) ? rows : []).map((row) => ({ ...row }));
  const column = proposal.matchedColumn;
  const indexes = proposal.affectedRowIndexes || [];
  const { type, params } = proposal.transform || {};

  for (const idx of indexes) {
    if (idx < 0 || idx >= data.length) continue;
    const before = data[idx][column];
    data[idx][column] = applyValueTransform(
      type,
      params,
      before,
      data[idx],
      null,
    );
  }

  return data;
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
    const rule = String(finding.ruleName || finding.ruleViolated || "").toLowerCase();
    const issue = String(finding.issue || "").toLowerCase();

    if (field && text.includes(field.toLowerCase())) score += 5;
    const fieldTokens = field.split(/[_\s]+/).filter((t) => t.length > 2);
    for (const token of fieldTokens) {
      if (text.includes(token)) score += 2;
    }
    if (rule && text.includes(rule)) score += 4;
    if (text.includes("length") && (issue.includes("length") || rule.includes("length") || String(finding.rule?.constraint || "").includes("characters"))) {
      score += 3;
    }
    if (text.includes("leading") && (issue.includes("leading") || rule.includes("leading"))) {
      score += 3;
    }
    if (text.includes("weight") && field.includes("weight")) score += 2;
    if (text.includes("gross") && field.includes("gross")) score += 3;
    if (text.includes("fix") || text.includes("correct") || text.includes("repair")) {
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
