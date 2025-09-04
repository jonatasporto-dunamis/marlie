import { pool } from '../../infra/db';
import { PoolClient } from 'pg';

describe('Row Level Security (RLS) Integration Tests', () => {
  let client1: PoolClient;
  let client2: PoolClient;
  let client3: PoolClient;

  beforeAll(async () => {
    // Get three separate connections to simulate different tenant contexts
    client1 = await pool.connect();
    client2 = await pool.connect();
    client3 = await pool.connect();
  });

  afterAll(async () => {
    client1.release();
    client2.release();
    client3.release();
  });

  beforeEach(async () => {
    // Clear any existing tenant context
    await client1.query('SELECT set_config($1, $2, true)', ['app.tenant_id', '']);
    await client2.query('SELECT set_config($1, $2, true)', ['app.tenant_id', '']);
    await client3.query('SELECT set_config($1, $2, true)', ['app.tenant_id', '']);
  });

  describe('Tenant Isolation', () => {
    it('should prevent cross-tenant access in servicos_prof table', async () => {
      // Set different tenant contexts
      await client1.query('SELECT set_config($1, $2, true)', ['app.tenant_id', 'tenant-a']);
      await client2.query('SELECT set_config($1, $2, true)', ['app.tenant_id', 'tenant-b']);
      
      // Insert data as tenant-a
      await client1.query(`
        INSERT INTO servicos_prof (tenant_id, servico_id, profissional_id, servico_nome, ativo, visivel_cliente)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['tenant-a', 'serv-1', 'prof-1', 'Corte de Cabelo', true, true]);
      
      // Insert data as tenant-b
      await client2.query(`
        INSERT INTO servicos_prof (tenant_id, servico_id, profissional_id, servico_nome, ativo, visivel_cliente)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['tenant-b', 'serv-2', 'prof-2', 'Manicure', true, true]);
      
      // Verify tenant-a can only see their data
      const resultA = await client1.query('SELECT * FROM servicos_prof');
      expect(resultA.rows).toHaveLength(1);
      expect(resultA.rows[0].tenant_id).toBe('tenant-a');
      expect(resultA.rows[0].servico_nome).toBe('Corte de Cabelo');
      
      // Verify tenant-b can only see their data
      const resultB = await client2.query('SELECT * FROM servicos_prof');
      expect(resultB.rows).toHaveLength(1);
      expect(resultB.rows[0].tenant_id).toBe('tenant-b');
      expect(resultB.rows[0].servico_nome).toBe('Manicure');
    });

    it('should prevent cross-tenant access in user_prefs table', async () => {
      // Set different tenant contexts
      await client1.query('SELECT set_config($1, $2, true)', ['app.tenant_id', 'tenant-a']);
      await client2.query('SELECT set_config($1, $2, true)', ['app.tenant_id', 'tenant-b']);
      
      // Insert data as tenant-a
      await client1.query(`
        INSERT INTO user_prefs (tenant_id, phone_e164, preferred_professional_id, preferred_times)
        VALUES ($1, $2, $3, $4)
      `, ['tenant-a', '+5511999999999', 'prof-1', '{"morning": true}']);
      
      // Insert data as tenant-b
      await client2.query(`
        INSERT INTO user_prefs (tenant_id, phone_e164, preferred_professional_id, preferred_times)
        VALUES ($1, $2, $3, $4)
      `, ['tenant-b', '+5511888888888', 'prof-2', '{"afternoon": true}']);
      
      // Verify tenant-a can only see their data
      const resultA = await client1.query('SELECT * FROM user_prefs');
      expect(resultA.rows).toHaveLength(1);
      expect(resultA.rows[0].tenant_id).toBe('tenant-a');
      expect(resultA.rows[0].phone_e164).toBe('+5511999999999');
      
      // Verify tenant-b can only see their data
      const resultB = await client2.query('SELECT * FROM user_prefs');
      expect(resultB.rows).toHaveLength(1);
      expect(resultB.rows[0].tenant_id).toBe('tenant-b');
      expect(resultB.rows[0].phone_e164).toBe('+5511888888888');
    });

    it('should prevent cross-tenant access in message_jobs table', async () => {
      // Set different tenant contexts
      await client1.query('SELECT set_config($1, $2, true)', ['app.tenant_id', 'tenant-a']);
      await client2.query('SELECT set_config($1, $2, true)', ['app.tenant_id', 'tenant-b']);
      
      // Insert data as tenant-a
      await client1.query(`
        INSERT INTO message_jobs (tenant_id, phone_e164, kind, run_at, payload)
        VALUES ($1, $2, $3, $4, $5)
      `, ['tenant-a', '+5511999999999', 'pre_visit', new Date(), '{}']);
      
      // Insert data as tenant-b
      await client2.query(`
        INSERT INTO message_jobs (tenant_id, phone_e164, kind, run_at, payload)
        VALUES ($1, $2, $3, $4, $5)
      `, ['tenant-b', '+5511888888888', 'no_show_check', new Date(), '{}']);
      
      // Verify tenant-a can only see their data
      const resultA = await client1.query('SELECT * FROM message_jobs');
      expect(resultA.rows).toHaveLength(1);
      expect(resultA.rows[0].tenant_id).toBe('tenant-a');
      expect(resultA.rows[0].kind).toBe('pre_visit');
      
      // Verify tenant-b can only see their data
      const resultB = await client2.query('SELECT * FROM message_jobs');
      expect(resultB.rows).toHaveLength(1);
      expect(resultB.rows[0].tenant_id).toBe('tenant-b');
      expect(resultB.rows[0].kind).toBe('no_show_check');
    });
  });

  describe('No Tenant Context', () => {
    it('should return empty results when no tenant context is set', async () => {
      // Insert some data with a specific tenant (using raw SQL to bypass RLS)
      await pool.query(`
        INSERT INTO servicos_prof (tenant_id, servico_id, profissional_id, servico_nome, ativo, visivel_cliente)
        VALUES ('tenant-test', 'serv-test', 'prof-test', 'Test Service', true, true)
      `);
      
      // Try to query without setting tenant context
      const result = await client3.query('SELECT * FROM servicos_prof');
      expect(result.rows).toHaveLength(0);
    });

    it('should prevent inserts when no tenant context is set', async () => {
      // Try to insert without setting tenant context
      await expect(
        client3.query(`
          INSERT INTO servicos_prof (tenant_id, servico_id, profissional_id, servico_nome, ativo, visivel_cliente)
          VALUES ('tenant-test', 'serv-test', 'prof-test', 'Test Service', true, true)
        `)
      ).rejects.toThrow();
    });
  });

  describe('Tenant Context Validation', () => {
    it('should allow access when correct tenant context is set', async () => {
      // Set tenant context
      await client1.query('SELECT set_config($1, $2, true)', ['app.tenant_id', 'tenant-valid']);
      
      // Insert data
      await client1.query(`
        INSERT INTO servicos_prof (tenant_id, servico_id, profissional_id, servico_nome, ativo, visivel_cliente)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['tenant-valid', 'serv-valid', 'prof-valid', 'Valid Service', true, true]);
      
      // Verify data can be retrieved
      const result = await client1.query('SELECT * FROM servicos_prof WHERE servico_id = $1', ['serv-valid']);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].tenant_id).toBe('tenant-valid');
    });

    it('should prevent access to data from different tenant', async () => {
      // Insert data as tenant-x
      await client1.query('SELECT set_config($1, $2, true)', ['app.tenant_id', 'tenant-x']);
      await client1.query(`
        INSERT INTO servicos_prof (tenant_id, servico_id, profissional_id, servico_nome, ativo, visivel_cliente)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['tenant-x', 'serv-x', 'prof-x', 'Service X', true, true]);
      
      // Try to access as tenant-y
      await client2.query('SELECT set_config($1, $2, true)', ['app.tenant_id', 'tenant-y']);
      const result = await client2.query('SELECT * FROM servicos_prof WHERE servico_id = $1', ['serv-x']);
      expect(result.rows).toHaveLength(0);
    });
  });

  describe('RLS Helper Functions', () => {
    it('should validate tenant context with validate_tenant_context function', async () => {
      // Set valid tenant context
      await client1.query('SELECT set_config($1, $2, true)', ['app.tenant_id', 'tenant-test']);
      
      // Test validation function
      const result = await client1.query('SELECT validate_tenant_context() as is_valid');
      expect(result.rows[0].is_valid).toBe(true);
    });

    it('should return false for invalid tenant context', async () => {
      // Don't set tenant context
      const result = await client3.query('SELECT validate_tenant_context() as is_valid');
      expect(result.rows[0].is_valid).toBe(false);
    });

    it('should get current tenant id with get_current_tenant_id function', async () => {
      // Set tenant context
      await client1.query('SELECT set_config($1, $2, true)', ['app.tenant_id', 'tenant-current']);
      
      // Test get function
      const result = await client1.query('SELECT get_current_tenant_id() as tenant_id');
      expect(result.rows[0].tenant_id).toBe('tenant-current');
    });

    it('should return null when no tenant context is set', async () => {
      const result = await client3.query('SELECT get_current_tenant_id() as tenant_id');
      expect(result.rows[0].tenant_id).toBeNull();
    });
  });

  describe('RLS Status View', () => {
    it('should show RLS status for all multi-tenant tables', async () => {
      const result = await client1.query('SELECT * FROM rls_status ORDER BY table_name');
      
      // Verify that all expected tables have RLS enabled
      const expectedTables = [
        'appointment_history',
        'appointment_requests',
        'client_no_show_tracking',
        'client_sessions',
        'contacts',
        'conversation_states',
        'message_jobs',
        'no_show_shield_config',
        'pre_visit_notifications',
        'servicos_prof',
        'upsell_events',
        'user_opt_outs',
        'user_prefs'
      ];
      
      const actualTables = result.rows.map(row => row.table_name);
      
      for (const table of expectedTables) {
        expect(actualTables).toContain(table);
      }
      
      // Verify all tables have RLS enabled
      for (const row of result.rows) {
        expect(row.rls_enabled).toBe(true);
        expect(row.policy_count).toBeGreaterThan(0);
      }
    });
  });
});