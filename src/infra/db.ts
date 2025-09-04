// src/infra/db.ts
import { Pool } from 'pg';

const dbUrl = process.env.DATABASE_URL!;
export const pool = new Pool({
  connectionString: dbUrl,
  // força aceitar o cert autoassinado (escopo só do PG)
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  max: 10,
});

console.log('PG pool initialized with ssl.rejectUnauthorized=false');