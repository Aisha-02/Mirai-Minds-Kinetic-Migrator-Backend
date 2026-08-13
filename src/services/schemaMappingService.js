/**
 * AI-generated field mapping between uploaded source schema and SAP metadata.
 * Uses the shared Bedrock converseText client — no duplicate Bedrock setup.
 */

import { FIELD_EQUIVALENCE_GROUPS } from "../constants/fieldColumnAliases.js";
import { converseText } from "./bedrockClient.js";

const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_MAX_TOKENS = 8192;

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
  error.code = "MALFORMED_RESPONSE";
  error.status = 502;
  throw error;
}

function normalizeConfidenceScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num > 1 && num <= 100) return Math.min(1, Math.max(0, num / 100));
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

function buildAliasHints() {
  return FIELD_EQUIVALENCE_GROUPS.map((group) => group.join(" ≈ ")).join("\n");
}

function buildMappingPrompt({
  businessObject,
  sapBusinessObject,
  sourceFields,
  sapFields,
}) {
  const sourceJson = JSON.stringify(sourceFields, null, 2);
  const sapJson = JSON.stringify(sapFields, null, 2);

  return `You are a senior SAP S/4HANA data-migration architect mapping legacy/source extract fields to SAP technical field names.

Business object (rules label): ${businessObject}
SAP metadata business object: ${sapBusinessObject}

Source schema fields (user upload — map each sourceField exactly once):
${sourceJson}

SAP metadata fields (valid sapField targets — use exact fieldName values only):
${sapJson}

Known column alias equivalences (use as hints, not exhaustive):
${buildAliasHints()}

Task: For EVERY source field, pick the best matching SAP field from the SAP metadata list.
- Prefer semantic matches (e.g. MATERIAL_NUMBER → MATNR, PO_NUMBER → EBELN).
- Consider data types and lengths when available.
- If no good SAP match exists, set sapField to null and confidenceScore below 0.3.
- confidenceScore must be a number from 0 to 1 (e.g. 0.92). Higher = more certain.
- reasoning: one concise sentence explaining the match or why unmatched.

Return ONLY valid JSON with this exact shape:
{
  "businessObject": "${businessObject}",
  "mappings": [
    {
      "sourceField": "<exact source fieldName>",
      "sapField": "<exact SAP fieldName or null>",
      "confidenceScore": 0.0,
      "reasoning": "<short explanation>"
    }
  ]
}

Hard requirements:
- One mapping entry per source field (exact sourceField spelling from input).
- sapField must be null or one of the SAP fieldName values provided.
- No markdown, no comments, no trailing commas.
- Ensure the JSON is complete and parseable.`;
}

function normalizeMappingPayload(parsed, sourceFields, sapFieldNames) {
  const sapSet = new Set(
    (sapFieldNames || []).map((name) => String(name).toUpperCase()),
  );
  const bySource = new Map();

  for (const entry of parsed?.mappings || parsed?.fields || []) {
    if (!entry?.sourceField) continue;
    const sourceField = String(entry.sourceField).trim();
    let sapField = entry.sapField == null ? null : String(entry.sapField).trim();
    if (sapField && !sapSet.has(sapField.toUpperCase())) {
      const match = (sapFieldNames || []).find(
        (name) => name.toUpperCase() === sapField.toUpperCase(),
      );
      sapField = match || null;
    }
    if (sapField && !sapSet.has(sapField.toUpperCase())) {
      sapField = null;
    }

    bySource.set(sourceField.toUpperCase(), {
      sourceField,
      sapField: sapField || null,
      confidenceScore: normalizeConfidenceScore(entry.confidenceScore),
      reasoning: String(entry.reasoning || entry.reason || "").trim(),
    });
  }

  return (sourceFields || []).map((field) => {
    const key = String(field.fieldName).toUpperCase();
    const existing = bySource.get(key);
    if (existing) return existing;
    return {
      sourceField: field.fieldName,
      sapField: null,
      confidenceScore: 0,
      reasoning: "No mapping returned by AI for this field",
    };
  });
}

async function generateMappingBatch({
  businessObject,
  sapBusinessObject,
  sourceFields,
  sapFields,
}) {
  const maxTokens = Number(
    process.env.BEDROCK_MAPPING_MAX_TOKENS || DEFAULT_MAX_TOKENS,
  );

  const { text } = await converseText({
    systemText:
      "You are an SAP migration mapping expert. Output only valid, complete JSON mapping source fields to SAP metadata fields. No markdown.",
    userText: buildMappingPrompt({
      businessObject,
      sapBusinessObject,
      sourceFields,
      sapFields,
    }),
    maxTokens,
  });

  const parsed = parseJsonSafely(text);
  const sapFieldNames = sapFields.map((field) => field.fieldName);
  return normalizeMappingPayload(parsed, sourceFields, sapFieldNames);
}

/**
 * Generate AI field mappings from source schema fields and SAP metadata.
 *
 * @param {{
 *   businessObject: string,
 *   sapBusinessObject: string,
 *   sourceFields: Array<{ fieldName: string, dataType?: string, length?: unknown, key?: string, defaultValue?: string }>,
 *   sapFields: Array<{ fieldName: string, dataType?: string | null, length?: number | null, isKey?: boolean }>,
 * }} params
 * @returns {Promise<{ mappings: Array<{ sourceField: string, sapField: string | null, confidenceScore: number, reasoning: string }> }>}
 */
export async function generateSchemaMapping({
  businessObject,
  sapBusinessObject,
  sourceFields,
  sapFields,
}) {
  const fields = Array.isArray(sourceFields) ? sourceFields : [];
  const sapMetadataFields = Array.isArray(sapFields) ? sapFields : [];

  if (!fields.length) {
    const error = new Error("Source schema must include at least one field");
    error.status = 400;
    throw error;
  }

  if (!sapMetadataFields.length) {
    const error = new Error("SAP metadata contains no fields for mapping");
    error.code = "NO_METADATA";
    error.status = 502;
    throw error;
  }

  const batchSize = Math.max(
    1,
    Number(process.env.BEDROCK_MAPPING_BATCH_SIZE || DEFAULT_BATCH_SIZE),
  );

  if (fields.length <= batchSize) {
    const mappings = await generateMappingBatch({
      businessObject,
      sapBusinessObject,
      sourceFields: fields,
      sapFields: sapMetadataFields,
    });
    return { mappings };
  }

  const merged = [];
  for (let i = 0; i < fields.length; i += batchSize) {
    const batch = fields.slice(i, i + batchSize);
    const batchResult = await generateMappingBatch({
      businessObject,
      sapBusinessObject,
      sourceFields: batch,
      sapFields: sapMetadataFields,
    });
    merged.push(...batchResult);
  }

  return { mappings: merged };
}
