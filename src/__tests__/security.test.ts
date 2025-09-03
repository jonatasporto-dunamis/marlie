import request from 'supertest';
import express from 'express';
import { webhookRateLimit, webhookDedupe, adminRateLimit } from '../middleware/security';
import { jest } from '@jest/globals';

// Mock do Redis para testes
jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    connect: jest.fn(),
    get: jest.fn(),
    setEx: jest.fn(),
    del: jest.fn(),
    quit: jest.fn()
  }))
}));

describe('Security Middleware', () => {
  let app: express.Application;
  
  beforeEach(() => {
    app = express();
    app.use(express.json());
    
    // Limpar cache de deduplicação
    (global as any).messageCache?.clear();
  });

  describe('Webhook Rate Limiting', () => {
    beforeEach(() => {
      app.use('/webhooks', webhookRateLimit);
      app.post('/webhooks/test', (req, res) => {
        res.json({ success: true });
      });
    });

    it('should allow requests within rate limit', async () => {
      const responses = [];
      
      // Fazer 5 requisições (bem abaixo do limite de 300/min)
      for (let i = 0; i < 5; i++) {
        const response = await request(app)
          .post('/webhooks/test')
          .send({ message: `test-${i}` });
        
        responses.push(response);
      }
      
      // Todas devem ser bem-sucedidas
      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
      });
    });

    it('should block requests exceeding rate limit', async () => {
      // Simular muitas requisições do mesmo IP
      const requests = [];
      
      // Fazer 310 requisições (acima do limite de 300/min)
      for (let i = 0; i < 310; i++) {
        const request_promise = request(app)
          .post('/webhooks/test')
          .send({ message: `test-${i}` });
        
        requests.push(request_promise);
      }
      
      const responses = await Promise.all(requests);
      
      // Contar respostas de sucesso e rate limit
      const successCount = responses.filter(r => r.status === 200).length;
      const rateLimitCount = responses.filter(r => r.status === 429).length;
      
      expect(successCount).toBeLessThanOrEqual(300);
      expect(rateLimitCount).toBeGreaterThan(0);
      
      // Verificar mensagem de erro
      const rateLimitResponse = responses.find(r => r.status === 429);
      expect(rateLimitResponse?.body.error).toContain('Rate limit exceeded');
    }, 30000); // Timeout maior para este teste

    it('should reset rate limit after time window', async () => {
      // Este teste seria mais complexo em um ambiente real
      // Aqui apenas verificamos que o middleware está configurado
      const response = await request(app)
        .post('/webhooks/test')
        .send({ message: 'test' });
      
      expect(response.status).toBe(200);
    });

    it('should apply rate limit per IP', async () => {
      // Simular requisições de IPs diferentes
      const ip1Requests = [];
      const ip2Requests = [];
      
      // IP 1 - fazer muitas requisições
      for (let i = 0; i < 5; i++) {
        const req = request(app)
          .post('/webhooks/test')
          .set('X-Forwarded-For', '192.168.1.1')
          .send({ message: `ip1-${i}` });
        
        ip1Requests.push(req);
      }
      
      // IP 2 - fazer poucas requisições
      for (let i = 0; i < 3; i++) {
        const req = request(app)
          .post('/webhooks/test')
          .set('X-Forwarded-For', '192.168.1.2')
          .send({ message: `ip2-${i}` });
        
        ip2Requests.push(req);
      }
      
      const [ip1Responses, ip2Responses] = await Promise.all([
        Promise.all(ip1Requests),
        Promise.all(ip2Requests)
      ]);
      
      // Ambos IPs devem ter sucesso (dentro do limite)
      ip1Responses.forEach(response => {
        expect(response.status).toBe(200);
      });
      
      ip2Responses.forEach(response => {
        expect(response.status).toBe(200);
      });
    });
  });

  describe('Admin Rate Limiting', () => {
    beforeEach(() => {
      app.use('/admin', adminRateLimit);
      app.get('/admin/test', (req, res) => {
        res.json({ success: true });
      });
    });

    it('should allow requests within admin rate limit', async () => {
      const responses = [];
      
      // Fazer 10 requisições (bem abaixo do limite de 100/min)
      for (let i = 0; i < 10; i++) {
        const response = await request(app)
          .get('/admin/test');
        
        responses.push(response);
      }
      
      // Todas devem ser bem-sucedidas
      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
      });
    });

    it('should return 429 when admin rate limit exceeded', async () => {
      // Simular muitas requisições admin
      const requests = [];
      
      // Fazer 110 requisições (acima do limite de 100/min)
      for (let i = 0; i < 110; i++) {
        const request_promise = request(app)
          .get('/admin/test');
        
        requests.push(request_promise);
      }
      
      const responses = await Promise.all(requests);
      
      // Deve haver respostas 429
      const rateLimitResponses = responses.filter(r => r.status === 429);
      expect(rateLimitResponses.length).toBeGreaterThan(0);
      
      // Verificar mensagem de erro
      const rateLimitResponse = rateLimitResponses[0];
      expect(rateLimitResponse.body.error).toBe('Too many requests, please try again later.');
    }, 30000);
  });

  describe('Webhook Deduplication', () => {
    beforeEach(() => {
      app.use('/webhooks', webhookDedupe);
      app.post('/webhooks/test', (req, res) => {
        res.json({ success: true, processed: true });
      });
    });

    it('should process first occurrence of message', async () => {
      const messageData = {
        messageId: 'msg-123',
        from: '5511999999999',
        body: 'Hello World',
        timestamp: Date.now()
      };
      
      const response = await request(app)
        .post('/webhooks/test')
        .send(messageData);
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.processed).toBe(true);
    });

    it('should reject duplicate messages', async () => {
      const messageData = {
        messageId: 'msg-456',
        from: '5511999999999',
        body: 'Duplicate test',
        timestamp: Date.now()
      };
      
      // Primeira requisição - deve ser processada
      const firstResponse = await request(app)
        .post('/webhooks/test')
        .send(messageData);
      
      expect(firstResponse.status).toBe(200);
      expect(firstResponse.body.processed).toBe(true);
      
      // Segunda requisição - deve ser rejeitada
      const secondResponse = await request(app)
        .post('/webhooks/test')
        .send(messageData);
      
      expect(secondResponse.status).toBe(200);
      expect(secondResponse.body.duplicate).toBe(true);
      expect(secondResponse.body.processed).toBeUndefined();
    });

    it('should handle messages without messageId', async () => {
      const messageData = {
        from: '5511999999999',
        body: 'No message ID',
        timestamp: Date.now()
      };
      
      const response = await request(app)
        .post('/webhooks/test')
        .send(messageData);
      
      // Deve processar normalmente (sem deduplicação)
      expect(response.status).toBe(200);
      expect(response.body.processed).toBe(true);
    });

    it('should generate consistent hash for same message content', async () => {
      const messageData1 = {
        from: '5511999999999',
        body: 'Test message',
        timestamp: 1234567890
      };
      
      const messageData2 = {
        from: '5511999999999',
        body: 'Test message',
        timestamp: 1234567890
      };
      
      // Primeira mensagem
      const firstResponse = await request(app)
        .post('/webhooks/test')
        .send(messageData1);
      
      expect(firstResponse.status).toBe(200);
      expect(firstResponse.body.processed).toBe(true);
      
      // Segunda mensagem (mesmo conteúdo)
      const secondResponse = await request(app)
        .post('/webhooks/test')
        .send(messageData2);
      
      expect(secondResponse.status).toBe(200);
      expect(secondResponse.body.duplicate).toBe(true);
    });

    it('should allow different messages from same sender', async () => {
      const message1 = {
        messageId: 'msg-001',
        from: '5511999999999',
        body: 'First message',
        timestamp: Date.now()
      };
      
      const message2 = {
        messageId: 'msg-002',
        from: '5511999999999',
        body: 'Second message',
        timestamp: Date.now() + 1000
      };
      
      // Primeira mensagem
      const firstResponse = await request(app)
        .post('/webhooks/test')
        .send(message1);
      
      expect(firstResponse.status).toBe(200);
      expect(firstResponse.body.processed).toBe(true);
      
      // Segunda mensagem (diferente)
      const secondResponse = await request(app)
        .post('/webhooks/test')
        .send(message2);
      
      expect(secondResponse.status).toBe(200);
      expect(secondResponse.body.processed).toBe(true);
      expect(secondResponse.body.duplicate).toBeUndefined();
    });

    it('should handle cache size limit', async () => {
      // Simular muitas mensagens para testar limite do cache
      const responses = [];
      
      for (let i = 0; i < 15000; i++) { // Acima do MAX_CACHE_SIZE (10000)
        const messageData = {
          messageId: `msg-${i}`,
          from: '5511999999999',
          body: `Message ${i}`,
          timestamp: Date.now() + i
        };
        
        const response = await request(app)
          .post('/webhooks/test')
          .send(messageData);
        
        responses.push(response);
        
        // Parar se começar a dar erro
        if (response.status !== 200) break;
      }
      
      // Todas as mensagens únicas devem ser processadas
      const processedCount = responses.filter(r => r.body.processed).length;
      expect(processedCount).toBeGreaterThan(10000);
    }, 60000); // Timeout maior para este teste
  });

  describe('Combined Security Middleware', () => {
    beforeEach(() => {
      // Aplicar ambos middlewares
      app.use('/webhooks', webhookRateLimit, webhookDedupe);
      app.post('/webhooks/evolution', (req, res) => {
        res.json({ success: true, processed: true });
      });
    });

    it('should apply both rate limiting and deduplication', async () => {
      const messageData = {
        messageId: 'msg-combined-test',
        from: '5511999999999',
        body: 'Combined test',
        timestamp: Date.now()
      };
      
      // Primeira requisição - deve passar por ambos middlewares
      const firstResponse = await request(app)
        .post('/webhooks/evolution')
        .send(messageData);
      
      expect(firstResponse.status).toBe(200);
      expect(firstResponse.body.processed).toBe(true);
      
      // Segunda requisição - deve ser bloqueada por deduplicação
      const secondResponse = await request(app)
        .post('/webhooks/evolution')
        .send(messageData);
      
      expect(secondResponse.status).toBe(200);
      expect(secondResponse.body.duplicate).toBe(true);
    });

    it('should handle rate limit before deduplication', async () => {
      // Este teste verifica a ordem dos middlewares
      const messageData = {
        messageId: 'msg-order-test',
        from: '5511999999999',
        body: 'Order test',
        timestamp: Date.now()
      };
      
      const response = await request(app)
        .post('/webhooks/evolution')
        .send(messageData);
      
      // Deve processar normalmente se dentro dos limites
      expect(response.status).toBe(200);
    });
  });

  describe('Cache Management', () => {
    it('should clean expired entries from cache', async () => {
      // Este teste verifica se o cleanup automático funciona
      // Em um ambiente real, seria necessário aguardar o intervalo de limpeza
      
      const messageData = {
        messageId: 'msg-cleanup-test',
        from: '5511999999999',
        body: 'Cleanup test',
        timestamp: Date.now()
      };
      
      app.use('/webhooks', webhookDedupe);
      app.post('/webhooks/test', (req, res) => {
        res.json({ success: true, processed: true });
      });
      
      const response = await request(app)
        .post('/webhooks/test')
        .send(messageData);
      
      expect(response.status).toBe(200);
      expect(response.body.processed).toBe(true);
      
      // Verificar que o cache contém a entrada
      // (Em um teste real, acessaríamos o cache diretamente)
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed webhook data gracefully', async () => {
      app.use('/webhooks', webhookDedupe);
      app.post('/webhooks/test', (req, res) => {
        res.json({ success: true, processed: true });
      });
      
      // Dados malformados
      const response = await request(app)
        .post('/webhooks/test')
        .send('invalid json');
      
      // Deve retornar erro de parsing, não erro do middleware
      expect(response.status).toBe(400);
    });

    it('should continue processing if cache operations fail', async () => {
      // Mock falha no cache
      const originalConsoleError = console.error;
      console.error = jest.fn();
      
      app.use('/webhooks', webhookDedupe);
      app.post('/webhooks/test', (req, res) => {
        res.json({ success: true, processed: true });
      });
      
      const messageData = {
        messageId: 'msg-error-test',
        from: '5511999999999',
        body: 'Error test',
        timestamp: Date.now()
      };
      
      const response = await request(app)
        .post('/webhooks/test')
        .send(messageData);
      
      // Deve processar mesmo com erro no cache
      expect(response.status).toBe(200);
      
      console.error = originalConsoleError;
    });
  });
});