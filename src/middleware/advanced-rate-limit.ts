import { Request, Response, NextFunction } from 'express';
import { createClient } from 'redis';
import logger from '../utils/logger';

interface RateLimitRule {
  key: 'ip' | 'user.phone';
  limit_per_min: number;
}

interface RateLimitConfig {
  rules: RateLimitRule[];
  penalty: {
    ban_minutes: number;
  };
  bypass_cidrs?: string[];
}

interface RateLimitState {
  count: number;
  resetTime: number;
  banned: boolean;
  banExpiry?: number;
}

/**
 * Middleware avançado de rate limiting com suporte a múltiplas chaves
 */
export class AdvancedRateLimit {
  private config: RateLimitConfig;
  private redis: any;
  private localCache = new Map<string, RateLimitState>();

  constructor(config: RateLimitConfig) {
    this.config = config;
    this.initRedis();
    
    // Limpeza periódica do cache local
    setInterval(() => this.cleanupLocalCache(), 60000); // 1 minuto
  }

  private async initRedis() {
    try {
      if (process.env.REDIS_URL) {
        this.redis = createClient({ url: process.env.REDIS_URL });
        await this.redis.connect();
        logger.info('Redis connected for rate limiting');
      }
    } catch (error) {
      logger.warn('Redis not available for rate limiting, using local cache', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Cria o middleware de rate limiting
   */
  middleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        // Verificar se IP está na lista de bypass
        if (this.isBypassedIP(req.ip)) {
          return next();
        }

        // Verificar cada regra de rate limit
        for (const rule of this.config.rules) {
          const key = this.extractKey(req, rule.key);
          if (!key) continue;

          const rateLimitKey = `rate_limit:${rule.key}:${key}`;
          const banKey = `ban:${rule.key}:${key}`;

          // Verificar se está banido
          if (await this.isBanned(banKey)) {
            logger.warn('Request blocked: IP/phone is banned', {
              ip: req.ip,
              key: rule.key,
              value: this.maskSensitiveData(key),
              path: req.path
            });
            
            return res.status(429).json({
              error: 'Too many requests. You are temporarily banned.',
              retryAfter: this.config.penalty.ban_minutes * 60
            });
          }

          // Verificar rate limit
          const isLimited = await this.checkRateLimit(rateLimitKey, rule.limit_per_min);
          
          if (isLimited) {
            // Aplicar banimento
            await this.applyBan(banKey);
            
            logger.warn('Rate limit exceeded, applying ban', {
              ip: req.ip,
              key: rule.key,
              value: this.maskSensitiveData(key),
              limit: rule.limit_per_min,
              banMinutes: this.config.penalty.ban_minutes,
              path: req.path
            });

            return res.status(429).json({
              error: 'Rate limit exceeded. You have been temporarily banned.',
              retryAfter: this.config.penalty.ban_minutes * 60
            });
          }
        }

        next();
      } catch (error) {
        logger.error('Rate limiting error', {
          error: error instanceof Error ? error.message : 'Unknown error',
          ip: req.ip,
          path: req.path
        });
        
        // Em caso de erro, permitir a requisição mas logar
        next();
      }
    };
  }

  /**
   * Verifica se o IP está na lista de bypass
   */
  private isBypassedIP(ip: string): boolean {
    if (!this.config.bypass_cidrs || this.config.bypass_cidrs.length === 0) {
      return false;
    }

    // Implementação simples de verificação CIDR
    // Para produção, usar biblioteca como 'ip-range-check'
    return this.config.bypass_cidrs.some(cidr => {
      if (cidr.includes('/')) {
        // CIDR notation - implementação básica
        const [network, prefixLength] = cidr.split('/');
        return ip.startsWith(network.split('.').slice(0, parseInt(prefixLength) / 8).join('.'));
      } else {
        // IP exato
        return ip === cidr;
      }
    });
  }

  /**
   * Extrai a chave baseada no tipo de regra
   */
  private extractKey(req: Request, keyType: string): string | null {
    switch (keyType) {
      case 'ip':
        return req.ip;
      case 'user.phone':
        // Extrair telefone do body, query ou headers
        return req.body?.phone || req.query?.phone || req.headers['x-phone'] as string || null;
      default:
        return null;
    }
  }

  /**
   * Verifica se está banido
   */
  private async isBanned(banKey: string): Promise<boolean> {
    try {
      if (this.redis) {
        const banExpiry = await this.redis.get(banKey);
        return banExpiry && parseInt(banExpiry) > Date.now();
      } else {
        const state = this.localCache.get(banKey);
        return state?.banned && (state.banExpiry || 0) > Date.now();
      }
    } catch (error) {
      logger.error('Error checking ban status', { error, banKey });
      return false;
    }
  }

  /**
   * Verifica rate limit e incrementa contador
   */
  private async checkRateLimit(rateLimitKey: string, limit: number): Promise<boolean> {
    const now = Date.now();
    const windowStart = Math.floor(now / 60000) * 60000; // Janela de 1 minuto
    const windowKey = `${rateLimitKey}:${windowStart}`;

    try {
      if (this.redis) {
        const count = await this.redis.incr(windowKey);
        if (count === 1) {
          await this.redis.expire(windowKey, 60); // Expira em 60 segundos
        }
        return count > limit;
      } else {
        const state = this.localCache.get(windowKey) || { count: 0, resetTime: windowStart + 60000, banned: false };
        
        if (now > state.resetTime) {
          state.count = 1;
          state.resetTime = windowStart + 60000;
        } else {
          state.count++;
        }
        
        this.localCache.set(windowKey, state);
        return state.count > limit;
      }
    } catch (error) {
      logger.error('Error checking rate limit', { error, rateLimitKey });
      return false;
    }
  }

  /**
   * Aplica banimento
   */
  private async applyBan(banKey: string): Promise<void> {
    const banExpiry = Date.now() + (this.config.penalty.ban_minutes * 60 * 1000);
    
    try {
      if (this.redis) {
        await this.redis.setex(banKey, this.config.penalty.ban_minutes * 60, banExpiry.toString());
      } else {
        this.localCache.set(banKey, {
          count: 0,
          resetTime: 0,
          banned: true,
          banExpiry
        });
      }
    } catch (error) {
      logger.error('Error applying ban', { error, banKey });
    }
  }

  /**
   * Limpa cache local de entradas expiradas
   */
  private cleanupLocalCache(): void {
    const now = Date.now();
    
    for (const [key, state] of this.localCache.entries()) {
      if (state.resetTime < now && (!state.banned || (state.banExpiry && state.banExpiry < now))) {
        this.localCache.delete(key);
      }
    }
  }

  /**
   * Mascara dados sensíveis para logs
   */
  private maskSensitiveData(data: string): string {
    if (data.includes('@')) {
      // Email
      const [local, domain] = data.split('@');
      return `${local.substring(0, 2)}***@${domain}`;
    } else if (data.match(/^\+?\d+$/)) {
      // Telefone
      return data.substring(0, 4) + '***' + data.substring(data.length - 2);
    }
    return data;
  }
}

/**
 * Factory function para criar middleware de rate limiting
 */
export function createAdvancedRateLimit(config: RateLimitConfig) {
  const rateLimiter = new AdvancedRateLimit(config);
  return rateLimiter.middleware();
}

/**
 * Middleware pré-configurado baseado nas variáveis de ambiente
 */
export const defaultRateLimit = createAdvancedRateLimit({
  rules: [
    {
      key: 'ip',
      limit_per_min: parseInt(process.env.RATE_IP_RPM || '120')
    },
    {
      key: 'user.phone',
      limit_per_min: parseInt(process.env.RATE_PHONE_RPM || '30')
    }
  ],
  penalty: {
    ban_minutes: parseInt(process.env.BAN_WINDOW_MIN || '15')
  },
  bypass_cidrs: process.env.INTERNAL_CIDRS?.split(',').map(cidr => cidr.trim()) || []
});

/**
 * Middleware específico para webhooks com limites mais altos
 */
export const webhookRateLimit = createAdvancedRateLimit({
  rules: [
    {
      key: 'ip',
      limit_per_min: 300 // 5 por segundo
    }
  ],
  penalty: {
    ban_minutes: 5 // Ban mais curto para webhooks
  }
});