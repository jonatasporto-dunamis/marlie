import { RedisClientType } from 'redis';
import { logger } from '../utils/logger';
import { TrinksAppointmentsService, createTrinksAppointmentsService } from '../services/trinks-appointments';
import { NotificationsLogService, createNotificationsLogService } from '../services/notifications-log';
import { AutoMessageTemplates, createAutoMessageTemplates } from '../services/auto-message-templates';
import { PreVisitWorker, createPreVisitWorker } from '../workers/previsit-worker';
import { NoShowShieldWorker, createNoShowShieldWorker } from '../workers/noshow-shield-worker';
import { AuditWorker, createAuditWorker } from '../workers/audit-worker';
import { WorkersScheduler, createWorkersScheduler } from '../workers/workers-scheduler';
import { WorkersConfigLoader, createWorkersConfigLoader } from '../config/workers-config-loader';
import { configService } from '../services/config';
import { format, parseISO, addDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';

/**
 * Interface para configuração do módulo
 */
interface MarlieAutoMsgConfig {
  tenantId: string;
  trinksConfig: {
    apiUrl: string;
    apiToken: string;
    timeout?: number;
  };
  whatsappConfig: {
    apiUrl: string;
    apiToken: string;
    timeout?: number;
  };
  redis: RedisClientType;
  enablePreVisit?: boolean;
  enableNoShowShield?: boolean;
  enableAudit?: boolean;
  enableWorkersScheduler?: boolean;
  workersConfigPath?: string;
  preVisitHour?: number; // Hora para envio de pré-visita (0-23)
  noShowShieldHour?: number; // Hora para envio de no-show shield (0-23)
  auditIntervalMinutes?: number; // Intervalo de auditoria em minutos
}

/**
 * Interface para status do módulo
 */
interface MarlieAutoMsgStatus {
  tenantId: string;
  isStarted: boolean;
  workers: {
    preVisit: {
      enabled: boolean;
      running: boolean;
    };
    noShowShield: {
      enabled: boolean;
      running: boolean;
    };
    audit: {
      enabled: boolean;
      running: boolean;
    };
  };
  workersScheduler?: {
    enabled: boolean;
    running: boolean;
    workers: Record<string, any>;
  };
  lastActivity: string;
}

/**
 * Interface para resposta das ferramentas
 */
interface ToolResponse {
  success: boolean;
  data?: any;
  error?: string;
  message?: string;
}

/**
 * Interface para parâmetros das ferramentas Trinks
 */
interface TrinksFetchAppointmentsParams {
  dataInicio: string;
  dataFim: string;
  page?: number;
}

interface TrinksGetAppointmentParams {
  id: string;
}

interface TrinksSearchSlotsParams {
  service_id: string;
  professional_id?: string;
  date_from_iso: string;
  limit?: number;
}

interface TrinksRebookParams {
  appointment_id: string;
  new_start_iso: string;
  service_id: string;
  professional_id?: string;
}

/**
 * Interface para parâmetros das ferramentas de mensageria
 */
interface WaSendMessageParams {
  phone: string;
  text: string;
}

interface DbNotificationsLogParams {
  dedupe_key: string;
  phone: string;
  kind: string;
  payload?: any;
}

interface DbHasNotificationParams {
  dedupe_key: string;
}

interface DbAuditDivergencesParams {
  date: string;
}

/**
 * Módulo principal de mensagens automáticas
 */
export class MarlieAutoMsgModule {
  private config: MarlieAutoMsgConfig;
  private previsitWorker: PreVisitWorker | null = null;
  private noshowWorker: NoShowShieldWorker | null = null;
  private auditWorker: AuditWorker | null = null;
  private workersScheduler: WorkersScheduler | null = null;
  private workersConfigLoader: WorkersConfigLoader | null = null;
  private trinksService: TrinksAppointmentsService;
  private notificationsService: NotificationsLogService;
  private templates: AutoMessageTemplates;
  private isInitialized: boolean = false;

  constructor(config: MarlieAutoMsgConfig) {
    this.config = config;
    this.trinksService = new TrinksAppointmentsService(config.tenantId);
    this.notificationsService = new NotificationsLogService(config.tenantId);
    this.templates = new AutoMessageTemplates();
  }

  /**
   * Inicializa o módulo e todos os workers
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      logger.info('Inicializando módulo Marlie Auto Messages', {
        tenantId: this.config.tenantId,
        config: this.config
      });

      // Inicializa workers scheduler se habilitado
      if (this.config.enableWorkersScheduler) {
        this.workersConfigLoader = await createWorkersConfigLoader(this.config.workersConfigPath);
        
        // Criar dependencies para o workers scheduler
        const dependencies = {
          trinksService: this.trinksService,
          notificationsLog: this.notificationsService,
          templates: this.templates,
          redis: this.config.redis,
          logger: logger,
          waService: null // TODO: implementar WhatsApp service
        };
        
        const workersConfig = this.workersConfigLoader.getWorkersConfig();
        const retryPolicy = this.workersConfigLoader.getRetryPolicy();
        
        this.workersScheduler = createWorkersScheduler(workersConfig, retryPolicy, dependencies);
        this.workersScheduler.start();
        logger.info('Workers Scheduler iniciado', { tenantId: this.config.tenantId });
      } else {
        // Inicializa workers individuais (modo legado)
        if (this.config.enablePreVisit) {
          this.previsitWorker = await createPreVisitWorker(this.config.tenantId);
          this.previsitWorker.start();
          logger.info('PreVisit Worker iniciado', { tenantId: this.config.tenantId });
        }

        if (this.config.enableNoShowShield) {
          this.noshowWorker = await createNoShowShieldWorker(this.config.tenantId);
          this.noshowWorker.start();
          logger.info('NoShow Shield Worker iniciado', { tenantId: this.config.tenantId });
        }

        if (this.config.enableAudit) {
          this.auditWorker = await createAuditWorker(this.config.tenantId);
          this.auditWorker.start();
          logger.info('Audit Worker iniciado', { tenantId: this.config.tenantId });
        }
      }

      this.isInitialized = true;
      
      logger.info('Módulo Marlie Auto Messages inicializado com sucesso', {
        tenantId: this.config.tenantId
      });
    } catch (error) {
      logger.error('Erro ao inicializar módulo Marlie Auto Messages', {
        tenantId: this.config.tenantId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Para todos os workers
   */
  async shutdown(): Promise<void> {
    logger.info('Parando módulo Marlie Auto Messages', {
      tenantId: this.config.tenantId
    });

    if (this.workersScheduler) {
      this.workersScheduler.stop();
    }

    if (this.previsitWorker) {
      this.previsitWorker.stop();
    }

    if (this.noshowWorker) {
      this.noshowWorker.stop();
    }

    if (this.auditWorker) {
      this.auditWorker.stop();
    }

    this.isInitialized = false;
    
    logger.info('Módulo Marlie Auto Messages parado', {
      tenantId: this.config.tenantId
    });
  }

  /**
   * Inicia o workers scheduler
   */
  private async startWorkersScheduler(): Promise<void> {
    try {
      // Carrega configuração dos workers
      this.workersConfigLoader = createWorkersConfigLoader(
        this.config.workersConfigPath
      );

      const workersConfig = this.workersConfigLoader.loadConfig();
      const retryPolicy = this.workersConfigLoader.getRetryPolicy();

      // Valida variáveis de ambiente
      const envValidation = this.workersConfigLoader.validateEnvironment();
      if (!envValidation.valid) {
        logger.warn(
          `Variáveis de ambiente faltando: ${envValidation.missing.join(', ')}`,
          { tenantId: this.config.tenantId }
        );
      }

      // Cria dependências para o scheduler
      const dependencies = {
        trinksService: this.trinksService,
        notificationsLog: this.notificationsService,
        templates: this.templates,
        redis: this.config.redis,
        logger: logger,
        waService: {
          sendMessage: async (params: { phone: string; text: string }) => {
            // Implementação do envio via WhatsApp
            // Aqui você integraria com seu serviço de WhatsApp
            logger.info(`Enviando mensagem para ${params.phone}: ${params.text}`, {
              tenantId: this.config.tenantId
            });
            return { success: true, messageId: `msg_${Date.now()}` };
          }
        }
      };

      // Cria e inicia o scheduler
      this.workersScheduler = createWorkersScheduler(
        workersConfig,
        retryPolicy,
        dependencies
      );

      this.workersScheduler.start();
      
      logger.info('Workers scheduler iniciado com sucesso', {
        tenantId: this.config.tenantId
      });

    } catch (error) {
      logger.error('Erro ao iniciar workers scheduler:', {
        error: error instanceof Error ? error.message : String(error),
        tenantId: this.config.tenantId
      });
      throw error;
    }
  }

  /**
   * Processa resposta de usuário (para no-show shield)
   */
  async processUserResponse(phone: string, message: string): Promise<ToolResponse> {
    if (!this.noshowWorker) {
      return {
        success: false,
        error: 'NoShow Shield Worker não está ativo'
      };
    }

    try {
      const result = await this.noshowWorker.processUserResponse(phone, message);
      
      if (result.processed) {
        return {
          success: true,
          data: {
            processed: true,
            response: result.response
          },
          message: 'Resposta processada com sucesso'
        };
      } else {
        return {
          success: true,
          data: {
            processed: false
          },
          message: 'Resposta não se aplica ao no-show shield'
        };
      }
    } catch (error) {
      logger.error('Erro ao processar resposta do usuário', {
        phone,
        message,
        error: error instanceof Error ? error.message : String(error),
        tenantId: this.config.tenantId
      });
      
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  // =============================================================================
  // FERRAMENTAS TRINKS
  // =============================================================================

  /**
   * Ferramenta: trinks.fetch_appointments
   */
  async trinksFetchAppointments(params: TrinksFetchAppointmentsParams): Promise<ToolResponse> {
    try {
      const response = await this.trinksService.fetchAppointments(
        params.dataInicio,
        params.dataFim,
        params.page || 1
      );
      
      return {
        success: true,
        data: response,
        message: `${response.agendamentos.length} agendamentos encontrados`
      };
    } catch (error) {
      logger.error('Erro em trinks.fetch_appointments', {
        params,
        error: error.message,
        tenantId: this.config.tenantId
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Ferramenta: trinks.get_appointment
   */
  async trinksGetAppointment(params: TrinksGetAppointmentParams): Promise<ToolResponse> {
    try {
      const appointment = await this.trinksService.getAppointment(params.id);
      
      return {
        success: true,
        data: appointment,
        message: 'Agendamento encontrado'
      };
    } catch (error) {
      logger.error('Erro em trinks.get_appointment', {
        params,
        error: error.message,
        tenantId: this.config.tenantId
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Ferramenta: trinks.search_slots
   */
  async trinksSearchSlots(params: TrinksSearchSlotsParams): Promise<ToolResponse> {
    try {
      const response = await this.trinksService.searchSlots(
        params.service_id,
        params.professional_id,
        params.date_from_iso,
        params.limit || 3
      );
      
      return {
        success: true,
        data: response,
        message: `${response.slots.length} slots encontrados`
      };
    } catch (error) {
      logger.error('Erro em trinks.search_slots', {
        params,
        error: error.message,
        tenantId: this.config.tenantId
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Ferramenta: trinks.rebook
   */
  async trinksRebook(params: TrinksRebookParams): Promise<ToolResponse> {
    try {
      const result = await this.trinksService.rebookAppointment(
        params.appointment_id,
        params.new_start_iso,
        params.service_id,
        params.professional_id
      );
      
      return {
        success: true,
        data: result,
        message: 'Agendamento reagendado com sucesso'
      };
    } catch (error) {
      logger.error('Erro em trinks.rebook', {
        params,
        error: error.message,
        tenantId: this.config.tenantId
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  // =============================================================================
  // FERRAMENTAS DE MENSAGERIA E BANCO
  // =============================================================================

  /**
   * Ferramenta: wa.send_message
   */
  async waSendMessage(params: WaSendMessageParams): Promise<ToolResponse> {
    try {
      // Esta implementação seria integrada com o sistema de WhatsApp existente
      // Por enquanto, apenas logamos a mensagem
      logger.info('Mensagem WhatsApp enviada (simulado)', {
        phone: params.phone,
        textLength: params.text.length,
        tenantId: this.config.tenantId
      });
      
      return {
        success: true,
        data: {
          messageId: `msg_${Date.now()}`,
          phone: params.phone,
          sentAt: new Date().toISOString()
        },
        message: 'Mensagem enviada com sucesso'
      };
    } catch (error) {
      logger.error('Erro em wa.send_message', {
        params,
        error: error.message,
        tenantId: this.config.tenantId
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Ferramenta: db.notifications_log
   */
  async dbNotificationsLog(params: DbNotificationsLogParams): Promise<ToolResponse> {
    try {
      const notification = await this.notificationsService.logNotification(
        params.dedupe_key,
        params.phone,
        params.kind,
        params.payload || {}
      );
      
      return {
        success: true,
        data: notification,
        message: 'Notificação registrada com sucesso'
      };
    } catch (error) {
      logger.error('Erro em db.notifications_log', {
        params,
        error: error.message,
        tenantId: this.config.tenantId
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Ferramenta: db.has_notification
   */
  async dbHasNotification(params: DbHasNotificationParams): Promise<ToolResponse> {
    try {
      const exists = await this.notificationsService.hasNotification(params.dedupe_key);
      
      return {
        success: true,
        data: {
          exists,
          dedupe_key: params.dedupe_key
        },
        message: exists ? 'Notificação já existe' : 'Notificação não encontrada'
      };
    } catch (error) {
      logger.error('Erro em db.has_notification', {
        params,
        error: error.message,
        tenantId: this.config.tenantId
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Ferramenta: db.audit_divergences
   */
  async dbAuditDivergences(params: DbAuditDivergencesParams): Promise<ToolResponse> {
    try {
      if (!this.auditWorker) {
        return {
          success: false,
          error: 'Audit Worker não está ativo'
        };
      }
      
      const report = await this.auditWorker.auditSpecificDate(params.date);
      
      return {
        success: true,
        data: report,
        message: `Auditoria concluída: ${report.summary.totalDivergences} divergências encontradas`
      };
    } catch (error) {
      logger.error('Erro em db.audit_divergences', {
        params,
        error: error.message,
        tenantId: this.config.tenantId
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  // =============================================================================
  // MÉTODOS DE STATUS E CONTROLE
  // =============================================================================

  /**
   * Obtém status geral do módulo
   */
  getStatus(): MarlieAutoMsgStatus {
    const status = {
      isInitialized: this.isInitialized,
      config: this.config,
      workers: {
        previsit: this.previsitWorker?.getStatus(),
        noshow: this.noshowWorker?.getStatus(),
        audit: this.auditWorker?.getStatus()
      }
    };

    // Adiciona status do workers scheduler se ativo
    if (this.workersScheduler) {
      (status as any).workersScheduler = {
        enabled: true,
        running: true,
        workers: this.workersScheduler.getStatus()
      };
    }

    return status;
  }

  /**
   * Executa teste de conectividade
   */
  async testConnectivity(): Promise<ToolResponse> {
    try {
      // Testa conexão com Trinks
      const tomorrow = addDays(new Date(), 1);
      const testDate = format(tomorrow, 'yyyy-MM-dd');
      
      await this.trinksService.fetchAppointments(
        `${testDate}T00:00:00.000Z`,
        `${testDate}T23:59:59.999Z`,
        1
      );
      
      return {
        success: true,
        data: {
          trinks: 'OK',
          database: 'OK',
          timestamp: new Date().toISOString()
        },
        message: 'Conectividade testada com sucesso'
      };
    } catch (error) {
      return {
        success: false,
        error: `Erro de conectividade: ${error.message}`
      };
    }
  }

  /**
   * Força execução manual dos workers
   */
  async forceExecution(workerType: 'previsit' | 'noshow' | 'audit'): Promise<ToolResponse> {
    try {
      let result: any;
      
      switch (workerType) {
        case 'previsit':
          if (!this.previsitWorker) {
            throw new Error('PreVisit Worker não está ativo');
          }
          result = await this.previsitWorker.executePreVisitRun();
          break;
          
        case 'noshow':
          if (!this.noshowWorker) {
            throw new Error('NoShow Shield Worker não está ativo');
          }
          result = await this.noshowWorker.executeNoShowShieldRun();
          break;
          
        case 'audit':
          if (!this.auditWorker) {
            throw new Error('Audit Worker não está ativo');
          }
          result = await this.auditWorker.executeAuditRun();
          break;
          
        default:
          throw new Error(`Worker type inválido: ${workerType}`);
      }
      
      return {
        success: true,
        data: result,
        message: `Execução manual do ${workerType} worker concluída`
      };
    } catch (error) {
      logger.error('Erro na execução manual', {
        workerType,
        error: error.message,
        tenantId: this.config.tenantId
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }
}

/**
 * Factory function para criar módulo de mensagens automáticas
 */
export async function createMarlieAutoMsgModule(tenantId: string): Promise<MarlieAutoMsgModule> {
  // Carrega configurações
  const previsitEnabledConfig = await configService.get(tenantId, 'previsit_enabled');
  const noshowShieldEnabledConfig = await configService.get(tenantId, 'noshow_shield_enabled');
  const auditEnabledConfig = await configService.get(tenantId, 'audit_enabled');
  const timezoneConfig = await configService.get(tenantId, 'timezone');

  const config: MarlieAutoMsgConfig = {
    tenantId,
    timezone: timezoneConfig?.value || 'America/Bahia',
    previsitEnabled: previsitEnabledConfig?.value === 'true' || previsitEnabledConfig?.value === true,
    noshowShieldEnabled: noshowShieldEnabledConfig?.value === 'true' || noshowShieldEnabledConfig?.value === true,
    auditEnabled: auditEnabledConfig?.value === 'true' || auditEnabledConfig?.value === true
  };

  const module = new MarlieAutoMsgModule(config);
  await module.initialize();
  
  return module;
}

/**
 * Instância global do módulo por tenant
 */
const moduleInstances = new Map<string, MarlieAutoMsgModule>();

/**
 * Obtém ou cria instância do módulo para um tenant
 */
export async function getMarlieAutoMsgModule(tenantId: string): Promise<MarlieAutoMsgModule> {
  if (!moduleInstances.has(tenantId)) {
    const module = await createMarlieAutoMsgModule(tenantId);
    moduleInstances.set(tenantId, module);
  }
  
  return moduleInstances.get(tenantId)!;
}

/**
 * Remove instância do módulo para um tenant
 */
export async function removeMarlieAutoMsgModule(tenantId: string): Promise<void> {
  const module = moduleInstances.get(tenantId);
  if (module) {
    await module.shutdown();
    moduleInstances.delete(tenantId);
  }
}