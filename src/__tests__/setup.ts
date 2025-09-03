// Global test setup

// Set environment variables for tests
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASS = 'password';
process.env.JWT_SECRET = 'test_secret';
process.env.ADMIN_TOKEN = 'test_admin_token';
process.env.NODE_ENV = 'test';

// Mock Pinecone
jest.mock('@pinecone-database/pinecone', () => {
  return {
    Pinecone: jest.fn().mockImplementation(() => ({
      Index: jest.fn().mockReturnValue({
        query: jest.fn().mockResolvedValue({ matches: [] }),
        upsert: jest.fn().mockResolvedValue({})
      })
    }))
  };
});

// Mock OpenAI Embeddings
jest.mock('@langchain/openai', () => {
  return {
    OpenAIEmbeddings: jest.fn().mockImplementation(() => ({
      embedQuery: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      embedDocuments: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]])
    }))
  };
});

// Mock database connections
jest.mock('../db/index', () => {
  return {
    initPersistence: jest.fn().mockResolvedValue(undefined),
    getConversationState: jest.fn().mockResolvedValue(null),
    setConversationState: jest.fn().mockResolvedValue(undefined),
    updateClientSession: jest.fn().mockResolvedValue(undefined),
    recordAppointmentAttempt: jest.fn().mockResolvedValue(undefined),
    recordPostBookingInteraction: jest.fn().mockResolvedValue(undefined),
    cleanExpiredConversationStates: jest.fn().mockResolvedValue(undefined),
    getAllConversationStates: jest.fn().mockResolvedValue([]),
    getServicosSuggestions: jest.fn().mockResolvedValue([]),
    existsServicoInCatalog: jest.fn().mockResolvedValue(true),
    addMessageToHistory: jest.fn().mockReturnValue([]),
    markMessageProcessed: jest.fn().mockResolvedValue(true),
    rateLimitAllow: jest.fn().mockResolvedValue(true),
    acquireIdempotencyKey: jest.fn().mockResolvedValue(true),
    getIdempotencyResult: jest.fn().mockResolvedValue(null),
    setIdempotencyResult: jest.fn().mockResolvedValue(undefined),
    getPg: jest.fn().mockReturnValue(null),
    __setPgForTests: jest.fn(),
    __resetPgForTests: jest.fn(),
    releaseIdempotencyKey: jest.fn().mockResolvedValue(undefined),
    cleanOldMessages: jest.fn().mockResolvedValue(undefined),
    pg: null,
    redis: null
  };
});

// Trinks API will be mocked in individual test files using axios mock

// Mock chat completion
jest.mock('../llm/openai', () => {
  return {
    chatCompletion: jest.fn().mockImplementation((messages) => {
      const userMessage = messages.find((m: any) => m.role === 'user')?.content || '';
      
      // Mock para extractIntentAndSlots
      if (userMessage.includes('agendar') || userMessage.includes('corte de cabelo')) {
        return Promise.resolve(JSON.stringify({
          intent: 'agendar',
          serviceName: 'corte de cabelo',
          dateRel: 'amanhã',
          timeISO: '10:00'
        }));
      }
      
      // Mock padrão para outras funções
      return Promise.resolve('Resposta de teste do assistente');
    })
  };
});

// Mock logger
// Mock winston first
jest.mock('winston', () => ({
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

// Mock logger
jest.mock('../utils/logger', () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn()
  }
}));