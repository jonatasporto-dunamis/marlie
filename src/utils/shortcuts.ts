import * as trinks from '../integrations/trinks';
import logger from './logger';
import { EstablishmentConfig } from './post-booking-templates';

// Configuração padrão do estabelecimento
const DEFAULT_ESTABLISHMENT: EstablishmentConfig = {
  name: 'Ateliê Marcleia Abade',
  address: 'Rua das Flores, 123 - Barra, Salvador - BA, 40070-000',
  phone: '(71) 99999-9999',
  lateFeePolicy: 'Tolerância de 15 minutos. Após esse período, será necessário reagendar.',
  noShowPolicy: 'Ausência sem aviso prévio pode resultar em cobrança de taxa.',
  arrivalInstructions: 'Chegue com 5 minutos de antecedência. Aguarde na recepção.',
  locationUrl: 'https://maps.google.com/?q=-12.9777,-38.5016'
};

// Interface para resultado de atalho
export interface ShortcutResult {
  action: 'remarcar' | 'cancelar' | 'preco' | 'endereco' | 'none';
  response: string;
  requiresFollowUp?: boolean;
  followUpContext?: any;
}

// Função principal para detectar e processar atalhos
export async function processShortcut(
  text: string,
  phoneNumber: string,
  currentContext?: any
): Promise<ShortcutResult> {
  const normalizedText = text.toLowerCase().trim();
  
  // Detectar atalho de remarcação
  if (isRemarcarShortcut(normalizedText)) {
    return await handleRemarcarShortcut(phoneNumber, currentContext);
  }
  
  // Detectar atalho de cancelamento
  if (isCancelarShortcut(normalizedText)) {
    return await handleCancelarShortcut(phoneNumber, currentContext);
  }
  
  // Detectar atalho de preço
  if (isPrecoShortcut(normalizedText)) {
    return await handlePrecoShortcut(normalizedText, currentContext);
  }
  
  // Detectar atalho de endereço
  if (isEnderecoShortcut(normalizedText)) {
    return handleEnderecoShortcut();
  }
  
  return {
    action: 'none',
    response: ''
  };
}

// Funções de detecção de atalhos
function isRemarcarShortcut(text: string): boolean {
  const remarcarTerms = [
    'remarcar', 'reagendar', 'mudar horário', 'mudar horario',
    'trocar data', 'trocar horário', 'trocar horario',
    'alterar agendamento', 'modificar agendamento'
  ];
  
  return remarcarTerms.some(term => text.includes(term));
}

function isCancelarShortcut(text: string): boolean {
  const cancelarTerms = [
    'cancelar', 'desmarcar', 'excluir agendamento',
    'não vou mais', 'nao vou mais', 'não posso ir',
    'nao posso ir', 'desistir'
  ];
  
  return cancelarTerms.some(term => text.includes(term));
}

function isPrecoShortcut(text: string): boolean {
  const precoTerms = [
    'preço', 'preco', 'valor', 'quanto custa',
    'quanto é', 'quanto fica', 'tabela de preços',
    'tabela de precos', 'valores'
  ];
  
  return precoTerms.some(term => text.includes(term));
}

function isEnderecoShortcut(text: string): boolean {
  const enderecoTerms = [
    'endereço', 'endereco', 'localização', 'localizacao',
    'onde fica', 'onde vocês ficam', 'como chegar',
    'localizar', 'maps', 'google maps'
  ];
  
  return enderecoTerms.some(term => text.includes(term));
}

// Handlers para cada tipo de atalho
async function handleRemarcarShortcut(
  phoneNumber: string,
  currentContext?: any
): Promise<ShortcutResult> {
  try {
    // Buscar agendamentos ativos do cliente
    const agendamentos = await findActiveBookings(phoneNumber);
    
    if (agendamentos.length === 0) {
      return {
        action: 'remarcar',
        response: 'Não encontrei agendamentos ativos para remarcar. Gostaria de fazer um novo agendamento?'
      };
    }
    
    if (agendamentos.length === 1) {
      const agendamento = agendamentos[0];
      return {
        action: 'remarcar',
        response: `Vou te ajudar a remarcar seu agendamento:\n\n` +
          `*Agendamento atual:*\n` +
          `${agendamento.serviceName} - ${agendamento.date} às ${agendamento.time}\n\n` +
          `Para qual nova data e horário gostaria de remarcar?`,
        requiresFollowUp: true,
        followUpContext: {
          action: 'remarcar',
          originalBooking: agendamento,
          preserveService: true,
          preserveProfessional: !!agendamento.professionalName
        }
      };
    }
    
    // Múltiplos agendamentos - listar para escolha
    const lista = agendamentos.map((ag, index) => 
      `${index + 1}. ${ag.serviceName} - ${ag.date} às ${ag.time}`
    ).join('\n');
    
    return {
      action: 'remarcar',
      response: `Você tem ${agendamentos.length} agendamentos. Qual deseja remarcar?\n\n${lista}\n\nResponda com o número.`,
      requiresFollowUp: true,
      followUpContext: {
        action: 'select_booking_to_reschedule',
        bookings: agendamentos
      }
    };
    
  } catch (error) {
    logger.error('Erro ao processar remarcação:', error);
    return {
      action: 'remarcar',
      response: 'Houve um erro ao buscar seus agendamentos. Pode tentar novamente ou entrar em contato conosco?'
    };
  }
}

async function handleCancelarShortcut(
  phoneNumber: string,
  currentContext?: any
): Promise<ShortcutResult> {
  try {
    const agendamentos = await findActiveBookings(phoneNumber);
    
    if (agendamentos.length === 0) {
      return {
        action: 'cancelar',
        response: 'Não encontrei agendamentos ativos para cancelar.'
      };
    }
    
    if (agendamentos.length === 1) {
      const agendamento = agendamentos[0];
      return {
        action: 'cancelar',
        response: `Confirma o cancelamento do agendamento?\n\n` +
          `*${agendamento.serviceName}*\n` +
          `${agendamento.date} às ${agendamento.time}\n\n` +
          `Responda *SIM* para confirmar o cancelamento.`,
        requiresFollowUp: true,
        followUpContext: {
          action: 'confirm_cancellation',
          bookingToCancel: agendamento
        }
      };
    }
    
    // Múltiplos agendamentos
    const lista = agendamentos.map((ag, index) => 
      `${index + 1}. ${ag.serviceName} - ${ag.date} às ${ag.time}`
    ).join('\n');
    
    return {
      action: 'cancelar',
      response: `Qual agendamento deseja cancelar?\n\n${lista}\n\nResponda com o número.`,
      requiresFollowUp: true,
      followUpContext: {
        action: 'select_booking_to_cancel',
        bookings: agendamentos
      }
    };
    
  } catch (error) {
    logger.error('Erro ao processar cancelamento:', error);
    return {
      action: 'cancelar',
      response: 'Houve um erro ao buscar seus agendamentos. Pode tentar novamente?'
    };
  }
}

async function handlePrecoShortcut(
  text: string,
  currentContext?: any
): Promise<ShortcutResult> {
  try {
    // Extrair nome do serviço da mensagem
    const serviceName = extractServiceFromPriceQuery(text);
    
    if (serviceName) {
      // Buscar preço específico do serviço
      const serviceInfo = await findServicePrice(serviceName);
      
      if (serviceInfo) {
        const similarServices = await findSimilarServices(serviceName);
        let response = `💰 *Preço de ${serviceInfo.name}:* R$ ${serviceInfo.price.toFixed(2)}\n\n`;
        
        if (similarServices.length > 0) {
          response += `*Serviços similares:*\n`;
          similarServices.forEach(service => {
            response += `• ${service.name}: R$ ${service.price.toFixed(2)}\n`;
          });
          response += '\n';
        }
        
        response += 'Gostaria de agendar algum desses serviços?';
        
        return {
          action: 'preco',
          response,
          requiresFollowUp: true,
          followUpContext: {
            action: 'price_inquiry_followup',
            queriedService: serviceInfo,
            similarServices
          }
        };
      }
    }
    
    // Resposta genérica com tabela de preços principais
    const mainServices = await getMainServicesPricing();
    let response = '💰 *Principais serviços e valores:*\n\n';
    
    mainServices.forEach(service => {
      response += `• ${service.name}: R$ ${service.price.toFixed(2)}\n`;
    });
    
    response += '\n📋 Para ver nossa tabela completa ou agendar, me diga qual serviço te interessa!';
    
    return {
      action: 'preco',
      response
    };
    
  } catch (error) {
    logger.error('Erro ao buscar preços:', error);
    return {
      action: 'preco',
      response: 'Houve um erro ao consultar os preços. Entre em contato conosco para informações atualizadas!'
    };
  }
}

function handleEnderecoShortcut(): ShortcutResult {
  const establishment = DEFAULT_ESTABLISHMENT;
  
  const response = `📍 *${establishment.name}*\n\n` +
    `*Endereço:*\n${establishment.address}\n\n` +
    `*Telefone:* ${establishment.phone}\n\n` +
    `🗺️ *Google Maps:*\n${establishment.locationUrl}\n\n` +
    `🚗 *Como chegar:*\n${establishment.arrivalInstructions}\n\n` +
    `⏰ *Funcionamento:*\nTerça a sábado, das 10h às 19h\n\n` +
    `Te esperamos! Qualquer dúvida sobre localização, me avise. 😊`;
  
  return {
    action: 'endereco',
    response
  };
}

// Funções auxiliares
async function findActiveBookings(phoneNumber: string): Promise<any[]> {
  try {
    // Buscar agendamentos ativos do cliente via Trinks
    const cliente = await trinks.Trinks.buscarClientes({ telefone: phoneNumber });
    const clienteData = Array.isArray(cliente?.data) ? cliente.data[0] : cliente?.[0];
    
    if (!clienteData?.id) {
      return [];
    }
    
    // Buscar agendamentos futuros (implementação temporária)
    // TODO: Implementar buscarAgendamentos na API Trinks quando disponível
    const hoje = new Date().toISOString().split('T')[0];
    
    // Por enquanto, retornar array vazio até que a API tenha o método buscarAgendamentos
    logger.warn('Método buscarAgendamentos não implementado na API Trinks ainda');
    return [];
    
    // Código comentado até implementação da API:
    // const agendamentos = await trinks.Trinks.buscarAgendamentos({
    //   clienteId: clienteData.id,
    //   dataInicio: hoje
    // });
    // 
    // const agendamentosArray = Array.isArray(agendamentos?.data) ? agendamentos.data : agendamentos || [];
    // 
    // return agendamentosArray.map((ag: any) => ({
    //   id: ag.id,
    //   serviceName: ag.servicoNome || ag.nomeServico || 'Serviço',
    //   date: ag.dataHoraInicio?.split('T')[0] || ag.data,
    //   time: ag.dataHoraInicio?.split('T')[1]?.substring(0, 5) || ag.hora,
    //   professionalName: ag.profissionalNome || ag.nomeProfissional
    // }));
    
  } catch (error) {
    logger.error('Erro ao buscar agendamentos ativos:', error);
    return [];
  }
}

function extractServiceFromPriceQuery(text: string): string | null {
  // Remover palavras de consulta de preço
  const cleanText = text
    .replace(/\b(preço|preco|valor|quanto custa|quanto é|quanto fica)\b/gi, '')
    .replace(/\b(da|do|de|para)\b/gi, '')
    .trim();
  
  if (cleanText.length > 2) {
    return cleanText;
  }
  
  return null;
}

async function findServicePrice(serviceName: string): Promise<{ name: string; price: number } | null> {
  try {
    // Buscar serviço no catálogo local primeiro
    const { getServicosSuggestions } = await import('../db/index');
    const suggestions = await getServicosSuggestions('default', serviceName, 1);
    
    if (suggestions.length > 0) {
      const service = suggestions[0];
      return {
        name: service.servicoNome,
        price: Number(service.valor) || 0
      };
    }
    
    // Buscar no Trinks se não encontrar localmente
    const services = await trinks.Trinks.buscarServicos({ nome: serviceName });
    const servicesList = Array.isArray(services?.data) ? services.data : services || [];
    
    if (servicesList.length > 0) {
      const service = servicesList[0];
      return {
        name: service.nome || service.nomeServico || serviceName,
        price: Number(service.valor || service.preco || service.precoAtual) || 0
      };
    }
    
    return null;
  } catch (error) {
    logger.error('Erro ao buscar preço do serviço:', error);
    return null;
  }
}

async function findSimilarServices(serviceName: string): Promise<{ name: string; price: number }[]> {
  try {
    const { getServicosSuggestions } = await import('../db/index');
    const suggestions = await getServicosSuggestions('default', serviceName, 5);
    
    return suggestions.slice(1, 4).map(service => ({
      name: service.servicoNome,
      price: Number(service.valor) || 0
    }));
  } catch (error) {
    logger.error('Erro ao buscar serviços similares:', error);
    return [];
  }
}

async function getMainServicesPricing(): Promise<{ name: string; price: number }[]> {
  try {
    const { getServicosSuggestions } = await import('../db/index');
    const suggestions = await getServicosSuggestions('default', '', 8);
    
    return suggestions.map(service => ({
      name: service.servicoNome,
      price: Number(service.valor) || 0
    }));
  } catch (error) {
    logger.error('Erro ao buscar preços principais:', error);
    // Fallback com preços exemplo
    return [
      { name: 'Cutilagem', price: 25.00 },
      { name: 'Esmaltação', price: 15.00 },
      { name: 'Manicure Completa', price: 35.00 },
      { name: 'Pedicure', price: 30.00 },
      { name: 'Design de Sobrancelha', price: 20.00 }
    ];
  }
}

// Função para processar follow-ups de atalhos
export async function processShortcutFollowUp(
  text: string,
  phoneNumber: string,
  followUpContext: any
): Promise<ShortcutResult> {
  const normalizedText = text.toLowerCase().trim();
  
  switch (followUpContext.action) {
    case 'confirm_cancellation':
      if (normalizedText.includes('sim') || normalizedText.includes('confirmo')) {
        // Processar cancelamento
        return await processCancellation(followUpContext.bookingToCancel, phoneNumber);
      } else {
        return {
          action: 'cancelar',
          response: 'Cancelamento não confirmado. Seu agendamento permanece ativo. Posso ajudar com mais alguma coisa?'
        };
      }
      
    case 'select_booking_to_cancel':
      const cancelIndex = parseInt(normalizedText) - 1;
      if (cancelIndex >= 0 && cancelIndex < followUpContext.bookings.length) {
        const selectedBooking = followUpContext.bookings[cancelIndex];
        return {
          action: 'cancelar',
          response: `Confirma o cancelamento?\n\n*${selectedBooking.serviceName}*\n${selectedBooking.date} às ${selectedBooking.time}\n\nResponda *SIM* para confirmar.`,
          requiresFollowUp: true,
          followUpContext: {
            action: 'confirm_cancellation',
            bookingToCancel: selectedBooking
          }
        };
      } else {
        return {
          action: 'cancelar',
          response: 'Número inválido. Qual agendamento deseja cancelar? Responda com o número da lista.'
        };
      }
      
    default:
      return {
        action: 'none',
        response: 'Não entendi. Pode reformular sua solicitação?'
      };
  }
}

async function processCancellation(booking: any, phoneNumber: string): Promise<ShortcutResult> {
  try {
    // Aqui você implementaria a lógica real de cancelamento via Trinks
    // Por enquanto, apenas simular
    
    logger.info('Processando cancelamento', {
      bookingId: booking.id,
      phoneNumber,
      serviceName: booking.serviceName
    });
    
    // Registrar motivo do cancelamento (opcional)
    return {
      action: 'cancelar',
      response: `✅ Agendamento cancelado com sucesso!\n\n` +
        `*${booking.serviceName}* em ${booking.date} às ${booking.time}\n\n` +
        `Se quiser reagendar, é só me avisar. Estou aqui para ajudar! 😊`,
      requiresFollowUp: true,
      followUpContext: {
        action: 'post_cancellation',
        cancelledService: booking.serviceName
      }
    };
    
  } catch (error) {
    logger.error('Erro ao cancelar agendamento:', error);
    return {
      action: 'cancelar',
      response: 'Houve um erro ao cancelar o agendamento. Entre em contato conosco para resolver.'
    };
  }
}