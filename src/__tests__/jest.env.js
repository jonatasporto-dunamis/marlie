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
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASS = 'admin123';
process.env.EVOLUTION_BASE_URL = 'https://test.evolution.com';
process.env.EVOLUTION_API_KEY = 'test-evolution-key';
process.env.EVOLUTION_INSTANCE = 'test-instance';
process.env.PORT = '3001';
process.env.SERVER_URL = 'http://localhost:3001';
process.env.WEBHOOK_URL = 'http://localhost:3001/webhooks/evolution';