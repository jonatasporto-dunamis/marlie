import { Request, Response } from 'express';
import { createClient } from 'redis';
import axios from 'axios';
import logger from '../utils/logger';
import { performHealthChecks, performReadinessCheck } from '../health/checks';
import { pool } from '../infra/db';

interface HealthCheck {
  status: 'healthy' | 'unhealthy' | 'degraded';
  message?: string;
  responseTime?: number;
  details?: any;
}

interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  uptime: number;
  version: string;
  checks: {
    database: HealthCheck;
    redis: HealthCheck;
    evolution: HealthCheck;
    trinks: HealthCheck;
  };
}

// Health check para PostgreSQL
async function checkDatabase(): Promise<HealthCheck> {
  const startTime = Date.now();
  
  try {
    if (!process.env.DATABASE_URL) {
      return {
        status: 'unhealthy',
        message: 'DATABASE_URL not configured'
      };
    }

    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();

    return {
      status: 'healthy',
      responseTime: Date.now() - startTime
    };
  } catch (error) {
    logger.error('Database health check failed', { error });
    return {
      status: 'unhealthy',
      message: error instanceof Error ? error.message : 'Database connection failed',
      responseTime: Date.now() - startTime
    };
  }
}

// Health check para Redis
async function checkRedis(): Promise<HealthCheck> {
  const startTime = Date.now();
  
  try {
    if (!process.env.REDIS_URL) {
      return {
        status: 'degraded',
        message: 'Redis not configured (optional service)'
      };
    }

    const redis = createClient({ url: process.env.REDIS_URL });
    await redis.connect();
    await redis.ping();
    await redis.disconnect();

    return {
      status: 'healthy',
      responseTime: Date.now() - startTime
    };
  } catch (error) {
    logger.warn('Redis health check failed', { error });
    return {
      status: 'degraded',
      message: error instanceof Error ? error.message : 'Redis connection failed',
      responseTime: Date.now() - startTime
    };
  }
}

// Health check para Evolution API
async function checkEvolution(): Promise<HealthCheck> {
  const startTime = Date.now();
  
  try {
    if (!process.env.EVOLUTION_BASE_URL || !process.env.EVOLUTION_API_KEY) {
      return {
        status: 'degraded',
        message: 'Evolution API not configured'
      };
    }

    const response = await axios.get(`${process.env.EVOLUTION_BASE_URL}/instance/fetchInstances`, {
      headers: {
        'apikey': process.env.EVOLUTION_API_KEY
      },
      timeout: 5000
    });

    return {
      status: response.status === 200 ? 'healthy' : 'degraded',
      responseTime: Date.now() - startTime,
      details: {
        statusCode: response.status
      }
    };
  } catch (error) {
    logger.warn('Evolution API health check failed', { error });
    return {
      status: 'degraded',
      message: error instanceof Error ? error.message : 'Evolution API connection failed',
      responseTime: Date.now() - startTime
    };
  }
}

// Health check para Trinks API
async function checkTrinks(): Promise<HealthCheck> {
  const startTime = Date.now();
  
  try {
    if (!process.env.TRINKS_BASE_URL || !process.env.TRINKS_API_KEY) {
      return {
        status: 'degraded',
        message: 'Trinks API not configured'
      };
    }

    const response = await axios.get(`${process.env.TRINKS_BASE_URL}/health`, {
      headers: {
        'Authorization': `Bearer ${process.env.TRINKS_API_KEY}`
      },
      timeout: 5000
    });

    return {
      status: response.status === 200 ? 'healthy' : 'degraded',
      responseTime: Date.now() - startTime,
      details: {
        statusCode: response.status
      }
    };
  } catch (error) {
    logger.warn('Trinks API health check failed', { error });
    return {
      status: 'degraded',
      message: error instanceof Error ? error.message : 'Trinks API connection failed',
      responseTime: Date.now() - startTime
    };
  }
}

// Determinar status geral baseado nos subchecks
function determineOverallStatus(checks: HealthStatus['checks']): 'healthy' | 'unhealthy' | 'degraded' {
  const statuses = Object.values(checks).map(check => check.status);
  
  if (statuses.includes('unhealthy')) {
    return 'unhealthy';
  }
  
  if (statuses.includes('degraded')) {
    return 'degraded';
  }
  
  return 'healthy';
}

// Handler para /health
export async function healthHandler(req: Request, res: Response) {
  try {
    const healthStatus = await performHealthChecks();
    
    const httpStatus = healthStatus.status === 'healthy' ? 200 : 
                      healthStatus.status === 'degraded' ? 200 : 503;
    
    // Add additional system info
    const response = {
      ...healthStatus,
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0',
      node_version: process.version,
      memory_usage: process.memoryUsage()
    };
    
    res.status(httpStatus).json(response);
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0',
      error: 'Health check system failure',
      checks: {
        database: { status: 'unhealthy', timestamp: new Date().toISOString(), duration_ms: 0, error: 'System error' },
        redis: { status: 'unhealthy', timestamp: new Date().toISOString(), duration_ms: 0, error: 'System error' },
        evolution: { status: 'unhealthy', timestamp: new Date().toISOString(), duration_ms: 0, error: 'System error' },
        trinks: { status: 'unhealthy', timestamp: new Date().toISOString(), duration_ms: 0, error: 'System error' }
      },
      overall_duration_ms: 0
    });
  }
}

// Handler para /ready (readiness probe)
export async function readyHandler(req: Request, res: Response) {
  try {
    const readinessStatus = await performReadinessCheck();
    
    const response = {
      ...readinessStatus,
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0'
    };
    
    res.status(readinessStatus.ready ? 200 : 503).json(response);
  } catch (error) {
    logger.error('Readiness check failed:', error);
    res.status(503).json({
      ready: false,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      duration_ms: 0,
      error: 'Readiness check system failure'
    });
  }
}