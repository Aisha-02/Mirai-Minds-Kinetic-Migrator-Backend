import { Signer } from "@aws-sdk/rds-signer";

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "require"].includes(value.toLowerCase());
}

export function useRdsIamAuth() {
  return Boolean(process.env.RDSHOST) && process.env.DB_AUTH !== "password";
}

export function getSslConfig() {
  // Matches psql sslmode=require (encrypt; do not require CA verify-full)
  if (envFlag("DB_SSL", true) || useRdsIamAuth()) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

export async function createPgConfig() {
  if (useRdsIamAuth()) {
    const hostname = process.env.RDSHOST;
    const port = Number(process.env.RDSPORT || 5432);
    const username = process.env.RDSUSER || "postgres";
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;

    if (!region) {
      throw new Error("AWS_REGION is required for RDS IAM authentication");
    }

    const signer = new Signer({
      hostname,
      port,
      username,
      region,
    });

    return {
      host: hostname,
      port,
      user: username,
      database: process.env.RDSDATABASE || "postgres",
      ssl: getSslConfig(),
      // IAM auth tokens expire (~15 min); refresh per new connection
      password: async () => signer.getAuthToken(),
    };
  }

  if (!process.env.DATABASE_URL) {
    throw new Error(
      "Set RDSHOST (+ AWS_REGION) for RDS IAM auth, or DATABASE_URL for password auth",
    );
  }

  return {
    connectionString: process.env.DATABASE_URL,
    ssl: getSslConfig(),
  };
}
