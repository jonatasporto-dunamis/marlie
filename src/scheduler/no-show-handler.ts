import { Pool } from 'pg';
import logger from '../utils/logger';
import { MetricsHelper } from '../metrics';
import { MessageSchedulerWorker } from './worker';
import { evolutionAPI } from '../integrations/evolution';

interface NoShowResponse {
  tenantId: string;
  phone: string;
  message: string;
  bookingId?: string;
}

interface RescheduleContext {
  tenantId: string;
  phone: string;
  bookingId: string;
  originalServiceName: string;
  originalDate: string;
  originalTime: string;
}

export class NoShowHandler {
  private db: Pool;

  constructor(db: Pool) {
    this.db = db;
  }

  /**
   * Processa resposta do usuário para no-show check
   */
  async handleNoShowResponse(response: NoShowResponse): Promise<void> {
    try {
      const normalizedMessage = this.normalizeMessage(response.message);
      
      if (this.isConfirmationResponse(normalizedMessage)) {
        await this.handleConfirmation(response);
      } else if (this.isNegativeResponse(normalizedMessage)) {
        await this.handleRescheduleRequest(response);
      } else {
        await this.handleUnknownResponse(response);
      }
      
    } catch (error) {
      logger.error('Error handling no-show response:', error);
    }
  }

  /**
   * Normaliza mensagem do usuário (remove acentos, converte para minúsculo)
   */
  private normalizeMessage(message: string): string {
    return message
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Remove acentos
      .trim();
  }

  /**
   * Verifica se é uma resposta de confirmação
   */
  private isConfirmationResponse(message: string): boolean {
    const confirmationWords = [
      'sim', 'yes', 'confirmo', 'confirmado', 'ok', 'okay', 
      'vou', 'estarei', 'la', 'presente', 'certeza', 'claro',
      '✅', '👍', 'confirmar'
    ];
    
    return confirmationWords.some(word => message.includes(word));
  }

  /**
   * Verifica se é uma resposta negativa
   */
  private isNegativeResponse(message: string): boolean {
    const negativeWords = [
      'nao', 'não', 'no', 'nope', 'cancelar', 'remarcar', 
      'nao posso', 'nao vou', 'impossivel', 'imprevisto',
      'problema', 'emergencia', '❌', '👎', 'desmarcar'
    ];
    
    return negativeWords.some(word => message.includes(word));
  }

  /**
   * Processa confirmação de presença
   */
  private async handleConfirmation(response: NoShowResponse): Promise<void> {
    const confirmationMessage = `✅ *Presença confirmada!*\n\n` +
      `Obrigada por confirmar! Estamos ansiosos para atendê-la amanhã.\n\n` +
      `💡 *Lembrete:*\n` +
      `• Chegue 10 minutos antes\n` +
      `• Traga um documento com foto\n\n` +
      `Até amanhã! 💖`;
    
    await evolutionAPI.sendMessage({
      number: response.phone,
      text: confirmationMessage
    });
    
    // Registrar métrica de no-show prevenido
    MetricsHelper.incrementNoShowPrevented(response.tenantId);
    
    logger.info('No-show confirmation received', {
      tenant_id: response.tenantId,
      phone: this.maskPhone(response.phone),
      booking_id: response.bookingId
    });
  }

  /**
   * Processa solicitação de remarcação
   */
  private async handleRescheduleRequest(response: NoShowResponse): Promise<void> {
    // Buscar contexto do agendamento
    const rescheduleContext = await this.getRescheduleContext(
      response.tenantId,
      response.phone,
      response.bookingId
    );
    
    if (!rescheduleContext) {
      await this.sendGenericRescheduleMessage(response);
      return;
    }
    
    const rescheduleMessage = this.formatRescheduleMessage(rescheduleContext);
    
    await evolutionAPI.sendMessage({
      number: response.phone,
      text: rescheduleMessage
    });
    
    // Registrar métrica de solicitação de remarcação
    MetricsHelper.incrementRescheduleRequested(response.tenantId);
    
    logger.info('Reschedule request received', {
      tenant_id: response.tenantId,
      phone: this.maskPhone(response.phone),
      booking_id: response.bookingId
    });
  }

  /**
   * Processa resposta não reconhecida
   */
  private async handleUnknownResponse(response: NoShowResponse): Promise<void> {
    const clarificationMessage = `🤔 *Não entendi sua resposta*\n\n` +
      `Para confirmar sua presença no agendamento de amanhã, responda:\n\n` +
      `✅ *SIM* - para confirmar\n` +
      `❌ *NÃO* - se precisar remarcar\n\n` +
      `Aguardo sua confirmação! 😊`;
    
    await evolutionAPI.sendMessage({
      number: response.phone,
      text: clarificationMessage
    });
  }

  /**
   * Busca contexto para remarcação
   */
  private async getRescheduleContext(
    tenantId: string,
    phone: string,
    bookingId?: string
  ): Promise<RescheduleContext | null> {
    try {
      // Esta função deveria buscar dados reais do agendamento
      // Por enquanto, retorna dados mock
      if (!bookingId) {
        return null;
      }
      
      return {
        tenantId,
        phone,
        bookingId,
        originalServiceName: 'Corte de Cabelo',
        originalDate: new Date().toLocaleDateString('pt-BR'),
        originalTime: '14:00'
      };
      
    } catch (error) {
      logger.error('Error fetching reschedule context:', error);
      return null;
    }
  }

  /**
   * Formata mensagem de remarcação com contexto
   */
  private formatRescheduleMessage(context: RescheduleContext): string {
    return `📅 *Vamos remarcar seu agendamento*\n\n` +
      `*Agendamento atual:*\n` +
      `• Serviço: ${context.originalServiceName}\n` +
      `• Data: ${context.originalDate}\n` +
      `• Horário: ${context.originalTime}\n\n` +
      `Para remarcar, você pode:\n\n` +
      `📞 *Ligar:* (71) 99999-9999\n` +
      `💬 *WhatsApp:* Continuar esta conversa\n` +
      `🌐 *Site:* www.syncbelle.com\n\n` +
      `Ou me diga quando gostaria de remarcar e eu verifico a disponibilidade! 😊\n\n` +
      `_Exemplo: "Quero remarcar para sexta-feira de manhã"_`;
  }

  /**
   * Envia mensagem genérica de remarcação
   */
  private async sendGenericRescheduleMessage(response: NoShowResponse): Promise<void> {
    const genericMessage = `📅 *Entendi que precisa remarcar*\n\n` +
      `Sem problemas! Para remarcar seu agendamento:\n\n` +
      `📞 *Ligar:* (71) 99999-9999\n` +
      `💬 *WhatsApp:* Continue esta conversa\n` +
      `🌐 *Site:* www.syncbelle.com\n\n` +
      `Nossa equipe terá prazer em encontrar um novo horário para você! 😊`;
    
    await evolutionAPI.sendMessage({
      number: response.phone,
      text: genericMessage
    });
  }

  /**
   * Máscara telefone para logs (privacidade)
   */
  private maskPhone(phone: string): string {
    if (phone.length <= 6) return phone;
    const start = phone.substring(0, 3);
    const end = phone.substring(phone.length - 3);
    const middle = '*'.repeat(phone.length - 6);
    return `${start}${middle}${end}`;
  }

  /**
   * Verifica se uma mensagem é resposta a no-show check
   * Baseado no contexto da conversa recente
   */
  static async isNoShowResponse(
    db: Pool,
    tenantId: string,
    phone: string,
    messageTimestamp: Date
  ): Promise<boolean> {
    try {
      // Verifica se foi enviado um no-show check nas últimas 24 horas
      const query = `
        SELECT COUNT(*) as count
        FROM message_jobs 
        WHERE tenant_id = $1 
          AND phone_e164 = $2 
          AND kind = 'no_show_check'
          AND status = 'sent'
          AND updated_at >= $3
      `;
      
      const yesterday = new Date(messageTimestamp.getTime() - 24 * 60 * 60 * 1000);
      const result = await db.query(query, [tenantId, phone, yesterday]);
      
      return parseInt(result.rows[0].count) > 0;
      
    } catch (error) {
      logger.error('Error checking no-show response context:', error);
      return false;
    }
  }
}

// Export singleton instance
export const noShowHandler = new NoShowHandler(
  // Will be injected with actual DB pool in main app
  {} as Pool
);