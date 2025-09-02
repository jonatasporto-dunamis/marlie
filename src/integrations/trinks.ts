import axios from 'axios';
import { z } from 'zod';
import axiosRetry from 'axios-retry';
import logger from '../utils/logger';

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
    profissionalId?: string | number;
  }) {
    const client = getClient();
    const path = `/v1/agendamentos/profissionais/${params.data}`;
    const res = await client.get(path, {
      params: {
        servicoId: params.servicoId,
        servicoDuracao: params.servicoDuracao,
        // Só envia profissionalId se informado
        ...(params.profissionalId !== undefined ? { profissionalId: params.profissionalId } : {}),
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
      // Regras de funcionamento: terça (2) a sábado (6), 10h-19h
      const horaInicio = new Date(`${params.data}T${params.hora}:00`);
      if (isNaN(horaInicio.getTime())) {
        return { disponivel: false, motivo: 'Data/horário inválidos' };
      }
      const now = new Date();
      if (horaInicio.getTime() <= now.getTime()) {
        // Não permitir horários no passado
        return { disponivel: false, motivo: 'Horário já passou, tente um horário futuro' };
      }
      const dow = horaInicio.getDay(); // 0-dom,1-seg,2-ter,3-qua,4-qui,5-sex,6-sab
      if (dow === 0 || dow === 1) {
        return { disponivel: false, motivo: 'Atendemos de terça a sábado' };
      }
      const hour = parseInt(params.hora.split(':')[0]);
      if (hour < 10 || hour >= 19) {
        return { disponivel: false, motivo: 'Horário fora do funcionamento (10h às 19h)' };
      }

      // Tenta consultar agenda do(s) profissional(is)
      const agenda = await this.buscarAgendaPorProfissional({
        data: params.data,
        servicoId: params.servicoId,
        servicoDuracao: params.duracaoEmMinutos,
        profissionalId: params.profissionalId,
      });

      const horaFim = new Date(horaInicio.getTime() + params.duracaoEmMinutos * 60000);

      // Se houver lista de agendamentos, validar conflitos
      const ags = (agenda && (agenda.agendamentos || agenda.data || agenda.slots)) ? (agenda.agendamentos || []) : [];
      if (Array.isArray(ags) && ags.length > 0) {
        for (const agendamento of ags) {
          const agStart = new Date(agendamento.dataHoraInicio || agendamento.inicio || agendamento.start);
          const agDur = Number(agendamento.duracaoEmMinutos || agendamento.duracao || agendamento.duration || 0);
          if (!isNaN(agStart.getTime()) && agDur > 0) {
            const agEnd = new Date(agStart.getTime() + agDur * 60000);
            if (horaInicio < agEnd && horaFim > agStart) {
              return {
                disponivel: false,
                motivo: `Conflito com agendamento existente às ${agStart.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`,
              };
            }
          }
        }
      }

      // Se não conseguimos avaliar (ex.: sem profissionalId e sem dados úteis), seja conservador
      if (!params.profissionalId && (!agenda || (!ags || ags.length === 0))) {
        return { disponivel: false, motivo: 'Preciso confirmar a disponibilidade com a profissional. Qual prefere ser atendido(a)?' };
      }

      return { disponivel: true };
    } catch (error) {
      logger.error('Erro ao verificar horário disponível:', error);
      return { disponivel: false, motivo: 'Erro ao consultar agenda' };
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
    try {
      const client = getClient();
      const res = await client.post('/v1/agendamentos', data, {
        headers: { 'content-type': 'application/json' },
      });
      return res.data;
    } catch (error) {
      logger.error('Erro ao criar agendamento:', error);
      throw error;
    }
  },
};