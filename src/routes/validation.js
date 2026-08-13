import { Router } from "express";
import multer from "multer";
import {
  mapDetectorToRulesBusinessObject,
  mapRulesBusinessObjectToDetector,
} from "../constants/businessObjectMap.js";
import { BUSINESS_OBJECTS, isBusinessObject } from "../constants/businessObjects.js";
import {
  buildRefinedFilename,
  isAllowedUploadFilename,
  parseUploadedBuffer,
  serializeRowsToBuffer,
} from "../lib/uploadParse.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { detectBusinessObject } from "../services/businessObjectDetector.js";
import { runValidationRulesLambda } from "../services/lambdaValidationRunner.js";
import {
  SUPPORTED_BUSINESS_OBJECTS,
  mapPreloadToSapFields,
} from "../services/sapMetadataService.js";
import { findValidationRulesById } from "../models/validationRules.js";
import {
  createCleanupSession,
  findCleanupSessionForUser,
  toPublicCleanupSession,
  updateCleanupSession,
} from "../models/validationCleanupSession.js";
import { runValidationAutoFix } from "../services/validationAutoFixService.js";
import { alignValidationOutputToSapFields } from "../services/validationColumnMapping.js";
import { remapRowsToPreloadColumns, remapRowsToSapColumns } from "../constants/fieldColumnAliases.js";

const router = Router();

const maxBytes = Number(process.env.UPLOAD_MAX_BYTES) || 5 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxBytes },
  fileFilter(_req, file, cb) {
    if (!isAllowedUploadFilename(file.originalname)) {
      const error = new Error("Only .csv and .xlsx files are allowed");
      error.status = 400;
      return cb(error);
    }
    return cb(null, true);
  },
});

function collectColumns(rows) {
  const columns = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row || {})) {
      columns.add(key);
    }
  }
  return [...columns];
}

/**
 * Upload preload → detect BO → map descriptive columns to SAP names →
 * evaluate rules → persist session → return findings on SAP field names.
 */
router.post(
  "/execute-cleanup",
  requireAuth,
  requireRole("normal_user", "admin"),
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file?.buffer) {
        return res
          .status(400)
          .json({ error: "A file is required (field name: file)" });
      }

      let rows;
      try {
        rows = parseUploadedBuffer(req.file.buffer, req.file.originalname);
      } catch (parseErr) {
        parseErr.status = parseErr.status || 400;
        return next(parseErr);
      }

      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: "File contains no data rows" });
      }

      const originalRows = rows;
      const originalColumns = collectColumns(originalRows);
      const sampleRows = originalRows.slice(0, 5);
      const manualBo = String(
        req.body?.businessObject || req.body?.business_object || "",
      ).trim();

      let detection;
      let detectorLabel;
      let rulesBusinessObject;

      if (manualBo) {
        if (isBusinessObject(manualBo)) {
          rulesBusinessObject = manualBo;
          detectorLabel = manualBo;
        } else {
          const mapped = mapDetectorToRulesBusinessObject(manualBo);
          if (!mapped) {
            return res.status(400).json({
              error: `Unsupported businessObject. Use one of: ${BUSINESS_OBJECTS.join(", ")} or ${SUPPORTED_BUSINESS_OBJECTS.join(", ")}`,
            });
          }
          rulesBusinessObject = mapped;
          detectorLabel = String(manualBo).toUpperCase().replace(/\s+/g, "_");
        }
        detection = {
          source: "manual",
          businessObject: detectorLabel,
          confidence: "high",
          reasoning: "Manually selected by user",
        };
      } else {
        const detected = await detectBusinessObject({
          columns: originalColumns,
          sampleRows,
        });
        if (!detected.ok) {
          return res.status(422).json({
            needs_business_object: true,
            error:
              detected.message ||
              detected.error?.message ||
              "Could not auto-detect business object",
            detection: {
              businessObject: detected.businessObject ?? null,
              confidence: detected.confidence ?? null,
              reasoning: detected.reasoning ?? null,
              error: detected.error ?? null,
            },
            candidates: detected.candidates || [...SUPPORTED_BUSINESS_OBJECTS],
          });
        }

        detectorLabel = detected.businessObject;
        rulesBusinessObject = mapDetectorToRulesBusinessObject(detectorLabel);
        if (!rulesBusinessObject) {
          return res.status(422).json({
            error: `Detected ${detectorLabel}, but no validation_rules mapping exists (supported: ${BUSINESS_OBJECTS.join(", ")})`,
            detection: {
              source: "auto",
              businessObject: detectorLabel,
              confidence: detected.confidence,
              reasoning: detected.reasoning,
            },
          });
        }

        detection = {
          source: "auto",
          businessObject: detectorLabel,
          confidence: detected.confidence,
          reasoning: detected.reasoning,
          modelId: detected.modelId,
        };
      }

      const sapBusinessObject =
        mapRulesBusinessObjectToDetector(detectorLabel) ||
        mapRulesBusinessObjectToDetector(rulesBusinessObject) ||
        detectorLabel;

      const sapMapping = await mapPreloadToSapFields(
        originalRows,
        sapBusinessObject,
      );
      const mappedRows = sapMapping.rows;
      const columnMapping = sapMapping.columnMapping;
      const columns = sapMapping.sapColumns;
      const sapFieldNames = sapMapping.sapFieldNames || columns;

      const lambdaResult = await runValidationRulesLambda({
        businessObject: rulesBusinessObject,
        rows: mappedRows,
      });

      const aligned = alignValidationOutputToSapFields(
        lambdaResult.findings,
        lambdaResult.report,
        columnMapping,
      );

      const ruleSetRow = await findValidationRulesById(lambdaResult.ruleSet.id);
      const rulesSnapshot = ruleSetRow?.rules ?? { businessObject: rulesBusinessObject };

      const session = await createCleanupSession({
        userId: req.user.id,
        filename: req.file.originalname,
        businessObject: rulesBusinessObject,
        detectorLabel,
        detection,
        ruleSetId: lambdaResult.ruleSet.id,
        rulesSnapshot,
        originalData: originalRows,
        currentData: mappedRows,
        findings: aligned.findings,
        report: {
          ...aligned.report,
          filename: req.file.originalname,
          totalRows: mappedRows.length,
          columnMapping,
          originalColumns,
          sapColumns: columns,
          sapFieldNames,
          sapMetadataUsed: sapMapping.sapMetadataUsed,
        },
        summary: lambdaResult.summary,
      });

      return res.status(200).json({
        sessionId: session.id,
        filename: req.file.originalname,
        rowCount: mappedRows.length,
        columns,
        originalColumns,
        columnMapping,
        sapMetadataUsed: sapMapping.sapMetadataUsed,
        detection,
        rulesBusinessObject,
        ruleSet: lambdaResult.ruleSet,
        summary: lambdaResult.summary,
        findings: aligned.findings,
        report: {
          ...aligned.report,
          filename: req.file.originalname,
          totalRows: mappedRows.length,
          columnMapping,
          originalColumns,
          sapColumns: columns,
          sapFieldNames,
          sapMetadataUsed: sapMapping.sapMetadataUsed,
        },
        previewRows: remapRowsToPreloadColumns(
          mappedRows.slice(0, 20),
          columnMapping,
          originalColumns,
        ),
        evaluator: String(process.env.VALIDATION_LAMBDA_MODE || "local"),
      });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * Apply auto-fix transforms to SAP-mapped rows and store preload_refined data.
 */
router.post(
  "/sessions/:sessionId/auto-fix",
  requireAuth,
  requireRole("normal_user", "admin"),
  async (req, res, next) => {
    try {
      const session = await findCleanupSessionForUser({
        sessionId: req.params.sessionId,
        userId: req.user.id,
      });

      if (!session) {
        return res.status(404).json({ error: "Validation session not found" });
      }

      const rows = Array.isArray(session.current_data) ? session.current_data : [];
      const findings = Array.isArray(session.findings) ? session.findings : [];

      const autoFix = await runValidationAutoFix({
        rows,
        findings,
        filename: session.filename,
        columnMapping: session.report?.columnMapping || {},
        originalColumns: session.report?.originalColumns || [],
        sapFieldNames: session.report?.sapFieldNames || session.report?.sapColumns || [],
      });

      const updatedReport = {
        ...(session.report || {}),
        autoFix: {
          ready: true,
          refinedFilename: autoFix.refinedFilename,
          columnMapping: autoFix.columnMapping,
          fixesApplied: autoFix.fixesApplied,
          fixesSkipped: autoFix.fixesSkipped,
          appliedFixes: autoFix.appliedFixes,
          skippedFixes: autoFix.skippedFixes,
          sapMetadataUsed: autoFix.sapMetadataUsed,
          rowCount: autoFix.rowCount,
        },
      };

      await updateCleanupSession(session.id, {
        currentData: autoFix.refinedRows,
        report: updatedReport,
      });

      return res.status(200).json({
        sessionId: session.id,
        ok: true,
        refinedFilename: autoFix.refinedFilename,
        columnMapping: autoFix.columnMapping,
        fixesApplied: autoFix.fixesApplied,
        fixesSkipped: autoFix.fixesSkipped,
        appliedFixes: autoFix.appliedFixes,
        skippedFixes: autoFix.skippedFixes,
        sapMetadataUsed: autoFix.sapMetadataUsed,
        rowCount: autoFix.rowCount,
        previewRefinedRows: autoFix.previewRefinedRows,
      });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * Download the refined preload file (SAP column headers, fixes applied).
 */
router.get(
  "/sessions/:sessionId/download-refined",
  requireAuth,
  requireRole("normal_user", "admin"),
  async (req, res, next) => {
    try {
      const session = await findCleanupSessionForUser({
        sessionId: req.params.sessionId,
        userId: req.user.id,
      });

      if (!session) {
        return res.status(404).json({ error: "Validation session not found" });
      }

      const refinedRows = Array.isArray(session.current_data)
        ? session.current_data
        : [];
      if (!refinedRows.length) {
        return res.status(400).json({ error: "No refined data available" });
      }

      const refinedFilename =
        session.report?.autoFix?.refinedFilename ||
        buildRefinedFilename(session.filename);

      const exportRows = remapRowsToSapColumns(
        refinedRows,
        session.report?.columnMapping || {},
        session.report?.sapFieldNames || session.report?.sapColumns || [],
      );

      const buffer = serializeRowsToBuffer(exportRows, session.filename);
      const contentType = refinedFilename.endsWith(".csv")
        ? "text/csv; charset=utf-8"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

      res.setHeader("Content-Type", contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${refinedFilename}"`,
      );
      return res.send(buffer);
    } catch (err) {
      return next(err);
    }
  },
);

router.get(
  "/sessions/:sessionId",
  requireAuth,
  requireRole("normal_user", "admin"),
  async (req, res, next) => {
    try {
      const session = await findCleanupSessionForUser({
        sessionId: req.params.sessionId,
        userId: req.user.id,
      });
      if (!session) {
        return res.status(404).json({ error: "Validation session not found" });
      }
      return res.json({ session: toPublicCleanupSession(session) });
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
