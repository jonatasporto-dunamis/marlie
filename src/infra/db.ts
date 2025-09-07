// src/infra/db.ts
import { Pool } from 'pg';
import { parse } from 'pg-connection-string';

const dbUrl = process.env.DATABASE_URL!;

// Parse the connection string to avoid SSL conflicts
const config = parse(dbUrl);

// Configuração específica para Supabase
const isSupabase = config.host?.includes('supabase.co') || config.host?.includes('pooler.supabase.com');

export const pool = new Pool({
  host: config.host!,
  port: parseInt(config.port || '5432'),
  database: config.database!,
  user: config.user!,
  password: config.password!,
  // Configuração SSL específica para Supabase
  ssl: isSupabase ? { rejectUnauthorized: true } : { rejectUnauthorized: false },
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  max: 10,
  // Configurações adicionais para Supabase
  ...(isSupabase && {
    application_name: 'syncbelle-app',
    statement_timeout: 30000,
    query_timeout: 30000,
  }),
});

console.log(`PG pool initialized for ${isSupabase ? 'Supabase' : 'local PostgreSQL'} with SSL ${isSupabase ? 'enabled' : 'disabled'}`);