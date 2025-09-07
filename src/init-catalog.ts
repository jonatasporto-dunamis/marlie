/**
 * Inicializador do Módulo Marlie-Catalog
 * 
 * Este arquivo é responsável por inicializar e gerenciar o ciclo de vida
 * do módulo de sincronização e normalização do catálogo Trinks.
 * 
 * @author SyncBelle Dev
 * @version 1.0
 */

import { Logger } from './utils/logger';
import { CatalogSyncService } from './services/catalog-sync';
import { CatalogTrinksService } from './services/catalog-trinks-service';
import { CatalogScheduler } from './services/catalog-scheduler';
import { getCatalogDisambiguationService } from './services/catalog-disambiguation-service';
import { getDisambiguationMiddleware } from './middleware/catalog-disambiguation-middleware';
import { 
  getCatalogStateMachineIntegration,
  initializeCatalogStateMachineIntegration,
  cleanupCatalogStateMachineIntegration
} from './integrations/catalog-state-machine';
import { createClient } from 'redis';
import { Pool } from 'pg';
import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import { Request, Response, NextFunction } from 'express';

// Interfaces para configuração
interface CatalogConfig {
  module: {
    name: string;
    version: string;
    language: string;
    description: string;
  };
  sync: {
    schedule_cron: string;
    snapshot_cron: string;
    cleanup_cron: string;
    backfill_on_boot: boolean;
    scheduler_enabled: boolean;
    page_size: number;
    max_concurrent_requests: number;
    timeout_ms: number;
    lock_ttl_seconds: number;
  };
  search: {
    default_top_n: number;
    max_results: number;
    similarity_threshold: number;
    popularity_days: number;
  };
  monitoring: {
    metrics: {
      enabled: boolean;
      interval_seconds: number;
    };
    health_checks: {
      enabled: boolean;
      interval_seconds: number;
    };
  };
}

interface CatalogInitializationResult {
  success: boolean;
  message: string;
  services?: {
    syncService: CatalogSyncService;
    trinksService: CatalogTrinksService;
    scheduler: CatalogScheduler;
  };
  config?: CatalogConfig;
  error?: Error;
}

// Singleton para gerenciar o estado do módulo
class CatalogModule {
  private static instance: CatalogModule;
  private initialized = false;
  private config: CatalogConfig | null = null;
  private syncService: CatalogSyncService | null = null;
  private trinksService: CatalogTrinksService | null = null;
  private scheduler: CatalogScheduler | null = null;
  private disambiguationService: any = null;
  private disambiguationMiddleware: any = null;
  private stateMachineIntegration: any = null;
  private logger: Logger;
  private dbPool: Pool | null = null;
  private redisClient: any = null;

  private constructor() {
    this.logger = new Logger('CatalogModule');
  }

  public static getInstance(): CatalogModule {
    if (!CatalogModule.instance) {
      CatalogModule.instance = new CatalogModule();
    }
    return CatalogModule.instance;
  }

  /**
   * Inicializa o módulo de catálogo
   */
  public async initialize(): Promise<CatalogInitializationResult> {
    try {
      this.logger.info('Iniciando módulo Marlie-Catalog...');

      // Verificar se o módulo está habilitado
      if (!this.isModuleEnabled()) {
        return {
          success: false,
          message: 'Módulo de catálogo desabilitado via CATALOG_MODULE_ENABLED=false'
        };
      }

      // Carregar configuração
      await this.loadConfiguration();

      // Verificar dependências
      await this.checkDependencies();

      // Inicializar serviços
      await this.initializeServices();

      // Executar backfill se configurado
      if (this.config?.sync.backfill_on_boot) {
        await this.executeBackfill();
      }

      // Inicializar serviços de desambiguação
      this.disambiguationService = getCatalogDisambiguationService();
      this.disambiguationMiddleware = getDisambiguationMiddleware();
      
      this.logger.info('Serviços de desambiguação inicializados');
      
      // Inicializar integração com máquina de estados
      await initializeCatalogStateMachineIntegration();
      this.stateMachineIntegration = getCatalogStateMachineIntegration();
      
      this.logger.info('Integração com máquina de estados inicializada');

      // Iniciar scheduler se habilitado
      if (this.config?.sync.scheduler_enabled) {
        await this.startScheduler();
      }

      this.initialized = true;
      this.logger.info('Módulo Marlie-Catalog inicializado com sucesso');

      return {
        success: true,
        message: 'Módulo de catálogo inicializado com sucesso',
        services: {
          syncService: this.syncService!,
          trinksService: this.trinksService!,
          scheduler: this.scheduler!
        },
        config: this.config!
      };

    } catch (error) {
      this.logger.error('Erro ao inicializar módulo de catálogo:', error);
      return {
        success: false,
        message: `Erro na inicialização: ${error instanceof Error ? error.message : 'Erro desconhecido'}`,
        error: error instanceof Error ? error : new Error('Erro desconhecido')
      };
    }
  }

  /**
   * Desliga o módulo de catálogo
   */
  public async shutdown(): Promise<void> {
    try {
      this.logger.info('Desligando módulo Marlie-Catalog...');

      // Parar scheduler
      if (this.scheduler) {
        await this.scheduler.stop();
      }

      // Limpar integração com máquina de estados
      if (this.stateMachineIntegration) {
        await cleanupCatalogStateMachineIntegration();
        this.logger.info('Integração com máquina de estados limpa');
      }
      
      // Limpar serviços de desambiguação
      if (this.disambiguationService) {
        await this.disambiguationService.clearCache();
      }
      
      if (this.disambiguationMiddleware) {
        await this.disambiguationMiddleware.clearAllSessions();
      }
      
      this.logger.info('Serviços de desambiguação limpos');

      // Fechar conexões
      if (this.redisClient) {
        await this.redisClient.quit();
      }

      if (this.dbPool) {
        await this.dbPool.end();
      }

      this.initialized = false;
      this.logger.info('Módulo Marlie-Catalog desligado com sucesso');

    } catch (error) {
      this.logger.error('Erro ao desligar módulo de catálogo:', error);
      throw error;
    }
  }

  /**
   * Verifica se o módulo está habilitado
   */
  private isModuleEnabled(): boolean {
    return process.env.CATALOG_MODULE_ENABLED === 'true';
  }

  /**
   * Carrega a configuração do arquivo YAML
   */
  private async loadConfiguration(): Promise<void> {
    try {
      const configPath = process.env.CATALOG_CONFIG_PATH || 
        path.join(__dirname, 'config', 'catalog-config.yaml');
      
      const configContent = await fs.readFile(configPath, 'utf8');
      this.config = yaml.load(configContent) as CatalogConfig;
      
      this.logger.info('Configuração carregada:', {
        module: this.config.module.name,
        version: this.config.module.version
      });

    } catch (error) {
      throw new Error(`Erro ao carregar configuração: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
    }
  }

  /**
   * Verifica dependências necessárias
   */
  private async checkDependencies(): Promise<void> {
    const errors: string[] = [];

    // Verificar variáveis de ambiente obrigatórias
    const requiredEnvVars = [
      'TRINKS_CATALOG_API_URL',
      'TRINKS_CATALOG_API_TOKEN',
      'DATABASE_URL',
      'REDIS_URL'
    ];

    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar]) {
        errors.push(`Variável de ambiente obrigatória não encontrada: ${envVar}`);
      }
    }

    // Testar conexão com banco de dados
    try {
      this.dbPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
      });
      
      await this.dbPool.query('SELECT 1');
      this.logger.info('Conexão com banco de dados verificada');

    } catch (error) {
      errors.push(`Erro na conexão com banco de dados: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
    }

    // Testar conexão com Redis
    try {
      this.redisClient = createClient({
        url: process.env.REDIS_URL
      });
      
      await this.redisClient.connect();
      await this.redisClient.ping();
      this.logger.info('Conexão com Redis verificada');

    } catch (error) {
      errors.push(`Erro na conexão com Redis: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
    }

    if (errors.length > 0) {
      throw new Error(`Dependências não atendidas:\n${errors.join('\n')}`);
    }
  }

  /**
   * Inicializa os serviços do módulo
   */
  private async initializeServices(): Promise<void> {
    // Inicializar serviço Trinks
    this.trinksService = new CatalogTrinksService({
      baseURL: process.env.TRINKS_CATALOG_API_URL!,
      token: process.env.TRINKS_CATALOG_API_TOKEN!,
      timeout: this.config?.sync.timeout_ms || 30000
    });

    // Inicializar serviço de sincronização
    this.syncService = new CatalogSyncService(
      this.dbPool!,
      this.redisClient,
      this.trinksService
    );

    // Inicializar scheduler
    this.scheduler = new CatalogScheduler(
      this.syncService,
      {
        syncCron: this.config?.sync.schedule_cron || '15 */1 * * *',
        snapshotCron: this.config?.sync.snapshot_cron || '0 2 * * *',
        cleanupCron: this.config?.sync.cleanup_cron || '0 3 * * 0',
        enabled: this.config?.sync.scheduler_enabled || true
      }
    );

    this.logger.info('Serviços inicializados com sucesso');
  }

  /**
   * Executa backfill inicial
   */
  private async executeBackfill(): Promise<void> {
    try {
      this.logger.info('Executando backfill inicial do catálogo...');
      
      const watermark = process.env.CATALOG_WATERMARK || '1970-01-01T00:00:00Z';
      await this.syncService!.triggerFullSync(watermark);
      
      this.logger.info('Backfill inicial concluído');

    } catch (error) {
      this.logger.error('Erro no backfill inicial:', error);
      throw error;
    }
  }

  /**
   * Inicia o scheduler
   */
  private async startScheduler(): Promise<void> {
    try {
      await this.scheduler!.start();
      this.logger.info('Scheduler iniciado com sucesso');

    } catch (error) {
      this.logger.error('Erro ao iniciar scheduler:', error);
      throw error;
    }
  }

  /**
   * Getters para acessar os serviços
   */
  public getSyncService(): CatalogSyncService | null {
    return this.syncService;
  }

  public getTrinksService(): CatalogTrinksService | null {
    return this.trinksService;
  }

  public getScheduler(): CatalogScheduler | null {
    return this.scheduler;
  }

  public getConfig(): CatalogConfig | null {
    return this.config;
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Obtém status de saúde do módulo
   */
  public async getHealthStatus(): Promise<any> {
    if (!this.initialized) {
      return {
        status: 'unhealthy',
        message: 'Módulo não inicializado',
        timestamp: new Date().toISOString()
      };
    }

    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        database: 'unknown',
        redis: 'unknown',
        trinks_api: 'unknown',
        scheduler: 'unknown',
        disambiguationService: this.disambiguationService ? 'initialized' : 'not_initialized',
        disambiguationMiddleware: this.disambiguationMiddleware ? 'initialized' : 'not_initialized',
        stateMachineIntegration: this.stateMachineIntegration ? 'initialized' : 'not_initialized'
      },
      config: {
        module: this.config?.module.name,
        version: this.config?.module.version
      }
    };

    // Verificar banco de dados
    try {
      await this.dbPool?.query('SELECT 1');
      health.services.database = 'healthy';
    } catch {
      health.services.database = 'unhealthy';
      health.status = 'degraded';
    }

    // Verificar Redis
    try {
      await this.redisClient?.ping();
      health.services.redis = 'healthy';
    } catch {
      health.services.redis = 'unhealthy';
      health.status = 'degraded';
    }

    // Verificar API Trinks
    try {
      await this.trinksService?.checkHealth();
      health.services.trinks_api = 'healthy';
    } catch {
      health.services.trinks_api = 'unhealthy';
      health.status = 'degraded';
    }

    // Verificar scheduler
    health.services.scheduler = this.scheduler?.isRunning() ? 'healthy' : 'stopped';

    return health;
  }
}

// Funções de conveniência para uso externo

/**
 * Obtém a instância singleton do módulo de catálogo
 */
export function getCatalogModule(): CatalogModule {
  return CatalogModule.getInstance();
}

/**
 * Inicializa o módulo de catálogo
 */
export async function initializeCatalog(): Promise<CatalogInitializationResult> {
  return await getCatalogModule().initialize();
}

/**
 * Desliga o módulo de catálogo
 */
export async function shutdownCatalog(): Promise<void> {
  await getCatalogModule().shutdown();
}

/**
 * Middleware Express para verificar se o módulo está inicializado
 */
export function catalogMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const module = getCatalogModule();
    
    if (!module.isInitialized()) {
      return res.status(503).json({
        error: 'Módulo de catálogo não inicializado',
        message: 'O serviço está temporariamente indisponível'
      });
    }
    
    // Adicionar serviços ao request para uso nas rotas
    (req as any).catalogServices = {
      syncService: module.getSyncService(),
      trinksService: module.getTrinksService(),
      scheduler: module.getScheduler(),
      disambiguationService: module.disambiguationService,
      disambiguationMiddleware: module.disambiguationMiddleware,
      stateMachineIntegration: module.stateMachineIntegration,
      config: module.getConfig()
    };
    
    next();
  };
}

/**
 * Middleware para integração com máquina de estados
 * Use este middleware nas rotas que processam mensagens do usuário
 */
export function createCatalogStateMachineMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const module = getCatalogModule();
    
    if (module.stateMachineIntegration) {
      (req as any).stateMachine = module.stateMachineIntegration;
    }
    
    next();
  };
}

/**
 * Verifica o status de saúde do módulo
 */
export async function getCatalogHealth(): Promise<any> {
  return await getCatalogModule().getHealthStatus();
}

/**
 * Obtém a configuração atual do módulo
 */
export function getCatalogConfig(): CatalogConfig | null {
  return getCatalogModule().getConfig();
}

// Exportar tipos para uso externo
export type { CatalogConfig, CatalogInitializationResult };
export { CatalogModule };

// Tratamento de sinais para shutdown graceful
process.on('SIGTERM', async () => {
  const logger = new Logger('CatalogModule');
  logger.info('Recebido SIGTERM, desligando módulo de catálogo...');
  try {
    await shutdownCatalog();
    process.exit(0);
  } catch (error) {
    logger.error('Erro no shutdown:', error);
    process.exit(1);
  }
});

process.on('SIGINT', async () => {
  const logger = new Logger('CatalogModule');
  logger.info('Recebido SIGINT, desligando módulo de catálogo...');
  try {
    await shutdownCatalog();
    process.exit(0);
  } catch (error) {
    logger.error('Erro no shutdown:', error);
    process.exit(1);
  }
});