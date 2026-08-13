import "dotenv/config";
import cors from "cors";
import express from "express";
import authRoutes from "./routes/auth.js";
import comparisonRoutes from "./routes/comparisons.js";
import rulesRoutes from "./routes/rules.js";
import validationRoutes from "./routes/validation.js";
import { requestLogger } from "./middleware/requestLogger.js";

const app = express();
const port = Number(process.env.PORT) || 4000;
const host = process.env.HOST || "0.0.0.0";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is required");
}

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    credentials: true,
  }),
);
app.use(requestLogger);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRoutes);
app.use("/api/comparisons", comparisonRoutes);
app.use("/api/rules", rulesRoutes);
app.use("/api/validation", validationRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  const message =
    status === 500 && process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message || "Internal server error";
  res.status(status).json({ error: message });
});

app.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}`);
  console.log(
    `SAP OData: baseUrl=${process.env.SAP_ODATA_BASE_URL ? "set" : "MISSING"} username=${process.env.SAP_ODATA_USERNAME ? "set" : "MISSING"} password=${process.env.SAP_ODATA_PASSWORD ? "set" : "MISSING"}`,
  );
  console.log(
    `AI: provider=${process.env.AI_REPORT_PROVIDER || "bedrock"} bedrockModel=${process.env.BEDROCK_MODEL_ID || "unset"} bedrockToken=${process.env.AWS_BEARER_TOKEN_BEDROCK ? "set" : "MISSING"}`,
  );
  console.log(
    `Storage: mode=${process.env.FILE_STORAGE || "s3"} bucket=${process.env.S3_BUCKET || "mirai-minds-s3"}`,
  );
  console.log(
    `Database: host=${process.env.RDSHOST || "unset"} auth=${process.env.DB_AUTH || "iam"}`,
  );
});
