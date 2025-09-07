import { jest } from '@jest/globals';

// Configurações globais para os testes
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.STAGING = 'true';
process.env.USE_TRINKS_STUBS = 'true';

// Mock do logger para evitar logs durante os testes
jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}));

// Mock das variáveis de ambiente
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test_db';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.TRINKS_API_KEY = 'test-trinks-key';
process.env.EVOLUTION_API_KEY = 'test-evolution-key';

// Configurar timeout global para testes
jest.setTimeout(30000);

// Limpar mocks antes de cada teste
beforeEach(() => {
  jest.clearAllMocks();
});

// Configurar mocks globais
global.console = {
  ...console,
  // Silenciar logs durante os testes
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

// Mock do fetch para requisições HTTP
global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    headers: new Headers()
  })
) as jest.Mock;

// Configurações específicas para testes de integração
export const testConfig = {
  database: {
    host: 'localhost',
    port: 5432,
    database: 'test_marlie_quality',
    username: 'test_user',
    password: 'test_pass',
    ssl: false,
    pool: {
      min: 1,
      max: 5
    }
  },
  redis: {
    host: 'localhost',
    port: 6379,
    db: 1, // Usar DB diferente para testes
    keyPrefix: 'test:marlie-quality:'
  },
  e2e: {
    timeout: 10000, // Timeout menor para testes
    scenarios: {
      basic_flow: {
        name: 'Fluxo Básico de Teste',
        description: 'Testa o fluxo básico de agendamento',
        steps: [
          {
            type: 'send_whatsapp_message',
            data: {
              phone: '+5511999999999',
              message: 'Olá, gostaria de agendar um horário'
            }
          },
          {
            type: 'wait_for_response',
            timeout: 5000
          },
          {
            type: 'confirm_appointment',
            data: {
              service: 'Corte de Cabelo',
              professional: 'João Silva',
              date: '2024-01-15',
              time: '14:00'
            }
          }
        ]
      }
    }
  },
  contract: {
    apis: {
      trinks: {
        baseUrl: 'https://api-staging.trinks.com',
        timeout: 5000,
        endpoints: [
          {
            path: '/appointments',
            method: 'POST',
            expectedSchema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                status: { type: 'string' },
                customer: { type: 'object' }
              },
              required: ['id', 'status']
            }
          }
        ]
      },
      evolution: {
        baseUrl: 'https://api-staging.evolution.com',
        timeout: 5000,
        endpoints: [
          {
            path: '/messages',
            method: 'POST',
            expectedSchema: {
              type: 'object',
              properties: {
                messageId: { type: 'string' },
                status: { type: 'string' }
              },
              required: ['messageId', 'status']
            }
          }
        ]
      }
    }
  },
  pipeline: {
    stages: {
      build: {
        name: 'Build',
        commands: ['npm run build'],
        timeout: 120000
      },
      lint: {
        name: 'Lint',
        commands: ['npm run lint'],
        timeout: 60000
      },
      test: {
        name: 'Test',
        commands: ['npm run test'],
        timeout: 300000
      },
      security_scan: {
        name: 'Security Scan',
        commands: ['npm audit'],
        timeout: 120000
      }
    },
    environments: {
      staging: {
        name: 'Staging',
        url: 'https://staging.marlie.com.br',
        healthcheck: '/health'
      }
    }
  },
  metrics: {
    enabled: true,
    retention: '7d',
    labels: {
      environment: 'test',
      module: 'marlie-quality'
    }
  },
  logging: {
    level: 'error',
    format: 'json',
    destination: 'console'
  }
};

// Helpers para testes
export const testHelpers = {
  // Criar dados de teste
  createTestCustomer: () => ({
    id: 'test-customer-1',
    name: 'Cliente Teste',
    phone: '+5511999999999',
    email: 'teste@exemplo.com',
    tenant_id: 'test-tenant'
  }),

  createTestAppointment: () => ({
    id: 'test-appointment-1',
    customer_id: 'test-customer-1',
    service_id: 'test-service-1',
    professional_id: 'test-professional-1',
    date: '2024-01-15',
    time: '14:00',
    status: 'confirmed',
    tenant_id: 'test-tenant'
  }),

  // Aguardar condição
  waitFor: async (condition: () => boolean, timeout = 5000) => {
    const start = Date.now();
    while (!condition() && Date.now() - start < timeout) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!condition()) {
      throw new Error(`Timeout waiting for condition after ${timeout}ms`);
    }
  },

  // Gerar ID único para testes
  generateTestId: (prefix = 'test') => `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
};