import { Pool } from 'pg';
import { redis } from '../db/index';
import axios from 'axios';
import logger from '../utils/logger';

export interface HealthCheckResult {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  duration_ms: number;
  details?: any;
  error?: string;
}

export interface SystemHealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  checks: {
    database: HealthCheckResult;
    redis: HealthCheckResult;
    evolution: HealthCheckResult;
    trinks: HealthCheckResult;
  };
  overall_duration_ms: number;
}

/**
 * Database health check
 */
export async function checkDatabase(): Promise<HealthCheckResult> {
  const startTime = Date.now();
  
  try {
    // Simple query to check database connectivity
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1, // Only one connection for health check
      connectionTimeoutMillis: 5000,
    });
    
    const client = await pool.connect();
    const result = await client.query('SELECT 1 as health_check');
    client.release();
    await pool.end();
    
    const duration = Date.now() - startTime;
    
    if (result.rows[0]?.health_check === 1) {
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        duration_ms: duration,
        details: {
          query_result: result.rows[0],
          connection_time_ms: duration
        }
      };
    } else {
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        duration_ms: duration,
        error: 'Unexpected query result'
      };
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Database health check failed:', error);
    
    return {
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      duration_ms: duration,
      error: error instanceof Error ? error.message : 'Unknown database error'
    };
  }
}

/**
 * Redis health check
 */
export async function checkRedis(): Promise<HealthCheckResult> {
  const startTime = Date.now();
  
  try {
    if (!redis) {
      throw new Error('Redis client not initialized');
    }
    
    // Test Redis connectivity with ping
    const pingResult = await redis.ping();
    
    if (pingResult === 'PONG') {
      // Test set/get operation
      const testKey = `health_check:${Date.now()}`;
      const testValue = 'health_test';
      
      await redis!.setEx(testKey, 10, testValue); // 10 seconds TTL
      const retrievedValue = await redis!.get(testKey);
      await redis!.del(testKey); // Cleanup
      
      const duration = Date.now() - startTime;
      
      if (retrievedValue === testValue) {
        return {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          duration_ms: duration,
          details: {
            ping_result: pingResult,
            set_get_test: 'passed'
          }
        };
      } else {
        return {
          status: 'degraded',
          timestamp: new Date().toISOString(),
          duration_ms: duration,
          error: 'Set/Get operation failed'
        };
      }
    } else {
      const duration = Date.now() - startTime;
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        duration_ms: duration,
        error: `Unexpected ping result: ${pingResult}`
      };
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Redis health check failed:', error);
    
    return {
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      duration_ms: duration,
      error: error instanceof Error ? error.message : 'Unknown Redis error'
    };
  }
}

/**
 * Evolution API health check
 */
export async function checkEvolution(): Promise<HealthCheckResult> {
  const startTime = Date.now();
  
  try {
    const evolutionBaseUrl = process.env.EVOLUTION_BASE_URL;
    const evolutionApiKey = process.env.EVOLUTION_API_KEY;
    
    if (!evolutionBaseUrl) {
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        error: 'EVOLUTION_BASE_URL not configured'
      };
    }
    
    // Simple health check endpoint or instance status
    const response = await axios.get(`${evolutionBaseUrl}/manager/health`, {
      timeout: 5000,
      headers: evolutionApiKey ? {
        'apikey': evolutionApiKey
      } : {},
      validateStatus: (status) => status < 500 // Accept 4xx as potentially healthy
    });
    
    const duration = Date.now() - startTime;
    
    if (response.status >= 200 && response.status < 300) {
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        duration_ms: duration,
        details: {
          status_code: response.status,
          response_time_ms: duration
        }
      };
    } else if (response.status >= 400 && response.status < 500) {
      return {
        status: 'degraded',
        timestamp: new Date().toISOString(),
        duration_ms: duration,
        details: {
          status_code: response.status,
          message: 'API accessible but returned client error'
        }
      };
    } else {
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        duration_ms: duration,
        error: `HTTP ${response.status}: ${response.statusText}`
      };
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Evolution API health check failed:', error);
    
    return {
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      duration_ms: duration,
      error: error instanceof Error ? error.message : 'Unknown Evolution API error'
    };
  }
}

/**
 * Trinks API health check
 */
export async function checkTrinks(): Promise<HealthCheckResult> {
  const startTime = Date.now();
  
  try {
    const trinksBaseUrl = process.env.TRINKS_BASE_URL;
    const trinksApiKey = process.env.TRINKS_API_KEY;
    const trinksEstabelecimentoId = process.env.TRINKS_ESTABELECIMENTO_ID;
    
    if (!trinksBaseUrl || !trinksApiKey || !trinksEstabelecimentoId) {
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        error: 'Trinks API credentials not configured'
      };
    }
    
    // Simple API call to check connectivity
    const response = await axios.get(`${trinksBaseUrl}/v1/servicos`, {
      timeout: 5000,
      params: { limit: 1 }, // Minimal data request
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': trinksApiKey,
        'estabelecimentoId': trinksEstabelecimentoId,
      },
      validateStatus: (status) => status < 500
    });
    
    const duration = Date.now() - startTime;
    
    if (response.status >= 200 && response.status < 300) {
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        duration_ms: duration,
        details: {
          status_code: response.status,
          response_time_ms: duration,
          api_accessible: true
        }
      };
    } else if (response.status === 429) {
      return {
        status: 'degraded',
        timestamp: new Date().toISOString(),
        duration_ms: duration,
        details: {
          status_code: response.status,
          message: 'API rate limited but accessible'
        }
      };
    } else if (response.status >= 400 && response.status < 500) {
      return {
        status: 'degraded',
        timestamp: new Date().toISOString(),
        duration_ms: duration,
        details: {
          status_code: response.status,
          message: 'API accessible but returned client error'
        }
      };
    } else {
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        duration_ms: duration,
        error: `HTTP ${response.status}: ${response.statusText}`
      };
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Trinks API health check failed:', error);
    
    return {
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      duration_ms: duration,
      error: error instanceof Error ? error.message : 'Unknown Trinks API error'
    };
  }
}

/**
 * Perform all health checks
 */
export async function performHealthChecks(): Promise<SystemHealthStatus> {
  const startTime = Date.now();
  
  try {
    // Run all checks in parallel for faster response
    const [database, redis, evolution, trinks] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkEvolution(),
      checkTrinks()
    ]);
    
    const checks = { database, redis, evolution, trinks };
    
    // Determine overall status
    const statuses = Object.values(checks).map(check => check.status);
    let overallStatus: 'healthy' | 'unhealthy' | 'degraded';
    
    if (statuses.every(status => status === 'healthy')) {
      overallStatus = 'healthy';
    } else if (statuses.some(status => status === 'unhealthy')) {
      overallStatus = 'unhealthy';
    } else {
      overallStatus = 'degraded';
    }
    
    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      checks,
      overall_duration_ms: Date.now() - startTime
    };
  } catch (error) {
    logger.error('Health checks failed:', error);
    
    return {
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      checks: {
        database: { status: 'unhealthy', timestamp: new Date().toISOString(), duration_ms: 0, error: 'Health check system error' },
        redis: { status: 'unhealthy', timestamp: new Date().toISOString(), duration_ms: 0, error: 'Health check system error' },
        evolution: { status: 'unhealthy', timestamp: new Date().toISOString(), duration_ms: 0, error: 'Health check system error' },
        trinks: { status: 'unhealthy', timestamp: new Date().toISOString(), duration_ms: 0, error: 'Health check system error' }
      },
      overall_duration_ms: Date.now() - startTime
    };
  }
}

/**
 * Simple readiness check (lighter than full health check)
 */
export async function performReadinessCheck(): Promise<{ ready: boolean; timestamp: string; duration_ms: number }> {
  const startTime = Date.now();
  
  try {
    // Quick checks for essential services only
    const dbCheck = await checkDatabase();
    const redisCheck = await checkRedis();
    
    const ready = dbCheck.status !== 'unhealthy' && redisCheck.status !== 'unhealthy';
    
    return {
      ready,
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - startTime
    };
  } catch (error) {
    logger.error('Readiness check failed:', error);
    
    return {
      ready: false,
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - startTime
    };
  }
}