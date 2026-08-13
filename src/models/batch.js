import { query } from "../db.js";

const BATCH_SELECT = `id, user_id, created_at, business_object, identifier_columns,
       schema_warnings, detection_confidence, detection_source, detection_reasoning`;

export async function createBatch(
  db,
  {
    userId,
    businessObject = null,
    identifierColumns = [],
    schemaWarnings = null,
    detectionConfidence = null,
    detectionSource = null,
    detectionReasoning = null,
  },
) {
  const result = await db.query(
    `INSERT INTO batches (
       user_id, business_object, identifier_columns, schema_warnings,
       detection_confidence, detection_source, detection_reasoning
     )
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     RETURNING ${BATCH_SELECT}`,
    [
      userId,
      businessObject,
      identifierColumns,
      schemaWarnings == null ? null : JSON.stringify(schemaWarnings),
      detectionConfidence,
      detectionSource,
      detectionReasoning,
    ],
  );
  return result.rows[0];
}

export async function findBatchByIdForUser(db, { batchId, userId }) {
  const result = await db.query(
    `SELECT ${BATCH_SELECT}
     FROM batches
     WHERE id = $1 AND user_id = $2
     LIMIT 1`,
    [batchId, userId],
  );
  return result.rows[0] ?? null;
}

export async function findBatchById(db, { batchId }) {
  const result = await db.query(
    `SELECT ${BATCH_SELECT}
     FROM batches
     WHERE id = $1
     LIMIT 1`,
    [batchId],
  );
  return result.rows[0] ?? null;
}

export async function findOpenBatchForUser(userId) {
  const result = await query(
    `SELECT b.id, b.user_id, b.created_at, b.business_object, b.identifier_columns,
            b.schema_warnings, b.detection_confidence, b.detection_source,
            b.detection_reasoning
     FROM batches b
     WHERE b.user_id = $1
       AND EXISTS (
         SELECT 1 FROM file_uploads f
         WHERE f.batch_id = b.id AND f.file_type = 'preload'
       )
       AND NOT EXISTS (
         SELECT 1 FROM file_uploads f
         WHERE f.batch_id = b.id AND f.file_type = 'postload'
       )
     ORDER BY b.created_at DESC
     LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

function summaryCounts(summaryJson) {
  if (!summaryJson || typeof summaryJson !== "object") return null;
  const keys = [
    "missingRecords",
    "missingValues",
    "valueMismatches",
    "duplicateRecords",
    "baselineDuplicates",
    "extraRecords",
  ];
  const counts = {};
  let total = 0;
  for (const key of keys) {
    const n = Array.isArray(summaryJson[key]) ? summaryJson[key].length : 0;
    counts[key] = n;
    total += n;
  }
  counts.total = total;
  return counts;
}

export async function listBatchesForUser(
  db,
  { userId, limit = 20, offset = 0 },
) {
  const pageSize = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const pageOffset = Math.max(Number(offset) || 0, 0);

  const countResult = await db.query(
    `SELECT COUNT(*)::int AS total FROM batches WHERE user_id = $1`,
    [userId],
  );
  const total = countResult.rows[0]?.total ?? 0;

  const result = await db.query(
    `SELECT
        b.id AS batch_id,
        b.created_at,
        b.business_object,
        b.detection_confidence,
        pre.original_filename AS preload_filename,
        pre.uploaded_at AS preload_uploaded_at,
        post.original_filename AS postload_filename,
        post.uploaded_at AS postload_uploaded_at,
        r.status AS report_status,
        r.completed_at AS report_completed_at,
        r.summary_json
     FROM batches b
     LEFT JOIN file_uploads pre
       ON pre.batch_id = b.id AND pre.file_type = 'preload'
     LEFT JOIN file_uploads post
       ON post.batch_id = b.id AND post.file_type = 'postload'
     LEFT JOIN comparison_reports r
       ON r.batch_id = b.id
     WHERE b.user_id = $1
     ORDER BY b.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, pageSize, pageOffset],
  );

  return {
    total,
    limit: pageSize,
    offset: pageOffset,
    batches: result.rows.map((row) => ({
      batch_id: row.batch_id,
      created_at: row.created_at,
      business_object: row.business_object,
      detection_confidence: row.detection_confidence,
      preload: row.preload_filename
        ? {
            filename: row.preload_filename,
            uploaded_at: row.preload_uploaded_at,
          }
        : null,
      postload: row.postload_filename
        ? {
            filename: row.postload_filename,
            uploaded_at: row.postload_uploaded_at,
          }
        : null,
      status: row.report_status || "pending",
      report_completed_at: row.report_completed_at,
      summary: summaryCounts(row.summary_json),
    })),
  };
}
