// src/infra/db.ts
import { Pool } from 'pg';

const dbUrl = process.env.DATABASE_URL!;
export const pool = new Pool({
  connectionString: dbUrl,
  // força SSL quando a URL tiver ?sslmode=require (Railway)
  ssl: /sslmode=require/.test(dbUrl) ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 10_000, // 10s
  idleTimeoutMillis: 30_000,
  max: 10,
});
