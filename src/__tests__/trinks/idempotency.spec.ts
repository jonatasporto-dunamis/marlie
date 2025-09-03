import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { Trinks } from '../../integrations/trinks';
import { redis } from '../../db/index';
import { generateBookingIdempotencyKey } from '../../utils/idempotency';

describe('Trinks Idempotency Tests', () => {
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
  
  it('should prevent duplicate bookings with same idempotency key', async () => {
    const agendamentoData = {
      clienteId: '123',
      servicoId: 456,
      profissionalId: 789,
      dataHoraInicio: '2024-02-15T10:00:00',
      dataHoraFim: '2024-02-15T11:00:00',
      telefone: '11999999999',
      observacoes: 'Teste de idempotência'
    };
    
    const expectedResponse = {
      id: 'booking-123',
      status: 'confirmed',
      ...agendamentoData
    };
    
    // Mock successful booking creation
    mockAxios.onPost('/v1/agendamentos').reply(200, expectedResponse);
    
    // First call - should create booking
    const result1 = await Trinks.criarAgendamento(agendamentoData);
    expect(result1).toEqual(expectedResponse);
    expect(mockAxios.history.post).toHaveLength(1);
    
    // Second call with same data - should return cached result
    const result2 = await Trinks.criarAgendamento(agendamentoData);
    expect(result2).toEqual(expectedResponse);
    expect(mockAxios.history.post).toHaveLength(1); // No additional API call
    
    // Verify both results are identical
    expect(result1).toEqual(result2);
  });
  
  it('should allow different bookings with different idempotency keys', async () => {
    const baseData = {
      clienteId: '123',
      servicoId: 456,
      profissionalId: 789,
      telefone: '11999999999'
    };
    
    const agendamento1 = {
      ...baseData,
      dataHoraInicio: '2024-02-15T10:00:00',
      dataHoraFim: '2024-02-15T11:00:00'
    };
    
    const agendamento2 = {
      ...baseData,
      dataHoraInicio: '2024-02-15T14:00:00', // Different time
      dataHoraFim: '2024-02-15T15:00:00'
    };
    
    // Mock responses
    mockAxios
      .onPost('/v1/agendamentos')
      .replyOnce(200, { id: 'booking-1', ...agendamento1 })
      .onPost('/v1/agendamentos')
      .replyOnce(200, { id: 'booking-2', ...agendamento2 });
    
    // Both calls should succeed and create different bookings
    const result1 = await Trinks.criarAgendamento(agendamento1);
    const result2 = await Trinks.criarAgendamento(agendamento2);
    
    expect(result1.id).toBe('booking-1');
    expect(result2.id).toBe('booking-2');
    expect(mockAxios.history.post).toHaveLength(2);
  });
  
  it('should handle idempotency key generation correctly', () => {
    const bookingData1 = {
      telefone: '11999999999',
      servicoId: '456',
      data: '2024-02-15',
      horario: '10:00'
    };
    
    const bookingData2 = {
      telefone: '11999999999',
      servicoId: '456',
      data: '2024-02-15',
      horario: '10:00'
    };
    
    const bookingData3 = {
      telefone: '11999999999',
      servicoId: '456',
      data: '2024-02-15',
      horario: '14:00' // Different time
    };
    
    const key1 = generateBookingIdempotencyKey(bookingData1);
    const key2 = generateBookingIdempotencyKey(bookingData2);
    const key3 = generateBookingIdempotencyKey(bookingData3);
    
    // Same data should generate same key
    expect(key1).toBe(key2);
    
    // Different data should generate different key
    expect(key1).not.toBe(key3);
    
    // Keys should be valid format
    expect(key1).toMatch(/^idemp:booking:[a-f0-9]{64}$/);
    expect(key3).toMatch(/^idemp:booking:[a-f0-9]{64}$/);
  });
  
  it('should respect idempotency TTL and allow retry after expiration', async () => {
    const agendamentoData = {
      clienteId: '123',
      servicoId: 456,
      profissionalId: 789,
      dataHoraInicio: '2024-02-15T10:00:00',
      dataHoraFim: '2024-02-15T11:00:00',
      telefone: '11999999999'
    };
    
    const expectedResponse = {
      id: 'booking-123',
      status: 'confirmed',
      ...agendamentoData
    };
    
    // Mock successful booking creation
    mockAxios.onPost('/v1/agendamentos').reply(200, expectedResponse);
    
    // First call
    const result1 = await Trinks.criarAgendamento(agendamentoData);
    expect(result1).toEqual(expectedResponse);
    expect(mockAxios.history.post).toHaveLength(1);
    
    // Generate the idempotency key to check Redis
    const idempotencyKey = generateBookingIdempotencyKey({
      telefone: agendamentoData.telefone,
      servicoId: agendamentoData.servicoId.toString(),
      data: agendamentoData.dataHoraInicio.split('T')[0],
      horario: agendamentoData.dataHoraInicio.split('T')[1]?.substring(0, 5) || ''
    });
    
    // Verify key exists in Redis
    const cachedResult = await redis.get(idempotencyKey);
    expect(cachedResult).toBeTruthy();
    
    // Manually expire the key
    await redis.del(idempotencyKey);
    
    // Mock another successful response
    mockAxios.onPost('/v1/agendamentos').reply(200, {
      id: 'booking-456', // Different ID
      status: 'confirmed',
      ...agendamentoData
    });
    
    // Call again after expiration - should make new API call
    const result2 = await Trinks.criarAgendamento(agendamentoData);
    expect(result2.id).toBe('booking-456');
    expect(mockAxios.history.post).toHaveLength(2);
  });
  
  it('should handle API errors during idempotent operations', async () => {
    const agendamentoData = {
      clienteId: '123',
      servicoId: 456,
      profissionalId: 789,
      dataHoraInicio: '2024-02-15T10:00:00',
      dataHoraFim: '2024-02-15T11:00:00',
      telefone: '11999999999'
    };
    
    // Mock API error
    mockAxios.onPost('/v1/agendamentos').reply(500, { error: 'Internal server error' });
    
    // First call should fail
    await expect(Trinks.criarAgendamento(agendamentoData)).rejects.toThrow();
    
    // Second call should also fail (not cached)
    await expect(Trinks.criarAgendamento(agendamentoData)).rejects.toThrow();
    
    // Should have made 2 API calls (errors are not cached)
    expect(mockAxios.history.post).toHaveLength(2);
  });
  
  it('should invalidate agenda cache after successful booking', async () => {
    const agendamentoData = {
      clienteId: '123',
      servicoId: 456,
      profissionalId: 789,
      dataHoraInicio: '2024-02-15T10:00:00',
      dataHoraFim: '2024-02-15T11:00:00',
      telefone: '11999999999'
    };
    
    // Pre-populate agenda cache
    const agendaCacheKey = `trinks:agenda:${agendamentoData.profissionalId}:2024-02-15`;
    await redis.setex(agendaCacheKey, 3600, JSON.stringify({ agenda: 'cached' }));
    
    // Verify cache exists
    const cachedAgenda = await redis.get(agendaCacheKey);
    expect(cachedAgenda).toBeTruthy();
    
    // Mock successful booking
    mockAxios.onPost('/v1/agendamentos').reply(200, {
      id: 'booking-123',
      status: 'confirmed',
      ...agendamentoData
    });
    
    // Create booking
    await Trinks.criarAgendamento(agendamentoData);
    
    // Verify agenda cache was invalidated
    const invalidatedCache = await redis.get(agendaCacheKey);
    expect(invalidatedCache).toBeNull();
  });
});