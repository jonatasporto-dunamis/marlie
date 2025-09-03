import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { Trinks } from '../../integrations/trinks';
import { redis } from '../../db/index';

describe('Trinks Retry 429 Tests', () => {
  let mockAxios: MockAdapter;
  
  beforeEach(async () => {
    // Clear Redis cache
    await redis.flushdb();
    
    // Mock environment variables
    process.env.TRINKS_BASE_URL = 'https://api.trinks.test';
    process.env.TRINKS_API_KEY = 'test-key';
    process.env.TRINKS_ESTABELECIMENTO_ID = 'test-estabelecimento';
    
    mockAxios = new MockAdapter(axios);
  });
  
  afterEach(() => {
    mockAxios.restore();
  });
  
  afterAll(async () => {
    await redis.quit();
  });
  
  it('should retry with progressive delays on 429 errors', async () => {
    const timestamps: number[] = [];
    
    // Mock 429 responses for first 2 attempts, then success
    mockAxios
      .onGet('/v1/servicos')
      .replyOnce(() => {
        timestamps.push(Date.now());
        return [429, { error: 'Rate limit exceeded' }];
      })
      .onGet('/v1/servicos')
      .replyOnce(() => {
        timestamps.push(Date.now());
        return [429, { error: 'Rate limit exceeded' }];
      })
      .onGet('/v1/servicos')
      .replyOnce(() => {
        timestamps.push(Date.now());
        return [200, { servicos: [{ id: 1, nome: 'Teste' }] }];
      });
    
    const startTime = Date.now();
    const result = await Trinks.buscarServicos({});
    
    // Verify successful result
    expect(result.servicos).toHaveLength(1);
    expect(result.servicos[0].nome).toBe('Teste');
    
    // Verify progressive delays
    expect(timestamps).toHaveLength(3);
    
    // First retry should have delay (around 1s + jitter)
    const firstDelay = timestamps[1] - timestamps[0];
    expect(firstDelay).toBeGreaterThan(800); // At least 800ms (considering jitter)
    expect(firstDelay).toBeLessThan(2000); // Less than 2s
    
    // Second retry should have longer delay (around 2s + jitter)
    const secondDelay = timestamps[2] - timestamps[1];
    expect(secondDelay).toBeGreaterThan(1500); // At least 1.5s
    expect(secondDelay).toBeLessThan(4000); // Less than 4s
    
    // Total time should be reasonable
    const totalTime = Date.now() - startTime;
    expect(totalTime).toBeGreaterThan(2000); // At least 2s for retries
    expect(totalTime).toBeLessThan(10000); // Less than 10s total
  });
  
  it('should fail after max retries on persistent 429', async () => {
    // Mock persistent 429 responses
    mockAxios.onGet('/v1/servicos').reply(429, { error: 'Rate limit exceeded' });
    
    const startTime = Date.now();
    
    await expect(Trinks.buscarServicos({})).rejects.toThrow();
    
    // Should have tried 3 times (initial + 2 retries)
    expect(mockAxios.history.get).toHaveLength(3);
    
    // Should have taken time for retries
    const totalTime = Date.now() - startTime;
    expect(totalTime).toBeGreaterThan(3000); // At least 3s for retries
  });
  
  it('should not retry non-idempotent POST requests on 429', async () => {
    const clienteData = {
      nome: 'João Silva',
      telefone: '11999999999',
      email: 'joao@test.com'
    };
    
    // Mock 429 response
    mockAxios.onPost('/v1/clientes').reply(429, { error: 'Rate limit exceeded' });
    
    await expect(Trinks.criarCliente(clienteData)).rejects.toThrow();
    
    // Should NOT retry POST requests
    expect(mockAxios.history.post).toHaveLength(1);
  });
  
  it('should retry GET requests but not POST on 500 errors', async () => {
    // Test GET retry on 500
    mockAxios
      .onGet('/v1/servicos')
      .replyOnce(500, { error: 'Internal server error' })
      .onGet('/v1/servicos')
      .replyOnce(200, { servicos: [] });
    
    const result = await Trinks.buscarServicos({});
    expect(result.servicos).toEqual([]);
    expect(mockAxios.history.get).toHaveLength(2);
    
    // Reset mock
    mockAxios.reset();
    
    // Test POST no retry on 500
    const clienteData = {
      nome: 'João Silva',
      telefone: '11999999999'
    };
    
    mockAxios.onPost('/v1/clientes').reply(500, { error: 'Internal server error' });
    
    await expect(Trinks.criarCliente(clienteData)).rejects.toThrow();
    expect(mockAxios.history.post).toHaveLength(1);
  });
  
  it('should use cached results and avoid API calls', async () => {
    const servicosData = { servicos: [{ id: 1, nome: 'Cached Service' }] };
    
    // First call - should hit API and cache
    mockAxios.onGet('/v1/servicos').replyOnce(200, servicosData);
    
    const result1 = await Trinks.buscarServicos({});
    expect(result1).toEqual(servicosData);
    expect(mockAxios.history.get).toHaveLength(1);
    
    // Second call - should use cache
    const result2 = await Trinks.buscarServicos({});
    expect(result2).toEqual(servicosData);
    expect(mockAxios.history.get).toHaveLength(1); // No additional API call
  });
});