// Mock logger before any imports
jest.doMock('../utils/logger', () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn()
  }
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
  test('GET /health should return status ok', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
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
});