import "dotenv/config";
import cors from "cors";
import express from "express";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import comparisonRoutes from "./routes/comparisons.js";
import rulesRoutes from "./routes/rules.js";
import validationRoutes from "./routes/validation.js";
import documentsRoutes from "./routes/documents.js";
import { requestLogger } from "./middleware/requestLogger.js";

const app = express();
const port = Number(process.env.PORT) || 4000;

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
app.use("/api/admin", adminRoutes);
app.use("/api/comparisons", comparisonRoutes);
app.use("/api/rules", rulesRoutes);
app.use("/api/validation", validationRoutes);
app.use("/api/documents", documentsRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  const message =
    status === 500 && process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message || "Internal server error";
  res.status(status).json({ error: message });
});

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
  console.log(
    `SAP OData: baseUrl=${process.env.SAP_ODATA_BASE_URL ? "set" : "MISSING"} username=${process.env.SAP_ODATA_USERNAME ? "set" : "MISSING"} password=${process.env.SAP_ODATA_PASSWORD ? "set" : "MISSING"}`,
  );
  console.log(
    `Bedrock: region=${process.env.BEDROCK_REGION || process.env.AWS_REGION || "MISSING"} model=${process.env.BEDROCK_MODEL_ID || "MISSING"} credentials=${process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.AWS_ACCESS_KEY_ID ? "set" : "MISSING"}`,
  );
  console.log(
    `S3: bucket=${process.env.AWS_S3_BUCKET || "MISSING — file uploads will fail"}`,
  );
  console.log(
    `Comparison service: url=${process.env.COMPARISON_SERVICE_URL || "not set — using in-memory comparisonEngine"}`,
  );
});
