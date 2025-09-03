import './jest.env.js';

// Mock logger first to prevent file system operations
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}));

// Mock winston to prevent file system operations
jest.mock('winston', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  })),
  format: {
    timestamp: jest.fn(),
    json: jest.fn(),
    combine: jest.fn()
  },
  transports: {
    Console: jest.fn(),
    File: jest.fn()
  }
}));

// Mock health checks to prevent database connections
jest.mock('../middleware/health', () => ({
  healthHandler: jest.fn((req, res) => {
    res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
  }),
  readyHandler: jest.fn((req, res) => {
    res.status(200).json({ status: 'ready', timestamp: new Date().toISOString() });
  })
}));

// Mock database operations
jest.mock('../db/index', () => ({
  initPersistence: jest.fn().mockResolvedValue(undefined),
  setConversationState: jest.fn(),
  getConversationState: jest.fn(),
  recordAppointmentAttempt: jest.fn(),
  cleanExpiredConversationStates: jest.fn(),
  getAllConversationStates: jest.fn().mockResolvedValue([])
}));

import request from 'supertest';
import jwt from 'jsonwebtoken';

describe('Server Integration Tests', () => {
  let app: any;
  
  beforeAll(async () => {
    // Import server after mocks are set up
    const serverModule = await import('../server');
    app = serverModule.app;
  });
  test('GET /health should return status healthy', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('healthy');
    expect(response.body.timestamp).toBeDefined();
  });

  test('POST /admin/login with valid credentials should return token', async () => {
    const response = await request(app)
      .post('/admin/login')
      .send({ username: process.env.ADMIN_USER, password: process.env.ADMIN_PASS });
    expect(response.status).toBe(200);
    expect(response.body.token).toBeDefined();

    const decoded = jwt.verify(response.body.token, process.env.JWT_SECRET || 'default_secret');
    if (typeof decoded === 'object' && decoded !== null) {
      expect(decoded.username).toBe(process.env.ADMIN_USER);
    }
  });

  test('POST /admin/login with invalid credentials should return 401', async () => {
    const response = await request(app)
      .post('/admin/login')
      .send({ username: 'wrong', password: 'wrong' });
    expect(response.status).toBe(401);
  });

  describe('Admin Authentication Tests', () => {
    test('GET /admin without token should return 401', async () => {
      const response = await request(app).get('/admin');
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('X-Admin-Token header required');
    });

    test('GET /admin with invalid token should return 401', async () => {
      const response = await request(app)
        .get('/admin')
        .set('x-admin-token', 'invalid-token');
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid X-Admin-Token');
    });

    test('GET /admin with valid token should return 200', async () => {
      const response = await request(app)
        .get('/admin')
        .set('x-admin-token', process.env.ADMIN_TOKEN!);
      expect(response.status).toBe(200);
    });

    test('GET /admin/state/:phone without token should return 401', async () => {
      const response = await request(app).get('/admin/state/5511999999999');
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('X-Admin-Token header required');
    });

    test('GET /admin/state/:phone with valid token should return 200', async () => {
      const response = await request(app)
        .get('/admin/state/5511999999999')
        .set('x-admin-token', process.env.ADMIN_TOKEN!);
      expect(response.status).toBe(200);
    });
  });

  describe('Webhook Authentication Tests', () => {
    test('POST /webhooks/evolution without token should return 401', async () => {
      const response = await request(app)
        .post('/webhooks/evolution')
        .send({ test: 'data' });
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('X-Webhook-Token header required');
    });

    test('POST /webhooks/evolution with invalid token should return 401', async () => {
      const response = await request(app)
        .post('/webhooks/evolution')
        .set('x-webhook-token', 'invalid-token')
        .send({ test: 'data' });
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid X-Webhook-Token');
    });

    test('POST /webhooks/evolution with valid token should return 200', async () => {
      const response = await request(app)
        .post('/webhooks/evolution')
        .set('x-webhook-token', process.env.EVOLUTION_WEBHOOK_TOKEN!)
        .send({ test: 'data' });
      expect(response.status).toBe(200);
    });
  });

  describe('Rate Limiting Tests', () => {
    test('Admin rate limit should return 429 after exceeding limit', async () => {
      // Make multiple requests quickly to trigger rate limit
      const requests = [];
      for (let i = 0; i < 65; i++) { // Exceed the 60 req/min limit
        requests.push(
          request(app)
            .get('/admin')
            .set('x-admin-token', process.env.ADMIN_TOKEN!)
        );
      }
      
      const responses = await Promise.all(requests);
      
      // Check that some requests were rate limited
      const rateLimitedResponses = responses.filter(res => res.status === 429);
      expect(rateLimitedResponses.length).toBeGreaterThan(0);
      
      // Check rate limit response format
      if (rateLimitedResponses.length > 0) {
        const rateLimitResponse = rateLimitedResponses[0];
        expect(rateLimitResponse.body.error).toContain('Too many admin requests');
        expect(rateLimitResponse.body.retryAfter).toBe('1 minute');
      }
    }, 10000); // Increase timeout for this test
  });
});