/**
 * Admin custom validation rules stored alongside AI rules in validation_rules.rules.
 *
 * Nested rule shape matches AI rules, plus source = "CUSTOM" and createdBy/createdAt.
 * AI-generated rules are not editable or deletable through these helpers.
 */

import { randomUUID } from "node:crypto";
import { isBusinessObject } from "../constants/businessObjects.js";
import {
  createValidationRules,
  findLatestValidationRulesByBusinessObject,
  findValidationRulesById,
  findValidationRulesByNestedRuleId,
  updateValidationRulesJson,
} from "../models/validationRules.js";
import { RULE_SOURCE } from "./commonRules.js";
import { normalizeRuleSource, toPersistableAiRules } from "./assembleRules.js";

const RULE_TYPES = new Set(["validation", "transformation"]);
const SEVERITIES = new Set(["error", "warning"]);
const CATEGORIES = new Set([
  "format",
  "domain",
  "range",
  "referential",
  "transformation",
  "consistency",
  "validation",
]);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function extractFields(rulesPayload) {
  if (!rulesPayload) return [];
  if (Array.isArray(rulesPayload.fields)) return rulesPayload.fields;
  if (rulesPayload.rules && Array.isArray(rulesPayload.rules.fields)) {
    return rulesPayload.rules.fields;
  }
  return [];
}

function fieldNameKey(name) {
  return String(name || "").trim().toUpperCase();
}

function findRuleLocation(rulesPayload, ruleId) {
  const fields = extractFields(rulesPayload);
  for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
    const rules = Array.isArray(fields[fieldIndex]?.rules)
      ? fields[fieldIndex].rules
      : [];
    const ruleIndex = rules.findIndex(
      (rule) => String(rule?.ruleId || "") === String(ruleId),
    );
    if (ruleIndex >= 0) {
      return { fieldIndex, ruleIndex, field: fields[fieldIndex], rule: rules[ruleIndex] };
    }
  }
  return null;
}

function assertCustomRule(rule) {
  const source = normalizeRuleSource(rule?.source);
  // AI (and predefined) rules cannot be edited or deleted via admin custom-rule APIs.
  if (source !== RULE_SOURCE.CUSTOM) {
    throw httpError(
      403,
      "Only admin-added custom rules can be edited or deleted. AI-generated rules are read-only.",
    );
  }
}

function cloneRulesPayload(row) {
  const payload =
    row?.rules && typeof row.rules === "object" ? structuredClone(row.rules) : {};
  if (!Array.isArray(payload.fields)) {
    payload.fields = [];
  }
  payload.businessObject = payload.businessObject || row.business_object;
  return payload;
}

export function validateCustomRuleInput(body, { partial = false } = {}) {
  const fieldName = String(body?.fieldName || "").trim();
  const constraint = String(
    body?.constraint || body?.condition || body?.logic || "",
  ).trim();
  const ruleName = String(
    body?.ruleName ||
      body?.name ||
      (fieldName ? `Custom transformation (${fieldName})` : ""),
  ).trim();
  const description = String(
    body?.description || body?.message || body?.errorMessage || constraint,
  ).trim();

  if (!partial) {
    if (!fieldName) {
      throw httpError(400, "fieldName is required");
    }
    if (!constraint) {
      throw httpError(400, "Custom logic is required");
    }
  } else {
    if (body?.fieldName !== undefined && !fieldName) {
      throw httpError(400, "fieldName cannot be empty");
    }
    if (
      (body?.constraint !== undefined ||
        body?.condition !== undefined ||
        body?.logic !== undefined) &&
      !constraint
    ) {
      throw httpError(400, "Custom logic cannot be empty");
    }
  }

  const typeRaw = body?.type != null ? String(body.type).trim().toLowerCase() : "";
  if (typeRaw && !RULE_TYPES.has(typeRaw)) {
    throw httpError(
      400,
      `type must be one of: ${[...RULE_TYPES].join(", ")}`,
    );
  }

  const severityRaw =
    body?.severity != null ? String(body.severity).trim().toLowerCase() : "";
  if (severityRaw && !SEVERITIES.has(severityRaw)) {
    throw httpError(
      400,
      `severity must be one of: ${[...SEVERITIES].join(", ")}`,
    );
  }

  const categoryRaw =
    body?.category != null ? String(body.category).trim().toLowerCase() : "";
  if (categoryRaw && !CATEGORIES.has(categoryRaw)) {
    throw httpError(
      400,
      `category must be one of: ${[...CATEGORIES].join(", ")}`,
    );
  }

  return {
    fieldName,
    ruleName,
    constraint,
    description,
    type: typeRaw || undefined,
    severity: severityRaw || undefined,
    category: categoryRaw || undefined,
  };
}

function buildCustomRule({ input, userId, existing = null }) {
  const now = new Date().toISOString();
  return {
    ruleId: existing?.ruleId || `CUSTOM-${randomUUID()}`,
    ruleName: input.ruleName || existing?.ruleName,
    source: RULE_SOURCE.CUSTOM,
    type: input.type || existing?.type || "transformation",
    description: input.description || existing?.description || "",
    constraint: input.constraint || existing?.constraint || "",
    severity: input.severity || existing?.severity || "warning",
    category: input.category || existing?.category || "transformation",
    createdBy: existing?.createdBy || userId || null,
    createdAt: existing?.createdAt || now,
    updatedBy: existing ? userId || null : null,
    updatedAt: existing ? now : null,
  };
}

async function resolveRuleSet({ ruleSetId, businessObject }) {
  if (ruleSetId) {
    const row = await findValidationRulesById(ruleSetId);
    if (!row) {
      throw httpError(404, "Rule set not found");
    }
    if (businessObject && row.business_object !== businessObject) {
      throw httpError(
        400,
        `Rule set ${ruleSetId} belongs to business object '${row.business_object}'`,
      );
    }
    return row;
  }

  if (!businessObject) {
    throw httpError(400, "businessObject or ruleSetId is required");
  }
  if (!isBusinessObject(businessObject)) {
    throw httpError(400, "Invalid businessObject");
  }

  return findLatestValidationRulesByBusinessObject(businessObject);
}

export async function addCustomValidationRule({
  businessObject,
  ruleSetId,
  body,
  userId,
}) {
  const input = validateCustomRuleInput(body, { partial: false });
  const customRule = buildCustomRule({ input, userId });

  if (businessObject && !isBusinessObject(businessObject)) {
    throw httpError(400, "Invalid businessObject");
  }

  const existing = await resolveRuleSet({
    ruleSetId,
    businessObject: businessObject || undefined,
  });

  if (!existing) {
    const targetBo = businessObject;
    if (!isBusinessObject(targetBo)) {
      throw httpError(
        400,
        "businessObject is required when no saved rule set exists yet",
      );
    }
    const payload = {
      businessObject: targetBo,
      fields: [
        {
          fieldName: input.fieldName,
          key: "",
          dataType: "",
          length: "",
          rules: [customRule],
        },
      ],
    };
    const saved = await createValidationRules({
      businessObject: targetBo,
      rules: toPersistableAiRules(targetBo, payload),
      createdBy: userId,
    });
    return { ruleSet: saved, rule: customRule, created: true };
  }

  const payload = cloneRulesPayload(existing);
  const fields = payload.fields;
  const matchIndex = fields.findIndex(
    (field) => fieldNameKey(field.fieldName) === fieldNameKey(input.fieldName),
  );

  if (matchIndex >= 0) {
    const currentRules = Array.isArray(fields[matchIndex].rules)
      ? fields[matchIndex].rules
      : [];
    fields[matchIndex] = {
      ...fields[matchIndex],
      fieldName: fields[matchIndex].fieldName || input.fieldName,
      rules: [...currentRules, customRule],
    };
  } else {
    fields.push({
      fieldName: input.fieldName,
      key: "",
      dataType: "",
      length: "",
      rules: [customRule],
    });
  }

  payload.fields = fields;
  const persisted = toPersistableAiRules(existing.business_object, payload);
  const ruleSet = await updateValidationRulesJson({
    id: existing.id,
    rules: persisted,
  });

  return { ruleSet, rule: customRule, created: false };
}

export async function updateCustomValidationRule({
  ruleId,
  businessObject,
  ruleSetId,
  body,
  userId,
}) {
  let row = null;
  if (ruleSetId || businessObject) {
    row = await resolveRuleSet({ ruleSetId, businessObject });
    if (!row) {
      throw httpError(404, "Rule set not found");
    }
  } else {
    row = await findValidationRulesByNestedRuleId(ruleId);
  }

  if (!row) {
    throw httpError(404, "Custom rule not found");
  }

  const payload = cloneRulesPayload(row);
  const location = findRuleLocation(payload, ruleId);
  if (!location) {
    throw httpError(404, "Custom rule not found");
  }

  assertCustomRule(location.rule);

  const input = validateCustomRuleInput(
    {
      fieldName: body?.fieldName || location.field.fieldName,
      ruleName: body?.ruleName ?? location.rule.ruleName,
      constraint: body?.constraint ?? body?.condition ?? location.rule.constraint,
      description:
        body?.description ??
        body?.message ??
        body?.errorMessage ??
        location.rule.description,
      type: body?.type ?? location.rule.type,
      severity: body?.severity ?? location.rule.severity,
      category: body?.category ?? location.rule.category,
    },
    { partial: true },
  );

  const nextRule = buildCustomRule({
    input: {
      ruleName: input.ruleName || location.rule.ruleName,
      constraint: input.constraint || location.rule.constraint,
      description: input.description || location.rule.description,
      type: input.type,
      severity: input.severity,
      category: input.category,
    },
    userId,
    existing: location.rule,
  });

  const moveToField =
    input.fieldName &&
    fieldNameKey(input.fieldName) !== fieldNameKey(location.field.fieldName);

  if (moveToField) {
    payload.fields[location.fieldIndex].rules.splice(location.ruleIndex, 1);
    const destIndex = payload.fields.findIndex(
      (field) => fieldNameKey(field.fieldName) === fieldNameKey(input.fieldName),
    );
    if (destIndex >= 0) {
      payload.fields[destIndex].rules = [
        ...(payload.fields[destIndex].rules || []),
        nextRule,
      ];
    } else {
      payload.fields.push({
        fieldName: input.fieldName,
        key: "",
        dataType: "",
        length: "",
        rules: [nextRule],
      });
    }
  } else {
    payload.fields[location.fieldIndex].rules[location.ruleIndex] = nextRule;
  }

  const persisted = toPersistableAiRules(row.business_object, payload);
  const ruleSet = await updateValidationRulesJson({
    id: row.id,
    rules: persisted,
  });

  return { ruleSet, rule: nextRule };
}

export async function deleteCustomValidationRule({
  ruleId,
  businessObject,
  ruleSetId,
}) {
  let row = null;
  if (ruleSetId || businessObject) {
    row = await resolveRuleSet({ ruleSetId, businessObject });
    if (!row) {
      throw httpError(404, "Rule set not found");
    }
  } else {
    row = await findValidationRulesByNestedRuleId(ruleId);
  }

  if (!row) {
    throw httpError(404, "Custom rule not found");
  }

  const payload = cloneRulesPayload(row);
  const location = findRuleLocation(payload, ruleId);
  if (!location) {
    throw httpError(404, "Custom rule not found");
  }

  assertCustomRule(location.rule);

  payload.fields[location.fieldIndex].rules.splice(location.ruleIndex, 1);

  const persisted = toPersistableAiRules(row.business_object, payload);
  const ruleSet = await updateValidationRulesJson({
    id: row.id,
    rules: persisted,
  });

  return { ruleSet, deletedRuleId: ruleId };
}
