import * as winston from 'winston';

/**
 * Mask PII (Personally Identifiable Information) in log messages
 */
function maskPII(obj: any): any {
  if (!process.env.MASK_PII_IN_LOGS || process.env.MASK_PII_IN_LOGS === 'false') {
    return obj;
  }

  if (typeof obj === 'string') {
    return obj
      // Mask phone numbers (Brazilian format)
      .replace(/\b55\d{10,11}\b/g, (match) => {
        const start = match.slice(0, 3);
        const end = match.slice(-3);
        const middle = '*'.repeat(match.length - 6);
        return `${start}${middle}${end}`;
      })
      // Mask email addresses
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, (match) => {
        const [local, domain] = match.split('@');
        const maskedLocal = local.length > 2 ? local[0] + '*'.repeat(local.length - 2) + local[local.length - 1] : local;
        return `${maskedLocal}@${domain}`;
      })
      // Mask CPF (Brazilian tax ID)
      .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '***.***.***-**')
      // Mask credit card numbers
      .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '**** **** **** ****');
  }

  if (Array.isArray(obj)) {
    return obj.map(maskPII);
  }

  if (obj && typeof obj === 'object') {
    const masked: any = {};
    for (const [key, value] of Object.entries(obj)) {
      // Mask specific fields that commonly contain PII
      if (['phone', 'phoneE164', 'phone_e164', 'email', 'cpf', 'document', 'remoteJid'].includes(key.toLowerCase())) {
        if (typeof value === 'string') {
          if (key.toLowerCase().includes('phone')) {
            // Mask phone numbers
            masked[key] = value.length > 6 ? 
              value.slice(0, 3) + '*'.repeat(value.length - 6) + value.slice(-3) : 
              value;
          } else if (key.toLowerCase().includes('email')) {
            // Mask email
            const [local, domain] = value.split('@');
            if (domain) {
              const maskedLocal = local.length > 2 ? local[0] + '*'.repeat(local.length - 2) + local[local.length - 1] : local;
              masked[key] = `${maskedLocal}@${domain}`;
            } else {
              masked[key] = value;
            }
          } else {
            // Generic masking for other PII fields
            masked[key] = value.length > 4 ? 
              value.slice(0, 2) + '*'.repeat(value.length - 4) + value.slice(-2) : 
              '****';
          }
        } else {
          masked[key] = value;
        }
      } else {
        masked[key] = maskPII(value);
      }
    }
    return masked;
  }

  return obj;
}

/**
 * Custom format to mask PII in logs
 */
const piiMaskingFormat = winston.format((info) => {
  return {
    ...info,
    message: typeof info.message === 'string' ? maskPII(info.message) : info.message,
    ...maskPII(info)
  };
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    piiMaskingFormat(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
    new winston.transports.File({ 
      filename: 'logs/error.log', 
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: 'logs/combined.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
  ],
});

// Add request ID to logs in development
if (process.env.NODE_ENV === 'development') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
        return `${timestamp} [${level}]: ${message} ${metaStr}`;
      })
    )
  }));
}

export { logger };
export default logger;