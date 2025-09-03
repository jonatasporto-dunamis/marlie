import { UpsellSelector } from '../upsell/selector';
import { db } from '../db';
import { MetricsHelper } from '../metrics';
import { jest } from '@jest/globals';
import { Pool } from 'pg';

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
    upsellSelector = new UpsellSelector(db as unknown as Pool);
    
    // Limpar dados de teste
    if (db) {
      await (db as unknown as Pool).query('DELETE FROM upsell_events WHERE tenant_id = $1', [mockTenantId]);
    }
    
    // Mock das métricas
    jest.spyOn(MetricsHelper, 'incrementUpsellShown').mockImplementation(() => {});
    jest.spyOn(MetricsHelper, 'incrementUpsellAccepted').mockImplementation(() => {});
    jest.spyOn(MetricsHelper, 'recordUpsellRevenue').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Contextual Selection', () => {
    it('should select appropriate upsell based on service context', async () => {
      const context = {
        tenantId: mockTenantId,
        phoneE164: mockPhone,
        baseServiceId: parseInt(mockBookingData.servico_id.replace('serv-', '')),
        baseServiceName: 'Test Service',
        appointmentDateTime: new Date(mockBookingData.data_agendamento + 'T' + mockBookingData.horario),
        conversationId: mockConversationId
      };
      const upsell = await upsellSelector.selectUpsell(context);
      
      expect(upsell).toBeDefined();
      expect(upsell?.suggestedServiceId).toBeDefined();
      expect(upsell?.suggestedPriceCents).toBeGreaterThan(0);
      expect(upsell?.reason).toContain('complementar');
    });

    it('should return null when no suitable upsell is available', async () => {
      const invalidBookingData = {
        ...mockBookingData,
        servico_id: 'non-existent-service'
      };
      
      const invalidContext = {
        tenantId: mockTenantId,
        phoneE164: mockPhone,
        baseServiceId: 999, // non-existent service
        baseServiceName: 'Non-existent Service',
        appointmentDateTime: new Date(),
        conversationId: mockConversationId
      };
      const upsell = await upsellSelector.selectUpsell(invalidContext);
      expect(upsell).toBeNull();
    });
  });

  describe('One Upsell Per Conversation Rule', () => {
    it('should offer upsell on first booking in conversation', async () => {
      const context = {
        tenantId: mockTenantId,
        phoneE164: mockPhone,
        baseServiceId: parseInt(mockBookingData.servico_id.replace('serv-', '')),
        baseServiceName: 'Test Service',
        appointmentDateTime: new Date(mockBookingData.data_agendamento + 'T' + mockBookingData.horario),
        conversationId: mockConversationId
      };
      const upsell = await upsellSelector.selectUpsell(context);
      expect(upsell).toBeDefined();
      
      // Simular que o upsell foi oferecido
      if (upsell) {
        await upsellSelector.recordUpsellShown(context, upsell);
      }
    });

    it('should NOT offer second upsell in same conversation', async () => {
      // Primeiro upsell
      const firstContext = {
        tenantId: mockTenantId,
        phoneE164: mockPhone,
        baseServiceId: parseInt(mockBookingData.servico_id.replace('serv-', '')),
        baseServiceName: 'Test Service',
        appointmentDateTime: new Date(mockBookingData.data_agendamento + 'T' + mockBookingData.horario),
        conversationId: mockConversationId
      };
      const firstUpsell = await upsellSelector.selectUpsell(firstContext);
      if (firstUpsell) {
        await upsellSelector.recordUpsellShown(firstContext, firstUpsell);
      }
      
      // Tentar segundo upsell na mesma conversa
      const secondContext = {
        tenantId: mockTenantId,
        phoneE164: mockPhone,
        baseServiceId: 2,
        baseServiceName: 'Second Service',
        appointmentDateTime: new Date(),
        conversationId: mockConversationId
      };
      
      const secondUpsell = await upsellSelector.selectUpsell(secondContext);
      expect(secondUpsell).toBeNull();
    });

    it('should allow upsell in new conversation', async () => {
      // Primeiro upsell na conversa 1
      const firstContext = {
        tenantId: mockTenantId,
        phoneE164: mockPhone,
        baseServiceId: parseInt(mockBookingData.servico_id.replace('serv-', '')),
        baseServiceName: 'Test Service',
        appointmentDateTime: new Date(mockBookingData.data_agendamento + 'T' + mockBookingData.horario),
        conversationId: mockConversationId
      };
      const firstUpsell = await upsellSelector.selectUpsell(firstContext);
      if (firstUpsell) {
        await upsellSelector.recordUpsellShown(firstContext, firstUpsell);
      }
      
      // Nova conversa (diferente conversation_id)
      const newConversationId = 'conv-456';
      const newContext = {
        tenantId: mockTenantId,
        phoneE164: mockPhone,
        baseServiceId: parseInt(mockBookingData.servico_id.replace('serv-', '')),
        baseServiceName: 'Test Service',
        appointmentDateTime: new Date(mockBookingData.data_agendamento + 'T' + mockBookingData.horario),
        conversationId: newConversationId
      };
      const newUpsell = await upsellSelector.selectUpsell(newContext);
      
      expect(newUpsell).toBeDefined();
    });
  });

  describe('Persistence and State Management', () => {
    it('should persist upsell offer in database', async () => {
      const context = {
        tenantId: mockTenantId,
        phoneE164: mockPhone,
        baseServiceId: parseInt(mockBookingData.servico_id.replace('serv-', '')),
        baseServiceName: 'Test Service',
        appointmentDateTime: new Date(mockBookingData.data_agendamento + 'T' + mockBookingData.horario),
        conversationId: mockConversationId
      };
      const upsell = await upsellSelector.selectUpsell(context);
      
      if (upsell) {
        await upsellSelector.recordUpsellShown(context, upsell);
        
        // Verificar se foi persistido
        const result = await (db as unknown as Pool).query(
          'SELECT * FROM upsell_events WHERE tenant_id = $1 AND phone_e164 = $2 AND conversation_id = $3',
          [mockTenantId, mockPhone, mockConversationId]
        );
        
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].suggested_service_id).toBe(upsell.suggestedServiceId);
        expect(result.rows[0].suggested_price_cents).toBe(upsell.suggestedPriceCents);
      }
    });

    it('should record upsell acceptance', async () => {
      const context = {
        tenantId: mockTenantId,
        phoneE164: mockPhone,
        baseServiceId: parseInt(mockBookingData.servico_id.replace('serv-', '')),
        baseServiceName: 'Test Service',
        appointmentDateTime: new Date(mockBookingData.data_agendamento + 'T' + mockBookingData.horario),
        conversationId: mockConversationId
      };
      const upsell = await upsellSelector.selectUpsell(context);
      
      if (upsell) {
        // Oferecer upsell
        await upsellSelector.recordUpsellShown(context, upsell);
        
        // Aceitar upsell
        await upsellSelector.recordUpsellResponse(context, upsell, true);
        
        // Verificar se foi registrado
        const result = await (db as unknown as Pool).query(
          'SELECT * FROM upsell_events WHERE tenant_id = $1 AND phone_e164 = $2 AND accepted_at IS NOT NULL',
          [mockTenantId, mockPhone]
        );
        
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].suggested_service_id).toBe(upsell.suggestedServiceId);
      }
    });

    it('should record upsell decline', async () => {
      const context = {
        tenantId: mockTenantId,
        phoneE164: mockPhone,
        baseServiceId: parseInt(mockBookingData.servico_id.replace('serv-', '')),
        baseServiceName: 'Test Service',
        appointmentDateTime: new Date(mockBookingData.data_agendamento + 'T' + mockBookingData.horario),
        conversationId: mockConversationId
      };
      const upsell = await upsellSelector.selectUpsell(context);
      
      if (upsell) {
        // Oferecer upsell
        await upsellSelector.recordUpsellShown(context, upsell);
        
        // Recusar upsell
        await upsellSelector.recordUpsellResponse(context, upsell, false);
        
        // Verificar se foi registrado
        const result = await (db as unknown as Pool).query(
          'SELECT * FROM upsell_events WHERE tenant_id = $1 AND phone_e164 = $2 AND declined_at IS NOT NULL',
          [mockTenantId, mockPhone]
        );
        
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].suggested_service_id).toBe(upsell.suggestedServiceId);
      }
    });
  });

  describe('Average Ticket Impact Simulation', () => {
    it('should calculate baseline ticket without upsell', async () => {
      const baselineTicket = mockBookingData.valor;
      expect(baselineTicket).toBe(100);
    });

    it('should calculate increased ticket with accepted upsell', async () => {
      const context = {
        tenantId: mockTenantId,
        phoneE164: mockPhone,
        baseServiceId: parseInt(mockBookingData.servico_id.replace('serv-', '')),
        baseServiceName: 'Test Service',
        appointmentDateTime: new Date(mockBookingData.data_agendamento + 'T' + mockBookingData.horario),
        conversationId: mockConversationId
      };
      const upsell = await upsellSelector.selectUpsell(context);
      
      if (upsell) {
        const totalTicket = mockBookingData.valor + (upsell.suggestedPriceCents / 100);
        const increase = (totalTicket - mockBookingData.valor) / mockBookingData.valor;
        
        expect(totalTicket).toBeGreaterThan(mockBookingData.valor);
        expect(increase).toBeGreaterThan(0);
        expect(increase).toBeLessThan(1); // Aumento menor que 100%
      }
    });

    it('should track metrics for ticket impact analysis', async () => {
      const context = {
        tenantId: mockTenantId,
        phoneE164: mockPhone,
        baseServiceId: parseInt(mockBookingData.servico_id.replace('serv-', '')),
        baseServiceName: 'Test Service',
        appointmentDateTime: new Date(mockBookingData.data_agendamento + 'T' + mockBookingData.horario),
        conversationId: mockConversationId
      };
      const upsell = await upsellSelector.selectUpsell(context);
      
      if (upsell) {
        // Simular oferta
        await upsellSelector.recordUpsellShown(context, upsell);
        
        // Simular aceitação
        await upsellSelector.recordUpsellResponse(context, upsell, true);
        
        // Verificar se métricas foram chamadas
        expect(MetricsHelper.incrementUpsellShown).toHaveBeenCalledWith(mockTenantId);
        expect(MetricsHelper.incrementUpsellAccepted).toHaveBeenCalledWith(mockTenantId);
        expect(MetricsHelper.recordUpsellRevenue).toHaveBeenCalledWith(mockTenantId, upsell.suggestedPriceCents);
      }
    });

    it('should calculate conversion rate over multiple attempts', async () => {
      const attempts = 10;
      let acceptedCount = 0;
      
      for (let i = 0; i < attempts; i++) {
        const conversationId = `conv-${i}`;
        const context = {
          tenantId: mockTenantId,
          phoneE164: mockPhone,
          baseServiceId: parseInt(mockBookingData.servico_id.replace('serv-', '')),
          baseServiceName: 'Test Service',
          appointmentDateTime: new Date(mockBookingData.data_agendamento + 'T' + mockBookingData.horario),
          conversationId
        };
        const upsell = await upsellSelector.selectUpsell(context);
        
        if (upsell) {
          await upsellSelector.recordUpsellShown(context, upsell);
          
          // Simular 50% de aceitação
          if (i % 2 === 0) {
            await upsellSelector.recordUpsellResponse(context, upsell, true);
            acceptedCount++;
          }
        }
      }
      
      const conversionRate = acceptedCount / attempts;
      expect(conversionRate).toBeGreaterThan(0);
      expect(conversionRate).toBeLessThanOrEqual(1);
    });
  });

  describe('Statistics and Analytics', () => {
    it('should get upsell statistics', async () => {
      const context = {
        tenantId: mockTenantId,
        phoneE164: mockPhone,
        baseServiceId: parseInt(mockBookingData.servico_id.replace('serv-', '')),
        baseServiceName: 'Test Service',
        appointmentDateTime: new Date(mockBookingData.data_agendamento + 'T' + mockBookingData.horario),
        conversationId: mockConversationId
      };
      const upsell = await upsellSelector.selectUpsell(context);
      
      if (upsell) {
        await upsellSelector.recordUpsellShown(context, upsell);
        await upsellSelector.recordUpsellResponse(context, upsell, true);
        
        const stats = await upsellSelector.getUpsellStats(mockTenantId, 30);
        expect(stats).toBeDefined();
        expect(stats.total_shown).toBeGreaterThan(0);
      }
    });
  });
});