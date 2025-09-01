import request from 'supertest';
import { app } from '../server';
import jwt from 'jsonwebtoken';

describe('Server Integration Tests', () => {
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