import { Trinks } from '../integrations/trinks';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('Trinks Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('verificarHorarioDisponivel should return availability', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { disponivel: true } });
    const result = await Trinks.verificarHorarioDisponivel({
      data: '2024-10-01',
      hora: '10:00',
      servicoId: 123,
      duracaoEmMinutos: 60
    });
    expect(result.disponivel).toBe(true);
    expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining('/agenda/verificar-disponibilidade'));
  });

  test('criarAgendamento should create appointment', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { id: 456 } });
    const result = await Trinks.criarAgendamento({
      servicoId: 123,
      clienteId: 789,
      dataHoraInicio: '2024-10-01T10:00:00Z',
      duracaoEmMinutos: 60,
      valor: 100,
      confirmado: true
    });
    expect(result.id).toBe(456);
    expect(mockedAxios.post).toHaveBeenCalledWith(expect.stringContaining('/agendamentos'), expect.any(Object));
  });

  test('criarAgendamento should handle errors', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('API Error'));
    await expect(Trinks.criarAgendamento({
      servicoId: 123,
      clienteId: 789,
      dataHoraInicio: '2024-10-01T10:00:00Z',
      duracaoEmMinutos: 60,
      valor: 100,
      confirmado: true
    })).rejects.toThrow('API Error');
  });
});