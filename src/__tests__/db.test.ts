import { Client } from 'pg';
import { getAllConversationStates, getPg, __setPgForTests, __resetPgForTests } from '../db/index';

// Não mockar o módulo de DB inteiro para evitar problemas de fechamento/escopo.

jest.mock('pg', () => {
  const mClient = {
    query: jest.fn(),
  };
  return { Client: jest.fn(() => mClient) };
});

describe('Database Functions', () => {
  let mClient: { query: jest.Mock };

  beforeEach(() => {
    mClient = { query: jest.fn() };
    __setPgForTests(mClient as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
    __resetPgForTests();
  });

  test('getAllConversationStates should return conversation states for a tenant', async () => {
    const mockStates = [
      { phone: '123456789', state: 'agendamento' },
      { phone: '987654321', state: 'confirmacao' },
    ];
    mClient.query.mockResolvedValueOnce({ rows: mockStates });

    const result = await getAllConversationStates('default');

    expect(getPg()!.query).toHaveBeenCalledWith(
      'SELECT phone, state FROM conversation_states WHERE tenant_id = $1',
      ['default']
    );
    expect(result).toEqual(mockStates);
  });
});