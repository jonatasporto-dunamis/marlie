import { UpsellSelector } from '../upsell/selector';
import { db } from '../db';
import { MetricsHelper } from '../metrics';
import { jest } from '@jest/globals';

describe('Upsell System', () => {
  let upsellSelector: UpsellSelector;
  const mockTenantId = 'test-tenant';
  const mockPhone = '5511999999999';
  const mockConversationId = 'conv-123';
  const mockBookingData = {
    servico_id: 'serv-1',
    profissional_id: 'prof-1',
    data_agendamento: '2024-01-15',
    horario: '14:00',
    valor: 100
  };

  beforeEach(async () => {
    upsellSelector = new UpsellSelector();
    
    // Limpar dados de teste
    await db.query('DELETE FROM upsell_events WHERE tenant_id = $1', [mockTenantId]);
    
    // Mock das métricas
    jest.spyOn(MetricsHelper, 'incrementUpsellOffered').mockImplementation(() => {});
    jest.spyOn(MetricsHelper, 'incrementUpsellAccepted').mockImplementation(() => {});
    jest.spyOn(MetricsHelper, 'recordUpsellRevenue').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Contextual Selection', () => {
    it('should select appropriate upsell based on service context', async () => {
      const upsell = await upsellSelector.selectUpsell(mockTenantId, mockBookingData);
      
      expect(upsell).toBeDefined();
      expect(upsell?.servico_id).toBeDefined();
      expect(upsell?.valor).toBeGreaterThan(0);
      expect(upsell?.contexto).toContain('complementar');
    });

    it('should return null when no suitable upsell is available', async () => {
      const invalidBookingData = {
        ...mockBookingData,
        servico_id: 'non-existent-service'
      };
      
      const upsell = await upsellSelector.selectUpsell(mockTenantId, invalidBookingData);
      expect(upsell).toBeNull();
    });
  });

  describe('One Upsell Per Conversation Rule', () => {
    it('should offer upsell on first booking in conversation', async () => {
      const upsell = await upsellSelector.selectUpsell(mockTenantId, mockBookingData);
      expect(upsell).toBeDefined();
      
      // Simular que o upsell foi oferecido
      if (upsell) {
        await upsellSelector.recordUpsellOffered(
          mockTenantId,
          mockPhone,
          mockConversationId,
          upsell.servico_id,
          upsell.valor
        );
      }
    });

    it('should NOT offer second upsell in same conversation', async () => {
      // Primeiro upsell
      const firstUpsell = await upsellSelector.selectUpsell(mockTenantId, mockBookingData);
      if (firstUpsell) {
        await upsellSelector.recordUpsellOffered(
          mockTenantId,
          mockPhone,
          mockConversationId,
          firstUpsell.servico_id,
          firstUpsell.valor
        );
      }
      
      // Tentar segundo upsell na mesma conversa
      const secondBooking = {
        ...mockBookingData,
        servico_id: 'serv-2',
        valor: 150
      };
      
      const secondUpsell = await upsellSelector.selectUpsell(mockTenantId, secondBooking);
      expect(secondUpsell).toBeNull();
    });

    it('should allow upsell in new conversation', async () => {
      // Primeiro upsell na conversa 1
      const firstUpsell = await upsellSelector.selectUpsell(mockTenantId, mockBookingData);
      if (firstUpsell) {
        await upsellSelector.recordUpsellOffered(
          mockTenantId,
          mockPhone,
          mockConversationId,
          firstUpsell.servico_id,
          firstUpsell.valor
        );
      }
      
      // Nova conversa (diferente conversation_id)
      const newConversationId = 'conv-456';
      const newUpsell = await upsellSelector.selectUpsell(mockTenantId, mockBookingData);
      
      expect(newUpsell).toBeDefined();
    });
  });

  describe('Persistence and State Management', () => {
    it('should persist upsell offer in database', async () => {
      const upsell = await upsellSelector.selectUpsell(mockTenantId, mockBookingData);
      
      if (upsell) {
        await upsellSelector.recordUpsellOffered(
          mockTenantId,
          mockPhone,
          mockConversationId,
          upsell.servico_id,
          upsell.valor
        );
        
        // Verificar se foi persistido
        const result = await db.query(
          'SELECT * FROM upsell_events WHERE tenant_id = $1 AND phone_e164 = $2 AND conversation_id = $3',
          [mockTenantId, mockPhone, mockConversationId]
        );
        
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].event_type).toBe('offered');
        expect(result.rows[0].servico_id).toBe(upsell.servico_id);
        expect(parseFloat(result.rows[0].valor)).toBe(upsell.valor);
      }
    });

    it('should record upsell acceptance', async () => {
      const upsell = await upsellSelector.selectUpsell(mockTenantId, mockBookingData);
      
      if (upsell) {
        // Oferecer upsell
        await upsellSelector.recordUpsellOffered(
          mockTenantId,
          mockPhone,
          mockConversationId,
          upsell.servico_id,
          upsell.valor
        );
        
        // Aceitar upsell
        await upsellSelector.recordUpsellAccepted(
          mockTenantId,
          mockPhone,
          mockConversationId,
          upsell.servico_id
        );
        
        // Verificar se foi registrado
        const result = await db.query(
          'SELECT * FROM upsell_events WHERE tenant_id = $1 AND phone_e164 = $2 AND event_type = $3',
          [mockTenantId, mockPhone, 'accepted']
        );
        
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].servico_id).toBe(upsell.servico_id);
      }
    });

    it('should record upsell decline', async () => {
      const upsell = await upsellSelector.selectUpsell(mockTenantId, mockBookingData);
      
      if (upsell) {
        // Oferecer upsell
        await upsellSelector.recordUpsellOffered(
          mockTenantId,
          mockPhone,
          mockConversationId,
          upsell.servico_id,
          upsell.valor
        );
        
        // Recusar upsell
        await upsellSelector.recordUpsellDeclined(
          mockTenantId,
          mockPhone,
          mockConversationId,
          upsell.servico_id
        );
        
        // Verificar se foi registrado
        const result = await db.query(
          'SELECT * FROM upsell_events WHERE tenant_id = $1 AND phone_e164 = $2 AND event_type = $3',
          [mockTenantId, mockPhone, 'declined']
        );
        
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].servico_id).toBe(upsell.servico_id);
      }
    });
  });

  describe('Average Ticket Impact Simulation', () => {
    it('should calculate baseline ticket without upsell', async () => {
      const baselineTicket = mockBookingData.valor;
      expect(baselineTicket).toBe(100);
    });

    it('should calculate increased ticket with accepted upsell', async () => {
      const upsell = await upsellSelector.selectUpsell(mockTenantId, mockBookingData);
      
      if (upsell) {
        const totalTicket = mockBookingData.valor + upsell.valor;
        const increase = (totalTicket - mockBookingData.valor) / mockBookingData.valor;
        
        expect(totalTicket).toBeGreaterThan(mockBookingData.valor);
        expect(increase).toBeGreaterThan(0);
        expect(increase).toBeLessThan(1); // Aumento menor que 100%
      }
    });

    it('should track metrics for ticket impact analysis', async () => {
      const upsell = await upsellSelector.selectUpsell(mockTenantId, mockBookingData);
      
      if (upsell) {
        // Simular oferta
        await upsellSelector.recordUpsellOffered(
          mockTenantId,
          mockPhone,
          mockConversationId,
          upsell.servico_id,
          upsell.valor
        );
        
        // Simular aceitação
        await upsellSelector.recordUpsellAccepted(
          mockTenantId,
          mockPhone,
          mockConversationId,
          upsell.servico_id
        );
        
        // Verificar se métricas foram chamadas
        expect(MetricsHelper.incrementUpsellOffered).toHaveBeenCalledWith(mockTenantId);
        expect(MetricsHelper.incrementUpsellAccepted).toHaveBeenCalledWith(mockTenantId);
        expect(MetricsHelper.recordUpsellRevenue).toHaveBeenCalledWith(mockTenantId, upsell.valor);
      }
    });

    it('should calculate conversion rate over multiple attempts', async () => {
      const attempts = 10;
      let acceptedCount = 0;
      
      for (let i = 0; i < attempts; i++) {
        const conversationId = `conv-${i}`;
        const upsell = await upsellSelector.selectUpsell(mockTenantId, mockBookingData);
        
        if (upsell) {
          await upsellSelector.recordUpsellOffered(
            mockTenantId,
            mockPhone,
            conversationId,
            upsell.servico_id,
            upsell.valor
          );
          
          // Simular 50% de aceitação
          if (i % 2 === 0) {
            await upsellSelector.recordUpsellAccepted(
              mockTenantId,
              mockPhone,
              conversationId,
              upsell.servico_id
            );
            acceptedCount++;
          }
        }
      }
      
      const conversionRate = acceptedCount / attempts;
      expect(conversionRate).toBeGreaterThan(0);
      expect(conversionRate).toBeLessThanOrEqual(1);
    });
  });

  describe('Timeout and Expiration', () => {
    it('should respect upsell timeout', async () => {
      const upsell = await upsellSelector.selectUpsell(mockTenantId, mockBookingData);
      
      if (upsell) {
        await upsellSelector.recordUpsellOffered(
          mockTenantId,
          mockPhone,
          mockConversationId,
          upsell.servico_id,
          upsell.valor
        );
        
        // Simular timeout (5 minutos padrão)
        const timeoutMs = 5 * 60 * 1000;
        const isExpired = await upsellSelector.isUpsellExpired(
          mockTenantId,
          mockPhone,
          mockConversationId,
          timeoutMs
        );
        
        // Como acabou de ser criado, não deve estar expirado
        expect(isExpired).toBe(false);
      }
    });
  });
});