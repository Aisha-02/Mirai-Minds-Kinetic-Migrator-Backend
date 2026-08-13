import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  createTransformationDocument,
  deleteTransformationDocument,
  findTransformationDocumentById,
  listTransformationDocuments,
} from "../models/transformationDocument.js";

const router = Router();
const db = { query };

const UPLOAD_ROOT = path.resolve(
  process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads"),
  "transformation-documents",
);

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await fs.mkdir(UPLOAD_ROOT, { recursive: true });
        cb(null, UPLOAD_ROOT);
      } catch (err) {
        cb(err);
      }
    },
    filename: (_req, file, cb) => {
      const safe = String(file.originalname || "document")
        .replace(/[^\w.\-()+\s]/g, "_")
        .slice(0, 180);
      cb(null, `${Date.now()}-${safe}`);
    },
  }),
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
      if (!req.file) {
        return res.status(400).json({ error: "file is required" });
      }

      const saved = await createTransformationDocument(db, {
        label,
        category,
        originalFilename: req.file.originalname,
        storagePath: req.file.path,
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

      const filePath = path.resolve(doc.storage_path);
      if (!filePath.startsWith(UPLOAD_ROOT)) {
        return res.status(400).json({ error: "Invalid document path" });
      }

      try {
        await fs.access(filePath);
      } catch {
        return res.status(404).json({ error: "Document file is missing on server" });
      }

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${doc.original_filename}"`,
      );
      if (doc.mime_type) {
        res.setHeader("Content-Type", doc.mime_type);
      }

      return res.sendFile(filePath);
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
        await fs.unlink(removed.storage_path);
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
