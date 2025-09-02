import logger from './logger';

// Interface para dados do agendamento
export interface BookingData {
  serviceName: string;
  professionalName?: string;
  date: string; // ISO format
  time: string; // HH:MM format
  estimatedValue?: number;
  bookingId: string | number;
  clientName?: string;
}

// Interface para configurações do estabelecimento
export interface EstablishmentConfig {
  name: string;
  address: string;
  phone: string;
  lateFeePolicy: string;
  noShowPolicy: string;
  arrivalInstructions: string;
  locationUrl?: string;
}

// Configuração padrão do Ateliê Marcleia Abade
const DEFAULT_ESTABLISHMENT: EstablishmentConfig = {
  name: 'Ateliê Marcleia Abade',
  address: 'Endereço do ateliê - Salvador, BA',
  phone: '(71) 9xxxx-xxxx',
  lateFeePolicy: 'Tolerância de 15 minutos. Após esse período, será necessário reagendar.',
  noShowPolicy: 'Ausência sem aviso prévio pode resultar em cobrança de taxa.',
  arrivalInstructions: 'Chegue com 5 minutos de antecedência. Aguarde na recepção.',
  locationUrl: 'https://maps.google.com/?q=Ateliê+Marcleia+Abade+Salvador'
};

// Função para formatar data em português brasileiro
function formatDateBR(dateISO: string): string {
  const date = new Date(dateISO + 'T00:00:00');
  return date.toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

// Função para formatar valor monetário
function formatCurrency(value: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(value);
}

// Template principal do resumo pós-agendamento
export function generateBookingSummary(
  booking: BookingData,
  establishment: EstablishmentConfig = DEFAULT_ESTABLISHMENT
): string {
  const formattedDate = formatDateBR(booking.date);
  const professionalInfo = booking.professionalName ? `\n*Profissional:* ${booking.professionalName}` : '';
  const valueInfo = booking.estimatedValue ? `\n*Valor estimado:* ${formatCurrency(booking.estimatedValue)}` : '';
  const clientGreeting = booking.clientName ? `${booking.clientName}, seu` : 'Seu';

  return `🎉 *${clientGreeting} agendamento está confirmado!*

` +
    `📋 *DETALHES DO AGENDAMENTO*
` +
    `*Serviço:* ${booking.serviceName}${professionalInfo}
` +
    `*Data:* ${formattedDate}
` +
    `*Horário:* ${booking.time}
` +
    `*ID:* ${booking.bookingId}${valueInfo}

` +
    `📍 *LOCAL*
` +
    `${establishment.name}
` +
    `${establishment.address}

` +
    `⏰ *POLÍTICAS IMPORTANTES*
` +
    `• *Atraso:* ${establishment.lateFeePolicy}
` +
    `• *Ausência:* ${establishment.noShowPolicy}

` +
    `🚶‍♀️ *INSTRUÇÕES DE CHEGADA*
` +
    `${establishment.arrivalInstructions}

` +
    `📞 *Contato:* ${establishment.phone}

` +
    `Te esperamos! Qualquer dúvida, estou aqui. 😊`;
}

// CTAs complementares pós-agendamento
export interface PostBookingCTAs {
  reminder: string;
  location: string;
  paymentMethod: string;
}

export function generatePostBookingCTAs(): PostBookingCTAs {
  return {
    reminder: '🔔 Deseja receber um lembrete 24h antes do seu agendamento?',
    location: '📍 Gostaria de receber a localização exata para facilitar sua chegada?',
    paymentMethod: '💳 Qual sua forma de pagamento preferida? (Dinheiro, PIX, Cartão)'
  };
}

// Função para processar resposta aos CTAs
export function processCTAResponse(
  ctaType: 'reminder' | 'location' | 'paymentMethod',
  userResponse: string,
  booking: BookingData,
  establishment: EstablishmentConfig = DEFAULT_ESTABLISHMENT
): {
  action: string;
  response: string;
  scheduleReminder?: boolean;
  paymentPreference?: string;
} {
  const normalizedResponse = userResponse.toLowerCase().trim();
  const isPositive = normalizedResponse.includes('sim') || 
                    normalizedResponse.includes('quero') || 
                    normalizedResponse.includes('gostaria') ||
                    normalizedResponse.includes('ok') ||
                    normalizedResponse.includes('pode') ||
                    normalizedResponse.includes('claro');

  switch (ctaType) {
    case 'reminder':
      if (isPositive) {
        return {
          action: 'schedule_reminder',
          response: '✅ Perfeito! Você receberá um lembrete 24h antes do seu agendamento.',
          scheduleReminder: true
        };
      } else {
        return {
          action: 'no_reminder',
          response: '👍 Entendi, sem lembrete. Anote aí: ' + formatDateBR(booking.date) + ' às ' + booking.time + '!'
        };
      }

    case 'location':
      if (isPositive) {
        const locationMessage = establishment.locationUrl 
          ? `📍 *Localização do ${establishment.name}*\n\n${establishment.address}\n\n🗺️ Link do Google Maps:\n${establishment.locationUrl}\n\n🚗 *Como chegar:*\n${establishment.arrivalInstructions}`
          : `📍 *Endereço:*\n${establishment.address}\n\n🚶‍♀️ *Como chegar:*\n${establishment.arrivalInstructions}`;
        
        return {
          action: 'send_location',
          response: locationMessage
        };
      } else {
        return {
          action: 'no_location',
          response: '👍 Sem problemas! Se precisar da localização depois, é só pedir.'
        };
      }

    case 'paymentMethod':
      let paymentPreference = 'não informado';
      
      if (normalizedResponse.includes('dinheiro') || normalizedResponse.includes('espécie')) {
        paymentPreference = 'dinheiro';
      } else if (normalizedResponse.includes('pix')) {
        paymentPreference = 'PIX';
      } else if (normalizedResponse.includes('cartão') || normalizedResponse.includes('cartao') || normalizedResponse.includes('débito') || normalizedResponse.includes('crédito')) {
        paymentPreference = 'cartão';
      }
      
      return {
        action: 'save_payment_preference',
        response: `💳 Anotado! Forma de pagamento preferida: *${paymentPreference}*. Isso nos ajuda a agilizar seu atendimento.`,
        paymentPreference
      };

    default:
      return {
        action: 'unknown',
        response: 'Não entendi sua preferência. Pode reformular?'
      };
  }
}

// Função para gerar mensagem de pré-visita (24-40h antes)
export function generatePreVisitMessage(
  booking: BookingData,
  establishment: EstablishmentConfig = DEFAULT_ESTABLISHMENT
): string {
  const formattedDate = formatDateBR(booking.date);
  const clientGreeting = booking.clientName ? `Oi, ${booking.clientName}!` : 'Olá!';
  
  return `${clientGreeting} 👋\n\n` +
    `🗓️ Lembrete do seu agendamento *amanhã*:\n\n` +
    `*Serviço:* ${booking.serviceName}\n` +
    `*Data:* ${formattedDate}\n` +
    `*Horário:* ${booking.time}\n\n` +
    `📍 *Local:* ${establishment.name}\n` +
    `${establishment.address}\n\n` +
    `⏰ *Lembre-se:*\n` +
    `• ${establishment.arrivalInstructions}\n` +
    `• ${establishment.lateFeePolicy}\n\n` +
    `Confirma sua presença? Responda *SIM* para confirmar ou *NÃO* se precisar remarcar.`;
}

// Função para gerar mensagem de no-show shield (dia anterior às 18h)
export function generateNoShowShieldMessage(
  booking: BookingData
): string {
  const clientGreeting = booking.clientName ? `${booking.clientName}` : 'Cliente';
  
  return `🔔 *Confirmação de Presença*\n\n` +
    `${clientGreeting}, confirma sua presença amanhã às *${booking.time}* para ${booking.serviceName.toLowerCase()}?\n\n` +
    `✅ Responda *SIM* para confirmar\n` +
    `❌ Responda *NÃO* se precisar remarcar\n\n` +
    `Sua confirmação nos ajuda a organizar melhor a agenda! 😊`;
}

// Função para processar resposta do no-show shield
export function processNoShowResponse(
  userResponse: string,
  booking: BookingData
): {
  confirmed: boolean;
  response: string;
  action: 'confirmed' | 'reschedule_needed' | 'unclear';
} {
  const normalizedResponse = userResponse.toLowerCase().trim();
  
  const positiveResponses = ['sim', 'confirmo', 'confirmado', 'ok', 'pode ser', 'claro', 'vou', 'estarei'];
  const negativeResponses = ['não', 'nao', 'preciso remarcar', 'remarcar', 'cancelar', 'não posso', 'nao posso'];
  
  const isPositive = positiveResponses.some(word => normalizedResponse.includes(word));
  const isNegative = negativeResponses.some(word => normalizedResponse.includes(word));
  
  if (isPositive && !isNegative) {
    return {
      confirmed: true,
      response: `✅ Perfeito! Confirmado para amanhã às ${booking.time}. Te esperamos! 😊`,
      action: 'confirmed'
    };
  }
  
  if (isNegative) {
    return {
      confirmed: false,
      response: `Sem problemas! Vamos remarcar seu agendamento. Qual data e horário prefere?`,
      action: 'reschedule_needed'
    };
  }
  
  return {
    confirmed: false,
    response: `Não entendi sua resposta. Confirma sua presença amanhã às ${booking.time}? Responda SIM ou NÃO.`,
    action: 'unclear'
  };
}

// Função para logging de interações pós-agendamento
export function logPostBookingInteraction(
  bookingId: string | number,
  interactionType: string,
  userResponse: string,
  systemAction: string
): void {
  logger.info('Post-booking interaction', {
    bookingId,
    interactionType,
    userResponse: userResponse.substring(0, 100), // Limitar tamanho do log
    systemAction,
    timestamp: new Date().toISOString()
  });
}