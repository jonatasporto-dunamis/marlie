import { Redis } from 'ioredis';
import logger from '../utils/logger';
import { sendMessage } from '../integrations/evolution';

interface PostBookingMessageData {
  bookingId: string;
  serviceId: string;
  timeISO: string;
  ctaButtons: string[];
}

interface ReminderData {
  serviceName: string;
  professionalName?: string;
  location?: string;
}

/**
 * Envia mensagem pós-agendamento com resumo e CTAs
 */
export async function sendPostBookingMessage(
  phone: string,
  message: string,
  data: PostBookingMessageData
): Promise<boolean> {
  try {
    const result = await sendMessage(phone, message);
    
    if (result.success) {
      logger.info('Post-booking message sent successfully', {
        phone,
        bookingId: data.bookingId,
        ctaButtons: data.ctaButtons
      });
      return true;
    } else {
      logger.error('Failed to send post-booking message', {
        phone,
        bookingId: data.bookingId,
        error: result.error
      });
      return false;
    }
  } catch (error) {
    logger.error('Error sending post-booking message:', {
      error,
      phone,
      bookingId: data.bookingId
    });
    return false;
  }
}

/**
 * Agenda lembrete automático 24h antes do agendamento
 */
export async function scheduleReminder(
  phone: string,
  appointmentTimeISO: string,
  reminderData: ReminderData
): Promise<boolean> {
  try {
    const appointmentTime = new Date(appointmentTimeISO);
    const reminderTime = new Date(appointmentTime.getTime() - 24 * 60 * 60 * 1000); // 24h antes
    const now = new Date();
    
    // Verificar se o lembrete deve ser agendado (não no passado)
    if (reminderTime <= now) {
      logger.warn('Reminder time is in the past, skipping', {
        phone,
        appointmentTime: appointmentTimeISO,
        reminderTime: reminderTime.toISOString()
      });
      return false;
    }
    
    // Construir mensagem de lembrete
    const formattedDate = appointmentTime.toLocaleDateString('pt-BR', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'America/Bahia'
    });
    
    const formattedTime = appointmentTime.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Bahia'
    });
    
    let reminderMessage = `🔔 *Lembrete de Agendamento*\n\n`;
    reminderMessage += `Olá! Você tem um agendamento amanhã:\n\n`;
    reminderMessage += `📋 *Serviço:* ${reminderData.serviceName}\n`;
    
    if (reminderData.professionalName) {
      reminderMessage += `👤 *Profissional:* ${reminderData.professionalName}\n`;
    }
    
    reminderMessage += `📅 *Data:* ${formattedDate}\n`;
    reminderMessage += `🕐 *Horário:* ${formattedTime}\n`;
    
    if (reminderData.location) {
      reminderMessage += `📍 *Local:* ${reminderData.location}\n`;
    }
    
    reminderMessage += `\n_Para remarcar ou cancelar, digite *remarcar* ou *cancelar*._`;
    
    // Por enquanto, apenas log do agendamento do lembrete
    // Em uma implementação real, isso seria salvo no banco ou Redis para processamento posterior
    logger.info('Reminder scheduled', {
      phone,
      appointmentTime: appointmentTimeISO,
      reminderTime: reminderTime.toISOString(),
      message: reminderMessage
    });
    
    // TODO: Implementar sistema de agendamento real (cron job, queue, etc.)
    // Por enquanto, simular sucesso
    return true;
    
  } catch (error) {
    logger.error('Error scheduling reminder:', {
      error,
      phone,
      appointmentTime: appointmentTimeISO
    });
    return false;
  }
}

/**
 * Envia lembrete agendado (chamado pelo sistema de cron/queue)
 */
export async function sendScheduledReminder(
  phone: string,
  message: string
): Promise<boolean> {
  try {
    const result = await sendMessage(phone, message);
    
    if (result.success) {
      logger.info('Scheduled reminder sent successfully', { phone });
      return true;
    } else {
      logger.error('Failed to send scheduled reminder', {
        phone,
        error: result.error
      });
      return false;
    }
  } catch (error) {
    logger.error('Error sending scheduled reminder:', { error, phone });
    return false;
  }
}

/**
 * Templates de mensagens para diferentes situações
 */
export const MessageTemplates = {
  /**
   * Confirmação de agendamento básica
   */
  bookingConfirmed: (data: {
    serviceName: string;
    professionalName?: string;
    date: string;
    time: string;
    bookingId: string;
  }) => {
    let message = `✅ *Agendamento Confirmado!*\n\n`;
    message += `📋 *Serviço:* ${data.serviceName}\n`;
    
    if (data.professionalName) {
      message += `👤 *Profissional:* ${data.professionalName}\n`;
    }
    
    message += `📅 *Data:* ${data.date}\n`;
    message += `🕐 *Horário:* ${data.time}\n`;
    message += `🔢 *Código:* ${data.bookingId}\n\n`;
    message += `_Para remarcar ou cancelar, digite *remarcar* ou *cancelar*._`;
    
    return message;
  },
  
  /**
   * Cancelamento confirmado
   */
  bookingCancelled: (data: {
    serviceName: string;
    date: string;
    time: string;
    reason?: string;
  }) => {
    let message = `❌ *Agendamento Cancelado*\n\n`;
    message += `📋 *Serviço:* ${data.serviceName}\n`;
    message += `📅 *Data:* ${data.date}\n`;
    message += `🕐 *Horário:* ${data.time}\n\n`;
    
    if (data.reason) {
      message += `📝 *Motivo:* ${data.reason}\n\n`;
    }
    
    message += `Para fazer um novo agendamento, digite *agendar*.`;
    
    return message;
  },
  
  /**
   * Remarcação confirmada
   */
  bookingRescheduled: (data: {
    serviceName: string;
    oldDate: string;
    oldTime: string;
    newDate: string;
    newTime: string;
    bookingId: string;
  }) => {
    let message = `🔄 *Agendamento Remarcado!*\n\n`;
    message += `📋 *Serviço:* ${data.serviceName}\n\n`;
    message += `❌ *Horário Anterior:*\n`;
    message += `📅 ${data.oldDate} às ${data.oldTime}\n\n`;
    message += `✅ *Novo Horário:*\n`;
    message += `📅 ${data.newDate} às ${data.newTime}\n\n`;
    message += `🔢 *Código:* ${data.bookingId}`;
    
    return message;
  },
  
  /**
   * Informações de preço
   */
  priceInfo: (data: {
    serviceName: string;
    price?: number;
    priceRange?: string;
  }) => {
    let message = `💰 *Informações de Preço*\n\n`;
    message += `📋 *Serviço:* ${data.serviceName}\n`;
    
    if (data.price) {
      message += `💵 *Valor:* R$ ${data.price.toFixed(2)}\n\n`;
    } else if (data.priceRange) {
      message += `💵 *Faixa de Preço:* ${data.priceRange}\n\n`;
    } else {
      message += `💵 *Valor:* Consulte no local\n\n`;
    }
    
    message += `_Para agendar este serviço, digite *agendar*._`;
    
    return message;
  },
  
  /**
   * Informações de localização
   */
  locationInfo: (data: {
    address: string;
    mapLink?: string;
    additionalInfo?: string;
  }) => {
    let message = `📍 *Localização*\n\n`;
    message += `📮 *Endereço:*\n${data.address}\n\n`;
    
    if (data.mapLink) {
      message += `🗺️ *Ver no Mapa:*\n${data.mapLink}\n\n`;
    }
    
    if (data.additionalInfo) {
      message += `ℹ️ *Informações Adicionais:*\n${data.additionalInfo}\n\n`;
    }
    
    message += `_Para agendar um horário, digite *agendar*._`;
    
    return message;
  }
};

/**
 * Envia mensagem usando template
 */
export async function sendTemplateMessage(
  phone: string,
  template: keyof typeof MessageTemplates,
  data: any
): Promise<boolean> {
  try {
    const templateFn = MessageTemplates[template];
    if (!templateFn) {
      logger.error('Template not found:', { template });
      return false;
    }
    
    const message = templateFn(data);
    const result = await sendMessage(phone, message);
    
    if (result.success) {
      logger.info('Template message sent successfully', {
        phone,
        template
      });
      return true;
    } else {
      logger.error('Failed to send template message', {
        phone,
        template,
        error: result.error
      });
      return false;
    }
  } catch (error) {
    logger.error('Error sending template message:', {
      error,
      phone,
      template
    });
    return false;
  }
}