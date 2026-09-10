import "dotenv/config";

export interface AppConfig {
  env: string;
  port: number;
  host: string;
  pg: {
    host: string;
    port: number;
    user: string;
    password: string;
    databases: { core: string; chat: string; storage: string };
  };
  jwt: { secret: string; expiresIn: string };
}

export const config: AppConfig = {
  env: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "3100", 10),
  host: process.env.HOST || "0.0.0.0",
  pg: {
    host: process.env.PGHOST || "127.0.0.1",
    port: parseInt(process.env.PGPORT || "5432", 10),
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "",
    databases: {
      core: process.env.PGDATABASE_CORE || "hyperoom_core",
      chat: process.env.PGDATABASE_CHAT || "hyperoom_chat",
      storage: process.env.PGDATABASE_STORAGE || "hyperoom_storage",
    },
  },
  jwt: {
    secret: process.env.JWT_SECRET || "hyperoom-v2-dev-secret-change-in-prod",
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  },
};