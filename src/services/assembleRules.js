import { buildPredefinedRulesForField, RULE_SOURCE } from "./commonRules.js";

function toAiRule(rule, index) {
  const ruleName =
    rule?.ruleName || rule?.rule || rule?.name || `AI Rule ${index + 1}`;

  return {
    ruleName: String(ruleName),
    source: RULE_SOURCE.AI,
    ruleId: rule?.ruleId || `AI-${String(index + 1).padStart(3, "0")}`,
    type: rule?.type || "validation",
    description: rule?.description || "",
    constraint: rule?.constraint || "",
    severity: rule?.severity || "error",
    category: rule?.category || "validation",
  };
}

function isPredefinedName(name) {
  const label = String(name || "").toLowerCase();
  return (
    label.includes("trim whitespace") ||
    label.includes("null/empty") ||
    label.includes("null check") ||
    label.includes("duplicate check")
  );
}

/**
 * Review payload: predefined + AI (for UI only).
 */
export function assembleFieldRules(businessObject, fields, aiByField = []) {
  const aiMap = new Map(
    (aiByField || []).map((entry) => [
      String(entry.fieldName).toUpperCase(),
      Array.isArray(entry.aiRules)
        ? entry.aiRules
        : Array.isArray(entry.rules)
          ? entry.rules.filter(
              (r) => String(r?.source || "").toUpperCase() !== "PREDEFINED",
            )
          : [],
    ]),
  );

  const fieldRules = (fields || []).map((field) => {
    const predefined = buildPredefinedRulesForField(field);
    const rawAi = aiMap.get(String(field.fieldName).toUpperCase()) || [];
    const aiRules = rawAi
      .map((rule, index) => toAiRule(rule, index))
      .filter((rule) => !isPredefinedName(rule.ruleName));

    return {
      fieldName: field.fieldName,
      metadata: {
        key: field.key || "",
        fieldName: field.fieldName,
        dataType: field.dataType,
        length: field.length === "" || field.length == null ? "" : field.length,
        defaultValue: field.defaultValue ?? "",
      },
      rules: [...predefined, ...aiRules],
    };
  });

  return {
    businessObject,
    fields: fieldRules,
  };
}

function persistKeyFlag(field) {
  const raw = field?.key ?? field?.metadata?.key ?? "";
  return String(raw).toUpperCase() === "X" ? "X" : "";
}

/**
 * DB persistence payload: Business Object + fieldName + key flag + AI rules.
 * Does NOT include predefined rules or other Excel metadata.
 * key = "X" marks a primary/business key; anything else is non-key.
 */
export function toPersistableAiRules(businessObject, rules) {
  const normalized = normalizeRulesForPersistence(businessObject, rules);

  return {
    businessObject: normalized.businessObject || businessObject,
    fields: (normalized.fields || [])
      .map((field) => {
        const aiOnly = (field.rules || []).filter(
          (rule) => String(rule.source || "").toUpperCase() === RULE_SOURCE.AI,
        );
        return {
          fieldName: field.fieldName,
          key: persistKeyFlag(field),
          rules: aiOnly.map((rule) => ({
            ruleName: rule.ruleName,
            source: RULE_SOURCE.AI,
            type: rule.type || "validation",
            description: rule.description || "",
            constraint: rule.constraint || "",
            severity: rule.severity || "error",
            category: rule.category || rule.type || "validation",
          })),
        };
      })
      .filter((field) => field.fieldName),
  };
}

/**
 * Normalize client/legacy payloads into fields with unified rules[].
 */
export function normalizeRulesForPersistence(businessObject, rules) {
  if (rules?.fields && Array.isArray(rules.fields)) {
    const fields = rules.fields.map((field) => {
      const key = persistKeyFlag(field);
      const metadata = {
        ...(field.metadata || { fieldName: field.fieldName }),
        key,
      };

      if (Array.isArray(field.rules)) {
        return {
          fieldName: field.fieldName,
          key,
          metadata,
          rules: field.rules.map((rule, index) => ({
            ruleName: rule.ruleName || rule.rule || `Rule ${index + 1}`,
            source:
              String(rule.source || "").toUpperCase() === "PREDEFINED"
                ? RULE_SOURCE.PREDEFINED
                : RULE_SOURCE.AI,
            ruleId: rule.ruleId,
            type: rule.type,
            description: rule.description,
            constraint: rule.constraint,
            severity: rule.severity,
            category: rule.category,
            keyEnforced: rule.keyEnforced,
          })),
        };
      }

      const predefined = (field.commonRules || []).map((rule, index) => ({
        ruleName: rule.ruleName || rule.rule || `Predefined ${index + 1}`,
        source: RULE_SOURCE.PREDEFINED,
        ...rule,
      }));
      const ai = (field.aiRules || []).map((rule, index) => toAiRule(rule, index));

      return {
        fieldName: field.fieldName,
        key,
        metadata,
        rules: [...predefined, ...ai],
      };
    });

    return {
      businessObject: rules.businessObject || businessObject,
      fields,
    };
  }

  if (rules?.rules?.fields && Array.isArray(rules.rules.fields)) {
    return normalizeRulesForPersistence(businessObject, rules.rules);
  }

  return {
    businessObject,
    fields: [],
  };
}
