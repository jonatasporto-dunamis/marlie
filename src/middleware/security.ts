import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import logger from '../utils/logger';

// Middleware de autenticação admin com X-Admin-Token
export const adminAuth = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers['x-admin-token'];
  const expectedToken = process.env.ADMIN_TOKEN;

  if (!expectedToken) {
    logger.error('ADMIN_TOKEN not configured in environment variables');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  if (!token) {
    logger.warn('Admin access attempt without token', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path
    });
    return res.status(401).json({ error: 'X-Admin-Token header required' });
  }

  if (token !== expectedToken) {
    logger.warn('Admin access attempt with invalid token', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path,
      providedToken: typeof token === 'string' ? token.substring(0, 8) + '...' : 'invalid'
    });
    return res.status(401).json({ error: 'Invalid X-Admin-Token' });
  }

  // Log successful admin access for audit
  logger.info('Admin access granted', {
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    path: req.path,
    method: req.method
  });

  next();
};

// Middleware de autenticação webhook com X-Webhook-Token
export const webhookAuth = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers['x-webhook-token'];
  const expectedToken = process.env.EVOLUTION_WEBHOOK_TOKEN;

  if (!expectedToken) {
    logger.error('EVOLUTION_WEBHOOK_TOKEN not configured in environment variables');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  if (!token) {
    logger.warn('Webhook access attempt without token', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path
    });
    return res.status(401).json({ error: 'X-Webhook-Token header required' });
  }

  if (token !== expectedToken) {
    logger.warn('Webhook access attempt with invalid token', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path,
      providedToken: typeof token === 'string' ? token.substring(0, 8) + '...' : 'invalid'
    });
    return res.status(401).json({ error: 'Invalid X-Webhook-Token' });
  }

  // Log successful webhook access for audit
  logger.info('Webhook access granted', {
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    path: req.path,
    method: req.method
  });

  next();
};

// Rate limiting para rotas admin (60 req/min por IP)
export const adminRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 60, // máximo 60 requests por minuto
  message: {
    error: 'Too many admin requests from this IP, please try again later.',
    retryAfter: '1 minute'
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (req: Request, res: Response) => {
    logger.warn('Admin rate limit exceeded', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path
    });
    res.status(429).json({
      error: 'Too many admin requests from this IP, please try again later.',
      retryAfter: '1 minute'
    });
  }
});

// Rate limiting para webhooks (300 req/min por IP)
export const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 300, // máximo 300 requests por minuto (5 por segundo)
  message: {
    error: 'Too many webhook requests from this IP, please try again later.',
    retryAfter: '1 minute'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    logger.warn('Webhook rate limit exceeded', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path
    });
    res.status(429).json({
      error: 'Too many admin requests from this IP, please try again later.',
      retryAfter: '1 minute'
    });
  }
});

// Sistema de dedupe para webhooks (cache em memória)
const messageCache = new Map<string, number>();
const DEDUPE_WINDOW_MS = 5 * 60 * 1000; // 5 minutos
const MAX_CACHE_SIZE = 10000;

// Limpar cache periodicamente
setInterval(() => {
  const now = Date.now();
  const expiredKeys: string[] = [];
  
  for (const [key, timestamp] of messageCache.entries()) {
    if (now - timestamp > DEDUPE_WINDOW_MS) {
      expiredKeys.push(key);
    }
  }
  
  expiredKeys.forEach(key => messageCache.delete(key));
  
  // Se o cache ainda estiver muito grande, remover entradas mais antigas
  if (messageCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(messageCache.entries())
      .sort(([,a], [,b]) => a - b)
      .slice(0, messageCache.size - MAX_CACHE_SIZE);
    
    entries.forEach(([key]) => messageCache.delete(key));
  }
}, 60 * 1000); // Executar a cada minuto

// Middleware de dedupe para webhooks
export const webhookDedupe = (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body;
    
    // Gerar chave única baseada no conteúdo da mensagem
    let dedupeKey = '';
    
    if (body?.data?.key?.id) {
      // Usar ID da mensagem se disponível
      dedupeKey = `msg_${body.data.key.id}`;
    } else if (body?.data?.key?.remoteJid && body?.data?.messageTimestamp) {
      // Fallback: usar combinação de remetente + timestamp
      dedupeKey = `fallback_${body.data.key.remoteJid}_${body.data.messageTimestamp}`;
    } else {
      // Se não conseguir gerar chave, permitir processamento
      logger.warn('Unable to generate dedupe key for webhook', {
        requestId: req.requestId,
        bodyKeys: Object.keys(body || {})
      });
      return next();
    }
    
    const now = Date.now();
    const lastSeen = messageCache.get(dedupeKey);
    
    if (lastSeen && (now - lastSeen) < DEDUPE_WINDOW_MS) {
      logger.info('Duplicate webhook message detected, skipping', {
        requestId: req.requestId,
        dedupeKey,
        lastSeenMs: now - lastSeen
      });
      
      return res.status(200).json({ 
        status: 'duplicate', 
        message: 'Message already processed' 
      });
    }
    
    // Registrar mensagem no cache
    messageCache.set(dedupeKey, now);
    
    logger.debug('Webhook message passed dedupe check', {
      requestId: req.requestId,
      dedupeKey,
      cacheSize: messageCache.size
    });
    
    next();
  } catch (error) {
    logger.error('Error in webhook dedupe middleware', {
      requestId: req.requestId,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    
    // Em caso de erro, permitir processamento para não bloquear
    next();
  }
};

// Middleware para logs de auditoria
export const auditLogger = (req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();
  
  // Gerar requestId único
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  req.requestId = requestId;

  // Log da requisição
  logger.info('Request received', {
    requestId,
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    timestamp: new Date().toISOString()
  });

  // Interceptar a resposta para log
  const originalSend = res.send;
  res.send = function(data) {
    const elapsedMs = Date.now() - startTime;
    
    logger.info('Request completed', {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      elapsedMs,
      ip: req.ip,
      timestamp: new Date().toISOString()
    });
    
    return originalSend.call(this, data);
  };

  next();
};

// Extend Request interface to include requestId
declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}