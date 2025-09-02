// Global test setup

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
    getConversationState: jest.fn().mockResolvedValue(null),
    setConversationState: jest.fn().mockResolvedValue(undefined),
    updateClientSession: jest.fn().mockResolvedValue(undefined),
    recordAppointmentAttempt: jest.fn().mockResolvedValue(undefined),
    getServicosSuggestions: jest.fn().mockResolvedValue([]),
    existsServicoInCatalog: jest.fn().mockResolvedValue(true)
  };
});

// Mock Trinks API
jest.mock('../integrations/trinks', () => {
  return {
    Trinks: {
      verificarHorarioDisponivel: jest.fn().mockResolvedValue({ disponivel: true }),
      criarAgendamento: jest.fn().mockResolvedValue({ id: 'test-123' }),
      buscarClientePorTelefone: jest.fn().mockResolvedValue(null),
      criarCliente: jest.fn().mockResolvedValue({ id: 'client-123' })
    }
  };
});

// Mock chat completion
jest.mock('../llm/openai', () => {
  return {
    chatCompletion: jest.fn().mockResolvedValue('Resposta de teste do assistente')
  };
});

// Mock logger
jest.mock('../utils/logger', () => {
  return {
    logger: {
      info: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn()
    }
  };
});