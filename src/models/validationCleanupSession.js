import { query } from "../db.js";

export async function createCleanupSession({
  userId,
  filename,
  businessObject,
  detectorLabel,
  detection,
  ruleSetId,
  rulesSnapshot,
  originalData,
  currentData,
  findings,
  report,
  summary,
  chatMessages = [],
}) {
  const result = await query(
    `INSERT INTO validation_cleanup_sessions (
       user_id, filename, business_object, detector_label, detection,
       rule_set_id, rules_snapshot, original_data, current_data,
       findings, report, summary, chat_messages
     ) VALUES (
       $1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9::jsonb,
       $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb
     )
     RETURNING *`,
    [
      userId,
      filename,
      businessObject,
      detectorLabel ?? null,
      JSON.stringify(detection ?? null),
      ruleSetId ?? null,
      JSON.stringify(rulesSnapshot),
      JSON.stringify(originalData),
      JSON.stringify(currentData),
      JSON.stringify(findings),
      JSON.stringify(report ?? null),
      JSON.stringify(summary ?? null),
      JSON.stringify(chatMessages),
    ],
  );
  return result.rows[0];
}

export async function findCleanupSessionForUser({ sessionId, userId }) {
  const result = await query(
    `SELECT * FROM validation_cleanup_sessions
     WHERE id = $1 AND user_id = $2
     LIMIT 1`,
    [sessionId, userId],
  );
  return result.rows[0] ?? null;
}

export async function updateCleanupSession(sessionId, patch) {
  const fields = [];
  const values = [];
  let i = 1;

  const map = {
    currentData: "current_data",
    findings: "findings",
    report: "report",
    summary: "summary",
    pendingProposal: "pending_proposal",
    chatMessages: "chat_messages",
  };

  for (const [key, column] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      fields.push(`${column} = $${i}::jsonb`);
      values.push(JSON.stringify(patch[key]));
      i += 1;
    }
  }

  if (fields.length === 0) {
    return findCleanupSessionById(sessionId);
  }

  fields.push("updated_at = NOW()");
  values.push(sessionId);

  const result = await query(
    `UPDATE validation_cleanup_sessions
     SET ${fields.join(", ")}
     WHERE id = $${i}
     RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function findCleanupSessionById(sessionId) {
  const result = await query(
    `SELECT * FROM validation_cleanup_sessions WHERE id = $1 LIMIT 1`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

export function toPublicCleanupSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    filename: session.filename,
    businessObject: session.business_object,
    detectorLabel: session.detector_label,
    detection: session.detection,
    ruleSetId: session.rule_set_id,
    findings: session.findings,
    report: session.report,
    summary: session.summary,
    pendingProposal: session.pending_proposal,
    chatMessages: session.chat_messages,
    rowCount: Array.isArray(session.current_data)
      ? session.current_data.length
      : 0,
    previewRows: Array.isArray(session.current_data)
      ? session.current_data.slice(0, 20)
      : [],
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
}
