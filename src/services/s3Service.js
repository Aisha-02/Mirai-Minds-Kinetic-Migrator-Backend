/**
 * S3 key layout:
 *
 * uploads/source-schemas/{userId}/{fileHash}/{safeFilename}
 * uploads/comparisons/{userId}/{batchId}/{fileType}-{timestamp}-{safeFilename}
 * uploads/transformation-documents/{documentId}/{safeFilename}
 * generated/mappings/{sourceSchemaId}/{businessObject}.json
 * generated/rules/{sourceSchemaId}/{businessObject}.json
 * generated/reports/comparison/{batchId}/report.pdf
 * generated/validation/{sessionId}/refined.{ext}
 * uploads/validation/{jobId}/{index}-{safeFilename}
 * generated/validation/{jobId}/parsed/{filename}
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";

let client = null;

const DEFAULT_SIGNED_URL_EXPIRES_SEC = 900;

function getBucket() {
  return String(process.env.AWS_S3_BUCKET || "").trim();
}

function getRegion() {
  return (
    process.env.AWS_REGION ||
    process.env.BEDROCK_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    "us-east-1"
  );
}

function getSignedUrlExpiresSec() {
  const value = Number(
    process.env.AWS_S3_SIGNED_URL_EXPIRES_SEC || DEFAULT_SIGNED_URL_EXPIRES_SEC,
  );
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_SIGNED_URL_EXPIRES_SEC;
}

function buildClientConfig() {
  const config = { region: getRegion() };
  const accessKeyId = String(process.env.AWS_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(process.env.AWS_SECRET_ACCESS_KEY || "").trim();

  if (accessKeyId && secretAccessKey) {
    config.credentials = { accessKeyId, secretAccessKey };
  }

  return config;
}

function getClient() {
  if (!client) {
    client = new S3Client(buildClientConfig());
  }
  return client;
}

export function isS3Configured() {
  return Boolean(getBucket());
}

export function assertS3Configured() {
  if (!isS3Configured()) {
    const err = new Error(
      "File storage is not configured. Set AWS_S3_BUCKET in the environment.",
    );
    err.status = 503;
    err.code = "S3_NOT_CONFIGURED";
    throw err;
  }
}

function sanitizeFilename(filename, fallback = "file") {
  return String(filename || fallback).replace(/[^\w.\-()+ ]+/g, "_").slice(0, 180);
}

function sanitizePathSegment(value, fallback = "unknown") {
  return String(value || fallback).replace(/[^\w.\-]+/g, "_").slice(0, 120);
}

export function buildSourceSchemaKey({ userId, fileHash, originalFilename }) {
  const safeName = sanitizeFilename(originalFilename, "schema.xlsx");
  return `uploads/source-schemas/${sanitizePathSegment(userId)}/${sanitizePathSegment(fileHash)}/${safeName}`;
}

export function buildComparisonUploadKey({
  userId,
  batchId,
  fileType,
  originalFilename,
  timestamp = Date.now(),
}) {
  const ext = originalFilename?.includes(".")
    ? originalFilename.slice(originalFilename.lastIndexOf("."))
    : "";
  const safeBase = sanitizeFilename(
    originalFilename?.replace(/\.[^.]+$/, "") || "upload",
    "upload",
  ).slice(0, 80);
  const filename = `${sanitizePathSegment(fileType)}-${timestamp}-${safeBase}${ext}`;
  return `uploads/comparisons/${sanitizePathSegment(userId)}/${sanitizePathSegment(batchId)}/${filename}`;
}

export function buildTransformationDocKey({ documentId, originalFilename }) {
  const safeName = sanitizeFilename(originalFilename, "document");
  return `uploads/transformation-documents/${sanitizePathSegment(documentId)}/${safeName}`;
}

export function buildMappingExportKey({ sourceSchemaId, businessObject }) {
  return `generated/mappings/${sanitizePathSegment(sourceSchemaId)}/${sanitizePathSegment(businessObject)}.json`;
}

export function buildRulesExportKey({ sourceSchemaId, businessObject }) {
  return `generated/rules/${sanitizePathSegment(sourceSchemaId)}/${sanitizePathSegment(businessObject)}.json`;
}

export function buildComparisonReportKey({ batchId }) {
  return `generated/reports/comparison/${sanitizePathSegment(batchId)}/report.pdf`;
}

export function buildRefinedValidationKey({ sessionId, filename }) {
  const ext = filename?.includes(".")
    ? filename.slice(filename.lastIndexOf("."))
    : ".xlsx";
  return `generated/validation/${sanitizePathSegment(sessionId)}/refined${ext}`;
}

export function buildValidationInputKey({ jobId, originalFilename, index = 0 }) {
  const safeName = sanitizeFilename(originalFilename, `input-${index}`);
  return `uploads/validation/${sanitizePathSegment(jobId)}/${index}-${safeName}`;
}

async function streamToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);

  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * @param {unknown} err
 * @param {{ operation: string, key: string }} context
 */
export function mapS3Error(err, { operation, key }) {
  const name = err?.name || "";
  const message = err?.message || "S3 request failed";
  const httpStatus = err?.$metadata?.httpStatusCode;

  console.error(`[s3] ${operation} failed key=${key}:`, message);

  if (name === "NoSuchKey" || httpStatus === 404) {
    const notFound = new Error("File not found in storage");
    notFound.status = 404;
    notFound.code = "S3_NOT_FOUND";
    return notFound;
  }

  if (
    name === "AccessDenied" ||
    httpStatus === 403 ||
    String(message).toLowerCase().includes("access denied")
  ) {
    const denied = new Error("Storage access denied. Check IAM permissions.");
    denied.status = 502;
    denied.code = "S3_ACCESS_DENIED";
    return denied;
  }

  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    String(message).toLowerCase().includes("timeout")
  ) {
    const timeout = new Error("Storage request timed out");
    timeout.status = 504;
    timeout.code = "S3_TIMEOUT";
    return timeout;
  }

  const generic = new Error(`Storage ${operation} failed`);
  generic.status = 502;
  generic.code = "S3_ERROR";
  generic.details = message;
  return generic;
}

/**
 * @param {{ key: string, body: Buffer | Uint8Array | string, contentType?: string }} params
 */
export async function uploadFile({ key, body, contentType }) {
  assertS3Configured();
  const bucket = getBucket();

  try {
    await getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType || "application/octet-stream",
      }),
    );
    return { key, bucket };
  } catch (err) {
    throw mapS3Error(err, { operation: "upload", key });
  }
}

/**
 * @param {string} key
 */
export async function getFile(key) {
  assertS3Configured();
  const bucket = getBucket();

  try {
    const response = await getClient().send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const body = await streamToBuffer(response.Body);
    return {
      body,
      contentType: response.ContentType || "application/octet-stream",
    };
  } catch (err) {
    throw mapS3Error(err, { operation: "download", key });
  }
}

/**
 * @param {string} key
 */
export async function deleteFile(key) {
  if (!key || !isS3Configured()) return;

  const bucket = getBucket();
  try {
    await getClient().send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key }),
    );
  } catch (err) {
    throw mapS3Error(err, { operation: "delete", key });
  }
}

/**
 * @param {string} key
 * @param {{ expiresIn?: number, filename?: string }} [options]
 */
export async function getSignedUrl(key, options = {}) {
  assertS3Configured();
  const bucket = getBucket();
  const expiresIn = options.expiresIn ?? getSignedUrlExpiresSec();

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(options.filename
      ? {
          ResponseContentDisposition: `attachment; filename="${options.filename.replace(/"/g, "")}"`,
        }
      : {}),
  });

  try {
    return await awsGetSignedUrl(getClient(), command, { expiresIn });
  } catch (err) {
    throw mapS3Error(err, { operation: "signed-url", key });
  }
}

export function getDefaultSignedUrlExpiresSec() {
  return getSignedUrlExpiresSec();
}

/**
 * @param {string} key
 * @param {string} filename
 */
export async function buildSignedDownloadResponse(key, filename) {
  const expiresIn = getSignedUrlExpiresSec();
  const signedUrl = await getSignedUrl(key, { expiresIn, filename });
  return { signedUrl, filename, expiresIn };
}
