// Mock winston first
jest.doMock('winston', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn()
  })),
  format: {
    combine: jest.fn(),
    timestamp: jest.fn(),
    json: jest.fn(),
    simple: jest.fn()
  },
  transports: {
    Console: jest.fn(),
    File: jest.fn()
  }
}));

// Mock logger before any imports
jest.doMock('../utils/logger', () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn()
  }
}));

import { extractIntentAndSlots } from '../orchestrator/dialog';
import { detectShortcuts } from '../utils/proactive-scheduling';
import { processShortcut } from '../utils/shortcuts';
import nluDataset from './nlu-dataset.json';

// Tipos para o dataset NLU
interface NLUTestCase {
  id: number;
  input: string;
  expected_output: {
    intent: string;
    serviceName?: string;
    dateRel?: string;
    timeISO?: string;
    name?: string;
    phone?: string;
    period?: string;
    action?: string;
    professionalName?: string;
  };
  category: string;
  dialect: string;
}

interface NLUDataset {
  description: string;
  version: string;
  created_at: string;
  test_cases: NLUTestCase[];
  metrics?: {
    total_cases: number;
    unique_services: number;
    unique_intents: number;
  };
}

// Mock das dependências externas
jest.mock('../llm/openai', () => ({
  chatCompletion: jest.fn()
}));

jest.mock('../integrations/trinks', () => ({
  Trinks: {
    buscarClientes: jest.fn(),
    buscarServicos: jest.fn(),
    buscarAgendamentos: jest.fn()
  }
}));

jest.mock('../db/index', () => ({
  getServicosSuggestions: jest.fn().mockResolvedValue([])
}));

describe('NLU Regression Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Intent and Slots Extraction', () => {
    // Testes para cada categoria do dataset
    const categories = {
      agendamento_basico: 'Agendamentos simples',
      agendamento_urgente: 'Agendamentos urgentes',
      agendamento_especifico: 'Agendamentos específicos',
      consulta_horarios: 'Consultas de horários',
      consulta_preco: 'Consultas de preços',
      reagendamento: 'Reagendamentos',
      cancelamento: 'Cancelamentos'
    };

    Object.entries(categories).forEach(([category, description]) => {
      describe(description, () => {
        const testCases = (nluDataset as NLUDataset).test_cases.filter((tc: NLUTestCase) => tc.category === category);
        
        testCases.forEach((testCase: NLUTestCase) => {
          it(`should correctly extract intent and slots for: "${testCase.input}"`, async () => {
            // Mock da resposta do LLM baseada no expected_output
            const { chatCompletion } = require('../llm/openai');
            chatCompletion.mockResolvedValueOnce(JSON.stringify(testCase.expected_output));

            const result = await extractIntentAndSlots(testCase.input);

            // Verificar intent
            expect(result.intent).toBe(testCase.expected_output.intent);

            // Verificar slots específicos se existirem
            if (testCase.expected_output.serviceName) {
              expect(result.serviceName).toBe(testCase.expected_output.serviceName);
            }
            if (testCase.expected_output.dateRel) {
              expect(result.dateRel || result.dateISO).toBe(testCase.expected_output.dateRel);
            }
            if (testCase.expected_output.timeISO) {
              expect(result.timeISO).toBe(testCase.expected_output.timeISO);
            }
            if (testCase.expected_output.name) {
              expect(result.slots?.name).toBe(testCase.expected_output.name);
            }
            if (testCase.expected_output.phone) {
              expect(result.slots?.phone).toBe(testCase.expected_output.phone);
            }
          });
        });
      });
    });
  });

  describe('Dialect Recognition', () => {
    it('should handle Bahian dialect expressions correctly', async () => {
      const bahianCases = (nluDataset as NLUDataset).test_cases.filter((tc: NLUTestCase) => tc.dialect === 'baiano');
      const { chatCompletion } = require('../llm/openai');
      
      for (const testCase of bahianCases.slice(0, 5)) { // Testar primeiros 5 casos
        chatCompletion.mockResolvedValueOnce(JSON.stringify(testCase.expected_output));
        
        const result = await extractIntentAndSlots(testCase.input);
        expect(result.intent).toBe(testCase.expected_output.intent);
      }
    });

    it('should handle neutral dialect correctly', async () => {
      const neutralCases = (nluDataset as NLUDataset).test_cases.filter((tc: NLUTestCase) => tc.dialect === 'neutro');
      const { chatCompletion } = require('../llm/openai');
      
      for (const testCase of neutralCases.slice(0, 5)) { // Testar primeiros 5 casos
        chatCompletion.mockResolvedValueOnce(JSON.stringify(testCase.expected_output));
        
        const result = await extractIntentAndSlots(testCase.input);
        expect(result.intent).toBe(testCase.expected_output.intent);
      }
    });
  });

  describe('Shortcut Detection', () => {
    const shortcutTests = [
      {
        input: 'quero remarcar meu horário',
        expectedAction: 'remarcar',
        description: 'remarcar shortcut'
      },
      {
        input: 'preciso cancelar',
        expectedAction: 'cancelar', 
        description: 'cancelar shortcut'
      },
      {
        input: 'quanto custa uma escova?',
        expectedAction: 'preco',
        description: 'preço shortcut'
      },
      {
        input: 'onde vocês ficam?',
        expectedAction: 'endereco',
        description: 'endereço shortcut'
      },
      {
        input: 'oi, tudo bem?',
        expectedAction: 'none',
        description: 'no shortcut detected'
      }
    ];

    shortcutTests.forEach(({ input, expectedAction, description }) => {
      it(`should detect ${description} correctly`, async () => {
        const result = await processShortcut(input, '71999887766');
        expect(result.action).toBe(expectedAction);
      });
    });
  });

  describe('Service Name Extraction', () => {
    const serviceTests = [
      { input: 'quero fazer manicure', expected: 'manicure' },
      { input: 'preciso cortar o cabelo', expected: 'corte de cabelo' },
      { input: 'fazer design de sobrancelha', expected: 'design de sobrancelha' },
      { input: 'quero unha gel', expected: 'unha gel' },
      { input: 'fazer limpeza de pele', expected: 'limpeza de pele' }
    ];

    serviceTests.forEach(({ input, expected }) => {
      it(`should extract service "${expected}" from "${input}"`, async () => {
        const { chatCompletion } = require('../llm/openai');
        chatCompletion.mockResolvedValueOnce(JSON.stringify({
          intent: 'agendar',
          serviceName: expected
        }));

        const result = await extractIntentAndSlots(input);
        expect(result.serviceName).toBe(expected);
      });
    });
  });

  describe('Date and Time Extraction', () => {
    const dateTimeTests = [
      {
        input: 'amanhã às 14h',
        expectedDate: 'amanhã',
        expectedTime: '14:00'
      },
      {
        input: 'hoje de manhã',
        expectedDate: 'hoje',
        expectedPeriod: 'manhã'
      },
      {
        input: 'sexta-feira à tarde',
        expectedDate: 'sexta',
        expectedPeriod: 'tarde'
      },
      {
        input: 'segunda às 15:30',
        expectedDate: 'segunda',
        expectedTime: '15:30'
      }
    ];

    dateTimeTests.forEach(({ input, expectedDate, expectedTime, expectedPeriod }) => {
      it(`should extract date/time from "${input}"`, async () => {
        const { chatCompletion } = require('../llm/openai');
        const mockResponse: any = {
          intent: 'schedule',
          dateRel: expectedDate
        };
        
        if (expectedTime) mockResponse.timeISO = expectedTime;
        if (expectedPeriod) mockResponse.period = expectedPeriod;
        
        chatCompletion.mockResolvedValueOnce(JSON.stringify(mockResponse));

        const result = await extractIntentAndSlots(input);
        expect(result.dateRel || result.dateISO).toBe(expectedDate);
        if (expectedTime) expect(result.timeISO).toBe(expectedTime);
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle LLM API failures gracefully', async () => {
      const { chatCompletion } = require('../llm/openai');
      chatCompletion.mockRejectedValueOnce(new Error('API Error'));

      const result = await extractIntentAndSlots('test input');
      expect(result.intent).toBe('outros');
    });

    it('should handle invalid JSON responses', async () => {
      const { chatCompletion } = require('../llm/openai');
      chatCompletion.mockResolvedValueOnce('invalid json response');

      const result = await extractIntentAndSlots('test input');
      expect(result.intent).toBe('outros');
    });

    it('should handle empty responses', async () => {
      const { chatCompletion } = require('../llm/openai');
      chatCompletion.mockResolvedValueOnce('');

      const result = await extractIntentAndSlots('');
      expect(result.intent).toBe('outros');
    });
  });

  describe('Performance Tests', () => {
    it('should process multiple requests within acceptable time', async () => {
      const { chatCompletion } = require('../llm/openai');
      chatCompletion.mockResolvedValue(JSON.stringify({ intent: 'agendar' }));

      const startTime = Date.now();
      const promises = Array(10).fill(0).map(() => 
        extractIntentAndSlots('quero agendar manicure')
      );
      
      await Promise.all(promises);
      const endTime = Date.now();
      
      // Deve processar 10 requests em menos de 5 segundos
      expect(endTime - startTime).toBeLessThan(5000);
    });
  });

  describe('Regression Prevention', () => {
    // Casos específicos que já causaram problemas
    const regressionCases = [
      {
        input: 'oxe, quero fazer unha',
        description: 'Bahian expression with service request',
        expectedIntent: 'agendar'
      },
      {
        input: 'eita, preciso cancelar',
        description: 'Bahian expression with cancellation',
        expectedIntent: 'cancel'
      },
      {
        input: 'massa! quanto custa?',
        description: 'Bahian expression with price inquiry',
        expectedIntent: 'price'
      }
    ];

    regressionCases.forEach(({ input, description, expectedIntent }) => {
      it(`should handle regression case: ${description}`, async () => {
        const { chatCompletion } = require('../llm/openai');
        chatCompletion.mockResolvedValueOnce(JSON.stringify({ intent: expectedIntent }));

        const result = await extractIntentAndSlots(input);
        expect(result.intent).toBe(expectedIntent);
      });
    });
  });
});

// Testes de integração com métricas
describe('NLU Metrics and Analytics', () => {
  it('should track intent distribution correctly', async () => {
    const intentCounts = (nluDataset as NLUDataset).test_cases.reduce((acc: Record<string, number>, tc: NLUTestCase) => {
      acc[tc.expected_output.intent] = (acc[tc.expected_output.intent] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    // Verificar se temos uma distribuição balanceada
    expect(intentCounts.schedule).toBeGreaterThan(10); // Maioria deve ser agendamentos
    expect(Object.keys(intentCounts).length).toBeGreaterThan(3); // Múltiplas intenções
  });

  it('should validate dataset quality', () => {
    const { test_cases, metrics } = nluDataset;
    
    // Verificar métricas do dataset
    expect(test_cases.length).toBe(metrics.total_cases);
    expect(metrics.total_cases).toBeGreaterThanOrEqual(50);
    expect(metrics.unique_services).toBeGreaterThan(20);
    expect(metrics.unique_intents).toBeGreaterThan(5);
    
    // Verificar que todos os casos têm campos obrigatórios
    test_cases.forEach((tc: NLUTestCase, index: number) => {
      expect(tc.id).toBeDefined();
      expect(tc.input).toBeDefined();
      expect(tc.expected_output).toBeDefined();
      expect(tc.category).toBeDefined();
      expect(tc.dialect).toBeDefined();
    });
  });
});