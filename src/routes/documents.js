import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  createTransformationDocument,
  deleteTransformationDocument,
  findTransformationDocumentById,
  listTransformationDocuments,
} from "../models/transformationDocument.js";
import {
  assertS3Configured,
  buildSignedDownloadResponse,
  buildTransformationDocKey,
  deleteFile,
  uploadFile,
} from "../services/s3Service.js";

const router = Router();
const db = { query };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.UPLOAD_MAX_BYTES || 5 * 1024 * 1024),
  },
});

const ALLOWED_CATEGORIES = new Set([
  "source_rule",
  "validation_rule",
  "mapping_files",
]);

router.get(
  "/transformation",
  requireAuth,
  requireRole("normal_user", "admin"),
  async (_req, res, next) => {
    try {
      const documents = await listTransformationDocuments(db);
      return res.status(200).json({ documents });
    } catch (err) {
      return next(err);
    }
  },
);

router.post(
  "/transformation",
  requireAuth,
  requireRole("admin"),
  upload.single("file"),
  async (req, res, next) => {
    try {
      assertS3Configured();

      const label = String(req.body?.label || "").trim();
      const category = String(req.body?.category || "").trim();

      if (!label) {
        return res.status(400).json({ error: "label is required" });
      }
      if (!ALLOWED_CATEGORIES.has(category)) {
        return res.status(400).json({
          error: `category must be one of: ${[...ALLOWED_CATEGORIES].join(", ")}`,
        });
      }
      if (!req.file?.buffer) {
        return res.status(400).json({ error: "file is required" });
      }

      const documentId = randomUUID();
      const s3Key = buildTransformationDocKey({
        documentId,
        originalFilename: req.file.originalname,
      });

      await uploadFile({
        key: s3Key,
        body: req.file.buffer,
        contentType: req.file.mimetype || "application/octet-stream",
      });

      const saved = await createTransformationDocument(db, {
        id: documentId,
        label,
        category,
        originalFilename: req.file.originalname,
        storagePath: s3Key,
        mimeType: req.file.mimetype,
        fileSize: req.file.size,
        uploadedBy: req.user.id,
      });

      return res.status(201).json({ document: saved });
    } catch (err) {
      return next(err);
    }
  },
);

router.get(
  "/transformation/:id/download",
  requireAuth,
  requireRole("normal_user", "admin"),
  async (req, res, next) => {
    try {
      const doc = await findTransformationDocumentById(db, req.params.id);
      if (!doc) {
        return res.status(404).json({ error: "Document not found" });
      }

      if (!doc.storage_path) {
        return res.status(404).json({ error: "Document file is missing" });
      }

      const payload = await buildSignedDownloadResponse(
        doc.storage_path,
        doc.original_filename,
      );
      return res.status(200).json(payload);
    } catch (err) {
      return next(err);
    }
  },
);

router.delete(
  "/transformation/:id",
  requireAuth,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const removed = await deleteTransformationDocument(db, req.params.id);
      if (!removed) {
        return res.status(404).json({ error: "Document not found" });
      }

      try {
        await deleteFile(removed.storage_path);
      } catch {
        // file may already be gone
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
