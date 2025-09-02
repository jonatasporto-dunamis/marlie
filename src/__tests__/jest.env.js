// Mock environment variables for testing
process.env.PINECONE_API_KEY = 'test-pinecone-key';
process.env.PINECONE_INDEX_NAME = 'test-index';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
process.env.TRINKS_API_KEY = 'test-trinks-key';
process.env.TRINKS_BASE_URL = 'https://test.trinks.com';
process.env.TRINKS_ESTABELECIMENTO_ID = '12345';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV = 'test';