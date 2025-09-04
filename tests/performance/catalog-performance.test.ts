import { pool } from '../../src/infra/db';
import { upsertServicosProf } from '../../src/db/index';
import logger from '../../src/utils/logger';

/**
 * Performance test for catalog queries
 * Tests queries with >80 active services and validates index usage
 */

const TEST_TENANT_ID = 'perf-test-tenant';
const MIN_SERVICES = 80;

describe('Catalog Performance Tests', () => {
  beforeAll(async () => {
    // Clean up any existing test data
    await pool.query('DELETE FROM servicos_prof WHERE tenant_id = $1', [TEST_TENANT_ID]);
    
    // Generate test services
    const testServices = [];
    for (let i = 1; i <= MIN_SERVICES + 20; i++) {
      testServices.push({
        servicoId: i,
        servicoNome: `Serviço de Teste ${i.toString().padStart(3, '0')}`,
        duracaoMin: 30 + (i % 60),
        valor: 50 + (i % 200),
        profissionalId: 1 + (i % 10),
        visivelCliente: true,
        ativo: true
      });
    }
    
    // Insert test data
    await upsertServicosProf(TEST_TENANT_ID, testServices);
    
    // Verify we have enough services
    const countResult = await pool.query(
      'SELECT COUNT(*) as count FROM servicos_prof WHERE tenant_id = $1 AND ativo = true AND visivel_cliente = true',
      [TEST_TENANT_ID]
    );
    
    const serviceCount = parseInt(countResult.rows[0].count);
    if (serviceCount < MIN_SERVICES) {
      throw new Error(`Expected at least ${MIN_SERVICES} services, but got ${serviceCount}`);
    }
    
    logger.info(`Performance test setup complete with ${serviceCount} services`);
  });
  
  afterAll(async () => {
    // Clean up test data
    await pool.query('DELETE FROM servicos_prof WHERE tenant_id = $1', [TEST_TENANT_ID]);
  });
  
  test('should use idx_servicos_prof_lookup_v2 index for catalog queries', async () => {
    const searchTerm = 'teste';
    const query = `
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT servico_id, servico_nome
      FROM servicos_prof
      WHERE tenant_id = $1
        AND ativo = true
        AND visivel_cliente = true
        AND servico_nome_norm LIKE $2 || '%'
      ORDER BY servico_nome_norm
      LIMIT 20
    `;
    
    const result = await pool.query(query, [TEST_TENANT_ID, searchTerm]);
    const plan = result.rows[0]['QUERY PLAN'][0];
    
    // Check if the index is being used
    const planText = JSON.stringify(plan);
    const usesIndex = planText.includes('idx_servicos_prof_lookup_v2') || 
                     planText.includes('Index Scan') || 
                     planText.includes('Bitmap Index Scan');
    
    expect(usesIndex).toBe(true);
    
    // Log the execution plan for debugging
    logger.info('Query execution plan:', JSON.stringify(plan, null, 2));
    
    // Check execution time (should be < 50ms)
    const executionTime = plan['Execution Time'];
    expect(executionTime).toBeLessThan(50);
    
    logger.info(`Query executed in ${executionTime}ms`);
  });
  
  test('should perform well with prefix search', async () => {
    const searchTerms = ['ser', 'test', 'serv', 'de'];
    
    for (const term of searchTerms) {
      const startTime = Date.now();
      
      const result = await pool.query(
        `SELECT servico_id, servico_nome
         FROM servicos_prof
         WHERE tenant_id = $1
           AND ativo = true
           AND visivel_cliente = true
           AND servico_nome_norm LIKE $2 || '%'
         ORDER BY servico_nome_norm
         LIMIT 20`,
        [TEST_TENANT_ID, term]
      );
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      expect(result.rows.length).toBeGreaterThan(0);
      expect(duration).toBeLessThan(50); // P50 < 50ms requirement
      
      logger.info(`Search for '${term}' returned ${result.rows.length} results in ${duration}ms`);
    }
  });
  
  test('should use idx_servicos_prof_servico_v2 index for service lookup', async () => {
    const serviceId = 1;
    const query = `
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT servico_id, servico_nome, duracao_min, valor
      FROM servicos_prof
      WHERE tenant_id = $1
        AND servico_id = $2
    `;
    
    const result = await pool.query(query, [TEST_TENANT_ID, serviceId]);
    const plan = result.rows[0]['QUERY PLAN'][0];
    
    // Check if the index is being used
    const planText = JSON.stringify(plan);
    const usesIndex = planText.includes('idx_servicos_prof_servico_v2') || 
                     planText.includes('Index Scan');
    
    expect(usesIndex).toBe(true);
    
    // Check execution time
    const executionTime = plan['Execution Time'];
    expect(executionTime).toBeLessThan(10); // Should be very fast for exact lookup
    
    logger.info(`Service lookup executed in ${executionTime}ms`);
  });
  
  test('should handle concurrent queries efficiently', async () => {
    const concurrentQueries = 10;
    const searchTerm = 'teste';
    
    const queryPromises = Array.from({ length: concurrentQueries }, (_, i) => {
      return pool.query(
        `SELECT servico_id, servico_nome
         FROM servicos_prof
         WHERE tenant_id = $1
           AND ativo = true
           AND visivel_cliente = true
           AND servico_nome_norm LIKE $2 || '%'
         ORDER BY servico_nome_norm
         LIMIT 20`,
        [TEST_TENANT_ID, `${searchTerm}${i % 3}`] // Vary search terms slightly
      );
    });
    
    const startTime = Date.now();
    const results = await Promise.all(queryPromises);
    const endTime = Date.now();
    
    const totalDuration = endTime - startTime;
    const avgDuration = totalDuration / concurrentQueries;
    
    // All queries should complete
    expect(results).toHaveLength(concurrentQueries);
    
    // Average duration should still be reasonable
    expect(avgDuration).toBeLessThan(100);
    
    logger.info(`${concurrentQueries} concurrent queries completed in ${totalDuration}ms (avg: ${avgDuration}ms)`);
  });
  
  test('should validate servico_nome_norm column exists and is populated', async () => {
    const result = await pool.query(
      `SELECT servico_nome, servico_nome_norm
       FROM servicos_prof
       WHERE tenant_id = $1
         AND servico_nome_norm IS NOT NULL
       LIMIT 5`,
      [TEST_TENANT_ID]
    );
    
    expect(result.rows.length).toBeGreaterThan(0);
    
    // Verify normalization is working correctly
    for (const row of result.rows) {
      const expected = row.servico_nome.toLowerCase().trim();
      expect(row.servico_nome_norm).toBe(expected);
    }
    
    logger.info('servico_nome_norm column validation passed');
  });
});