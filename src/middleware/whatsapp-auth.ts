import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger } from '../utils/logger';

/**
 * Middleware para verificar assinatura do webhook do WhatsApp
 * Garante que as requisições vêm realmente do WhatsApp
 */
export function verifyWhatsAppWebhook(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const signature = req.get('X-Hub-Signature-256');
    const appSecret = process.env.WHATSAPP_APP_SECRET;

    if (!appSecret) {
      logger.error('WHATSAPP_APP_SECRET not configured');
      res.status(500).json({
        success: false,
        message: 'Configuração de segurança ausente'
      });
      return;
    }

    if (!signature) {
      logger.warn('Missing X-Hub-Signature-256 header');
      res.status(401).json({
        success: false,
        message: 'Assinatura ausente'
      });
      return;
    }

    // Remove o prefixo 'sha256=' da assinatura
    const signatureHash = signature.replace('sha256=', '');
    
    // Calcula hash esperado
    const expectedHash = crypto
      .createHmac('sha256', appSecret)
      .update(req.body, 'utf8')
      .digest('hex');

    // Compara assinaturas de forma segura
    const isValid = crypto.timingSafeEqual(
      Buffer.from(signatureHash, 'hex'),
      Buffer.from(expectedHash, 'hex')
    );

    if (!isValid) {
      logger.warn('Invalid webhook signature', {
        received: signatureHash.substring(0, 8) + '...',
        expected: expectedHash.substring(0, 8) + '...'
      });
      res.status(401).json({
        success: false,
        message: 'Assinatura inválida'
      });
      return;
    }

    // Assinatura válida, continua
    logger.debug('WhatsApp webhook signature verified');
    next();
  } catch (error) {
    logger.error('Error verifying WhatsApp signature:', error);
    res.status(500).json({
      success: false,
      message: 'Erro na verificação de segurança'
    });
  }
}

/**
 * Middleware para verificar token de acesso do WhatsApp em endpoints administrativos
 */
export function verifyWhatsAppToken(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const authHeader = req.get('Authorization');
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

    if (!accessToken) {
      logger.error('WHATSAPP_ACCESS_TOKEN not configured');
      res.status(500).json({
        success: false,
        message: 'Token de acesso não configurado'
      });
      return;
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        message: 'Token de autorização ausente ou inválido'
      });
      return;
    }

    const token = authHeader.substring(7); // Remove 'Bearer '
    
    if (token !== accessToken) {
      logger.warn('Invalid WhatsApp access token attempt');
      res.status(401).json({
        success: false,
        message: 'Token de acesso inválido'
      });
      return;
    }

    next();
  } catch (error) {
    logger.error('Error verifying WhatsApp token:', error);
    res.status(500).json({
      success: false,
      message: 'Erro na verificação do token'
    });
  }
}

/**
 * Middleware para rate limiting específico do WhatsApp
 * Previne spam e uso excessivo
 */
export function whatsAppRateLimit(
  windowMs: number = 60000, // 1 minuto
  maxRequests: number = 100 // máximo 100 requisições por minuto
) {
  const requests = new Map<string, { count: number; resetTime: number }>();

  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const clientId = req.ip || 'unknown';
      const now = Date.now();
      const windowStart = now - windowMs;

      // Limpa entradas expiradas
      for (const [key, data] of requests.entries()) {
        if (data.resetTime < windowStart) {
          requests.delete(key);
        }
      }

      // Verifica limite para este cliente
      const clientData = requests.get(clientId);
      
      if (!clientData) {
        // Primeira requisição desta janela
        requests.set(clientId, {
          count: 1,
          resetTime: now + windowMs
        });
        next();
        return;
      }

      if (clientData.count >= maxRequests) {
        logger.warn(`Rate limit exceeded for ${clientId}`);
        res.status(429).json({
          success: false,
          message: 'Muitas requisições. Tente novamente em alguns minutos.',
          retryAfter: Math.ceil((clientData.resetTime - now) / 1000)
        });
        return;
      }

      // Incrementa contador
      clientData.count++;
      next();
    } catch (error) {
      logger.error('Error in rate limiting:', error);
      // Em caso de erro, permite a requisição
      next();
    }
  };
}

/**
 * Middleware para validar formato de número de telefone
 */
export function validatePhoneNumber(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const phone = req.body.to || req.params.phone || req.query.phone;
    
    if (!phone) {
      res.status(400).json({
        success: false,
        message: 'Número de telefone é obrigatório'
      });
      return;
    }

    // Regex para validar formato internacional
    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    
    if (!phoneRegex.test(phone)) {
      res.status(400).json({
        success: false,
        message: 'Formato de telefone inválido. Use formato internacional (+5511999999999)'
      });
      return;
    }

    // Normaliza o número (adiciona + se não tiver)
    const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;
    
    // Atualiza o valor normalizado no request
    if (req.body.to) req.body.to = normalizedPhone;
    if (req.params.phone) req.params.phone = normalizedPhone;
    if (req.query.phone) req.query.phone = normalizedPhone;

    next();
  } catch (error) {
    logger.error('Error validating phone number:', error);
    res.status(500).json({
      success: false,
      message: 'Erro na validação do telefone'
    });
  }
}

/**
 * Middleware para log de requisições do WhatsApp
 */
export function logWhatsAppRequest(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const startTime = Date.now();
  
  // Log da requisição
  logger.info('WhatsApp request received', {
    method: req.method,
    url: req.url,
    userAgent: req.get('User-Agent'),
    contentLength: req.get('Content-Length'),
    timestamp: new Date().toISOString()
  });

  // Intercepta a resposta para log
  const originalSend = res.send;
  res.send = function(data) {
    const duration = Date.now() - startTime;
    
    logger.info('WhatsApp response sent', {
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      contentLength: data ? data.length : 0
    });
    
    return originalSend.call(this, data);
  };

  next();
}

/**
 * Middleware para verificar se o WhatsApp está configurado
 */
export function ensureWhatsAppConfigured(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const requiredEnvVars = [
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID'
  ];

  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    logger.error('WhatsApp not properly configured', {
      missingVariables: missingVars
    });
    
    res.status(503).json({
      success: false,
      message: 'Serviço WhatsApp não configurado',
      details: 'Configurações ausentes no servidor'
    });
    return;
  }

  next();
}