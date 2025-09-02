import { Request, Response } from 'express';
import { Pool } from 'pg';
import { createClient } from 'redis';
import axios from 'axios';
import logger from '../utils/logger';

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

    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
    });

    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    await pool.end();

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
export const healthHandler = async (req: Request, res: Response) => {
  try {
    const checks = {
      database: await checkDatabase(),
      redis: await checkRedis(),
      evolution: await checkEvolution(),
      trinks: await checkTrinks()
    };

    const overallStatus = determineOverallStatus(checks);
    
    const healthStatus: HealthStatus = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0',
      checks
    };

    const statusCode = overallStatus === 'healthy' ? 200 : 
                      overallStatus === 'degraded' ? 200 : 503;

    res.status(statusCode).json(healthStatus);
  } catch (error) {
    logger.error('Health check failed', { error });
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      message: 'Health check failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

// Handler para /ready (readiness probe)
export const readyHandler = async (req: Request, res: Response) => {
  try {
    // Para readiness, apenas verificamos serviços críticos
    const databaseCheck = await checkDatabase();
    
    if (databaseCheck.status === 'unhealthy') {
      return res.status(503).json({
        status: 'not_ready',
        timestamp: new Date().toISOString(),
        message: 'Database not available',
        checks: {
          database: databaseCheck
        }
      });
    }

    res.status(200).json({
      status: 'ready',
      timestamp: new Date().toISOString(),
      message: 'Service is ready to accept traffic'
    });
  } catch (error) {
    logger.error('Readiness check failed', { error });
    res.status(503).json({
      status: 'not_ready',
      timestamp: new Date().toISOString(),
      message: 'Readiness check failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};