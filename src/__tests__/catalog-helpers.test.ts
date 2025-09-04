/**
 * Testes para helpers de catálogo - P1.1
 * Valida normalização, upsert e performance de consultas
 */

import { Pool } from 'pg';
import {
  normalizeServiceName,
  generateIdempotencyKey,
  upsertServicoProf,
  searchServicesByPrefix,
  explainServiceSearch,
  ServicoProf
} from '../utils/catalog-helpers';

// Mock do pool de conexão
const mockPool = {
  query: jest.fn()
} as unknown as Pool;

describe('Catalog Helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('normalizeServiceName', () => {
    it('deve normalizar nomes de serviços corretamente', () => {
      expect(normalizeServiceName('  Corte Feminino  ')).toBe('corte feminino');
      expect(normalizeServiceName('COLORAÇÃO')).toBe('coloração');
      expect(normalizeServiceName('Manicure & Pedicure')).toBe('manicure & pedicure');
      expect(normalizeServiceName('')).toBe('');
    });

    it('deve manter caracteres especiais', () => {
      expect(normalizeServiceName('Corte & Escova')).toBe('corte & escova');
      expect(normalizeServiceName('Hidratação - Premium')).toBe('hidratação - premium');
    });
  });

  describe('generateIdempotencyKey', () => {
    it('deve gerar chaves consistentes para os mesmos parâmetros', () => {
      const key1 = generateIdempotencyKey('42', '11999999999', 1001, '2024-01-15', '14:30');
      const key2 = generateIdempotencyKey('42', '11999999999', 1001, '2024-01-15', '14:30');
      
      expect(key1).toBe(key2);
      expect(key1).toMatch(/^idem:42:[a-f0-9]{64}$/);
    });

    it('deve gerar chaves diferentes para parâmetros diferentes', () => {
      const key1 = generateIdempotencyKey('42', '11999999999', 1001, '2024-01-15', '14:30');
      const key2 = generateIdempotencyKey('42', '11999999999', 1001, '2024-01-15', '15:30');
      
      expect(key1).not.toBe(key2);
    });
  });

  describe('upsertServicoProf', () => {
    it('deve executar upsert com parâmetros corretos', async () => {
      const servico: ServicoProf = {
        tenant_id: '42',
        servico_id: 1001,
        servico_nome: 'Corte Feminino',
        ativo: true,
        visivel_cliente: true,
        duracao_min: 60,
        valor: 50.00,
        profissional_id: 1
      };

      const mockResult = { rows: [{ ...servico, id: 1 }] };
      (mockPool.query as jest.Mock).mockResolvedValue(mockResult);

      const result = await upsertServicoProf(mockPool, servico);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO public.servicos_prof'),
        [
          '42',
          1001,
          'Corte Feminino',
          true,
          true,
          60,
          50.00,
          1
        ]
      );
      expect(result).toEqual({ ...servico, id: 1 });
    });

    it('deve lidar com valores opcionais nulos', async () => {
      const servico: ServicoProf = {
        tenant_id: '42',
        servico_id: 1001,
        servico_nome: 'Corte Feminino',
        ativo: true,
        visivel_cliente: true
      };

      const mockResult = { rows: [servico] };
      (mockPool.query as jest.Mock).mockResolvedValue(mockResult);

      await upsertServicoProf(mockPool, servico);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO public.servicos_prof'),
        [
          '42',
          1001,
          'Corte Feminino',
          true,
          true,
          null,
          null,
          null
        ]
      );
    });
  });

  describe('searchServicesByPrefix', () => {
    it('deve buscar serviços por prefixo normalizado', async () => {
      const mockServices = [
        { servico_id: 1, servico_nome: 'Corte Feminino' },
        { servico_id: 2, servico_nome: 'Coloração' }
      ];
      (mockPool.query as jest.Mock).mockResolvedValue({ rows: mockServices });

      const result = await searchServicesByPrefix(mockPool, '42', 'COR', 10);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM public.servicos_prof'),
        ['42', 'cor%', 10]
      );
      expect(result).toEqual(mockServices);
    });

    it('deve usar limite padrão de 20', async () => {
      (mockPool.query as jest.Mock).mockResolvedValue({ rows: [] });

      await searchServicesByPrefix(mockPool, '42', 'cor');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ['42', 'cor%', 20]
      );
    });
  });

  describe('explainServiceSearch', () => {
    it('deve executar EXPLAIN ANALYZE para análise de performance', async () => {
      const mockExplain = [
        { 'QUERY PLAN': 'Index Scan using idx_servicos_prof_lookup_pt2' }
      ];
      (mockPool.query as jest.Mock).mockResolvedValue({ rows: mockExplain });

      const result = await explainServiceSearch(mockPool, '42', 'cor');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('EXPLAIN (ANALYZE, BUFFERS, VERBOSE)'),
        ['42', 'cor%']
      );
      expect(result).toEqual(mockExplain);
    });
  });
});

// Testes de integração (comentados para não executar em CI)
/*
describe('Catalog Integration Tests', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('deve validar performance de consulta real', async () => {
    // Inserir dados de teste
    const testServices = Array.from({ length: 100 }, (_, i) => ({
      tenant_id: 'test-tenant',
      servico_id: i + 1,
      servico_nome: `Serviço Teste ${i + 1}`,
      ativo: true,
      visivel_cliente: true
    }));

    for (const service of testServices) {
      await upsertServicoProf(pool, service);
    }

    // Testar performance
    const start = Date.now();
    const results = await searchServicesByPrefix(pool, 'test-tenant', 'serviço', 20);
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(50); // < 50ms
    expect(results.length).toBeGreaterThan(0);

    // Validar uso do índice
    const explain = await explainServiceSearch(pool, 'test-tenant', 'serviço');
    const planText = explain.map(row => row['QUERY PLAN']).join(' ');
    expect(planText).toContain('idx_servicos_prof_lookup_pt2');

    // Limpar dados de teste
    await pool.query("DELETE FROM servicos_prof WHERE tenant_id = 'test-tenant'");
  });
});
*/