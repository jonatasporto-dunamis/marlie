// src/infra/redis.ts
import { createClient, RedisClientType } from 'redis';
import logger from '../utils/logger';

let client: RedisClientType | null = null;

/**
 * Obter cliente Redis singleton
 */
export async function getRedis(): Promise<RedisClientType | null> {
  if (client && client.isOpen) return client;

  const url = process.env.REDIS_URL;
  if (!url) {
    logger.warn('REDIS_URL not set - Redis functionality disabled');
    return null;
  }

  try {
    client = createClient({
      url,
      socket: {
        connectTimeout: 10_000, // 10s
        keepAlive: true,
        reconnectStrategy: (retries) => Math.min(1000 * 2 ** retries, 10_000),
      },
    });

    client.on('error', (err) => {
      logger.error('redis_error', { msg: err?.message });
    });

    client.on('connect', () => {
      logger.info('Redis connected successfully');
    });

    client.on('disconnect', () => {
      logger.warn('Redis disconnected');
    });

    await client.connect();
    return client;
  } catch (error) {
    logger.error('Failed to connect to Redis:', error);
    client = null;
    return null;
  }
}

/**
 * Ping Redis para health check
 */
export async function pingRedis(): Promise<boolean> {
  try {
    const c = await getRedis();
    if (!c) return false;
    
    const r = await c.ping();
    return r === 'PONG';
  } catch (error) {
    logger.error('Redis ping failed:', error);
    return false;
  }
}

/**
 * TTL padrões para diferentes tipos de dados
 */
export const TTL = {
  // Conversas - 2 horas
  CONVERSATION: 2 * 60 * 60, // 7200 segundos
  
  // Deduplicação de mensagens - 15 minutos
  MESSAGE_DEDUPE: 15 * 60, // 900 segundos
  
  // Cache de catálogo de serviços - 6-24 horas
  CATALOG_SHORT: 6 * 60 * 60, // 21600 segundos
  CATALOG_LONG: 24 * 60 * 60, // 86400 segundos
  
  // Idempotência - 30 minutos
  IDEMPOTENCY: 30 * 60, // 1800 segundos
  
  // Rate limiting - 1 hora
  RATE_LIMIT: 60 * 60, // 3600 segundos
  
  // Cache de configurações - 10 minutos
  CONFIG: 10 * 60, // 600 segundos
  
  // Sessões de usuário - 1 hora
  SESSION: 60 * 60, // 3600 segundos
  
  // Métricas temporárias - 5 minutos
  METRICS: 5 * 60, // 300 segundos
} as const;

/**
 * Helpers Redis multi-tenant com prefixos padronizados
 */
export class RedisHelper {
  private redis: RedisClientType | null = null;
  
  constructor() {
    this.initRedis();
  }
  
  private async initRedis() {
    this.redis = await getRedis();
  }
  
  private async ensureRedis(): Promise<RedisClientType> {
    if (!this.redis) {
      this.redis = await getRedis();
    }
    
    if (!this.redis) {
      throw new Error('Redis not available');
    }
    
    return this.redis;
  }
  
  /**
   * Gerar chave com prefixo de tenant
   */
  private getKey(prefix: string, tenantId: string, ...parts: string[]): string {
    return `${prefix}:${tenantId}:${parts.join(':')}`;
  }
  
  // ===== CONVERSAS ===== //
  
  /**
   * Definir estado de conversa
   * Padrão: conv:{tenant}:{phone}
   */
  async setConversationState(
    tenantId: string, 
    phone: string, 
    state: any, 
    ttl: number = TTL.CONVERSATION
  ): Promise<void> {
    try {
      const redis = await this.ensureRedis();
      const key = this.getKey('conv', tenantId, phone);
      await redis.setEx(key, ttl, JSON.stringify(state));
      
      logger.debug('Conversation state set', { tenantId, phone, ttl });
    } catch (error) {
      logger.error('Error setting conversation state:', { error, tenantId, phone });
      throw error;
    }
  }
  
  /**
   * Obter estado de conversa
   */
  async getConversationState(tenantId: string, phone: string): Promise<any | null> {
    try {
      const redis = await this.ensureRedis();
      const key = this.getKey('conv', tenantId, phone);
      const result = await redis.get(key);
      
      if (!result) {
        return null;
      }
      
      return JSON.parse(result);
    } catch (error) {
      logger.error('Error getting conversation state:', { error, tenantId, phone });
      return null;
    }
  }
  
  /**
   * Deletar estado de conversa
   */
  async deleteConversationState(tenantId: string, phone: string): Promise<void> {
    try {
      const redis = await this.ensureRedis();
      const key = this.getKey('conv', tenantId, phone);
      await redis.del(key);
      
      logger.debug('Conversation state deleted', { tenantId, phone });
    } catch (error) {
      logger.error('Error deleting conversation state:', { error, tenantId, phone });
    }
  }
  
  // ===== DEDUPLICAÇÃO DE MENSAGENS ===== //
  
  /**
   * Marcar mensagem como processada
   * Padrão: msg:{tenant}:{messageId}
   */
  async markMessageProcessed(
    tenantId: string, 
    messageId: string, 
    ttl: number = TTL.MESSAGE_DEDUPE
  ): Promise<boolean> {
    try {
      const redis = await this.ensureRedis();
      const key = this.getKey('msg', tenantId, messageId);
      const result = await redis.set(key, '1', { NX: true, EX: ttl });
      
      const isFirstTime = result === 'OK';
      logger.debug('Message processed check', { tenantId, messageId, isFirstTime });
      
      return isFirstTime;
    } catch (error) {
      logger.error('Error marking message as processed:', { error, tenantId, messageId });
      return true; // Em caso de erro, permitir processamento
    }
  }
  
  /**
   * Verificar se mensagem já foi processada
   */
  async isMessageProcessed(tenantId: string, messageId: string): Promise<boolean> {
    try {
      const redis = await this.ensureRedis();
      const key = this.getKey('msg', tenantId, messageId);
      const result = await redis.exists(key);
      
      return result === 1;
    } catch (error) {
      logger.error('Error checking if message is processed:', { error, tenantId, messageId });
      return false;
    }
  }
  
  // ===== CACHE DE CATÁLOGO ===== //
  
  /**
   * Cache de serviços
   * Padrão: cache:servicos:{tenant}
   */
  async setCatalogCache(
    tenantId: string, 
    data: any, 
    ttl: number = TTL.CATALOG_SHORT
  ): Promise<void> {
    try {
      const redis = await this.ensureRedis();
      const key = this.getKey('cache:servicos', tenantId);
      await redis.setEx(key, ttl, JSON.stringify(data));
      
      logger.debug('Catalog cache set', { tenantId, ttl });
    } catch (error) {
      logger.error('Error setting catalog cache:', { error, tenantId });
    }
  }
  
  /**
   * Obter cache de catálogo
   */
  async getCatalogCache(tenantId: string): Promise<any | null> {
    try {
      const redis = await this.ensureRedis();
      const key = this.getKey('cache:servicos', tenantId);
      const result = await redis.get(key);
      
      if (!result) {
        return null;
      }
      
      return JSON.parse(result);
    } catch (error) {
      logger.error('Error getting catalog cache:', { error, tenantId });
      return null;
    }
  }
  
  /**
   * Invalidar cache de catálogo
   */
  async invalidateCatalogCache(tenantId: string): Promise<void> {
    try {
      const redis = await this.ensureRedis();
      const key = this.getKey('cache:servicos', tenantId);
      await redis.del(key);
      
      logger.debug('Catalog cache invalidated', { tenantId });
    } catch (error) {
      logger.error('Error invalidating catalog cache:', { error, tenantId });
    }
  }
  
  // ===== IDEMPOTÊNCIA ===== //
  
  /**
   * Definir chave de idempotência
   * Padrão: idemp:{tenant}:{hash}
   */
  async setIdempotencyKey(
    tenantId: string, 
    hash: string, 
    result: any, 
    ttl: number = TTL.IDEMPOTENCY
  ): Promise<void> {
    try {
      const redis = await this.ensureRedis();
      const key = this.getKey('idemp', tenantId, hash);
      await redis.setEx(key, ttl, JSON.stringify(result));
      
      logger.debug('Idempotency key set', { tenantId, hash, ttl });
    } catch (error) {
      logger.error('Error setting idempotency key:', { error, tenantId, hash });
    }
  }
  
  /**
   * Obter resultado de idempotência
   */
  async getIdempotencyResult(tenantId: string, hash: string): Promise<any | null> {
    try {
      const redis = await this.ensureRedis();
      const key = this.getKey('idemp', tenantId, hash);
      const result = await redis.get(key);
      
      if (!result) {
        return null;
      }
      
      return JSON.parse(result);
    } catch (error) {
      logger.error('Error getting idempotency result:', { error, tenantId, hash });
      return null;
    }
  }
  
  /**
   * Verificar se operação é idempotente
   */
  async checkIdempotency(tenantId: string, hash: string): Promise<boolean> {
    try {
      const redis = await this.ensureRedis();
      const key = this.getKey('idemp', tenantId, hash);
      const result = await redis.exists(key);
      
      return result === 1;
    } catch (error) {
      logger.error('Error checking idempotency:', { error, tenantId, hash });
      return false;
    }
  }
  
  // ===== RATE LIMITING ===== //
  
  /**
   * Incrementar contador de rate limit
   * Padrão: rl:{tenant}:{identifier}:{window}
   */
  async incrementRateLimit(
    tenantId: string, 
    identifier: string, 
    window: string, 
    ttl: number = TTL.RATE_LIMIT
  ): Promise<number> {
    try {
      const redis = await this.ensureRedis();
      const key = this.getKey('rl', tenantId, identifier, window);
      
      const count = await redis.incr(key);
      
      // Definir TTL apenas na primeira vez
      if (count === 1) {
        await redis.expire(key, ttl);
      }
      
      return count;
    } catch (error) {
      logger.error('Error incrementing rate limit:', { error, tenantId, identifier, window });
      return 0;
    }
  }
  
  /**
   * Obter contador atual de rate limit
   */
  async getRateLimitCount(
    tenantId: string, 
    identifier: string, 
    window: string
  ): Promise<number> {
    try {
      const redis = await this.ensureRedis();
      const key = this.getKey('rl', tenantId, identifier, window);
      const result = await redis.get(key);
      
      return result ? parseInt(result, 10) : 0;
    } catch (error) {
      logger.error('Error getting rate limit count:', { error, tenantId, identifier, window });
      return 0;
    }
  }
  
  /**
   * Resetar contador de rate limit
   */
  async resetRateLimit(
    tenantId: string, 
    identifier: string, 
    window: string
  ): Promise<void> {
    try {
      const redis = await this.ensureRedis();
      const key = this.getKey('rl', tenantId, identifier, window);
      await redis.del(key);
      
      logger.debug('Rate limit reset', { tenantId, identifier, window });
    } catch (error) {
      logger.error('Error resetting rate limit:', { error, tenantId, identifier, window });
    }
  }
  
  /**
   * Rate limiting helpers
   */
  async rateLimitCheck(tenantId: string, key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; count: number; resetTime: number }> {
    const now = Date.now();
    const windowStart = Math.floor(now / (windowSeconds * 1000)) * (windowSeconds * 1000);
    const windowKey = this.getKey('rl', tenantId, key, windowStart.toString());
    
    try {
      const redis = await this.ensureRedis();
      const count = await redis.incr(windowKey);
      if (count === 1) {
        await redis.expire(windowKey, windowSeconds);
      }
      
      return {
        allowed: count <= limit,
        count,
        resetTime: windowStart + (windowSeconds * 1000)
      };
    } catch (error) {
      logger.error('Rate limit check failed:', error);
      return { allowed: true, count: 0, resetTime: now };
    }
  }

  /**
   * Health check específico do Redis
   */
  async healthCheck(): Promise<{
    status: 'healthy' | 'unhealthy';
    latency?: number;
    error?: string;
  }> {
    const startTime = Date.now();
    
    try {
      const redis = await this.ensureRedis();
      await redis.ping();
      
      const latency = Date.now() - startTime;
      
      return {
        status: 'healthy',
        latency
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

// Singleton instance
export const redisHelper = new RedisHelper();

// Encerramento limpo ao finalizar o processo
process.on('beforeExit', () => {
  client?.quit().catch(() => {});
});

process.on('SIGINT', () => {
  client?.quit().catch(() => {});
  process.exit(0);
});

process.on('SIGTERM', () => {
  client?.quit().catch(() => {});
  process.exit(0);
});