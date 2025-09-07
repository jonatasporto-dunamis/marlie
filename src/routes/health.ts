import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import Redis from 'ioredis';
import axios from 'axios';
import { logger } from '../utils/logger';

const router = Router();

interface HealthCheckResult {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  uptime: number;
  version: string;
  environment: string;
  checks: {
    redis: 'ok' | 'error' | 'timeout';
    postgres: 'ok' | 'error' | 'timeout';
    evolution: 'ok' | 'error' | 'timeout' | 'disabled';
    trinks: 'ok' | 'error' | 'timeout' | 'disabled';
  };
  details?: {
    redis?: any;
    postgres?: any;
    evolution?: any;
    trinks?: any;
  };
  metrics?: {
    memory_usage: {
      used: number;
      total: number;
      percentage: number;
    };
    cpu_usage?: number;
    active_connections?: number;
  };
}

/**
 * Verifica saúde do Redis
 */
async function checkRedis(redis: Redis): Promise<{ status: 'ok' | 'error' | 'timeout'; details?: any }> {
  try {
    const start = Date.now();
    await redis.ping();
    const duration = Date.now() - start;
    
    return {
      status: 'ok',
      details: {
        response_time_ms: duration,
        connected: redis.status === 'ready'
      }
    };
  } catch (error) {
    return {
      status: 'error',
      details: {
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    };
  }
}

/**
 * Verifica saúde do PostgreSQL
 */
async function checkPostgreSQL(pool: Pool): Promise<{ status: 'ok' | 'error' | 'timeout'; details?: any }> {
  try {
    const start = Date.now();
    const client = await pool.connect();
    
    try {
      const result = await client.query('SELECT NOW() as current_time, version() as version');
      const duration = Date.now() - start;
      
      return {
        status: 'ok',
        details: {
          response_time_ms: duration,
          current_time: result.rows[0].current_time,
          version: result.rows[0].version.split(' ')[0] + ' ' + result.rows[0].version.split(' ')[1],
          total_connections: pool.totalCount,
          idle_connections: pool.idleCount,
          waiting_connections: pool.waitingCount
        }
      };
    } finally {
      client.release();
    }
  } catch (error) {
    return {
      status: 'error',
      details: {
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    };
  }
}

/**
 * Verifica saúde da API Evolution
 */
async function checkEvolutionAPI(): Promise<{ status: 'ok' | 'error' | 'timeout' | 'disabled'; details?: any }> {
  const evolutionUrl = process.env.EVOLUTION_API_URL;
  const evolutionToken = process.env.EVOLUTION_API_TOKEN;
  
  if (!evolutionUrl || !evolutionToken) {
    return {
      status: 'disabled',
      details: { reason: 'Evolution API not configured' }
    };
  }
  
  try {
    const start = Date.now();
    const response = await axios.get(`${evolutionUrl}/instance/fetchInstances`, {
      headers: {
        'Authorization': `Bearer ${evolutionToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });
    
    const duration = Date.now() - start;
    
    return {
      status: response.status === 200 ? 'ok' : 'error',
      details: {
        response_time_ms: duration,
        status_code: response.status,
        instances_count: Array.isArray(response.data) ? response.data.length : 0
      }
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return {
        status: error.code === 'ECONNABORTED' ? 'timeout' : 'error',
        details: {
          error: error.message,
          status_code: error.response?.status,
          url: evolutionUrl
        }
      };
    }
    
    return {
      status: 'error',
      details: {
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    };
  }
}

/**
 * Verifica saúde da API Trinks
 */
async function checkTrinksAPI(): Promise<{ status: 'ok' | 'error' | 'timeout' | 'disabled'; details?: any }> {
  const trinksUrl = process.env.TRINKS_API_URL;
  const trinksToken = process.env.TRINKS_API_TOKEN;
  
  if (!trinksUrl || !trinksToken) {
    return {
      status: 'disabled',
      details: { reason: 'Trinks API not configured' }
    };
  }
  
  try {
    const start = Date.now();
    const response = await axios.get(`${trinksUrl}/api/v1/health`, {
      headers: {
        'Authorization': `Bearer ${trinksToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });
    
    const duration = Date.now() - start;
    
    return {
      status: response.status === 200 ? 'ok' : 'error',
      details: {
        response_time_ms: duration,
        status_code: response.status
      }
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return {
        status: error.code === 'ECONNABORTED' ? 'timeout' : 'error',
        details: {
          error: error.message,
          status_code: error.response?.status,
          url: trinksUrl
        }
      };
    }
    
    return {
      status: 'error',
      details: {
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    };
  }
}

/**
 * Coleta métricas do sistema
 */
function getSystemMetrics() {
  const memUsage = process.memoryUsage();
  
  return {
    memory_usage: {
      used: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
      total: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
      percentage: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100)
    },
    uptime: Math.round(process.uptime()),
    pid: process.pid,
    node_version: process.version
  };
}

/**
 * Endpoint principal de health check
 */
router.get('/health', async (req: Request, res: Response) => {
  const startTime = Date.now();
  
  try {
    // Obter instâncias de conexão (assumindo que estão disponíveis globalmente)
    const redis = (req as any).redis || (global as any).redis;
    const pgPool = (req as any).pgPool || (global as any).pgPool;
    
    // Executar verificações em paralelo
    const [redisCheck, postgresCheck, evolutionCheck, trinksCheck] = await Promise.all([
      redis ? checkRedis(redis) : Promise.resolve({ status: 'error' as const, details: { error: 'Redis not available' } }),
      pgPool ? checkPostgreSQL(pgPool) : Promise.resolve({ status: 'error' as const, details: { error: 'PostgreSQL not available' } }),
      checkEvolutionAPI(),
      checkTrinksAPI()
    ]);
    
    // Determinar status geral
    let overallStatus: 'healthy' | 'unhealthy' | 'degraded' = 'healthy';
    
    // Serviços essenciais (Redis e PostgreSQL) devem estar OK
    if (redisCheck.status === 'error' || postgresCheck.status === 'error') {
      overallStatus = 'unhealthy';
    }
    // Serviços externos podem estar degradados sem afetar funcionalidade crítica
    else if (evolutionCheck.status === 'error' || trinksCheck.status === 'error') {
      overallStatus = 'degraded';
    }
    
    // Coletar métricas
    const metrics = getSystemMetrics();
    
    const result: HealthCheckResult = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      version: process.env.APP_VERSION || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      checks: {
        redis: redisCheck.status,
        postgres: postgresCheck.status,
        evolution: evolutionCheck.status,
        trinks: trinksCheck.status
      },
      details: {
        redis: redisCheck.details,
        postgres: postgresCheck.details,
        evolution: evolutionCheck.details,
        trinks: trinksCheck.details
      },
      metrics
    };
    
    const duration = Date.now() - startTime;
    
    // Log do resultado
    logger.info('Health check completed', {
      status: overallStatus,
      duration_ms: duration,
      checks: result.checks
    });
    
    // Definir status HTTP baseado no resultado
    const httpStatus = overallStatus === 'unhealthy' ? 503 : 200;
    
    res.status(httpStatus).json(result);
    
  } catch (error) {
    logger.error('Health check failed:', error);
    
    const errorResult: HealthCheckResult = {
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      version: process.env.APP_VERSION || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      checks: {
        redis: 'error',
        postgres: 'error',
        evolution: 'error',
        trinks: 'error'
      },
      details: {
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    };
    
    res.status(503).json(errorResult);
  }
});

/**
 * Endpoint simplificado para load balancers
 */
router.get('/ping', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime())
  });
});

/**
 * Endpoint de readiness (pronto para receber tráfego)
 */
router.get('/ready', async (req: Request, res: Response) => {
  try {
    // Verificações mínimas para readiness
    const redis = (req as any).redis || (global as any).redis;
    const pgPool = (req as any).pgPool || (global as any).pgPool;
    
    if (!redis || !pgPool) {
      return res.status(503).json({
        status: 'not_ready',
        reason: 'Essential services not initialized'
      });
    }
    
    // Teste rápido de conectividade
    await Promise.all([
      redis.ping(),
      pgPool.query('SELECT 1')
    ]);
    
    res.status(200).json({
      status: 'ready',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(503).json({
      status: 'not_ready',
      reason: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Endpoint de liveness (aplicação está viva)
 */
router.get('/live', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    memory_usage: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
    }
  });
});

export default router;
export type { HealthCheckResult };