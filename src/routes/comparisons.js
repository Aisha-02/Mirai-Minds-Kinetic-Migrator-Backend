import fs from "fs";
import path from "path";
import { Router } from "express";
import multer from "multer";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getClient, query } from "../db.js";
import {
  createBatch,
  findBatchById,
  findBatchByIdForUser,
  findOpenBatchForUser,
} from "../models/batch.js";
import {
  createFileUpload,
  findUploadByBatchAndType,
  findUploadWithParsedData,
  findUploadWithParsedDataById,
  findUploadsByBatchId,
} from "../models/fileUpload.js";
import {
  createProcessingReport,
  completeReport,
  failReport,
  findReportByBatchId,
  markReportProcessing,
  toPublicReport,
} from "../models/comparisonReport.js";
import { compareDatasets } from "../services/comparisonEngine.js";
import { generateComparisonReport } from "../services/aiReportService.js";
import { buildComparisonReportPdf } from "../services/pdfReportService.js";
import { detectBusinessObject } from "../services/businessObjectDetector.js";
import {
  getBusinessObjectMetadata,
  SUPPORTED_BUSINESS_OBJECTS,
} from "../services/sapMetadataService.js";
import { validateColumnsAgainstSchema } from "../services/schemaValidation.js";
import {
  UPLOADS_ROOT,
  buildStoragePath,
  ensureUploadDir,
  isAllowedUploadFilename,
  parseUploadedFile,
  removeFileQuietly,
} from "../lib/uploadParse.js";

const router = Router();

const maxBytes = Number(process.env.UPLOAD_MAX_BYTES) || 5 * 1024 * 1024;
const db = { query };
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

ensureUploadDir(UPLOADS_ROOT);

async function resolveAccessibleBatch(req, batchId) {
  if (req.user.role === "admin") {
    return findBatchById(db, { batchId });
  }
  return findBatchByIdForUser(db, {
    batchId,
    userId: req.user.id,
  });
}

const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      const dest = path.join(UPLOADS_ROOT, "_tmp");
      try {
        ensureUploadDir(dest);
        cb(null, dest);
      } catch (err) {
        cb(err);
      }
    },
    filename(_req, file, cb) {
      const safe = String(file.originalname || "upload").replace(
        /[^a-zA-Z0-9._-]+/g,
        "_",
      );
      cb(null, `${Date.now()}-${safe}`);
    },
  }),
  limits: { fileSize: maxBytes, files: 1 },
  fileFilter(_req, file, cb) {
    if (!isAllowedUploadFilename(file.originalname)) {
      const err = new Error("Only .csv and .xlsx files are allowed");
      err.status = 400;
      return cb(err);
    }
    return cb(null, true);
  },
});

function uploadSingle(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        err.message = `File exceeds maximum size of ${maxBytes} bytes`;
      }
      err.status = 400;
    } else if (!err.status) {
      err.status = 400;
    }
    return next(err);
  });
}

function parseIdentifierColumns(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
      } catch {
        return [trimmed];
      }
    }
    return trimmed.includes(",")
      ? trimmed.split(",").map((part) => part.trim()).filter(Boolean)
      : [trimmed];
  }
  if (Array.isArray(raw)) {
    return raw.map(String).filter(Boolean);
  }
  return null;
}

function parseCompareColumns(raw) {
  if (raw == null) return undefined;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed.map(String) : undefined;
      } catch {
        return undefined;
      }
    }
    return trimmed.split(",").map((part) => part.trim()).filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw.map(String).filter(Boolean);
  }
  return undefined;
}

function parseBusinessObjectInput(raw) {
  if (raw == null) return null;
  const value = String(raw).trim().toUpperCase().replace(/\s+/g, "_");
  if (!value) return null;
  if (!SUPPORTED_BUSINESS_OBJECTS.includes(value)) return null;
  return value;
}

function collectColumns(rows) {
  const columns = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const key of Object.keys(row)) {
      if (String(key).trim()) columns.add(String(key).trim());
    }
  }
  return [...columns];
}

async function resolveBusinessObjectForPreload(parsedData, reqBody) {
  const manual = parseBusinessObjectInput(
    reqBody?.businessObject ?? reqBody?.business_object,
  );
  if (manual) {
    console.log(`[preload] using manual businessObject=${manual}`);
    return {
      ok: true,
      needsManualSelection: false,
      businessObject: manual,
      confidence: "high",
      reasoning: "Provided manually by the client",
      source: "manual",
    };
  }

  const columns = collectColumns(parsedData);
  const sampleRows = parsedData.slice(0, 5);
  console.log(
    `[preload] detecting business object from ${columns.length} columns, ${sampleRows.length} sample rows`,
  );
  const detection = await detectBusinessObject({ columns, sampleRows });
  console.log(
    `[preload] detection result ok=${detection.ok} object=${detection.businessObject || "-"} confidence=${detection.confidence || "-"} needsManual=${Boolean(detection.needsManualSelection)}`,
  );

  if (!detection.ok || detection.needsManualSelection) {
    return {
      ok: false,
      needsManualSelection: true,
      message:
        detection.message ||
        "Couldn't auto-detect — please select the business object manually",
      candidates: detection.candidates || [...SUPPORTED_BUSINESS_OBJECTS],
      detection: {
        businessObject: detection.businessObject ?? null,
        confidence: detection.confidence ?? null,
        reasoning: detection.reasoning ?? null,
        error: detection.error ?? null,
      },
      source: "auto",
    };
  }

  return {
    ok: true,
    needsManualSelection: false,
    businessObject: detection.businessObject,
    confidence: detection.confidence,
    reasoning: detection.reasoning,
    source: "auto",
  };
}

async function handleUpload(fileType, req, res, next) {
  let tempPath = req.file?.path ?? null;
  let finalPath = null;
  let client = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "A file is required (field name: file)" });
    }

    if (!isAllowedUploadFilename(req.file.originalname)) {
      removeFileQuietly(tempPath);
      return res.status(400).json({ error: "Only .csv and .xlsx files are allowed" });
    }

    const userId = req.user.id;

    // Parse while still in temp storage so preload detection can run before DB writes
    let parsedData;
    try {
      parsedData = parseUploadedFile(tempPath, req.file.originalname);
    } catch (parseErr) {
      removeFileQuietly(tempPath);
      parseErr.status = parseErr.status || 400;
      return next(parseErr);
    }

    if (!Array.isArray(parsedData) || parsedData.length === 0) {
      removeFileQuietly(tempPath);
      return res.status(400).json({ error: "File contains no data rows" });
    }

    let batchId;
    let preloadMeta = null;

    if (fileType === "preload") {
      const resolved = await resolveBusinessObjectForPreload(parsedData, req.body);
      if (!resolved.ok) {
        removeFileQuietly(tempPath);
        return res.status(422).json({
          needs_business_object: true,
          error: resolved.message,
          message: resolved.message,
          candidates: resolved.candidates,
          detection: resolved.detection,
        });
      }

      const metadata = await getBusinessObjectMetadata(resolved.businessObject);
      console.log(
        `[preload] sap metadata ok=${metadata.ok} object=${resolved.businessObject} cached=${metadata.cached ?? false} keys=${metadata.ok ? metadata.identifierColumns?.join(",") : metadata.error?.code}`,
      );
      if (!metadata.ok) {
        removeFileQuietly(tempPath);
        return res.status(502).json({
          error: "Failed to load SAP metadata for the detected business object",
          sap_error: metadata.error,
          business_object: resolved.businessObject,
        });
      }

      const columns = collectColumns(parsedData);
      const validation = validateColumnsAgainstSchema(columns, metadata.fields);

      // Hard-fail only when SAP key fields are absent — comparison cannot match rows.
      // Extra/missing non-key columns are warnings (files are often partial extracts).
      if (!validation.ok) {
        removeFileQuietly(tempPath);
        return res.status(400).json({
          error:
            validation.identifierColumns.length === 0
              ? "SAP metadata did not identify any key fields for this business object"
              : "Preload is missing required SAP key column(s) needed for comparison",
          business_object: resolved.businessObject,
          missing_key_columns: validation.missingKeyColumns,
          schema_warnings: validation.warnings,
        });
      }

      preloadMeta = {
        businessObject: resolved.businessObject,
        identifierColumns: validation.identifierColumns,
        schemaWarnings: validation.warnings,
        detectionConfidence: resolved.confidence,
        detectionSource: resolved.source,
        detectionReasoning: resolved.reasoning,
      };

      client = await getClient();
      await client.query("BEGIN");
      const batch = await createBatch(client, {
        userId,
        businessObject: preloadMeta.businessObject,
        identifierColumns: preloadMeta.identifierColumns,
        schemaWarnings: preloadMeta.schemaWarnings,
        detectionConfidence: preloadMeta.detectionConfidence,
        detectionSource: preloadMeta.detectionSource,
        detectionReasoning: preloadMeta.detectionReasoning,
      });
      batchId = batch.id;
    } else {
      const requestedBatchId =
        typeof req.body?.batch_id === "string" ? req.body.batch_id.trim() : "";

      if (requestedBatchId) {
        const batch = await findBatchByIdForUser(db, {
          batchId: requestedBatchId,
          userId,
        });
        if (!batch) {
          removeFileQuietly(tempPath);
          return res.status(404).json({ error: "Batch not found" });
        }
        batchId = batch.id;
      } else {
        const openBatch = await findOpenBatchForUser(userId);
        if (!openBatch) {
          removeFileQuietly(tempPath);
          return res.status(400).json({
            error:
              "No open preload batch found; upload a preload file first or pass batch_id",
          });
        }
        batchId = openBatch.id;
      }

      client = await getClient();
      await client.query("BEGIN");

      const preload = await findUploadByBatchAndType(client, {
        batchId,
        fileType: "preload",
      });
      if (!preload) {
        await client.query("ROLLBACK");
        client.release();
        client = null;
        removeFileQuietly(tempPath);
        return res.status(400).json({
          error: "This batch has no preload file; upload preload first",
        });
      }

      const existingPostload = await findUploadByBatchAndType(client, {
        batchId,
        fileType: "postload",
      });
      if (existingPostload) {
        await client.query("ROLLBACK");
        client.release();
        client = null;
        removeFileQuietly(tempPath);
        return res.status(409).json({
          error: "This batch already has a postload file",
        });
      }
    }

    finalPath = buildStoragePath({
      userId,
      batchId,
      fileType,
      originalFilename: req.file.originalname,
    });
    ensureUploadDir(path.dirname(finalPath));
    fs.renameSync(tempPath, finalPath);
    tempPath = null;

    const uploadRow = await createFileUpload(client, {
      userId,
      batchId,
      fileType,
      originalFilename: req.file.originalname,
      storagePath: finalPath,
      parsedData,
    });

    await client.query("COMMIT");
    client.release();
    client = null;

    const response = {
      batch_id: batchId,
      file_type: fileType,
      upload: {
        id: uploadRow.id,
        original_filename: uploadRow.original_filename,
        row_count: parsedData.length,
        uploaded_at: uploadRow.uploaded_at,
      },
    };

    if (preloadMeta) {
      response.business_object = preloadMeta.businessObject;
      response.identifier_columns = preloadMeta.identifierColumns;
      response.schema_warnings = preloadMeta.schemaWarnings;
      response.detection = {
        source: preloadMeta.detectionSource,
        confidence: preloadMeta.detectionConfidence,
        reasoning: preloadMeta.detectionReasoning,
      };
    }

    return res.status(201).json(response);
  } catch (err) {
    removeFileQuietly(tempPath);
    removeFileQuietly(finalPath);
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      }
      client.release();
      client = null;
    }

    if (err?.code === "23505") {
      return res.status(409).json({
        error: `A ${fileType} file already exists for this batch`,
      });
    }
    return next(err);
  }
}

router.post(
  "/upload-preload",
  requireAuth,
  requireRole("normal_user"),
  uploadSingle,
  (req, res, next) => handleUpload("preload", req, res, next),
);

router.post(
  "/upload-postload",
  requireAuth,
  requireRole("normal_user"),
  uploadSingle,
  (req, res, next) => handleUpload("postload", req, res, next),
);

/**
 * Synchronous run: no job queue exists in this project.
 * Uploads are capped (~5MB), parsed data is already in DB, and AI generation
 * is bounded by GROQ/BEDROCK timeout — so we process inline and return the
 * final report (200 completed / 502 failed after persistence).
 */
router.post(
  "/:batchId/run",
  requireAuth,
  requireRole("normal_user"),
  async (req, res, next) => {
    let reportId = null;

    try {
      const batchId = String(req.params.batchId || "").trim();
      if (!UUID_RE.test(batchId)) {
        return res.status(400).json({ error: "Invalid batch_id" });
      }

      const batch = await findBatchByIdForUser(db, {
        batchId,
        userId: req.user.id,
      });
      if (!batch) {
        return res.status(404).json({ error: "Batch not found" });
      }

      const identifierColumns =
        parseIdentifierColumns(
          req.body?.identifierColumns ?? req.body?.identifier_columns,
        ) ||
        (Array.isArray(batch.identifier_columns) &&
        batch.identifier_columns.length > 0
          ? batch.identifier_columns
          : null);

      if (!identifierColumns || identifierColumns.length === 0) {
        return res.status(400).json({
          error:
            "identifierColumns is required (no key fields were stored on this batch from preload detection)",
        });
      }

      const compareColumns = parseCompareColumns(
        req.body?.compareColumns ?? req.body?.compare_columns,
      );

      const preload = await findUploadWithParsedData(db, {
        batchId,
        fileType: "preload",
      });
      const postload = await findUploadWithParsedData(db, {
        batchId,
        fileType: "postload",
      });

      if (!preload || !postload) {
        return res.status(400).json({
          error:
            "Both preload and postload files are required before running a comparison",
        });
      }

      const existing = await findReportByBatchId(db, { batchId });
      if (existing?.status === "processing") {
        return res.status(409).json({
          error: "A comparison is already processing for this batch",
          report: toPublicReport(existing),
        });
      }

      let report;
      if (existing) {
        report = await markReportProcessing(db, { reportId: existing.id });
      } else {
        report = await createProcessingReport(db, { batchId });
      }
      reportId = report.id;

      const preloadRows = Array.isArray(preload.parsed_data)
        ? preload.parsed_data
        : [];
      const postloadRows = Array.isArray(postload.parsed_data)
        ? postload.parsed_data
        : [];

      const summary = compareDatasets(preloadRows, postloadRows, {
        identifierColumns,
        ...(compareColumns ? { compareColumns } : {}),
      });

      const aiResult = await generateComparisonReport(summary);

      if (!aiResult.ok) {
        const failed = await failReport(db, {
          reportId,
          summaryJson: summary,
          errorMessage:
            aiResult.error?.message ||
            aiResult.error?.details ||
            "AI report generation failed",
        });
        return res.status(502).json({
          error: "Comparison finished but AI report generation failed",
          report: toPublicReport(failed),
          ai_error: aiResult.error,
        });
      }

      const completed = await completeReport(db, {
        reportId,
        summaryJson: summary,
        aiReportText: aiResult.reportText,
      });

      return res.status(200).json({
        report: toPublicReport(completed),
        provider: aiResult.provider,
        model_id: aiResult.modelId,
      });
    } catch (err) {
      if (reportId) {
        try {
          await failReport(db, {
            reportId,
            errorMessage: err.message || "Comparison failed",
          });
        } catch {
          // ignore secondary persistence errors
        }
      }
      return next(err);
    }
  },
);

router.get(
  "/:batchId/files",
  requireAuth,
  requireRole("normal_user", "admin"),
  async (req, res, next) => {
    try {
      const batchId = String(req.params.batchId || "").trim();
      if (!UUID_RE.test(batchId)) {
        return res.status(400).json({ error: "Invalid batch_id" });
      }

      const batch = await resolveAccessibleBatch(req, batchId);
      if (!batch) {
        return res.status(404).json({ error: "Batch not found" });
      }

      const uploads = await findUploadsByBatchId(db, { batchId });
      return res.status(200).json({
        batch_id: batchId,
        files: uploads.map((row) => ({
          id: row.id,
          file_type: row.file_type,
          original_filename: row.original_filename,
          uploaded_at: row.uploaded_at,
          row_count: Number(row.row_count) || 0,
        })),
      });
    } catch (err) {
      return next(err);
    }
  },
);

router.get(
  "/:batchId/files/:uploadId",
  requireAuth,
  requireRole("normal_user", "admin"),
  async (req, res, next) => {
    try {
      const batchId = String(req.params.batchId || "").trim();
      const uploadId = String(req.params.uploadId || "").trim();
      if (!UUID_RE.test(batchId) || !UUID_RE.test(uploadId)) {
        return res.status(400).json({ error: "Invalid batch_id or upload id" });
      }

      const batch = await resolveAccessibleBatch(req, batchId);
      if (!batch) {
        return res.status(404).json({ error: "Batch not found" });
      }

      const upload = await findUploadWithParsedDataById(db, {
        uploadId,
        batchId,
      });
      if (!upload) {
        return res.status(404).json({ error: "Upload not found for this batch" });
      }

      const rows = Array.isArray(upload.parsed_data) ? upload.parsed_data : [];
      const columns =
        rows.length > 0 && rows[0] && typeof rows[0] === "object"
          ? Object.keys(rows[0])
          : [];

      return res.status(200).json({
        batch_id: batchId,
        file: {
          id: upload.id,
          file_type: upload.file_type,
          original_filename: upload.original_filename,
          uploaded_at: upload.uploaded_at,
          row_count: rows.length,
          columns,
          rows,
        },
      });
    } catch (err) {
      return next(err);
    }
  },
);

router.get(
  "/:batchId/report/download",
  requireAuth,
  requireRole("normal_user", "admin"),
  async (req, res, next) => {
    try {
      const batchId = String(req.params.batchId || "").trim();
      if (!UUID_RE.test(batchId)) {
        return res.status(400).json({ error: "Invalid batch_id" });
      }

      const batch = await resolveAccessibleBatch(req, batchId);
      if (!batch) {
        return res.status(404).json({ error: "Batch not found" });
      }

      const report = await findReportByBatchId(db, { batchId });
      if (!report) {
        return res.status(404).json({ error: "No report found for this batch" });
      }

      if (report.status !== "completed" && !report.ai_report_text && !report.summary_json) {
        return res.status(409).json({
          error: "Report is not ready to download yet",
          status: report.status,
        });
      }

      // On-demand PDF: no download/cache pattern exists in this project, and
      // reports can be re-run (summary/narrative change), so we build from
      // current DB fields each request instead of storing a PDF blob.
      const pdfBuffer = await buildComparisonReportPdf({
        batchId,
        summaryJson: report.summary_json,
        aiReportText: report.ai_report_text,
        generatedAt: report.completed_at || report.created_at || new Date(),
      });

      const filename = `comparison-report-${batchId}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      res.setHeader("Content-Length", pdfBuffer.length);
      return res.status(200).send(pdfBuffer);
    } catch (err) {
      return next(err);
    }
  },
);

router.get(
  "/:batchId/report",
  requireAuth,
  requireRole("normal_user"),
  async (req, res, next) => {
    try {
      const batchId = String(req.params.batchId || "").trim();
      if (!UUID_RE.test(batchId)) {
        return res.status(400).json({ error: "Invalid batch_id" });
      }

      const batch = await findBatchByIdForUser(db, {
        batchId,
        userId: req.user.id,
      });
      if (!batch) {
        return res.status(404).json({ error: "Batch not found" });
      }

      const report = await findReportByBatchId(db, { batchId });
      if (!report) {
        return res.status(404).json({ error: "No report found for this batch" });
      }

      return res.status(200).json({ report: toPublicReport(report) });
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
