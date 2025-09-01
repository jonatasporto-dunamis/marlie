import axios from 'axios';
import { z } from 'zod';
import axiosRetry from 'axios-retry';

const TrinksEnvSchema = z.object({
  TRINKS_BASE_URL: z.string().url().optional(),
  TRINKS_API_KEY: z.string().min(1).optional(),
  TRINKS_ESTABELECIMENTO_ID: z.string().min(1).optional(),
});

function normalizeOptional(v?: string) {
  const t = (v ?? '').trim();
  return t.length ? t : undefined;
}

function getEnv() {
  const mapped = {
    TRINKS_BASE_URL: normalizeOptional(process.env.TRINKS_BASE_URL),
    TRINKS_API_KEY: normalizeOptional(process.env.TRINKS_API_KEY),
    TRINKS_ESTABELECIMENTO_ID: normalizeOptional(process.env.TRINKS_ESTABELECIMENTO_ID),
  };
  return TrinksEnvSchema.parse(mapped);
}

function validateConfigured(env: z.infer<typeof TrinksEnvSchema>) {
  if (!env.TRINKS_BASE_URL || !env.TRINKS_API_KEY || !env.TRINKS_ESTABELECIMENTO_ID) {
    throw new Error('Trinks API não configurada corretamente (TRINKS_BASE_URL, TRINKS_API_KEY, TRINKS_ESTABELECIMENTO_ID)');
  }
}

function getClient() {
  const env = getEnv();
  validateConfigured(env);
  const client = axios.create({
    baseURL: env.TRINKS_BASE_URL,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': env.TRINKS_API_KEY,
      'X-Estabelecimento-Id': env.TRINKS_ESTABELECIMENTO_ID,
    },
  });
  
  axiosRetry(client, {
    retries: 3,
    retryDelay: (retryCount) => retryCount * 1000,
    retryCondition: (error) => {
      return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response?.status === 429;
    },
  });
  return client;
}

export const Trinks = {
  async buscarClientes(params: {
    nome?: string;
    cpf?: string;
    telefone?: string;
    incluirDetalhes?: boolean | string;
  }) {
    const client = getClient();
    const res = await client.get('/v1/clientes', {
      params: {
        nome: params.nome,
        cpf: params.cpf,
        telefone: params.telefone,
        incluirDetalhes: params.incluirDetalhes,
      },
    });
    return res.data;
  },

  async criarCliente(data: any) {
    const client = getClient();
    const res = await client.post('/v1/clientes', data, {
      headers: { 'content-type': 'application/json' },
    });
    return res.data;
  },

  async buscarServicos(params: {
    nome?: string;
    categoria?: string;
    somenteVisiveisCliente?: boolean | string;
  }) {
    const client = getClient();
    const res = await client.get('/v1/servicos', { params });
    return res.data;
  },

  async buscarAgendaPorProfissional(params: {
    data: string; // formato aaaa-mm-dd
    servicoId: string | number;
    servicoDuracao: string | number;
    profissionalId: string | number;
  }) {
    const client = getClient();
    const path = `/v1/agendamentos/profissionais/${params.data}`;
    const res = await client.get(path, {
      params: {
        servicoId: params.servicoId,
        servicoDuracao: params.servicoDuracao,
        profissionalId: params.profissionalId,
      },
    });
    return res.data;
  },

  async verificarHorarioDisponivel(params: {
    data: string; // formato aaaa-mm-dd
    hora: string; // formato HH:mm
    servicoId: number;
    duracaoEmMinutos: number;
    profissionalId?: number;
  }): Promise<{ disponivel: boolean; motivo?: string }> {
    try {
      const client = getClient();
      
      // Buscar agenda do profissional para o dia
      const agenda = await this.buscarAgendaPorProfissional({
        data: params.data,
        servicoId: params.servicoId,
        servicoDuracao: params.duracaoEmMinutos,
        profissionalId: params.profissionalId || 1 // ID padrão se não especificado
      });
      
      // Verificar se o horário está disponível
      const horaInicio = new Date(`${params.data}T${params.hora}:00`);
      const horaFim = new Date(horaInicio.getTime() + params.duracaoEmMinutos * 60000);
      
      // Verificar conflitos com agendamentos existentes
      if (agenda && agenda.agendamentos) {
        for (const agendamento of agenda.agendamentos) {
          const agendamentoInicio = new Date(agendamento.dataHoraInicio);
          const agendamentoFim = new Date(agendamentoInicio.getTime() + agendamento.duracaoEmMinutos * 60000);
          
          // Verificar sobreposição
          if (horaInicio < agendamentoFim && horaFim > agendamentoInicio) {
            return {
              disponivel: false,
              motivo: `Horário conflita com agendamento existente às ${agendamentoInicio.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
            };
          }
        }
      }
      
      // Verificar horário de funcionamento (exemplo: 8h às 18h)
      const hora24 = parseInt(params.hora.split(':')[0]);
      if (hora24 < 8 || hora24 >= 18) {
        return {
          disponivel: false,
          motivo: 'Horário fora do funcionamento (8h às 18h)'
        };
      }
      
      return { disponivel: true };
    } catch (error) {
      console.error('Erro ao verificar horário disponível:', error);
      return {
        disponivel: false,
        motivo: 'Erro ao consultar agenda'
      };
    }
  },

  async criarAgendamento(data: {
    servicoId: number;
    clienteId: number;
    dataHoraInicio: string; // ISO
    duracaoEmMinutos: number;
    valor: number; // agora obrigatório
    confirmado: boolean; // novo campo obrigatório
    observacoes?: string; // opcional
    profissionalId?: number; // opcional
  }) {
    const client = getClient();
    const res = await client.post('/v1/agendamentos', data, {
      headers: { 'content-type': 'application/json' },
    });
    return res.data;
  },
};