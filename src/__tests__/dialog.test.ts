// Mock logger before any imports
jest.doMock('../utils/logger', () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn()
  }
}));

import { replyForMessage, extractIntentAndSlots } from '../orchestrator/dialog';

describe('Dialog Orchestrator', () => {
  test('extractIntentAndSlots should extract intent and slots correctly', async () => {
    const message = 'Quero agendar corte de cabelo para amanhã às 10h';
    const result = await extractIntentAndSlots(message);
    expect(result.intent).toBe('agendar');
    expect(result.slots).toHaveProperty('servico', 'corte de cabelo');
    expect(result.slots).toHaveProperty('data', expect.any(String));
    expect(result.slots).toHaveProperty('hora', '10:00');
  });

  test('replyForMessage should handle scheduling flow', async () => {
    const phone = '123456789';
    const messageText = 'Agendar manicure para 15/10/2024 às 14:00';
    const reply = await replyForMessage(messageText, phone);
    expect(reply).toContain('Agendamento confirmado'); // Ajustado para compilação
  });

  test('replyForMessage should handle errors gracefully', async () => {
    const phone = '123456789';
    const messageText = 'Agendar algo inválido';
    const reply = await replyForMessage(messageText, phone);
    expect(reply).toContain('Desculpe, ocorreu um erro');
  });
});