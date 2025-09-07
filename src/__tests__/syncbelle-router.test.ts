import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import { createSyncbelleRouter } from '../../agents/syncbelle-router';
import { MessageBuffer } from '../../services/message-buffer';
import { HumanHandoffService } from '../../services/human-handoff';
import { ValidationService } from '../../services/validation-service';
import { ResponseTemplateService } from '../../services/response-templates';
import { CatalogService } from '../../services/catalog-service';
import { TrinksService } from '../../services/trinks-service';
import Redis from 'ioredis';
import { Pool } from 'pg';

// Mock services para testes
class MockRedis {
  private data = new Map<string, any>();
  private ttls = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    const ttl = this.ttls.get(key);
    if (ttl && Date.now() > ttl) {
      this.data.delete(key);
      this.ttls.delete(key);
      return null;
    }
    return this.data.get(key) || null;
  }

  async set(key: string, value: string, mode?: string, duration?: number): Promise<string> {
    this.data.set(key, value);
    if (mode === 'EX' && duration) {
      this.ttls.set(key, Date.now() + duration * 1000);
    }
    return 'OK';
  }

  async del(key: string): Promise<number> {
    const existed = this.data.has(key);
    this.data.delete(key);
    this.ttls.delete(key);
    return existed ? 1 : 0;
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(pattern.replace('*', '.*'));
    return Array.from(this.data.keys()).filter(key => regex.test(key));
  }

  async exists(key: string): Promise<number> {
    return this.data.has(key) ? 1 : 0;
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (this.data.has(key)) {
      this.ttls.set(key, Date.now() + seconds * 1000);
      return 1;
    }
    return 0;
  }
}

class MockDatabase {
  private tables = new Map<string, any[]>();

  constructor() {
    // Inicializa tabelas mock
    this.tables.set('human_handoffs', []);
    this.tables.set('catalog_services', [
      {
        id: '1',
        tenant_id: 'test',
        nome: 'Corte Feminino',
        categoria: 'cabelo',
        duracao: 60,
        preco: 'R$ 80,00',
        ativo: true
      },
      {
        id: '2',
        tenant_id: 'test',
        nome: 'Manicure',
        categoria: 'unhas',
        duracao: 45,
        preco: 'R$ 35,00',
        ativo: true
      },
      {
        id: '3',
        tenant_id: 'test',
        nome: 'Pedicure',
        categoria: 'unhas',
        duracao: 60,
        preco: 'R$ 40,00',
        ativo: true
      }
    ]);
  }

  async query(text: string, params?: any[]): Promise<{ rows: any[] }> {
    // Mock simples para queries específicas
    if (text.includes('SELECT * FROM catalog_services')) {
      const services = this.tables.get('catalog_services') || [];
      return { rows: services.filter(s => s.tenant_id === 'test') };
    }
    
    if (text.includes('SELECT * FROM human_handoffs')) {
      return { rows: this.tables.get('human_handoffs') || [] };
    }
    
    if (text.includes('INSERT INTO human_handoffs')) {
      const handoffs = this.tables.get('human_handoffs') || [];
      const newHandoff = {
        id: handoffs.length + 1,
        tenant_id: params?.[0] || 'test',
        phone: params?.[1] || '+5511999999999',
        enabled: params?.[2] || true,
        created_at: new Date(),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000)
      };
      handoffs.push(newHandoff);
      return { rows: [newHandoff] };
    }
    
    return { rows: [] };
  }
}

class MockTrinksService {
  async validateAvailability(serviceId: string, professionalId?: string, startIso?: string): Promise<{
    available: boolean;
    confidence: 'explicit' | 'categorical' | 'ambiguous' | 'invalid';
    reason?: string;
  }> {
    // Mock de validação
    if (serviceId === '1') {
      return { available: true, confidence: 'explicit' };
    }
    if (serviceId === 'categoria') {
      return { available: false, confidence: 'categorical', reason: 'Categoria muito genérica' };
    }
    return { available: false, confidence: 'ambiguous', reason: 'Serviço não encontrado' };
  }
}

describe('Syncbelle Router Integration Tests', () => {
  let syncbelleAgent: any;
  let mockRedis: MockRedis;
  let mockDb: MockDatabase;
  let messageBuffer: any;
  let handoffService: any;
  let validationService: any;
  let templateService: any;
  let catalogService: any;
  let trinksService: MockTrinksService;

  beforeAll(async () => {
    // Inicializa mocks
    mockRedis = new MockRedis();
    mockDb = new MockDatabase();
    trinksService = new MockTrinksService();

    // Inicializa serviços
    messageBuffer = new MessageBuffer(mockRedis as any);
    handoffService = new HumanHandoffService(mockRedis as any, mockDb as any);
    catalogService = new CatalogService(mockDb as any);
    validationService = new ValidationService(catalogService, trinksService as any);
    templateService = new ResponseTemplateService();

    // Cria agente
    syncbelleAgent = createSyncbelleRouter(
      mockRedis as any,
      mockDb as any,
      messageBuffer,
      handoffService,
      validationService,
      templateService,
      catalogService,
      trinksService as any
    );
  });

  beforeEach(async () => {
    // Limpa dados entre testes
    await mockRedis.del('*');
  });

  describe('Menu Determinístico - Primeiro Turno', () => {
    it('deve mostrar menu de boas-vindas para nova conversa', async () => {
      const response = await syncbelleAgent.processMessage(
        '+5511999999999',
        'Oi',
        'test',
        { first_name: 'João' }
      );

      expect(response.action).toBe('show_menu');
      expect(response.message).toContain('Olá, João!');
      expect(response.message).toContain('1) Agendar atendimento');
      expect(response.message).toContain('2) Informações');
      expect(response.message).toContain('Responda com **1** ou **2**');
    });

    it('deve processar opção 1 (Agendar)', async () => {
      // Primeiro turno - menu
      await marlieAgent.processMessage('+5511999999999', 'Oi', 'test', { first_name: 'João' });
      
      // Segundo turno - opção 1
      const response = await marlieAgent.processMessage('+5511999999999', '1', 'test');

      expect(response.action).toBe('start_scheduling');
      expect(response.message).toContain('agendamento');
    });

    it('deve processar opção 2 (Informações)', async () => {
      // Primeiro turno - menu
      await marlieAgent.processMessage('+5511999999999', 'Oi', 'test', { first_name: 'João' });
      
      // Segundo turno - opção 2
      const response = await marlieAgent.processMessage('+5511999999999', '2', 'test');

      expect(response.action).toBe('provide_info');
      expect(response.message).toContain('informações');
    });

    it('deve pedir confirmação para opção inválida', async () => {
      // Primeiro turno - menu
      await marlieAgent.processMessage('+5511999999999', 'Oi', 'test', { first_name: 'João' });
      
      // Segundo turno - opção inválida
      const response = await marlieAgent.processMessage('+5511999999999', 'xyz', 'test');

      expect(response.action).toBe('invalid_option');
      expect(response.message).toContain('Não entendi');
      expect(response.message).toContain('**1** para Agendar ou **2** para Informações');
    });
  });

  describe('Buffer Temporal de Mensagens', () => {
    it('deve agrupar mensagens quebradas em 30s', async () => {
      const phone = '+5511999999999';
      
      // Primeira parte da mensagem
      await marlieAgent.processMessage(phone, 'Quero agendar', 'test');
      
      // Segunda parte (dentro de 30s)
      const response = await marlieAgent.processMessage(phone, 'um corte de cabelo', 'test');
      
      // Deve processar como mensagem única
      expect(response.metadata?.originalMessage).toContain('Quero agendar um corte de cabelo');
    });

    it('deve processar mensagens separadas após 30s', async () => {
      const phone = '+5511999999999';
      
      // Primeira mensagem
      const response1 = await marlieAgent.processMessage(phone, 'Oi', 'test');
      expect(response1.action).toBe('show_menu');
      
      // Simula passagem de tempo (mock)
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Segunda mensagem (deve ser tratada separadamente)
      const response2 = await marlieAgent.processMessage(phone, '1', 'test');
      expect(response2.action).toBe('start_scheduling');
    });
  });

  describe('Validação de Serviços', () => {
    it('deve validar serviço específico com sucesso', async () => {
      const phone = '+5511999999999';
      
      // Menu inicial
      await marlieAgent.processMessage(phone, 'Oi', 'test');
      
      // Escolhe agendar
      await marlieAgent.processMessage(phone, '1', 'test');
      
      // Especifica serviço válido
      const response = await marlieAgent.processMessage(phone, 'Corte Feminino', 'test');
      
      expect(response.action).toBe('service_validated');
      expect(response.metadata?.serviceId).toBe('1');
    });

    it('deve rejeitar categoria genérica', async () => {
      const phone = '+5511999999999';
      
      // Menu inicial
      await marlieAgent.processMessage(phone, 'Oi', 'test');
      
      // Escolhe agendar
      await marlieAgent.processMessage(phone, '1', 'test');
      
      // Especifica categoria genérica
      const response = await marlieAgent.processMessage(phone, 'cabelo', 'test');
      
      expect(response.action).toBe('clarify_service');
      expect(response.message).toContain('Antes de confirmar');
      expect(response.message).toContain('Corte Feminino');
    });

    it('deve pedir clarificação para serviço ambíguo', async () => {
      const phone = '+5511999999999';
      
      // Menu inicial
      await marlieAgent.processMessage(phone, 'Oi', 'test');
      
      // Escolhe agendar
      await marlieAgent.processMessage(phone, '1', 'test');
      
      // Especifica serviço ambíguo
      const response = await marlieAgent.processMessage(phone, 'unhas', 'test');
      
      expect(response.action).toBe('clarify_service');
      expect(response.message).toContain('Manicure');
      expect(response.message).toContain('Pedicure');
    });
  });

  describe('Handoff Humano', () => {
    it('deve ativar handoff humano quando solicitado', async () => {
      const phone = '+5511999999999';
      
      // Ativa handoff
      await handoffService.setHandoff(phone, true, 'test');
      
      // Qualquer mensagem deve retornar handoff ativo
      const response = await marlieAgent.processMessage(phone, 'Oi', 'test');
      
      expect(response.action).toBe('human_handoff');
      expect(response.message).toContain('Atendimento humano ativo');
    });

    it('deve permitir desativar handoff humano', async () => {
      const phone = '+5511999999999';
      
      // Ativa e depois desativa handoff
      await handoffService.setHandoff(phone, true, 'test');
      await handoffService.setHandoff(phone, false, 'test');
      
      // Deve voltar ao fluxo normal
      const response = await marlieAgent.processMessage(phone, 'Oi', 'test', { first_name: 'João' });
      
      expect(response.action).toBe('show_menu');
      expect(response.message).toContain('Olá, João!');
    });

    it('deve detectar palavras-chave de stop', async () => {
      const phone = '+5511999999999';
      
      const response = await marlieAgent.processMessage(phone, 'cancelar atendimento', 'test');
      
      expect(response.action).toBe('conversation_ended');
      expect(response.message).toContain('atendimento encerrado');
    });
  });

  describe('Padrões NLP', () => {
    it('deve detectar intenção explícita de agendamento', async () => {
      const phone = '+5511999999999';
      
      const response = await marlieAgent.processMessage(phone, 'quero agendar atendimento', 'test');
      
      expect(response.action).toBe('start_scheduling');
    });

    it('deve pedir confirmação para intenção ambígua', async () => {
      const phone = '+5511999999999';
      
      const response = await marlieAgent.processMessage(phone, 'agenda', 'test');
      
      expect(response.action).toBe('confirm_intent');
      expect(response.message).toContain('Só para confirmar');
    });

    it('deve reconhecer variações da opção 1', async () => {
      const phone = '+5511999999999';
      
      // Menu inicial
      await marlieAgent.processMessage(phone, 'Oi', 'test');
      
      // Testa diferentes variações
      const variations = ['1', 'um', 'opção 1', 'número 1', 'quero agendar'];
      
      for (const variation of variations) {
        // Reset da sessão
        await marlieAgent.processMessage(phone, 'Oi', 'test');
        
        const response = await marlieAgent.processMessage(phone, variation, 'test');
        expect(response.action).toBe('start_scheduling');
      }
    });
  });

  describe('Templates de Resposta', () => {
    it('deve personalizar templates com variáveis do usuário', async () => {
      const response = await marlieAgent.processMessage(
        '+5511999999999',
        'Oi',
        'test',
        { first_name: 'Maria' }
      );

      expect(response.message).toContain('Olá, Maria!');
    });

    it('deve usar template de clarificação com serviços', async () => {
      const phone = '+5511999999999';
      
      // Menu e agendamento
      await marlieAgent.processMessage(phone, 'Oi', 'test');
      await marlieAgent.processMessage(phone, '1', 'test');
      
      // Categoria ambígua
      const response = await marlieAgent.processMessage(phone, 'unhas', 'test');
      
      expect(response.message).toContain('1) Manicure — 45min — R$ 35,00');
      expect(response.message).toContain('2) Pedicure — 60min — R$ 40,00');
    });
  });

  describe('Fluxos Completos', () => {
    it('deve completar fluxo de agendamento com sucesso', async () => {
      const phone = '+5511999999999';
      
      // 1. Menu inicial
      const step1 = await marlieAgent.processMessage(phone, 'Oi', 'test', { first_name: 'Ana' });
      expect(step1.action).toBe('show_menu');
      
      // 2. Escolhe agendar
      const step2 = await marlieAgent.processMessage(phone, '1', 'test');
      expect(step2.action).toBe('start_scheduling');
      
      // 3. Especifica serviço
      const step3 = await marlieAgent.processMessage(phone, 'Corte Feminino', 'test');
      expect(step3.action).toBe('service_validated');
      
      // 4. Confirma agendamento
      const step4 = await marlieAgent.processMessage(phone, 'sim', 'test');
      expect(step4.action).toBe('schedule_confirmed');
    });

    it('deve completar fluxo de informações', async () => {
      const phone = '+5511999999999';
      
      // 1. Menu inicial
      const step1 = await marlieAgent.processMessage(phone, 'Oi', 'test', { first_name: 'Carlos' });
      expect(step1.action).toBe('show_menu');
      
      // 2. Escolhe informações
      const step2 = await marlieAgent.processMessage(phone, '2', 'test');
      expect(step2.action).toBe('provide_info');
      
      // 3. Pergunta específica
      const step3 = await marlieAgent.processMessage(phone, 'horário de funcionamento', 'test');
      expect(step3.action).toBe('info_provided');
    });

    it('deve lidar com mudança de contexto', async () => {
      const phone = '+5511999999999';
      
      // Inicia agendamento
      await marlieAgent.processMessage(phone, 'Oi', 'test');
      await marlieAgent.processMessage(phone, '1', 'test');
      
      // Muda para informações
      const response = await marlieAgent.processMessage(phone, '2', 'test');
      expect(response.action).toBe('provide_info');
    });
  });

  describe('Limpeza e Manutenção', () => {
    it('deve limpar sessões expiradas', async () => {
      const phone = '+5511999999999';
      
      // Cria sessão
      await marlieAgent.processMessage(phone, 'Oi', 'test');
      
      // Verifica que sessão existe
      const sessionsBefore = await marlieAgent.getSessionStats();
      expect(sessionsBefore.activeSessions).toBeGreaterThan(0);
      
      // Limpa sessões expiradas
      const cleaned = await marlieAgent.cleanupExpiredSessions();
      expect(typeof cleaned).toBe('number');
    });

    it('deve obter estatísticas do agente', async () => {
      const stats = await marlieAgent.getSessionStats();
      
      expect(stats).toHaveProperty('activeSessions');
      expect(stats).toHaveProperty('totalMessages');
      expect(typeof stats.activeSessions).toBe('number');
    });
  });
});