import axios, { AxiosResponse } from 'axios';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import logger from '../utils/logger';

interface HealthCheckResult {
  status: 'healthy' | 'unhealthy' | 'degraded';
  responseTime: number;
  timestamp: string;
  details?: any;
  error?: string;
}

interface HealthCheckConfig {
  timeout: number;
  retries: number;
  retryDelay: number;
}

/**
 * Serviço para verificação de saúde das dependências
 */
export class HealthCheckService {
  private config: HealthCheckConfig;
  private pgPool?: Pool;
  private redis?: Redis;

  constructor(config: Partial<HealthCheckConfig> = {}) {
    this.config = {
      timeout: 5000,
      retries: 2,
      retryDelay: 1000,
      ...config
    };
  }

  /**
   * Configura pool do PostgreSQL
   */
  public setPgPool(pool: Pool): void {
    this.pgPool = pool;
  }

  /**
   * Configura cliente Redis
   */
  public setRedis(redis: Redis): void {
    this.redis = redis;
  }

  /**
   * Executa health check com retry
   */
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= this.config.retries + 1; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');
        
        if (attempt <= this.config.retries) {
          logger.warn(`Health check ${operationName} failed, retrying...`, {
            attempt,
            error: lastError.message,
            retryIn: this.config.retryDelay
          });
          
          await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
        }
      }
    }
    
    throw lastError;
  }

  /**
   * Verifica saúde do Redis
   */
  public async checkRedis(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    
    try {
      if (!this.redis) {
        throw new Error('Redis client not configured');
      }

      await this.executeWithRetry(async () => {
        const result = await Promise.race([
          this.redis!.ping(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), this.config.timeout)
          )
        ]);
        
        if (result !== 'PONG') {
          throw new Error(`Unexpected ping response: ${result}`);
        }
      }, 'Redis');

      const responseTime = Date.now() - startTime;
      
      // Verificar informações adicionais do Redis
      const info = await this.redis.info('server');
      const memory = await this.redis.info('memory');
      
      return {
        status: 'healthy',
        responseTime,
        timestamp: new Date().toISOString(),
        details: {
          version: this.extractRedisInfo(info, 'redis_version'),
          uptime: this.extractRedisInfo(info, 'uptime_in_seconds'),
          memoryUsed: this.extractRedisInfo(memory, 'used_memory_human'),
          connectedClients: await this.redis.dbsize()
        }
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      
      logger.error('Redis health check failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        responseTime
      });
      
      return {
        status: 'unhealthy',
        responseTime,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Extrai informação do Redis INFO
   */
  private extractRedisInfo(info: string, key: string): string | null {
    const lines = info.split('\r\n');
    const line = lines.find(l => l.startsWith(`${key}:`));
    return line ? line.split(':')[1] : null;
  }

  /**
   * Verifica saúde do PostgreSQL
   */
  public async checkPostgreSQL(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    
    try {
      if (!this.pgPool) {
        throw new Error('PostgreSQL pool not configured');
      }

      await this.executeWithRetry(async () => {
        const client = await this.pgPool!.connect();
        
        try {
          const result = await Promise.race([
            client.query('SELECT 1 as test'),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Timeout')), this.config.timeout)
            )
          ]) as any;
          
          if (!result.rows || result.rows[0].test !== 1) {
            throw new Error('Unexpected query result');
          }
        } finally {
          client.release();
        }
      }, 'PostgreSQL');

      const responseTime = Date.now() - startTime;
      
      // Verificar informações adicionais do PostgreSQL
      const client = await this.pgPool.connect();
      let details = {};
      
      try {
        const versionResult = await client.query('SELECT version()');
        const statsResult = await client.query(`
          SELECT 
            numbackends as active_connections,
            xact_commit as transactions_committed,
            xact_rollback as transactions_rolled_back,
            blks_read as blocks_read,
            blks_hit as blocks_hit
          FROM pg_stat_database 
          WHERE datname = current_database()
        `);
        
        details = {
          version: versionResult.rows[0]?.version?.split(' ')[1] || 'unknown',
          activeConnections: statsResult.rows[0]?.active_connections || 0,
          transactionsCommitted: statsResult.rows[0]?.transactions_committed || 0,
          cacheHitRatio: statsResult.rows[0] ? 
            (parseInt(statsResult.rows[0].blocks_hit) / 
             (parseInt(statsResult.rows[0].blocks_hit) + parseInt(statsResult.rows[0].blocks_read)) * 100).toFixed(2) + '%' 
            : 'N/A'
        };
      } catch (detailsError) {
        logger.warn('Could not fetch PostgreSQL details', {
          error: detailsError instanceof Error ? detailsError.message : 'Unknown error'
        });
      } finally {
        client.release();
      }
      
      return {
        status: 'healthy',
        responseTime,
        timestamp: new Date().toISOString(),
        details
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      
      logger.error('PostgreSQL health check failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        responseTime
      });
      
      return {
        status: 'unhealthy',
        responseTime,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Verifica saúde de um serviço HTTP externo
   */
  public async checkHttpService(url: string, options: {
    method?: 'GET' | 'POST' | 'HEAD';
    headers?: Record<string, string>;
    expectedStatus?: number[];
    expectedBody?: string | RegExp;
  } = {}): Promise<HealthCheckResult> {
    const startTime = Date.now();
    
    try {
      const {
        method = 'GET',
        headers = {},
        expectedStatus = [200, 201, 204],
        expectedBody
      } = options;

      const response = await this.executeWithRetry(async () => {
        return await Promise.race([
          axios({
            method,
            url,
            headers,
            timeout: this.config.timeout,
            validateStatus: () => true // Não lançar erro para status HTTP
          }),
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), this.config.timeout)
          )
        ]) as AxiosResponse;
      }, `HTTP ${url}`);

      const responseTime = Date.now() - startTime;
      
      // Verificar status HTTP
      if (!expectedStatus.includes(response.status)) {
        throw new Error(`Unexpected status code: ${response.status}`);
      }
      
      // Verificar corpo da resposta se especificado
      if (expectedBody) {
        const bodyStr = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        
        if (expectedBody instanceof RegExp) {
          if (!expectedBody.test(bodyStr)) {
            throw new Error('Response body does not match expected pattern');
          }
        } else {
          if (!bodyStr.includes(expectedBody)) {
            throw new Error('Response body does not contain expected content');
          }
        }
      }
      
      return {
        status: 'healthy',
        responseTime,
        timestamp: new Date().toISOString(),
        details: {
          url,
          method,
          statusCode: response.status,
          contentLength: response.headers['content-length'] || 'unknown',
          contentType: response.headers['content-type'] || 'unknown'
        }
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      
      logger.error('HTTP service health check failed', {
        url,
        error: error instanceof Error ? error.message : 'Unknown error',
        responseTime
      });
      
      return {
        status: 'unhealthy',
        responseTime,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
        details: { url }
      };
    }
  }

  /**
   * Executa todos os health checks configurados
   */
  public async checkAll(services: {
    redis?: boolean;
    postgresql?: boolean;
    evolution?: string;
    trinks?: string;
    custom?: Array<{ name: string; url: string; options?: any }>;
  } = {}): Promise<Record<string, HealthCheckResult>> {
    const results: Record<string, HealthCheckResult> = {};
    const checks: Array<{ name: string; check: () => Promise<HealthCheckResult> }> = [];
    
    // Redis
    if (services.redis) {
      checks.push({
        name: 'redis',
        check: () => this.checkRedis()
      });
    }
    
    // PostgreSQL
    if (services.postgresql) {
      checks.push({
        name: 'postgres',
        check: () => this.checkPostgreSQL()
      });
    }
    
    // Evolution API
    if (services.evolution) {
      checks.push({
        name: 'evolution',
        check: () => this.checkHttpService(services.evolution!, {
          expectedBody: /status|health|ok/i
        })
      });
    }
    
    // Trinks API
    if (services.trinks) {
      checks.push({
        name: 'trinks',
        check: () => this.checkHttpService(services.trinks!, {
          expectedBody: /status|health|ok/i
        })
      });
    }
    
    // Serviços customizados
    if (services.custom) {
      for (const service of services.custom) {
        checks.push({
          name: service.name,
          check: () => this.checkHttpService(service.url, service.options)
        });
      }
    }
    
    // Executar todos os checks em paralelo
    const checkPromises = checks.map(async ({ name, check }) => {
      try {
        const result = await check();
        return { name, result };
      } catch (error) {
        return {
          name,
          result: {
            status: 'unhealthy' as const,
            responseTime: 0,
            timestamp: new Date().toISOString(),
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        };
      }
    });
    
    const checkResults = await Promise.all(checkPromises);
    
    for (const { name, result } of checkResults) {
      results[name] = result;
    }
    
    return results;
  }

  /**
   * Calcula status geral baseado nos resultados individuais
   */
  public calculateOverallStatus(results: Record<string, HealthCheckResult>): {
    status: 'healthy' | 'unhealthy' | 'degraded';
    summary: {
      total: number;
      healthy: number;
      unhealthy: number;
      degraded: number;
    };
  } {
    const statuses = Object.values(results).map(r => r.status);
    const summary = {
      total: statuses.length,
      healthy: statuses.filter(s => s === 'healthy').length,
      unhealthy: statuses.filter(s => s === 'unhealthy').length,
      degraded: statuses.filter(s => s === 'degraded').length
    };
    
    let overallStatus: 'healthy' | 'unhealthy' | 'degraded';
    
    if (summary.unhealthy > 0) {
      overallStatus = 'unhealthy';
    } else if (summary.degraded > 0) {
      overallStatus = 'degraded';
    } else {
      overallStatus = 'healthy';
    }
    
    return { status: overallStatus, summary };
  }
}

/**
 * Instância global do serviço de health checks
 */
export const healthCheckService = new HealthCheckService();

/**
 * Funções de conveniência para health checks individuais
 */
export const healthChecks = {
  /**
   * Ping do Redis
   */
  async redisPing(): Promise<HealthCheckResult> {
    return healthCheckService.checkRedis();
  },

  /**
   * SELECT 1 do PostgreSQL
   */
  async pgSelect1(): Promise<HealthCheckResult> {
    return healthCheckService.checkPostgreSQL();
  },

  /**
   * Check HTTP genérico
   */
  async httpCheck(url: string, options?: any): Promise<HealthCheckResult> {
    return healthCheckService.checkHttpService(url, options);
  }
};

/**
 * Middleware para endpoint de health check
 */
export function createHealthCheckEndpoint(services: {
  redis?: boolean;
  postgresql?: boolean;
  evolution?: string;
  trinks?: string;
}) {
  return async (req: any, res: any) => {
    try {
      const results = await healthCheckService.checkAll(services);
      const overall = healthCheckService.calculateOverallStatus(results);
      
      const response = {
        status: overall.status,
        timestamp: new Date().toISOString(),
        summary: overall.summary,
        services: results
      };
      
      // Status HTTP baseado na saúde geral
      const httpStatus = overall.status === 'healthy' ? 200 : 
                        overall.status === 'degraded' ? 207 : 503;
      
      res.status(httpStatus).json(response);
    } catch (error) {
      logger.error('Health check endpoint error', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      res.status(500).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: 'Internal server error'
      });
    }
  };
}