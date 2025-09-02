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