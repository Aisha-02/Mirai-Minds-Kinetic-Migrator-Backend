import { query } from "../db.js";

export async function findSourceSchemaByUserAndHash(userId, fileHash) {
  const result = await query(
    `SELECT id, created_by, original_filename, file_hash, source_fields, s3_key, created_at
     FROM admin_source_schemas
     WHERE created_by = $1 AND file_hash = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, fileHash],
  );
  return result.rows[0] ?? null;
}

export async function findSourceSchemaByIdForUser(id, userId) {
  const result = await query(
    `SELECT id, created_by, original_filename, file_hash, source_fields, s3_key, created_at
     FROM admin_source_schemas
     WHERE id = $1 AND created_by = $2
     LIMIT 1`,
    [id, userId],
  );
  return result.rows[0] ?? null;
}

export async function createSourceSchema({
  createdBy,
  originalFilename,
  fileHash,
  sourceFields,
  s3Key = null,
}) {
  const result = await query(
    `INSERT INTO admin_source_schemas
       (created_by, original_filename, file_hash, source_fields, s3_key)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id, created_by, original_filename, file_hash, source_fields, s3_key, created_at`,
    [
      createdBy,
      originalFilename,
      fileHash,
      JSON.stringify(sourceFields),
      s3Key,
    ],
  );
  return result.rows[0];
}

export async function upsertWorkspaceState(userId, {
  activeSourceSchemaId = null,
  selectedBusinessObject = null,
} = {}) {
  const result = await query(
    `INSERT INTO admin_workspace_state (user_id, active_source_schema_id, selected_business_object, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       active_source_schema_id = COALESCE(EXCLUDED.active_source_schema_id, admin_workspace_state.active_source_schema_id),
       selected_business_object = COALESCE(EXCLUDED.selected_business_object, admin_workspace_state.selected_business_object),
       updated_at = NOW()
     RETURNING user_id, active_source_schema_id, selected_business_object, updated_at`,
    [userId, activeSourceSchemaId, selectedBusinessObject],
  );
  return result.rows[0];
}

export async function getWorkspaceState(userId) {
  const result = await query(
    `SELECT user_id, active_source_schema_id, selected_business_object, updated_at
     FROM admin_workspace_state
     WHERE user_id = $1
     LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function clearWorkspaceState(userId) {
  await query(
    `UPDATE admin_workspace_state
     SET active_source_schema_id = NULL,
         selected_business_object = NULL,
         updated_at = NOW()
     WHERE user_id = $1`,
    [userId],
  );
}

export async function findSchemaMapping(sourceSchemaId, businessObject) {
  const result = await query(
    `SELECT id, source_schema_id, business_object, sap_business_object, mappings, created_by, created_at
     FROM admin_schema_mappings
     WHERE source_schema_id = $1 AND business_object = $2
     LIMIT 1`,
    [sourceSchemaId, businessObject],
  );
  return result.rows[0] ?? null;
}

export async function upsertSchemaMapping({
  sourceSchemaId,
  businessObject,
  sapBusinessObject,
  mappings,
  createdBy,
  outputS3Key = null,
}) {
  const result = await query(
    `INSERT INTO admin_schema_mappings
       (source_schema_id, business_object, sap_business_object, mappings, created_by, output_s3_key)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (source_schema_id, business_object) DO UPDATE SET
       sap_business_object = EXCLUDED.sap_business_object,
       mappings = EXCLUDED.mappings,
       created_by = EXCLUDED.created_by,
       output_s3_key = COALESCE(EXCLUDED.output_s3_key, admin_schema_mappings.output_s3_key),
       created_at = NOW()
     RETURNING id, source_schema_id, business_object, sap_business_object, mappings, created_by, created_at, output_s3_key`,
    [
      sourceSchemaId,
      businessObject,
      sapBusinessObject,
      JSON.stringify(mappings),
      createdBy ?? null,
      outputS3Key,
    ],
  );
  return result.rows[0];
}

export async function findRulesDraft(sourceSchemaId, businessObject) {
  const result = await query(
    `SELECT id, source_schema_id, business_object, rules, created_by, created_at
     FROM admin_rules_drafts
     WHERE source_schema_id = $1 AND business_object = $2
     LIMIT 1`,
    [sourceSchemaId, businessObject],
  );
  return result.rows[0] ?? null;
}

export async function upsertRulesDraft({
  sourceSchemaId,
  businessObject,
  rules,
  createdBy,
  outputS3Key = null,
}) {
  const result = await query(
    `INSERT INTO admin_rules_drafts (source_schema_id, business_object, rules, created_by, output_s3_key)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (source_schema_id, business_object) DO UPDATE SET
       rules = EXCLUDED.rules,
       created_by = EXCLUDED.created_by,
       output_s3_key = COALESCE(EXCLUDED.output_s3_key, admin_rules_drafts.output_s3_key),
       created_at = NOW()
     RETURNING id, source_schema_id, business_object, rules, created_by, created_at, output_s3_key`,
    [
      sourceSchemaId,
      businessObject,
      JSON.stringify(rules),
      createdBy ?? null,
      outputS3Key,
    ],
  );
  return result.rows[0];
}

export async function deleteDraftsForSchema(sourceSchemaId, userId) {
  await query(
    `DELETE FROM admin_schema_mappings m
     USING admin_source_schemas s
     WHERE m.source_schema_id = s.id
       AND s.id = $1
       AND s.created_by = $2`,
    [sourceSchemaId, userId],
  );
  await query(
    `DELETE FROM admin_rules_drafts d
     USING admin_source_schemas s
     WHERE d.source_schema_id = s.id
       AND s.id = $1
       AND s.created_by = $2`,
    [sourceSchemaId, userId],
  );
}
