/**
 * Módulo Marlie Upsell - Integração Principal
 * 
 * Este arquivo serve como ponto de entrada principal para o módulo de upsell,
 * integrando todos os componentes e fornecendo uma interface unificada.
 * 
 * Funcionalidades:
 * - Inicialização completa do módulo
 * - Integração com máquina de estados
 * - Configuração de middlewares
 * - Exposição de APIs administrativas
 * - Observabilidade e métricas
 */

import { Express } from 'express';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { UpsellService } from '../../services/upsell-service';
import { UpsellStateMachineIntegration } from '../../integrations/upsell-state-machine';
import { upsellTriggerMiddleware, upsellResponseMiddleware } from '../../middleware/upsell-trigger';
import { upsellAdminRoutes } from '../../routes/upsell-admin';
import { UpsellDatabase } from '../../database/upsell-queries';
import { UpsellScheduler } from '../../services/upsell-scheduler';
import { logger } from '../../utils/logger';
import { MarlieUpsellConfig, UpsellTools } from './types';

/**
 * Classe principal de integração do módulo Marlie Upsell
 */
export class MarlieUpsellModule {
  private config: MarlieUpsellConfig;
  private upsellService: UpsellService;
  private stateMachine: UpsellStateMachineIntegration;
  private database: UpsellDatabase;
  private scheduler: UpsellScheduler;
  private isInitialized: boolean = false;

  constructor(
    config: MarlieUpsellConfig,
    pgPool: Pool,
    redis: Redis,
    tools: UpsellTools
  ) {
    this.config = config;
    
    // Inicializar componentes principais
    this.upsellService = new UpsellService(config, pgPool, redis, tools);
    this.stateMachine = new UpsellStateMachineIntegration();
    this.database = new UpsellDatabase();
    this.scheduler = new UpsellScheduler({
      defaultDelay: config.env?.upsellDelayMin || 10,
      maxRetries: 3,
      retryDelay: 60
    });

    logger.info('MarlieUpsellModule instantiated', {
      component: 'marlie-upsell',
      version: '1.0.0'
    });
  }

  /**
   * Inicializa o módulo completo de upsell
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('MarlieUpsellModule already initialized');
      return;
    }

    try {
      logger.info('Initializing MarlieUpsellModule...');

      // 1. Inicializar banco de dados
      await this.database.initialize();
      logger.info('Database initialized');

      // 2. Inicializar scheduler
      await this.scheduler.start();
      logger.info('Scheduler started');

      // 3. Inicializar máquina de estados
      await this.stateMachine.initialize();
      logger.info('State machine initialized');

      // 4. Inicializar serviço principal
      await this.upsellService.initialize();
      logger.info('Upsell service initialized');

      // 5. Configurar integração entre componentes
      this.setupComponentIntegration();

      this.isInitialized = true;
      logger.info('MarlieUpsellModule initialized successfully');

    } catch (error) {
      logger.error('Failed to initialize MarlieUpsellModule:', error);
      throw new Error(`MarlieUpsellModule initialization failed: ${error.message}`);
    }
  }

  /**
   * Configura a integração entre os componentes
   */
  private setupComponentIntegration(): void {
    // Conectar eventos do serviço com a máquina de estados
    this.upsellService.on('upsell:triggered', async (data) => {
      await this.stateMachine.processUpsellTrigger(data);
    });

    this.upsellService.on('upsell:response', async (data) => {
      await this.stateMachine.processUpsellResponse(data);
    });

    // Conectar eventos da máquina de estados com o scheduler
    this.stateMachine.on('upsell:schedule', async (data) => {
      await this.scheduler.scheduleUpsell(data.conversationId, data.delay, data.payload);
    });

    // Conectar eventos do scheduler com o serviço
    this.scheduler.on('job:completed', async (job) => {
      await this.upsellService.processScheduledUpsell(job.data);
    });

    logger.info('Component integration configured');
  }

  /**
   * Configura middlewares no Express app
   */
  setupMiddlewares(app: Express): void {
    if (!this.isInitialized) {
      throw new Error('Module must be initialized before setting up middlewares');
    }

    // Middleware para interceptar confirmações de agendamento
    app.use('/api/appointments', upsellTriggerMiddleware(this.upsellService));
    app.use('/webhook/whatsapp', upsellTriggerMiddleware(this.upsellService));

    // Middleware para processar respostas de upsell
    app.use('/api/messages', upsellResponseMiddleware(this.upsellService));
    app.use('/webhook/whatsapp', upsellResponseMiddleware(this.upsellService));

    logger.info('Middlewares configured');
  }

  /**
   * Configura rotas administrativas
   */
  setupAdminRoutes(app: Express): void {
    if (!this.isInitialized) {
      throw new Error('Module must be initialized before setting up admin routes');
    }

    // Rotas administrativas para métricas e configuração
    app.use('/admin/upsell', upsellAdminRoutes(this.upsellService, this.database));

    logger.info('Admin routes configured');
  }

  /**
   * Processa trigger de upsell manualmente
   */
  async triggerUpsell(data: {
    conversationId: string;
    phone: string;
    appointmentId: string;
    primaryServiceId: string;
    tenantId: string;
  }): Promise<{ success: boolean; message?: string; addon?: any }> {
    if (!this.isInitialized) {
      throw new Error('Module must be initialized before triggering upsells');
    }

    try {
      return await this.upsellService.triggerUpsell(data);
    } catch (error) {
      logger.error('Failed to trigger upsell:', error);
      return {
        success: false,
        message: error.message
      };
    }
  }

  /**
   * Processa resposta de upsell manualmente
   */
  async processUpsellResponse(data: {
    conversationId: string;
    phone: string;
    message: string;
    timestamp?: Date;
  }): Promise<{ success: boolean; action?: string; message?: string }> {
    if (!this.isInitialized) {
      throw new Error('Module must be initialized before processing responses');
    }

    try {
      return await this.upsellService.processResponse(data);
    } catch (error) {
      logger.error('Failed to process upsell response:', error);
      return {
        success: false,
        message: error.message
      };
    }
  }

  /**
   * Obtém métricas do módulo
   */
  async getMetrics(): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Module must be initialized before getting metrics');
    }

    try {
      const [serviceMetrics, dbMetrics, schedulerMetrics] = await Promise.all([
        this.upsellService.getMetrics(),
        this.database.getMetrics(),
        this.scheduler.getStats()
      ]);

      return {
        service: serviceMetrics,
        database: dbMetrics,
        scheduler: schedulerMetrics,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Failed to get metrics:', error);
      throw error;
    }
  }

  /**
   * Obtém status de saúde do módulo
   */
  async getHealthStatus(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    components: Record<string, boolean>;
    details?: any;
  }> {
    const components = {
      service: false,
      database: false,
      scheduler: false,
      stateMachine: false
    };

    try {
      // Verificar componentes
      components.service = this.upsellService ? true : false;
      components.database = await this.database.healthCheck();
      components.scheduler = this.scheduler.isRunning();
      components.stateMachine = this.stateMachine ? true : false;

      const healthyComponents = Object.values(components).filter(Boolean).length;
      const totalComponents = Object.keys(components).length;

      let status: 'healthy' | 'degraded' | 'unhealthy';
      if (healthyComponents === totalComponents) {
        status = 'healthy';
      } else if (healthyComponents >= totalComponents * 0.5) {
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
          totalComponents
        }
      };
    } catch (error) {
      logger.error('Health check failed:', error);
      return {
        status: 'unhealthy',
        components,
        details: { error: error.message }
      };
    }
  }

  /**
   * Finaliza o módulo e limpa recursos
   */
  async shutdown(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    try {
      logger.info('Shutting down MarlieUpsellModule...');

      // Parar scheduler
      await this.scheduler.stop();
      logger.info('Scheduler stopped');

      // Finalizar outros componentes
      await this.stateMachine.shutdown();
      logger.info('State machine shutdown');

      this.isInitialized = false;
      logger.info('MarlieUpsellModule shutdown completed');

    } catch (error) {
      logger.error('Error during shutdown:', error);
      throw error;
    }
  }

  /**
   * Getters para acesso aos componentes (para testes)
   */
  get service(): UpsellService {
    return this.upsellService;
  }

  get db(): UpsellDatabase {
    return this.database;
  }

  get stateMachineIntegration(): UpsellStateMachineIntegration {
    return this.stateMachine;
  }

  get upsellScheduler(): UpsellScheduler {
    return this.scheduler;
  }

  get initialized(): boolean {
    return this.isInitialized;
  }
}

/**
 * Factory function para criar e inicializar o módulo
 */
export async function createMarlieUpsellModule(
  config: MarlieUpsellConfig,
  pgPool: Pool,
  redis: Redis,
  tools: UpsellTools
): Promise<MarlieUpsellModule> {
  const module = new MarlieUpsellModule(config, pgPool, redis, tools);
  await module.initialize();
  return module;
}

/**
 * Exportações principais
 */
export { MarlieUpsellConfig, UpsellTools } from './types';
export { UpsellService } from '../../services/upsell-service';
export { UpsellDatabase } from '../../database/upsell-queries';
export { UpsellScheduler } from '../../services/upsell-scheduler';
export { UpsellStateMachineIntegration } from '../../integrations/upsell-state-machine';

/**
 * Versão do módulo
 */
export const MARLIE_UPSELL_VERSION = '1.0.0';

/**
 * Configuração padrão para desenvolvimento
 */
export const DEFAULT_UPSELL_CONFIG: Partial<MarlieUpsellConfig> = {
  env: {
    upsellDelayMin: 10,
    upsellEnabled: true,
    abTestingEnabled: true
  },
  security: {
    enablePiiMasking: true,
    logSensitiveData: false,
    encryptStoredData: true
  },
  nlp: {
    acceptPatterns: [
      /^\s*1\s*$/,
      /\b(sim|quero|aceito|adicionar|pode sim|ok|beleza)\b/i
    ],
    declinePatterns: [
      /\b(nao|não|talvez depois|agora não|não quero|dispenso)\b/i
    ]
  },
  responses: {
    copyVariants: {
      A: "Dica rápida: **{{addon.nome}}** ({{addon.duracao}}min) por **{{addon.preco}}**. Quer adicionar ao seu atendimento? Responda **1**.",
      B: "Potencialize seu resultado: **{{addon.nome}}** ({{addon.duracao}}min). Valor **{{addon.preco}}**. Deseja incluir? Responda **1**."
    },
    confirmAdded: "Perfeito! Adicionei **{{addon.nome}}** ao seu atendimento. ✅",
    addedPending: "Certo! Vou ajustar sua agenda com **{{addon.nome}}** e te confirmo já. 😉",
    declined: "Tudo bem! Seguimos com o que já foi confirmado. 🙌",
    nothingToOffer: " ",
    alreadyOffered: " "
  }
};