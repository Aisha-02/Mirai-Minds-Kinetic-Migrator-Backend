import { buildPredefinedRulesForField, RULE_SOURCE } from "./commonRules.js";
import { resolveFieldColumn } from "../constants/fieldColumnAliases.js";

const PERSISTED_SOURCES = new Set([RULE_SOURCE.AI, RULE_SOURCE.CUSTOM]);

export const DEFAULT_PREDEFINED_CHECKS = {
  trim: true,
  nullCheck: true,
  duplicates: true,
};

export function normalizePredefinedChecks(checks) {
  return {
    trim: checks?.trim !== false,
    nullCheck: checks?.nullCheck !== false,
    duplicates: checks?.duplicates !== false,
  };
}

export function normalizeRuleSource(value) {
  const source = String(value || "").trim().toUpperCase();
  if (source === RULE_SOURCE.PREDEFINED || source === "PREDEFINED") {
    return RULE_SOURCE.PREDEFINED;
  }
  if (source === RULE_SOURCE.CUSTOM || source === "CUSTOM" || source === "ADMIN") {
    return RULE_SOURCE.CUSTOM;
  }
  return RULE_SOURCE.AI;
}

function toAiRule(rule, index) {
  const ruleName =
    rule?.ruleName || rule?.rule || rule?.name || `AI Rule ${index + 1}`;
  const hasSelected = rule != null && Object.prototype.hasOwnProperty.call(rule, "selected");

  return {
    ruleName: String(ruleName),
    source: normalizeRuleSource(rule?.source || RULE_SOURCE.AI),
    ruleId: rule?.ruleId || `AI-${String(index + 1).padStart(3, "0")}`,
    type: rule?.type || "validation",
    description: rule?.description || "",
    constraint: rule?.constraint || "",
    severity: rule?.severity || "error",
    category: rule?.category || "validation",
    selected: hasSelected ? rule.selected : null,
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

function extractFields(rulesPayload) {
  if (!rulesPayload) return [];
  if (Array.isArray(rulesPayload.fields)) return rulesPayload.fields;
  if (rulesPayload.rules && Array.isArray(rulesPayload.rules.fields)) {
    return rulesPayload.rules.fields;
  }
  return [];
}

/** Latest admin-authored CUSTOM rules, keyed by uppercase fieldName. */
export function extractCustomRulesByField(rulesPayload) {
  const byField = new Map();
  for (const field of extractFields(rulesPayload)) {
    const fieldName = String(field?.fieldName || "").trim();
    if (!fieldName) continue;
    const custom = (Array.isArray(field.rules) ? field.rules : []).filter(
      (rule) => normalizeRuleSource(rule?.source) === RULE_SOURCE.CUSTOM,
    );
    if (!custom.length) continue;
    byField.set(fieldName.toUpperCase(), custom);
  }
  return byField;
}

export function lookupCustomRulesForField(fieldName, customByField) {
  if (!customByField?.size) return [];
  const direct = customByField.get(String(fieldName || "").toUpperCase());
  if (direct?.length) return direct;
  const matchedKey = resolveFieldColumn(fieldName, [...customByField.keys()]);
  if (!matchedKey) return [];
  return customByField.get(String(matchedKey).toUpperCase()) || [];
}

/**
 * Review payload: custom + predefined + AI (for UI only).
 */
export function assembleFieldRules(
  businessObject,
  fields,
  aiByField = [],
  customByField = new Map(),
) {
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
    const customRules = lookupCustomRulesForField(field.fieldName, customByField);
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
      rules: [...customRules, ...predefined, ...aiRules],
    };
  });

  return {
    businessObject,
    predefinedChecks: normalizePredefinedChecks(null),
    fields: fieldRules,
  };
}

function persistKeyFlag(field) {
  const raw = field?.key ?? field?.metadata?.key ?? "";
  return String(raw).toUpperCase() === "X" ? "X" : "";
}

function toPersistableRule(rule) {
  const source = normalizeRuleSource(rule.source);
  const persisted = {
    ruleId: rule.ruleId || undefined,
    ruleName: rule.ruleName,
    source,
    type: rule.type || "validation",
    description: rule.description || "",
    constraint: rule.constraint || "",
    severity: rule.severity || "error",
    category: rule.category || rule.type || "validation",
    selected: rule.selected === undefined ? undefined : rule.selected,
  };

  if (source === RULE_SOURCE.CUSTOM) {
    persisted.createdBy = rule.createdBy ?? null;
    persisted.createdAt = rule.createdAt ?? null;
    persisted.updatedBy = rule.updatedBy ?? null;
    persisted.updatedAt = rule.updatedAt ?? null;
  }

  return persisted;
}

/**
 * DB persistence payload: Business Object + fieldName + key flag + AI + custom rules.
 * Does NOT include predefined rules (those are applied at evaluation time).
 * key = "X" marks a primary/business key; anything else is non-key.
 */
export function toPersistableAiRules(businessObject, rules) {
  const normalized = normalizeRulesForPersistence(businessObject, rules);

  return {
    businessObject: normalized.businessObject || businessObject,
    predefinedChecks: normalizePredefinedChecks(
      rules?.predefinedChecks || normalized.predefinedChecks,
    ),
    fields: (normalized.fields || [])
      .map((field) => {
        const persistedRules = (field.rules || []).filter((rule) =>
          PERSISTED_SOURCES.has(normalizeRuleSource(rule.source)),
        );
        return {
          fieldName: field.fieldName,
          key: persistKeyFlag(field),
          dataType:
            field.metadata?.dataType || field.dataType
              ? String(field.metadata?.dataType || field.dataType).trim()
              : "",
          length:
            field.metadata?.length ?? field.length ?? "",
          rules: persistedRules.map(toPersistableRule),
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
            source: normalizeRuleSource(rule.source),
            ruleId: rule.ruleId,
            type: rule.type,
            description: rule.description,
            constraint: rule.constraint,
            severity: rule.severity,
            category: rule.category,
            keyEnforced: rule.keyEnforced,
            selected: rule.selected,
            createdBy: rule.createdBy,
            createdAt: rule.createdAt,
            updatedBy: rule.updatedBy,
            updatedAt: rule.updatedAt,
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
      predefinedChecks: normalizePredefinedChecks(rules.predefinedChecks),
      fields,
    };
  }

  if (rules?.rules?.fields && Array.isArray(rules.rules.fields)) {
    return normalizeRulesForPersistence(businessObject, rules.rules);
  }

  return {
    businessObject,
    predefinedChecks: normalizePredefinedChecks(rules?.predefinedChecks),
    fields: [],
  };
}
