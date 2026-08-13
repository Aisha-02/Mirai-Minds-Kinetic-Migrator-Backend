/**
 * Align validation findings/report field labels to SAP column names
 * after preload headers have been remapped.
 */

function replaceFieldLabel(text, from, to) {
  if (!text || !from || !to || from === to) return text;
  return String(text).split(from).join(to);
}

/**
 * @param {object[]} findings
 * @param {object} [report]
 * @param {Record<string, string>} [columnMapping]
 */
export function alignValidationOutputToSapFields(
  findings,
  report,
  columnMapping = {},
) {
  const ruleFieldToSap = new Map();
  for (const finding of findings || []) {
    const sapField = finding.matchedColumn || finding.fieldName;
    if (finding.fieldName && sapField) {
      ruleFieldToSap.set(finding.fieldName, sapField);
    }
  }

  for (const [source, target] of Object.entries(columnMapping)) {
    if (source !== target) {
      ruleFieldToSap.set(source, target);
    }
  }

  const normalizedFindings = (findings || []).map((finding) => {
    const sapField =
      finding.matchedColumn ||
      ruleFieldToSap.get(finding.fieldName) ||
      finding.fieldName;
    return {
      ...finding,
      fieldName: sapField,
      matchedColumn: sapField,
      summary: replaceFieldLabel(finding.summary, finding.fieldName, sapField),
      issue: replaceFieldLabel(finding.issue, finding.fieldName, sapField),
    };
  });

  const groupsBySapField = new Map();

  for (const group of report?.fieldGroups || []) {
    const sapField =
      ruleFieldToSap.get(group.fieldName) || group.fieldName;
    const existing = groupsBySapField.get(sapField) || {
      fieldName: sapField,
      errorCount: 0,
      warningCount: 0,
      findingCount: 0,
      findings: [],
    };

    existing.errorCount += group.errorCount || 0;
    existing.warningCount += group.warningCount || 0;
    existing.findingCount += group.findingCount || 0;
    existing.findings.push(
      ...(group.findings || []).map((item) => ({
        ...item,
        summary: replaceFieldLabel(item.summary, group.fieldName, sapField),
        whatToCorrect: replaceFieldLabel(
          item.whatToCorrect,
          group.fieldName,
          sapField,
        ),
      })),
    );
    groupsBySapField.set(sapField, existing);
  }

  const fieldGroups = [...groupsBySapField.values()].sort(
    (a, b) => b.errorCount - a.errorCount || b.warningCount - a.warningCount,
  );

  return {
    findings: normalizedFindings,
    report: report
      ? {
          ...report,
          fieldGroups,
        }
      : { fieldGroups },
  };
}
