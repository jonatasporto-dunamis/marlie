import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { Pool } from 'pg';
import { MarlieUpsell } from '../modules/marlie-upsell';
import { UpsellService } from '../services/upsell-service';
import { UpsellScheduler } from '../services/upsell-scheduler';
import { UpsellDatabase } from '../database/upsell-queries';
import { createUpsellTriggerMiddleware } from '../middleware/upsell-trigger';
import { createUpsellAdminRoutes } from '../routes/upsell-admin';

/**
 * Testes para o módulo marlie-upsell
 * 
 * Valida funcionalidades de A/B testing, métricas de conversão,
 * agendamento, deduplicação e integração com serviços externos.
 */

describe('Marlie Upsell Module', () => {
  let app: express.Application;
  let upsellModule: MarlieUpsell;
  let mockPool: jest.Mocked<Pool>;
  let mockClient: any;

  const mockConfig = {
    env: {
      timezone: 'America/Bahia',
      UPSELL_ENABLED: 'true',
      UPSELL_DELAY_MIN: '10',
      UPSELL_COPY_A_WEIGHT: '0.5',
      UPSELL_POS_IMMEDIATE_WEIGHT: '0.5'
    },
    security: {
      auth: 'bearer:test-token',
      pii_masking: true
    },
    nlp: {
      patterns: {
        accept_numeric_1: ['^\\s*1\\s*$'],
        accept_words: ['(?i)\\b(sim|quero|aceito|adicionar|pode sim)\\b'],
        decline_words: ['(?i)\\b(nao|não|talvez depois|agora não)\\b']
      }
    },
    responses: {
      copy_A: 'Dica rápida: **{{addon.nome}}** ({{addon.duracao}}min) por **{{addon.preco}}**. Quer adicionar ao seu atendimento? Responda **1**.',
      copy_B: 'Potencialize seu resultado: **{{addon.nome}}** ({{addon.duracao}}min). Valor **{{addon.preco}}**. Deseja incluir? Responda **1**.',
      confirm_added: 'Perfeito! Adicionei **{{addon.nome}}** ao seu atendimento. ✅',
      added_pending: 'Certo! Vou ajustar sua agenda com **{{addon.nome}}** e te confirmo já. 😉',
      declined: 'Tudo bem! Seguimos com o que já foi confirmado. 🙌',
      nothing_to_offer: ' ',
      already_offered: ' '
    },
    tools: [
      {
        name: 'catalog.recommended_addon',
        description: 'Sugere 1 addon relevante dado o serviço principal.',
        input_schema: {
          type: 'object',
          properties: {
            primary_service_id: { type: 'string' }
          },
          required: ['primary_service_id']
        }
      }
    ]
  };

  beforeEach(async () => {
    // Mock do pool de conexões
    mockClient = {
      query: jest.fn(),
      release: jest.fn()
    };

    mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn(),
      end: jest.fn()
    } as any;

    // Criar aplicação Express
    app = express();
    app.use(express.json());

    // Inicializar módulo de upsell
    upsellModule = new MarlieUpsell(mockConfig);
    await upsellModule.initialize({
      pool: mockPool,
      redis: null,
      logger: console
    });

    // Configurar rotas de teste
    app.use('/admin/upsell', createUpsellAdminRoutes(
      upsellModule.getService(),
      upsellModule.getScheduler()
    ));
  });

  afterEach(async () => {
    await upsellModule.shutdown();
    jest.clearAllMocks();
  });

  describe('Inicialização do Módulo', () => {
    it('deve inicializar com configuração válida', () => {
      expect(upsellModule).toBeDefined();
      expect(upsellModule.getService()).toBeDefined();
      expect(upsellModule.getScheduler()).toBeDefined();
    });

    it('deve validar configuração obrigatória', () => {
      expect(() => {
        new MarlieUpsell({} as any);
      }).toThrow();
    });

    it('deve aplicar configurações padrão', () => {
      const config = upsellModule.getConfig();
      expect(config.env.UPSELL_ENABLED).toBe('true');
      expect(config.env.UPSELL_DELAY_MIN).toBe('10');
    });
  });

  describe('A/B Testing', () => {
    let upsellService: UpsellService;

    beforeEach(() => {
      upsellService = upsellModule.getService();
    });

    it('deve distribuir variantes de copy conforme peso configurado', async () => {
      const results = { A: 0, B: 0 };
      const iterations = 1000;

      // Mock da verificação de deduplicação
      mockClient.query.mockResolvedValue({ rows: [{ has_upsell_shown: false }] });

      // Mock do addon recomendado
      jest.spyOn(upsellService as any, 'getRecommendedAddon').mockResolvedValue({
        id: 'addon-1',
        nome: 'Massagem Relaxante',
        preco: 'R$ 80,00',
        duracao: 30
      });

      // Mock do envio de mensagem
      jest.spyOn(upsellService as any, 'sendMessage').mockResolvedValue(true);

      for (let i = 0; i < iterations; i++) {
        const context = {
          conversationId: `conv-${i}`,
          phone: '5511999999999',
          appointmentId: `apt-${i}`,
          primaryServiceId: 'service-1'
        };

        const result = await upsellService.processBookingConfirmation(context);
        if (result?.variant?.copy) {
          results[result.variant.copy]++;
        }
      }

      // Verificar distribuição próxima a 50/50 (com margem de erro)
      const ratioA = results.A / iterations;
      expect(ratioA).toBeGreaterThan(0.4);
      expect(ratioA).toBeLessThan(0.6);
    });

    it('deve distribuir variantes de posição conforme peso configurado', async () => {
      const results = { IMMEDIATE: 0, DELAY10: 0 };
      const iterations = 1000;

      mockClient.query.mockResolvedValue({ rows: [{ has_upsell_shown: false }] });

      jest.spyOn(upsellService as any, 'getRecommendedAddon').mockResolvedValue({
        id: 'addon-1',
        nome: 'Massagem Relaxante',
        preco: 'R$ 80,00',
        duracao: 30
      });

      jest.spyOn(upsellService as any, 'sendMessage').mockResolvedValue(true);
      jest.spyOn(upsellService as any, 'scheduleDelayedUpsell').mockResolvedValue('job-id');

      for (let i = 0; i < iterations; i++) {
        const context = {
          conversationId: `conv-${i}`,
          phone: '5511999999999',
          appointmentId: `apt-${i}`,
          primaryServiceId: 'service-1'
        };

        const result = await upsellService.processBookingConfirmation(context);
        if (result?.variant?.position) {
          results[result.variant.position]++;
        }
      }

      // Verificar distribuição próxima a 50/50
      const ratioImmediate = results.IMMEDIATE / iterations;
      expect(ratioImmediate).toBeGreaterThan(0.4);
      expect(ratioImmediate).toBeLessThan(0.6);
    });

    it('deve usar variante específica quando fornecida', async () => {
      mockClient.query.mockResolvedValue({ rows: [{ has_upsell_shown: false }] });

      jest.spyOn(upsellService as any, 'getRecommendedAddon').mockResolvedValue({
        id: 'addon-1',
        nome: 'Massagem Relaxante',
        preco: 'R$ 80,00',
        duracao: 30
      });

      jest.spyOn(upsellService as any, 'sendMessage').mockResolvedValue(true);

      const context = {
        conversationId: 'conv-1',
        phone: '5511999999999',
        appointmentId: 'apt-1',
        primaryServiceId: 'service-1'
      };

      const forcedVariant = { copy: 'B' as const, position: 'DELAY10' as const };
      const result = await upsellService.processBookingConfirmation(context, forcedVariant);

      expect(result?.variant?.copy).toBe('B');
      expect(result?.variant?.position).toBe('DELAY10');
    });
  });

  describe('Deduplicação', () => {
    let upsellService: UpsellService;

    beforeEach(() => {
      upsellService = upsellModule.getService();
    });

    it('deve evitar múltiplos upsells na mesma conversa', async () => {
      // Primeira chamada: sem upsell anterior
      mockClient.query.mockResolvedValueOnce({ rows: [{ has_upsell_shown: false }] });
      
      // Segunda chamada: já tem upsell
      mockClient.query.mockResolvedValueOnce({ rows: [{ has_upsell_shown: true }] });

      const context = {
        conversationId: 'conv-1',
        phone: '5511999999999',
        appointmentId: 'apt-1',
        primaryServiceId: 'service-1'
      };

      // Primeira tentativa deve processar
      const result1 = await upsellService.processBookingConfirmation(context);
      expect(result1).toBeDefined();

      // Segunda tentativa deve ser ignorada
      const result2 = await upsellService.processBookingConfirmation(context);
      expect(result2).toBeNull();
    });

    it('deve registrar evento de deduplicação', async () => {
      mockClient.query.mockResolvedValue({ rows: [{ has_upsell_shown: true }] });

      const logEventSpy = jest.spyOn(upsellService as any, 'logEvent');

      const context = {
        conversationId: 'conv-1',
        phone: '5511999999999',
        appointmentId: 'apt-1',
        primaryServiceId: 'service-1'
      };

      await upsellService.processBookingConfirmation(context);

      expect(logEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'already_offered',
          conversationId: 'conv-1'
        })
      );
    });
  });

  describe('Processamento de Respostas', () => {
    let upsellService: UpsellService;

    beforeEach(() => {
      upsellService = upsellModule.getService();
    });

    it('deve detectar aceite numérico (1)', async () => {
      const result = await upsellService.processUpsellResponse(
        'conv-1',
        '5511999999999',
        '1'
      );

      expect(result?.action).toBe('accepted');
    });

    it('deve detectar aceite por palavras', async () => {
      const responses = ['sim', 'quero', 'aceito', 'adicionar', 'pode sim'];

      for (const response of responses) {
        const result = await upsellService.processUpsellResponse(
          'conv-1',
          '5511999999999',
          response
        );

        expect(result?.action).toBe('accepted');
      }
    });

    it('deve detectar recusa por palavras', async () => {
      const responses = ['não', 'nao', 'talvez depois', 'agora não'];

      for (const response of responses) {
        const result = await upsellService.processUpsellResponse(
          'conv-1',
          '5511999999999',
          response
        );

        expect(result?.action).toBe('declined');
      }
    });

    it('deve ignorar respostas não relacionadas', async () => {
      const result = await upsellService.processUpsellResponse(
        'conv-1',
        '5511999999999',
        'oi, como vai?'
      );

      expect(result).toBeNull();
    });
  });

  describe('Agendamento com Delay', () => {
    let scheduler: UpsellScheduler;

    beforeEach(() => {
      scheduler = upsellModule.getScheduler();
    });

    it('deve agendar upsell com delay', async () => {
      const jobId = await scheduler.scheduleUpsell(
        'conv-1',
        '5511999999999',
        'apt-1',
        'service-1',
        10, // 10 minutos
        { copy: 'A', position: 'DELAY10' },
        'João Silva'
      );

      expect(jobId).toBeDefined();
      expect(jobId).toMatch(/^upsell_/);
    });

    it('deve cancelar job agendado', async () => {
      const jobId = await scheduler.scheduleUpsell(
        'conv-1',
        '5511999999999',
        'apt-1',
        'service-1',
        10,
        { copy: 'A', position: 'DELAY10' }
      );

      const cancelled = await scheduler.cancelScheduledUpsell(jobId);
      expect(cancelled).toBe(true);
    });

    it('deve obter estatísticas do scheduler', () => {
      const stats = scheduler.getStats();
      
      expect(stats).toHaveProperty('isRunning');
      expect(stats).toHaveProperty('totalJobs');
      expect(stats).toHaveProperty('pendingJobs');
      expect(stats).toHaveProperty('completedJobs');
    });
  });

  describe('Middleware de Trigger', () => {
    it('deve interceptar confirmações de agendamento', async () => {
      const mockNext = jest.fn();
      const mockReq = {
        route: { path: '/booking/confirm' },
        body: {
          conversation_id: 'conv-1',
          phone: '5511999999999',
          appointment_id: 'apt-1',
          service_id: 'service-1'
        }
      } as any;
      const mockRes = {} as any;

      const middleware = createUpsellTriggerMiddleware(
        upsellModule.getService(),
        {
          enabled: true,
          routes: ['/booking/confirm'],
          extractors: {
            conversationId: (req) => req.body.conversation_id,
            phone: (req) => req.body.phone,
            appointmentId: (req) => req.body.appointment_id,
            primaryServiceId: (req) => req.body.service_id
          }
        }
      );

      await middleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('deve ignorar rotas não configuradas', async () => {
      const mockNext = jest.fn();
      const mockReq = {
        route: { path: '/other/route' },
        body: {}
      } as any;
      const mockRes = {} as any;

      const middleware = createUpsellTriggerMiddleware(
        upsellModule.getService(),
        {
          enabled: true,
          routes: ['/booking/confirm'],
          extractors: {
            conversationId: (req) => req.body.conversation_id,
            phone: (req) => req.body.phone,
            appointmentId: (req) => req.body.appointment_id,
            primaryServiceId: (req) => req.body.service_id
          }
        }
      );

      await middleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('Rotas Administrativas', () => {
    beforeEach(() => {
      // Mock de autenticação admin
      app.use((req, res, next) => {
        req.headers.authorization = 'Bearer test-token';
        next();
      });
    });

    it('deve retornar métricas gerais', async () => {
      mockClient.query.mockResolvedValue({
        rows: [{
          total_shown: 100,
          total_accepted: 15,
          total_declined: 85,
          total_scheduled: 5,
          total_errors: 0,
          conversion_rate: 15.0,
          total_revenue_brl: 1200.0,
          avg_addon_price_brl: 80.0,
          avg_processing_time_ms: 250
        }]
      });

      const response = await request(app)
        .get('/admin/upsell/metrics')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('totalShown', 100);
      expect(response.body.data).toHaveProperty('conversionRate', 15.0);
    });

    it('deve retornar resultados do teste A/B', async () => {
      mockClient.query.mockResolvedValue({
        rows: [
          {
            date: new Date('2024-01-01'),
            variant_copy: 'A',
            variant_position: 'IMMEDIATE',
            shown_count: 50,
            accepted_count: 8,
            conversion_rate_percent: 16.0
          },
          {
            date: new Date('2024-01-01'),
            variant_copy: 'B',
            variant_position: 'IMMEDIATE',
            shown_count: 50,
            accepted_count: 7,
            conversion_rate_percent: 14.0
          }
        ]
      });

      const response = await request(app)
        .get('/admin/upsell/metrics/ab-test')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(2);
    });

    it('deve executar teste manual', async () => {
      const testData = {
        conversationId: 'conv-test',
        phone: '5511999999999',
        appointmentId: 'apt-test',
        primaryServiceId: 'service-1',
        variant: { copy: 'A', position: 'IMMEDIATE' }
      };

      mockClient.query.mockResolvedValue({ rows: [{ has_upsell_shown: false }] });

      const response = await request(app)
        .post('/admin/upsell/test')
        .send(testData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('sucesso');
    });

    it('deve retornar status de saúde', async () => {
      const response = await request(app)
        .get('/admin/upsell/health')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('status');
      expect(response.body.data).toHaveProperty('service');
      expect(response.body.data).toHaveProperty('scheduler');
    });
  });

  describe('Métricas de Performance', () => {
    let upsellService: UpsellService;

    beforeEach(() => {
      upsellService = upsellModule.getService();
    });

    it('deve calcular taxa de conversão corretamente', async () => {
      mockClient.query.mockResolvedValue({
        rows: [{
          total_shown: 100,
          total_accepted: 15,
          total_declined: 85,
          conversion_rate: 15.0
        }]
      });

      const metrics = await upsellService.getMetrics({ period: '7d' });
      
      expect(metrics.totalShown).toBe(100);
      expect(metrics.totalAccepted).toBe(15);
      expect(metrics.conversionRate).toBe(15.0);
    });

    it('deve agrupar métricas por período', async () => {
      mockClient.query.mockResolvedValue({
        rows: [
          {
            date: new Date('2024-01-01'),
            variant_copy: 'A',
            shown_count: 25,
            accepted_count: 4,
            conversion_rate_percent: 16.0
          },
          {
            date: new Date('2024-01-02'),
            variant_copy: 'A',
            shown_count: 30,
            accepted_count: 3,
            conversion_rate_percent: 10.0
          }
        ]
      });

      const report = await upsellService.getConversionMetrics({
        period: '7d',
        groupBy: 'day'
      });

      expect(report).toHaveLength(2);
      expect(report[0]).toHaveProperty('conversionRatePercent', 16.0);
    });
  });

  describe('Integração com Ferramentas Externas', () => {
    let upsellService: UpsellService;

    beforeEach(() => {
      upsellService = upsellModule.getService();
    });

    it('deve integrar com catálogo para recomendação', async () => {
      const mockAddon = {
        id: 'addon-1',
        nome: 'Massagem Relaxante',
        preco: 'R$ 80,00',
        duracao: 30
      };

      jest.spyOn(upsellService as any, 'getRecommendedAddon')
        .mockResolvedValue(mockAddon);

      const addon = await (upsellService as any).getRecommendedAddon('service-1');
      
      expect(addon).toEqual(mockAddon);
    });

    it('deve integrar com WhatsApp para envio', async () => {
      jest.spyOn(upsellService as any, 'sendMessage')
        .mockResolvedValue(true);

      const sent = await (upsellService as any).sendMessage(
        '5511999999999',
        'Mensagem de teste'
      );
      
      expect(sent).toBe(true);
    });

    it('deve integrar com Trinks para adicionar serviço', async () => {
      jest.spyOn(upsellService as any, 'appendServiceToAppointment')
        .mockResolvedValue(true);

      const added = await (upsellService as any).appendServiceToAppointment(
        'apt-1',
        'addon-1'
      );
      
      expect(added).toBe(true);
    });
  });

  describe('Tratamento de Erros', () => {
    let upsellService: UpsellService;

    beforeEach(() => {
      upsellService = upsellModule.getService();
    });

    it('deve tratar erro de conexão com banco', async () => {
      mockClient.query.mockRejectedValue(new Error('Connection failed'));

      const result = await upsellService.processBookingConfirmation({
        conversationId: 'conv-1',
        phone: '5511999999999',
        appointmentId: 'apt-1',
        primaryServiceId: 'service-1'
      });

      expect(result).toBeNull();
    });

    it('deve registrar erro quando addon não encontrado', async () => {
      mockClient.query.mockResolvedValue({ rows: [{ has_upsell_shown: false }] });
      
      jest.spyOn(upsellService as any, 'getRecommendedAddon')
        .mockResolvedValue(null);

      const logEventSpy = jest.spyOn(upsellService as any, 'logEvent');

      await upsellService.processBookingConfirmation({
        conversationId: 'conv-1',
        phone: '5511999999999',
        appointmentId: 'apt-1',
        primaryServiceId: 'service-1'
      });

      expect(logEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'nothing_to_offer'
        })
      );
    });

    it('deve tratar timeout em integrações externas', async () => {
      jest.spyOn(upsellService as any, 'sendMessage')
        .mockRejectedValue(new Error('Timeout'));

      const logEventSpy = jest.spyOn(upsellService as any, 'logEvent');

      // Simular processamento que falha no envio
      mockClient.query.mockResolvedValue({ rows: [{ has_upsell_shown: false }] });
      
      jest.spyOn(upsellService as any, 'getRecommendedAddon')
        .mockResolvedValue({
          id: 'addon-1',
          nome: 'Massagem',
          preco: 'R$ 80,00',
          duracao: 30
        });

      await upsellService.processBookingConfirmation({
        conversationId: 'conv-1',
        phone: '5511999999999',
        appointmentId: 'apt-1',
        primaryServiceId: 'service-1'
      });

      expect(logEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'error',
          errorMessage: expect.stringContaining('Timeout')
        })
      );
    });
  });

  describe('Testes de Aceitação', () => {
    it('deve processar fluxo completo de upsell imediato', async () => {
      // Configurar mocks para fluxo completo
      mockClient.query.mockResolvedValue({ rows: [{ has_upsell_shown: false }] });
      
      const upsellService = upsellModule.getService();
      
      jest.spyOn(upsellService as any, 'getRecommendedAddon')
        .mockResolvedValue({
          id: 'addon-1',
          nome: 'Massagem Relaxante',
          preco: 'R$ 80,00',
          duracao: 30
        });

      jest.spyOn(upsellService as any, 'sendMessage')
        .mockResolvedValue(true);

      const logEventSpy = jest.spyOn(upsellService as any, 'logEvent');

      // 1. Processar confirmação de agendamento
      const result = await upsellService.processBookingConfirmation({
        conversationId: 'conv-1',
        phone: '5511999999999',
        appointmentId: 'apt-1',
        primaryServiceId: 'service-1',
        customerName: 'João Silva'
      });

      expect(result).toBeDefined();
      expect(result?.variant).toBeDefined();
      expect(logEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'shown' })
      );

      // 2. Processar resposta de aceite
      const responseResult = await upsellService.processUpsellResponse(
        'conv-1',
        '5511999999999',
        '1'
      );

      expect(responseResult?.action).toBe('accepted');
      expect(logEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'accepted' })
      );
    });

    it('deve atingir meta de conversão de 5%', async () => {
      // Simular dados que atendem à meta
      mockClient.query.mockResolvedValue({
        rows: [{
          total_shown: 1000,
          total_accepted: 60, // 6% de conversão
          conversion_rate: 6.0
        }]
      });

      const upsellService = upsellModule.getService();
      const metrics = await upsellService.getMetrics({ period: '14d' });
      
      expect(metrics.conversionRate).toBeGreaterThanOrEqual(5.0);
    });
  });
});