/**
 * Application-defined common rules for every uploaded field.
 * Always applied — independent of AI output.
 * Canonical shape uses ruleName + source = "PREDEFINED".
 */

export const RULE_SOURCE = {
  PREDEFINED: "PREDEFINED",
  AI: "AI",
};

export const COMMON_RULE_IDS = {
  TRIM: "COMMON-TRIM",
  NULL_EMPTY: "COMMON-NULL-EMPTY",
  DUPLICATE: "COMMON-DUPLICATE",
};

function isKeyField(field) {
  return String(field?.key ?? "").toUpperCase() === "X";
}

export function buildPredefinedRulesForField(field) {
  const key = isKeyField(field);

  const rules = [
    {
      ruleName: "Trim Whitespace",
      source: RULE_SOURCE.PREDEFINED,
      ruleId: COMMON_RULE_IDS.TRIM,
      type: "transformation",
      description: "Remove leading and trailing spaces from the field value.",
      severity: "warning",
    },
    {
      ruleName: "Null/Empty Value Check",
      source: RULE_SOURCE.PREDEFINED,
      ruleId: COMMON_RULE_IDS.NULL_EMPTY,
      type: "validation",
      description: key
        ? "Key field must not contain null or empty values."
        : "Validate null or empty values for this field.",
      constraint: key ? "NOT_NULL_OR_EMPTY" : "FLAG_NULL_OR_EMPTY",
      keyEnforced: key,
      severity: key ? "error" : "warning",
    },
  ];

  // Duplicate Check only when key = "X"
  if (key) {
    rules.push({
      ruleName: "Duplicate Check",
      source: RULE_SOURCE.PREDEFINED,
      ruleId: COMMON_RULE_IDS.DUPLICATE,
      type: "validation",
      description:
        "Key field must not contain duplicate values across the uploaded file.",
      constraint: "UNIQUE_REQUIRED",
      keyEnforced: true,
      severity: "error",
    });
  }

  return rules;
}

/** @deprecated use buildPredefinedRulesForField */
export const buildCommonRulesForField = buildPredefinedRulesForField;
