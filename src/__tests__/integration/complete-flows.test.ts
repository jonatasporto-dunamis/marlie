import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { createMarlieRouter } from '../../agents/marlie-router';
import { getMessageBuffer } from '../../services/message-buffer';
import { getHumanHandoffService } from '../../services/human-handoff';
import { getValidationService } from '../../services/validation-service';
import { getResponseTemplateService } from '../../services/response-templates';
import { getCatalogService } from '../../services/catalog-service';
import { getTrinksService } from '../../services/trinks-service';
import { initializeStateMachine } from '../../init-state-machine';
import { initializeCatalog } from '../../init-catalog';
import Redis from 'ioredis';
import { Pool } from 'pg';

// Mock classes para testes isolados
class MockRedis {
  private data = new Map<string, any>();
  private ttls = new Map<string, number>();
  private lists = new Map<string, any[]>();

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

  async setex(key: string, seconds: number, value: string): Promise<string> {
    this.data.set(key, value);
    this.ttls.set(key, Date.now() + seconds * 1000);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    const existed = this.data.has(key);
    this.data.delete(key);
    this.ttls.delete(key);
    this.lists.delete(key);
    return existed ? 1 : 0;
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
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

  async lpush(key: string, ...values: string[]): Promise<number> {
    if (!this.lists.has(key)) {
      this.lists.set(key, []);
    }
    const list = this.lists.get(key)!;
    list.unshift(...values);
    return list.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) || [];
    if (stop === -1) stop = list.length - 1;
    return list.slice(start, stop + 1);
  }

  async ltrim(key: string, start: number, stop: number): Promise<string> {
    const list = this.lists.get(key) || [];
    if (stop === -1) stop = list.length - 1;
    this.lists.set(key, list.slice(start, stop + 1));
    return 'OK';
  }
}

class MockDatabase {
  public tables = new Map<string, any[]>();
  private sequences = new Map<string, number>();

  constructor() {
    // Inicializa tabelas mock
    this.tables.set('human_handoffs', []);
    this.tables.set('conversation_states', []);
    this.tables.set('servicos_prof', [
      {
        id: 1,
        tenant_id: 'test-tenant',
        servico_id: 'srv_001',
        profissional_id: 'prof_001',
        servico_nome: 'Corte Feminino',
        servico_nome_normalizado: 'corte feminino',
        categoria: 'cabelo',
        categoria_normalizada: 'cabelo',
        preco: 80.00,
        duracao: 60,
        ativo: true,
        visivel_cliente: true,
        created_at: new Date(),
        updated_at: new Date()
      },
      {
        id: 2,
        tenant_id: 'test-tenant',
        servico_id: 'srv_002',
        profissional_id: 'prof_001',
        servico_nome: 'Manicure Simples',
        servico_nome_normalizado: 'manicure simples',
        categoria: 'unhas',
        categoria_normalizada: 'unhas',
        preco: 35.00,
        duracao: 45,
        ativo: true,
        visivel_cliente: true,
        created_at: new Date(),
        updated_at: new Date()
      },
      {
        id: 3,
        tenant_id: 'test-tenant',
        servico_id: 'srv_003',
        profissional_id: 'prof_002',
        servico_nome: 'Escova Progressiva',
        servico_nome_normalizado: 'escova progressiva',
        categoria: 'cabelo',
        categoria_normalizada: 'cabelo',
        preco: 120.00,
        duracao: 180,
        ativo: true,
        visivel_cliente: true,
        created_at: new Date(),
        updated_at: new Date()
      }
    ]);
    this.tables.set('agendamentos', []);
    this.tables.set('catalog_sync_watermarks', []);
    this.tables.set('user_preferences', []);
    
    // Inicializa sequências
    this.sequences.set('servicos_prof_id_seq', 4);
    this.sequences.set('agendamentos_id_seq', 1);
  }

  async query(text: string, params: any[] = []): Promise<any> {
    // Simula consultas SQL básicas
    if (text.includes('SELECT') && text.includes('servicos_prof')) {
      const services = this.tables.get('servicos_prof') || [];
      
      if (text.includes('WHERE categoria_normalizada')) {
        const categoria = params[1] || params[0];
        return {
          rows: services.filter(s => s.categoria_normalizada === categoria)
        };
      }
      
      if (text.includes('WHERE servico_nome_normalizado ILIKE')) {
        const searchTerm = params[1] || params[0];
        const term = searchTerm.replace(/%/g, '');
        return {
          rows: services.filter(s => 
            s.servico_nome_normalizado.includes(term.toLowerCase())
          )
        };
      }
      
      return { rows: services };
    }
    
    if (text.includes('INSERT INTO agendamentos')) {
      const agendamentos = this.tables.get('agendamentos') || [];
      const newId = this.sequences.get('agendamentos_id_seq')!;
      this.sequences.set('agendamentos_id_seq', newId + 1);
      
      const newAgendamento = {
        id: newId,
        tenant_id: params[0],
        cliente_telefone: params[1],
        servico_id: params[2],
        profissional_id: params[3],
        data_agendamento: params[4],
        status: 'agendado',
        created_at: new Date()
      };
      
      agendamentos.push(newAgendamento);
      return { rows: [newAgendamento] };
    }
    
    if (text.includes('SELECT') && text.includes('conversation_states')) {
      const states = this.tables.get('conversation_states') || [];
      const phone = params[1] || params[0];
      return {
        rows: states.filter(s => s.phone === phone)
      };
    }
    
    if (text.includes('INSERT INTO conversation_states') || text.includes('UPDATE conversation_states')) {
      const states = this.tables.get('conversation_states') || [];
      const phone = params[1] || params[0];
      const existingIndex = states.findIndex(s => s.phone === phone);
      
      const stateData = {
        tenant_id: params[0],
        phone: phone,
        state: params[2],
        slots: params[3],
        context: params[4] || {},
        updated_at: new Date()
      };
      
      if (existingIndex >= 0) {
        states[existingIndex] = { ...states[existingIndex], ...stateData };
      } else {
        states.push({ id: states.length + 1, ...stateData });
      }
      
      return { rows: [stateData] };
    }
    
    return { rows: [] };
  }

  async connect(): Promise<any> {
    return this;
  }

  release(): void {
    // Mock release
  }
}

// Setup global mocks
const mockRedis = new MockRedis();
const mockDb = new MockDatabase();

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => mockRedis);
});

jest.mock('../../infra/redis', () => ({
  redis: mockRedis
}));

jest.mock('../../infra/db', () => ({
  pool: {
    query: mockDb.query.bind(mockDb),
    connect: () => mockDb.connect()
  }
}));

// Mock Trinks API
jest.mock('../../integrations/trinks', () => ({
  getTrinksClient: () => ({
    getServicos: jest.fn().mockResolvedValue({
      data: [
        {
          id: 'srv_001',
          nome: 'Corte Feminino',
          categoria: 'cabelo',
          preco: 80.00,
          duracao: 60
        }
      ]
    }),
    createAgendamento: jest.fn().mockResolvedValue({
      id: 'agend_001',
      status: 'confirmado'
    }),
    getHorarios: jest.fn().mockResolvedValue({
      data: [
        {
          data: '2024-01-20',
          horario: '14:00',
          disponivel: true
        }
      ]
    })
  })
}));

// Mock OpenAI
jest.mock('../../llm/openai', () => ({
  generateResponse: jest.fn().mockResolvedValue('Resposta gerada pelo AI'),
  classifyIntent: jest.fn().mockResolvedValue('agendar_servico')
}));

describe('Testes de Integração - Fluxos Completos', () => {
  let app: express.Application;
  let marlieRouter: any;

  beforeAll(async () => {
    // Setup environment
    process.env.NODE_ENV = 'test';
    process.env.TENANT_ID = 'test-tenant';
    process.env.ADMIN_TOKEN = 'test-admin-token';
    
    // Inicializa módulos
    await initializeStateMachine();
    await initializeCatalog();
    
    // Cria aplicação Express
    app = express();
    app.use(express.json());
    
    // Cria router Marlie com dependências mockadas
    const mockServices = {
      redis: mockRedis as any,
      db: mockDb as any,
      messageBuffer: getMessageBuffer(mockRedis as any),
      handoffService: {} as any,
      validationService: {} as any,
      templateService: {} as any,
      catalogService: {} as any,
      trinksService: {} as any
    };
    
    marlieRouter = createMarlieRouter(
      mockServices.redis,
      mockServices.db,
      mockServices.messageBuffer,
      mockServices.handoffService,
      mockServices.validationService,
      mockServices.templateService,
      mockServices.catalogService,
      mockServices.trinksService
    );
    app.use('/webhook', marlieRouter);
  });

  beforeEach(async () => {
    // Limpa dados entre testes
    await mockRedis.del('*');
    mockDb.tables.set('conversation_states', []);
    mockDb.tables.set('agendamentos', []);
  });

  describe('Fluxo 1: Menu Determinístico → Agendamento', () => {
    it('deve apresentar menu no primeiro contato e processar escolha de agendamento', async () => {
      const phone = '+5511999999999';
      
      // 1. Primeira mensagem - deve apresentar menu
      const response1 = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'Oi',
          timestamp: Date.now()
        });
      
      expect(response1.status).toBe(200);
      expect(response1.body.message).toContain('1');
      expect(response1.body.message).toContain('Agendar');
      expect(response1.body.message).toContain('2');
      expect(response1.body.message).toContain('Informações');
      
      // 2. Escolha opção 1 (Agendar)
      const response2 = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: '1',
          timestamp: Date.now()
        });
      
      expect(response2.status).toBe(200);
      expect(response2.body.message).toContain('serviço');
      
      // 3. Entrada ambígua - deve ativar desambiguação
      const response3 = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'cabelo',
          timestamp: Date.now()
        });
      
      expect(response3.status).toBe(200);
      expect(response3.body.message).toContain('1)');
      expect(response3.body.message).toContain('2)');
      expect(response3.body.message).toContain('Corte');
      
      // 4. Escolha serviço específico
      const response4 = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: '1',
          timestamp: Date.now()
        });
      
      expect(response4.status).toBe(200);
      expect(response4.body.message).toContain('Anotei');
      expect(response4.body.message).toContain('Corte');
    });

    it('deve validar disponibilidade antes de confirmar agendamento', async () => {
      const phone = '+5511999999998';
      
      // Simula fluxo até validação
      await request(app).post('/webhook').send({ phone, message: 'Oi' });
      await request(app).post('/webhook').send({ phone, message: '1' });
      await request(app).post('/webhook').send({ phone, message: 'Corte Feminino' });
      
      // Deve solicitar data
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'amanhã',
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      expect(response.body.message).toContain('horário');
    });

    it('deve rejeitar agendamento para categoria ambígua não resolvida', async () => {
      const phone = '+5511999999997';
      
      // Simula entrada de categoria muito genérica
      await request(app).post('/webhook').send({ phone, message: 'Oi' });
      await request(app).post('/webhook').send({ phone, message: '1' });
      
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'beleza',
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      expect(response.body.message).toContain('específico');
    });
  });

  describe('Fluxo 2: Menu Determinístico → Informações', () => {
    it('deve fornecer informações quando escolhida opção 2', async () => {
      const phone = '+5511999999996';
      
      // 1. Menu inicial
      await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'Olá',
          timestamp: Date.now()
        });
      
      // 2. Escolha opção 2 (Informações)
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: '2',
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      expect(response.body.message).toContain('informações');
      expect(response.body.message).toContain('horário');
    });

    it('deve permitir busca de serviços específicos no modo informações', async () => {
      const phone = '+5511999999995';
      
      // Simula fluxo até informações
      await request(app).post('/webhook').send({ phone, message: 'Oi' });
      await request(app).post('/webhook').send({ phone, message: '2' });
      
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'Quanto custa manicure?',
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      expect(response.body.message).toContain('R$');
      expect(response.body.message).toContain('35');
    });
  });

  describe('Fluxo 3: Validação de Entrada Inválida', () => {
    it('deve rejeitar entrada inválida no menu e solicitar opção válida', async () => {
      const phone = '+5511999999994';
      
      // Menu inicial
      await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'Oi',
          timestamp: Date.now()
        });
      
      // Entrada inválida
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'xyz',
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      expect(response.body.message).toContain('1');
      expect(response.body.message).toContain('2');
      expect(response.body.message).toContain('opção');
    });

    it('deve rejeitar escolha inválida na desambiguação', async () => {
      const phone = '+5511999999993';
      
      // Simula fluxo até desambiguação
      await request(app).post('/webhook').send({ phone, message: 'Oi' });
      await request(app).post('/webhook').send({ phone, message: '1' });
      await request(app).post('/webhook').send({ phone, message: 'cabelo' });
      
      // Escolha inválida na desambiguação
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: '5',
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      expect(response.body.message).toContain('1');
      expect(response.body.message).toContain('2');
      expect(response.body.message).toContain('3');
    });
  });

  describe('Fluxo 4: Buffer Temporal de Mensagens', () => {
    it('deve agrupar mensagens quebradas em 30 segundos', async () => {
      const phone = '+5511999999992';
      
      // Primeira parte da mensagem
      const response1 = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'Quero agendar um',
          timestamp: Date.now()
        });
      
      // Segunda parte (dentro de 30s)
      const response2 = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'corte de cabelo',
          timestamp: Date.now() + 5000
        });
      
      // Deve processar como mensagem única
      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
      
      // Verifica se o buffer foi usado
      const bufferKey = `buffer:${phone}`;
      const bufferedMessage = await mockRedis.get(bufferKey);
      expect(bufferedMessage).toBeTruthy();
    });
  });

  describe('Fluxo 5: Human Handoff', () => {
    it('deve ativar handoff quando flag HUMAN_OVERRIDE está ativa', async () => {
      const phone = '+5511999999991';
      
      // Ativa flag de handoff
      await mockRedis.set(`human_override:${phone}`, 'true', 'EX', 3600);
      
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'Oi',
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      expect(response.body.message).toContain('atendente');
    });
  });

  describe('Fluxo 6: Templates de Resposta Personalizáveis', () => {
    it('deve usar templates com variáveis dinâmicas', async () => {
      const phone = '+5511999999990';
      
      // Simula fluxo com nome do usuário
      await mockRedis.set(`user:${phone}:name`, 'João', 'EX', 3600);
      
      await request(app).post('/webhook').send({ phone, message: 'Oi' });
      await request(app).post('/webhook').send({ phone, message: '1' });
      
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'cabelo',
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      // Verifica se template foi aplicado com variáveis
      expect(response.body.message).toContain('opções');
    });
  });

  describe('Fluxo 7: Integração Completa com Estado Persistente', () => {
    it('deve manter estado da conversa entre múltiplas interações', async () => {
      const phone = '+5511999999989';
      
      // Sequência completa de agendamento
      const responses = [];
      
      // 1. Menu inicial
      responses.push(await request(app).post('/webhook').send({ phone, message: 'Oi' }));
      
      // 2. Escolha agendamento
      responses.push(await request(app).post('/webhook').send({ phone, message: '1' }));
      
      // 3. Especifica serviço
      responses.push(await request(app).post('/webhook').send({ phone, message: 'Corte Feminino' }));
      
      // 4. Especifica data
      responses.push(await request(app).post('/webhook').send({ phone, message: 'amanhã' }));
      
      // 5. Especifica horário
      responses.push(await request(app).post('/webhook').send({ phone, message: '14:00' }));
      
      // Verifica que todas as respostas foram bem-sucedidas
      responses.forEach(response => {
        expect(response.status).toBe(200);
      });
      
      // Verifica estado final
      const finalResponse = responses[responses.length - 1];
      expect(finalResponse.body.message).toContain('confirmado');
    });
  });

  describe('Fluxo 8: Métricas e Observabilidade', () => {
    it('deve registrar métricas durante o fluxo completo', async () => {
      const phone = '+5511999999988';
      
      // Executa fluxo completo
      await request(app).post('/webhook').send({ phone, message: 'Oi' });
      await request(app).post('/webhook').send({ phone, message: '1' });
      await request(app).post('/webhook').send({ phone, message: 'cabelo' });
      await request(app).post('/webhook').send({ phone, message: '1' });
      
      // Verifica se métricas foram registradas no Redis
      const metricsKeys = await mockRedis.keys('metrics:*');
      expect(metricsKeys.length).toBeGreaterThan(0);
    });
  });

  afterAll(async () => {
    // Cleanup
    await mockRedis.del('*');
  });
});

// Testes de Performance
describe('Testes de Performance - Fluxos Completos', () => {
  let app: express.Application;
  let marlieRouter: any;

  beforeAll(async () => {
    // Setup environment
    process.env.NODE_ENV = 'test';
    process.env.TENANT_ID = 'test-tenant';
    process.env.ADMIN_TOKEN = 'test-admin-token';
    
    // Inicializa módulos
    await initializeStateMachine();
    await initializeCatalog();
    
    // Cria aplicação Express
    app = express();
    app.use(express.json());
    
    // Cria router Marlie com dependências mockadas
    const mockServices = {
      redis: mockRedis as any,
      db: mockDb as any,
      messageBuffer: getMessageBuffer(mockRedis as any),
      handoffService: {} as any,
      validationService: {} as any,
      templateService: {} as any,
      catalogService: {} as any,
      trinksService: {} as any
    };
    
    marlieRouter = createMarlieRouter(
      mockServices.redis,
      mockServices.db,
      mockServices.messageBuffer,
      mockServices.handoffService,
      mockServices.validationService,
      mockServices.templateService,
      mockServices.catalogService,
      mockServices.trinksService
    );
    app.use('/webhook', marlieRouter);
  });

  beforeEach(async () => {
    // Limpa dados entre testes
    await mockRedis.del('*');
    mockDb.tables.set('conversation_states', []);
    mockDb.tables.set('agendamentos', []);
  });

  it('deve processar fluxo completo em menos de 2 segundos', async () => {
    const phone = '+5511999999987';
    const startTime = Date.now();
    
    // Executa fluxo completo
    await request(app).post('/webhook').send({ phone, message: 'Oi' });
    await request(app).post('/webhook').send({ phone, message: '1' });
    await request(app).post('/webhook').send({ phone, message: 'Corte Feminino' });
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    expect(duration).toBeLessThan(2000); // 2 segundos
  });

  it('deve suportar múltiplas conversas simultâneas', async () => {
    const phones = [
      '+5511999999986',
      '+5511999999985',
      '+5511999999984'
    ];
    
    // Executa conversas em paralelo
    const promises = phones.map(phone => 
      request(app).post('/webhook').send({ phone, message: 'Oi' })
    );
    
    const responses = await Promise.all(promises);
    
    // Verifica que todas foram processadas com sucesso
    responses.forEach(response => {
      expect(response.status).toBe(200);
      expect(response.body.message).toContain('1');
    });
  });
});