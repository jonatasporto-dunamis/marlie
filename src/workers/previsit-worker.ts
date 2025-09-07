import * as cron from 'node-cron';
import { logger } from '../utils/logger';
import { TrinksAppointmentsService, TrinksAppointment } from '../services/trinks-appointments';
import { NotificationsLogService } from '../services/notifications-log';
import { AutoMessageTemplates } from '../services/auto-message-templates';
import { configService } from '../services/config';
import { format, addDays, startOfDay, endOfDay } from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import axios from 'axios';
import { setConversationState } from '../db';

/**
 * Interface para configuração do worker
 */
interface PreVisitConfig {
  enabled: boolean;
  hour: number; // 0-23
  timezone: string;
  tenantId: string;
  evolutionBaseUrl: string;
  evolutionApiKey: string;
  evolutionInstance: string;
}

/**
 * Interface para estatísticas de execução
 */
interface ExecutionStats {
  totalAppointments: number;
  sentNotifications: number;
  skippedDuplicates: number;
  errors: number;
  executionTime: number;
}

/**
 * Worker diário de pré-visita
 */
export class PreVisitWorker {
  private isRunning: boolean = false;
  private cronJob: cron.ScheduledTask | null = null;
  private config: PreVisitConfig;
  private trinksService: TrinksAppointmentsService;
  private notificationsService: NotificationsLogService;
  private templates: AutoMessageTemplates;

  constructor(config: PreVisitConfig) {
    this.config = config;
    this.trinksService = new TrinksAppointmentsService(config.tenantId);
    this.notificationsService = new NotificationsLogService(config.tenantId);
    this.templates = new AutoMessageTemplates();
  }

  /**
   * Inicia o worker com agendamento cron
   */
  start(): void {
    if (!this.config.enabled) {
      logger.info('PreVisit Worker desabilitado', { tenantId: this.config.tenantId });
      return;
    }

    // Agenda para executar diariamente no horário configurado
    const cronExpression = `0 ${this.config.hour} * * *`;
    
    this.cronJob = cron.schedule(cronExpression, async () => {
      await this.executePreVisitRun();
    }, {
      timezone: this.config.timezone
    });

    logger.info('PreVisit Worker iniciado', {
      cronExpression,
      hour: this.config.hour,
      timezone: this.config.timezone,
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
    
    logger.info('PreVisit Worker parado', { tenantId: this.config.tenantId });
  }

  /**
   * Executa uma rodada de pré-visita manualmente
   */
  async executePreVisitRun(): Promise<ExecutionStats> {
    if (this.isRunning) {
      logger.warn('PreVisit Worker já está executando', { tenantId: this.config.tenantId });
      throw new Error('Worker já está executando');
    }

    this.isRunning = true;
    const startTime = Date.now();
    
    const stats: ExecutionStats = {
      totalAppointments: 0,
      sentNotifications: 0,
      skippedDuplicates: 0,
      errors: 0,
      executionTime: 0
    };

    try {
      logger.info('Iniciando execução PreVisit Worker', { tenantId: this.config.tenantId });

      // Calcula data de amanhã no timezone configurado
      const now = new Date();
      const zonedNow = toZonedTime(now, this.config.timezone);
      const tomorrow = addDays(zonedNow, 1);
      
      const startOfTomorrow = startOfDay(tomorrow);
      const endOfTomorrow = endOfDay(tomorrow);
      
      // Converte para UTC para a API
      const dataInicio = fromZonedTime(startOfTomorrow, this.config.timezone).toISOString();
      const dataFim = fromZonedTime(endOfTomorrow, this.config.timezone).toISOString();

      logger.info('Buscando agendamentos para amanhã', {
        dataInicio,
        dataFim,
        timezone: this.config.timezone,
        tenantId: this.config.tenantId
      });

      // Busca todos os agendamentos de amanhã
      const appointments = await this.fetchAllAppointments(dataInicio, dataFim);
      stats.totalAppointments = appointments.length;

      logger.info(`Encontrados ${appointments.length} agendamentos`, {
        tenantId: this.config.tenantId
      });

      // Processa cada agendamento
      for (const appointment of appointments) {
        try {
          await this.processAppointment(appointment, stats);
        } catch (error) {
          stats.errors++;
          logger.error('Erro ao processar agendamento', {
            appointmentId: appointment.id,
            error: error.message,
            tenantId: this.config.tenantId
          });
        }
      }

      stats.executionTime = Date.now() - startTime;

      logger.info('Execução PreVisit Worker concluída', {
        stats,
        tenantId: this.config.tenantId
      });

      return stats;
    } catch (error) {
      stats.executionTime = Date.now() - startTime;
      stats.errors++;
      
      logger.error('Erro na execução PreVisit Worker', {
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
      const response = await this.trinksService.fetchAppointments(dataInicio, dataFim, page);
      allAppointments.push(...response.agendamentos);
      
      hasMore = page < response.totalPages;
      page++;
    }

    return allAppointments;
  }

  /**
   * Processa um agendamento individual
   */
  private async processAppointment(
    appointment: TrinksAppointment,
    stats: ExecutionStats
  ): Promise<void> {
    // Só processa agendamentos confirmados ou agendados
    if (!['agendado', 'confirmado'].includes(appointment.status)) {
      logger.debug('Agendamento ignorado por status', {
        appointmentId: appointment.id,
        status: appointment.status,
        tenantId: this.config.tenantId
      });
      return;
    }

    // Verifica se tem telefone
    if (!appointment.cliente.telefone) {
      logger.warn('Agendamento sem telefone', {
        appointmentId: appointment.id,
        clienteNome: appointment.cliente.nome,
        tenantId: this.config.tenantId
      });
      return;
    }

    // Gera chave de deduplicação
    const appointmentDate = format(new Date(appointment.dataHoraInicio), 'yyyy-MM-dd');
    const dedupeKey = `previsit:${appointment.id}:${appointmentDate}`;

    // Verifica se já foi enviado
    const alreadySent = await this.notificationsService.hasNotification(dedupeKey);
    if (alreadySent) {
      stats.skippedDuplicates++;
      logger.debug('Notificação já enviada (deduplicação)', {
        appointmentId: appointment.id,
        dedupeKey,
        tenantId: this.config.tenantId
      });
      return;
    }

    // Gera mensagem
    const message = this.templates.getPreVisitMessage(appointment);

    // Envia mensagem
    await this.sendWhatsAppMessage(appointment.cliente.telefone, message, appointment);

    // Registra no log
    await this.notificationsService.logNotification(
      dedupeKey,
      appointment.cliente.telefone,
      'previsit',
      {
        appointmentId: appointment.id,
        clienteNome: appointment.cliente.nome,
        servicoNome: appointment.servico.nome,
        dataHoraInicio: appointment.dataHoraInicio
      }
    );

    stats.sentNotifications++;

    logger.info('Notificação de pré-visita enviada', {
      appointmentId: appointment.id,
      clienteNome: appointment.cliente.nome,
      telefone: appointment.cliente.telefone,
      tenantId: this.config.tenantId
    });
  }

  /**
   * Envia mensagem via WhatsApp (Evolution API)
   */
  private async sendWhatsAppMessage(
    phone: string, 
    text: string, 
    appointment?: TrinksAppointment
  ): Promise<void> {
    try {
      const response = await axios.post(
        `${this.config.evolutionBaseUrl}/message/sendText/${this.config.evolutionInstance}`,
        {
          number: phone,
          text: text
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'apikey': this.config.evolutionApiKey
          },
          timeout: 30000
        }
      );

      // Salvar contexto conforme especificado nos requisitos
      if (appointment) {
        await this.saveConversationContext(phone, appointment);
      }

      logger.debug('Mensagem WhatsApp enviada', {
        phone,
        status: response.status,
        tenantId: this.config.tenantId
      });
    } catch (error) {
      logger.error('Erro ao enviar mensagem WhatsApp', {
        phone,
        error: error.message,
        tenantId: this.config.tenantId
      });
      throw error;
    }
  }

  /**
   * Salva contexto da conversa para correlacionar respostas
   */
  private async saveConversationContext(
    phone: string, 
    appointment: TrinksAppointment
  ): Promise<void> {
    try {
      // Formatar data/hora no timezone local (America/Bahia)
      const appointmentDate = toZonedTime(
        new Date(appointment.dataHoraInicio), 
        this.config.timezone
      );
      
      const formattedDate = format(appointmentDate, 'dd/MM/yyyy');
      const formattedTime = format(appointmentDate, 'HH:mm');
      
      // Salvar contexto conforme especificado nos requisitos
      await setConversationState(this.config.tenantId, phone, {
        etapaAtual: 'aguardando_resposta_previsit',
        slots: {
          last_outbound_kind: 'previsit',
          appointment: {
            id: appointment.id,
            clienteNome: appointment.cliente.nome,
            servicoNome: appointment.servico.nome,
            profissionalNome: appointment.profissional.nome,
            dataHoraInicio: appointment.dataHoraInicio,
            dataFormatada: formattedDate,
            horaFormatada: formattedTime,
            telefone: appointment.cliente.telefone
          }
        },
        messageHistory: []
      });
      
      logger.debug('Contexto de conversa salvo para pré-visita', {
        phone,
        appointmentId: appointment.id,
        tenantId: this.config.tenantId
      });
    } catch (error) {
      logger.error('Erro ao salvar contexto de conversa', {
        phone,
        appointmentId: appointment.id,
        error: error.message,
        tenantId: this.config.tenantId
      });
      // Não propagar erro para não interromper o envio da mensagem
    }
  }

  /**
   * Obtém status do worker
   */
  getStatus(): {
    isRunning: boolean;
    isScheduled: boolean;
    config: PreVisitConfig;
  } {
    return {
      isRunning: this.isRunning,
      isScheduled: !!this.cronJob,
      config: this.config
    };
  }
}

/**
 * Factory function para criar worker de pré-visita
 */
export async function createPreVisitWorker(tenantId: string): Promise<PreVisitWorker> {
  // Carrega configurações
  const enabledConfig = await configService.get(tenantId, 'previsit_enabled');
  const hourConfig = await configService.get(tenantId, 'previsit_hour');
  const timezoneConfig = await configService.get(tenantId, 'timezone');
  const evolutionBaseUrlConfig = await configService.get(tenantId, 'evolution_base_url');
  const evolutionApiKeyConfig = await configService.get(tenantId, 'evolution_api_key');
  const evolutionInstanceConfig = await configService.get(tenantId, 'evolution_instance');

  const config: PreVisitConfig = {
    enabled: enabledConfig?.value === 'true' || String(enabledConfig?.value) === 'true',
    hour: parseInt(hourConfig?.value || '18'),
    timezone: timezoneConfig?.value || 'America/Bahia',
    tenantId,
    evolutionBaseUrl: evolutionBaseUrlConfig?.value || '',
    evolutionApiKey: evolutionApiKeyConfig?.value || '',
    evolutionInstance: evolutionInstanceConfig?.value || ''
  };

  if (!config.evolutionBaseUrl || !config.evolutionApiKey || !config.evolutionInstance) {
    throw new Error('Configuração Evolution API incompleta');
  }

  return new PreVisitWorker(config);
}