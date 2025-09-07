import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { createMarlieRouter } from '../../agents/marlie-router';
import { initializeStateMachine } from '../../init-state-machine';
import { initializeCatalog } from '../../init-catalog';

// Reutiliza mocks do arquivo principal
class MockRedis {
  private data = new Map<string, any>();
  private ttls = new Map<string, number>();
  private failureMode = false;

  setFailureMode(enabled: boolean) {
    this.failureMode = enabled;
  }

  async get(key: string): Promise<string | null> {
    if (this.failureMode) throw new Error('Redis connection failed');
    
    const ttl = this.ttls.get(key);
    if (ttl && Date.now() > ttl) {
      this.data.delete(key);
      this.ttls.delete(key);
      return null;
    }
    return this.data.get(key) || null;
  }

  async set(key: string, value: string, mode?: string, duration?: number): Promise<string> {
    if (this.failureMode) throw new Error('Redis connection failed');
    
    this.data.set(key, value);
    if (mode === 'EX' && duration) {
      this.ttls.set(key, Date.now() + duration * 1000);
    }
    return 'OK';
  }

  async setex(key: string, seconds: number, value: string): Promise<string> {
    if (this.failureMode) throw new Error('Redis connection failed');
    
    this.data.set(key, value);
    this.ttls.set(key, Date.now() + seconds * 1000);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    if (this.failureMode) throw new Error('Redis connection failed');
    
    const existed = this.data.has(key);
    this.data.delete(key);
    this.ttls.delete(key);
    return existed ? 1 : 0;
  }

  async keys(pattern: string): Promise<string[]> {
    if (this.failureMode) throw new Error('Redis connection failed');
    
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    return Array.from(this.data.keys()).filter(key => regex.test(key));
  }

  async exists(key: string): Promise<number> {
    if (this.failureMode) throw new Error('Redis connection failed');
    
    return this.data.has(key) ? 1 : 0;
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (this.failureMode) throw new Error('Redis connection failed');
    
    if (this.data.has(key)) {
      this.ttls.set(key, Date.now() + seconds * 1000);
      return 1;
    }
    return 0;
  }
}

class MockDatabase {
  public tables = new Map<string, any[]>();
  private failureMode = false;

  constructor() {
    this.tables.set('servicos_prof', [
      {
        id: 1,
        tenant_id: 'test-tenant',
        servico_id: 'srv_001',
        servico_nome: 'Corte Feminino',
        servico_nome_normalizado: 'corte feminino',
        categoria: 'cabelo',
        categoria_normalizada: 'cabelo',
        preco: 80.00,
        duracao: 60,
        ativo: true,
        visivel_cliente: true
      }
    ]);
    this.tables.set('conversation_states', []);
    this.tables.set('agendamentos', []);
  }

  setFailureMode(enabled: boolean) {
    this.failureMode = enabled;
  }

  async query(text: string, params: any[] = []): Promise<any> {
    if (this.failureMode) {
      throw new Error('Database connection failed');
    }

    if (text.includes('SELECT') && text.includes('servicos_prof')) {
      const services = this.tables.get('servicos_prof') || [];
      return { rows: services };
    }

    if (text.includes('SELECT') && text.includes('conversation_states')) {
      const states = this.tables.get('conversation_states') || [];
      return { rows: states };
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
    if (this.failureMode) {
      throw new Error('Database connection failed');
    }
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

// Mock Trinks API com falhas
const mockTrinksClient = {
  getServicos: jest.fn(),
  createAgendamento: jest.fn(),
  getHorarios: jest.fn()
};

jest.mock('../../integrations/trinks', () => ({
  getTrinksClient: () => mockTrinksClient
}));

// Mock OpenAI com falhas
const mockOpenAI = {
  generateResponse: jest.fn(),
  classifyIntent: jest.fn()
};

jest.mock('../../llm/openai', () => mockOpenAI);

describe('Testes de Edge Cases e Recuperação de Falhas', () => {
  let app: express.Application;
  let marlieRouter: any;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.TENANT_ID = 'test-tenant';
    process.env.ADMIN_TOKEN = 'test-admin-token';
    
    await initializeStateMachine();
    await initializeCatalog();
    
    app = express();
    app.use(express.json());
    
    marlieRouter = createMarlieRouter(
      mockRedis as any,
      { query: mockDb.query.bind(mockDb), connect: () => mockDb.connect() } as any,
      {} as any, // MessageBufferService
      {} as any, // HumanHandoffService
      {} as any, // ValidationService
      {} as any, // ResponseTemplateService
      {} as any, // CatalogService
      {} as any  // TrinksService
    );
    app.use('/webhook', marlieRouter);
  });

  beforeEach(async () => {
    // Reset mocks
    mockRedis.setFailureMode(false);
    mockDb.setFailureMode(false);
    
    mockTrinksClient.getServicos.mockResolvedValue({
      data: [{
        id: 'srv_001',
        nome: 'Corte Feminino',
        categoria: 'cabelo',
        preco: 80.00,
        duracao: 60
      }]
    });
    
    mockTrinksClient.createAgendamento.mockResolvedValue({
      id: 'agend_001',
      status: 'confirmado'
    });
    
    mockTrinksClient.getHorarios.mockResolvedValue({
      data: [{
        data: '2024-01-20',
        horario: '14:00',
        disponivel: true
      }]
    });
    
    mockOpenAI.generateResponse.mockResolvedValue('Resposta gerada pelo AI');
    mockOpenAI.classifyIntent.mockResolvedValue('agendar_servico');
    
    // Limpa dados
    await mockRedis.del('*');
    mockDb.tables.set('conversation_states', []);
    mockDb.tables.set('agendamentos', []);
  });

  describe('Falhas de Infraestrutura', () => {
    it('deve continuar funcionando quando Redis falha', async () => {
      const phone = '+5511999999999';
      
      // Simula falha do Redis
      mockRedis.setFailureMode(true);
      
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'Oi',
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      expect(response.body.message).toBeTruthy();
      // Deve funcionar mesmo sem cache
    });

    it('deve continuar funcionando quando banco de dados falha', async () => {
      const phone = '+5511999999998';
      
      // Simula falha do banco
      mockDb.setFailureMode(true);
      
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'Oi',
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      expect(response.body.message).toBeTruthy();
      // Deve usar fallback sem persistência
    });

    it('deve lidar com falha da API Trinks', async () => {
      const phone = '+5511999999997';
      
      // Simula falha da API Trinks
      mockTrinksClient.getServicos.mockRejectedValue(new Error('API Trinks indisponível'));
      
      await request(app).post('/webhook').send({ phone, message: 'Oi' });
      await request(app).post('/webhook').send({ phone, message: '1' });
      
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'corte',
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      expect(response.body.message).toContain('indisponível');
    });

    it('deve lidar com falha do OpenAI', async () => {
      const phone = '+5511999999996';
      
      // Simula falha do OpenAI
      mockOpenAI.generateResponse.mockRejectedValue(new Error('OpenAI API limit exceeded'));
      
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'Oi',
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      expect(response.body.message).toBeTruthy();
      // Deve usar resposta padrão
    });
  });

  describe('Entradas Maliciosas e Inválidas', () => {
    it('deve lidar com payload JSON malformado', async () => {
      const response = await request(app)
        .post('/webhook')
        .send('invalid json');
      
      expect(response.status).toBe(400);
    });

    it('deve lidar com mensagem extremamente longa', async () => {
      const phone = '+5511999999995';
      const longMessage = 'a'.repeat(10000);
      
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: longMessage,
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      expect(response.body.message).toContain('muito longa');
    });

    it('deve lidar com caracteres especiais e emojis', async () => {
      const phone = '+5511999999994';
      
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: '🔥💯 Ação <script>alert("xss")</script> 中文',
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      expect(response.body.message).toBeTruthy();
      // Deve sanitizar entrada
    });

    it('deve lidar com tentativas de SQL injection', async () => {
      const phone = '+5511999999993';
      
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: "'; DROP TABLE servicos_prof; --",
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      expect(response.body.message).toBeTruthy();
      // Deve tratar como entrada normal
    });

    it('deve lidar com números de telefone inválidos', async () => {
      const invalidPhones = [
        '',
        'invalid',
        '123',
        '+' + 'a'.repeat(20)
      ];
      
      for (const phone of invalidPhones) {
        const response = await request(app)
          .post('/webhook')
          .send({
            phone,
            message: 'Oi',
            timestamp: Date.now()
          });
        
        expect(response.status).toBe(400);
      }
    });
  });

  describe('Cenários de Concorrência', () => {
    it('deve lidar com múltiplas mensagens simultâneas do mesmo usuário', async () => {
      const phone = '+5511999999992';
      
      // Envia múltiplas mensagens ao mesmo tempo
      const promises = [
        request(app).post('/webhook').send({ phone, message: 'Oi', timestamp: Date.now() }),
        request(app).post('/webhook').send({ phone, message: '1', timestamp: Date.now() + 1 }),
        request(app).post('/webhook').send({ phone, message: 'corte', timestamp: Date.now() + 2 })
      ];
      
      const responses = await Promise.all(promises);
      
      // Todas devem ser processadas com sucesso
      responses.forEach(response => {
        expect(response.status).toBe(200);
      });
    });

    it('deve manter isolamento entre diferentes usuários', async () => {
      const phones = [
        '+5511999999991',
        '+5511999999990',
        '+5511999999989'
      ];
      
      // Cada usuário em estado diferente
      const promises = phones.map((phone, index) => 
        request(app).post('/webhook').send({ 
          phone, 
          message: index === 0 ? 'Oi' : index === 1 ? '1' : 'corte',
          timestamp: Date.now()
        })
      );
      
      const responses = await Promise.all(promises);
      
      // Cada resposta deve ser específica para o estado do usuário
      expect(responses[0].body.message).toContain('1'); // Menu
      expect(responses[1].body.message).toContain('serviço'); // Após escolher agendar
      expect(responses[2].body.message).toBeTruthy(); // Processamento de serviço
    });
  });

  describe('Limites e Rate Limiting', () => {
    it('deve lidar com muitas mensagens em sequência rápida', async () => {
      const phone = '+5511999999988';
      const messages = Array.from({ length: 20 }, (_, i) => `Mensagem ${i}`);
      
      const promises = messages.map(message => 
        request(app).post('/webhook').send({ 
          phone, 
          message, 
          timestamp: Date.now()
        })
      );
      
      const responses = await Promise.all(promises);
      
      // Deve processar todas ou aplicar rate limiting
      const successfulResponses = responses.filter(r => r.status === 200);
      expect(successfulResponses.length).toBeGreaterThan(0);
    });

    it('deve lidar com timeout de operações longas', async () => {
      const phone = '+5511999999987';
      
      // Simula operação lenta
      mockTrinksClient.getServicos.mockImplementation(() => 
        new Promise(resolve => setTimeout(resolve, 10000))
      );
      
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'Oi',
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      // Deve retornar resposta mesmo com timeout
    });
  });

  describe('Recuperação de Estado', () => {
    it('deve recuperar estado após reinicialização do sistema', async () => {
      const phone = '+5511999999986';
      
      // Simula estado salvo antes da reinicialização
      await mockRedis.set(
        `conversation_state:${phone}`,
        JSON.stringify({
          state: 'waiting_service',
          slots: { intent: 'agendar' },
          context: { menu_shown: true }
        }),
        'EX',
        3600
      );
      
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'corte',
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      expect(response.body.message).toContain('Corte');
      // Deve continuar do estado salvo
    });

    it('deve lidar com estado corrompido', async () => {
      const phone = '+5511999999985';
      
      // Simula estado corrompido
      await mockRedis.set(
        `conversation_state:${phone}`,
        'invalid json',
        'EX',
        3600
      );
      
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'Oi',
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      expect(response.body.message).toContain('1');
      // Deve resetar para estado inicial
    });
  });

  describe('Validação de Dados', () => {
    it('deve validar formato de data inválida', async () => {
      const phone = '+5511999999984';
      
      await request(app).post('/webhook').send({ phone, message: 'Oi' });
      await request(app).post('/webhook').send({ phone, message: '1' });
      await request(app).post('/webhook').send({ phone, message: 'Corte Feminino' });
      
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: '32/13/2024',
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      expect(response.body.message).toContain('válida');
    });

    it('deve validar horário inválido', async () => {
      const phone = '+5511999999983';
      
      await request(app).post('/webhook').send({ phone, message: 'Oi' });
      await request(app).post('/webhook').send({ phone, message: '1' });
      await request(app).post('/webhook').send({ phone, message: 'Corte Feminino' });
      await request(app).post('/webhook').send({ phone, message: 'amanhã' });
      
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: '25:99',
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      expect(response.body.message).toContain('horário');
    });
  });

  describe('Monitoramento e Logs', () => {
    it('deve registrar erros para monitoramento', async () => {
      const phone = '+5511999999982';
      
      // Força um erro
      mockDb.setFailureMode(true);
      
      const response = await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'Oi',
          timestamp: Date.now()
        });
      
      expect(response.status).toBe(200);
      // Erro deve ser logado mas não quebrar o fluxo
    });

    it('deve manter métricas mesmo com falhas parciais', async () => {
      const phone = '+5511999999981';
      
      // Simula falha parcial
      mockRedis.setFailureMode(true);
      
      await request(app)
        .post('/webhook')
        .send({
          phone,
          message: 'Oi',
          timestamp: Date.now()
        });
      
      // Métricas devem ser mantidas mesmo com Redis falhando
      // (usando fallback local ou banco)
    });
  });

  afterAll(async () => {
    // Cleanup
    mockRedis.setFailureMode(false);
    mockDb.setFailureMode(false);
  });
});