import { Router } from "express";
import multer from "multer";
import { BUSINESS_OBJECTS, isBusinessObject } from "../constants/businessObjects.js";
import { requireAuth } from "../middleware/auth.js";
import {
  findRulesDraft,
  findSourceSchemaByIdForUser,
  upsertRulesDraft,
  upsertWorkspaceState,
} from "../models/adminWorkspace.js";
import {
  createValidationRules,
  findLatestValidationRulesByBusinessObject,
  findValidationRulesById,
  listValidationRules,
} from "../models/validationRules.js";
import {
  parseFieldMetadataExcel,
  toBusinessObjectJson,
} from "../services/excelParser.js";
import { validateFieldMetadata } from "../services/excelValidator.js";
import { generateAiRulesWithBedrock } from "../services/bedrockRules.js";
import {
  buildRulesExportKey,
  uploadFile,
} from "../services/s3Service.js";
import {
  assembleFieldRules,
  extractCustomRulesByField,
  toPersistableAiRules,
} from "../services/assembleRules.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.UPLOAD_MAX_BYTES || 5 * 1024 * 1024),
  },
  fileFilter(_req, file, cb) {
    const name = String(file.originalname || "").toLowerCase();
    const ok =
      name.endsWith(".xlsx") ||
      name.endsWith(".xls") ||
      name.endsWith(".xlsm") ||
      file.mimetype.includes("spreadsheet") ||
      file.mimetype.includes("excel");

    if (!ok) {
      const error = new Error("Only Excel files (.xlsx, .xls) are allowed");
      error.status = 400;
      return cb(error);
    }
    return cb(null, true);
  },
});

function parseStoredSourceFields(row) {
  if (!row?.source_fields) return [];
  if (Array.isArray(row.source_fields)) return row.source_fields;
  if (typeof row.source_fields === "string") {
    try {
      return JSON.parse(row.source_fields);
    } catch {
      return [];
    }
  }
  return row.source_fields;
}

router.get("/business-objects", requireAuth, (_req, res) => {
  res.json({ businessObjects: BUSINESS_OBJECTS });
});

/**
 * Parse Excel → review JSON (predefined + AI). Caches draft when sourceSchemaId is provided.
 */
router.post(
  "/generate",
  requireAuth,
  upload.single("file"),
  async (req, res, next) => {
    try {
      const businessObject = String(req.body?.businessObject || "").trim();
      const sourceSchemaId = String(req.body?.sourceSchemaId || "").trim();
      const force =
        String(req.query?.force || req.body?.force || "").toLowerCase() === "true";

      if (!isBusinessObject(businessObject)) {
        return res.status(400).json({
          error: `businessObject must be one of: ${BUSINESS_OBJECTS.join(", ")}`,
        });
      }

      if (sourceSchemaId && !force) {
        const schema = await findSourceSchemaByIdForUser(
          sourceSchemaId,
          req.user.id,
        );
        if (!schema) {
          return res.status(404).json({ error: "Source schema not found" });
        }

        const cached = await findRulesDraft(sourceSchemaId, businessObject);
        if (cached) {
          await upsertWorkspaceState(req.user.id, {
            activeSourceSchemaId: sourceSchemaId,
            selectedBusinessObject: businessObject,
          });

          return res.status(200).json({
            businessObject: cached.business_object,
            rules: cached.rules,
            sourceSchemaId,
            cached: true,
            persisted: false,
            message: "Returned cached rules draft for this file and business object",
          });
        }
      }

      let fields;
      if (sourceSchemaId) {
        const schema = await findSourceSchemaByIdForUser(
          sourceSchemaId,
          req.user.id,
        );
        if (!schema) {
          return res.status(404).json({ error: "Source schema not found" });
        }
        fields = parseStoredSourceFields(schema);
        validateFieldMetadata(fields);
      } else if (req.file?.buffer) {
        fields = parseFieldMetadataExcel(req.file.buffer);
        validateFieldMetadata(fields);
      } else {
        return res.status(400).json({
          error: "Excel file or sourceSchemaId is required",
        });
      }

      const sourceFields = toBusinessObjectJson(businessObject, fields);
      const latestRuleSet =
        await findLatestValidationRulesByBusinessObject(businessObject);
      const customByField = extractCustomRulesByField(latestRuleSet?.rules);
      const aiByField = await generateAiRulesWithBedrock(
        businessObject,
        sourceFields,
        fields,
        customByField,
      );
      const rules = assembleFieldRules(
        businessObject,
        fields,
        aiByField,
        customByField,
      );

      if (sourceSchemaId) {
        const rulesPayload = {
          businessObject,
          sourceFields,
          rules,
          generatedAt: new Date().toISOString(),
        };
        const outputKey = buildRulesExportKey({ sourceSchemaId, businessObject });
        await uploadFile({
          key: outputKey,
          body: Buffer.from(JSON.stringify(rulesPayload, null, 2), "utf8"),
          contentType: "application/json",
        });

        await upsertRulesDraft({
          sourceSchemaId,
          businessObject,
          rules,
          createdBy: req.user.id,
          outputS3Key: outputKey,
        });
        await upsertWorkspaceState(req.user.id, {
          activeSourceSchemaId: sourceSchemaId,
          selectedBusinessObject: businessObject,
        });
      }

      return res.status(200).json({
        businessObject,
        sourceFields,
        rules,
        sourceSchemaId: sourceSchemaId || null,
        cached: false,
        persisted: false,
        message:
          "Review predefined + AI rules. Save stores Business Object, field names, key flags (X = primary key), data types, lengths, and AI rules.",
      });
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) {
        err.message =
          err.message || "LLM access denied. Check Bedrock credentials and model access.";
      }
      return next(err);
    }
  },
);

/**
 * Persist in-progress tick/toggle state to the workspace draft (not the published rule set).
 */
router.post("/draft", requireAuth, async (req, res, next) => {
  try {
    const businessObject = String(req.body?.businessObject || "").trim();
    const sourceSchemaId = String(req.body?.sourceSchemaId || "").trim();
    const rules = req.body?.rules;

    if (!isBusinessObject(businessObject)) {
      return res.status(400).json({
        error: `businessObject must be one of: ${BUSINESS_OBJECTS.join(", ")}`,
      });
    }
    if (!sourceSchemaId) {
      return res.status(400).json({ error: "sourceSchemaId is required" });
    }
    if (!rules || typeof rules !== "object" || !Array.isArray(rules.fields)) {
      return res.status(400).json({
        error: "rules JSON with fields[] is required",
      });
    }

    const schema = await findSourceSchemaByIdForUser(sourceSchemaId, req.user.id);
    if (!schema) {
      return res.status(404).json({ error: "Source schema not found" });
    }

    const saved = await upsertRulesDraft({
      sourceSchemaId,
      businessObject,
      rules,
      createdBy: req.user.id,
    });

    await upsertWorkspaceState(req.user.id, {
      activeSourceSchemaId: sourceSchemaId,
      selectedBusinessObject: businessObject,
    });

    return res.status(200).json({
      message: "Selection state saved to workspace draft",
      draftId: saved.id,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * Persist: businessObject + fieldName + key (X = PK) + AI rules.
 */
router.post("/save", requireAuth, async (req, res, next) => {
  try {
    const businessObject = String(req.body?.businessObject || "").trim();
    const rules = req.body?.rules;

    if (!isBusinessObject(businessObject)) {
      return res.status(400).json({
        error: `businessObject must be one of: ${BUSINESS_OBJECTS.join(", ")}`,
      });
    }

    if (!rules || typeof rules !== "object" || !Array.isArray(rules.fields)) {
      return res.status(400).json({
        error: "rules JSON with fields[] is required",
      });
    }

    const persistable = toPersistableAiRules(businessObject, rules);

    if (!persistable.fields.length) {
      return res.status(400).json({
        error: "No fields found to save",
      });
    }

    const saved = await createValidationRules({
      businessObject,
      rules: persistable,
      createdBy: req.user?.id,
    });

    return res.status(201).json({
      message: "Saved Business Object + field names + key flags + data types + AI rules",
      ruleSet: saved,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const businessObject = req.query.businessObject
      ? String(req.query.businessObject)
      : undefined;

    if (businessObject && !isBusinessObject(businessObject)) {
      return res.status(400).json({
        error: `businessObject must be one of: ${BUSINESS_OBJECTS.join(", ")}`,
      });
    }

    const rows = await listValidationRules({
      businessObject,
      limit: req.query.limit,
    });
    return res.json({ rules: rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const row = await findValidationRulesById(req.params.id);
    if (!row) {
      return res.status(404).json({ error: "Rule set not found" });
    }
    return res.json({ ruleSet: row });
  } catch (err) {
    return next(err);
  }
});

export default router;
