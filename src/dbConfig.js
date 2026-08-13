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

export function useRdsPasswordAuth() {
  return (
    Boolean(process.env.RDSHOST) &&
    process.env.DB_AUTH === "password" &&
    Boolean(process.env.RDSPASSWORD || process.env.DATABASE_URL)
  );
}

export async function createPgConfig() {
  if (useRdsPasswordAuth()) {
    const hostname = process.env.RDSHOST;
    const port = Number(process.env.RDSPORT || 5432);
    const username = process.env.RDSUSER || "postgres";

    if (process.env.DATABASE_URL) {
      return {
        connectionString: process.env.DATABASE_URL,
        ssl: getSslConfig(),
      };
    }

    return {
      host: hostname,
      port,
      user: username,
      password: process.env.RDSPASSWORD,
      database: process.env.RDSDATABASE || "postgres",
      ssl: getSslConfig(),
    };
  }

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
    if (!process.env.RDSHOST) {
      throw new Error(
        "RDSHOST is missing. Create a .env file in the project root (same folder as package.json) before running migrations.",
      );
    }
    if (process.env.DB_AUTH === "password" && !process.env.RDSPASSWORD) {
      throw new Error(
        "RDSPASSWORD is required when DB_AUTH=password. Set it in .env or use DATABASE_URL instead.",
      );
    }
    throw new Error(
      "Database config incomplete. Set RDSHOST + RDSPASSWORD (DB_AUTH=password), or RDSHOST + AWS_REGION (DB_AUTH=iam), or DATABASE_URL.",
    );
  }

  return {
    connectionString: process.env.DATABASE_URL,
    ssl: getSslConfig(),
  };
}
