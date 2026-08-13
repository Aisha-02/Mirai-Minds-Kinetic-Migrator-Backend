import { Router } from "express";
import multer from "multer";
import { BUSINESS_OBJECTS, isBusinessObject } from "../constants/businessObjects.js";
import {
  mapRulesBusinessObjectToDetector,
} from "../constants/businessObjectMap.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  clearWorkspaceState,
  createSourceSchema,
  findRulesDraft,
  findSchemaMapping,
  findSourceSchemaByIdForUser,
  findSourceSchemaByUserAndHash,
  getWorkspaceState,
  upsertSchemaMapping,
  upsertWorkspaceState,
} from "../models/adminWorkspace.js";
import {
  getFieldsFromSourceJson,
  parseFieldMetadataExcel,
} from "../services/excelParser.js";
import { validateFieldMetadata } from "../services/excelValidator.js";
import { generateSchemaMapping } from "../services/schemaMappingService.js";
import { getBusinessObjectMetadata } from "../services/sapMetadataService.js";
import {
  assertS3Configured,
  buildMappingExportKey,
  buildRulesExportKey,
  buildSourceSchemaKey,
  uploadFile,
} from "../services/s3Service.js";
import { hashBuffer } from "../utils/fileHash.js";

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

function mapBedrockRouteError(err) {
  if (err?.code === "TIMEOUT") {
    err.status = 504;
    err.message = err.message || "AI mapping request timed out";
  } else if (err?.code === "THROTTLED") {
    err.status = 429;
  } else if (err?.code === "MALFORMED_RESPONSE") {
    err.status = 502;
  } else if (err?.code === "CONFIG") {
    err.status = 500;
  } else if (err?.code === "BEDROCK_ERROR") {
    err.status = 502;
  }
  return err;
}

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

async function resolveSourceFieldsForMapping(businessObject, req, userId) {
  const sourceSchemaId = String(
    req.body?.sourceSchemaId || req.query?.sourceSchemaId || "",
  ).trim();
  const force = String(req.query?.force || req.body?.force || "").toLowerCase() === "true";

  if (sourceSchemaId) {
    const schema = await findSourceSchemaByIdForUser(sourceSchemaId, userId);
    if (!schema) {
      const error = new Error("Source schema not found");
      error.status = 404;
      throw error;
    }
    const fields = parseStoredSourceFields(schema);
    validateFieldMetadata(fields);
    return { sourceFields: fields, sourceSchemaId: schema.id, schema, force };
  }

  if (req.file?.buffer) {
    const fields = parseFieldMetadataExcel(req.file.buffer);
    validateFieldMetadata(fields);
    return { sourceFields: fields, sourceSchemaId: null, schema: null, force };
  }

  const sourceFields = req.body?.sourceFields;
  if (Array.isArray(sourceFields) && sourceFields.length > 0) {
    validateFieldMetadata(sourceFields);
    return { sourceFields, sourceSchemaId: null, schema: null, force };
  }

  const sourceSchema = req.body?.sourceSchema;
  if (sourceSchema && typeof sourceSchema === "object") {
    const fields = getFieldsFromSourceJson(businessObject, sourceSchema);
    validateFieldMetadata(fields);
    return { sourceFields: fields, sourceSchemaId: null, schema: null, force };
  }

  const error = new Error(
    "Source schema is required: provide sourceSchemaId, upload Excel (field name: file), sourceFields[], or sourceSchema JSON",
  );
  error.status = 400;
  throw error;
}

/**
 * POST /api/admin/source-schema
 * Register uploaded Excel as active admin workspace source schema.
 */
router.post(
  "/source-schema",
  requireAuth,
  requireRole("admin"),
  upload.single("file"),
  async (req, res, next) => {
    try {
      assertS3Configured();

      if (!req.file?.buffer) {
        return res.status(400).json({ error: "Excel file is required (field name: file)" });
      }

      const fields = parseFieldMetadataExcel(req.file.buffer);
      validateFieldMetadata(fields);

      const fileHash = hashBuffer(req.file.buffer);
      const userId = req.user.id;
      const selectedBusinessObject = String(req.body?.businessObject || "").trim() || null;

      let schema = await findSourceSchemaByUserAndHash(userId, fileHash);
      if (!schema) {
        const s3Key = buildSourceSchemaKey({
          userId,
          fileHash,
          originalFilename: req.file.originalname,
        });

        await uploadFile({
          key: s3Key,
          body: req.file.buffer,
          contentType:
            req.file.mimetype ||
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });

        schema = await createSourceSchema({
          createdBy: userId,
          originalFilename: req.file.originalname,
          fileHash,
          sourceFields: fields,
          s3Key,
        });
      }

      await upsertWorkspaceState(userId, {
        activeSourceSchemaId: schema.id,
        selectedBusinessObject,
      });

      return res.status(200).json({
        id: schema.id,
        fileHash: schema.file_hash,
        originalFilename: schema.original_filename,
        sourceFields: parseStoredSourceFields(schema),
        selectedBusinessObject,
        message: "Source schema registered for admin workspace",
      });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * GET /api/admin/workspace
 * Restore active admin workspace (schema + cached drafts/mappings).
 */
router.get(
  "/workspace",
  requireAuth,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const userId = req.user.id;
      const state = await getWorkspaceState(userId);

      if (!state?.active_source_schema_id) {
        return res.json({
          sourceSchema: null,
          selectedBusinessObject: state?.selected_business_object ?? null,
          rulesDraft: null,
          schemaMapping: null,
        });
      }

      const schema = await findSourceSchemaByIdForUser(
        state.active_source_schema_id,
        userId,
      );

      if (!schema) {
        await clearWorkspaceState(userId);
        return res.json({
          sourceSchema: null,
          selectedBusinessObject: null,
          rulesDraft: null,
          schemaMapping: null,
        });
      }

      const businessObject = state.selected_business_object;
      let rulesDraft = null;
      let schemaMapping = null;

      if (businessObject && isBusinessObject(businessObject)) {
        const draftRow = await findRulesDraft(schema.id, businessObject);
        if (draftRow) {
          rulesDraft = {
            businessObject: draftRow.business_object,
            rules: draftRow.rules,
          };
        }

        const mappingRow = await findSchemaMapping(schema.id, businessObject);
        if (mappingRow) {
          schemaMapping = {
            businessObject: mappingRow.business_object,
            sapBusinessObject: mappingRow.sap_business_object,
            mappings: mappingRow.mappings,
            cached: true,
          };
        }
      }

      return res.json({
        sourceSchema: {
          id: schema.id,
          fileHash: schema.file_hash,
          originalFilename: schema.original_filename,
          sourceFields: parseStoredSourceFields(schema),
        },
        selectedBusinessObject: businessObject,
        rulesDraft,
        schemaMapping,
      });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * PUT /api/admin/workspace
 * Update active workspace selection without re-uploading file.
 */
router.put(
  "/workspace",
  requireAuth,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const userId = req.user.id;
      const sourceSchemaId = String(req.body?.sourceSchemaId || "").trim() || null;
      const selectedBusinessObject =
        String(req.body?.selectedBusinessObject || "").trim() || null;

      if (sourceSchemaId) {
        const schema = await findSourceSchemaByIdForUser(sourceSchemaId, userId);
        if (!schema) {
          return res.status(404).json({ error: "Source schema not found" });
        }
      }

      if (
        selectedBusinessObject &&
        !isBusinessObject(selectedBusinessObject)
      ) {
        return res.status(400).json({
          error: `businessObject must be one of: ${BUSINESS_OBJECTS.join(", ")}`,
        });
      }

      const state = await upsertWorkspaceState(userId, {
        activeSourceSchemaId: sourceSchemaId,
        selectedBusinessObject,
      });

      return res.json({
        selectedBusinessObject: state.selected_business_object,
        sourceSchemaId: state.active_source_schema_id,
        message: "Workspace selection updated",
      });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * DELETE /api/admin/workspace
 * Clear active workspace pointer (logout).
 */
router.delete(
  "/workspace",
  requireAuth,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      await clearWorkspaceState(req.user.id);
      return res.json({ message: "Admin workspace cleared" });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * POST /api/admin/schema-mapping
 * Admin-only: AI map source schema fields to SAP metadata (cached per schema + BO).
 */
router.post(
  "/schema-mapping",
  requireAuth,
  requireRole("admin"),
  upload.single("file"),
  async (req, res, next) => {
    try {
      const businessObject = String(req.body?.businessObject || "").trim();

      if (!isBusinessObject(businessObject)) {
        return res.status(400).json({
          error: `businessObject must be one of: ${BUSINESS_OBJECTS.join(", ")}`,
        });
      }

      const sapBusinessObject = mapRulesBusinessObjectToDetector(businessObject);
      if (!sapBusinessObject) {
        return res.status(400).json({
          error: `No SAP metadata mapping for business object '${businessObject}'`,
        });
      }

      let resolved;
      try {
        resolved = await resolveSourceFieldsForMapping(
          businessObject,
          req,
          req.user.id,
        );
      } catch (err) {
        if (err?.status === 400 || err?.status === 404) {
          return res.status(err.status).json({ error: err.message });
        }
        throw err;
      }

      const { sourceFields, sourceSchemaId, force } = resolved;

      if (sourceSchemaId && !force) {
        const cached = await findSchemaMapping(sourceSchemaId, businessObject);
        if (cached) {
          await upsertWorkspaceState(req.user.id, {
            activeSourceSchemaId: sourceSchemaId,
            selectedBusinessObject: businessObject,
          });

          return res.status(200).json({
            businessObject: cached.business_object,
            sapBusinessObject: cached.sap_business_object,
            mappings: cached.mappings,
            sourceFieldCount: sourceFields.length,
            sourceSchemaId,
            cached: true,
            message: "Returned cached schema mapping for this file and business object",
          });
        }
      }

      const metadata = await getBusinessObjectMetadata(sapBusinessObject);
      if (!metadata.ok) {
        const status =
          metadata.error?.code === "TIMEOUT"
            ? 504
            : metadata.error?.code === "CONFIG"
              ? 500
              : 502;
        return res.status(status).json({
          error: metadata.error?.message || "SAP metadata is unavailable",
          code: metadata.error?.code || "SAP_ERROR",
        });
      }

      let mappings;
      try {
        const result = await generateSchemaMapping({
          businessObject,
          sapBusinessObject,
          sourceFields,
          sapFields: metadata.fields,
        });
        mappings = result.mappings;
      } catch (err) {
        throw mapBedrockRouteError(err);
      }

      let persistedSchemaId = sourceSchemaId;
      if (persistedSchemaId) {
        const mappingPayload = {
          businessObject,
          sapBusinessObject,
          mappings,
          sourceFieldCount: sourceFields.length,
          sapFieldCount: metadata.fields.length,
          generatedAt: new Date().toISOString(),
        };
        const outputKey = buildMappingExportKey({
          sourceSchemaId: persistedSchemaId,
          businessObject,
        });
        await uploadFile({
          key: outputKey,
          body: Buffer.from(JSON.stringify(mappingPayload, null, 2), "utf8"),
          contentType: "application/json",
        });

        await upsertSchemaMapping({
          sourceSchemaId: persistedSchemaId,
          businessObject,
          sapBusinessObject,
          mappings,
          createdBy: req.user.id,
          outputS3Key: outputKey,
        });
        await upsertWorkspaceState(req.user.id, {
          activeSourceSchemaId: persistedSchemaId,
          selectedBusinessObject: businessObject,
        });
      }

      return res.status(200).json({
        businessObject,
        sapBusinessObject,
        mappings,
        sourceFieldCount: sourceFields.length,
        sapFieldCount: metadata.fields.length,
        sapMetadataUsed: true,
        sapMetadataCached: metadata.cached,
        sourceSchemaId: persistedSchemaId,
        cached: false,
        message: "AI field mapping generated from source schema and SAP metadata",
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

export default router;
