import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

const DEFAULT_BUCKET = "mirai-minds-s3";

function getRegion() {
  return (
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    process.env.S3_REGION ||
    "ap-southeast-2"
  );
}

function getBucket() {
  return process.env.S3_BUCKET || DEFAULT_BUCKET;
}

export function isS3StorageEnabled() {
  const mode = String(process.env.FILE_STORAGE || "s3").trim().toLowerCase();
  return mode === "s3";
}

let s3Client;

function getClient() {
  if (!s3Client) {
    s3Client = new S3Client({ region: getRegion() });
  }
  return s3Client;
}

/**
 * Build a structured S3 object key for uploaded files.
 * Layout: uploads/{userId}/{batchId}/{fileType}/{timestamp}-{safeName}.ext
 */
export function buildS3ObjectKey({
  userId,
  batchId,
  fileType,
  originalFilename,
}) {
  const ext = (originalFilename.match(/\.[^.]+$/) || [".bin"])[0].toLowerCase();
  const safeBase = String(originalFilename)
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 80);
  const timestamp = Date.now();
  return `uploads/${userId}/${batchId}/${fileType}/${timestamp}-${safeBase}${ext}`;
}

/**
 * Build S3 key for validation report artifacts.
 * Layout: validation-reports/{userId}/{sessionKey}/input|report/{filename}
 */
export function buildValidationReportKey({
  userId,
  sessionKey,
  artifactType,
  filename,
}) {
  const safeName = String(filename || "file")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
  return `validation-reports/${userId}/${sessionKey}/${artifactType}/${safeName}`;
}

export function toS3Uri(key) {
  return `s3://${getBucket()}/${key}`;
}

export function parseS3Uri(uri) {
  const match = String(uri || "").match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { bucket: match[1], key: match[2] };
}

/**
 * @param {string} key
 * @param {Buffer} body
 * @param {string} [contentType]
 */
export async function uploadBuffer(key, body, contentType) {
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
    }),
  );
  return toS3Uri(key);
}

/**
 * @param {string} key
 * @param {string} filePath
 * @param {string} [contentType]
 */
export async function uploadFile(key, filePath, contentType) {
  const fs = await import("fs");
  const body = fs.readFileSync(filePath);
  return uploadBuffer(key, body, contentType);
}

/**
 * @param {string} uriOrKey - s3:// URI or bare object key
 * @returns {Promise<Buffer>}
 */
export async function downloadToBuffer(uriOrKey) {
  const parsed = parseS3Uri(uriOrKey);
  const bucket = parsed?.bucket || getBucket();
  const key = parsed?.key || uriOrKey;

  const client = getClient();
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );

  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function guessContentType(filename) {
  const ext = String(filename).split(".").pop()?.toLowerCase();
  const map = {
    csv: "text/csv",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    json: "application/json",
    pdf: "application/pdf",
  };
  return map[ext] || "application/octet-stream";
}

export async function uploadOriginalFile({
  userId,
  batchId,
  fileType,
  originalFilename,
  buffer,
  filePath,
}) {
  const key = buildS3ObjectKey({
    userId,
    batchId,
    fileType,
    originalFilename,
  });
  const contentType = guessContentType(originalFilename);

  if (buffer) {
    return { key, uri: await uploadBuffer(key, buffer, contentType) };
  }
  if (filePath) {
    return { key, uri: await uploadFile(key, filePath, contentType) };
  }
  throw new Error("uploadOriginalFile requires buffer or filePath");
}

export async function uploadValidationArtifacts({
  userId,
  sessionKey,
  originalFilename,
  fileBuffer,
  reportJson,
}) {
  const inputKey = buildValidationReportKey({
    userId,
    sessionKey,
    artifactType: "input",
    filename: originalFilename,
  });
  const reportKey = buildValidationReportKey({
    userId,
    sessionKey,
    artifactType: "report",
    filename: "validation-report.json",
  });

  const inputUri = await uploadBuffer(
    inputKey,
    fileBuffer,
    guessContentType(originalFilename),
  );
  const reportUri = await uploadBuffer(
    reportKey,
    Buffer.from(JSON.stringify(reportJson, null, 2), "utf8"),
    "application/json",
  );

  return {
    input: { key: inputKey, uri: inputUri },
    report: { key: reportKey, uri: reportUri },
  };
}
