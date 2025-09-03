import { Pool } from 'pg';
import { RedisClientType } from 'redis';
import logger from '../utils/logger';
import { sendTemplateMessage, MessageTemplates } from '../messages/templates';
import { getBookingData } from '../services/booking';
import { Trinks } from '../integrations/trinks';
import { recommendSlots } from '../recommendation/recommend';

interface ShortcutContext {
  phone: string;
  tenantId: string;
  currentStep?: string;
  currentData?: any;
  sessionId?: string;
}

interface ShortcutResult {
  handled: boolean;
  response?: string;
  shouldContinueFlow?: boolean;
  newStep?: string;
  newData?: any;
}

/**
 * Lista de palavras-chave para atalhos globais
 */
const SHORTCUT_KEYWORDS = {
  RESCHEDULE: ['remarcar', 'reagendar', 'mudar horario', 'trocar horario'],
  CANCEL: ['cancelar', 'desmarcar', 'cancelamento'],
  PRICE: ['preço', 'preco', 'valor', 'quanto custa', 'precos'],
  ADDRESS: ['endereço', 'endereco', 'localização', 'localizacao', 'onde fica', 'local']
};

/**
 * Verifica se a mensagem contém uma palavra-chave de atalho
 */
export function detectShortcut(message: string): string | null {
  const normalizedMessage = message.toLowerCase().trim();
  
  // Verificar cada categoria de atalho
  for (const [category, keywords] of Object.entries(SHORTCUT_KEYWORDS)) {
    for (const keyword of keywords) {
      if (normalizedMessage.includes(keyword)) {
        return category.toLowerCase();
      }
    }
  }
  
  return null;
}

/**
 * Processa atalho global preservando o contexto atual
 */
export async function handleGlobalShortcut(
  db: Pool,
  redis: RedisClientType,
  shortcut: string,
  context: ShortcutContext
): Promise<ShortcutResult> {
  try {
    // Salvar contexto atual antes de processar atalho
    await saveCurrentContext(redis, context);
    
    switch (shortcut) {
      case 'reschedule':
        return await handleRescheduleShortcut(db, redis, context);
        
      case 'cancel':
        return await handleCancelShortcut(db, redis, context);
        
      case 'price':
        return await handlePriceShortcut(db, context);
        
      case 'address':
        return await handleAddressShortcut(context);
        
      default:
        return {
          handled: false
        };
    }
  } catch (error) {
    logger.error('Error handling global shortcut:', {
      error,
      shortcut,
      context
    });
    
    return {
      handled: true,
      response: 'Erro ao processar solicitação. Tente novamente.',
      shouldContinueFlow: true
    };
  }
}

/**
 * Atalho para remarcar agendamento
 */
async function handleRescheduleShortcut(
  db: Pool,
  redis: RedisClientType,
  context: ShortcutContext
): Promise<ShortcutResult> {
  try {
    // Buscar agendamento ativo do usuário
    const activeBooking = await getActiveBooking(db, context.phone, context.tenantId);
    
    if (!activeBooking) {
      return {
        handled: true,
        response: 'Você não possui agendamentos ativos para remarcar.\n\nPara fazer um novo agendamento, digite *agendar*.',
        shouldContinueFlow: true
      };
    }
    
    // Buscar novos horários disponíveis
    const today = new Date();
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
    const dateISO = tomorrow.toISOString().split('T')[0];
    
    const availableSlots = await recommendSlots(
      db,
      redis,
      {
        tenantId: context.tenantId,
        phone: context.phone,
        dateISO: dateISO
      }
    );
    
    if (availableSlots.length === 0) {
      return {
        handled: true,
        response: 'Não há horários disponíveis para remarcação no momento.\n\nTente novamente mais tarde ou entre em contato conosco.',
        shouldContinueFlow: true
      };
    }
    
    // Construir resposta com opções
    let response = `🔄 *Remarcação de Agendamento*\n\n`;
    response += `📋 *Agendamento Atual:*\n`;
    response += `Serviço: ${activeBooking.service_name}\n`;
    response += `Data: ${formatDate(activeBooking.appointment_time)}\n`;
    response += `Horário: ${formatTime(activeBooking.appointment_time)}\n\n`;
    response += `📅 *Novos horários disponíveis:*\n\n`;
    
    availableSlots.slice(0, 3).forEach((slot, index) => {
      const slotDate = new Date(slot.timeISO);
      response += `${index + 1}. ${formatDate(slot.timeISO)} às ${formatTime(slot.timeISO)}\n`;
    });
    
    response += `\nDigite o número da opção desejada ou *voltar* para cancelar.`;
    
    // Salvar dados da remarcação no contexto
    const rescheduleData = {
      currentBooking: activeBooking,
      availableSlots: availableSlots.slice(0, 3),
      step: 'awaiting_reschedule_choice'
    };
    
    await redis.setEx(
      `reschedule:${context.phone}:${context.tenantId}`,
      300, // 5 minutos
      JSON.stringify(rescheduleData)
    );
    
    return {
      handled: true,
      response,
      shouldContinueFlow: false,
      newStep: 'reschedule_flow',
      newData: rescheduleData
    };
    
  } catch (error) {
    logger.error('Error handling reschedule shortcut:', { error, context });
    return {
      handled: true,
      response: 'Erro ao buscar opções de remarcação. Tente novamente.',
      shouldContinueFlow: true
    };
  }
}

/**
 * Atalho para cancelar agendamento
 */
async function handleCancelShortcut(
  db: Pool,
  redis: RedisClientType,
  context: ShortcutContext
): Promise<ShortcutResult> {
  try {
    // Buscar agendamento ativo do usuário
    const activeBooking = await getActiveBooking(db, context.phone, context.tenantId);
    
    if (!activeBooking) {
      return {
        handled: true,
        response: 'Você não possui agendamentos ativos para cancelar.',
        shouldContinueFlow: true
      };
    }
    
    let response = `❌ *Cancelamento de Agendamento*\n\n`;
    response += `📋 *Agendamento:*\n`;
    response += `Serviço: ${activeBooking.service_name}\n`;
    response += `Data: ${formatDate(activeBooking.appointment_time)}\n`;
    response += `Horário: ${formatTime(activeBooking.appointment_time)}\n\n`;
    response += `⚠️ Tem certeza que deseja cancelar este agendamento?\n\n`;
    response += `Digite *confirmar* para cancelar ou *voltar* para manter o agendamento.`;
    
    // Salvar dados do cancelamento no contexto
    const cancelData = {
      booking: activeBooking,
      step: 'awaiting_cancel_confirmation'
    };
    
    await redis.setEx(
      `cancel:${context.phone}:${context.tenantId}`,
      300, // 5 minutos
      JSON.stringify(cancelData)
    );
    
    return {
      handled: true,
      response,
      shouldContinueFlow: false,
      newStep: 'cancel_flow',
      newData: cancelData
    };
    
  } catch (error) {
    logger.error('Error handling cancel shortcut:', { error, context });
    return {
      handled: true,
      response: 'Erro ao processar cancelamento. Tente novamente.',
      shouldContinueFlow: true
    };
  }
}

/**
 * Atalho para consultar preços
 */
async function handlePriceShortcut(
  db: Pool,
  context: ShortcutContext
): Promise<ShortcutResult> {
  try {
    // Se há um serviço no contexto atual, mostrar preço dele
    if (context.currentData?.serviceName) {
      const servicePrice = await getServicePrice(db, context.tenantId, context.currentData.serviceName);
      
      const response = MessageTemplates.priceInfo({
        serviceName: context.currentData.serviceName,
        price: servicePrice?.price,
        priceRange: servicePrice?.priceRange
      });
      
      return {
        handled: true,
        response,
        shouldContinueFlow: true
      };
    }
    
    // Caso contrário, mostrar lista de serviços com preços
    const services = await getServicesWithPrices(db, context.tenantId);
    
    if (services.length === 0) {
      return {
        handled: true,
        response: '💰 *Tabela de Preços*\n\nEntre em contato para consultar nossos preços atualizados.',
        shouldContinueFlow: true
      };
    }
    
    let response = `💰 *Tabela de Preços*\n\n`;
    
    services.forEach(service => {
      response += `📋 *${service.name}*\n`;
      if (service.price) {
        response += `💵 R$ ${service.price.toFixed(2)}\n\n`;
      } else if (service.price_range) {
        response += `💵 ${service.price_range}\n\n`;
      } else {
        response += `💵 Consulte no local\n\n`;
      }
    });
    
    response += `_Para agendar um serviço, digite *agendar*._`;
    
    return {
      handled: true,
      response,
      shouldContinueFlow: true
    };
    
  } catch (error) {
    logger.error('Error handling price shortcut:', { error, context });
    return {
      handled: true,
      response: 'Erro ao consultar preços. Tente novamente.',
      shouldContinueFlow: true
    };
  }
}

/**
 * Atalho para consultar endereço
 */
async function handleAddressShortcut(
  context: ShortcutContext
): Promise<ShortcutResult> {
  try {
    // Buscar informações de localização do tenant
    const locationInfo = await getTenantLocation(context.tenantId);
    
    const response = MessageTemplates.locationInfo({
      address: locationInfo.address || 'Rua das Flores, 123 - Centro, Salvador/BA',
      mapLink: locationInfo.mapLink,
      additionalInfo: locationInfo.additionalInfo
    });
    
    return {
      handled: true,
      response,
      shouldContinueFlow: true
    };
    
  } catch (error) {
    logger.error('Error handling address shortcut:', { error, context });
    return {
      handled: true,
      response: 'Erro ao consultar localização. Tente novamente.',
      shouldContinueFlow: true
    };
  }
}

/**
 * Salva o contexto atual para permitir retorno após atalho
 */
async function saveCurrentContext(
  redis: RedisClientType,
  context: ShortcutContext
): Promise<void> {
  try {
    const contextKey = `context:${context.phone}:${context.tenantId}`;
    await redis.setEx(contextKey, 600, JSON.stringify({
      step: context.currentStep,
      data: context.currentData,
      sessionId: context.sessionId,
      savedAt: new Date().toISOString()
    }));
  } catch (error) {
    logger.error('Error saving current context:', { error, context });
  }
}

/**
 * Restaura o contexto salvo após processamento de atalho
 */
export async function restoreContext(
  redis: RedisClientType,
  phone: string,
  tenantId: string
): Promise<any> {
  try {
    const contextKey = `context:${phone}:${tenantId}`;
    const savedContext = await redis.get(contextKey);
    
    if (savedContext) {
      await redis.del(contextKey); // Limpar contexto usado
      return JSON.parse(savedContext);
    }
    
    return null;
  } catch (error) {
    logger.error('Error restoring context:', { error, phone, tenantId });
    return null;
  }
}

/**
 * Busca agendamento ativo do usuário
 */
async function getActiveBooking(db: Pool, phone: string, tenantId: string): Promise<any> {
  try {
    // Esta query deveria buscar no banco real
    // Por enquanto, retorna dados mock
    const result = await db.query(
      `SELECT * FROM bookings 
       WHERE phone = $1 AND tenant_id = $2 
       AND status = 'confirmed' 
       AND appointment_time > NOW()
       ORDER BY appointment_time ASC 
       LIMIT 1`,
      [phone, tenantId]
    );
    
    return result.rows[0] || null;
  } catch (error) {
    logger.error('Error fetching active booking:', { error, phone, tenantId });
    return null;
  }
}

/**
 * Busca preço de um serviço específico
 */
async function getServicePrice(db: Pool, tenantId: string, serviceName: string): Promise<any> {
  try {
    // Mock de preços
    const mockPrices: Record<string, any> = {
      'corte de cabelo': { price: 25.00 },
      'barba': { price: 15.00 },
      'corte + barba': { price: 35.00 },
      'manicure': { priceRange: 'R$ 20,00 - R$ 30,00' },
      'pedicure': { priceRange: 'R$ 25,00 - R$ 35,00' }
    };
    
    return mockPrices[serviceName.toLowerCase()] || null;
  } catch (error) {
    logger.error('Error fetching service price:', { error, tenantId, serviceName });
    return null;
  }
}

/**
 * Busca todos os serviços com preços
 */
async function getServicesWithPrices(db: Pool, tenantId: string): Promise<any[]> {
  try {
    // Mock de serviços com preços
    return [
      { name: 'Corte de Cabelo', price: 25.00 },
      { name: 'Barba', price: 15.00 },
      { name: 'Corte + Barba', price: 35.00 },
      { name: 'Manicure', price_range: 'R$ 20,00 - R$ 30,00' },
      { name: 'Pedicure', price_range: 'R$ 25,00 - R$ 35,00' }
    ];
  } catch (error) {
    logger.error('Error fetching services with prices:', { error, tenantId });
    return [];
  }
}

/**
 * Busca informações de localização do tenant
 */
async function getTenantLocation(tenantId: string): Promise<any> {
  try {
    // Mock de localização
    return {
      address: 'Rua das Flores, 123 - Centro, Salvador/BA\nCEP: 40070-000',
      mapLink: 'https://maps.google.com/?q=-12.9714,-38.5014',
      additionalInfo: 'Próximo ao Shopping da Bahia\nEstacionamento disponível'
    };
  } catch (error) {
    logger.error('Error fetching tenant location:', { error, tenantId });
    return {
      address: 'Rua das Flores, 123 - Centro, Salvador/BA'
    };
  }
}

/**
 * Utilitários para formatação
 */
function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('pt-BR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Bahia'
  });
}

function formatTime(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Bahia'
  });
}