import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import logger from '../utils/logger';

interface HMACConfig {
  header: string;
  algo: string;
  secrets: string[];
  bodySource: 'raw' | 'json';
}

/**
 * Middleware de verificação HMAC para webhooks
 * Suporta rotação de secrets (current + previous)
 */
export class HMACVerification {
  private config: HMACConfig;

  constructor(config: HMACConfig) {
    this.config = config;
  }

  /**
   * Cria o middleware de verificação HMAC
   */
  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      try {
        const signature = req.headers[this.config.header.toLowerCase()] as string;
        
        if (!signature) {
          logger.warn('HMAC verification failed: missing signature header', {
            ip: req.ip,
            path: req.path,
            expectedHeader: this.config.header
          });
          return res.status(401).json({ error: 'Missing signature header' });
        }

        // Obter o body raw para verificação
        const body = this.getBodyForVerification(req);
        
        if (!this.verifySignature(signature, body)) {
          logger.warn('HMAC verification failed: invalid signature', {
            ip: req.ip,
            path: req.path,
            signature: signature.substring(0, 16) + '...'
          });
          return res.status(401).json({ error: 'Invalid signature' });
        }

        logger.info('HMAC verification successful', {
          ip: req.ip,
          path: req.path
        });

        next();
      } catch (error) {
        logger.error('HMAC verification error', {
          error: error instanceof Error ? error.message : 'Unknown error',
          ip: req.ip,
          path: req.path
        });
        return res.status(500).json({ error: 'Internal server error' });
      }
    };
  }

  /**
   * Verifica a assinatura HMAC usando os secrets disponíveis
   */
  private verifySignature(signature: string, body: string): boolean {
    for (const secret of this.config.secrets) {
      if (!secret) continue;
      
      const expectedSignature = this.generateSignature(body, secret);
      
      // Comparação segura contra timing attacks
      if (this.safeCompare(signature, expectedSignature)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Gera a assinatura HMAC
   */
  private generateSignature(body: string, secret: string): string {
    const hmac = crypto.createHmac(this.config.algo, secret);
    hmac.update(body, 'utf8');
    return `sha256=${hmac.digest('hex')}`;
  }

  /**
   * Comparação segura contra timing attacks
   */
  private safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    
    return result === 0;
  }

  /**
   * Obtém o body para verificação baseado na configuração
   */
  private getBodyForVerification(req: Request): string {
    if (this.config.bodySource === 'raw') {
      // Para body raw, precisamos do buffer original
      return (req as any).rawBody || JSON.stringify(req.body);
    } else {
      // Para JSON, serializar o objeto
      return JSON.stringify(req.body);
    }
  }
}

/**
 * Factory function para criar middleware HMAC
 */
export function createHMACMiddleware(config: Partial<HMACConfig> = {}) {
  const defaultConfig: HMACConfig = {
    header: 'X-Signature',
    algo: 'sha256',
    secrets: [
      process.env.HMAC_SECRET_CURRENT || '',
      process.env.HMAC_SECRET_PREV || ''
    ].filter(Boolean),
    bodySource: 'raw'
  };

  const finalConfig = { ...defaultConfig, ...config };
  
  if (finalConfig.secrets.length === 0) {
    throw new Error('No HMAC secrets configured');
  }

  const hmacVerification = new HMACVerification(finalConfig);
  return hmacVerification.middleware();
}

/**
 * Middleware para capturar o body raw (necessário para HMAC)
 */
export function rawBodyCapture() {
  return (req: Request, res: Response, next: NextFunction) => {
    let data = '';
    
    req.on('data', (chunk) => {
      data += chunk;
    });
    
    req.on('end', () => {
      (req as any).rawBody = data;
      next();
    });
  };
}

/**
 * Middleware HMAC pré-configurado para webhooks Evolution
 */
export const evolutionHMACVerification = createHMACMiddleware({
  header: 'X-Signature',
  algo: 'sha256',
  bodySource: 'raw'
});

/**
 * Middleware HMAC pré-configurado para webhooks Trinks
 */
export const trinksHMACVerification = createHMACMiddleware({
  header: 'X-Hub-Signature-256',
  algo: 'sha256', 
  bodySource: 'raw'
});