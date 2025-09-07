import crypto from 'crypto';
import { redis } from '../db/index';
import logger from './logger';

/**
 * Utility for implementing idempotency with Redis
 * Prevents duplicate operations by using unique keys
 */

export interface IdempotencyConfig {
  /** TTL for idempotency keys in seconds */
  ttl: number;
  /** Key prefix for Redis */
  keyPrefix: string;
  /** Whether to store operation results */
  storeResults: boolean;
}

export const DEFAULT_IDEMPOTENCY_CONFIG: IdempotencyConfig = {
  ttl: 30 * 60, // 30 minutes
  keyPrefix: 'idemp',
  storeResults: true
};

/**
 * Generate idempotency key from operation parameters
 */
export function generateIdempotencyKey(
  operation: string,
  params: Record<string, any>,
  config: Partial<IdempotencyConfig> = {}
): string {
  const cfg = { ...DEFAULT_IDEMPOTENCY_CONFIG, ...config };
  
  // Create deterministic hash from operation and parameters
  const data = JSON.stringify({ operation, params }, Object.keys(params).sort());
  const hash = crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  
  return `${cfg.keyPrefix}:${operation}:${hash}`;
}

/**
 * Generate booking idempotency key according to requirements:
 * Key: idem:{tenant_id}:{sha256(phone|servicoId|date|time)}
 * TTL: 30 minutes
 */
export function generateBookingIdempotencyKey(
  telefone: string,
  servicoId: number,
  dateISO: string,
  timeISO: string,
  tenantId: string = 'default'
): string {
  // Clean phone number (remove non-digits)
  const cleanPhone = telefone.replace(/\D/g, '');
  
  // Create the data string for hashing: phone|servicoId|date|time
  const dataToHash = `${cleanPhone}|${servicoId}|${dateISO}|${timeISO}`;
  
  // Generate SHA256 hash
  const hash = crypto.createHash('sha256').update(dataToHash).digest('hex');
  
  // Return key in required format: idem:{tenant_id}:{sha256}
  return `idem:${tenantId}:${hash}`;
}

/**
 * Check if operation is already in progress or completed
 */
export async function checkIdempotency(
  key: string
): Promise<{ exists: boolean; result?: any; inProgress: boolean }> {
  if (!redis) {
    logger.warn('Redis not available for idempotency check');
    return { exists: false, inProgress: false };
  }
  
  try {
    const value = await redis.get(key);
    
    if (!value) {
      return { exists: false, inProgress: false };
    }
    
    const data = typeof value === 'string' ? JSON.parse(value) : value;
    
    return {
      exists: true,
      result: data.result,
      inProgress: data.status === 'in_progress'
    };
  } catch (error) {
    logger.error('Error checking idempotency:', error);
    return { exists: false, inProgress: false };
  }
}

/**
 * Mark operation as in progress
 */
export async function markInProgress(
  key: string,
  ttl: number = DEFAULT_IDEMPOTENCY_CONFIG.ttl
): Promise<boolean> {
  if (!redis) {
    logger.warn('Redis not available for idempotency marking');
    return false;
  }
  
  try {
    const data = {
      status: 'in_progress',
      startedAt: new Date().toISOString()
    };
    
    // Use SET with NX (only if not exists) to ensure atomicity
    const result = await redis.set(key, JSON.stringify(data), {
      EX: ttl,
      NX: true
    });
    
    return result === 'OK';
  } catch (error) {
    logger.error('Error marking operation in progress:', error);
    return false;
  }
}

/**
 * Mark operation as completed with result
 */
export async function markCompleted(
  key: string,
  result: any,
  ttl: number = DEFAULT_IDEMPOTENCY_CONFIG.ttl
): Promise<void> {
  if (!redis) {
    logger.warn('Redis not available for idempotency completion');
    return;
  }
  
  try {
    const data = {
      status: 'completed',
      result,
      completedAt: new Date().toISOString()
    };
    
    await redis.set(key, JSON.stringify(data), { EX: ttl });
  } catch (error) {
    logger.error('Error marking operation completed:', error);
  }
}

/**
 * Mark operation as failed
 */
export async function markFailed(
  key: string,
  error: any,
  ttl: number = DEFAULT_IDEMPOTENCY_CONFIG.ttl
): Promise<void> {
  if (!redis) {
    logger.warn('Redis not available for idempotency failure marking');
    return;
  }
  
  try {
    const data = {
      status: 'failed',
      error: error.message || String(error),
      failedAt: new Date().toISOString()
    };
    
    await redis.set(key, JSON.stringify(data), { EX: ttl });
  } catch (error) {
    logger.error('Error marking operation failed:', error);
  }
}

/**
 * Remove idempotency key
 */
export async function removeIdempotencyKey(key: string): Promise<void> {
  if (!redis) {
    return;
  }
  
  try {
    await redis.del(key);
  } catch (error) {
    logger.error('Error removing idempotency key:', error);
  }
}

/**
 * Idempotent operation wrapper
 */
export async function withIdempotency<T>(
  key: string,
  operation: () => Promise<T>,
  config: Partial<IdempotencyConfig> = {}
): Promise<T> {
  const cfg = { ...DEFAULT_IDEMPOTENCY_CONFIG, ...config };
  
  // Check if operation already exists
  const check = await checkIdempotency(key);
  
  if (check.exists) {
    if (check.inProgress) {
      throw new Error('Operation already in progress');
    }
    
    if (check.result !== undefined) {
      logger.info(`Returning cached result for idempotency key: ${key}`);
      return check.result;
    }
  }
  
  // Mark as in progress
  const marked = await markInProgress(key, cfg.ttl);
  
  if (!marked) {
    throw new Error('Failed to acquire idempotency lock - operation may already be in progress');
  }
  
  try {
    // Execute operation
    const result = await operation();
    
    // Mark as completed
    if (cfg.storeResults) {
      await markCompleted(key, result, cfg.ttl);
    } else {
      await removeIdempotencyKey(key);
    }
    
    return result;
  } catch (error) {
    // Mark as failed
    await markFailed(key, error, Math.min(cfg.ttl, 5 * 60)); // Shorter TTL for failures
    throw error;
  }
}

/**
 * Idempotency decorator for class methods
 */
export function idempotent(
  keyGenerator: (...args: any[]) => string,
  config: Partial<IdempotencyConfig> = {}
) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function (...args: any[]) {
      const key = keyGenerator(...args);
      return withIdempotency(
        key,
        () => originalMethod.apply(this, args),
        config
      );
    };
    
    return descriptor;
  };
}

/**
 * Utility class for managing idempotency operations
 */
export class IdempotencyManager {
  constructor(private config: IdempotencyConfig = DEFAULT_IDEMPOTENCY_CONFIG) {}
  
  /**
   * Execute operation with idempotency
   */
  async execute<T>(
    operation: string,
    params: Record<string, any>,
    fn: () => Promise<T>
  ): Promise<T> {
    const key = generateIdempotencyKey(operation, params, this.config);
    return withIdempotency(key, fn, this.config);
  }
  
  /**
   * Check if operation exists
   */
  async exists(operation: string, params: Record<string, any>): Promise<boolean> {
    const key = generateIdempotencyKey(operation, params, this.config);
    const check = await checkIdempotency(key);
    return check.exists;
  }
  
  /**
   * Get operation status
   */
  async getStatus(
    operation: string,
    params: Record<string, any>
  ): Promise<'not_found' | 'in_progress' | 'completed' | 'failed'> {
    const key = generateIdempotencyKey(operation, params, this.config);
    const check = await checkIdempotency(key);
    
    if (!check.exists) {
      return 'not_found';
    }
    
    if (check.inProgress) {
      return 'in_progress';
    }
    
    // Parse stored data to determine status
    try {
      if (!redis) return 'not_found';
      
      const value = await redis.get(key);
      if (!value) return 'not_found';
      
      const data = typeof value === 'string' ? JSON.parse(value) : value;
      return data.status || 'completed';
    } catch {
      return 'completed';
    }
  }
  
  /**
   * Clear operation
   */
  async clear(operation: string, params: Record<string, any>): Promise<void> {
    const key = generateIdempotencyKey(operation, params, this.config);
    await removeIdempotencyKey(key);
  }
  
  /**
   * Get statistics
   */
  async getStats(): Promise<{ totalKeys: number; inProgressCount: number }> {
    if (!redis) {
      return { totalKeys: 0, inProgressCount: 0 };
    }
    
    try {
      const pattern = `${this.config.keyPrefix}:*`;
      const keys = await redis.keys(pattern);
      
      let inProgressCount = 0;
      
      for (const key of keys) {
        try {
          const value = await redis.get(key);
          if (value) {
            const data = typeof value === 'string' ? JSON.parse(value) : value;
            if (data.status === 'in_progress') {
              inProgressCount++;
            }
          }
        } catch {
          // Ignore parsing errors
        }
      }
      
      return {
        totalKeys: keys.length,
        inProgressCount
      };
    } catch (error) {
      logger.error('Error getting idempotency stats:', error);
      return { totalKeys: 0, inProgressCount: 0 };
    }
  }
}

// Global idempotency manager
export const globalIdempotencyManager = new IdempotencyManager();