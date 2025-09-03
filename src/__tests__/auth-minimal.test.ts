// Mock environment variables first
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.EVOLUTION_WEBHOOK_TOKEN = 'test-webhook-token';
process.env.NODE_ENV = 'test';

// Mock logger to prevent file system operations
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

// Mock database and external dependencies
jest.mock('../db/index', () => ({
  initPersistence: jest.fn().mockResolvedValue(undefined),
  setConversationState: jest.fn(),
  getConversationState: jest.fn(),
  recordAppointmentAttempt: jest.fn(),
  cleanExpiredConversationStates: jest.fn(),
  getAllConversationStates: jest.fn()
}));

import request from 'supertest';
import express from 'express';
import { adminAuth, webhookAuth } from '../middleware/security';

// Create a minimal test app
const testApp = express();
testApp.use(express.json());

// Add test routes with auth middleware
testApp.get('/test-admin', adminAuth, (req, res) => {
  res.status(200).json({ message: 'Admin authenticated' });
});

testApp.post('/test-webhook', webhookAuth, (req, res) => {
  res.status(200).json({ message: 'Webhook authenticated' });
});

// Add a simple health route without dependencies
testApp.get('/test-health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

describe('Authentication Middleware Tests', () => {
  test('Simple health route should work', async () => {
    const response = await request(testApp)
      .get('/test-health')
      .expect(200);
    
    expect(response.body).toEqual({ status: 'ok' });
  });

  test('Admin route should return 401 without token', async () => {
    await request(testApp)
      .get('/test-admin')
      .expect(401);
  });

  test('Admin route should return 401 with invalid token', async () => {
    await request(testApp)
      .get('/test-admin')
      .set('X-Admin-Token', 'invalid-token')
      .expect(401);
  });

  test('Admin route should return 200 with valid token', async () => {
    const response = await request(testApp)
      .get('/test-admin')
      .set('X-Admin-Token', 'test-admin-token')
      .expect(200);
    
    expect(response.body).toEqual({ message: 'Admin authenticated' });
  });

  test('Webhook route should return 401 without token', async () => {
    await request(testApp)
      .post('/test-webhook')
      .expect(401);
  });

  test('Webhook route should return 401 with invalid token', async () => {
    await request(testApp)
      .post('/test-webhook')
      .set('X-Webhook-Token', 'invalid-token')
      .expect(401);
  });

  test('Webhook route should return 200 with valid token', async () => {
    const response = await request(testApp)
      .post('/test-webhook')
      .set('X-Webhook-Token', 'test-webhook-token')
      .expect(200);
    
    expect(response.body).toEqual({ message: 'Webhook authenticated' });
  });
});