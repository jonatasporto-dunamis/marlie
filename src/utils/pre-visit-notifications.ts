import logger from './logger';
import { pg } from '../db/index';
import * as trinks from '../integrations/trinks';

// Interfaces para notificações de pré-visita
interface PreVisitNotification {
  id: number;
  clientPhone: string;
  clientName: string;
  serviceName: string;
  appointmentDate: Date;
  appointmentTime: string;
  professionalName?: string;
  notificationType: 'reminder_24h' | 'reminder_2h' | 'confirmation' | 'no_show_prevention';
  status: 'pending' | 'sent' | 'failed';
  scheduledFor: Date;
  sentAt?: Date;
  metadata?: Record<string, any>;
}

interface NoShowShieldConfig {
  enabled: boolean;
  reminderIntervals: number[]; // em horas antes do agendamento
  confirmationRequired: boolean;
  autoRescheduleOnNoShow: boolean;
  maxNoShowCount: number;
}

// Configuração padrão do No-Show Shield
const DEFAULT_NO_SHOW_CONFIG: NoShowShieldConfig = {
  enabled: true,
  reminderIntervals: [24, 2], // 24h e 2h antes
  confirmationRequired: true,
  autoRescheduleOnNoShow: false,
  maxNoShowCount: 3
};

// Templates de mensagens
const MESSAGE_TEMPLATES = {
  reminder_24h: {
    baiano: (data: any) => `Oi ${data.clientName}! 🌟 Lembrete carinhoso: você tem agendamento amanhã às ${data.appointmentTime} para ${data.serviceName}. Tá tudo certo? Se precisar remarcar, é só me avisar! 💅✨`,
    neutro: (data: any) => `Olá ${data.clientName}! 🌟 Lembrete: você tem agendamento amanhã às ${data.appointmentTime} para ${data.serviceName}. Confirma presença? Se precisar remarcar, me avise! 💅`
  },
  reminder_2h: {
    baiano: (data: any) => `Oi meu bem! 💖 Seu horário de ${data.serviceName} é daqui a 2 horas (${data.appointmentTime}). Já tá se arrumando? Qualquer coisa me chama! 🥰`,
    neutro: (data: any) => `Olá! 💖 Seu agendamento de ${data.serviceName} é em 2 horas (${data.appointmentTime}). Confirma presença? Qualquer dúvida, me avise! 🥰`
  },
  confirmation: {
    baiano: (data: any) => `Oi querida! 💅 Preciso confirmar seu agendamento de ${data.serviceName} hoje às ${data.appointmentTime}. Responda com SIM para confirmar ou me avise se precisar remarcar! ✨`,
    neutro: (data: any) => `Olá! 💅 Confirme seu agendamento de ${data.serviceName} hoje às ${data.appointmentTime}. Responda SIM para confirmar ou me avise se precisar remarcar! ✨`
  },
  no_show_prevention: {
    baiano: (data: any) => `Oi ${data.clientName}! 😊 Notei que você perdeu alguns agendamentos recentemente. Que tal reagendarmos com um horário que seja mais fácil pra você? Estou aqui para ajudar! 💖`,
    neutro: (data: any) => `Olá ${data.clientName}! 😊 Vamos reagendar seu próximo horário? Quero garantir que você consiga vir. Me diga qual horário funciona melhor! 💖`
  }
};

export class PreVisitNotificationEngine {
  private tenantId: string;
  private config: NoShowShieldConfig;

  constructor(tenantId: string, config?: Partial<NoShowShieldConfig>) {
    this.tenantId = tenantId;
    this.config = { ...DEFAULT_NO_SHOW_CONFIG, ...config };
  }

  /**
   * Agenda notificações de pré-visita para um agendamento
   */
  async schedulePreVisitNotifications(
    clientPhone: string,
    clientName: string,
    serviceName: string,
    appointmentDate: Date,
    appointmentTime: string,
    professionalName?: string
  ): Promise<void> {
    try {
      if (!this.config.enabled) {
        logger.debug('Notificações de pré-visita desabilitadas');
        return;
      }

      // Agendar lembretes baseados nos intervalos configurados
      for (const intervalHours of this.config.reminderIntervals) {
        const scheduledFor = new Date(appointmentDate.getTime() - (intervalHours * 60 * 60 * 1000));
        
        // Não agendar para o passado
        if (scheduledFor > new Date()) {
          const notificationType = intervalHours === 24 ? 'reminder_24h' : 
                                 intervalHours === 2 ? 'reminder_2h' : 'confirmation';
          
          await this.createNotification({
            clientPhone,
            clientName,
            serviceName,
            appointmentDate,
            appointmentTime,
            professionalName,
            notificationType,
            scheduledFor
          });
        }
      }

      // Agendar confirmação se habilitada
      if (this.config.confirmationRequired) {
        const confirmationTime = new Date(appointmentDate.getTime() - (4 * 60 * 60 * 1000)); // 4h antes
        
        if (confirmationTime > new Date()) {
          await this.createNotification({
            clientPhone,
            clientName,
            serviceName,
            appointmentDate,
            appointmentTime,
            professionalName,
            notificationType: 'confirmation',
            scheduledFor: confirmationTime
          });
        }
      }

      logger.info(`Notificações de pré-visita agendadas para ${clientPhone}`);
    } catch (error) {
      logger.error('Erro ao agendar notificações de pré-visita:', error);
    }
  }

  /**
   * Cria uma notificação no banco de dados
   */
  private async createNotification(data: {
    clientPhone: string;
    clientName: string;
    serviceName: string;
    appointmentDate: Date;
    appointmentTime: string;
    professionalName?: string;
    notificationType: PreVisitNotification['notificationType'];
    scheduledFor: Date;
  }): Promise<void> {
    const insertQuery = `
      INSERT INTO pre_visit_notifications (
        tenant_id, client_phone, client_name, service_name, 
        appointment_date, appointment_time, professional_name,
        notification_type, status, scheduled_for, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `;

    // TODO: Implementar inserção no banco quando query estiver disponível
    // await query(insertQuery, [...]);
    logger.info('PreVisitNotification: Notificação agendada (implementação temporária)', {
      clientPhone: data.clientPhone,
      notificationType: data.notificationType,
      scheduledFor: data.scheduledFor
    });
  }

  /**
   * Processa notificações pendentes que devem ser enviadas
   */
  async processPendingNotifications(): Promise<void> {
    try {
      const pendingQuery = `
        SELECT * FROM pre_visit_notifications 
        WHERE tenant_id = $1 
          AND status = 'pending' 
          AND scheduled_for <= NOW()
        ORDER BY scheduled_for ASC
        LIMIT 50
      `;

      // TODO: Implementar busca no banco quando query estiver disponível
      // const result = await query(pendingQuery, [this.tenantId]);
      
      // Implementação temporária - sem notificações pendentes
      const result = { rows: [] };
      
      for (const notification of result.rows) {
        await this.sendNotification(notification);
      }

      logger.info(`Processadas ${result.rows.length} notificações pendentes (implementação temporária)`);
    } catch (error) {
      logger.error('Erro ao processar notificações pendentes:', error);
    }
  }

  /**
   * Envia uma notificação específica
   */
  private async sendNotification(notification: any): Promise<void> {
    try {
      // Detectar dialeto do cliente (simplificado)
      const dialect = await this.detectClientDialect(notification.client_phone);
      
      // Gerar mensagem baseada no template
      const template = MESSAGE_TEMPLATES[notification.notification_type as keyof typeof MESSAGE_TEMPLATES];
      const message = template[dialect]({
        clientName: notification.client_name,
        serviceName: notification.service_name,
        appointmentTime: notification.appointment_time,
        professionalName: notification.professional_name
      });

      // Enviar via webhook (simulação - adaptar para seu sistema)
      await this.sendWhatsAppMessage(notification.client_phone, message);

      // Marcar como enviada
      await this.markNotificationAsSent(notification.id);

      logger.info(`Notificação enviada para ${notification.client_phone}: ${notification.notification_type}`);
    } catch (error: any) {
      logger.error(`Erro ao enviar notificação ${notification.id}:`, error);
      await this.markNotificationAsFailed(notification.id, error.message);
    }
  }

  /**
   * Detecta o dialeto preferido do cliente
   */
  private async detectClientDialect(clientPhone: string): Promise<'baiano' | 'neutro'> {
    try {
      // Buscar histórico de mensagens do cliente para detectar dialeto
      const historyQuery = `
        SELECT message_text FROM conversation_history 
        WHERE tenant_id = $1 AND phone = $2 
        ORDER BY created_at DESC LIMIT 10
      `;
      
      const result = await pg?.query(historyQuery, [this.tenantId, clientPhone]);
      if (!result) return 'neutro';
      
      // Palavras-chave baianas
      const baianoKeywords = ['oxe', 'vixe', 'meu rei', 'minha nega', 'danado', 'arretado', 'massa'];
      
      const messages = result.rows.map((row: any) => row.message_text?.toLowerCase() || '').join(' ');
      const hasBaianoWords = baianoKeywords.some(keyword => messages.includes(keyword));
      
      return hasBaianoWords ? 'baiano' : 'neutro';
    } catch (error) {
      logger.error('Erro ao detectar dialeto:', error);
      return 'neutro'; // fallback
    }
  }

  /**
   * Envia mensagem via WhatsApp
   */
  private async sendWhatsAppMessage(phone: string, message: string): Promise<void> {
    // Implementar integração com seu provedor de WhatsApp
    // Por exemplo: Evolution API, Baileys, etc.
    logger.info(`Enviando WhatsApp para ${phone}: ${message}`);
    
    // Simulação - substituir pela implementação real
    // await evolutionAPI.sendMessage(phone, message);
  }

  /**
   * Marca notificação como enviada
   */
  private async markNotificationAsSent(notificationId: number): Promise<void> {
    const updateQuery = `
      UPDATE pre_visit_notifications 
      SET status = 'sent', sent_at = NOW() 
      WHERE id = $1
    `;
    
    // TODO: Implementar update no banco quando query estiver disponível
    // await query(updateQuery, [notificationId]);
    logger.info(`Notificação ${notificationId} marcada como enviada (implementação temporária)`);
  }

  /**
   * Marca notificação como falhada
   */
  private async markNotificationAsFailed(notificationId: number, errorMessage: string): Promise<void> {
    const updateQuery = `
      UPDATE pre_visit_notifications 
      SET status = 'failed', metadata = jsonb_set(COALESCE(metadata, '{}'), '{error}', $2) 
      WHERE id = $1
    `;
    
    // TODO: Implementar update no banco quando query estiver disponível
    // await query(updateQuery, [notificationId, JSON.stringify(errorMessage)]);
    logger.error(`Notificação ${notificationId} marcada como falhada: ${errorMessage} (implementação temporária)`);
  }

  /**
   * Implementa lógica de No-Show Shield
   */
  async handleNoShowShield(clientPhone: string): Promise<void> {
    try {
      // Contar no-shows recentes do cliente
      const noShowCount = await this.getClientNoShowCount(clientPhone);
      
      if (noShowCount >= this.config.maxNoShowCount) {
        // Enviar mensagem preventiva
        await this.sendNoShowPreventionMessage(clientPhone);
        
        // Se configurado, oferecer reagendamento automático
        if (this.config.autoRescheduleOnNoShow) {
          await this.offerAutoReschedule(clientPhone);
        }
      }
    } catch (error) {
      logger.error('Erro no No-Show Shield:', error);
    }
  }

  /**
   * Conta no-shows do cliente nos últimos 30 dias
   */
  private async getClientNoShowCount(clientPhone: string): Promise<number> {
    const countQuery = `
      SELECT COUNT(*) as no_show_count
      FROM appointment_history 
      WHERE tenant_id = $1 
        AND client_phone = $2 
        AND status = 'no_show'
        AND created_at >= NOW() - INTERVAL '30 days'
    `;
    
    // TODO: Implementar busca no banco quando query estiver disponível
    // const result = await query(countQuery, [this.tenantId, clientPhone]);
    // return parseInt(result.rows[0]?.no_show_count || '0');
    
    // Implementação temporária - retorna 0 no-shows
    logger.info(`Verificando no-shows para ${clientPhone} (implementação temporária)`);
    return 0;
  }

  /**
   * Envia mensagem de prevenção de no-show
   */
  private async sendNoShowPreventionMessage(clientPhone: string): Promise<void> {
    const dialect = await this.detectClientDialect(clientPhone);
    const template = MESSAGE_TEMPLATES.no_show_prevention[dialect];
    
    // Buscar nome do cliente
    const clientQuery = `
      SELECT client_name FROM client_sessions 
      WHERE tenant_id = $1 AND phone = $2 
      ORDER BY last_activity DESC LIMIT 1
    `;
    
    // TODO: Implementar busca no banco quando query estiver disponível
    // const clientResult = await query(clientQuery, [this.tenantId, clientPhone]);
    // const clientName = clientResult.rows[0]?.client_name || 'Cliente';
    
    // Implementação temporária - usa nome genérico
    const clientName = 'Cliente';
    
    const message = template({ clientName });
    await this.sendWhatsAppMessage(clientPhone, message);
  }

  /**
   * Oferece reagendamento automático
   */
  private async offerAutoReschedule(clientPhone: string): Promise<void> {
    // Implementar lógica de reagendamento automático
    logger.info(`Oferecendo reagendamento automático para ${clientPhone}`);
  }

  /**
   * Obtém estatísticas das notificações
   */
  async getNotificationStats(): Promise<{
    totalSent: number;
    totalFailed: number;
    totalPending: number;
    successRate: number;
  }> {
    const statsQuery = `
      SELECT 
        COUNT(CASE WHEN status = 'sent' THEN 1 END) as sent_count,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count,
        COUNT(*) as total_count
      FROM pre_visit_notifications 
      WHERE tenant_id = $1 
        AND created_at >= NOW() - INTERVAL '30 days'
    `;
    
    // TODO: Implementar busca no banco quando query estiver disponível
    // const result = await query(statsQuery, [this.tenantId]);
    // const stats = result.rows[0];
    
    // Implementação temporária - retorna estatísticas zeradas
    const totalSent = 0;
    const totalFailed = 0;
    const totalPending = 0;
    const totalCount = 0;
    
    logger.info('Obtendo estatísticas de notificações (implementação temporária)');
    
    return {
      totalSent,
      totalFailed,
      totalPending,
      successRate: totalCount > 0 ? (totalSent / totalCount) * 100 : 0
    };
  }
}

// Função utilitária para inicializar o sistema de notificações
export async function initializePreVisitNotifications(tenantId: string = 'default'): Promise<PreVisitNotificationEngine> {
  const engine = new PreVisitNotificationEngine(tenantId);
  
  // Processar notificações pendentes na inicialização
  await engine.processPendingNotifications();
  
  return engine;
}

// Função para agendar processamento periódico
export function scheduleNotificationProcessing(engine: PreVisitNotificationEngine, intervalMinutes: number = 15): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      await engine.processPendingNotifications();
    } catch (error) {
      logger.error('Erro no processamento periódico de notificações:', error);
    }
  }, intervalMinutes * 60 * 1000);
}

export { NoShowShieldConfig, MESSAGE_TEMPLATES };