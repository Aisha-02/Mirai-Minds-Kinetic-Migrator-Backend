export async function listTransformationDocuments(db) {
  const result = await db.query(
    `SELECT id, label, category, original_filename, mime_type, file_size, created_at
     FROM transformation_documents
     ORDER BY category ASC, created_at DESC`,
  );
  return result.rows;
}

export async function findTransformationDocumentById(db, id) {
  const result = await db.query(
    `SELECT id, label, category, original_filename, storage_path, mime_type, file_size, created_at
     FROM transformation_documents
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function createTransformationDocument(
  db,
  {
    label,
    category,
    originalFilename,
    storagePath,
    mimeType,
    fileSize,
    uploadedBy,
  },
) {
  const result = await db.query(
    `INSERT INTO transformation_documents (
       label, category, original_filename, storage_path, mime_type, file_size, uploaded_by
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, label, category, original_filename, mime_type, file_size, created_at`,
    [
      label,
      category,
      originalFilename,
      storagePath,
      mimeType ?? null,
      fileSize ?? null,
      uploadedBy ?? null,
    ],
  );
  return result.rows[0];
}

export async function deleteTransformationDocument(db, id) {
  const result = await db.query(
    `DELETE FROM transformation_documents
     WHERE id = $1
     RETURNING id, storage_path`,
    [id],
  );
  return result.rows[0] ?? null;
}
