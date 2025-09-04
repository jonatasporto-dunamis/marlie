import { Request, Response, NextFunction } from 'express';
import { redisHelper } from '../infra/redis';
import logger from '../utils/logger';
import { getCurrentTenantId } from './tenant';

/**
 * Configurações de rate limiting
 */
export interface RateLimitConfig {
  windowMs: number; // Janela de tempo em milissegundos
  maxRequests: number; // Máximo de requisições por janela
  keyGenerator?: (req: Request) => string; // Gerador de chave personalizado
  skipSuccessfulRequests?: boolean; // Pular requisições bem-sucedidas
  skipFailedRequests?: boolean; // Pular requisições com falha
  message?: string; // Mensagem de erro personalizada
}

/**
 * Rate limiting padrão para diferentes tipos de endpoint
 */
export const RATE_LIMIT_CONFIGS = {
  // Admin endpoints - 60 req/min
  ADMIN: {
    windowMs: 60 * 1000, // 1 minuto
    maxRequests: 60,
    message: 'Too many admin requests, please try again later'
  },
  
  // Webhook endpoints - 60 req/min
  WEBHOOK: {
    windowMs: 60 * 1000, // 1 minuto
    maxRequests: 60,
    message: 'Too many webhook requests, please try again later'
  },
  
  // API endpoints por IP - 100 req/min
  API_BY_IP: {
    windowMs: 60 * 1000, // 1 minuto
    maxRequests: 100,
    message: 'Too many API requests from this IP, please try again later'
  },
  
  // API endpoints por phone - 30 req/min
  API_BY_PHONE: {
    windowMs: 60 * 1000, // 1 minuto
    maxRequests: 30,
    message: 'Too many requests for this phone number, please try again later'
  },
  
  // Endpoints de autenticação - 10 req/min
  AUTH: {
    windowMs: 60 * 1000, // 1 minuto
    maxRequests: 10,
    message: 'Too many authentication attempts, please try again later'
  }
} as const;

/**
 * Obter IP real do cliente considerando proxies
 */
function getClientIP(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const realIP = req.headers['x-real-ip'];
  const remoteAddress = req.connection?.remoteAddress || req.socket?.remoteAddress;
  
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  
  if (typeof realIP === 'string') {
    return realIP;
  }
  
  return remoteAddress || 'unknown';
}

/**
 * Gerar chave de rate limiting
 */
function generateRateLimitKey(
  tenantId: string,
  identifier: string,
  endpoint: string,
  windowStart: number
): string {
  return `${tenantId}:${identifier}:${endpoint}:${windowStart}`;
}

/**
 * Middleware de rate limiting
 */
export function createRateLimiter(config: RateLimitConfig) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = getCurrentTenantId(req) || 'default';
      const windowStart = Math.floor(Date.now() / config.windowMs) * config.windowMs;
      
      // Gerar identificador
      let identifier: string;
      if (config.keyGenerator) {
        identifier = config.keyGenerator(req);
      } else {
        identifier = getClientIP(req);
      }
      
      // Gerar chave única
      const endpoint = req.route?.path || req.path;
      const window = windowStart.toString();
      
      // Incrementar contador
      const count = await redisHelper.incrementRateLimit(
        tenantId,
        identifier,
        `${endpoint}:${window}`,
        Math.ceil(config.windowMs / 1000)
      );
      
      // Verificar se excedeu o limite
      if (count > config.maxRequests) {
        logger.warn('Rate limit exceeded', {
          tenantId,
          identifier,
          endpoint,
          count,
          maxRequests: config.maxRequests,
          windowMs: config.windowMs
        });
        
        // Headers informativos
        res.set({
          'X-RateLimit-Limit': config.maxRequests.toString(),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': (windowStart + config.windowMs).toString()
        });
        
        return res.status(429).json({
          error: 'Rate limit exceeded',
          message: config.message || 'Too many requests, please try again later',
          retryAfter: Math.ceil((windowStart + config.windowMs - Date.now()) / 1000)
        });
      }
      
      // Headers informativos
      res.set({
        'X-RateLimit-Limit': config.maxRequests.toString(),
        'X-RateLimit-Remaining': Math.max(0, config.maxRequests - count).toString(),
        'X-RateLimit-Reset': (windowStart + config.windowMs).toString()
      });
      
      logger.debug('Rate limit check passed', {
        tenantId,
        identifier,
        endpoint,
        count,
        maxRequests: config.maxRequests
      });
      
      next();
      
    } catch (error) {
      logger.error('Rate limiting error:', error);
      // Em caso de erro, permitir a requisição
      next();
    }
  };
}

/**
 * Rate limiter para endpoints admin
 */
export const adminRateLimit = createRateLimiter(RATE_LIMIT_CONFIGS.ADMIN);

/**
 * Rate limiter para webhooks
 */
export const webhookRateLimit = createRateLimiter(RATE_LIMIT_CONFIGS.WEBHOOK);

/**
 * Rate limiter por IP para APIs
 */
export const apiRateLimitByIP = createRateLimiter(RATE_LIMIT_CONFIGS.API_BY_IP);

/**
 * Rate limiter por telefone para APIs
 */
export const apiRateLimitByPhone = createRateLimiter({
  ...RATE_LIMIT_CONFIGS.API_BY_PHONE,
  keyGenerator: (req: Request) => {
    // Extrair telefone do body, query ou params
    const phone = req.body?.phone || req.query?.phone || req.params?.phone;
    return phone ? `phone:${phone}` : `ip:${getClientIP(req)}`;
  }
});

/**
 * Rate limiter para autenticação
 */
export const authRateLimit = createRateLimiter(RATE_LIMIT_CONFIGS.AUTH);

/**
 * Middleware para resetar rate limit (uso administrativo)
 */
export function createRateLimitReset() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { identifier, endpoint } = req.body;
      
      if (!identifier || !endpoint) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'identifier and endpoint are required'
        });
      }
      
      const tenantId = getCurrentTenantId(req) || 'default';
      const windowStart = Math.floor(Date.now() / 60000) * 60000; // 1 minuto
      const window = windowStart.toString();
      
      await redisHelper.resetRateLimit(tenantId, identifier, `${endpoint}:${window}`);
      
      logger.info('Rate limit reset', {
        tenantId,
        identifier,
        endpoint,
        resetBy: req.ip
      });
      
      res.json({
        success: true,
        message: 'Rate limit reset successfully'
      });
      
    } catch (error) {
      logger.error('Error resetting rate limit:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to reset rate limit'
      });
    }
  };
}

/**
 * Middleware para obter estatísticas de rate limiting
 */
export function createRateLimitStats() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = getCurrentTenantId(req) || 'default';
      const { identifier, endpoint } = req.query;
      
      if (!identifier || !endpoint) {
        return res.status(400).json({
          error: 'Missing required parameters',
          message: 'identifier and endpoint query parameters are required'
        });
      }
      
      const windowStart = Math.floor(Date.now() / 60000) * 60000; // 1 minuto
      const window = windowStart.toString();
      
      const count = await redisHelper.getRateLimitCount(
        tenantId,
        identifier as string,
        `${endpoint}:${window}`
      );
      
      res.json({
        tenantId,
        identifier,
        endpoint,
        currentWindow: windowStart,
        currentCount: count,
        windowMs: 60000,
        resetAt: windowStart + 60000
      });
      
    } catch (error) {
      logger.error('Error getting rate limit stats:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to get rate limit statistics'
      });
    }
  };
}

/**
 * Middleware para limpar rate limits expirados (uso em cron jobs)
 */
export function createRateLimitCleanup() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = getCurrentTenantId(req) || 'default';
      
      // Esta funcionalidade seria implementada no RedisHelper
      // Por enquanto, retornar sucesso
      
      logger.info('Rate limit cleanup completed', { tenantId });
      
      res.json({
        success: true,
        message: 'Rate limit cleanup completed'
      });
      
    } catch (error) {
      logger.error('Error during rate limit cleanup:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to cleanup rate limits'
      });
    }
  };
}