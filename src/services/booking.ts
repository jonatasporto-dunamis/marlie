import { Pool } from 'pg';
import { Redis } from 'ioredis';
import logger from '../utils/logger';
import { criarAgendamento } from '../integrations/trinks';
import { updateUserPreferences, updateSlotPopularity } from '../recommendation/recommend';
import { MetricsHelper } from '../metrics/index';
import { sendPostBookingMessage, scheduleReminder } from '../messages/templates';
import { upsellSelector, UpsellContext, UpsellSuggestion } from '../upsell/selector';
import { MessageSchedulerWorker } from '../scheduler/worker';

interface BookingData {
  tenantId: string;
  phone: string;
  serviceName: string;
  serviceId: string;
  professionalId?: string;
  professionalName?: string;
  dateISO: string;
  timeISO: string;
  clientName?: string;
  estimatedPrice?: number;
  location?: string;
  paymentInstructions?: string;
}

interface BookingResult {
  success: boolean;
  bookingId?: string;
  message: string;
  error?: string;
}

interface PostBookingCTAs {
  reminder: boolean;
  location: boolean;
  payment: boolean;
}

interface UpsellResponse {
  accepted: boolean;
  suggestion?: UpsellSuggestion;
}

/**
 * Cria um agendamento e executa ações pós-agendamento
 */
export async function createBookingWithCTAs(
  db: Pool,
  redis: Redis,
  bookingData: BookingData,
  ctas: PostBookingCTAs = { reminder: true, location: true, payment: true }
): Promise<BookingResult> {
  const startTime = Date.now();
  
  try {
    // 1. Criar agendamento via Trinks
    const trinksResult = await criarAgendamento({
      telefone: bookingData.phone,
      servicoId: bookingData.serviceId,
      profissionalId: bookingData.professionalId,
      data: bookingData.dateISO,
      horario: bookingData.timeISO,
      nomeCliente: bookingData.clientName
    });
    
    if (!trinksResult.success) {
      logger.error('Trinks booking failed:', trinksResult);
      return {
        success: false,
        message: 'Não foi possível confirmar o agendamento. Tente novamente.',
        error: trinksResult.error
      };
    }
    
    const bookingId = trinksResult.agendamentoId;
    
    // 2. Atualizar preferências do usuário
    await updateUserPreferencesFromBooking(db, bookingData);
    
    // 3. Atualizar popularidade do slot
    await updateSlotPopularity(
      db,
      bookingData.tenantId,
      bookingData.timeISO,
      bookingData.serviceId,
      bookingData.professionalId,
      true
    );
    
    // 4. Verificar e oferecer upsell (antes do resumo final)
    const upsellResult = await handleUpsellFlow(db, bookingData, bookingId);
    
    // 5. Agendar mensagens automáticas (pré-visita)
    await scheduleAutomaticMessages(db, bookingData, bookingId);
    
    // 6. Enviar resumo pós-agendamento (incluindo upsell se aceito)
    await sendPostBookingSummary(bookingData, bookingId, ctas, upsellResult);
    
    // 7. Registrar métricas
    MetricsHelper.incrementBookingsConfirmed(
      bookingData.tenantId,
      bookingData.serviceId,
      bookingData.professionalId
    );
    
    MetricsHelper.incrementFirstTryBooking(
      bookingData.tenantId,
      bookingData.serviceId
    );
    
    // Registrar métricas de upsell se aplicável
    if (upsellResult?.suggestion) {
      if (upsellResult.accepted) {
        MetricsHelper.incrementUpsellAccepted(bookingData.tenantId);
        MetricsHelper.recordTicketValue(
          bookingData.tenantId,
          (bookingData.estimatedPrice || 0) + (upsellResult.suggestion.suggestedPriceCents / 100)
        );
      } else {
        MetricsHelper.incrementUpsellDeclined(bookingData.tenantId);
      }
    }
    
    const duration = Date.now() - startTime;
    logger.info('Booking created successfully with CTAs', {
      bookingId,
      tenantId: bookingData.tenantId,
      phone: bookingData.phone,
      serviceId: bookingData.serviceId,
      duration
    });
    
    return {
      success: true,
      bookingId,
      message: 'Agendamento confirmado com sucesso! 🎉'
    };
    
  } catch (error) {
    logger.error('Error creating booking with CTAs:', {
      error,
      bookingData
    });
    
    return {
      success: false,
      message: 'Erro interno. Tente novamente em alguns minutos.',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Atualiza preferências do usuário baseado no agendamento realizado
 */
async function updateUserPreferencesFromBooking(
  db: Pool,
  bookingData: BookingData
): Promise<void> {
  try {
    const slotDate = new Date(bookingData.timeISO);
    const dayOfWeek = slotDate.getDay();
    const hour = slotDate.getHours();
    
    // Determinar janela de horário
    let slotWindow: 'morning' | 'afternoon' | 'evening';
    if (hour < 12) {
      slotWindow = 'morning';
    } else if (hour < 18) {
      slotWindow = 'afternoon';
    } else {
      slotWindow = 'evening';
    }
    
    // Buscar preferências atuais
    const currentPrefs = await db.query(
      'SELECT service_top, preferred_days FROM user_prefs WHERE phone_e164 = $1 AND tenant_id = $2',
      [bookingData.phone, bookingData.tenantId]
    );
    
    let serviceTop = [];
    let preferredDays = [];
    
    if (currentPrefs.rows.length > 0) {
      serviceTop = currentPrefs.rows[0].service_top || [];
      preferredDays = currentPrefs.rows[0].preferred_days || [];
    }
    
    // Atualizar serviços top
    const existingService = serviceTop.find((s: any) => s.service_id === bookingData.serviceId);
    if (existingService) {
      existingService.count += 1;
    } else {
      serviceTop.push({
        service_id: bookingData.serviceId,
        service_name: bookingData.serviceName,
        count: 1
      });
    }
    
    // Manter apenas top 5 serviços
    serviceTop.sort((a: any, b: any) => b.count - a.count);
    serviceTop = serviceTop.slice(0, 5);
    
    // Atualizar dias preferidos
    if (!preferredDays.includes(dayOfWeek)) {
      preferredDays.push(dayOfWeek);
    }
    
    // Atualizar preferências
    await updateUserPreferences(db, bookingData.phone, bookingData.tenantId, {
      professional_id_pref: bookingData.professionalId,
      slot_window_pref: slotWindow,
      service_top: serviceTop,
      preferred_days: preferredDays,
      total_bookings: 1, // Será incrementado via SQL
      successful_bookings: 1
    });
    
    // Incrementar contadores
    await db.query(
      `UPDATE user_prefs 
       SET total_bookings = total_bookings + 1,
           successful_bookings = successful_bookings + 1
       WHERE phone_e164 = $1 AND tenant_id = $2`,
      [bookingData.phone, bookingData.tenantId]
    );
    
  } catch (error) {
    logger.error('Error updating user preferences from booking:', {
      error,
      phone: bookingData.phone,
      tenantId: bookingData.tenantId
    });
  }
}

/**
 * Handles upsell flow after booking confirmation
 */
async function handleUpsellFlow(
  db: Pool,
  bookingData: BookingData,
  bookingId: string
): Promise<UpsellResponse | null> {
  try {
    const upsellContext: UpsellContext = {
      tenantId: bookingData.tenantId,
      phoneE164: bookingData.phone,
      bookingId,
      baseServiceId: parseInt(bookingData.serviceId),
      baseServiceName: bookingData.serviceName,
      appointmentDateTime: new Date(bookingData.timeISO)
    };

    // Get upsell suggestion
    const suggestion = await upsellSelector.selectUpsell(upsellContext);
    if (!suggestion) {
      return null;
    }

    // Record that upsell was shown
    await upsellSelector.recordUpsellShown(upsellContext, suggestion);
    MetricsHelper.incrementUpsellShown(bookingData.tenantId);

    // Present upsell to user
    const upsellMessage = formatUpsellMessage(suggestion);
    await sendUpsellMessage(bookingData.phone, upsellMessage);

    // Wait for user response (this would be handled by webhook in real implementation)
    // For now, we'll simulate a response or handle it asynchronously
    const userResponse = await waitForUpsellResponse(bookingData.phone, suggestion, 30000); // 30s timeout

    if (userResponse !== null) {
      await upsellSelector.recordUpsellResponse(upsellContext, suggestion, userResponse);
      return {
        accepted: userResponse,
        suggestion
      };
    }

    return { accepted: false, suggestion };

  } catch (error) {
    logger.error('Error in upsell flow:', error);
    return null;
  }
}

/**
 * Formats upsell message for user
 */
function formatUpsellMessage(suggestion: UpsellSuggestion): string {
  const price = (suggestion.suggestedPriceCents / 100).toFixed(2);
  
  let message = `🌟 *Que tal complementar seu cuidado?*\n\n`;
  message += `💅 *${suggestion.suggestedServiceName}*\n`;
  message += `💰 *Apenas R$ ${price}*\n\n`;
  message += `${suggestion.reason}\n\n`;
  message += `Gostaria de adicionar este serviço ao seu agendamento?\n\n`;
  message += `✅ Digite *SIM* para adicionar\n`;
  message += `❌ Digite *NÃO* para continuar sem`;
  
  return message;
}

/**
 * Sends upsell message to user
 */
async function sendUpsellMessage(phone: string, message: string): Promise<void> {
  try {
    // This would integrate with your messaging service (Evolution API)
    await sendPostBookingMessage(phone, message, { isUpsell: true });
  } catch (error) {
    logger.error('Error sending upsell message:', error);
  }
}

/**
 * Waits for user response to upsell (simplified implementation)
 */
async function waitForUpsellResponse(
  phone: string, 
  suggestion: UpsellSuggestion, 
  timeoutMs: number
): Promise<boolean | null> {
  // In a real implementation, this would be handled by the webhook
  // when the user responds. For now, we'll return null to indicate
  // that the response will be handled asynchronously.
  return null;
}

/**
 * Processes user response to upsell offer
 */
export async function handleUpsellResponse(
  db: Pool,
  phone: string,
  response: string,
  bookingId: string
): Promise<string> {
  try {
    const normalizedResponse = response.toLowerCase().trim();
    const isAccepted = ['sim', 'yes', 's', 'aceito', 'quero', 'adicionar'].includes(normalizedResponse);
    const isDeclined = ['não', 'nao', 'no', 'n', 'recuso', 'não quero'].includes(normalizedResponse);

    if (!isAccepted && !isDeclined) {
      return 'Por favor, responda com *SIM* para adicionar o serviço ou *NÃO* para continuar sem.';
    }

    // Find the pending upsell for this booking
    const client = await db.connect();
    try {
      const upsellQuery = await client.query(
        `SELECT * FROM upsell_events 
         WHERE booking_id = $1 AND phone_e164 = $2 
         AND accepted_at IS NULL AND declined_at IS NULL 
         ORDER BY shown_at DESC LIMIT 1`,
        [bookingId, phone]
      );

      if (upsellQuery.rows.length === 0) {
        return 'Não encontrei uma oferta pendente para responder.';
      }

      const upsellEvent = upsellQuery.rows[0];
      const updateField = isAccepted ? 'accepted_at' : 'declined_at';
      
      await client.query(
        `UPDATE upsell_events SET ${updateField} = now() WHERE id = $1`,
        [upsellEvent.id]
      );

      if (isAccepted) {
        MetricsHelper.incrementUpsellAccepted(upsellEvent.tenant_id);
        const serviceName = await getServiceName(db, upsellEvent.suggested_service_id);
        return `✅ Perfeito! *${serviceName}* foi adicionado ao seu agendamento.\n\nSeu novo total: R$ ${((upsellEvent.suggested_price_cents || 0) / 100).toFixed(2)} adicional.`;
      } else {
        MetricsHelper.incrementUpsellDeclined(upsellEvent.tenant_id);
        return '👍 Sem problemas! Seu agendamento original está confirmado.';
      }

    } finally {
      client.release();
    }

  } catch (error) {
    logger.error('Error handling upsell response:', error);
    return 'Erro ao processar sua resposta. Tente novamente.';
  }
}

/**
 * Gets service name by ID (helper function)
 */
async function getServiceName(db: Pool, serviceId: number): Promise<string> {
  // This would query your services table
  // For now, return a default name
  return 'Serviço Adicional';
}

/**
 * Envia resumo pós-agendamento com CTAs
 */
async function sendPostBookingSummary(
  bookingData: BookingData,
  bookingId: string,
  ctas: PostBookingCTAs,
  upsellResult?: UpsellResponse | null
): Promise<void> {
  try {
    const slotDate = new Date(bookingData.timeISO);
    const formattedDate = slotDate.toLocaleDateString('pt-BR', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'America/Bahia'
    });
    
    const formattedTime = slotDate.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Bahia'
    });
    
    // Construir resumo
    let summary = `✅ *Agendamento Confirmado!*\n\n`;
    summary += `📋 *Serviço:* ${bookingData.serviceName}\n`;
    
    if (bookingData.professionalName) {
      summary += `👤 *Profissional:* ${bookingData.professionalName}\n`;
    }
    
    summary += `📅 *Data:* ${formattedDate}\n`;
    summary += `🕐 *Horário:* ${formattedTime}\n`;
    
    let totalPrice = bookingData.estimatedPrice || 0;
    if (upsellResult?.accepted && upsellResult.suggestion) {
      totalPrice += (upsellResult.suggestion.suggestedPriceCents / 100);
      summary += `💰 *Valor Total:* R$ ${totalPrice.toFixed(2)}\n`;
      summary += `   • ${bookingData.serviceName}: R$ ${(bookingData.estimatedPrice || 0).toFixed(2)}\n`;
      summary += `   • ${upsellResult.suggestion.suggestedServiceName}: R$ ${(upsellResult.suggestion.suggestedPriceCents / 100).toFixed(2)}\n`;
    } else if (bookingData.estimatedPrice) {
      summary += `💰 *Valor:* R$ ${bookingData.estimatedPrice.toFixed(2)}\n`;
    }
    
    summary += `\n🔢 *Código:* ${bookingId}\n\n`;
    
    // Adicionar CTAs
    const ctaButtons = [];
    
    if (ctas.reminder) {
      summary += `🔔 Para receber um lembrete 24h antes, digite: *lembrete*\n`;
      ctaButtons.push('lembrete');
    }
    
    if (ctas.location) {
      summary += `📍 Para ver a localização, digite: *endereço*\n`;
      ctaButtons.push('endereço');
    }
    
    if (ctas.payment) {
      summary += `💳 Para informações de pagamento, digite: *pagamento*\n`;
      ctaButtons.push('pagamento');
    }
    
    summary += `\n_Para remarcar ou cancelar, digite *remarcar* ou *cancelar* a qualquer momento._`;
    
    // Enviar mensagem
    await sendPostBookingMessage(bookingData.phone, summary, {
      bookingId,
      serviceId: bookingData.serviceId,
      timeISO: bookingData.timeISO,
      ctaButtons
    });
    
    // Agendar lembrete automático se solicitado
    if (ctas.reminder) {
      await scheduleReminder(
        bookingData.phone,
        bookingData.timeISO,
        {
          serviceName: bookingData.serviceName,
          professionalName: bookingData.professionalName,
          location: bookingData.location
        }
      );
    }
    
  } catch (error) {
    logger.error('Error sending post-booking summary:', {
      error,
      bookingId,
      phone: bookingData.phone
    });
  }
}

/**
 * Processa ações dos CTAs pós-agendamento
 */
export async function handlePostBookingCTA(
  action: string,
  phone: string,
  bookingData?: any
): Promise<string> {
  try {
    switch (action.toLowerCase()) {
      case 'lembrete':
        if (bookingData?.timeISO) {
          await scheduleReminder(phone, bookingData.timeISO, {
            serviceName: bookingData.serviceName,
            professionalName: bookingData.professionalName,
            location: bookingData.location
          });
          return '🔔 Lembrete agendado! Você receberá uma mensagem 24h antes do seu horário.';
        }
        return '❌ Não foi possível agendar o lembrete. Dados do agendamento não encontrados.';
        
      case 'endereço':
      case 'localização':
        if (bookingData?.location) {
          return `📍 *Localização:*\n${bookingData.location}\n\n_Clique no link para abrir no mapa._`;
        }
        return '📍 *Endereço:* Rua das Flores, 123 - Centro, Salvador/BA\n\n_Entre em contato para confirmar a localização exata._';
        
      case 'pagamento':
        if (bookingData?.paymentInstructions) {
          return `💳 *Informações de Pagamento:*\n${bookingData.paymentInstructions}`;
        }
        return '💳 *Pagamento:* Aceitamos dinheiro, cartão e PIX.\n\n_O pagamento pode ser feito no local ou antecipadamente._';
        
      default:
        return 'Ação não reconhecida. Use: *lembrete*, *endereço* ou *pagamento*.';
    }
  } catch (error) {
    logger.error('Error handling post-booking CTA:', {
      error,
      action,
      phone
    });
    return 'Erro ao processar solicitação. Tente novamente.';
  }
}

/**
 * Agenda mensagens automáticas para o agendamento (pré-visita e no-show check)
 */
async function scheduleAutomaticMessages(
  db: Pool,
  bookingData: BookingData,
  bookingId: string
): Promise<void> {
  try {
    // Verificar se as funcionalidades estão habilitadas
    const reminderEnabled = process.env.REMINDER_ENABLED === 'on';
    const noShowShieldEnabled = process.env.NO_SHOW_SHIELD_ENABLED === 'on';
    
    if (!reminderEnabled && !noShowShieldEnabled) {
      return;
    }
    
    const appointmentDate = new Date(bookingData.dateISO + 'T' + bookingData.timeISO);
    
    // Payload comum para ambas as mensagens
    const messagePayload = {
      booking_id: bookingId,
      service_name: bookingData.serviceName,
      appointment_date: appointmentDate.toLocaleDateString('pt-BR'),
      appointment_time: appointmentDate.toLocaleTimeString('pt-BR', { 
        hour: '2-digit', 
        minute: '2-digit' 
      }),
      business_name: 'SyncBelle', // TODO: Get from tenant config
      business_address: bookingData.location,
      business_phone: process.env.BUSINESS_PHONE
    };
    
    // Agendar mensagem de pré-visita (24-40h antes)
    if (reminderEnabled) {
      const preVisitTime = MessageSchedulerWorker.calculatePreVisitTime(appointmentDate);
      
      // Só agendar se a data de envio for no futuro
      if (preVisitTime > new Date()) {
        await MessageSchedulerWorker.scheduleJob(
          db,
          bookingData.tenantId,
          bookingData.phone,
          'pre_visit',
          preVisitTime,
          messagePayload
        );
        
        logger.info('Pre-visit message scheduled', {
          tenant_id: bookingData.tenantId,
          phone: maskPhone(bookingData.phone),
          booking_id: bookingId,
          scheduled_for: preVisitTime.toISOString()
        });
      }
    }
    
    // Agendar no-show check (D-1 às 18h)
    if (noShowShieldEnabled) {
      const noShowCheckTime = MessageSchedulerWorker.calculateNoShowCheckTime(appointmentDate);
      
      // Só agendar se a data de envio for no futuro
      if (noShowCheckTime > new Date()) {
        await MessageSchedulerWorker.scheduleJob(
          db,
          bookingData.tenantId,
          bookingData.phone,
          'no_show_check',
          noShowCheckTime,
          messagePayload
        );
        
        logger.info('No-show check message scheduled', {
          tenant_id: bookingData.tenantId,
          phone: maskPhone(bookingData.phone),
          booking_id: bookingId,
          scheduled_for: noShowCheckTime.toISOString()
        });
      }
    }
    
  } catch (error) {
    logger.error('Error scheduling automatic messages:', error);
    // Não falhar o agendamento por causa de erro no scheduler
  }
}

/**
 * Máscara telefone para logs (privacidade)
 */
function maskPhone(phone: string): string {
  if (phone.length <= 6) return phone;
  const start = phone.substring(0, 3);
  const end = phone.substring(phone.length - 3);
  const middle = '*'.repeat(phone.length - 6);
  return `${start}${middle}${end}`;
}

/**
 * Busca dados de agendamento por ID
 */
export async function getBookingData(
  db: Pool,
  bookingId: string,
  phone: string
): Promise<any> {
  try {
    // Esta função deveria buscar dados do agendamento
    // Por enquanto, retorna dados mock
    return {
      bookingId,
      phone,
      serviceName: 'Corte de Cabelo',
      timeISO: new Date().toISOString(),
      location: 'Rua das Flores, 123 - Centro, Salvador/BA',
      paymentInstructions: 'Aceitamos dinheiro, cartão e PIX.'
    };
  } catch (error) {
    logger.error('Error fetching booking data:', { error, bookingId, phone });
    return null;
  }
}