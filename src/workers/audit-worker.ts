import * as cron from 'node-cron';
import { logger } from '../utils/logger';
import { TrinksAppointmentsService, TrinksAppointment } from '../services/trinks-appointments';
import { NotificationsLogService, NotificationRecord } from '../services/notifications-log';
import { configService } from '../services/config';
import { format, subDays, startOfDay, endOfDay } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

/**
 * Interface para configuração do worker de auditoria
 */
interface AuditWorkerConfig {
  enabled: boolean;
  cronExpression: string;
  timezone: string;
  tenantId: string;
  daysToAudit: number; // Quantos dias para trás auditar
}

/**
 * Interface para divergência encontrada
 */
interface AuditDivergence {
  type: 'missing_notification' | 'orphan_notification' | 'status_mismatch';
  appointmentId?: string;
  notificationId?: string;
  description: string;
  appointmentData?: Partial<TrinksAppointment>;
  notificationData?: Partial<NotificationRecord>;
  severity: 'low' | 'medium' | 'high';
}

/**
 * Interface para relatório de auditoria
 */
interface AuditReport {
  date: string;
  totalAppointments: number;
  totalNotifications: number;
  divergences: AuditDivergence[];
  summary: {
    missingNotifications: number;
    orphanNotifications: number;
    statusMismatches: number;
    totalDivergences: number;
  };
  executionTime: number;
  auditedAt: string;
}

/**
 * Interface para estatísticas de execução
 */
interface ExecutionStats {
  auditedDates: number;
  totalDivergences: number;
  highSeverityDivergences: number;
  executionTime: number;
}

/**
 * Worker de auditoria de divergências
 */
export class AuditWorker {
  private isRunning: boolean = false;
  private cronJob: cron.ScheduledTask | null = null;
  private config: AuditWorkerConfig;
  private trinksService: TrinksAppointmentsService;
  private notificationsService: NotificationsLogService;

  constructor(config: AuditWorkerConfig) {
    this.config = config;
    this.trinksService = new TrinksAppointmentsService(config.tenantId);
    this.notificationsService = new NotificationsLogService(config.tenantId);
  }

  /**
   * Inicia o worker com agendamento cron
   */
  start(): void {
    if (!this.config.enabled) {
      logger.info('Audit Worker desabilitado', { tenantId: this.config.tenantId });
      return;
    }

    this.cronJob = cron.schedule(this.config.cronExpression, async () => {
      await this.executeAuditRun();
    }, {
      scheduled: true,
      timezone: this.config.timezone
    });

    logger.info('Audit Worker iniciado', {
      cronExpression: this.config.cronExpression,
      timezone: this.config.timezone,
      daysToAudit: this.config.daysToAudit,
      tenantId: this.config.tenantId
    });
  }

  /**
   * Para o worker
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    
    logger.info('Audit Worker parado', { tenantId: this.config.tenantId });
  }

  /**
   * Executa uma rodada de auditoria
   */
  async executeAuditRun(): Promise<ExecutionStats> {
    if (this.isRunning) {
      logger.warn('Audit Worker já está executando', { tenantId: this.config.tenantId });
      throw new Error('Worker já está executando');
    }

    this.isRunning = true;
    const startTime = Date.now();
    
    const stats: ExecutionStats = {
      auditedDates: 0,
      totalDivergences: 0,
      highSeverityDivergences: 0,
      executionTime: 0
    };

    try {
      logger.info('Iniciando execução Audit Worker', { 
        daysToAudit: this.config.daysToAudit,
        tenantId: this.config.tenantId 
      });

      // Audita os últimos N dias
      for (let i = 1; i <= this.config.daysToAudit; i++) {
        const auditDate = subDays(new Date(), i);
        const dateStr = format(auditDate, 'yyyy-MM-dd');
        
        try {
          const report = await this.auditDate(dateStr);
          stats.auditedDates++;
          stats.totalDivergences += report.summary.totalDivergences;
          stats.highSeverityDivergences += report.divergences.filter(d => d.severity === 'high').length;
          
          // Log apenas se houver divergências
          if (report.summary.totalDivergences > 0) {
            logger.warn('Divergências encontradas na auditoria', {
              date: dateStr,
              summary: report.summary,
              tenantId: this.config.tenantId
            });
          }
        } catch (error) {
          logger.error('Erro ao auditar data', {
            date: dateStr,
            error: error.message,
            tenantId: this.config.tenantId
          });
        }
      }

      stats.executionTime = Date.now() - startTime;

      logger.info('Execução Audit Worker concluída', {
        stats,
        tenantId: this.config.tenantId
      });

      return stats;
    } catch (error) {
      stats.executionTime = Date.now() - startTime;
      
      logger.error('Erro na execução Audit Worker', {
        error: error.message,
        stats,
        tenantId: this.config.tenantId
      });
      
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Audita uma data específica
   */
  async auditDate(dateStr: string): Promise<AuditReport> {
    const startTime = Date.now();
    
    logger.debug('Iniciando auditoria para data', {
      date: dateStr,
      tenantId: this.config.tenantId
    });

    // Calcula range da data no timezone configurado
    const targetDate = new Date(dateStr + 'T00:00:00');
    const zonedDate = toZonedTime(targetDate, this.config.timezone);
    
    const startOfTargetDay = startOfDay(zonedDate);
    const endOfTargetDay = endOfDay(zonedDate);
    
    // Converte para UTC para a API
    const dataInicio = fromZonedTime(startOfTargetDay, this.config.timezone).toISOString();
    const dataFim = fromZonedTime(endOfTargetDay, this.config.timezone).toISOString();

    // Busca agendamentos da Trinks
    const appointments = await this.fetchAllAppointments(dataInicio, dataFim);
    
    // Busca notificações do banco
    const notifications = await this.notificationsService.getNotificationsByDate(dateStr);
    
    // Analisa divergências
    const divergences = await this.analyzeDivergences(appointments, notifications, dateStr);
    
    const report: AuditReport = {
      date: dateStr,
      totalAppointments: appointments.length,
      totalNotifications: notifications.length,
      divergences,
      summary: {
        missingNotifications: divergences.filter(d => d.type === 'missing_notification').length,
        orphanNotifications: divergences.filter(d => d.type === 'orphan_notification').length,
        statusMismatches: divergences.filter(d => d.type === 'status_mismatch').length,
        totalDivergences: divergences.length
      },
      executionTime: Date.now() - startTime,
      auditedAt: new Date().toISOString()
    };

    // Salva relatório se houver divergências
    if (divergences.length > 0) {
      await this.saveAuditReport(report);
    }

    return report;
  }

  /**
   * Busca todos os agendamentos paginando se necessário
   */
  private async fetchAllAppointments(
    dataInicio: string,
    dataFim: string
  ): Promise<TrinksAppointment[]> {
    const allAppointments: TrinksAppointment[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await this.trinksService.fetchAppointments(dataInicio, dataFim, page);
        allAppointments.push(...response.agendamentos);
        
        hasMore = page < response.totalPages;
        page++;
      } catch (error) {
        logger.error('Erro ao buscar agendamentos para auditoria', {
          dataInicio,
          dataFim,
          page,
          error: error.message,
          tenantId: this.config.tenantId
        });
        break;
      }
    }

    return allAppointments;
  }

  /**
   * Analisa divergências entre agendamentos e notificações
   */
  private async analyzeDivergences(
    appointments: TrinksAppointment[],
    notifications: NotificationRecord[],
    dateStr: string
  ): Promise<AuditDivergence[]> {
    const divergences: AuditDivergence[] = [];
    
    // Cria mapas para facilitar comparação
    const appointmentMap = new Map(appointments.map(apt => [apt.id, apt]));
    const notificationMap = new Map<string, NotificationRecord[]>();
    
    // Agrupa notificações por appointment_id
    notifications.forEach(notif => {
      const appointmentId = notif.payload?.appointmentId;
      if (appointmentId) {
        if (!notificationMap.has(appointmentId)) {
          notificationMap.set(appointmentId, []);
        }
        notificationMap.get(appointmentId)!.push(notif);
      }
    });

    // 1. Verifica agendamentos que deveriam ter notificações mas não têm
    for (const appointment of appointments) {
      // Só verifica agendamentos que deveriam gerar notificações
      if (!this.shouldHaveNotification(appointment)) {
        continue;
      }
      
      const appointmentNotifications = notificationMap.get(appointment.id) || [];
      
      if (appointmentNotifications.length === 0) {
        divergences.push({
          type: 'missing_notification',
          appointmentId: appointment.id,
          description: `Agendamento ${appointment.id} deveria ter notificação mas não foi encontrada`,
          appointmentData: {
            id: appointment.id,
            status: appointment.status,
            dataHoraInicio: appointment.dataHoraInicio,
            cliente: appointment.cliente,
            servico: appointment.servico
          },
          severity: this.calculateMissingSeverity(appointment)
        });
      } else {
        // Verifica consistência das notificações existentes
        for (const notification of appointmentNotifications) {
          const statusDivergence = this.checkStatusConsistency(appointment, notification);
          if (statusDivergence) {
            divergences.push(statusDivergence);
          }
        }
      }
    }

    // 2. Verifica notificações órfãs (sem agendamento correspondente)
    for (const [appointmentId, appointmentNotifications] of notificationMap) {
      if (!appointmentMap.has(appointmentId)) {
        for (const notification of appointmentNotifications) {
          divergences.push({
            type: 'orphan_notification',
            notificationId: notification.id,
            appointmentId,
            description: `Notificação ${notification.id} referencia agendamento ${appointmentId} que não existe`,
            notificationData: {
              id: notification.id,
              kind: notification.kind,
              phone: notification.phone,
              createdAt: notification.createdAt
            },
            severity: 'medium'
          });
        }
      }
    }

    return divergences;
  }

  /**
   * Verifica se um agendamento deveria ter notificação
   */
  private shouldHaveNotification(appointment: TrinksAppointment): boolean {
    // Só agendamentos confirmados ou agendados com telefone
    return (
      ['agendado', 'confirmado'].includes(appointment.status) &&
      !!appointment.cliente.telefone
    );
  }

  /**
   * Calcula severidade de notificação faltante
   */
  private calculateMissingSeverity(appointment: TrinksAppointment): 'low' | 'medium' | 'high' {
    const appointmentDate = new Date(appointment.dataHoraInicio);
    const now = new Date();
    const diffHours = (now.getTime() - appointmentDate.getTime()) / (1000 * 60 * 60);
    
    // Se o agendamento foi há mais de 48h, é baixa severidade
    if (diffHours > 48) {
      return 'low';
    }
    
    // Se foi nas últimas 24h, é alta severidade
    if (diffHours <= 24) {
      return 'high';
    }
    
    return 'medium';
  }

  /**
   * Verifica consistência de status entre agendamento e notificação
   */
  private checkStatusConsistency(
    appointment: TrinksAppointment,
    notification: NotificationRecord
  ): AuditDivergence | null {
    // Verifica se o status do agendamento é consistente com o tipo de notificação
    const inconsistencies: string[] = [];
    
    // Se agendamento foi cancelado mas tem notificação de pré-visita
    if (appointment.status === 'cancelado' && notification.kind === 'previsit') {
      inconsistencies.push('Agendamento cancelado mas tem notificação de pré-visita');
    }
    
    // Se agendamento está confirmado mas tem notificação de no-show
    if (appointment.status === 'confirmado' && notification.kind.startsWith('noshow_')) {
      inconsistencies.push('Agendamento confirmado mas tem notificação de no-show');
    }
    
    if (inconsistencies.length > 0) {
      return {
        type: 'status_mismatch',
        appointmentId: appointment.id,
        notificationId: notification.id,
        description: inconsistencies.join('; '),
        appointmentData: {
          id: appointment.id,
          status: appointment.status
        },
        notificationData: {
          id: notification.id,
          kind: notification.kind
        },
        severity: 'medium'
      };
    }
    
    return null;
  }

  /**
   * Salva relatório de auditoria
   */
  private async saveAuditReport(report: AuditReport): Promise<void> {
    try {
      // Registra como notificação especial de auditoria
      const dedupeKey = `audit_report:${report.date}:${this.config.tenantId}`;
      
      await this.notificationsService.logNotification(
        dedupeKey,
        'system', // Phone especial para sistema
        'audit',
        {
          auditDate: report.date,
          summary: report.summary,
          divergences: report.divergences,
          executionTime: report.executionTime
        }
      );
      
      logger.info('Relatório de auditoria salvo', {
        date: report.date,
        totalDivergences: report.summary.totalDivergences,
        tenantId: this.config.tenantId
      });
    } catch (error) {
      logger.error('Erro ao salvar relatório de auditoria', {
        date: report.date,
        error: error.message,
        tenantId: this.config.tenantId
      });
    }
  }

  /**
   * Executa auditoria manual para uma data específica
   */
  async auditSpecificDate(dateStr: string): Promise<AuditReport> {
    if (this.isRunning) {
      throw new Error('Worker já está executando');
    }
    
    logger.info('Executando auditoria manual', {
      date: dateStr,
      tenantId: this.config.tenantId
    });
    
    return await this.auditDate(dateStr);
  }

  /**
   * Obtém relatórios de auditoria salvos
   */
  async getAuditReports(limit: number = 10): Promise<NotificationRecord[]> {
    return await this.notificationsService.getNotificationsByKind('audit', limit);
  }

  /**
   * Obtém status do worker
   */
  getStatus(): {
    isRunning: boolean;
    isScheduled: boolean;
    config: AuditWorkerConfig;
  } {
    return {
      isRunning: this.isRunning,
      isScheduled: this.cronJob !== null,
      config: this.config
    };
  }
}

/**
 * Factory function para criar worker de auditoria
 */
export async function createAuditWorker(tenantId: string): Promise<AuditWorker> {
  // Carrega configurações
  const enabledConfig = await configService.get(tenantId, 'audit_enabled');
  const cronConfig = await configService.get(tenantId, 'audit_cron_expression');
  const timezoneConfig = await configService.get(tenantId, 'timezone');
  const daysToAuditConfig = await configService.get(tenantId, 'audit_days_to_audit');

  const config: AuditWorkerConfig = {
    enabled: enabledConfig?.value === 'true' || enabledConfig?.value === true,
    cronExpression: cronConfig?.value || '0 2 * * *', // 2h da manhã por padrão
    timezone: timezoneConfig?.value || 'America/Bahia',
    tenantId,
    daysToAudit: parseInt(daysToAuditConfig?.value || '7') // 7 dias por padrão
  };

  return new AuditWorker(config);
}