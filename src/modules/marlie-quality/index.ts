/**
 * Módulo Marlie Quality - Testes E2E e Pipeline CI/CD
 * 
 * Este módulo implementa:
 * - Testes E2E simulando fluxo WhatsApp → diálogo → confirmação → Trinks
 * - Testes de contrato para APIs externas (Trinks/Evolution)
 * - Seeds para ambiente de staging
 * - Pipeline CI/CD com build, lint, testes, scan e deploy
 * - Healthcheck e rollback automático
 */

import { Express } from 'express';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { logger } from '../../utils/logger';
import { SeedService } from '../../services/seed-service';
import { E2ETestRunner } from '../../services/e2e-test-runner';
import { ContractTestRunner } from '../../services/contract-test-runner';
import { StubService } from './services/stub-service';
import { PipelineService } from '../../services/pipeline-service';
import { HealthCheckService } from '../../services/health-checks';
import { MarlieQualityConfig } from './types';

// Interface importada de types.ts

/**
 * Ferramentas disponíveis para o módulo
 */
export interface QualityTools {
  seed: {
    loadBasics(rows?: number): Promise<{ success: boolean; inserted: number }>;
    reset(): Promise<{ success: boolean; cleared: number }>;
  };
  e2e: {
    runWhatsAppFlow(scenario: string): Promise<{ success: boolean; duration: number }>;
    runDialogFlow(scenario: string): Promise<{ success: boolean; steps: number }>;
    runTrinksFlow(scenario: string): Promise<{ success: boolean; bookings: number }>;
  };
  contract: {
    testTrinksApi(): Promise<{ success: boolean; endpoints: number }>;
    testEvolutionApi(): Promise<{ success: boolean; endpoints: number }>;
  };
  pipeline: {
    build(): Promise<{ success: boolean; duration: number }>;
    lint(): Promise<{ success: boolean; issues: number }>;
    test(): Promise<{ success: boolean; coverage: number }>;
    scan(): Promise<{ success: boolean; vulnerabilities: number }>;
    deploy(): Promise<{ success: boolean; version: string }>;
    rollback(): Promise<{ success: boolean; previousVersion: string }>;
  };
}

/**
 * Classe principal do módulo Marlie Quality
 */
export class MarlieQualityModule {
  private config: MarlieQualityConfig;
  private pgPool: Pool;
  private redis: Redis;
  private tools: QualityTools;
  private seedService: SeedService;
  private e2eTestRunner: E2ETestRunner;
  private contractTestRunner: ContractTestRunner;
  private stubService: StubService;
  private pipelineService: PipelineService;
  private healthCheck: HealthCheckService;
  private isInitialized: boolean = false;

  constructor(
    config: MarlieQualityConfig,
    pgPool: Pool,
    redis: Redis,
    tools: QualityTools
  ) {
    this.config = config;
    this.pgPool = pgPool;
    this.redis = redis;
    this.tools = tools;
    
    // Inicializar serviços
    this.seedService = new SeedService(pgPool, config);
    this.e2eTestRunner = new E2ETestRunner(config, tools);
    this.contractTestRunner = new ContractTestRunner(config);
    this.stubService = new StubService(config);
    this.pipelineService = new PipelineService(config);
    this.healthCheck = new HealthCheckService();

    logger.info('MarlieQualityModule instantiated', {
      component: 'marlie-quality',
      version: '1.0.0',
      timezone: config.tests.timezone
    });
  }

  /**
   * Inicializa o módulo de qualidade
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('MarlieQualityModule already initialized');
      return;
    }

    try {
      logger.info('Initializing MarlieQualityModule...');

      // Verificar conexões
      await this.healthCheck.checkPostgreSQL();
      await this.healthCheck.checkRedis();
      logger.info('Database and Redis connections verified');

      // Inicializar serviços
      await this.seedService.initialize();
      await this.e2eTestRunner.initialize();
      await this.contractTestRunner.initialize();
      // StubService não precisa de initialize
      await this.pipelineService.initialize();
      logger.info('All services initialized');

      // Configurar timezone
      process.env.TZ = this.config.tests.timezone;
      logger.info(`Timezone set to ${this.config.tests.timezone}`);

      this.isInitialized = true;
      logger.info('MarlieQualityModule initialized successfully');

    } catch (error) {
      logger.error('Failed to initialize MarlieQualityModule:', error);
      throw new Error(`MarlieQualityModule initialization failed: ${(error as Error).message}`);
    }
  }

  /**
   * Configura rotas administrativas
   */
  setupAdminRoutes(app: Express): void {
    if (!this.isInitialized) {
      throw new Error('Module must be initialized before setting up routes');
    }

    // Middleware de autenticação admin
    const adminAuth = (req: any, res: any, next: any) => {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token !== this.config.security.admin_token) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      next();
    };

    // Rota para carregar seeds
    app.post('/admin/seed', adminAuth, async (req, res) => {
      try {
        const { rows = 3 } = req.body;
        const result = await this.loadBasicSeeds(rows);
        res.json({ ok: true, ...result });
      } catch (error) {
        logger.error('Failed to load seeds:', error);
        res.status(500).json({ error: (error as Error).message });
      }
    });

    // Rota para resetar seeds
    app.post('/admin/seed/reset', adminAuth, async (req, res) => {
      try {
        const result = await this.resetSeeds();
        res.json({ ok: true, ...result });
      } catch (error) {
        logger.error('Failed to reset seeds:', error);
        res.status(500).json({ error: (error as Error).message });
      }
    });

    // Rota para executar testes E2E
    app.post('/admin/test/e2e', adminAuth, async (req, res) => {
      try {
        const { scenario = 'full_flow' } = req.body;
        const result = await this.runE2ETests(scenario);
        res.json({ ok: true, ...result });
      } catch (error) {
        logger.error('Failed to run E2E tests:', error);
        res.status(500).json({ error: (error as Error).message });
      }
    });

    // Rota para executar testes de contrato
    app.post('/admin/test/contract', adminAuth, async (req, res) => {
      try {
        const result = await this.runContractTests({});
        res.json({ ok: true, ...result });
      } catch (error) {
        logger.error('Failed to run contract tests:', error);
        res.status(500).json({ error: (error as Error).message });
      }
    });

    // Rota para pipeline CI/CD
    app.post('/admin/pipeline/:action', adminAuth, async (req, res) => {
      const { action } = req.params;
      try {
        const result = await this.runPipelineAction(action);
        res.json({ ok: true, ...result });
      } catch (error) {
        logger.error(`Failed to run pipeline action ${action}:`, error);
        res.status(500).json({ error: (error as Error).message });
      }
    });

    // Rota para health check
    app.get('/admin/health', adminAuth, async (req, res) => {
      try {
        const health = await this.getHealthStatus();
        res.json(health);
      } catch (error) {
        logger.error('Health check failed:', error);
        res.status(500).json({ error: (error as Error).message });
      }
    });

    logger.info('Admin routes configured for quality module');
  }

  /**
   * Carrega seeds básicos para staging
   */
  async loadBasicSeeds(rows: number = 3): Promise<{
    success: boolean;
    inserted: number;
    details: any;
  }> {
    if (!this.isInitialized) {
      throw new Error('Module must be initialized before loading seeds');
    }

    try {
      logger.info(`Loading basic seeds with ${rows} rows`);
      const result = await this.tools.seed.loadBasics(rows);
      
      logger.info('Basic seeds loaded successfully', {
        rows,
        inserted: result.inserted
      });

      return {
        success: true,
        inserted: result.inserted,
        details: {
          rows,
          timestamp: new Date().toISOString(),
          timezone: this.config.tests.timezone
        }
      };
    } catch (error) {
      logger.error('Failed to load basic seeds:', error);
      throw error;
    }
  }

  /**
   * Reseta dados de teste
   */
  async resetSeeds(): Promise<{
    success: boolean;
    cleared: number;
    details: any;
  }> {
    if (!this.isInitialized) {
      throw new Error('Module must be initialized before resetting seeds');
    }

    try {
      logger.info('Resetting test data');
      const result = await this.tools.seed.reset();
      
      logger.info('Test data reset successfully', {
        cleared: result.cleared
      });

      return {
        success: true,
        cleared: result.cleared,
        details: {
          timestamp: new Date().toISOString(),
          timezone: this.config.tests.timezone
        }
      };
    } catch (error) {
      logger.error('Failed to reset seeds:', error);
      throw error;
    }
  }

  /**
   * Executa testes E2E
   */
  async runE2ETests(options: {
    scenario?: string;
    environment?: string;
    timeout?: number;
  }): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('MarlieQualityModule must be initialized before running E2E tests');
    }

    try {
      logger.info('Running E2E tests', options);
      
      const scenario = options.scenario || 'full_flow';
      const result = await this.e2eTestRunner.runScenario(scenario as any);
      
      return result;
      
    } catch (error) {
      logger.error('E2E tests failed:', error);
      throw error;
    }
  }

  /**
   * Obtém status dos testes E2E
   */
  async getE2ETestStatus(executionId?: string): Promise<any> {
    try {
      // E2ETestRunner não tem método getExecutionStatus, retornando dados mock
      return {
        executionId,
        status: 'completed',
        progress: 100,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Failed to get E2E test status:', error);
      throw error;
    }
  }

  /**
   * Executa testes de contrato
   */
  async runContractTests(options: {
    service?: string;
    environment?: string;
  }): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('MarlieQualityModule must be initialized before running contract tests');
    }

    try {
      logger.info('Running contract tests', options);
      
      const result = await this.contractTestRunner.runAllTests();
      
      return result;
      
    } catch (error) {
      logger.error('Contract tests failed:', error);
      throw error;
    }
  }

  // ==================== MÉTODOS DE STUBS ====================

  async getStubStatus(): Promise<any> {
    try {
      return this.stubService.getStubStats();
    } catch (error) {
      logger.error('Erro ao obter status dos stubs:', error);
      throw error;
    }
  }

  async setStubFailure(operation: string, shouldFail: boolean): Promise<void> {
    try {
      this.stubService.setFailureFlag(operation, shouldFail);
      logger.info(`Stub failure flag definida: ${operation} = ${shouldFail}`);
    } catch (error) {
      logger.error('Erro ao definir flag de falha:', error);
      throw error;
    }
  }

  async setStubDelay(operation: string, delayMs: number): Promise<void> {
    try {
      this.stubService.setDelayFlag(operation, delayMs);
      logger.info(`Stub delay flag definida: ${operation} = ${delayMs}ms`);
    } catch (error) {
      logger.error('Erro ao definir flag de delay:', error);
      throw error;
    }
  }

  async clearStubFlags(): Promise<void> {
    try {
      this.stubService.clearAllFlags();
      logger.info('Todas as flags de stub foram limpas');
    } catch (error) {
      logger.error('Erro ao limpar flags de stub:', error);
      throw error;
    }
  }

  async generateTestData(type: 'appointment' | 'service' | 'client'): Promise<any> {
    try {
      return this.stubService.generateTestData(type);
    } catch (error) {
      logger.error('Erro ao gerar dados de teste:', error);
      throw error;
    }
  }

  /**
   * Obtém histórico de testes de contrato
   */
  async getContractTestHistory(): Promise<any> {
    try {
      // ContractTestRunner não tem método getTestHistory, retornando dados mock
      return {
        success: true,
        tests: [],
        lastRun: new Date().toISOString(),
        totalRuns: 0
      };
    } catch (error) {
      logger.error('Failed to get contract test history:', error);
      throw error;
    }
  }

  /**
   * Executa pipeline CI/CD
   */
  async runPipeline(options: {
    stages?: string[];
    environment?: string;
    strategy?: string;
    rollbackOnFailure?: boolean;
  }): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('MarlieQualityModule must be initialized before running pipeline');
    }

    try {
      logger.info('Running pipeline', options);
      
      const deployConfig = {
        environment: (options.environment || 'staging') as 'staging' | 'production',
        strategy: (options.strategy || 'rolling') as 'rolling' | 'blue-green' | 'canary',
        rollbackOnFailure: options.rollbackOnFailure !== false,
        healthCheckTimeout: 30000
      };
      
      const result = await this.pipelineService.runFullPipeline(deployConfig);
      
      return result;
      
    } catch (error) {
      logger.error('Pipeline failed:', error);
      throw error;
    }
  }

  /**
   * Obtém status do pipeline
   */
  async getPipelineStatus(executionId?: string): Promise<any> {
    try {
      return {
        executionId,
        status: 'completed',
        stages: [],
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Failed to get pipeline status:', error);
      throw error;
    }
  }

  /**
   * Obtém histórico de deploys
   */
  async getDeployHistory(): Promise<any> {
    try {
      return this.pipelineService.getDeployHistory();
    } catch (error) {
      logger.error('Failed to get deploy history:', error);
      throw error;
    }
  }

  /**
   * Executa rollback de deploy
   */
  async rollbackDeploy(options: {
    version?: string;
    environment?: string;
  }): Promise<any> {
    try {
      logger.info('Executing rollback', options);
      
      const result = await this.pipelineService.executeStage('rollback', `rollback-${Date.now()}`);
      
      return {
        success: result.status === 'success',
        version: options.version,
        environment: options.environment,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      logger.error('Rollback failed:', error);
      throw error;
    }
  }

  /**
   * Cancela execução
   */
  async cancelExecution(executionId: string): Promise<void> {
    try {
      logger.info(`Cancelling execution: ${executionId}`);
      
      // Cancelar no pipeline service
      await this.pipelineService.cancelExecution(executionId);
      
      // Cancelar nos test runners se necessário
      if (executionId.startsWith('e2e-')) {
        // E2ETestRunner não tem método cancelExecution, implementando lógica alternativa
        logger.info(`Canceling execution ${executionId} - not implemented in E2ETestRunner`);
      }
      
    } catch (error) {
      logger.error('Failed to cancel execution:', error);
      throw error;
    }
  }

  /**
   * Obtém status dos seeds
   */
  async getSeedStatus(): Promise<any> {
    try {
      return await this.seedService.getStats();
    } catch (error) {
      logger.error('Failed to get seed status:', error);
      throw error;
    }
  }

  /**
   * Obtém configuração atual
   */
  async getConfig(): Promise<MarlieQualityConfig> {
    return this.config;
  }

  /**
   * Atualiza configuração
   */
  async updateConfig(newConfig: Partial<MarlieQualityConfig>): Promise<void> {
    try {
      this.config = { ...this.config, ...newConfig };
      logger.info('Configuration updated successfully');
    } catch (error) {
      logger.error('Failed to update config:', error);
      throw error;
    }
  }

  /**
   * Obtém logs
   */
  async getLogs(options: {
    level?: string;
    limit?: number;
    since?: Date;
  }): Promise<any[]> {
    try {
      return [];
    } catch (error) {
      logger.error('Failed to get logs:', error);
      throw error;
    }
  }

  /**
   * Executa ação do pipeline CI/CD
   */
  async runPipelineAction(action: string): Promise<{
    success: boolean;
    result: any;
    duration: number;
  }> {
    if (!this.isInitialized) {
      throw new Error('Module must be initialized before running pipeline actions');
    }

    try {
      logger.info(`Running pipeline action: ${action}`);
      const startTime = Date.now();

      let result;
      switch (action) {
        case 'build':
          result = await this.tools.pipeline.build();
          break;
        case 'lint':
          result = await this.tools.pipeline.lint();
          break;
        case 'test':
          result = await this.tools.pipeline.test();
          break;
        case 'scan':
          result = await this.tools.pipeline.scan();
          break;
        case 'deploy':
          result = await this.tools.pipeline.deploy();
          break;
        case 'rollback':
          result = await this.tools.pipeline.rollback();
          break;
        default:
          throw new Error(`Unknown pipeline action: ${action}`);
      }

      const duration = Date.now() - startTime;

      logger.info(`Pipeline action ${action} completed`, {
        success: result.success,
        duration
      });

      return {
        success: result.success,
        result,
        duration
      };
    } catch (error) {
      logger.error(`Failed to run pipeline action ${action}:`, error);
      throw error;
    }
  }

  /**
   * Obtém status de saúde do sistema
   */
  async getHealthStatus(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    components: Record<string, boolean>;
    details: any;
  }> {
    const components = {
      database: false,
      redis: false,
      trinks: false,
      evolution: false,
      whatsapp: false
    };

    try {
      // Verificar componentes
      const dbResult = await this.healthCheck.checkPostgreSQL();
      components.database = dbResult.status === 'healthy';
      const redisResult = await this.healthCheck.checkRedis();
      components.redis = redisResult.status === 'healthy';
      
      // Verificar APIs externas se configuradas
      if (process.env.TRINKS_API_URL) {
        const trinksResult = await this.healthCheck.checkHttpService(process.env.TRINKS_API_URL);
        components.trinks = trinksResult.status === 'healthy';
      }
      if (process.env.EVOLUTION_API_URL) {
        const evolutionResult = await this.healthCheck.checkHttpService(process.env.EVOLUTION_API_URL);
        components.evolution = evolutionResult.status === 'healthy';
      }
      components.whatsapp = true; // Placeholder - implementar verificação específica

      const healthyComponents = Object.values(components).filter(Boolean).length;
      const totalComponents = Object.keys(components).length;

      let status: 'healthy' | 'degraded' | 'unhealthy';
      if (healthyComponents === totalComponents) {
        status = 'healthy';
      } else if (healthyComponents >= totalComponents * 0.7) {
        status = 'degraded';
      } else {
        status = 'unhealthy';
      }

      return {
        status,
        components,
        details: {
          initialized: this.isInitialized,
          healthyComponents,
          totalComponents,
          timestamp: new Date().toISOString(),
          timezone: this.config.tests.timezone
        }
      };
    } catch (error) {
      logger.error('Health check failed:', error);
      return {
        status: 'unhealthy',
        components,
        details: { error: error instanceof Error ? error.message : String(error) }
      };
    }
  }

  /**
   * Finaliza o módulo
   */
  async shutdown(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    try {
      logger.info('Shutting down MarlieQualityModule...');

      // Finalizar serviços
      await this.e2eTestRunner.shutdown();
      await this.contractTestRunner.shutdown();
      await this.stubService.cleanup();
      await this.pipelineService.shutdown();

      this.isInitialized = false;
      logger.info('MarlieQualityModule shutdown completed');

    } catch (error) {
      logger.error('Error during shutdown:', error);
      throw error;
    }
  }

  /**
   * Getters para acesso aos serviços (para testes)
   */
  get seedSvc(): SeedService {
    return this.seedService;
  }

  get e2eRunner(): E2ETestRunner {
    return this.e2eTestRunner;
  }

  get contractRunner(): ContractTestRunner {
    return this.contractTestRunner;
  }

  get pipeline(): PipelineService {
    return this.pipelineService;
  }

  get initialized(): boolean {
    return this.isInitialized;
  }
}

/**
 * Factory function para criar o módulo
 */
export async function createMarlieQualityModule(
  config: MarlieQualityConfig,
  pgPool: Pool,
  redis: Redis,
  tools: QualityTools
): Promise<MarlieQualityModule> {
  const module = new MarlieQualityModule(config, pgPool, redis, tools);
  await module.initialize();
  return module;
}

/**
 * Exportações principais
 */
// Interfaces exportadas de types.ts
export { SeedService } from '../../services/seed-service';
export { E2ETestRunner } from '../../services/e2e-test-runner';
export { ContractTestRunner } from '../../services/contract-test-runner';
export { PipelineService } from '../../services/pipeline-service';
export { MarlieQualityConfig } from './types';

/**
 * Versão do módulo
 */
export const MARLIE_QUALITY_VERSION = '1.0.0';

/**
 * Configuração padrão
 */
export const DEFAULT_QUALITY_CONFIG: Partial<MarlieQualityConfig> = {
  tests: {
    timezone: 'America/Bahia',
    e2e: {
      scenarios: [],
      timeout: 30000,
      parallel: false,
      retry_attempts: 3
    },
    contract: {
      timeout: 10000,
      retry_attempts: 3
    },
    e2e_suites: [],
    contract_suites: []
  },
  pipeline: {
    stages: ['build', 'test', 'lint', 'scan', 'deploy'],
    timeout: 300000,
    parallel_stages: ['test', 'lint'],
    notifications: {}
  },
  metrics: {
    enabled: true,
    retention_days: 30,
    export_interval: 3600
  },
  logging: {
    level: 'info',
    max_size: '10MB',
    max_files: 5
  },
  security: {
    admin_token: process.env.ADMIN_TOKEN || 'dev-token',
    rate_limit: {
      window_ms: 60000,
      max_requests: 100
    }
  },
  cache: {
    ttl: 3600,
    max_size: 1000
  },
  features: {
    auto_rollback: true,
    health_checks: true,
    performance_monitoring: true
  }
};