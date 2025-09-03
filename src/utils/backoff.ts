/**
 * Utility functions for implementing exponential backoff with jitter
 * for resilient API client implementations
 */

export interface BackoffConfig {
  /** Base delay in milliseconds */
  baseDelay: number;
  /** Maximum delay in milliseconds */
  maxDelay: number;
  /** Multiplier for exponential backoff */
  multiplier: number;
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Whether to add jitter to prevent thundering herd */
  jitter: boolean;
}

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseDelay: 1000, // 1 second
  maxDelay: 30000, // 30 seconds
  multiplier: 2,
  maxRetries: 3,
  jitter: true
};

/**
 * Calculate delay for exponential backoff with optional jitter
 */
export function calculateBackoffDelay(
  attempt: number,
  config: Partial<BackoffConfig> = {}
): number {
  const cfg = { ...DEFAULT_BACKOFF_CONFIG, ...config };
  
  // Calculate exponential delay
  const exponentialDelay = cfg.baseDelay * Math.pow(cfg.multiplier, attempt - 1);
  
  // Cap at maximum delay
  const cappedDelay = Math.min(exponentialDelay, cfg.maxDelay);
  
  // Add jitter if enabled (±25% random variation)
  if (cfg.jitter) {
    const jitterRange = cappedDelay * 0.25;
    const jitter = (Math.random() - 0.5) * 2 * jitterRange;
    return Math.max(0, cappedDelay + jitter);
  }
  
  return cappedDelay;
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: any): boolean {
  // Network errors
  if (error.code === 'ECONNRESET' || 
      error.code === 'ENOTFOUND' || 
      error.code === 'ECONNREFUSED' ||
      error.code === 'ETIMEDOUT') {
    return true;
  }
  
  // HTTP status codes that should be retried
  if (error.response?.status) {
    const status = error.response.status;
    return status === 429 || // Rate limited
           status === 502 || // Bad Gateway
           status === 503 || // Service Unavailable
           status === 504;   // Gateway Timeout
  }
  
  return false;
}

/**
 * Check if an HTTP method is idempotent (safe to retry)
 */
export function isIdempotentMethod(method: string): boolean {
  const idempotentMethods = ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'];
  return idempotentMethods.includes(method.toUpperCase());
}

/**
 * Retry function with exponential backoff
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  config: Partial<BackoffConfig> = {},
  isRetryable: (error: any) => boolean = isRetryableError
): Promise<T> {
  const cfg = { ...DEFAULT_BACKOFF_CONFIG, ...config };
  let lastError: any;
  
  for (let attempt = 1; attempt <= cfg.maxRetries + 1; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      
      // Don't retry on last attempt or if error is not retryable
      if (attempt > cfg.maxRetries || !isRetryable(error)) {
        throw error;
      }
      
      const delay = calculateBackoffDelay(attempt, cfg);
      await sleep(delay);
    }
  }
  
  throw lastError;
}

/**
 * Create a retry decorator for class methods
 */
export function withRetry<T extends any[], R>(
  config: Partial<BackoffConfig> = {},
  isRetryable: (error: any) => boolean = isRetryableError
) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function (...args: T): Promise<R> {
      return retryWithBackoff(
        () => originalMethod.apply(this, args),
        config,
        isRetryable
      );
    };
    
    return descriptor;
  };
}

/**
 * Utility class for managing retry state and metrics
 */
export class RetryManager {
  private attempts: Map<string, number> = new Map();
  private lastAttemptTime: Map<string, number> = new Map();
  
  constructor(private config: BackoffConfig = DEFAULT_BACKOFF_CONFIG) {}
  
  /**
   * Get current attempt count for an operation
   */
  getAttemptCount(operationId: string): number {
    return this.attempts.get(operationId) || 0;
  }
  
  /**
   * Record a retry attempt
   */
  recordAttempt(operationId: string): number {
    const current = this.getAttemptCount(operationId);
    const newCount = current + 1;
    this.attempts.set(operationId, newCount);
    this.lastAttemptTime.set(operationId, Date.now());
    return newCount;
  }
  
  /**
   * Reset retry state for an operation
   */
  reset(operationId: string): void {
    this.attempts.delete(operationId);
    this.lastAttemptTime.delete(operationId);
  }
  
  /**
   * Check if operation should be retried
   */
  shouldRetry(operationId: string, error: any): boolean {
    const attemptCount = this.getAttemptCount(operationId);
    return attemptCount < this.config.maxRetries && isRetryableError(error);
  }
  
  /**
   * Calculate delay for next retry
   */
  getNextDelay(operationId: string): number {
    const attemptCount = this.getAttemptCount(operationId);
    return calculateBackoffDelay(attemptCount + 1, this.config);
  }
  
  /**
   * Get retry statistics
   */
  getStats(): { totalOperations: number; activeRetries: number } {
    return {
      totalOperations: this.attempts.size,
      activeRetries: Array.from(this.attempts.values()).filter(count => count > 1).length
    };
  }
  
  /**
   * Clean up old retry states (older than 1 hour)
   */
  cleanup(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    
    for (const [operationId, lastTime] of this.lastAttemptTime.entries()) {
      if (lastTime < oneHourAgo) {
        this.reset(operationId);
      }
    }
  }
}

// Global retry manager instance
export const globalRetryManager = new RetryManager();

// Clean up old retry states every 30 minutes
setInterval(() => {
  globalRetryManager.cleanup();
}, 30 * 60 * 1000);