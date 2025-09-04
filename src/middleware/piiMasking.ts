import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

/**
 * Configurações de mascaramento de PII
 */
export interface PIIMaskingConfig {
  maskPhone?: boolean;
  maskEmail?: boolean;
  maskCPF?: boolean;
  maskCNPJ?: boolean;
  maskCreditCard?: boolean;
  customPatterns?: Array<{
    pattern: RegExp;
    replacement: string;
    description: string;
  }>;
}

/**
 * Configuração padrão de mascaramento
 */
const DEFAULT_CONFIG: PIIMaskingConfig = {
  maskPhone: true,
  maskEmail: true,
  maskCPF: true,
  maskCNPJ: true,
  maskCreditCard: true,
  customPatterns: []
};

/**
 * Padrões regex para identificar PII
 */
const PII_PATTERNS = {
  // Telefones brasileiros: +5511999887766 -> +55*********66
  PHONE_BR: {
    pattern: /\+55\d{2}\d{8,9}/g,
    replacement: (match: string) => {
      const prefix = match.substring(0, 3); // +55
      const suffix = match.substring(match.length - 2); // últimos 2 dígitos
      const stars = '*'.repeat(match.length - 5);
      return `${prefix}${stars}${suffix}`;
    },
    description: 'Brazilian phone number'
  },
  
  // Telefones internacionais: +1234567890 -> +12*******90
  PHONE_INTL: {
    pattern: /\+\d{10,15}/g,
    replacement: (match: string) => {
      const prefix = match.substring(0, 3);
      const suffix = match.substring(match.length - 2);
      const stars = '*'.repeat(match.length - 5);
      return `${prefix}${stars}${suffix}`;
    },
    description: 'International phone number'
  },
  
  // Telefones sem código de país: 11999887766 -> 11*******66
  PHONE_LOCAL: {
    pattern: /\b\d{10,11}\b/g,
    replacement: (match: string) => {
      if (match.length < 10) return match;
      const prefix = match.substring(0, 2);
      const suffix = match.substring(match.length - 2);
      const stars = '*'.repeat(match.length - 4);
      return `${prefix}${stars}${suffix}`;
    },
    description: 'Local phone number'
  },
  
  // Email: user@domain.com -> u***@d*****.com
  EMAIL: {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    replacement: (match: string) => {
      const [user, domain] = match.split('@');
      const [domainName, ...domainParts] = domain.split('.');
      
      const maskedUser = user.length > 1 ? 
        user[0] + '*'.repeat(Math.max(1, user.length - 1)) : 
        user;
      
      const maskedDomain = domainName.length > 1 ? 
        domainName[0] + '*'.repeat(Math.max(1, domainName.length - 1)) : 
        domainName;
      
      return `${maskedUser}@${maskedDomain}.${domainParts.join('.')}`;
    },
    description: 'Email address'
  },
  
  // CPF: 123.456.789-01 -> 123.***.***-01
  CPF: {
    pattern: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g,
    replacement: (match: string) => {
      return match.replace(/(\d{3}\.)\d{3}\.\d{3}(-\d{2})/, '$1***.***$2');
    },
    description: 'Brazilian CPF'
  },
  
  // CPF sem formatação: 12345678901 -> 123***901
  CPF_UNFORMATTED: {
    pattern: /\b\d{11}\b/g,
    replacement: (match: string) => {
      return match.substring(0, 3) + '***' + match.substring(8);
    },
    description: 'Brazilian CPF (unformatted)'
  },
  
  // CNPJ: 12.345.678/0001-90 -> 12.***.***/**01-90
  CNPJ: {
    pattern: /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g,
    replacement: (match: string) => {
      return match.replace(/(\d{2}\.)\d{3}\.\d{3}(\/)\d{2}(\d{2}-\d{2})/, '$1***.***$2**$3');
    },
    description: 'Brazilian CNPJ'
  },
  
  // Cartão de crédito: 1234 5678 9012 3456 -> 1234 **** **** 3456
  CREDIT_CARD: {
    pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    replacement: (match: string) => {
      const cleaned = match.replace(/[\s-]/g, '');
      const first4 = cleaned.substring(0, 4);
      const last4 = cleaned.substring(12);
      const separator = match.includes(' ') ? ' ' : match.includes('-') ? '-' : '';
      
      if (separator) {
        return `${first4}${separator}****${separator}****${separator}${last4}`;
      }
      return `${first4}********${last4}`;
    },
    description: 'Credit card number'
  }
};

/**
 * Mascarar PII em uma string
 */
export function maskPII(text: string, config: PIIMaskingConfig = DEFAULT_CONFIG): string {
  if (!text || typeof text !== 'string') {
    return text;
  }
  
  let maskedText = text;
  
  // Aplicar padrões padrão
  if (config.maskPhone) {
    maskedText = maskedText.replace(PII_PATTERNS.PHONE_BR.pattern, PII_PATTERNS.PHONE_BR.replacement);
    maskedText = maskedText.replace(PII_PATTERNS.PHONE_INTL.pattern, PII_PATTERNS.PHONE_INTL.replacement);
    maskedText = maskedText.replace(PII_PATTERNS.PHONE_LOCAL.pattern, PII_PATTERNS.PHONE_LOCAL.replacement);
  }
  
  if (config.maskEmail) {
    maskedText = maskedText.replace(PII_PATTERNS.EMAIL.pattern, PII_PATTERNS.EMAIL.replacement);
  }
  
  if (config.maskCPF) {
    maskedText = maskedText.replace(PII_PATTERNS.CPF.pattern, PII_PATTERNS.CPF.replacement);
    maskedText = maskedText.replace(PII_PATTERNS.CPF_UNFORMATTED.pattern, PII_PATTERNS.CPF_UNFORMATTED.replacement);
  }
  
  if (config.maskCNPJ) {
    maskedText = maskedText.replace(PII_PATTERNS.CNPJ.pattern, PII_PATTERNS.CNPJ.replacement);
  }
  
  if (config.maskCreditCard) {
    maskedText = maskedText.replace(PII_PATTERNS.CREDIT_CARD.pattern, PII_PATTERNS.CREDIT_CARD.replacement);
  }
  
  // Aplicar padrões customizados
  if (config.customPatterns) {
    for (const customPattern of config.customPatterns) {
      maskedText = maskedText.replace(customPattern.pattern, customPattern.replacement);
    }
  }
  
  return maskedText;
}

/**
 * Mascarar PII em objetos recursivamente
 */
export function maskPIIInObject(obj: any, config: PIIMaskingConfig = DEFAULT_CONFIG): any {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (typeof obj === 'string') {
    return maskPII(obj, config);
  }
  
  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => maskPIIInObject(item, config));
  }
  
  if (typeof obj === 'object') {
    const maskedObj: any = {};
    
    for (const [key, value] of Object.entries(obj)) {
      // Campos sensíveis que devem ser completamente mascarados
      const sensitiveFields = [
        'password', 'token', 'secret', 'key', 'authorization',
        'x-admin-token', 'x-webhook-token', 'x-api-key'
      ];
      
      if (sensitiveFields.includes(key.toLowerCase())) {
        maskedObj[key] = '[REDACTED]';
      } else {
        maskedObj[key] = maskPIIInObject(value, config);
      }
    }
    
    return maskedObj;
  }
  
  return obj;
}

/**
 * Middleware para mascarar PII em logs de requisições
 */
export function createPIIMaskingMiddleware(config: PIIMaskingConfig = DEFAULT_CONFIG) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Interceptar o método de log original
    const originalSend = res.send;
    const originalJson = res.json;
    
    // Mascarar dados da requisição para logs
    const maskedReqData = {
      method: req.method,
      url: maskPII(req.url, config),
      headers: maskPIIInObject(req.headers, config),
      body: maskPIIInObject(req.body, config),
      query: maskPIIInObject(req.query, config),
      params: maskPIIInObject(req.params, config)
    };
    
    // Adicionar dados mascarados ao objeto de requisição
    (req as any).maskedData = maskedReqData;
    
    // Interceptar resposta para mascarar dados sensíveis
    res.send = function(body: any) {
      // Log da resposta com dados mascarados
      if (process.env.NODE_ENV !== 'production' || process.env.LOG_RESPONSES === 'true') {
        const maskedResponse = maskPIIInObject(body, config);
        logger.debug('Response sent', {
          statusCode: res.statusCode,
          body: maskedResponse
        });
      }
      
      return originalSend.call(this, body);
    };
    
    res.json = function(obj: any) {
      // Log da resposta JSON com dados mascarados
      if (process.env.NODE_ENV !== 'production' || process.env.LOG_RESPONSES === 'true') {
        const maskedResponse = maskPIIInObject(obj, config);
        logger.debug('JSON response sent', {
          statusCode: res.statusCode,
          body: maskedResponse
        });
      }
      
      return originalJson.call(this, obj);
    };
    
    next();
  };
}

/**
 * Middleware para log de requisições com PII mascarado
 */
export function createMaskedRequestLogger(config: PIIMaskingConfig = DEFAULT_CONFIG) {
  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    
    // Log da requisição com dados mascarados
    const maskedReqData = {
      method: req.method,
      url: maskPII(req.url, config),
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      headers: maskPIIInObject(req.headers, config),
      body: req.method !== 'GET' ? maskPIIInObject(req.body, config) : undefined,
      query: Object.keys(req.query).length > 0 ? maskPIIInObject(req.query, config) : undefined
    };
    
    logger.info('Request received', maskedReqData);
    
    // Interceptar o fim da resposta
    const originalEnd = res.end;
    res.end = function(chunk?: any, encoding?: any) {
      const duration = Date.now() - startTime;
      
      logger.info('Request completed', {
        method: req.method,
        url: maskPII(req.url, config),
        statusCode: res.statusCode,
        duration: `${duration}ms`,
        contentLength: res.get('Content-Length')
      });
      
      return originalEnd.call(this, chunk, encoding);
    };
    
    next();
  };
}

/**
 * Utilitário para testar padrões de mascaramento
 */
export function testPIIMasking(testCases: string[], config: PIIMaskingConfig = DEFAULT_CONFIG): Array<{ original: string; masked: string; detected: string[] }> {
  return testCases.map(testCase => {
    const masked = maskPII(testCase, config);
    const detected: string[] = [];
    
    // Verificar quais padrões foram detectados
    Object.entries(PII_PATTERNS).forEach(([key, pattern]) => {
      if (pattern.pattern.test(testCase)) {
        detected.push(pattern.description);
      }
    });
    
    return {
      original: testCase,
      masked,
      detected
    };
  });
}

/**
 * Configuração específica para logs de produção
 */
export const PRODUCTION_PII_CONFIG: PIIMaskingConfig = {
  ...DEFAULT_CONFIG,
  customPatterns: [
    {
      pattern: /\b[A-Z0-9]{20,}\b/g, // Tokens longos
      replacement: '[TOKEN]',
      description: 'Long token or key'
    },
    {
      pattern: /\b\d{13,19}\b/g, // Números longos (possíveis cartões)
      replacement: (match: string) => `${match.substring(0, 4)}${'*'.repeat(match.length - 8)}${match.substring(match.length - 4)}`,
      description: 'Long number sequence'
    }
  ]
};

/**
 * Configuração para desenvolvimento (menos restritiva)
 */
export const DEVELOPMENT_PII_CONFIG: PIIMaskingConfig = {
  maskPhone: true,
  maskEmail: false, // Permitir emails em dev
  maskCPF: true,
  maskCNPJ: true,
  maskCreditCard: true,
  customPatterns: []
};