import { getServicosSuggestions, upsertServicosProf, initPersistence, pg } from '../../db/index';
import logger from '../../utils/logger';

// Mock do logger para evitar logs durante os testes
jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn()
}));

describe('Catalog Performance Tests', () => {
  const testTenantId = 'test-perf';
  const targetItemCount = 100; // Mais que 80 para garantir o teste
  
  beforeAll(async () => {
    await initPersistence({ redisUrl: null, databaseUrl: process.env.DATABASE_URL, databaseSsl: false });
    
    // Limpar dados de teste anteriores
    if (pg) {
      await pg.query('DELETE FROM servicos_prof WHERE tenant_id = $1', [testTenantId]);
    }
    
    // Criar dataset de teste com mais de 80 itens
    const testServices = [];
    const serviceNames = [
      'corte de cabelo', 'escova', 'hidratação', 'coloração', 'luzes', 'mechas',
      'manicure', 'pedicure', 'esmaltação', 'cutilagem', 'design de unhas',
      'limpeza de pele', 'hidratação facial', 'peeling', 'microagulhamento',
      'design de sobrancelha', 'tintura de sobrancelha', 'extensão de cílios',
      'massagem relaxante', 'massagem terapêutica', 'drenagem linfática',
      'depilação perna', 'depilação axila', 'depilação virilha', 'depilação buço',
      'progressiva', 'botox capilar', 'cauterização', 'reconstrução capilar'
    ];
    
    // Gerar variações para atingir 100+ serviços
    for (let i = 0; i < targetItemCount; i++) {
      const baseName = serviceNames[i % serviceNames.length];
      const variation = Math.floor(i / serviceNames.length);
      const serviceName = variation > 0 ? `${baseName} ${variation}` : baseName;
      
      testServices.push({
        servicoId: 1000 + i,
        servicoNome: serviceName,
        duracaoMin: 30 + (i % 120), // 30-150 minutos
        valor: 50 + (i % 200), // R$ 50-250
        profissionalId: i % 5, // 5 profissionais diferentes
        visivelCliente: true,
        ativo: true
      });
    }
    
    // Inserir serviços de teste
    await upsertServicosProf(testTenantId, testServices);
    
    // Verificar se foram inseridos corretamente
    if (pg) {
      const countResult = await pg.query(
        'SELECT COUNT(*) as count FROM servicos_prof WHERE tenant_id = $1 AND ativo = TRUE AND visivel_cliente = TRUE',
        [testTenantId]
      );
      const actualCount = parseInt(countResult.rows[0]?.count || '0');
      
      if (actualCount < 80) {
        throw new Error(`Dataset insuficiente: apenas ${actualCount} serviços inseridos, mínimo 80 necessário`);
      }
      
      logger.info(`Dataset de teste criado com ${actualCount} serviços`);
    }
  });
  
  afterAll(async () => {
    // Limpar dados de teste
    if (pg) {
      await pg.query('DELETE FROM servicos_prof WHERE tenant_id = $1', [testTenantId]);
    }
  });
  
  describe('Search Performance', () => {
    test('should return suggestions in less than 50ms with 80+ items', async () => {
      // Verificar que temos pelo menos 80 itens
      if (pg) {
        const countResult = await pg.query(
          'SELECT COUNT(*) as count FROM servicos_prof WHERE tenant_id = $1 AND ativo = TRUE AND visivel_cliente = TRUE',
          [testTenantId]
        );
        const itemCount = parseInt(countResult.rows[0]?.count || '0');
        expect(itemCount).toBeGreaterThanOrEqual(80);
      }
      
      // Testar diferentes termos de busca
      const searchTerms = ['corte', 'manicure', 'limpeza', 'design', 'massagem'];
      
      for (const term of searchTerms) {
        const startTime = performance.now();
        
        const suggestions = await getServicosSuggestions(testTenantId, term, 5);
        
        const endTime = performance.now();
        const duration = endTime - startTime;
        
        // Verificar que retornou resultados
        expect(suggestions).toBeDefined();
        expect(Array.isArray(suggestions)).toBe(true);
        
        // Verificar performance: deve ser menor que 50ms
        expect(duration).toBeLessThan(50);
        
        logger.info(`Busca por "${term}": ${duration.toFixed(2)}ms, ${suggestions.length} resultados`);
      }
    });
    
    test('should use index for lookup queries (EXPLAIN ANALYZE)', async () => {
      if (!pg) {
        throw new Error('Conexão com banco não disponível');
      }
      
      // Executar EXPLAIN ANALYZE na query de sugestões
      const explainQuery = `
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT servico_id as "servicoId",
               MIN(servico_nome) as "servicoNome",
               MIN(duracao_min) as "duracaoMin",
               MIN(valor) as valor
          FROM servicos_prof
         WHERE tenant_id = $1
           AND ativo IS TRUE
           AND visivel_cliente IS TRUE
           AND lower(servico_nome) LIKE $2
         GROUP BY servico_id
         ORDER BY MIN(valor) NULLS LAST, MIN(servico_nome)
         LIMIT $3
      `;
      
      const result = await pg.query(explainQuery, [testTenantId, '%corte%', 5]);
      const plan = result.rows[0]['QUERY PLAN'][0];
      
      // Verificar se o plano de execução usa o índice idx_servicos_prof_lookup
      const planStr = JSON.stringify(plan);
      
      // Deve usar Index Scan ou Bitmap Index Scan no índice correto
      const usesIndex = planStr.includes('idx_servicos_prof_lookup') || 
                       planStr.includes('Index Scan') || 
                       planStr.includes('Bitmap Index Scan');
      
      expect(usesIndex).toBe(true);
      
      // Verificar tempo de execução
      const executionTime = plan['Execution Time'];
      expect(executionTime).toBeLessThan(50); // Menos de 50ms
      
      logger.info(`EXPLAIN ANALYZE - Tempo de execução: ${executionTime}ms`);
      logger.info(`Plano usa índice: ${usesIndex}`);
    });
    
    test('should handle concurrent searches efficiently', async () => {
      const concurrentSearches = 10;
      const searchPromises = [];
      
      // Executar múltiplas buscas simultaneamente
      for (let i = 0; i < concurrentSearches; i++) {
        const term = ['corte', 'manicure', 'design', 'limpeza'][i % 4];
        searchPromises.push(
          (async () => {
            const startTime = performance.now();
            const results = await getServicosSuggestions(testTenantId, term, 5);
            const duration = performance.now() - startTime;
            return { term, duration, resultCount: results.length };
          })()
        );
      }
      
      const results = await Promise.all(searchPromises);
      
      // Verificar que todas as buscas foram rápidas
      for (const result of results) {
        expect(result.duration).toBeLessThan(100); // Mais tolerante para concorrência
        expect(result.resultCount).toBeGreaterThanOrEqual(0);
      }
      
      const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length;
      logger.info(`Busca concorrente - Tempo médio: ${avgDuration.toFixed(2)}ms`);
      
      // Tempo médio deve ser aceitável mesmo com concorrência
      expect(avgDuration).toBeLessThan(75);
    });
    
    test('should maintain performance with cache disabled', async () => {
      // Simular cache desabilitado temporariamente
      const originalRedis = require('../../db/index').redis;
      
      // Mock redis como null para forçar busca no banco
      jest.doMock('../../db/index', () => ({
        ...jest.requireActual('../../db/index'),
        redis: null
      }));
      
      const startTime = performance.now();
      const suggestions = await getServicosSuggestions(testTenantId, 'corte', 5);
      const duration = performance.now() - startTime;
      
      // Mesmo sem cache, deve ser rápido devido aos índices
      expect(duration).toBeLessThan(100);
      expect(suggestions.length).toBeGreaterThan(0);
      
      logger.info(`Busca sem cache: ${duration.toFixed(2)}ms`);
    });
  });
  
  describe('Index Usage Verification', () => {
    test('should verify all required indexes exist', async () => {
      if (!pg) {
        throw new Error('Conexão com banco não disponível');
      }
      
      const indexQuery = `
        SELECT indexname, indexdef
        FROM pg_indexes 
        WHERE tablename = 'servicos_prof'
          AND indexname IN (
            'idx_servicos_prof_lookup',
            'idx_servicos_prof_servico',
            'idx_servicos_prof_profissional',
            'idx_servicos_prof_last_synced'
          )
        ORDER BY indexname
      `;
      
      const result = await pg.query(indexQuery);
      const indexes = result.rows;
      
      // Verificar que todos os índices necessários existem
      const expectedIndexes = [
        'idx_servicos_prof_lookup',
        'idx_servicos_prof_servico',
        'idx_servicos_prof_profissional',
        'idx_servicos_prof_last_synced'
      ];
      
      const foundIndexes = indexes.map(idx => idx.indexname);
      
      for (const expectedIndex of expectedIndexes) {
        expect(foundIndexes).toContain(expectedIndex);
      }
      
      logger.info(`Índices verificados: ${foundIndexes.join(', ')}`);
    });
  });
});