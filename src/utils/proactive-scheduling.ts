import * as trinks from '../integrations/trinks';
import logger from './logger';
import { 
  resolveDateRelative, 
  resolveCompleteDateTime, 
  getNextBusinessDay, 
  formatDateBR,
  isBusinessDay,
  type Period,
  type ResolvedDate 
} from './date-resolver';

// Mapeamento de períodos para janelas de horário
const PERIOD_WINDOWS = {
  manhã: { start: '09:00', end: '12:00' },
  tarde: { start: '13:30', end: '17:30' },
  noite: { start: '18:00', end: '20:00' }
} as const;

// Função para detectar termos relativos de data e período
export function parseRelativeDateTime(text: string): {
  dateRel?: string;
  period?: Period;
  timeISO?: string;
} {
  const normalizedText = text.toLowerCase().trim();
  
  // Detectar termos de data relativa
  let dateRel: string | undefined;
  if (normalizedText.includes('hoje')) {
    dateRel = 'hoje';
  } else if (normalizedText.includes('amanhã')) {
    dateRel = 'amanhã';
  }
  
  // Detectar períodos com variações baianas
  let period: Period | undefined;
  if (normalizedText.includes('manhã') || normalizedText.includes('cedinho') || normalizedText.includes('cedo')) {
    period = 'manhã';
  } else if (normalizedText.includes('tarde') || normalizedText.includes('finalzinho da tarde')) {
    period = 'tarde';
  } else if (normalizedText.includes('noite') || normalizedText.includes('noitinha') || normalizedText.includes('mais pra noite')) {
    period = 'noite';
  }
  
  // Detectar horário específico (formato HH:MM ou HH:mm)
  const timeMatch = normalizedText.match(/\b(\d{1,2})[:h](\d{2})\b/);
  let timeISO: string | undefined;
  if (timeMatch) {
    const hours = timeMatch[1].padStart(2, '0');
    const minutes = timeMatch[2];
    timeISO = `${hours}:${minutes}`;
  }
  
  return { dateRel, period, timeISO };
}

// Função para converter data relativa em ISO (usando novo resolver)
export function convertRelativeDateToISO(dateRel: string): string {
  const resolved = resolveDateRelative(dateRel);
  return resolved.dateISO;
}

// Função para gerar horários dentro de uma janela
function generateTimeSlots(startTime: string, endTime: string, intervalMinutes: number = 30): string[] {
  const slots: string[] = [];
  const [startHour, startMin] = startTime.split(':').map(Number);
  const [endHour, endMin] = endTime.split(':').map(Number);
  
  let currentHour = startHour;
  let currentMin = startMin;
  
  while (currentHour < endHour || (currentHour === endHour && currentMin < endMin)) {
    const timeSlot = `${currentHour.toString().padStart(2, '0')}:${currentMin.toString().padStart(2, '0')}`;
    slots.push(timeSlot);
    
    currentMin += intervalMinutes;
    if (currentMin >= 60) {
      currentHour += Math.floor(currentMin / 60);
      currentMin = currentMin % 60;
    }
  }
  
  return slots;
}

// Função principal para sugerir horários proativamente
export async function suggestProactiveTimeSlots(
  servicoId: number,
  duracaoEmMinutos: number,
  dateISO: string,
  period?: Period
): Promise<{
  suggestions: string[];
  fallbackDate?: string;
  fallbackSuggestions?: string[];
}> {
  try {
    logger.debug(`Sugerindo horários proativos para serviço ${servicoId} em ${dateISO}, período: ${period}`);
    
    let timeSlots: string[] = [];
    
    if (period && PERIOD_WINDOWS[period]) {
      // Gerar slots dentro da janela do período
      const window = PERIOD_WINDOWS[period];
      timeSlots = generateTimeSlots(window.start, window.end, 30);
    } else {
      // Se não há período específico, usar horário comercial completo
      timeSlots = [
        ...generateTimeSlots('09:00', '12:00', 30),
        ...generateTimeSlots('13:30', '17:30', 30),
        ...generateTimeSlots('18:00', '20:00', 30)
      ];
    }
    
    // Verificar disponibilidade para cada slot
    const availableSlots: string[] = [];
    
    for (const timeSlot of timeSlots) {
      try {
        const disponibilidade = await trinks.Trinks.verificarHorarioDisponivel({
          data: dateISO,
          hora: timeSlot,
          servicoId,
          duracaoEmMinutos
        });
        
        if (disponibilidade.disponivel) {
          availableSlots.push(timeSlot);
          // Limitar a 3 sugestões
          if (availableSlots.length >= 3) {
            break;
          }
        }
      } catch (error) {
        logger.debug(`Erro ao verificar disponibilidade para ${timeSlot}:`, error);
        continue;
      }
    }
    
    // Se não há disponibilidade na data solicitada, tentar próximo dia útil
    if (availableSlots.length === 0) {
      const nextBusinessDay = getNextBusinessDay(dateISO);
      const fallbackSlots = await suggestProactiveTimeSlots(
        servicoId,
        duracaoEmMinutos,
        nextBusinessDay,
        period
      );
      
      return {
        suggestions: [],
        fallbackDate: nextBusinessDay,
        fallbackSuggestions: fallbackSlots.suggestions.slice(0, 3)
      };
    }
    
    return {
      suggestions: availableSlots.slice(0, 3)
    };
    
  } catch (error) {
    logger.error('Erro ao sugerir horários proativos:', error);
    return { suggestions: [] };
  }
}

// Função removida - agora usando getNextBusinessDay do date-resolver

// Função para formatar sugestões de horário para o usuário
export function formatTimeSlotSuggestions(
  suggestions: string[],
  serviceName: string,
  dateISO: string,
  fallbackDate?: string,
  fallbackSuggestions?: string[]
): string {
  
  if (suggestions.length > 0) {
    const formattedDate = formatDateBR(dateISO);
    const timeOptions = suggestions.map((time, index) => `${index + 1}. ${time}`).join('\n');
    
    return `Perfeito! Tenho estes horários disponíveis para ${serviceName.toLowerCase()} em ${formattedDate}:\n\n${timeOptions}\n\nQual prefere? Pode responder com o número ou horário.`;
  }
  
  if (fallbackDate && fallbackSuggestions && fallbackSuggestions.length > 0) {
    const formattedFallbackDate = formatDateBR(fallbackDate);
    const timeOptions = fallbackSuggestions.map((time, index) => `${index + 1}. ${time}`).join('\n');
    
    return `Não tenho disponibilidade na data solicitada. Que tal em ${formattedFallbackDate}?\n\n${timeOptions}\n\nQual horário prefere?`;
  }
  
  return 'No momento não tenho horários disponíveis. Pode sugerir uma data específica ou prefere que eu verifique com nossa equipe?';
}

// Função para detectar se o usuário está usando atalhos
export function detectShortcuts(text: string): {
  action?: 'remarcar' | 'cancelar' | 'preco' | 'endereco';
  context?: string;
} {
  const normalizedText = text.toLowerCase().trim();
  
  if (normalizedText.includes('remarcar') || normalizedText.includes('reagendar')) {
    return { action: 'remarcar' };
  }
  
  if (normalizedText.includes('cancelar') || normalizedText.includes('desmarcar')) {
    return { action: 'cancelar' };
  }
  
  if (normalizedText.includes('preço') || normalizedText.includes('preco') || 
      normalizedText.includes('valor') || normalizedText.includes('quanto custa')) {
    return { action: 'preco' };
  }
  
  if (normalizedText.includes('endereço') || normalizedText.includes('endereco') || 
      normalizedText.includes('localização') || normalizedText.includes('localizacao') ||
      normalizedText.includes('onde fica') || normalizedText.includes('como chegar')) {
    return { action: 'endereco' };
  }
  
  return {};
}