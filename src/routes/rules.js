import { Router } from "express";
import multer from "multer";
import { BUSINESS_OBJECTS, isBusinessObject } from "../constants/businessObjects.js";
import { requireAuth } from "../middleware/auth.js";
import {
  createValidationRules,
  findValidationRulesById,
  listValidationRules,
} from "../models/validationRules.js";
import {
  parseFieldMetadataExcel,
  toBusinessObjectJson,
} from "../services/excelParser.js";
import { validateFieldMetadata } from "../services/excelValidator.js";
import { generateAiRulesWithGrok } from "../services/grokRules.js";
import {
  assembleFieldRules,
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

router.get("/business-objects", requireAuth, (_req, res) => {
  res.json({ businessObjects: BUSINESS_OBJECTS });
});

/**
 * Parse Excel → review JSON (predefined + AI). Does NOT persist.
 */
router.post(
  "/generate",
  requireAuth,
  upload.single("file"),
  async (req, res, next) => {
    try {
      const businessObject = String(req.body?.businessObject || "").trim();

      if (!isBusinessObject(businessObject)) {
        return res.status(400).json({
          error: `businessObject must be one of: ${BUSINESS_OBJECTS.join(", ")}`,
        });
      }

      if (!req.file?.buffer) {
        return res.status(400).json({ error: "Excel file is required (field name: file)" });
      }

      const fields = parseFieldMetadataExcel(req.file.buffer);
      validateFieldMetadata(fields);

      const sourceFields = toBusinessObjectJson(businessObject, fields);
      const aiByField = await generateAiRulesWithGrok(
        businessObject,
        sourceFields,
        fields,
      );
      const rules = assembleFieldRules(businessObject, fields, aiByField);

      return res.status(200).json({
        businessObject,
        // Returned for UI review only — NOT saved to DB
        sourceFields,
        rules,
        persisted: false,
        message:
          "Review predefined + AI rules. Save stores Business Object, field names, key flags (X = primary key), and AI rules.",
      });
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) {
        err.message =
          err.message || "LLM access denied. Check GROK_API_KEY / model access.";
      }
      return next(err);
    }
  },
);

/**
 * Persist: businessObject + fieldName + key (X = PK) + AI rules.
 * Predefined rules and other Excel metadata are not stored.
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
      message: "Saved Business Object + field names + key flags + AI rules",
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
