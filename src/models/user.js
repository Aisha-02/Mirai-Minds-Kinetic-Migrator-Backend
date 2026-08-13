import { query } from "../db.js";

export async function findUserByEmail(email) {
  const result = await query(
    `SELECT id, email, password_hash, role, created_at, updated_at
     FROM users
     WHERE email = $1
     LIMIT 1`,
    [email],
  );
  return result.rows[0] ?? null;
}

export async function findUserById(id) {
  const result = await query(
    `SELECT id, email, role, created_at, updated_at
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function createUser({ email, passwordHash, role = "normal_user" }) {
  const result = await query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, $2, $3)
     RETURNING id, email, role, created_at, updated_at`,
    [email, passwordHash, role],
  );
  return result.rows[0];
}

export function toPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}
