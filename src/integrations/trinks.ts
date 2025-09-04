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
 * Implements resilient client with:
 * - 10s timeout (configured in getClient)
 * - Up to 3 retries with exponential backoff + jitter
 * - Only retries idempotent methods for 429/5xx errors
 */
async function executeWithRetry<T>(
  operation: () => Promise<T>,
  method: string = 'GET'
): Promise<T> {
  const shouldRetry = (error: any) => {
    // Only retry idempotent methods (GET, HEAD, PUT, DELETE, OPTIONS)
    if (!isIdempotentMethod(method)) {
      logger.debug(`Not retrying non-idempotent method: ${method}`);
      return false;
    }
    
    const isRetryable = isRetryableError(error);
    if (isRetryable) {
      const status = error.response?.status;
      logger.info(`Retrying Trinks API call due to ${status ? `HTTP ${status}` : error.code || 'network error'}`);
    }
    
    return isRetryable;
  };
  
  return retryWithBackoff(operation, {
    baseDelay: 1000, // 1s base delay
    maxDelay: 10000, // 10s max delay
    maxRetries: 3,   // Up to 3 retries as required
    jitter: true     // Add jitter to prevent thundering herd
  }, shouldRetry);
}

// Cache keys with tenant support
const CACHE_KEYS = {
  SERVICOS: (tenantId: string) => `serv:${tenantId}`,
  PROFISSIONAIS: (tenantId: string) => `prof:${tenantId}`,
  AGENDA: (profissionalId: string, data: string, tenantId: string) => `trinks:agenda:${tenantId}:${profissionalId}:${data}`,
  ETAG: (key: string) => `${key}:etag`
};

// Cache TTL (6-24h as required)
const CACHE_TTL = {
  SERVICOS: 24 * 60 * 60, // 24 hours
  PROFISSIONAIS: 6 * 60 * 60, // 6 hours
  AGENDA: 6 * 60 * 60, // 6 hours
  ETAG: 24 * 60 * 60 // 24 hours for ETags
};

/**
 * Get cached data with ETag validation
 */
async function getCachedWithETag<T>(cacheKey: string, etagKey: string): Promise<{ data: T | null; etag: string | null }> {
  if (!redis) return { data: null, etag: null };
  
  try {
    const [cachedData, cachedETag] = await Promise.all([
      redis.get(cacheKey),
      redis.get(etagKey)
    ]);
    
    return {
      data: cachedData ? JSON.parse(cachedData) : null,
      etag: cachedETag
    };
  } catch (error) {
    logger.warn('Failed to get cached data with ETag:', error);
    return { data: null, etag: null };
  }
}

/**
 * Set cached data with ETag
 */
async function setCachedWithETag(cacheKey: string, etagKey: string, data: any, etag: string, ttl: number): Promise<void> {
  if (!redis) return;
  
  try {
    await Promise.all([
      redis.setEx(cacheKey, ttl, JSON.stringify(data)),
      redis.setEx(etagKey, CACHE_TTL.ETAG, etag)
    ]);
  } catch (error) {
    logger.warn('Failed to cache data with ETag:', error);
  }
}

/**
 * Invalidate cache by pattern
 */
async function invalidateCache(pattern: string): Promise<void> {
  if (!redis) return;
  
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
      logger.debug(`Invalidated ${keys.length} cache entries matching pattern: ${pattern}`);
    }
  } catch (error) {
    logger.warn('Failed to invalidate cache:', error);
  }
}

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
    tenantId?: string;
  }) {
    const tenantId = params.tenantId || 'default';
    const cacheKey = CACHE_KEYS.SERVICOS(tenantId);
    const etagKey = CACHE_KEYS.ETAG(cacheKey);
    
    // Try cache first with ETag validation
    const cached = await getCachedWithETag(cacheKey, etagKey);
    
    const client = getClient();
    
    return executeWithRetry(async () => {
      const headers: any = {};
      if (cached.etag) {
        headers['If-None-Match'] = cached.etag;
      }
      
      try {
        const res = await client.get('/v1/servicos', { 
          params: {
            nome: params.nome,
            categoria: params.categoria,
            somenteVisiveisCliente: params.somenteVisiveisCliente
          },
          headers 
        });
        
        const data = res.data;
        const etag = res.headers.etag || res.headers.ETag || `"${Date.now()}"`;
        
        // Cache the fresh result
        await setCachedWithETag(cacheKey, etagKey, data, etag, CACHE_TTL.SERVICOS);
        logger.debug(`Cached fresh servicos for tenant ${tenantId}`);
        
        return data;
      } catch (error: any) {
        // If 304 Not Modified, return cached data
        if (error.response?.status === 304 && cached.data) {
          logger.debug(`Returning cached servicos for tenant ${tenantId} (304 Not Modified)`);
          return cached.data;
        }
        
        // If cache exists but API fails, return stale data
        if (cached.data) {
          logger.warn(`API failed, returning stale servicos for tenant ${tenantId}:`, error.message);
          return cached.data;
        }
        
        throw error;
      }
    }, 'GET');
  },

  async buscarAgendaPorProfissional(params: {
    data: string; // formato aaaa-mm-dd
    servicoId: string | number;
    servicoDuracao: string | number;
    profissionalId?: string | number;
    tenantId?: string;
  }) {
    const tenantId = params.tenantId || 'default';
    const cacheKey = CACHE_KEYS.AGENDA(params.profissionalId?.toString() || 'all', params.data, tenantId);
    const etagKey = CACHE_KEYS.ETAG(cacheKey);
    
    // Try cache first with ETag validation
    const cached = await getCachedWithETag(cacheKey, etagKey);
    
    const client = getClient();
    
    return executeWithRetry(async () => {
      const headers: any = {};
      if (cached.etag) {
        headers['If-None-Match'] = cached.etag;
      }
      
      try {
        const path = `/v1/agendamentos/profissionais/${params.data}`;
        const res = await client.get(path, {
          params: {
            servicoId: params.servicoId,
            servicoDuracao: params.servicoDuracao,
            // Só envia profissionalId se informado
            ...(params.profissionalId !== undefined ? { profissionalId: params.profissionalId } : {}),
          },
          headers
        });
        
        const data = res.data;
        const etag = res.headers.etag || res.headers.ETag || `"${Date.now()}"`;
        
        // Cache the fresh result
        await setCachedWithETag(cacheKey, etagKey, data, etag, CACHE_TTL.AGENDA);
        logger.debug(`Cached fresh agenda for professional ${params.profissionalId || 'all'} (tenant: ${tenantId})`);
        
        return data;
      } catch (error: any) {
        // If 304 Not Modified, return cached data
        if (error.response?.status === 304 && cached.data) {
          logger.debug(`Returning cached agenda for professional ${params.profissionalId || 'all'} (304 Not Modified)`);
          return cached.data;
        }
        
        // If cache exists but API fails, return stale data
        if (cached.data) {
          logger.warn(`API failed, returning stale agenda for professional ${params.profissionalId || 'all'}:`, error.message);
          return cached.data;
        }
        
        throw error;
      }
    }, 'GET');
  },

  async verificarHorarioDisponivel(params: {
    data: string; // formato aaaa-mm-dd
    hora: string; // formato HH:mm
    servicoId: number;
    duracaoEmMinutos: number;
    profissionalId?: number;
    tenantId?: string;
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
        tenantId: params.tenantId
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
    tenantId?: string; // opcional, default 'default'
  }) {
    // Generate idempotency key with tenant_id
    const idempotencyKey = generateBookingIdempotencyKey(
      data.telefone || '',
      data.servicoId,
      data.dataHoraInicio.split('T')[0],
      data.dataHoraInicio.split('T')[1]?.substring(0, 5) || '',
      data.tenantId || 'default'
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
          
          // Invalidate agenda cache after successful booking
          const tenantId = data.tenantId || 'default';
          await invalidateCache(`trinks:agenda:${tenantId}:*`);
          
          return res.data;
        }, 'POST');
      },
      { ttl: 30 * 60 } // 30 minutes TTL
    );
  },
};