import fs from "fs";
import path from "path";
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { UPLOADS_ROOT } from "../lib/uploadParse.js";

function getRegion() {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-northeast-1";
}

let s3Client;

function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client({ region: getRegion() });
  }
  return s3Client;
}

/**
 * S3 object key mirroring the local uploads layout: {userId}/{batchId}/{filename}
 */
export function buildComparisonS3Key({ userId, batchId, storagePath }) {
  const relative = path.relative(UPLOADS_ROOT, storagePath);
  if (!relative || relative.startsWith("..")) {
    throw Object.assign(
      new Error("Upload file is outside the configured uploads directory"),
      { status: 500 },
    );
  }
  return relative.split(path.sep).join("/");
}

async function objectExists(bucket, key) {
  try {
    await getS3Client().send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
    return true;
  } catch (err) {
    if (err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw err;
  }
}

/**
 * Ensure the locally stored upload exists in S3 for the comparison-engine service.
 */
export async function ensureComparisonFileInS3({
  bucket,
  userId,
  batchId,
  storagePath,
}) {
  if (!bucket) {
    throw Object.assign(new Error("COMPARISON_S3_BUCKET is not configured"), {
      status: 500,
    });
  }

  if (!storagePath || !fs.existsSync(storagePath)) {
    throw Object.assign(
      new Error(`Upload file not found on disk: ${storagePath || "(missing path)"}`),
      { status: 500 },
    );
  }

  const key = buildComparisonS3Key({ userId, batchId, storagePath });
  if (await objectExists(bucket, key)) {
    return key;
  }

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(storagePath),
    }),
  );

  return key;
}
