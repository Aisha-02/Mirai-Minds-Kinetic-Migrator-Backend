/**
 * Turns structured validation findings into plain-language, field-grouped report copy.
 */

function rowPhrase(count) {
  const n = Number(count) || 0;
  if (n === 1) return "1 row";
  return `${n} rows`;
}

function formatRowList(rows) {
  const list = Array.isArray(rows) ? rows.filter((n) => Number.isFinite(n)) : [];
  if (list.length === 0) return "";
  if (list.length === 1) return `Row ${list[0]}`;
  if (list.length === 2) return `Rows ${list[0]} and ${list[1]}`;
  const shown = list.slice(0, 5).join(", ");
  const extra = list.length > 5 ? ` (+${list.length - 5} more sampled)` : "";
  return `Rows ${shown}${extra}`;
}

function humanIssue(finding) {
  const reason = String(
    finding?.sampleValues?.[0]?.reason || finding?.issue || "",
  ).trim();
  const constraint = String(finding?.rule?.constraint || "").trim();
  const description = String(finding?.rule?.description || "").trim();
  const field = finding.fieldName;
  const count = finding.affectedCount;
  const text = `${reason} ${constraint} ${description}`.toLowerCase();

  if (text.includes("leading zero")) {
    return `${field} has leading zeros in ${rowPhrase(count)} — remove leading zeros (or apply the agreed SAP padding format) so values match the material-number standard.`;
  }

  if (text.includes("duplicate")) {
    return `${field} has duplicate values in ${rowPhrase(count)} — primary/key fields must be unique across the preload file; remove or correct the repeated material numbers.`;
  }

  const lengthMatch = `${constraint} ${description} ${reason}`.match(
    /(\d+)\s*characters?\s*or\s*less/i,
  );
  if (lengthMatch || text.includes("exceeds max") || text.includes("length")) {
    const max = lengthMatch?.[1];
    if (max) {
      return `${field} exceeds the allowed length of ${max} characters in ${rowPhrase(count)} — SAP expects this field to stay within ${max} characters (often zero-padded to a fixed width).`;
    }
    return `${field} fails the length/format check in ${rowPhrase(count)} — shorten or reformat the value to match the SAP field length rule.`;
  }

  if (text.includes("less than zero") || text.includes("greater than or equal to zero")) {
    return `${field} contains a negative or invalid number in ${rowPhrase(count)} — set the value to zero or a positive amount; SAP does not allow negative weights/quantities here.`;
  }

  if (text.includes("gross") && text.includes("net")) {
    return `${field} is lower than net weight in ${rowPhrase(count)} — correct the values so gross weight is greater than or equal to net weight.`;
  }

  if (text.includes("null/empty") || text.includes("is empty") || text.includes("required")) {
    return `${field} is blank in ${rowPhrase(count)} — fill in a valid value before migration; SAP treats this as a required field for this check.`;
  }

  if (text.includes("domain") || text.includes("allowed values")) {
    return `${field} is missing or not a recognized SAP domain value in ${rowPhrase(count)} — replace it with a valid code from the SAP domain list for this field.`;
  }

  if (text.includes("start with a letter or number") || text.includes("letter or a number")) {
    return `${field} starts with an invalid character in ${rowPhrase(count)} — values must begin with a letter or number per SAP format rules.`;
  }

  const what = reason || constraint || "does not meet the validation rule";
  const why =
    description ||
    constraint ||
    "This check comes from the admin-configured SAP validation ruleset.";

  return `${field}: ${what} in ${rowPhrase(count)} — ${why}`;
}

function correctionGuidance(finding) {
  const constraint = String(finding?.rule?.constraint || "").trim();
  const description = String(finding?.rule?.description || "").trim();
  const reason = String(
    finding?.sampleValues?.[0]?.reason || finding?.issue || "",
  ).trim();

  const parts = [];
  if (reason) parts.push(`Observed: ${reason}.`);
  if (constraint) parts.push(`Required: ${constraint}.`);
  if (description && description !== constraint) {
    parts.push(`Why it matters: ${description}.`);
  }
  if (parts.length === 0) {
    return `Review and correct ${finding.fieldName} so it satisfies "${finding.ruleName}".`;
  }
  return parts.join(" ");
}

/**
 * @param {object[]} findings
 * @param {{ businessObject?: string, filename?: string, totalRows?: number }} [meta]
 */
export function buildPlainLanguageValidationReport(findings, meta = {}) {
  const list = Array.isArray(findings) ? findings : [];
  const byField = new Map();

  for (const finding of list) {
    const fieldName = String(finding.fieldName || "UNKNOWN");
    if (!byField.has(fieldName)) {
      byField.set(fieldName, []);
    }

    const severity =
      String(finding.severity || "error").toLowerCase() === "warning"
        ? "warning"
        : "error";

    byField.get(fieldName).push({
      ruleName: finding.ruleName || finding.ruleViolated,
      severity,
      affectedCount: finding.affectedCount,
      affectedRowsSample: finding.affectedRows || [],
      affectedRowsLabel: formatRowList(finding.affectedRows || []),
      summary: humanIssue(finding),
      whatToCorrect: correctionGuidance(finding),
      rule: finding.rule || null,
    });
  }

  const fieldGroups = [...byField.entries()].map(([fieldName, items]) => {
    const errorCount = items
      .filter((i) => i.severity === "error")
      .reduce((sum, i) => sum + (i.affectedCount || 0), 0);
    const warningCount = items
      .filter((i) => i.severity === "warning")
      .reduce((sum, i) => sum + (i.affectedCount || 0), 0);

    return {
      fieldName,
      errorCount,
      warningCount,
      findingCount: items.length,
      findings: items,
    };
  });

  fieldGroups.sort((a, b) => {
    if (b.errorCount !== a.errorCount) return b.errorCount - a.errorCount;
    return b.warningCount - a.warningCount;
  });

  const totalIssues = list.reduce((sum, f) => sum + (f.affectedCount || 0), 0);
  const headline =
    list.length === 0
      ? "No validation issues were found in the uploaded preload file."
      : `Found ${list.length} rule issue${list.length === 1 ? "" : "s"} across ${fieldGroups.length} field${fieldGroups.length === 1 ? "" : "s"} (${totalIssues} affected row hit${totalIssues === 1 ? "" : "s"}).`;

  return {
    headline,
    businessObject: meta.businessObject || null,
    filename: meta.filename || null,
    totalRows: meta.totalRows ?? null,
    fieldGroups,
  };
}
