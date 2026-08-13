import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { Signer } from "@aws-sdk/rds-signer";
import { runValidationRulesLocalNode } from "./nodeValidationEvaluator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAMBDA_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "lambda",
  "validation_rules_runner",
);
const LAMBDA_SCRIPT = path.join(LAMBDA_DIR, "lambda_function.py");

function getRegion() {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-northeast-1";
}

function candidatePythonBins() {
  const configured = process.env.VALIDATION_PYTHON;
  if (configured) return [configured];
  // Windows often exposes the launcher as `py`
  return process.platform === "win32"
    ? ["py", "python", "python3"]
    : ["python3", "python"];
}

async function buildDbConfigForPython() {
  const host = process.env.RDSHOST;
  const user = process.env.RDSUSER || "postgres";
  const database = process.env.RDSDATABASE || "postgres";
  const port = Number(process.env.RDSPORT || 5432);
  const region = getRegion();

  let password = process.env.DB_PASSWORD || process.env.PGPASSWORD || "";

  if (process.env.DB_AUTH === "iam" && host) {
    const signer = new Signer({
      hostname: host,
      port,
      username: user,
      region,
    });
    password = await signer.getAuthToken();
  }

  return {
    host,
    user,
    password,
    database,
    port,
    ssl: process.env.DB_SSL || "require",
  };
}

function runWithBin(bin, event) {
  return new Promise((resolve, reject) => {
    const args = bin === "py" ? ["-3", LAMBDA_SCRIPT] : [LAMBDA_SCRIPT];
    const command = bin === "py" ? "py" : bin;
    const scriptArgs = bin === "py" ? args : [LAMBDA_SCRIPT];

    const child = spawn(command, scriptArgs, {
      cwd: LAMBDA_DIR,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(
          Object.assign(
            new Error(
              stderr.trim() ||
                `Validation Lambda local Python exited with code ${code}`,
            ),
            { status: 500, details: stderr.slice(0, 500) },
          ),
        );
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(
          Object.assign(new Error("Invalid JSON from local validation runner"), {
            status: 500,
            details: stdout.slice(0, 500),
          }),
        );
      }
    });

    child.stdin.write(JSON.stringify(event));
    child.stdin.end();
  });
}

async function runLocalPython(event) {
  let lastError = null;
  for (const bin of candidatePythonBins()) {
    try {
      return await runWithBin(bin, event);
    } catch (err) {
      lastError = err;
      const msg = String(err?.message || "");
      if (
        err?.code === "ENOENT" ||
        msg.toLowerCase().includes("python was not found") ||
        msg.toLowerCase().includes("not recognized")
      ) {
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error("Python runtime not available");
}

async function invokeAwsLambda(event) {
  const functionName = process.env.VALIDATION_LAMBDA_FUNCTION_NAME;
  if (!functionName) {
    throw Object.assign(
      new Error("VALIDATION_LAMBDA_FUNCTION_NAME is not configured"),
      { status: 500 },
    );
  }

  const client = new LambdaClient({ region: getRegion() });
  const response = await client.send(
    new InvokeCommand({
      FunctionName: functionName,
      Payload: Buffer.from(JSON.stringify(event)),
    }),
  );

  const raw = Buffer.from(response.Payload || []).toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    throw Object.assign(new Error("Lambda returned non-JSON payload"), {
      status: 502,
      details: raw.slice(0, 500),
    });
  }

  if (parsed && typeof parsed.body === "string") {
    parsed = JSON.parse(parsed.body);
  }

  if (response.FunctionError) {
    throw Object.assign(
      new Error(parsed?.errorMessage || "Validation Lambda invocation failed"),
      { status: 502, details: parsed },
    );
  }

  return parsed;
}

/**
 * Prefer AWS Lambda (Python). Locally: Python script, else Node evaluator
 * that still queries validation_rules and returns findings only.
 */
export async function runValidationRulesLambda({ businessObject, rows }) {
  const mode = String(
    process.env.VALIDATION_LAMBDA_MODE || "local",
  ).toLowerCase();

  if (mode === "aws") {
    const db = await buildDbConfigForPython();
    const result = await invokeAwsLambda({ businessObject, rows, db });
    if (!result?.ok) {
      const err = new Error(
        result?.error || "Validation rules evaluation failed",
      );
      err.status = String(result?.error || "").includes(
        "No saved validation rules",
      )
        ? 404
        : 502;
      err.details = result;
      throw err;
    }
    return { ...result, evaluator: "aws-lambda" };
  }

  // local: try Python Lambda script first
  try {
    const db = await buildDbConfigForPython();
    const result = await runLocalPython({ businessObject, rows, db });
    if (!result?.ok) {
      const err = new Error(
        result?.error || "Validation rules evaluation failed",
      );
      err.status = String(result?.error || "").includes(
        "No saved validation rules",
      )
        ? 404
        : 502;
      err.details = result;
      throw err;
    }
    return { ...result, evaluator: "python-local" };
  } catch (err) {
    const msg = String(err?.message || "");
    const missingPython =
      err?.code === "ENOENT" ||
      msg.toLowerCase().includes("python was not found") ||
      msg.toLowerCase().includes("not available");

    if (!missingPython && err?.status && err.status !== 500) {
      throw err;
    }

    console.warn(
      "[validation] Python Lambda local runner unavailable; using Node evaluator fallback:",
      msg.slice(0, 200),
    );
    const result = await runValidationRulesLocalNode({ businessObject, rows });
    return { ...result, evaluator: "node-local" };
  }
}
