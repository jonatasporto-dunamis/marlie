// Mock logger before any imports
jest.doMock('../utils/logger', () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn()
  }
}));

import { Client } from 'pg';

// Mock the entire db module for this test
jest.mock('../db/index', () => {
  const mockClient = { query: jest.fn() };
  let pgClient: any = null;
  
  return {
    getAllConversationStates: jest.fn(),
    getPg: jest.fn(() => pgClient),
    __setPgForTests: jest.fn((client: any) => { pgClient = client; }),
    __resetPgForTests: jest.fn(() => { pgClient = null; })
  };
});

jest.mock('pg', () => {
  const mClient = {
    query: jest.fn(),
  };
  return { Client: jest.fn(() => mClient) };
});

import { getAllConversationStates, getPg, __setPgForTests, __resetPgForTests } from '../db/index';

describe('Database Functions', () => {
  let mClient: { query: jest.Mock };
  const mockGetAllConversationStates = getAllConversationStates as jest.MockedFunction<typeof getAllConversationStates>;

  beforeEach(() => {
    mClient = { query: jest.fn() };
    jest.clearAllMocks();
  });

  test('getAllConversationStates should return conversation states for a tenant', async () => {
    const mockStates = [
      { phone: '123456789', state: 'agendamento' },
      { phone: '987654321', state: 'confirmacao' },
    ];
    
    mockGetAllConversationStates.mockResolvedValueOnce(mockStates);

    const result = await getAllConversationStates('default');

    expect(mockGetAllConversationStates).toHaveBeenCalledWith('default');
    expect(result).toEqual(mockStates);
  });
});