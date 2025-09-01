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