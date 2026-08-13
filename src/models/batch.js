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
