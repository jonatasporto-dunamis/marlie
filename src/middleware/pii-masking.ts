import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

interface PIIPattern {
  regex: string;
  replacement?: string;
  name?: string;
}

interface PIIMaskingConfig {
  enabled: boolean;
  patterns: PIIPattern[];
  maskChar: string;
  preserveLength: boolean;
  logMasking: boolean;
}

/**
 * Middleware para mascaramento de PII (Personally Identifiable Information)
 */
export class PIIMasking {
  private config: PIIMaskingConfig;
  private compiledPatterns: Array<{ regex: RegExp; replacement: string; name: string }>;

  constructor(config: PIIMaskingConfig) {
    this.config = config;
    this.compiledPatterns = this.compilePatterns();
  }

  /**
   * Compila os padrões regex para melhor performance
   */
  private compilePatterns() {
    return this.config.patterns.map(pattern => ({
      regex: new RegExp(pattern.regex, 'gi'),
      replacement: pattern.replacement || this.generateMask.bind(this),
      name: pattern.name || 'unknown'
    }));
  }

  /**
   * Gera máscara baseada na configuração
   */
  private generateMask(match: string): string {
    if (this.config.preserveLength) {
      return this.config.maskChar.repeat(match.length);
    } else {
      return `[${this.config.maskChar.repeat(3)}]`;
    }
  }

  /**
   * Mascara PII em uma string
   */
  public maskPII(text: string): string {
    if (!this.config.enabled || !text) {
      return text;
    }

    let maskedText = text;
    let maskingApplied = false;

    for (const pattern of this.compiledPatterns) {
      const originalText = maskedText;
      
      if (typeof pattern.replacement === 'string') {
        maskedText = maskedText.replace(pattern.regex, pattern.replacement);
      } else {
        maskedText = maskedText.replace(pattern.regex, pattern.replacement);
      }

      if (originalText !== maskedText) {
        maskingApplied = true;
        
        if (this.config.logMasking) {
          logger.debug('PII masking applied', {
            pattern: pattern.name,
            originalLength: originalText.length,
            maskedLength: maskedText.length
          });
        }
      }
    }

    return maskedText;
  }

  /**
   * Mascara PII em objetos recursivamente
   */
  public maskPIIInObject(obj: any): any {
    if (!this.config.enabled) {
      return obj;
    }

    if (typeof obj === 'string') {
      return this.maskPII(obj);
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.maskPIIInObject(item));
    }

    if (obj && typeof obj === 'object') {
      const masked: any = {};
      
      for (const [key, value] of Object.entries(obj)) {
        // Mascarar tanto a chave quanto o valor se necessário
        const maskedKey = this.maskPII(key);
        masked[maskedKey] = this.maskPIIInObject(value);
      }
      
      return masked;
    }

    return obj;
  }

  /**
   * Middleware para mascarar PII em logs de requisições
   */
  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!this.config.enabled) {
        return next();
      }

      // Interceptar o método de log para aplicar mascaramento
      const originalSend = res.send;
      const originalJson = res.json;
      
      // Mascarar dados da requisição para logs
      const maskedReqData = {
        ip: req.ip,
        method: req.method,
        path: req.path,
        headers: this.maskPIIInObject(req.headers),
        query: this.maskPIIInObject(req.query),
        body: this.maskPIIInObject(req.body)
      };

      // Adicionar dados mascarados ao request para uso posterior
      (req as any).maskedData = maskedReqData;

      // Interceptar resposta para mascarar dados sensíveis
      res.send = function(body: any) {
        // Log da resposta com dados mascarados
        logger.info('HTTP Response', {
          ...maskedReqData,
          statusCode: res.statusCode,
          responseSize: typeof body === 'string' ? body.length : JSON.stringify(body).length
        });
        
        return originalSend.call(this, body);
      };

      res.json = function(obj: any) {
        // Log da resposta JSON com dados mascarados
        const maskedResponse = this.maskPIIInObject(obj);
        
        logger.info('HTTP JSON Response', {
          ...maskedReqData,
          statusCode: res.statusCode,
          response: maskedResponse
        });
        
        return originalJson.call(this, obj);
      }.bind(this);

      next();
    };
  }

  /**
   * Middleware para audit log com PII mascarado
   */
  auditMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!this.config.enabled) {
        return next();
      }

      const startTime = Date.now();
      
      res.on('finish', () => {
        const duration = Date.now() - startTime;
        
        const auditData = {
          timestamp: new Date().toISOString(),
          ip: req.ip,
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          duration,
          userAgent: this.maskPII(req.get('User-Agent') || ''),
          headers: this.maskPIIInObject(req.headers),
          query: this.maskPIIInObject(req.query),
          body: this.maskPIIInObject(req.body)
        };

        logger.info('Audit Log', auditData);
      });

      next();
    };
  }
}

/**
 * Padrões padrão para PII brasileiro
 */
const DEFAULT_PII_PATTERNS: PIIPattern[] = [
  {
    regex: '(?:\+?55)?\s?\(?\d{2}\)?\s?\d{4,5}-?\d{4}',
    name: 'phone_br',
    replacement: '[PHONE]'
  },
  {
    regex: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}',
    name: 'email',
    replacement: '[EMAIL]'
  },
  {
    regex: '\d{3}\.\d{3}\.\d{3}-\d{2}',
    name: 'cpf',
    replacement: '[CPF]'
  },
  {
    regex: '\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}',
    name: 'cnpj',
    replacement: '[CNPJ]'
  },
  {
    regex: '\d{4}\s?\d{4}\s?\d{4}\s?\d{4}',
    name: 'credit_card',
    replacement: '[CARD]'
  },
  {
    regex: '\d{5}-?\d{3}',
    name: 'cep',
    replacement: '[CEP]'
  }
];

/**
 * Factory function para criar middleware de PII masking
 */
export function createPIIMasking(config: Partial<PIIMaskingConfig> = {}) {
  const defaultConfig: PIIMaskingConfig = {
    enabled: process.env.PII_MASKING_ENABLED !== 'false',
    patterns: DEFAULT_PII_PATTERNS,
    maskChar: '*',
    preserveLength: false,
    logMasking: process.env.NODE_ENV === 'development'
  };

  const finalConfig = { ...defaultConfig, ...config };
  return new PIIMasking(finalConfig);
}

/**
 * Middleware pré-configurado para mascaramento de PII
 */
export const defaultPIIMasking = createPIIMasking();

/**
 * Middleware de request logging com PII mascarado
 */
export const piiSafeRequestLogger = defaultPIIMasking.middleware();

/**
 * Middleware de audit log com PII mascarado
 */
export const piiSafeAuditLogger = defaultPIIMasking.auditMiddleware();

/**
 * Função utilitária para mascarar PII em strings
 */
export function maskPII(text: string, patterns?: PIIPattern[]): string {
  const masking = createPIIMasking({ patterns });
  return masking.maskPII(text);
}

/**
 * Função utilitária para mascarar PII em objetos
 */
export function maskPIIInObject(obj: any, patterns?: PIIPattern[]): any {
  const masking = createPIIMasking({ patterns });
  return masking.maskPIIInObject(obj);
}