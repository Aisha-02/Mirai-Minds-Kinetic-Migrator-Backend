import { randomUUID } from "crypto";
import { Router } from "express";
import multer from "multer";
import {
  mapDetectorToRulesBusinessObject,
  mapRulesBusinessObjectToDetector,
} from "../constants/businessObjectMap.js";
import { BUSINESS_OBJECTS, isBusinessObject } from "../constants/businessObjects.js";
import {
  buildRefinedFilename,
  contentTypeForFilename,
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
import {
  findLatestValidationRulesByBusinessObject,
  findLatestValidationRulesGrouped,
  findValidationRulesById,
} from "../models/validationRules.js";
import {
  createCleanupSession,
  findCleanupSessionForUser,
  toPublicCleanupSession,
  updateCleanupSession,
} from "../models/validationCleanupSession.js";
import { runValidationAutoFix } from "../services/validationAutoFixService.js";
import {
  buildRefinedValidationKey,
  buildSignedDownloadResponse,
  buildValidationInputKey,
  uploadFile,
} from "../services/s3Service.js";
import { isValidationEngineConfigured, runValidationEngine } from "../services/validationEngineClient.js";
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

function parseS3KeysFromBody(body) {
  const raw = body?.s3Keys ?? body?.s3Key ?? body?.inputs;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (typeof item === "string" ? { s3Key: item } : item))
      .filter((item) => item?.s3Key);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return parseS3KeysFromBody({ s3Keys: parsed });
    } catch {
      return trimmed.split(",").map((key) => ({ s3Key: key.trim() })).filter((item) => item.s3Key);
    }
  }
  return [];
}

/**
 * Upload preload file(s) to S3, pass saved validation_rules to the Python
 * engine, and return per-scenario parsed output keys for download.
 */
router.post(
  "/execute-preload",
  requireAuth,
  requireRole("normal_user", "admin"),
  upload.array("files", 20),
  async (req, res, next) => {
    try {
      const jobId = String(req.body?.jobId || randomUUID());
      const files = Array.isArray(req.files) ? req.files : [];
      const inputRefs = parseS3KeysFromBody(req.body);

      for (const [index, file] of files.entries()) {
        if (!isAllowedUploadFilename(file.originalname)) {
          return res.status(400).json({ error: "Only .csv and .xlsx files are allowed" });
        }
        const key = buildValidationInputKey({
          jobId,
          originalFilename: file.originalname,
          index,
        });
        await uploadFile({
          key,
          body: file.buffer,
          contentType: contentTypeForFilename(file.originalname),
        });
        inputRefs.push({ s3Key: key, filename: file.originalname });
      }

      if (!inputRefs.length) {
        return res.status(400).json({
          error: "Upload one or more files (field name: files) or pass s3Key/s3Keys",
        });
      }

      const ruleRows = await findLatestValidationRulesGrouped();
      if (!ruleRows.length) {
        return res.status(404).json({
          error: "No saved validation rules. Generate and save rules in Admin first.",
        });
      }

      const rulesByBusinessObject = Object.fromEntries(
        ruleRows.map((row) => [row.business_object, row.rules]),
      );

      const engineResult = await runValidationEngine({
        jobId,
        inputs: inputRefs,
        rulesByBusinessObject,
        outputFormat: req.body?.outputFormat || undefined,
      });

      const scenarios = [];
      for (const scenario of engineResult.scenarios || []) {
        let download = null;
        try {
          download = await buildSignedDownloadResponse(
            scenario.s3Key,
            scenario.filename,
          );
        } catch (err) {
          console.error("[validation] signed URL failed:", err.message);
        }
        scenarios.push({ ...scenario, download });
      }

      return res.status(200).json({
        ok: true,
        jobId: engineResult.jobId || jobId,
        scenarios,
        unclassified: engineResult.unclassified || [],
        errors: engineResult.errors || [],
        ruleSets: ruleRows.map((row) => ({
          id: row.id,
          businessObject: row.business_object,
          createdAt: row.created_at,
        })),
      });
    } catch (err) {
      return next(err);
    }
  },
);

function toDetectorLabel(manualBo) {
  if (isBusinessObject(manualBo)) {
    return mapRulesBusinessObjectToDetector(manualBo);
  }
  return String(manualBo).toUpperCase().replace(/\s+/g, "_");
}

/**
 * Evaluate the same parsed rows the cleanup session will store, via FastAPI.
 * Serializes first-sheet rows so the engine sees the same data Node parsed.
 */
async function evaluateCleanupWithFastApi({
  rows,
  filename,
  forcedBusinessObject,
}) {
  const ruleRows = await findLatestValidationRulesGrouped();
  if (!ruleRows.length) {
    const err = new Error(
      "No saved validation rules. Generate and save rules in Admin first.",
    );
    err.status = 404;
    throw err;
  }

  const jobId = randomUUID();
  const body = serializeRowsToBuffer(rows, filename);
  const key = buildValidationInputKey({
    jobId,
    originalFilename: filename,
    index: 0,
  });
  await uploadFile({
    key,
    body,
    contentType: contentTypeForFilename(filename),
  });

  const engineResult = await runValidationEngine({
    jobId,
    inputs: [
      {
        s3Key: key,
        filename,
        businessObject: forcedBusinessObject || undefined,
      },
    ],
    rulesByBusinessObject: Object.fromEntries(
      ruleRows.map((row) => [row.business_object, row.rules]),
    ),
  });

  const scenario = (engineResult.scenarios || [])[0];
  const unclassified = (engineResult.unclassified || [])[0];
  if (!scenario) {
    return { ok: false, unclassified, errors: engineResult.errors || [], ruleRows };
  }

  const rulesBusinessObject = scenario.rulesBusinessObject;
  const ruleSetRow =
    ruleRows.find((row) => row.business_object === rulesBusinessObject) ||
    (await findLatestValidationRulesByBusinessObject(rulesBusinessObject));

  return {
    ok: true,
    scenario,
    ruleSetRow,
    ruleRows,
    unclassified: engineResult.unclassified || [],
    errors: engineResult.errors || [],
  };
}

async function uploadRefinedValidationFile(session, refinedRows) {
  const refinedFilename =
    session.report?.autoFix?.refinedFilename ||
    buildRefinedFilename(session.filename);

  const exportRows = remapRowsToSapColumns(
    refinedRows,
    session.report?.columnMapping || {},
    session.report?.sapFieldNames || session.report?.sapColumns || [],
  );

  const buffer = serializeRowsToBuffer(exportRows, session.filename);
  const refinedKey = buildRefinedValidationKey({
    sessionId: session.id,
    filename: refinedFilename,
  });

  await uploadFile({
    key: refinedKey,
    body: buffer,
    contentType: contentTypeForFilename(refinedFilename),
  });

  return { refinedKey, refinedFilename };
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
      let evalResult;
      let evaluator = String(process.env.VALIDATION_LAMBDA_MODE || "local");

      if (isValidationEngineConfigured()) {
        if (manualBo) {
          if (isBusinessObject(manualBo)) {
            rulesBusinessObject = manualBo;
            detectorLabel = toDetectorLabel(manualBo);
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
        }

        const fastApi = await evaluateCleanupWithFastApi({
          rows: originalRows,
          filename: req.file.originalname,
          forcedBusinessObject: detectorLabel,
        });

        if (!fastApi.ok) {
          if (!fastApi.unclassified && (fastApi.errors || []).length) {
            const err = new Error(
              fastApi.errors[0]?.error || "Validation engine failed",
            );
            err.status = 502;
            throw err;
          }
          const unclassified = fastApi.unclassified;
          const det = unclassified?.detection || {};
          return res.status(422).json({
            needs_business_object: true,
            error:
              det.message ||
              unclassified?.reason ||
              "Could not auto-detect business object",
            detection: {
              businessObject: det.businessObject ?? null,
              confidence: det.confidence ?? null,
              reasoning: det.reasoning ?? unclassified?.reason ?? null,
              error: det.error ?? null,
            },
            candidates: det.candidates || [...SUPPORTED_BUSINESS_OBJECTS],
          });
        }

        detectorLabel = fastApi.scenario.scenario;
        rulesBusinessObject = fastApi.scenario.rulesBusinessObject;
        detection = {
          source: manualBo ? "manual" : "auto",
          businessObject: detectorLabel,
          confidence: fastApi.scenario.detection?.confidence,
          reasoning: fastApi.scenario.detection?.reasoning,
          modelId: fastApi.scenario.detection?.modelId,
        };
        evalResult = {
          findings: fastApi.scenario.findings || [],
          report: fastApi.scenario.report || {},
          summary: fastApi.scenario.summary,
          ruleSet: {
            id: fastApi.ruleSetRow?.id,
            business_object: rulesBusinessObject,
            created_at: fastApi.ruleSetRow?.created_at,
          },
          rulesSnapshot:
            fastApi.ruleSetRow?.rules ?? { businessObject: rulesBusinessObject },
        };
        evaluator = "fastapi";
        console.log("[validation] evaluator=fastapi");
      } else if (manualBo) {
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

      if (!evalResult) {
        const lambdaResult = await runValidationRulesLambda({
          businessObject: rulesBusinessObject,
          rows: mappedRows,
        });
        const ruleSetRow = await findValidationRulesById(lambdaResult.ruleSet.id);
        evalResult = {
          findings: lambdaResult.findings,
          report: lambdaResult.report,
          summary: lambdaResult.summary,
          ruleSet: lambdaResult.ruleSet,
          rulesSnapshot:
            ruleSetRow?.rules ?? { businessObject: rulesBusinessObject },
        };
      }

      const aligned = alignValidationOutputToSapFields(
        evalResult.findings,
        evalResult.report,
        columnMapping,
      );

      const session = await createCleanupSession({
        userId: req.user.id,
        filename: req.file.originalname,
        businessObject: rulesBusinessObject,
        detectorLabel,
        detection,
        ruleSetId: evalResult.ruleSet.id,
        rulesSnapshot: evalResult.rulesSnapshot,
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
        summary: evalResult.summary,
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
        ruleSet: evalResult.ruleSet,
        summary: evalResult.summary,
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
        evaluator,
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

      try {
        const { refinedKey, refinedFilename } = await uploadRefinedValidationFile(
          { ...session, report: updatedReport },
          autoFix.refinedRows,
        );
        await updateCleanupSession(session.id, {
          refinedS3Key: refinedKey,
          refinedFilename,
        });
      } catch (uploadErr) {
        console.error("[validation] refined file upload failed:", uploadErr.message);
      }

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

      let refinedKey = session.refined_s3_key;
      let refinedFilename =
        session.refined_filename ||
        session.report?.autoFix?.refinedFilename ||
        buildRefinedFilename(session.filename);

      if (!refinedKey) {
        const uploaded = await uploadRefinedValidationFile(session, refinedRows);
        refinedKey = uploaded.refinedKey;
        refinedFilename = uploaded.refinedFilename;
        await updateCleanupSession(session.id, {
          refinedS3Key: refinedKey,
          refinedFilename,
        });
      }

      const payload = await buildSignedDownloadResponse(refinedKey, refinedFilename);
      return res.status(200).json(payload);
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
