import { Request, Response, NextFunction } from 'express';
import { register, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import logger from '../utils/logger';

/**
 * Configuração das métricas Prometheus
 */
interface PrometheusConfig {
  prefix: string;
  labels: Record<string, string>;
  collectDefaultMetrics: boolean;
  defaultMetricsInterval: number;
}

/**
 * Serviço de métricas Prometheus para segurança
 */
export class PrometheusMetricsService {
  private config: PrometheusConfig;
  private initialized = false;

  // Contadores de segurança
  public authDeniedTotal: Counter<string>;
  public hmacInvalidTotal: Counter<string>;
  public rateLimitHitsTotal: Counter<string>;
  public tempBansTotal: Counter<string>;
  public cbOpenTotal: Counter<string>;
  public requestsTotal: Counter<string>;
  public errorsTotal: Counter<string>;

  // Histogramas de performance
  public requestDuration: Histogram<string>;
  public authDuration: Histogram<string>;
  public hmacVerificationDuration: Histogram<string>;

  // Gauges de estado
  public activeConnections: Gauge<string>;
  public rateLimitBuckets: Gauge<string>;
  public circuitBreakerState: Gauge<string>;
  public healthStatus: Gauge<string>;

  constructor(config: Partial<PrometheusConfig> = {}) {
    this.config = {
      prefix: 'marlie_security_',
      labels: { app: 'marlie', component: 'security' },
      collectDefaultMetrics: true,
      defaultMetricsInterval: 10000,
      ...config
    };

    this.initializeMetrics();
  }

  /**
   * Inicializa todas as métricas
   */
  private initializeMetrics(): void {
    if (this.initialized) {
      return;
    }

    // Limpar registry anterior se existir
    register.clear();

    // Métricas padrão do Node.js
    if (this.config.collectDefaultMetrics) {
      collectDefaultMetrics({
        register,
        prefix: this.config.prefix,
        timeout: this.config.defaultMetricsInterval
      });
    }

    // Contadores de segurança
    this.authDeniedTotal = new Counter({
      name: `${this.config.prefix}auth_denied_total`,
      help: 'Total number of authentication denials',
      labelNames: ['reason', 'endpoint', 'ip_range'],
      registers: [register]
    });

    this.hmacInvalidTotal = new Counter({
      name: `${this.config.prefix}hmac_invalid_total`,
      help: 'Total number of invalid HMAC signatures',
      labelNames: ['endpoint', 'reason'],
      registers: [register]
    });

    this.rateLimitHitsTotal = new Counter({
      name: `${this.config.prefix}rate_limit_hits_total`,
      help: 'Total number of rate limit hits',
      labelNames: ['key', 'endpoint', 'action'],
      registers: [register]
    });

    this.tempBansTotal = new Counter({
      name: `${this.config.prefix}temp_bans_total`,
      help: 'Total number of temporary bans applied',
      labelNames: ['reason', 'duration'],
      registers: [register]
    });

    this.cbOpenTotal = new Counter({
      name: `${this.config.prefix}cb_open_total`,
      help: 'Total number of circuit breaker opens',
      labelNames: ['dep', 'reason'],
      registers: [register]
    });

    this.requestsTotal = new Counter({
      name: `${this.config.prefix}requests_total`,
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'endpoint', 'status_code'],
      registers: [register]
    });

    this.errorsTotal = new Counter({
      name: `${this.config.prefix}errors_total`,
      help: 'Total number of errors',
      labelNames: ['type', 'endpoint', 'error_code'],
      registers: [register]
    });

    // Histogramas de performance
    this.requestDuration = new Histogram({
      name: `${this.config.prefix}request_duration_seconds`,
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'endpoint', 'status_code'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
      registers: [register]
    });

    this.authDuration = new Histogram({
      name: `${this.config.prefix}auth_duration_seconds`,
      help: 'Authentication duration in seconds',
      labelNames: ['auth_type', 'result'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.2],
      registers: [register]
    });

    this.hmacVerificationDuration = new Histogram({
      name: `${this.config.prefix}hmac_verification_duration_seconds`,
      help: 'HMAC verification duration in seconds',
      labelNames: ['result'],
      buckets: [0.001, 0.002, 0.005, 0.01, 0.02, 0.05],
      registers: [register]
    });

    // Gauges de estado
    this.activeConnections = new Gauge({
      name: `${this.config.prefix}active_connections`,
      help: 'Number of active connections',
      labelNames: ['type'],
      registers: [register]
    });

    this.rateLimitBuckets = new Gauge({
      name: `${this.config.prefix}rate_limit_buckets`,
      help: 'Current rate limit bucket values',
      labelNames: ['key', 'bucket_type'],
      registers: [register]
    });

    this.circuitBreakerState = new Gauge({
      name: `${this.config.prefix}circuit_breaker_state`,
      help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
      labelNames: ['dep'],
      registers: [register]
    });

    this.healthStatus = new Gauge({
      name: `${this.config.prefix}health_status`,
      help: 'Health status of dependencies (1=healthy, 0=unhealthy)',
      labelNames: ['service'],
      registers: [register]
    });

    this.initialized = true;
    logger.info('Prometheus metrics initialized', {
      prefix: this.config.prefix,
      labels: this.config.labels
    });
  }

  /**
   * Middleware para coletar métricas de requisições HTTP
   */
  public createRequestMetricsMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const startTime = Date.now();
      const originalSend = res.send;

      // Override do método send para capturar quando a resposta é enviada
      res.send = function(body: any) {
        const duration = (Date.now() - startTime) / 1000;
        const endpoint = req.route?.path || req.path;
        const method = req.method;
        const statusCode = res.statusCode.toString();

        // Incrementar contador de requisições
        prometheusMetrics.requestsTotal.inc({
          method,
          endpoint,
          status_code: statusCode
        });

        // Registrar duração da requisição
        prometheusMetrics.requestDuration.observe(
          { method, endpoint, status_code: statusCode },
          duration
        );

        // Incrementar contador de erros se status >= 400
        if (res.statusCode >= 400) {
          prometheusMetrics.errorsTotal.inc({
            type: 'http_error',
            endpoint,
            error_code: statusCode
          });
        }

        return originalSend.call(this, body);
      };

      next();
    };
  }

  /**
   * Registra negação de autenticação
   */
  public recordAuthDenied(reason: string, endpoint: string, ip?: string): void {
    const ipRange = ip ? this.getIpRange(ip) : 'unknown';
    this.authDeniedTotal.inc({ reason, endpoint, ip_range: ipRange });
  }

  /**
   * Registra HMAC inválido
   */
  public recordHmacInvalid(endpoint: string, reason: string): void {
    this.hmacInvalidTotal.inc({ endpoint, reason });
  }

  /**
   * Registra hit de rate limit
   */
  public recordRateLimitHit(key: string, endpoint: string, action: 'blocked' | 'warned'): void {
    this.rateLimitHitsTotal.inc({ key, endpoint, action });
  }

  /**
   * Registra banimento temporário
   */
  public recordTempBan(reason: string, duration: string): void {
    this.tempBansTotal.inc({ reason, duration });
  }

  /**
   * Registra abertura de circuit breaker
   */
  public recordCircuitBreakerOpen(dependency: string, reason: string): void {
    this.cbOpenTotal.inc({ dep: dependency, reason });
  }

  /**
   * Atualiza estado do circuit breaker
   */
  public updateCircuitBreakerState(dependency: string, state: 'closed' | 'open' | 'half-open'): void {
    const stateValue = state === 'closed' ? 0 : state === 'open' ? 1 : 2;
    this.circuitBreakerState.set({ dep: dependency }, stateValue);
  }

  /**
   * Atualiza status de saúde de um serviço
   */
  public updateHealthStatus(service: string, healthy: boolean): void {
    this.healthStatus.set({ service }, healthy ? 1 : 0);
  }

  /**
   * Atualiza bucket de rate limit
   */
  public updateRateLimitBucket(key: string, bucketType: 'current' | 'remaining', value: number): void {
    this.rateLimitBuckets.set({ key, bucket_type: bucketType }, value);
  }

  /**
   * Registra duração de autenticação
   */
  public recordAuthDuration(authType: string, result: 'success' | 'failure', duration: number): void {
    this.authDuration.observe({ auth_type: authType, result }, duration);
  }

  /**
   * Registra duração de verificação HMAC
   */
  public recordHmacDuration(result: 'valid' | 'invalid', duration: number): void {
    this.hmacVerificationDuration.observe({ result }, duration);
  }

  /**
   * Atualiza número de conexões ativas
   */
  public updateActiveConnections(type: string, count: number): void {
    this.activeConnections.set({ type }, count);
  }

  /**
   * Obtém faixa de IP para métricas (para privacidade)
   */
  private getIpRange(ip: string): string {
    try {
      if (ip.includes(':')) {
        // IPv6 - pegar apenas os primeiros 4 grupos
        const parts = ip.split(':');
        return `${parts.slice(0, 4).join(':')}::/64`;
      } else {
        // IPv4 - pegar apenas os primeiros 3 octetos
        const parts = ip.split('.');
        return `${parts.slice(0, 3).join('.')}.0/24`;
      }
    } catch {
      return 'unknown';
    }
  }

  /**
   * Obtém todas as métricas em formato Prometheus
   */
  public async getMetrics(): Promise<string> {
    return register.metrics();
  }

  /**
   * Obtém métricas em formato JSON
   */
  public async getMetricsJson(): Promise<any> {
    const metrics = await register.getMetricsAsJSON();
    return {
      timestamp: new Date().toISOString(),
      labels: this.config.labels,
      metrics
    };
  }

  /**
   * Reseta todas as métricas
   */
  public reset(): void {
    register.resetMetrics();
    logger.info('Prometheus metrics reset');
  }

  /**
   * Obtém estatísticas resumidas
   */
  public async getStats(): Promise<any> {
    const metrics = await register.getMetricsAsJSON();
    
    const stats = {
      totalMetrics: metrics.length,
      counters: metrics.filter(m => m.type === 'counter').length,
      gauges: metrics.filter(m => m.type === 'gauge').length,
      histograms: metrics.filter(m => m.type === 'histogram').length,
      lastUpdate: new Date().toISOString(),
      config: {
        prefix: this.config.prefix,
        labels: this.config.labels
      }
    };
    
    return stats;
  }
}

/**
 * Instância global do serviço de métricas
 */
export const prometheusMetrics = new PrometheusMetricsService();

/**
 * Middleware para endpoint de métricas
 */
export function createMetricsEndpoint() {
  return async (req: Request, res: Response) => {
    try {
      const format = req.query.format as string;
      
      if (format === 'json') {
        const metrics = await prometheusMetrics.getMetricsJson();
        res.json(metrics);
      } else {
        const metrics = await prometheusMetrics.getMetrics();
        res.set('Content-Type', register.contentType);
        res.send(metrics);
      }
    } catch (error) {
      logger.error('Metrics endpoint error', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      res.status(500).json({
        error: 'Internal server error'
      });
    }
  };
}

/**
 * Middleware para coletar métricas de autenticação
 */
export function createAuthMetricsMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    const originalSend = res.send;
    
    res.send = function(body: any) {
      const duration = (Date.now() - startTime) / 1000;
      const authType = req.headers.authorization ? 'bearer' : 'none';
      const result = res.statusCode < 400 ? 'success' : 'failure';
      
      prometheusMetrics.recordAuthDuration(authType, result, duration);
      
      if (res.statusCode === 401 || res.statusCode === 403) {
        const reason = res.statusCode === 401 ? 'unauthorized' : 'forbidden';
        const endpoint = req.route?.path || req.path;
        prometheusMetrics.recordAuthDenied(reason, endpoint, req.ip);
      }
      
      return originalSend.call(this, body);
    };
    
    next();
  };
}

/**
 * Funções de conveniência para métricas específicas
 */
export const metrics = {
  /**
   * Incrementa contador de autenticação negada
   */
  authDenied: (reason: string, endpoint: string, ip?: string) => {
    prometheusMetrics.recordAuthDenied(reason, endpoint, ip);
  },

  /**
   * Incrementa contador de HMAC inválido
   */
  hmacInvalid: (endpoint: string, reason: string) => {
    prometheusMetrics.recordHmacInvalid(endpoint, reason);
  },

  /**
   * Incrementa contador de rate limit
   */
  rateLimitHit: (key: string, endpoint: string, action: 'blocked' | 'warned' = 'blocked') => {
    prometheusMetrics.recordRateLimitHit(key, endpoint, action);
  },

  /**
   * Incrementa contador de banimento temporário
   */
  tempBan: (reason: string, duration: string) => {
    prometheusMetrics.recordTempBan(reason, duration);
  },

  /**
   * Incrementa contador de circuit breaker aberto
   */
  circuitBreakerOpen: (dependency: string, reason: string) => {
    prometheusMetrics.recordCircuitBreakerOpen(dependency, reason);
  },

  /**
   * Atualiza estado do circuit breaker
   */
  circuitBreakerState: (dependency: string, state: 'closed' | 'open' | 'half-open') => {
    prometheusMetrics.updateCircuitBreakerState(dependency, state);
  },

  /**
   * Atualiza status de saúde
   */
  healthStatus: (service: string, healthy: boolean) => {
    prometheusMetrics.updateHealthStatus(service, healthy);
  }
};

/**
 * Inicializa métricas com configuração padrão
 */
export function initializeMetrics(config?: Partial<PrometheusConfig>) {
  if (config) {
    // Recriar instância com nova configuração
    Object.assign(prometheusMetrics, new PrometheusMetricsService(config));
  }
  
  logger.info('Prometheus metrics service initialized');
}