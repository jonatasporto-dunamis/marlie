import logger from '../utils/logger';

// Timezone da Bahia
const BAHIA_TIMEZONE = 'America/Bahia';

/**
 * Resolve data relativa para formato ISO (YYYY-MM-DD) no timezone da Bahia
 */
export function resolveDateRelToISO(
  dateRel: string,
  referenceDate?: Date
): string | null {
  try {
    const now = referenceDate || new Date();
    
    // Converter para timezone da Bahia
    const bahiaDate = new Date(now.toLocaleString('en-US', { timeZone: BAHIA_TIMEZONE }));
    
    let targetDate: Date;
    
    switch (dateRel.toLowerCase()) {
      case 'hoje':
      case 'hj':
        targetDate = bahiaDate;
        break;
        
      case 'amanhã':
      case 'amanha':
        targetDate = new Date(bahiaDate);
        targetDate.setDate(targetDate.getDate() + 1);
        break;
        
      case 'depois de amanhã':
      case 'depois de amanha':
        targetDate = new Date(bahiaDate);
        targetDate.setDate(targetDate.getDate() + 2);
        break;
        
      case 'próxima semana':
      case 'proxima semana':
      case 'semana que vem':
        targetDate = new Date(bahiaDate);
        targetDate.setDate(targetDate.getDate() + 7);
        break;
        
      default:
        // Tentar parsear outras expressões
        const parsedDate = parseRelativeDate(dateRel, bahiaDate);
        if (!parsedDate) {
          logger.warn('Unable to parse relative date:', { dateRel });
          return null;
        }
        targetDate = parsedDate;
    }
    
    // Retornar no formato ISO (YYYY-MM-DD)
    const isoDate = targetDate.toISOString().split('T')[0];
    
    logger.debug('Resolved relative date:', {
      dateRel,
      isoDate,
      timezone: BAHIA_TIMEZONE
    });
    
    return isoDate;
    
  } catch (error) {
    logger.error('Error resolving relative date:', {
      error,
      dateRel,
      referenceDate
    });
    return null;
  }
}

/**
 * Parseia expressões de data mais complexas
 */
function parseRelativeDate(dateRel: string, referenceDate: Date): Date | null {
  const normalized = dateRel.toLowerCase().trim();
  
  // Dias da semana
  const weekdays = {
    'segunda': 1, 'segunda-feira': 1,
    'terça': 2, 'terca': 2, 'terça-feira': 2, 'terca-feira': 2,
    'quarta': 3, 'quarta-feira': 3,
    'quinta': 4, 'quinta-feira': 4,
    'sexta': 5, 'sexta-feira': 5,
    'sábado': 6, 'sabado': 6,
    'domingo': 0
  };
  
  // Procurar por dia da semana
  for (const [dayName, dayNumber] of Object.entries(weekdays)) {
    if (normalized.includes(dayName)) {
      return getNextWeekday(referenceDate, dayNumber);
    }
  }
  
  // Expressões como "daqui a X dias"
  const daysMatch = normalized.match(/daqui a (\d+) dias?/);
  if (daysMatch) {
    const days = parseInt(daysMatch[1]);
    const targetDate = new Date(referenceDate);
    targetDate.setDate(targetDate.getDate() + days);
    return targetDate;
  }
  
  // Expressões como "em X dias"
  const inDaysMatch = normalized.match(/em (\d+) dias?/);
  if (inDaysMatch) {
    const days = parseInt(inDaysMatch[1]);
    const targetDate = new Date(referenceDate);
    targetDate.setDate(targetDate.getDate() + days);
    return targetDate;
  }
  
  return null;
}

/**
 * Encontra o próximo dia da semana
 */
function getNextWeekday(referenceDate: Date, targetDay: number): Date {
  const currentDay = referenceDate.getDay();
  let daysToAdd = targetDay - currentDay;
  
  // Se o dia já passou esta semana, ir para a próxima
  if (daysToAdd <= 0) {
    daysToAdd += 7;
  }
  
  const targetDate = new Date(referenceDate);
  targetDate.setDate(targetDate.getDate() + daysToAdd);
  return targetDate;
}

/**
 * Converte horário para timezone da Bahia
 */
export function convertToBahiaTime(date: Date): Date {
  const bahiaTime = new Date(date.toLocaleString('en-US', { timeZone: BAHIA_TIMEZONE }));
  return bahiaTime;
}

/**
 * Obtém data atual no timezone da Bahia
 */
export function getCurrentBahiaDate(): Date {
  return convertToBahiaTime(new Date());
}

/**
 * Obtém data atual no formato ISO (YYYY-MM-DD) no timezone da Bahia
 */
export function getCurrentBahiaDateISO(): string {
  const bahiaDate = getCurrentBahiaDate();
  return bahiaDate.toISOString().split('T')[0];
}

/**
 * Combina data ISO com horário para criar timestamp completo
 */
export function combineDateTimeISO(
  dateISO: string,
  timeISO: string
): string | null {
  try {
    // Validar formatos
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
      throw new Error('Invalid date format, expected YYYY-MM-DD');
    }
    
    if (!/^\d{2}:\d{2}$/.test(timeISO)) {
      throw new Error('Invalid time format, expected HH:MM');
    }
    
    // Criar timestamp no timezone da Bahia
    const dateTimeString = `${dateISO}T${timeISO}:00`;
    const localDate = new Date(dateTimeString);
    
    // Ajustar para timezone da Bahia
    const bahiaTimestamp = new Date(localDate.toLocaleString('en-US', { timeZone: BAHIA_TIMEZONE }));
    
    return bahiaTimestamp.toISOString();
    
  } catch (error) {
    logger.error('Error combining date and time:', {
      error,
      dateISO,
      timeISO
    });
    return null;
  }
}

/**
 * Valida se uma data está no futuro (considerando timezone da Bahia)
 */
export function isDateInFuture(dateISO: string, timeISO?: string): boolean {
  try {
    const now = getCurrentBahiaDate();
    
    if (timeISO) {
      const combined = combineDateTimeISO(dateISO, timeISO);
      if (!combined) return false;
      
      const targetDate = new Date(combined);
      return targetDate > now;
    } else {
      const targetDate = new Date(dateISO + 'T00:00:00');
      const targetBahia = convertToBahiaTime(targetDate);
      
      // Comparar apenas as datas (ignorar horário)
      const nowDateOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const targetDateOnly = new Date(targetBahia.getFullYear(), targetBahia.getMonth(), targetBahia.getDate());
      
      return targetDateOnly >= nowDateOnly;
    }
    
  } catch (error) {
    logger.error('Error validating future date:', {
      error,
      dateISO,
      timeISO
    });
    return false;
  }
}

/**
 * Formata data para exibição em português brasileiro
 */
export function formatDateBR(dateISO: string): string {
  try {
    const date = new Date(dateISO + 'T00:00:00');
    const bahiaDate = convertToBahiaTime(date);
    
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: BAHIA_TIMEZONE
    };
    
    return bahiaDate.toLocaleDateString('pt-BR', options);
    
  } catch (error) {
    logger.error('Error formatting date:', { error, dateISO });
    return dateISO;
  }
}

/**
 * Formata horário para exibição em português brasileiro
 */
export function formatTimeBR(timeISO: string): string {
  try {
    const [hours, minutes] = timeISO.split(':');
    return `${hours}:${minutes}`;
    
  } catch (error) {
    logger.error('Error formatting time:', { error, timeISO });
    return timeISO;
  }
}

/**
 * Converte período (manhã/tarde/noite) para range de horários
 */
export function periodToTimeRange(period: string): { start: string; end: string } | null {
  switch (period.toLowerCase()) {
    case 'manhã':
    case 'manha':
      return { start: '08:00', end: '12:00' };
      
    case 'tarde':
      return { start: '12:00', end: '18:00' };
      
    case 'noite':
      return { start: '18:00', end: '22:00' };
      
    default:
      logger.warn('Unknown period:', { period });
      return null;
  }
}

/**
 * Gera slots de horário para um período específico
 */
export function generateTimeSlotsForPeriod(
  period: string,
  intervalMinutes: number = 30
): string[] {
  const range = periodToTimeRange(period);
  if (!range) return [];
  
  const slots: string[] = [];
  const startTime = parseTime(range.start);
  const endTime = parseTime(range.end);
  
  if (!startTime || !endTime) return [];
  
  let current = startTime;
  while (current < endTime) {
    const hours = Math.floor(current / 60);
    const minutes = current % 60;
    
    slots.push(`${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`);
    
    current += intervalMinutes;
  }
  
  return slots;
}

/**
 * Parseia horário HH:MM para minutos desde meia-noite
 */
function parseTime(timeStr: string): number | null {
  const match = timeStr.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  
  const hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  
  return hours * 60 + minutes;
}

/**
 * Calcula diferença em dias entre duas datas
 */
export function daysDifference(date1ISO: string, date2ISO: string): number {
  try {
    const d1 = new Date(date1ISO + 'T00:00:00');
    const d2 = new Date(date2ISO + 'T00:00:00');
    
    const diffTime = Math.abs(d2.getTime() - d1.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    return diffDays;
    
  } catch (error) {
    logger.error('Error calculating days difference:', {
      error,
      date1ISO,
      date2ISO
    });
    return 0;
  }
}

/**
 * Verifica se uma data é fim de semana
 */
export function isWeekend(dateISO: string): boolean {
  try {
    const date = new Date(dateISO + 'T00:00:00');
    const bahiaDate = convertToBahiaTime(date);
    const dayOfWeek = bahiaDate.getDay();
    
    return dayOfWeek === 0 || dayOfWeek === 6; // Domingo ou Sábado
    
  } catch (error) {
    logger.error('Error checking weekend:', { error, dateISO });
    return false;
  }
}

/**
 * Obtém próximos N dias úteis
 */
export function getNextBusinessDays(count: number, startDate?: string): string[] {
  const businessDays: string[] = [];
  const start = startDate ? new Date(startDate + 'T00:00:00') : getCurrentBahiaDate();
  
  let current = new Date(start);
  let added = 0;
  
  while (added < count) {
    const currentISO = current.toISOString().split('T')[0];
    
    if (!isWeekend(currentISO)) {
      businessDays.push(currentISO);
      added++;
    }
    
    current.setDate(current.getDate() + 1);
  }
  
  return businessDays;
}