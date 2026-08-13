import { query } from "../db.js";

export async function findReportByBatchId(db, { batchId }) {
  const result = await db.query(
    `SELECT id, batch_id, status, summary_json, ai_report_text,
            created_at, completed_at, error_message
     FROM comparison_reports
     WHERE batch_id = $1
     LIMIT 1`,
    [batchId],
  );
  return result.rows[0] ?? null;
}

export async function createProcessingReport(db, { batchId }) {
  const result = await db.query(
    `INSERT INTO comparison_reports (batch_id, status)
     VALUES ($1, 'processing')
     RETURNING id, batch_id, status, summary_json, ai_report_text,
               created_at, completed_at, error_message`,
    [batchId],
  );
  return result.rows[0];
}

export async function markReportProcessing(db, { reportId }) {
  const result = await db.query(
    `UPDATE comparison_reports
     SET status = 'processing',
         summary_json = NULL,
         ai_report_text = NULL,
         error_message = NULL,
         completed_at = NULL
     WHERE id = $1
     RETURNING id, batch_id, status, summary_json, ai_report_text,
               created_at, completed_at, error_message`,
    [reportId],
  );
  return result.rows[0];
}

export async function completeReport(db, { reportId, summaryJson, aiReportText }) {
  const result = await db.query(
    `UPDATE comparison_reports
     SET status = 'completed',
         summary_json = $2::jsonb,
         ai_report_text = $3,
         error_message = NULL,
         completed_at = NOW()
     WHERE id = $1
     RETURNING id, batch_id, status, summary_json, ai_report_text,
               created_at, completed_at, error_message`,
    [reportId, JSON.stringify(summaryJson), aiReportText],
  );
  return result.rows[0];
}

export async function failReport(db, { reportId, errorMessage, summaryJson = null }) {
  const result = await db.query(
    `UPDATE comparison_reports
     SET status = 'failed',
         summary_json = COALESCE($2::jsonb, summary_json),
         error_message = $3,
         completed_at = NOW()
     WHERE id = $1
     RETURNING id, batch_id, status, summary_json, ai_report_text,
               created_at, completed_at, error_message`,
    [
      reportId,
      summaryJson == null ? null : JSON.stringify(summaryJson),
      errorMessage,
    ],
  );
  return result.rows[0];
}

export function toPublicReport(report) {
  if (!report) return null;
  return {
    id: report.id,
    batch_id: report.batch_id,
    status: report.status,
    summary_json: report.summary_json,
    ai_report_text: report.ai_report_text,
    error_message: report.error_message,
    created_at: report.created_at,
    completed_at: report.completed_at,
  };
}

/** Convenience when no transaction client is needed */
export async function findReportByBatchIdForQuery(batchId) {
  return findReportByBatchId({ query }, { batchId });
}
