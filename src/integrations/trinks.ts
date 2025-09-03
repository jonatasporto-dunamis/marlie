import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { z } from 'zod';
import logger from '../utils/logger';
import { retryWithBackoff, isRetryableError, isIdempotentMethod } from '../utils/backoff';
import { 
  generateBookingIdempotencyKey, 
  withIdempotency, 
  checkIdempotency,
  markInProgress,
  markCompleted 
} from '../utils/idempotency';
import { redis } from '../db/index';

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

function getClient(): AxiosInstance {
  const env = getEnv();
  validateConfigured(env);
  
  const client = axios.create({
    baseURL: env.TRINKS_BASE_URL,
    timeout: 10000, // 10 seconds timeout
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': env.TRINKS_API_KEY,
      'estabelecimentoId': env.TRINKS_ESTABELECIMENTO_ID,
    },
  });
  
  return client;
}

/**
 * Execute request with retry logic and proper error handling
 */
async function executeWithRetry<T>(
  operation: () => Promise<T>,
  method: string = 'GET'
): Promise<T> {
  const shouldRetry = (error: any) => {
    // Only retry idempotent methods or specific errors
    if (!isIdempotentMethod(method) && method.toUpperCase() !== 'POST') {
      return false;
    }
    
    return isRetryableError(error);
  };
  
  return retryWithBackoff(operation, {
    baseDelay: 1000,
    maxDelay: 10000,
    maxRetries: 2,
    jitter: true
  }, shouldRetry);
}

// Cache keys
const CACHE_KEYS = {
  SERVICOS: 'trinks:servicos',
  PROFISSIONAIS: 'trinks:profissionais',
  AGENDA: (profissionalId: string, data: string) => `trinks:agenda:${profissionalId}:${data}`
};

// Cache TTL (6-24h)
const CACHE_TTL = {
  SERVICOS: 24 * 60 * 60, // 24 hours
  PROFISSIONAIS: 24 * 60 * 60, // 24 hours
  AGENDA: 6 * 60 * 60 // 6 hours
};

export const Trinks = {
  async buscarClientes(params: {
    nome?: string;
    cpf?: string;
    telefone?: string;
    incluirDetalhes?: boolean | string;
  }) {
    const client = getClient();
    
    return executeWithRetry(async () => {
      const res = await client.get('/v1/clientes', {
        params: {
          nome: params.nome,
          cpf: params.cpf,
          telefone: params.telefone,
          incluirDetalhes: params.incluirDetalhes,
        },
      });
      return res.data;
    }, 'GET');
  },

  async criarCliente(data: any) {
    const client = getClient();
    
    return executeWithRetry(async () => {
      const res = await client.post('/v1/clientes', data, {
        headers: { 'content-type': 'application/json' },
      });
      return res.data;
    }, 'POST');
  },

  async buscarServicos(params: {
    nome?: string;
    categoria?: string;
    somenteVisiveisCliente?: boolean | string;
  }) {
    // Try cache first
    try {
      const cached = redis ? await redis.get(CACHE_KEYS.SERVICOS) : null;
      if (cached) {
        logger.debug('Returning cached servicos from Trinks');
        return JSON.parse(cached);
      }
    } catch (error) {
      logger.warn('Failed to get servicos from cache:', error);
    }
    
    const client = getClient();
    
    return executeWithRetry(async () => {
      const res = await client.get('/v1/servicos', { params });
      const data = res.data;
      
      // Cache the result
      try {
        if (redis) {
          await redis.setEx(CACHE_KEYS.SERVICOS, CACHE_TTL.SERVICOS, JSON.stringify(data));
          logger.debug('Cached servicos from Trinks');
        }
      } catch (error) {
        logger.warn('Failed to cache servicos:', error);
      }
      
      return data;
    }, 'GET');
  },

  async buscarAgendaPorProfissional(params: {
    data: string; // formato aaaa-mm-dd
    servicoId: string | number;
    servicoDuracao: string | number;
    profissionalId?: string | number;
  }) {
    const cacheKey = CACHE_KEYS.AGENDA(params.profissionalId?.toString() || 'all', params.data);
    
    // Try cache first
    try {
      const cached = redis ? await redis.get(cacheKey) : null;
      if (cached) {
        logger.debug(`Returning cached agenda for professional ${params.profissionalId || 'all'}`);
        return JSON.parse(cached);
      }
    } catch (error) {
      logger.warn('Failed to get agenda from cache:', error);
    }
    
    const client = getClient();
    
    return executeWithRetry(async () => {
      const path = `/v1/agendamentos/profissionais/${params.data}`;
      const res = await client.get(path, {
        params: {
          servicoId: params.servicoId,
          servicoDuracao: params.servicoDuracao,
          // Só envia profissionalId se informado
          ...(params.profissionalId !== undefined ? { profissionalId: params.profissionalId } : {}),
        },
      });
      
      const data = res.data;
      
      // Cache the result
      try {
        if (redis) {
          await redis.setEx(cacheKey, CACHE_TTL.AGENDA, JSON.stringify(data));
          logger.debug(`Cached agenda for professional ${params.profissionalId || 'all'}`);
        }
      } catch (error) {
        logger.warn('Failed to cache agenda:', error);
      }
      
      return data;
    }, 'GET');
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
    telefone?: string;
  }) {
    // Generate idempotency key
    const idempotencyKey = generateBookingIdempotencyKey(
      data.telefone || '',
      data.servicoId,
      data.dataHoraInicio.split('T')[0],
      data.dataHoraInicio.split('T')[1]?.substring(0, 5) || ''
    );
    
    // Use idempotency wrapper
    return withIdempotency(
      idempotencyKey,
      async () => {
        const client = getClient();
        
        return executeWithRetry(async () => {
          const res = await client.post('/v1/agendamentos', data, {
            headers: { 
              'content-type': 'application/json',
              'Idempotency-Key': idempotencyKey
            },
          });
          
          // Invalidate related cache entries
          try {
            if (redis) {
              const agendaCacheKey = CACHE_KEYS.AGENDA(
                data.profissionalId?.toString() || 'all', 
                data.dataHoraInicio.split('T')[0]
              );
              await redis.del(agendaCacheKey);
              logger.debug(`Invalidated agenda cache for professional ${data.profissionalId || 'all'}`);
            }
          } catch (error) {
            logger.warn('Failed to invalidate agenda cache:', error);
          }
          
          return res.data;
        }, 'POST');
      },
      { ttl: 30 * 60 } // 30 minutes TTL
    );
  },
};