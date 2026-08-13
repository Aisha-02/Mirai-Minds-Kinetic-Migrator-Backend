import { query } from "../db.js";

/**
 * Persist Business Object + field-wise AI rules only.
 * rules shape:
 * {
 *   businessObject: "MM",
 *   fields: [{ fieldName: "MATNR", rules: [{ ruleName, source: "AI", ... }] }]
 * }
 */
export async function createValidationRules({
  businessObject,
  rules,
  createdBy,
}) {
  const result = await query(
    `INSERT INTO validation_rules (business_object, rules, created_by)
     VALUES ($1, $2::jsonb, $3)
     RETURNING id, business_object, rules, created_by, created_at, updated_at`,
    [businessObject, JSON.stringify(rules), createdBy ?? null],
  );
  return result.rows[0];
}

export async function listValidationRules({ businessObject, limit = 50 } = {}) {
  const params = [];
  let sql = `SELECT id, business_object, rules, created_by, created_at, updated_at
             FROM validation_rules`;

  if (businessObject) {
    params.push(businessObject);
    sql += ` WHERE business_object = $${params.length}`;
  }

  params.push(Math.min(Number(limit) || 50, 200));
  sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;

  const result = await query(sql, params);
  return result.rows;
}

export async function findValidationRulesById(id) {
  const result = await query(
    `SELECT id, business_object, rules, created_by, created_at, updated_at
     FROM validation_rules
     WHERE id = $1
     LIMIT 1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Latest saved rule set for a business object (MM | PO | GL Account | BP). */
export async function findLatestValidationRulesByBusinessObject(businessObject) {
  const result = await query(
    `SELECT id, business_object, rules, created_by, created_at, updated_at
     FROM validation_rules
     WHERE business_object = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [businessObject],
  );
  return result.rows[0] ?? null;
}
