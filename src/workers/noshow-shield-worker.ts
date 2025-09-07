import * as cron from 'node-cron';
import { logger } from '../utils/logger';
import { TrinksAppointmentsService, TrinksAppointment, TrinksSlot } from '../services/trinks-appointments';
import { NotificationsLogService } from '../services/notifications-log';
import { AutoMessageTemplates, RebookSlot } from '../services/auto-message-templates';
import { configService } from '../services/config';
import { getRedis } from '../infra/redis';
import { format, addDays, startOfDay, endOfDay, parseISO } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { ptBR } from 'date-fns/locale';
import axios from 'axios';
import { Redis } from 'ioredis';

/**
 * Interface para configuração do worker
 */
interface NoShowShieldConfig {
  enabled: boolean;
  hour: number; // 0-23
  timezone: string;
  tenantId: string;
  evolutionBaseUrl: string;
  evolutionApiKey: string;
  evolutionInstance: string;
}

/**
 * Interface para resposta pendente
 */
interface PendingResponse {
  appointmentId: string;
  phone: string;
  questionSentAt: string;
  expiresAt: string;
}

/**
 * Interface para estatísticas de execução
 */
interface ExecutionStats {
  totalAppointments: number;
  sentQuestions: number;
  skippedDuplicates: number;
  processedResponses: number;
  errors: number;
  executionTime: number;
}

/**
 * Worker de no-show shield
 */
export class NoShowShieldWorker {
  private isRunning: boolean = false;
  private cronJob: cron.ScheduledTask | null = null;
  private config: NoShowShieldConfig;
  private trinksService: TrinksAppointmentsService;
  private notificationsService: NotificationsLogService;
  private templates: AutoMessageTemplates;
  private redis: Redis;

  constructor(config: NoShowShieldConfig) {
    this.config = config;
    this.trinksService = new TrinksAppointmentsService(config.tenantId);
    this.notificationsService = new NotificationsLogService(config.tenantId);
    this.templates = new AutoMessageTemplates();
  }

  /**
   * Inicializa o worker
   */
  async initialize(): Promise<void> {
    this.redis = await getRedis();
  }

  /**
   * Inicia o worker com agendamento cron
   */
  start(): void {
    if (!this.config.enabled) {
      logger.info('NoShow Shield Worker desabilitado', { tenantId: this.config.tenantId });
      return;
    }

    // Agenda para executar diariamente no horário configurado
    const cronExpression = `0 ${this.config.hour} * * *`;
    
    this.cronJob = cron.schedule(cronExpression, async () => {
      await this.executeNoShowShieldRun();
    }, {
      scheduled: true,
      timezone: this.config.timezone
    });

    logger.info('NoShow Shield Worker iniciado', {
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
    
    logger.info('NoShow Shield Worker parado', { tenantId: this.config.tenantId });
  }

  /**
   * Executa uma rodada de no-show shield
   */
  async executeNoShowShieldRun(): Promise<ExecutionStats> {
    if (this.isRunning) {
      logger.warn('NoShow Shield Worker já está executando', { tenantId: this.config.tenantId });
      throw new Error('Worker já está executando');
    }

    this.isRunning = true;
    const startTime = Date.now();
    
    const stats: ExecutionStats = {
      totalAppointments: 0,
      sentQuestions: 0,
      skippedDuplicates: 0,
      processedResponses: 0,
      errors: 0,
      executionTime: 0
    };

    try {
      logger.info('Iniciando execução NoShow Shield Worker', { tenantId: this.config.tenantId });

      // Calcula data de amanhã no timezone configurado
      const now = new Date();
      const zonedNow = toZonedTime(now, this.config.timezone);
      const tomorrow = addDays(zonedNow, 1);
      
      const startOfTomorrow = startOfDay(tomorrow);
      const endOfTomorrow = endOfDay(tomorrow);
      
      // Converte para UTC para a API
      const dataInicio = fromZonedTime(startOfTomorrow, this.config.timezone).toISOString();
      const dataFim = fromZonedTime(endOfTomorrow, this.config.timezone).toISOString();

      logger.info('Buscando agendamentos para amanhã (no-show shield)', {
        dataInicio,
        dataFim,
        timezone: this.config.timezone,
        tenantId: this.config.tenantId
      });

      // Busca todos os agendamentos de amanhã
      const appointments = await this.fetchAllAppointments(dataInicio, dataFim);
      stats.totalAppointments = appointments.length;

      logger.info(`Encontrados ${appointments.length} agendamentos para no-show shield`, {
        tenantId: this.config.tenantId
      });

      // Processa cada agendamento
      for (const appointment of appointments) {
        try {
          await this.processAppointmentQuestion(appointment, stats);
        } catch (error) {
          stats.errors++;
          logger.error('Erro ao processar agendamento no-show shield', {
            appointmentId: appointment.id,
            error: error.message,
            tenantId: this.config.tenantId
          });
        }
      }

      stats.executionTime = Date.now() - startTime;

      logger.info('Execução NoShow Shield Worker concluída', {
        stats,
        tenantId: this.config.tenantId
      });

      return stats;
    } catch (error) {
      stats.executionTime = Date.now() - startTime;
      stats.errors++;
      
      logger.error('Erro na execução NoShow Shield Worker', {
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
   * Processa um agendamento enviando pergunta de confirmação
   */
  private async processAppointmentQuestion(
    appointment: TrinksAppointment,
    stats: ExecutionStats
  ): Promise<void> {
    // Só processa agendamentos confirmados ou agendados
    if (!['agendado', 'confirmado'].includes(appointment.status)) {
      logger.debug('Agendamento ignorado por status (no-show shield)', {
        appointmentId: appointment.id,
        status: appointment.status,
        tenantId: this.config.tenantId
      });
      return;
    }

    // Verifica se tem telefone
    if (!appointment.cliente.telefone) {
      logger.warn('Agendamento sem telefone (no-show shield)', {
        appointmentId: appointment.id,
        clienteNome: appointment.cliente.nome,
        tenantId: this.config.tenantId
      });
      return;
    }

    // Gera chave de deduplicação
    const appointmentDate = format(new Date(appointment.dataHoraInicio), 'yyyy-MM-dd');
    const dedupeKey = `noshow_question:${appointment.id}:${appointmentDate}`;

    // Verifica se já foi enviado
    const alreadySent = await this.notificationsService.hasNotification(dedupeKey);
    if (alreadySent) {
      stats.skippedDuplicates++;
      logger.debug('Pergunta no-show já enviada (deduplicação)', {
        appointmentId: appointment.id,
        dedupeKey,
        tenantId: this.config.tenantId
      });
      return;
    }

    // Gera mensagem de pergunta
    const message = this.templates.getNoShowShieldQuestion(appointment);

    // Envia mensagem
    await this.sendWhatsAppMessage(appointment.cliente.telefone, message);

    // Registra no log
    await this.notificationsService.logNotification(
      dedupeKey,
      appointment.cliente.telefone,
      'noshow_yes', // Será atualizado quando responder
      {
        appointmentId: appointment.id,
        clienteNome: appointment.cliente.nome,
        servicoNome: appointment.servico.nome,
        dataHoraInicio: appointment.dataHoraInicio,
        questionType: 'confirmation'
      }
    );

    // Armazena resposta pendente no Redis
    await this.storePendingResponse(appointment);

    stats.sentQuestions++;

    logger.info('Pergunta no-show shield enviada', {
      appointmentId: appointment.id,
      clienteNome: appointment.cliente.nome,
      telefone: appointment.cliente.telefone,
      tenantId: this.config.tenantId
    });
  }

  /**
   * Armazena resposta pendente no Redis
   */
  private async storePendingResponse(appointment: TrinksAppointment): Promise<void> {
    const key = `noshow_pending:${this.config.tenantId}:${appointment.cliente.telefone}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 horas
    
    const pendingResponse: PendingResponse = {
      appointmentId: appointment.id,
      phone: appointment.cliente.telefone,
      questionSentAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString()
    };

    await this.redis.setex(key, 24 * 60 * 60, JSON.stringify(pendingResponse));
  }

  /**
   * Processa resposta do usuário (SIM/NÃO)
   */
  async processUserResponse(
    phone: string,
    message: string
  ): Promise<{ processed: boolean; response?: string }> {
    const key = `noshow_pending:${this.config.tenantId}:${phone}`;
    const pendingData = await this.redis.get(key);
    
    if (!pendingData) {
      return { processed: false };
    }

    const pending: PendingResponse = JSON.parse(pendingData);
    const normalizedMessage = message.toLowerCase().trim();
    
    try {
      // Busca o agendamento atual
      const appointment = await this.trinksService.getAppointment(pending.appointmentId);
      
      if (normalizedMessage.includes('sim') || normalizedMessage.includes('s')) {
        // Resposta SIM - confirma presença
        await this.handleYesResponse(appointment, phone);
        await this.redis.del(key);
        return { 
          processed: true, 
          response: this.templates.getNoShowConfirmationYes(appointment)
        };
      } 
      else if (normalizedMessage.includes('não') || normalizedMessage.includes('nao') || normalizedMessage.includes('n')) {
        // Resposta NÃO - oferece reagendamento
        const response = await this.handleNoResponse(appointment, phone);
        // Não remove a chave ainda, aguarda escolha do slot
        return { processed: true, response };
      }
      else if (/^[1-9]$/.test(normalizedMessage)) {
        // Resposta numérica - escolha de slot
        const response = await this.handleSlotChoice(appointment, phone, parseInt(normalizedMessage));
        await this.redis.del(key);
        return { processed: true, response };
      }
      else if (normalizedMessage.includes('outro')) {
        // Solicita contato manual
        await this.redis.del(key);
        return { 
          processed: true, 
          response: this.templates.getNoSlotsAvailable(appointment)
        };
      }
      
      return { processed: false };
    } catch (error) {
      logger.error('Erro ao processar resposta no-show', {
        phone,
        message,
        appointmentId: pending.appointmentId,
        error: error.message,
        tenantId: this.config.tenantId
      });
      
      await this.redis.del(key);
      return { 
        processed: true, 
        response: 'Ops! Ocorreu um erro. Entre em contato conosco para reagendar.' 
      };
    }
  }

  /**
   * Processa resposta SIM
   */
  private async handleYesResponse(appointment: TrinksAppointment, phone: string): Promise<void> {
    const appointmentDate = format(new Date(appointment.dataHoraInicio), 'yyyy-MM-dd');
    const dedupeKey = `noshow_yes:${appointment.id}:${appointmentDate}`;
    
    await this.notificationsService.logNotification(
      dedupeKey,
      phone,
      'noshow_yes',
      {
        appointmentId: appointment.id,
        clienteNome: appointment.cliente.nome,
        response: 'SIM',
        confirmedAt: new Date().toISOString()
      }
    );

    logger.info('Presença confirmada (no-show shield)', {
      appointmentId: appointment.id,
      phone,
      tenantId: this.config.tenantId
    });
  }

  /**
   * Processa resposta NÃO
   */
  private async handleNoResponse(appointment: TrinksAppointment, phone: string): Promise<string> {
    const appointmentDate = format(new Date(appointment.dataHoraInicio), 'yyyy-MM-dd');
    const dedupeKey = `noshow_no:${appointment.id}:${appointmentDate}`;
    
    await this.notificationsService.logNotification(
      dedupeKey,
      phone,
      'noshow_no',
      {
        appointmentId: appointment.id,
        clienteNome: appointment.cliente.nome,
        response: 'NÃO',
        requestedRebookAt: new Date().toISOString()
      }
    );

    // Busca slots disponíveis
    const tomorrow = addDays(new Date(), 2); // Dia depois de amanhã
    const slots = await this.trinksService.searchSlots(
      appointment.servicoId,
      appointment.profissionalId,
      tomorrow.toISOString(),
      3
    );

    if (slots.slots.length === 0) {
      return this.templates.getNoSlotsAvailable(appointment);
    }

    // Converte slots para formato do template
    const rebookSlots: RebookSlot[] = slots.slots.map(slot => {
      const slotDate = parseISO(slot.dataHoraInicio);
      return {
        dataHoraInicio: slot.dataHoraInicio,
        dataFormatada: format(slotDate, "EEEE, dd 'de' MMMM", { locale: ptBR }),
        horaFormatada: format(slotDate, 'HH:mm'),
        profissionalNome: appointment.profissional.nome
      };
    });

    // Armazena slots no Redis para escolha posterior
    const slotsKey = `noshow_slots:${this.config.tenantId}:${phone}`;
    await this.redis.setex(slotsKey, 60 * 60, JSON.stringify(slots.slots)); // 1 hora

    return this.templates.getNoShowRebookOffer(appointment, rebookSlots);
  }

  /**
   * Processa escolha de slot
   */
  private async handleSlotChoice(
    appointment: TrinksAppointment,
    phone: string,
    choice: number
  ): Promise<string> {
    const slotsKey = `noshow_slots:${this.config.tenantId}:${phone}`;
    const slotsData = await this.redis.get(slotsKey);
    
    if (!slotsData) {
      return 'Ops! Os horários expiraram. Entre em contato conosco.';
    }

    const slots: TrinksSlot[] = JSON.parse(slotsData);
    const selectedSlot = slots[choice - 1];
    
    if (!selectedSlot) {
      return 'Opção inválida. Digite um número de 1 a ' + slots.length;
    }

    try {
      // Reagenda o agendamento
      await this.trinksService.rebookAppointment(
        appointment.id,
        selectedSlot.dataHoraInicio,
        appointment.servicoId,
        appointment.profissionalId
      );

      // Registra o reagendamento
      const appointmentDate = format(new Date(appointment.dataHoraInicio), 'yyyy-MM-dd');
      const dedupeKey = `rebook:${appointment.id}:${appointmentDate}`;
      
      await this.notificationsService.logNotification(
        dedupeKey,
        phone,
        'rebook',
        {
          appointmentId: appointment.id,
          oldDateTime: appointment.dataHoraInicio,
          newDateTime: selectedSlot.dataHoraInicio,
          rebookedAt: new Date().toISOString()
        }
      );

      // Remove slots do Redis
      await this.redis.del(slotsKey);

      // Converte slot para formato do template
      const slotDate = parseISO(selectedSlot.dataHoraInicio);
      const rebookSlot: RebookSlot = {
        dataHoraInicio: selectedSlot.dataHoraInicio,
        dataFormatada: format(slotDate, "EEEE, dd 'de' MMMM", { locale: ptBR }),
        horaFormatada: format(slotDate, 'HH:mm'),
        profissionalNome: appointment.profissional.nome
      };

      return this.templates.getRebookConfirmation(appointment, rebookSlot);
    } catch (error) {
      logger.error('Erro ao reagendar', {
        appointmentId: appointment.id,
        selectedSlot,
        error: error.message,
        tenantId: this.config.tenantId
      });
      
      return this.templates.getRebookError(appointment);
    }
  }

  /**
   * Envia mensagem via WhatsApp
   */
  private async sendWhatsAppMessage(phone: string, text: string): Promise<void> {
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

      logger.debug('Mensagem WhatsApp enviada (no-show shield)', {
        phone,
        status: response.status,
        tenantId: this.config.tenantId
      });
    } catch (error) {
      logger.error('Erro ao enviar mensagem WhatsApp (no-show shield)', {
        phone,
        error: error.message,
        tenantId: this.config.tenantId
      });
      throw error;
    }
  }

  /**
   * Obtém status do worker
   */
  getStatus(): {
    isRunning: boolean;
    isScheduled: boolean;
    config: NoShowShieldConfig;
  } {
    return {
      isRunning: this.isRunning,
      isScheduled: this.cronJob !== null,
      config: this.config
    };
  }
}

/**
 * Factory function para criar worker de no-show shield
 */
export async function createNoShowShieldWorker(tenantId: string): Promise<NoShowShieldWorker> {
  // Carrega configurações
  const enabledConfig = await configService.get(tenantId, 'noshow_shield_enabled');
  const hourConfig = await configService.get(tenantId, 'previsit_hour'); // Mesmo horário
  const timezoneConfig = await configService.get(tenantId, 'timezone');
  const evolutionBaseUrlConfig = await configService.get(tenantId, 'evolution_base_url');
  const evolutionApiKeyConfig = await configService.get(tenantId, 'evolution_api_key');
  const evolutionInstanceConfig = await configService.get(tenantId, 'evolution_instance');

  const config: NoShowShieldConfig = {
    enabled: enabledConfig?.value === 'true' || enabledConfig?.value === true,
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

  const worker = new NoShowShieldWorker(config);
  await worker.initialize();
  
  return worker;
}