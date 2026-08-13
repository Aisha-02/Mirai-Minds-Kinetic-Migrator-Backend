import { Router } from "express";
import multer from "multer";
import { mapDetectorToRulesBusinessObject } from "../constants/businessObjectMap.js";
import { BUSINESS_OBJECTS, isBusinessObject } from "../constants/businessObjects.js";
import {
  isAllowedUploadFilename,
  parseUploadedBuffer,
} from "../lib/uploadParse.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { detectBusinessObject } from "../services/businessObjectDetector.js";
import { runValidationRulesLambda } from "../services/lambdaValidationRunner.js";
import { SUPPORTED_BUSINESS_OBJECTS } from "../services/sapMetadataService.js";

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
 * Upload preload → AI detect BO → Lambda fetches validation_rules & returns findings.
 * Findings only — no row transforms / cleanup mutations.
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

      const columns = collectColumns(rows);
      const sampleRows = rows.slice(0, 5);
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
        const detected = await detectBusinessObject({ columns, sampleRows });
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

      const lambdaResult = await runValidationRulesLambda({
        businessObject: rulesBusinessObject,
        rows,
      });

      return res.status(200).json({
        filename: req.file.originalname,
        rowCount: rows.length,
        columns,
        detection,
        rulesBusinessObject,
        ruleSet: lambdaResult.ruleSet,
        summary: lambdaResult.summary,
        findings: lambdaResult.findings,
        report: {
          ...lambdaResult.report,
          filename: req.file.originalname,
          totalRows: rows.length,
        },
        previewRows: lambdaResult.previewRows || rows.slice(0, 20),
        evaluator: String(process.env.VALIDATION_LAMBDA_MODE || "local"),
      });
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
