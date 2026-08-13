/**
 * Amazon Bedrock Converse API for ADDITIONAL field rules only.
 * Credentials stay server-side (AWS_ACCESS_KEY_ID / AWS_BEARER_TOKEN_BEDROCK).
 */

import { converseText } from "./bedrockClient.js";
import { lookupCustomRulesForField } from "./assembleRules.js";

const DEFAULT_BATCH_SIZE = 6;
const DEFAULT_MAX_TOKENS = 16384;

function stripJsonFences(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function extractJsonCandidate(text) {
  const candidate = stripJsonFences(text);
  const start = candidate.indexOf("{");
  if (start < 0) return candidate;
  const end = candidate.lastIndexOf("}");
  return end > start ? candidate.slice(start, end + 1) : candidate.slice(start);
}

function repairTruncatedJson(text) {
  let s = extractJsonCandidate(text);
  s = s.replace(/,\s*([}\]])/g, "$1");

  const stack = [];
  let inString = false;
  let escaped = false;

  for (const char of s) {
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === "}" || char === "]") stack.pop();
  }

  if (inString) s += '"';
  while (stack.length > 0) s += stack.pop();
  return s;
}

function parseJsonSafely(text) {
  const attempts = [
    () => JSON.parse(stripJsonFences(text)),
    () => JSON.parse(extractJsonCandidate(text)),
    () => JSON.parse(repairTruncatedJson(text)),
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch (err) {
      lastError = err;
    }
  }

  const error = new Error(
    `LLM response was not valid JSON${lastError?.message ? `: ${lastError.message}` : ""}`,
  );
  error.status = 502;
  throw error;
}

function ruleHaystack(rule) {
  return [
    rule?.ruleName,
    rule?.description,
    rule?.constraint,
    rule?.category,
    rule?.type,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isLengthOrPaddingTopic(text) {
  return /pad|padding|leading zero|alpha conversion|\blength\b|characters? long/.test(
    String(text || ""),
  );
}

function isTransformationLike(rule) {
  const type = String(rule?.type || "").toLowerCase();
  const category = String(rule?.category || "").toLowerCase();
  return type === "transformation" || category === "transformation";
}

export function aiRuleConflictsWithCustom(aiRule, customRules) {
  const customs = Array.isArray(customRules) ? customRules : [];
  if (!customs.length) return false;

  const aiText = ruleHaystack(aiRule);
  const aiTransform = isTransformationLike(aiRule);
  const aiLengthPad = isLengthOrPaddingTopic(aiText);

  return customs.some((custom) => {
    const customText = ruleHaystack(custom);
    if (isTransformationLike(custom) && aiTransform) return true;
    if (isLengthOrPaddingTopic(customText) && aiLengthPad) return true;
    return false;
  });
}

function customRulesPromptBlock(customRulesForPrompt) {
  if (!customRulesForPrompt?.length) {
    return `ADMIN CUSTOM RULES (HIGHEST PRIORITY):
None are stored for these fields yet. Still do not invent a generic MATNR/material-number length or leading-zero padding rule unless field metadata length explicitly requires it AND no custom rule exists.`;
  }

  return `ADMIN CUSTOM RULES (HIGHEST PRIORITY — source of truth, consider these FIRST):
An administrator already defined the following field rules. They outrank both predefined checks and any rule you might recommend.

${JSON.stringify(customRulesForPrompt, null, 2)}

You MUST:
- Read every custom rule before proposing AI rules for that field.
- Treat custom length, padding, leading-zero, and ALPHA-conversion rules as final (example: material number padded to a specific length with leading zeros).
- NOT duplicate, weaken, contradict, or restate those custom rules.
- NOT add another length / pad-with-zeros / ALPHA conversion rule for a field that already has a custom length or padding rule.
- Propose only ADDITIONAL non-conflicting rules for those fields (domain, format, referential, etc.).`;
}

function buildPrompt(businessObject, sourceFieldsJson, customRulesForPrompt = []) {
  const fieldCount = sourceFieldsJson?.[businessObject]?.fields?.length ?? 0;

  return `You are a senior SAP MDG / data-migration architect with deep expertise in S/4HANA ${businessObject} master/transactional data quality.

Business Object: ${businessObject}

Rule priority you MUST follow (highest to lowest):
1. ADMIN CUSTOM RULES — already decided by the customer; never override.
2. PREDEFINED application rules — already enforced; never repeat.
3. YOUR AI-recommended rules — only gaps not covered above.

Field metadata JSON (use key, dataType, length, defaultValue when present):
${JSON.stringify(sourceFieldsJson, null, 2)}

${customRulesPromptBlock(customRulesForPrompt)}

IMPORTANT — the application ALREADY enforces these PREDEFINED rules on every field. Do NOT repeat them:
1. Trim Whitespace
2. Null/Empty Value Check (mandatory when key = "X")
3. Duplicate Check (mandatory uniqueness when key = "X")

Your task: invent ADDITIONAL, high-value, field-specific validation and transformation rules that a real SAP migration project would need, without colliding with custom or predefined rules.

Be creative and practical. Prefer rules that catch real migration defects, for example:
- SAP domain semantics (MATNR, EBELN, LIFNR, KUNNR, BUKRS, WERKS, HKONT, WAERS, MEINS, DATS, TIMS, QUAN, CURR)
- Check-digit / number-range / leading-zero padding (ALPHA conversion) ONLY when no custom length/padding rule exists for that field
- Allowed value lists / domain fixed values / ISO codes (currency, UoM, language, country)
- Cross-field consistency hints described for this field (e.g. net weight ≤ gross weight)
- Plant/company-code organizational existence format checks
- Forbidden characters, uppercase enforcement, no embedded blanks
- Date not in future/field-length / fiscal-period plausibility / date should always be in format yyyy-mm-dd
- Numeric precision/scale and non-negative quantities/amounts
- External ID vs internal ID patterns for key fields
- do not explicitly add any default value where null values are present
- check all field lengths if they match their data type length, unless a custom length/padding rule already governs that field

For EACH of the ${fieldCount} fields produce exactly 2 strong AI rules (keep descriptions concise). If a field already has a custom length/padding rule, both AI rules must be about other topics.
Use severity "error" for must-fix migration blockers, "warning" for data-quality advisories.
category should be one of: format, domain, range, referential, transformation, consistency.

Return ONLY valid JSON with this exact shape:
{
  "businessObject": "${businessObject}",
  "fields": [
    {
      "fieldName": "<exact fieldName from input>",
      "aiRules": [
        {
          "ruleName": "<specific creative rule name>",
          "type": "validation|transformation",
          "category": "format|domain|range|referential|transformation|consistency",
          "description": "<why this matters for SAP ${businessObject} migration>",
          "constraint": "<clear executable/plain-English check>",
          "severity": "error|warning"
        }
      ]
    }
  ]
}

Hard requirements:
- One entry per input fieldName (exact spelling).
- Never include Trim Whitespace, Null/Empty, or Duplicate Check.
- Never replace predefined rules.
- Never replace, duplicate, or contradict admin custom rules (especially material/MATNR length and leading-zero padding).
- No markdown, no comments, no trailing commas.
- Ensure the JSON is complete and parseable.`;
}

function normalizeAiRulesPayload(parsed, fields, customByField = new Map()) {
  const byName = new Map();

  for (const entry of parsed?.fields || []) {
    if (!entry?.fieldName) continue;
    const aiRules = Array.isArray(entry.aiRules)
      ? entry.aiRules
      : Array.isArray(entry.rules)
        ? entry.rules
        : [];
    byName.set(String(entry.fieldName).toUpperCase(), aiRules);
  }

  if (!byName.size && (parsed?.validation || parsed?.transformation)) {
    for (const rule of [
      ...(parsed.validation || []).map((r) => ({ ...r, type: r.type || "validation" })),
      ...(parsed.transformation || []).map((r) => ({
        ...r,
        type: r.type || "transformation",
      })),
    ]) {
      const name = String(rule.fieldName || "").toUpperCase();
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(rule);
    }
  }

  return (fields || []).map((field) => {
    const fieldKey = String(field.fieldName).toUpperCase();
    const customRules = lookupCustomRulesForField(field.fieldName, customByField);
    const aiRules = (byName.get(fieldKey) || []).filter((rule) => {
      const label = `${rule.ruleId || ""} ${rule.ruleName || ""} ${rule.rule || ""}`.toLowerCase();
      if (
        label.includes("trim whitespace") ||
        label.includes("null/empty") ||
        label.includes("null check") ||
        label.includes("duplicate check")
      ) {
        return false;
      }
      return !aiRuleConflictsWithCustom(rule, customRules);
    });
    return {
      fieldName: field.fieldName,
      aiRules,
    };
  });
}

function toSourceFieldsJson(businessObject, fields) {
  return {
    [businessObject]: {
      fields,
    },
  };
}

function customRulesForFields(_fields, customByField) {
  if (!customByField?.size) return [];
  return [...customByField.entries()].map(([fieldName, customRules]) => ({
    fieldName,
    customRules: (customRules || []).map((rule) => ({
      ruleName: rule.ruleName,
      type: rule.type,
      category: rule.category,
      description: rule.description,
      constraint: rule.constraint,
      severity: rule.severity,
    })),
  }));
}

async function generateAiRulesBatch(businessObject, fields, customByField = new Map()) {
  const sourceFieldsJson = toSourceFieldsJson(businessObject, fields);
  const customRulesForPrompt = customRulesForFields(fields, customByField);
  const maxTokens = Number(
    process.env.BEDROCK_RULES_MAX_TOKENS || DEFAULT_MAX_TOKENS,
  );

  const { text } = await converseText({
    systemText:
      "You are an SAP migration expert. Admin custom rules have the highest priority and must be considered first. Never contradict custom length/padding rules. Never repeat trim/null/duplicate predefined rules. Output only valid, complete JSON of additional field-specific AI rules. No markdown.",
    userText: buildPrompt(businessObject, sourceFieldsJson, customRulesForPrompt),
    maxTokens,
  });

  const parsed = parseJsonSafely(text);
  return normalizeAiRulesPayload(parsed, fields, customByField);
}

export async function generateAiRulesWithBedrock(
  businessObject,
  sourceFieldsJson,
  fields,
  customByField = new Map(),
) {
  const allFields =
    Array.isArray(fields) && fields.length > 0
      ? fields
      : sourceFieldsJson?.[businessObject]?.fields || [];

  if (!allFields.length) {
    return [];
  }

  const batchSize = Math.max(
    1,
    Number(process.env.BEDROCK_RULES_BATCH_SIZE || DEFAULT_BATCH_SIZE),
  );

  if (allFields.length <= batchSize) {
    return generateAiRulesBatch(businessObject, allFields, customByField);
  }

  const merged = [];
  for (let i = 0; i < allFields.length; i += batchSize) {
    const batch = allFields.slice(i, i + batchSize);
    const batchResult = await generateAiRulesBatch(
      businessObject,
      batch,
      customByField,
    );
    merged.push(...batchResult);
  }

  return merged;
}
