import * as cron from 'node-cron';
import { Logger } from '../utils/logger';
import { TrinksAppointmentsService } from '../services/trinks-appointments';
import { NotificationsLogService } from '../services/notifications-log';
import { AutoMessageTemplates } from '../services/auto-message-templates';
import { Redis } from 'ioredis';

interface WorkerConfig {
  enabled: boolean;
  cron: string;
  timezone?: string;
}

interface WorkersConfig {
  previsit_daily: WorkerConfig;
  divergence_audit_hourly: WorkerConfig;
}

interface RetryPolicy {
  network: {
    maxRetries: number;
    baseDelay: number;
    maxDelay: number;
    jitter: boolean;
  };
}

interface WorkerDependencies {
  trinksService: TrinksAppointmentsService;
  notificationsLog: NotificationsLogService;
  templates: AutoMessageTemplates;
  redis: Redis;
  logger: Logger;
  waService: any; // WhatsApp service
}

interface AuditResult {
  count: number;
  divergences: Array<{
    appointment_id: string;
    issue: string;
    severity: 'low' | 'medium' | 'high';
  }>;
}

class WorkersScheduler {
  private config: WorkersConfig;
  private retryPolicy: RetryPolicy;
  private dependencies: WorkerDependencies;
  private scheduledTasks: Map<string, cron.ScheduledTask> = new Map();
  private logger: Logger;

  constructor(
    config: WorkersConfig,
    retryPolicy: RetryPolicy,
    dependencies: WorkerDependencies
  ) {
    this.config = config;
    this.retryPolicy = retryPolicy;
    this.dependencies = dependencies;
    this.logger = dependencies.logger;
  }

  /**
   * Inicia todos os workers configurados
   */
  public start(): void {
    this.logger.info('Iniciando workers scheduler');

    // Worker de pré-visita diário
    if (this.config.previsit_daily.enabled) {
      this.schedulePreVisitWorker();
    }

    // Worker de auditoria de divergências horário
    if (this.config.divergence_audit_hourly.enabled) {
      this.scheduleDivergenceAuditWorker();
    }

    this.logger.info(`Workers iniciados: ${this.scheduledTasks.size} tarefas agendadas`);
  }

  /**
   * Para todos os workers
   */
  public stop(): void {
    this.logger.info('Parando workers scheduler');
    
    for (const [name, task] of this.scheduledTasks) {
      task.stop();
      this.logger.info(`Worker ${name} parado`);
    }
    
    this.scheduledTasks.clear();
  }

  /**
   * Agenda o worker de pré-visita diário
   */
  private schedulePreVisitWorker(): void {
    const task = cron.schedule(
      this.config.previsit_daily.cron,
      async () => {
        await this.executePreVisitWorker();
      },
      {
        scheduled: false,
        timezone: this.config.previsit_daily.timezone || 'America/Sao_Paulo'
      }
    );

    this.scheduledTasks.set('previsit_daily', task);
    task.start();
    
    this.logger.info(
      `Worker pré-visita agendado: ${this.config.previsit_daily.cron}`
    );
  }

  /**
   * Agenda o worker de auditoria de divergências
   */
  private scheduleDivergenceAuditWorker(): void {
    const task = cron.schedule(
      this.config.divergence_audit_hourly.cron,
      async () => {
        await this.executeDivergenceAuditWorker();
      },
      {
        scheduled: false,
        timezone: this.config.divergence_audit_hourly.timezone || 'America/Sao_Paulo'
      }
    );

    this.scheduledTasks.set('divergence_audit_hourly', task);
    task.start();
    
    this.logger.info(
      `Worker auditoria agendado: ${this.config.divergence_audit_hourly.cron}`
    );
  }

  /**
   * Executa o worker de pré-visita
   */
  private async executePreVisitWorker(): Promise<void> {
    const startTime = Date.now();
    this.logger.info('Iniciando execução do worker de pré-visita');

    try {
      // Calcula data alvo (amanhã)
      const dateTarget = this.getTomorrowLocalDate();
      const startIso = `${dateTarget}T00:01:00`;
      const endIso = `${dateTarget}T23:59:00`;

      this.logger.info(`Processando agendamentos para ${dateTarget}`);

      let processedCount = 0;
      let sentCount = 0;
      let skippedCount = 0;

      // Busca agendamentos paginados
      await this.dependencies.trinksService.paginateAppointments(
        { dataInicio: startIso, dataFim: endIso },
        async (appointments: any[]) => {
          for (const apt of appointments) {
            try {
              processedCount++;
              
              // Gera chave de deduplicação
              const dedupeKey = `previsit:${apt.id}:${dateTarget}`;
              
              // Verifica se já foi enviada notificação
              const alreadyExists = await this.dependencies.notificationsLog.hasNotification(dedupeKey);
              
              if (alreadyExists) {
                skippedCount++;
                continue;
              }

              // Busca detalhes completos do agendamento
              const aptFull = await this.dependencies.trinksService.getAppointment(apt.id);
              
              // Verifica se está confirmado
              if (aptFull.status !== 'confirmado') {
                skippedCount++;
                continue;
              }

              // Gera mensagem de pré-visita
              const templateData = this.dependencies.templates.convertAppointmentToTemplateData(aptFull);
              const message = this.dependencies.templates.getPreVisitTemplate(templateData);

              // Envia mensagem
              await this.dependencies.waService.sendMessage({
                phone: aptFull.cliente.telefone,
                text: message
              });

              // Registra no log de notificações
              await this.dependencies.notificationsLog.logNotification({
                dedupeKey,
                phone: aptFull.cliente.telefone,
                kind: 'previsit',
                payload: {
                  appointment_id: aptFull.id,
                  start_iso: aptFull.dataHoraInicio,
                  service_id: aptFull.servico?.id,
                  professional_id: aptFull.profissional?.id
                }
              });

              sentCount++;
              
              this.logger.debug(`Pré-visita enviada para ${aptFull.cliente.nome} (${aptFull.cliente.telefone})`);
              
            } catch (error) {
              this.logger.error(`Erro ao processar agendamento ${apt.id}:`, error);
            }
          }
        }
      );

      const duration = Date.now() - startTime;
      
      this.logger.info(
        `Worker pré-visita concluído em ${duration}ms: ` +
        `${processedCount} processados, ${sentCount} enviados, ${skippedCount} ignorados`
      );

      // Registra métricas
      await this.recordMetrics('previsit_daily', {
        processed: processedCount,
        sent: sentCount,
        skipped: skippedCount,
        duration
      });

    } catch (error) {
      this.logger.error('Erro na execução do worker de pré-visita:', error);
      throw error;
    }
  }

  /**
   * Executa o worker de auditoria de divergências
   */
  private async executeDivergenceAuditWorker(): Promise<void> {
    const startTime = Date.now();
    this.logger.info('Iniciando execução do worker de auditoria');

    try {
      const dateTarget = this.getTomorrowLocalDate();
      
      // Executa auditoria de divergências
      const auditResult = await this.auditDivergences(dateTarget);
      
      const duration = Date.now() - startTime;
      
      this.logger.info(
        `Auditoria concluída em ${duration}ms: ${auditResult.count} divergências encontradas`
      );

      // Registra métrica de divergências
      await this.setMetricGauge('auto_msg_divergences', auditResult.count, {
        date: dateTarget
      });

      // Se há muitas divergências, alerta
      if (auditResult.count > 10) {
        this.logger.warn(
          `Alto número de divergências detectadas (${auditResult.count}) para ${dateTarget}`
        );
      }

    } catch (error) {
      this.logger.error('Erro na execução do worker de auditoria:', error);
      throw error;
    }
  }

  /**
   * Executa auditoria de divergências para uma data
   */
  private async auditDivergences(date: string): Promise<AuditResult> {
    try {
      // Busca notificações enviadas para a data
      const notifications = await this.dependencies.notificationsLog.getNotifications(
        'previsit',
        date,
        date
      );
      
      // Busca agendamentos reais da API Trinks para a data
      const startIso = `${date}T00:01:00`;
      const endIso = `${date}T23:59:00`;
      
      const realAppointments = await this.dependencies.trinksService.fetchAppointments(
        startIso,
        endIso,
        1
      );

      const divergences: Array<{
        appointment_id: string;
        issue: string;
        severity: 'low' | 'medium' | 'high';
      }> = [];

      // Verifica agendamentos que deveriam ter notificação mas não têm
      for (const apt of realAppointments.agendamentos) {
        if (apt.status === 'confirmado') {
          const dedupeKey = `previsit:${apt.id}:${date}`;
          const hasNotification = notifications.some((n: any) => n.dedupe_key === dedupeKey);
          
          if (!hasNotification) {
            divergences.push({
              appointment_id: apt.id,
              issue: 'Agendamento confirmado sem notificação de pré-visita',
              severity: 'medium'
            });
          }
        }
      }

      // Verifica notificações órfãs (sem agendamento correspondente)
      for (const notification of notifications) {
        if (notification.kind === 'previsit' && notification.payload?.appointment_id) {
          const aptExists = realAppointments.agendamentos.some(
            (apt: any) => apt.id === notification.payload.appointment_id
          );
          
          if (!aptExists) {
            divergences.push({
              appointment_id: notification.payload.appointment_id,
              issue: 'Notificação enviada para agendamento inexistente',
              severity: 'high'
            });
          }
        }
      }

      return {
        count: divergences.length,
        divergences
      };

    } catch (error) {
      this.logger.error('Erro na auditoria de divergências:', error);
      throw error;
    }
  }

  /**
   * Calcula a data de amanhã no formato local
   */
  private getTomorrowLocalDate(): string {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  }

  /**
   * Registra métricas de execução
   */
  private async recordMetrics(workerName: string, metrics: Record<string, number>): Promise<void> {
    try {
      const key = `metrics:worker:${workerName}:${Date.now()}`;
      await this.dependencies.redis.setex(key, 86400, JSON.stringify({
        timestamp: new Date().toISOString(),
        worker: workerName,
        ...metrics
      }));
    } catch (error) {
      this.logger.error('Erro ao registrar métricas:', error);
    }
  }

  /**
   * Define valor de métrica gauge
   */
  private async setMetricGauge(
    name: string, 
    value: number, 
    labels: Record<string, string> = {}
  ): Promise<void> {
    try {
      const key = `gauge:${name}:${JSON.stringify(labels)}`;
      await this.dependencies.redis.setex(key, 3600, value.toString());
      
      this.logger.debug(`Métrica ${name} definida: ${value}`, { labels });
    } catch (error) {
      this.logger.error('Erro ao definir métrica gauge:', error);
    }
  }

  /**
   * Obtém status dos workers
   */
  public getStatus(): Record<string, any> {
    const status: Record<string, any> = {};
    
    for (const [name, task] of this.scheduledTasks) {
      status[name] = {
        running: task.getStatus() === 'scheduled',
        nextRun: task.nextDate()?.toISOString()
      };
    }
    
    return status;
  }
}

/**
 * Factory function para criar instância do WorkersScheduler
 */
export function createWorkersScheduler(
  config: WorkersConfig,
  retryPolicy: RetryPolicy,
  dependencies: WorkerDependencies
): WorkersScheduler {
  return new WorkersScheduler(config, retryPolicy, dependencies);
}

export {
  WorkersScheduler,
  WorkersConfig,
  WorkerConfig,
  RetryPolicy,
  WorkerDependencies,
  AuditResult
};