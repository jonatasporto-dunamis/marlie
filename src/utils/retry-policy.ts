import { logger } from './logger';

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterMaxMs: number;
  retryableErrors?: string[];
  nonRetryableErrors?: string[];
}

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  attempts: number;
  totalDurationMs: number;
}

export interface RetryAttempt {
  attemptNumber: number;
  delayMs: number;
  error?: Error;
  timestamp: Date;
}

/**
 * Configurações predefinidas de retry
 */
export const RETRY_CONFIGS = {
  // Para chamadas de API externas (Trinks, Evolution)
  network: {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
    jitterMaxMs: 500,
    retryableErrors: [
      'ECONNRESET',
      'ENOTFOUND',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'NETWORK_ERROR',
      'TIMEOUT_ERROR'
    ],
    nonRetryableErrors: [
      'UNAUTHORIZED',
      'FORBIDDEN',
      'BAD_REQUEST',
      'NOT_FOUND'
    ]
  } as RetryConfig,

  // Para operações de banco de dados
  database: {
    maxAttempts: 2,
    baseDelayMs: 500,
    maxDelayMs: 2000,
    backoffMultiplier: 2,
    jitterMaxMs: 200,
    retryableErrors: [
      'ECONNRESET',
      'CONNECTION_ERROR',
      'DEADLOCK_DETECTED'
    ],
    nonRetryableErrors: [
      'SYNTAX_ERROR',
      'CONSTRAINT_VIOLATION',
      'PERMISSION_DENIED'
    ]
  } as RetryConfig,

  // Para operações críticas (menor tolerância)
  critical: {
    maxAttempts: 5,
    baseDelayMs: 2000,
    maxDelayMs: 30000,
    backoffMultiplier: 1.5,
    jitterMaxMs: 1000,
    retryableErrors: [],
    nonRetryableErrors: []
  } as RetryConfig,

  // Para operações rápidas (menor delay)
  fast: {
    maxAttempts: 2,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    backoffMultiplier: 3,
    jitterMaxMs: 50,
    retryableErrors: [],
    nonRetryableErrors: []
  } as RetryConfig
};

/**
 * Classe principal para implementação de retry policy
 */
export class RetryPolicy {
  private config: RetryConfig;
  private attempts: RetryAttempt[] = [];

  constructor(config: RetryConfig) {
    this.config = { ...config };
  }

  /**
   * Executa uma função com retry policy
   */
  async execute<T>(
    operation: () => Promise<T>,
    context?: { operationName?: string; metadata?: any }
  ): Promise<RetryResult<T>> {
    const startTime = Date.now();
    this.attempts = [];
    
    const operationName = context?.operationName || 'unknown';
    const metadata = context?.metadata || {};

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      const attemptStart = Date.now();
      
      try {
        logger.debug('Executando operação', {
          operationName,
          attempt,
          maxAttempts: this.config.maxAttempts,
          metadata
        });

        const result = await operation();
        
        const totalDuration = Date.now() - startTime;
        
        logger.info('Operação executada com sucesso', {
          operationName,
          attempt,
          totalDurationMs: totalDuration,
          metadata
        });

        return {
          success: true,
          result,
          attempts: attempt,
          totalDurationMs: totalDuration
        };
      } catch (error) {
        const attemptDuration = Date.now() - attemptStart;
        
        const retryAttempt: RetryAttempt = {
          attemptNumber: attempt,
          delayMs: 0,
          error: error as Error,
          timestamp: new Date()
        };
        
        this.attempts.push(retryAttempt);
        
        logger.warn('Falha na operação', {
          operationName,
          attempt,
          maxAttempts: this.config.maxAttempts,
          error: (error as Error).message,
          attemptDurationMs: attemptDuration,
          metadata
        });

        // Verificar se deve tentar novamente
        if (attempt >= this.config.maxAttempts || !this.shouldRetry(error as Error)) {
          const totalDuration = Date.now() - startTime;
          
          logger.error('Operação falhou definitivamente', {
            operationName,
            totalAttempts: attempt,
            totalDurationMs: totalDuration,
            finalError: (error as Error).message,
            metadata
          });

          return {
            success: false,
            error: error as Error,
            attempts: attempt,
            totalDurationMs: totalDuration
          };
        }

        // Calcular delay para próxima tentativa
        const delay = this.calculateDelay(attempt);
        retryAttempt.delayMs = delay;
        
        logger.info('Aguardando para próxima tentativa', {
          operationName,
          attempt,
          delayMs: delay,
          metadata
        });

        await this.sleep(delay);
      }
    }

    // Este ponto nunca deveria ser alcançado
    throw new Error('Retry policy: estado inconsistente');
  }

  /**
   * Verifica se um erro é elegível para retry
   */
  private shouldRetry(error: Error): boolean {
    const errorMessage = error.message;
    const errorCode = (error as any).code;
    const errorType = (error as any).type;
    
    // Verificar erros não-retryable primeiro
    if (this.config.nonRetryableErrors) {
      for (const nonRetryable of this.config.nonRetryableErrors) {
        if (
          errorMessage.includes(nonRetryable) ||
          errorCode === nonRetryable ||
          errorType === nonRetryable
        ) {
          return false;
        }
      }
    }
    
    // Se não há lista de erros retryable, assumir que todos são retryable
    if (!this.config.retryableErrors || this.config.retryableErrors.length === 0) {
      return true;
    }
    
    // Verificar se está na lista de erros retryable
    for (const retryable of this.config.retryableErrors) {
      if (
        errorMessage.includes(retryable) ||
        errorCode === retryable ||
        errorType === retryable
      ) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Calcula delay com backoff exponencial e jitter
   */
  private calculateDelay(attempt: number): number {
    // Backoff exponencial
    const exponentialDelay = this.config.baseDelayMs * Math.pow(this.config.backoffMultiplier, attempt - 1);
    
    // Aplicar limite máximo
    const cappedDelay = Math.min(exponentialDelay, this.config.maxDelayMs);
    
    // Adicionar jitter aleatório
    const jitter = Math.random() * this.config.jitterMaxMs;
    
    return Math.floor(cappedDelay + jitter);
  }

  /**
   * Sleep assíncrono
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Obtém histórico de tentativas
   */
  getAttempts(): RetryAttempt[] {
    return [...this.attempts];
  }

  /**
   * Obtém configuração atual
   */
  getConfig(): RetryConfig {
    return { ...this.config };
  }
}

/**
 * Função utilitária para executar operação com retry usando configuração predefinida
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  configName: keyof typeof RETRY_CONFIGS = 'network',
  context?: { operationName?: string; metadata?: any }
): Promise<RetryResult<T>> {
  const policy = new RetryPolicy(RETRY_CONFIGS[configName]);
  return policy.execute(operation, context);
}

/**
 * Função utilitária para executar operação com retry usando configuração customizada
 */
export async function withCustomRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig,
  context?: { operationName?: string; metadata?: any }
): Promise<RetryResult<T>> {
  const policy = new RetryPolicy(config);
  return policy.execute(operation, context);
}

/**
 * Decorator para métodos que precisam de retry
 */
export function retryable(
  configName: keyof typeof RETRY_CONFIGS = 'network',
  operationName?: string
) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function (...args: any[]) {
      const context = {
        operationName: operationName || `${target.constructor.name}.${propertyKey}`,
        metadata: { args: args.length }
      };
      
      const result = await withRetry(
        () => originalMethod.apply(this, args),
        configName,
        context
      );
      
      if (!result.success) {
        throw result.error;
      }
      
      return result.result;
    };
    
    return descriptor;
  };
}

/**
 * Classe para métricas de retry
 */
export class RetryMetrics {
  private static metrics = new Map<string, {
    totalAttempts: number;
    successfulOperations: number;
    failedOperations: number;
    totalRetries: number;
    averageAttempts: number;
    lastUpdated: Date;
  }>();

  static recordOperation(
    operationName: string,
    result: RetryResult<any>
  ): void {
    const current = this.metrics.get(operationName) || {
      totalAttempts: 0,
      successfulOperations: 0,
      failedOperations: 0,
      totalRetries: 0,
      averageAttempts: 0,
      lastUpdated: new Date()
    };

    current.totalAttempts += result.attempts;
    current.totalRetries += (result.attempts - 1);
    
    if (result.success) {
      current.successfulOperations++;
    } else {
      current.failedOperations++;
    }
    
    const totalOperations = current.successfulOperations + current.failedOperations;
    current.averageAttempts = current.totalAttempts / totalOperations;
    current.lastUpdated = new Date();
    
    this.metrics.set(operationName, current);
  }

  static getMetrics(operationName?: string) {
    if (operationName) {
      return this.metrics.get(operationName);
    }
    return Object.fromEntries(this.metrics);
  }

  static clearMetrics(): void {
    this.metrics.clear();
  }
}

/**
 * Função para criar retry policy personalizada baseada em contexto
 */
export function createContextualRetryPolicy(
  baseConfig: keyof typeof RETRY_CONFIGS,
  overrides: Partial<RetryConfig>
): RetryPolicy {
  const config = {
    ...RETRY_CONFIGS[baseConfig],
    ...overrides
  };
  
  return new RetryPolicy(config);
}