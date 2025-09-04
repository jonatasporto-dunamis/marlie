// src/infra/db.ts
import { Pool } from 'pg';
import { parse } from 'pg-connection-string';

const dbUrl = process.env.DATABASE_URL!;

// Parse the connection string to avoid SSL conflicts
const config = parse(dbUrl);

export const pool = new Pool({
  host: config.host!,
  port: parseInt(config.port || '5432'),
  database: config.database!,
  user: config.user!,
  password: config.password!,
  // força aceitar o cert autoassinado (escopo só do PG)
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  max: 10,
});

console.log('PG pool initialized with ssl.rejectUnauthorized=false (parsed config)');