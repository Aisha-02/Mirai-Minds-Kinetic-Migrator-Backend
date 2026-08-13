/**
 * Grok / Groq OpenAI-compatible chat completions for ADDITIONAL field rules only.
 * API key stays server-side (GROK_API_KEY).
 */

function extractJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    throw new Error("LLM returned an empty response");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1].trim());
    }

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }

    throw new Error("LLM response was not valid JSON");
  }
}

function buildPrompt(businessObject, sourceFieldsJson) {
  return `You are a senior SAP MDG / data-migration architect with deep expertise in S/4HANA ${businessObject} master/transactional data quality.

Business Object: ${businessObject}

Field metadata JSON (use key, dataType, length, defaultValue when present):
${JSON.stringify(sourceFieldsJson, null, 2)}

IMPORTANT — the application ALREADY enforces these PREDEFINED rules on every field. Do NOT repeat them:
1. Trim Whitespace
2. Null/Empty Value Check (mandatory when key = "X")
3. Duplicate Check (mandatory uniqueness when key = "X")

Your task: invent ADDITIONAL, high-value, field-specific validation and transformation rules that a real SAP migration project would need.

Be creative and practical. Prefer rules that catch real migration defects, for example:
- SAP domain semantics (MATNR, EBELN, LIFNR, KUNNR, BUKRS, WERKS, HKONT, WAERS, MEINS, DATS, TIMS, QUAN, CURR)
- Check-digit / number-range / leading-zero padding (ALPHA conversion)
- Allowed value lists / domain fixed values / ISO codes (currency, UoM, language, country)
- Cross-field consistency hints described for this field (e.g. net weight ≤ gross weight)
- Plant/company-code organizational existence format checks
- Forbidden characters, uppercase enforcement, no embedded blanks
- Date not in future / fiscal-period plausibility
- Numeric precision/scale and non-negative quantities/amounts
- External ID vs internal ID patterns for key fields

For EACH field produce 2–4 strong AI rules when metadata allows (at least 1 if possible).
Use severity "error" for must-fix migration blockers, "warning" for data-quality advisories.
category should be one of: format, domain, range, referential, transformation, consistency.

Return ONLY this JSON:
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
- No markdown outside JSON.`;
}

function normalizeAiRulesPayload(parsed, fields) {
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

  // Legacy shape fallback: flat validation/transformation arrays
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

  return (fields || []).map((field) => ({
    fieldName: field.fieldName,
    aiRules: (byName.get(String(field.fieldName).toUpperCase()) || []).filter(
      (rule) => {
        const label = `${rule.ruleId || ""} ${rule.ruleName || ""} ${rule.rule || ""}`.toLowerCase();
        return !(
          label.includes("trim whitespace") ||
          label.includes("null/empty") ||
          label.includes("null check") ||
          label.includes("duplicate check")
        );
      },
    ),
  }));
}

export async function generateAiRulesWithGrok(businessObject, sourceFieldsJson, fields) {
  const apiKey =
    process.env.GROK_API_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.XAI_API_KEY;
  const baseUrl = (
    process.env.GROK_BASE_URL || "https://api.groq.com/openai/v1"
  ).replace(/\/$/, "");
  const model =
    process.env.GROK_MODEL ||
    process.env.GROQ_MODEL_ID ||
    "llama-3.3-70b-versatile";

  if (!apiKey) {
    const error = new Error(
      "GROQ_API_KEY (or GROK_API_KEY) is required server-side for AI rule generation",
    );
    error.status = 500;
    throw error;
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: Number(
        process.env.GROK_TEMPERATURE || process.env.GROQ_TEMPERATURE || 0.3,
      ),
      max_tokens: Number(
        process.env.GROK_MAX_TOKENS || process.env.GROQ_MAX_TOKENS || 4096,
      ),
      messages: [
        {
          role: "system",
          content:
            "You are an SAP migration expert. Output only valid JSON of creative field-specific AI rules. Never repeat trim/null/duplicate predefined rules. No markdown.",
        },
        {
          role: "user",
          content: buildPrompt(businessObject, sourceFieldsJson),
        },
      ],
    }),
  });

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    const error = new Error(`Grok API returned non-JSON (${response.status})`);
    error.status = response.status || 502;
    throw error;
  }

  if (!response.ok) {
    const message =
      data?.error?.message || data?.message || `Grok API error (${response.status})`;
    const error = new Error(message);
    error.status =
      response.status >= 400 && response.status < 600 ? response.status : 502;
    throw error;
  }

  const text = data?.choices?.[0]?.message?.content ?? "";
  const parsed = extractJson(text);
  return normalizeAiRulesPayload(parsed, fields);
}

/** @deprecated */
export const generateRulesWithGrok = generateAiRulesWithGrok;
