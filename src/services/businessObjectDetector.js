import { SUPPORTED_BUSINESS_OBJECTS } from "./sapMetadataService.js";
import { converseText, mapBedrockError } from "./bedrockClient.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_SAMPLE_ROWS = 5;

const ALLOWED_LABELS = [...SUPPORTED_BUSINESS_OBJECTS, "NONE_MATCHED"];
const ACCEPTABLE_CONFIDENCE = new Set(["high", "medium"]);

/**
 * Defensively extract the first JSON object from a model response
 * (handles prose wrappers and ```json fences).
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
export function extractJsonObject(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? raw).trim();

  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // fall through to brace scan
  }

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

export function buildDetectionPrompt({ columns, sampleRows }) {
  return `You are classifying an SAP migration preload dataset into exactly one business object type.

Allowed values for businessObject (exactly one):
${ALLOWED_LABELS.map((label) => `- ${label}`).join("\n")}

Rules:
- Choose NONE_MATCHED if the dataset does not clearly match one type.
- confidence must be one of: high, medium, low
- Respond with STRICT JSON only — no markdown, no prose outside JSON.
- JSON shape:
{"businessObject":"MATERIAL_MASTER","confidence":"high","reasoning":"short explanation"}

Column headers:
${JSON.stringify(columns)}

Sample rows (up to ${DEFAULT_SAMPLE_ROWS}):
${JSON.stringify(sampleRows)}`;
}

function normalizeConfidence(value) {
  const confidence = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["high", "medium", "low"].includes(confidence)) return confidence;
  return "low";
}

function normalizeBusinessObjectLabel(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

/**
 * @param {{ columns: string[], sampleRows?: Record<string, unknown>[] }} input
 * @param {{
 *   modelId?: string,
 *   timeoutMs?: number,
 * }} [options]
 */
export async function detectBusinessObject(input, options = {}) {
  const columns = Array.isArray(input?.columns)
    ? input.columns.map(String)
    : [];
  const sampleRows = Array.isArray(input?.sampleRows)
    ? input.sampleRows.slice(0, DEFAULT_SAMPLE_ROWS)
    : [];

  if (columns.length === 0) {
    return {
      ok: false,
      needsManualSelection: true,
      error: {
        code: "INVALID_INPUT",
        message: "No column headers available for business object detection",
      },
    };
  }

  const timeoutMs = Number(
    options.timeoutMs ?? process.env.BEDROCK_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const { text, modelId } = await converseText({
      userText: buildDetectionPrompt({ columns, sampleRows }),
      temperature: 0,
      maxTokens: 400,
      modelId: options.modelId,
      timeoutMs,
    });

    const parsed = extractJsonObject(text);
    if (!parsed) {
      return {
        ok: false,
        needsManualSelection: true,
        error: {
          code: "MALFORMED_RESPONSE",
          message:
            "Could not parse a JSON business-object classification from the model response",
          details: String(text ?? "").slice(0, 300),
        },
      };
    }

    const businessObject = normalizeBusinessObjectLabel(parsed.businessObject);
    const confidence = normalizeConfidence(parsed.confidence);
    const reasoning = String(parsed.reasoning ?? "").trim();

    if (!ALLOWED_LABELS.includes(businessObject)) {
      return {
        ok: false,
        needsManualSelection: true,
        businessObject: "NONE_MATCHED",
        confidence: "low",
        reasoning: reasoning || "Model returned an unsupported label",
        error: {
          code: "UNSUPPORTED_LABEL",
          message: `Model returned unsupported business object '${parsed.businessObject}'`,
        },
      };
    }

    const needsManualSelection =
      businessObject === "NONE_MATCHED" ||
      !ACCEPTABLE_CONFIDENCE.has(confidence);

    if (needsManualSelection) {
      return {
        ok: false,
        needsManualSelection: true,
        businessObject,
        confidence,
        reasoning,
        message:
          "Couldn't auto-detect — please select the business object manually",
        candidates: [...SUPPORTED_BUSINESS_OBJECTS],
      };
    }

    return {
      ok: true,
      needsManualSelection: false,
      businessObject,
      confidence,
      reasoning,
      modelId,
    };
  } catch (err) {
    const mapped = err?.code ? err : mapBedrockError(err);
    const code = mapped.code || "BEDROCK_ERROR";
    const message = mapped.message || err?.message || "Business object detection failed";
    const timedOut = code === "TIMEOUT";

    return {
      ok: false,
      needsManualSelection: true,
      error: {
        code: timedOut ? "TIMEOUT" : code === "THROTTLED" ? "THROTTLED" : code,
        message: timedOut
          ? "Business object detection timed out"
          : message,
        details: mapped.details || err?.details,
      },
      candidates: [...SUPPORTED_BUSINESS_OBJECTS],
      message:
        "Couldn't auto-detect — please select the business object manually",
    };
  }
}
