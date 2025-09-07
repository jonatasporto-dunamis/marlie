import { Express, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import logger from '../utils/logger';

// Importar todos os middlewares e serviços
import { createHmacVerificationMiddleware, hmacVerificationService } from '../middleware/hmac-verification';
import { createAdvancedRateLimitMiddleware, advancedRateLimitService } from '../middleware/advanced-rate-limit';
import { createPiiMaskingMiddleware, piiMaskingService } from '../middleware/pii-masking';
import { createCircuitBreakerMiddleware, circuitBreakerService } from '../middleware/circuit-breaker';
import { createAdminAuthMiddleware, adminAuthService } from '../middleware/admin-auth';
import { secretRotationService, rotateSecretController, generateSecretController, getSecretStatsController } from '../services/secret-rotation';
import { healthCheckService, healthChecks, createHealthCheckEndpoint } from '../services/health-checks';
import { prometheusMetrics, createMetricsEndpoint, createAuthMetricsMiddleware, metrics, initializeMetrics } from '../services/prometheus-metrics';

/**
 * Configuração do módulo Marlie Security
 */
export interface MarlieSecurityConfig {
  // Configurações de ambiente
  env: {
    timezone: string;
    adminToken: string;
    hmacSecretCurrent: string;
    hmacSecretPrev?: string;
    rateIpRpm: number;
    ratePhoneRpm: number;
    banWindowMin: number;
    cbErrorRateLimit: number;
    cbOpenSecs: number;
    adminIpAllowlist?: string[];
    internalCidrs?: string[];
    evolutionHealthUrl?: string;
    trinksHealthUrl?: string;
  };

  // Configurações de segurança
  security: {
    auth: string;
    ipAllowlist: {
      enabled: boolean;
      cidrs: string[];
    };
    piiMasking: boolean;
    piiPatterns: Array<{ regex: string }>;
  };

  // Configurações de middleware
  middleware: Array<{
    name: string;
    applyToRoutes?: string[];
    applyToTools?: string[];
    config: any;
  }>;

  // Configurações de observabilidade
  observability: {
    prometheus: {
      httpEndpoint: string;
      labels: Record<string, string>;
      counters: Array<{ name: string; help: string; labels?: string[] }>;
    };
  };

  // Configurações de rate limiting
  rateLimitBypassCidrs?: string[];

  // Configurações de circuit breaker
  circuitBreaker: {
    dependencies: Array<{ name: string; matchTools: string[] }>;
    notify: {
      onOpen: { channel: string; template: string };
      onClose: { channel: string; template: string };
    };
  };
}

/**
 * Classe principal do módulo Marlie Security
 */
export class MarlieSecurityModule {
  private config: MarlieSecurityConfig;
  private app: Express;
  private pgPool?: Pool;
  private redis?: Redis;
  private initialized = false;

  constructor(app: Express, config: MarlieSecurityConfig) {
    this.app = app;
    this.config = config;
  }

  /**
   * Configura dependências externas
   */
  public setDependencies(pgPool: Pool, redis: Redis): void {
    this.pgPool = pgPool;
    this.redis = redis;
    
    // Configurar serviços que dependem de conexões externas
    healthCheckService.setPgPool(pgPool);
    healthCheckService.setRedis(redis);
    advancedRateLimitService.setRedis(redis);
  }

  /**
   * Inicializa o módulo de segurança
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('Marlie Security module already initialized');
      return;
    }

    try {
      logger.info('Initializing Marlie Security module...', {
        timezone: this.config.env.timezone,
        piiMasking: this.config.security.piiMasking,
        middlewareCount: this.config.middleware.length
      });

      // 1. Inicializar métricas Prometheus
      await this.initializeMetrics();

      // 2. Configurar middlewares globais
      await this.setupGlobalMiddlewares();

      // 3. Configurar middlewares específicos
      await this.setupSecurityMiddlewares();

      // 4. Configurar rotas administrativas
      await this.setupAdminRoutes();

      // 5. Configurar rotas de webhook
      await this.setupWebhookRoutes();

      // 6. Configurar rotas de observabilidade
      await this.setupObservabilityRoutes();

      // 7. Configurar circuit breakers
      await this.setupCircuitBreakers();

      this.initialized = true;
      logger.info('Marlie Security module initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Marlie Security module', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * Inicializa métricas Prometheus
   */
  private async initializeMetrics(): Promise<void> {
    initializeMetrics({
      prefix: 'marlie_security_',
      labels: this.config.observability.prometheus.labels,
      collectDefaultMetrics: true,
      defaultMetricsInterval: 10000
    });

    logger.info('Prometheus metrics initialized');
  }

  /**
   * Configura middlewares globais
   */
  private async setupGlobalMiddlewares(): Promise<void> {
    // Middleware de métricas de requisição (deve ser o primeiro)
    this.app.use(prometheusMetrics.createRequestMetricsMiddleware());

    // Middleware de métricas de autenticação
    this.app.use(createAuthMetricsMiddleware());

    // Middleware de mascaramento de PII (se habilitado)
    if (this.config.security.piiMasking) {
      const piiMiddleware = createPiiMaskingMiddleware({
        patterns: this.config.security.piiPatterns.map(p => ({ regex: new RegExp(p.regex, 'g') })),
        maskChar: '*',
        preserveLength: true,
        logMasking: true
      });
      
      this.app.use(piiMiddleware.requestLogger);
    }

    logger.info('Global middlewares configured');
  }

  /**
   * Configura middlewares de segurança específicos
   */
  private async setupSecurityMiddlewares(): Promise<void> {
    // Rate limiting global
    const rateLimitMiddleware = createAdvancedRateLimitMiddleware({
      rules: [
        { key: 'ip', limitPerMin: this.config.env.rateIpRpm },
        { key: 'user.phone', limitPerMin: this.config.env.ratePhoneRpm }
      ],
      penalty: { banMinutes: this.config.env.banWindowMin },
      bypassCidrs: this.config.rateLimitBypassCidrs || [],
      redis: this.redis
    });

    this.app.use('/*', rateLimitMiddleware.standard);

    logger.info('Security middlewares configured');
  }

  /**
   * Configura rotas administrativas
   */
  private async setupAdminRoutes(): Promise<void> {
    // Middleware de autenticação admin
    const adminAuth = createAdminAuthMiddleware({
      token: this.config.env.adminToken,
      ipAllowlist: this.config.security.ipAllowlist.cidrs,
      maxFailedAttempts: 5,
      lockoutDuration: 15 * 60 * 1000, // 15 minutos
      cleanupInterval: 60 * 60 * 1000 // 1 hora
    });

    // Rota para rotação de secrets
    this.app.post('/admin/rotate-secret', adminAuth, rotateSecretController);

    // Rota para gerar novo secret
    this.app.get('/admin/generate-secret', adminAuth, generateSecretController);

    // Rota para estatísticas de secrets
    this.app.get('/admin/secret-stats', adminAuth, getSecretStatsController);

    // Rota de health check
    const healthCheckEndpoint = createHealthCheckEndpoint({
      redis: !!this.redis,
      postgresql: !!this.pgPool,
      evolution: this.config.env.evolutionHealthUrl,
      trinks: this.config.env.trinksHealthUrl
    });
    
    this.app.get('/admin/health', adminAuth, healthCheckEndpoint);

    logger.info('Admin routes configured');
  }

  /**
   * Configura rotas de webhook
   */
  private async setupWebhookRoutes(): Promise<void> {
    // Middleware de verificação HMAC para webhooks
    const hmacMiddleware = createHmacVerificationMiddleware({
      header: 'X-Signature',
      algorithm: 'sha256',
      secrets: [this.config.env.hmacSecretCurrent, this.config.env.hmacSecretPrev].filter(Boolean),
      bodySource: 'raw'
    });

    // Rate limiting específico para webhooks
    const webhookRateLimit = createAdvancedRateLimitMiddleware({
      rules: [{ key: 'ip', limitPerMin: 60 }],
      penalty: { banMinutes: 5 },
      redis: this.redis
    });

    // Rota de webhook Evolution
    this.app.post('/webhook/evolution', 
      webhookRateLimit.webhooks,
      hmacMiddleware.evolutionWebhook,
      (req: Request, res: Response) => {
        // Enfileirar para processamento
        // TODO: Implementar enfileiramento
        
        res.json({ ok: true });
      }
    );

    logger.info('Webhook routes configured');
  }

  /**
   * Configura rotas de observabilidade
   */
  private async setupObservabilityRoutes(): Promise<void> {
    // Endpoint de métricas Prometheus
    this.app.get(this.config.observability.prometheus.httpEndpoint, createMetricsEndpoint());

    // Endpoint de estatísticas em JSON
    this.app.get('/admin/metrics/stats', 
      createAdminAuthMiddleware({
        token: this.config.env.adminToken,
        ipAllowlist: this.config.security.ipAllowlist.cidrs
      }),
      async (req: Request, res: Response) => {
        try {
          const stats = await prometheusMetrics.getStats();
          res.json(stats);
        } catch (error) {
          logger.error('Metrics stats error', { error });
          res.status(500).json({ error: 'Internal server error' });
        }
      }
    );

    logger.info('Observability routes configured');
  }

  /**
   * Configura circuit breakers
   */
  private async setupCircuitBreakers(): Promise<void> {
    for (const dep of this.config.circuitBreaker.dependencies) {
      const cbMiddleware = createCircuitBreakerMiddleware({
        errorRateWindow: 2 * 60 * 1000, // 2 minutos
        errorRateThreshold: this.config.env.cbErrorRateLimit,
        openForSeconds: this.config.env.cbOpenSecs,
        backoff: { baseMs: 300, maxMs: 3000, jitter: true },
        onOpen: (dependency: string) => {
          logger.warn(`Circuit breaker opened for ${dependency}`);
          metrics.circuitBreakerOpen(dependency, 'error_rate_exceeded');
          metrics.circuitBreakerState(dependency, 'open');
          
          // TODO: Implementar notificação Telegram
        },
        onClose: (dependency: string) => {
          logger.info(`Circuit breaker closed for ${dependency}`);
          metrics.circuitBreakerState(dependency, 'closed');
          
          // TODO: Implementar notificação Telegram
        }
      });

      // Registrar circuit breaker para as ferramentas correspondentes
      circuitBreakerService.registerDependency(dep.name, dep.matchTools, cbMiddleware);
    }

    logger.info('Circuit breakers configured', {
      dependencies: this.config.circuitBreaker.dependencies.map(d => d.name)
    });
  }

  /**
   * Obtém estatísticas do módulo
   */
  public async getStats(): Promise<any> {
    if (!this.initialized) {
      throw new Error('Module not initialized');
    }

    return {
      module: 'marlie-security',
      initialized: this.initialized,
      timestamp: new Date().toISOString(),
      config: {
        timezone: this.config.env.timezone,
        piiMasking: this.config.security.piiMasking,
        middlewareCount: this.config.middleware.length,
        dependencies: this.config.circuitBreaker.dependencies.length
      },
      services: {
        hmacVerification: hmacVerificationService.getStats(),
        rateLimiting: advancedRateLimitService.getStats(),
        secretRotation: secretRotationService.getStats(),
        circuitBreaker: circuitBreakerService.getStats()
      },
      metrics: await prometheusMetrics.getStats()
    };
  }

  /**
   * Executa health check completo
   */
  public async healthCheck(): Promise<any> {
    if (!this.initialized) {
      throw new Error('Module not initialized');
    }

    const results = await healthCheckService.checkAll({
      redis: !!this.redis,
      postgresql: !!this.pgPool,
      evolution: this.config.env.evolutionHealthUrl,
      trinks: this.config.env.trinksHealthUrl
    });

    const overall = healthCheckService.calculateOverallStatus(results);

    return {
      module: 'marlie-security',
      status: overall.status,
      timestamp: new Date().toISOString(),
      summary: overall.summary,
      services: results
    };
  }

  /**
   * Rotaciona secret HMAC
   */
  public async rotateHmacSecret(newSecret: string): Promise<any> {
    if (!this.initialized) {
      throw new Error('Module not initialized');
    }

    const result = secretRotationService.rotateSecret(newSecret);
    
    if (result.success) {
      // Atualizar configuração interna
      this.config.env.hmacSecretPrev = this.config.env.hmacSecretCurrent;
      this.config.env.hmacSecretCurrent = newSecret;
      
      logger.info('HMAC secret rotated via module API');
    }
    
    return result;
  }

  /**
   * Para o módulo e limpa recursos
   */
  public async shutdown(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    try {
      // Limpar intervalos e timers
      advancedRateLimitService.cleanup();
      circuitBreakerService.cleanup();
      
      // Reset métricas
      prometheusMetrics.reset();
      
      this.initialized = false;
      logger.info('Marlie Security module shutdown completed');
    } catch (error) {
      logger.error('Error during module shutdown', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }
}

/**
 * Factory function para criar e configurar o módulo
 */
export function createMarlieSecurityModule(
  app: Express, 
  config: MarlieSecurityConfig,
  dependencies?: { pgPool: Pool; redis: Redis }
): MarlieSecurityModule {
  const module = new MarlieSecurityModule(app, config);
  
  if (dependencies) {
    module.setDependencies(dependencies.pgPool, dependencies.redis);
  }
  
  return module;
}

/**
 * Configuração padrão do módulo
 */
export function getDefaultConfig(): Partial<MarlieSecurityConfig> {
  return {
    env: {
      timezone: 'America/Bahia',
      rateIpRpm: 120,
      ratePhoneRpm: 30,
      banWindowMin: 15,
      cbErrorRateLimit: 0.25,
      cbOpenSecs: 60
    },
    security: {
      auth: 'bearer',
      ipAllowlist: {
        enabled: true,
        cidrs: []
      },
      piiMasking: true,
      piiPatterns: [
        { regex: '(?:\\+?55)?\\s?\\(?\\d{2}\\)?\\s?\\d{4,5}-?\\d{4}' }, // Telefone BR
        { regex: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}' } // Email
      ]
    },
    observability: {
      prometheus: {
        httpEndpoint: '/metrics',
        labels: { app: 'marlie', component: 'security' },
        counters: [
          { name: 'auth_denied_total', help: 'Acessos negados' },
          { name: 'hmac_invalid_total', help: 'Assinaturas HMAC inválidas' },
          { name: 'rate_limit_hits_total', help: 'Rate-limit acionado', labels: ['key'] },
          { name: 'temp_bans_total', help: 'Banimentos aplicados', labels: ['reason'] },
          { name: 'cb_open_total', help: 'Circuit-breaker aberto', labels: ['dep'] }
        ]
      }
    },
    circuitBreaker: {
      dependencies: [
        { name: 'trinks', matchTools: ['trinks.*'] },
        { name: 'evolution', matchTools: ['evolution.*'] }
      ],
      notify: {
        onOpen: {
          channel: 'telegram',
          template: '⚠️ Breaker {{dep}} ABERTO.'
        },
        onClose: {
          channel: 'telegram',
          template: '✅ Breaker {{dep}} FECHADO.'
        }
      }
    }
  };
}

/**
 * Exportações principais
 */
export {
  // Serviços
  hmacVerificationService,
  advancedRateLimitService,
  piiMaskingService,
  circuitBreakerService,
  adminAuthService,
  secretRotationService,
  healthCheckService,
  prometheusMetrics,
  
  // Utilitários
  healthChecks,
  metrics
};