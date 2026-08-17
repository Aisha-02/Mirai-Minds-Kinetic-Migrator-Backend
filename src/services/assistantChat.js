import { converseText } from "./bedrockClient.js";

export const ASSISTANT_SCOPES = ["admin-rules", "mapping"];

const MAX_RULES = 80;
const MAX_MAPPINGS = 80;
const MAX_TEXT = 400;
const MAX_HISTORY = 12;
const MAX_REPLY_TOKENS = 1024;

function clip(value, max = MAX_TEXT) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function selectionLabel(selected) {
  if (selected === false) return "crossed/excluded";
  if (selected === null) return "pending/unselected";
  if (selected === true) return "ticked/included";
  return "included (legacy)";
}

function sanitizeAdminRulesContext(context = {}) {
  const checks = context.predefinedChecks || {};
  const rules = Array.isArray(context.rules) ? context.rules.slice(0, MAX_RULES) : [];

  return {
    businessObject: clip(context.businessObject, 80),
    predefinedChecks: {
      trim: checks.trim !== false,
      nullCheck: checks.nullCheck !== false,
      duplicates: checks.duplicates !== false,
    },
    rules: rules.map((rule) => ({
      fieldName: clip(rule.fieldName, 80),
      ruleName: clip(rule.ruleName, 120),
      source: clip(rule.source, 20),
      description: clip(rule.description || rule.constraint),
      constraint: clip(rule.constraint),
      severity: clip(rule.severity, 20),
      selection: selectionLabel(rule.selected),
    })),
  };
}

function sanitizeMappingContext(context = {}) {
  const mappings = Array.isArray(context.mappings)
    ? context.mappings.slice(0, MAX_MAPPINGS)
    : [];

  return {
    businessObject: clip(context.businessObject, 80),
    mappings: mappings.map((row) => ({
      sourceField: clip(row.sourceField, 80),
      sapField: clip(row.sapField, 80) || null,
      confidenceScore: Number(row.confidenceScore) || 0,
      confidencePercent: `${Math.round((Number(row.confidenceScore) || 0) * 100)}%`,
      reasoning: clip(row.reasoning),
    })),
  };
}

function formatInstructions() {
  return [
    "Format every reply in compact Markdown so it is easy to scan:",
    "- Start with a short ## heading (Answer, Mapping, or Rule).",
    "- Use ### subheadings for sections such as Why, Details, or Next step.",
    "- Use bullet lists for facts. Keep each bullet to one line when possible.",
    "- Put field names, rule names, and SAP targets in `backticks`.",
    "- Use **Label:** value for key facts (Confidence, Status, Source, Target).",
    "- Short paragraphs only. No walls of text. No preamble like 'Sure' or 'Of course'.",
  ].join("\n");
}

function systemPromptForScope(scope, context) {
  if (scope === "admin-rules") {
    const payload = sanitizeAdminRulesContext(context);
    return [
      "You are the Kinetic Migrator admin assistant for validation rules on the current Admin page.",
      "Answer only questions about these AI-recommended rules, custom validations, and predefined checks.",
      "Ground every answer in the JSON context: use each rule's description/constraint as the rationale, and respect tick/cross/pending plus predefined on/off state.",
      "If the user asks about mapping, SAP field mapping, confidence scores, or anything not in this rules context, refuse and say you can only discuss the rules and checks on this Admin page.",
      "Do not invent rules that are not listed. If a rationale field is empty, say that no stored rationale is available.",
      formatInstructions(),
      "Context JSON:",
      JSON.stringify(payload),
    ].join("\n");
  }

  const payload = sanitizeMappingContext(context);
  return [
    "You are the Kinetic Migrator mapping assistant for the current Mapping/Analysis page.",
    "Answer only questions about the source-to-SAP field mappings on screen.",
    "Ground every answer in the JSON context: sourceField, sapField, confidenceScore, and reasoning for that row.",
    "If asked why a confidence score is low/high, use that row's reasoning and score. Do not invent mapping reasons.",
    "If the user asks about validation rules, predefined checks, tick/cross state, or anything not in this mapping context, refuse and say you can only discuss the mappings on this page.",
    formatInstructions(),
    "For mapping answers, prefer this shape:",
    "## Mapping",
    "- **Source:** `FIELD`",
    "- **SAP target:** `FIELD` or unmapped",
    "- **Confidence:** 72%",
    "### Why",
    "- one-line reason from the stored reasoning",
    "Context JSON:",
    JSON.stringify(payload),
  ].join("\n");
}

function sanitizeHistory(messages) {
  const cleaned = [];
  for (const message of messages || []) {
    const role = String(message?.role || "").toLowerCase();
    const content = String(message?.content || "").trim();
    if (!content) continue;
    if (role !== "user" && role !== "assistant") continue;
    cleaned.push({ role, content: clip(content, 2000) });
  }
  return cleaned.slice(-MAX_HISTORY);
}

export async function answerAssistantChat({ scope, messages, context }) {
  if (!ASSISTANT_SCOPES.includes(scope)) {
    const error = new Error('scope must be "admin-rules" or "mapping"');
    error.status = 400;
    throw error;
  }

  const history = sanitizeHistory(messages);
  if (!history.length || history[history.length - 1].role !== "user") {
    const error = new Error("messages must end with a user turn");
    error.status = 400;
    throw error;
  }

  const { text, modelId } = await converseText({
    systemText: systemPromptForScope(scope, context),
    messages: history,
    maxTokens: MAX_REPLY_TOKENS,
  });

  return { reply: text, modelId, scope };
}
