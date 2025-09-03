import { DateTime } from 'luxon';

// Timezone da Bahia
const BAHIA_TIMEZONE = 'America/Bahia';

// Tipos para datas relativas
export type RelativeDate = 'hoje' | 'amanhã' | 'depois de amanhã' | 'segunda' | 'terça' | 'quarta' | 'quinta' | 'sexta' | 'sábado' | 'domingo';
export type Period = 'manhã' | 'tarde' | 'noite';

// Interface para resultado do resolver
export interface ResolvedDate {
  dateISO: string; // YYYY-MM-DD
  dateRel?: string; // Data relativa original
  timeISO?: string; // HH:MM
  period?: Period;
  dayOfWeek: number; // 1=segunda, 7=domingo
  isBusinessDay: boolean; // terça a sábado
}

/**
 * Resolve datas relativas para datas absolutas usando timezone da Bahia
 */
export function resolveDateRelative(dateRel: string, referenceDate?: DateTime): ResolvedDate {
  // Usar data de referência ou agora na Bahia
  const now = referenceDate || DateTime.now().setZone(BAHIA_TIMEZONE);
  let targetDate: DateTime;

  switch (dateRel.toLowerCase()) {
    case 'hoje':
      targetDate = now;
      break;
    
    case 'amanhã':
      targetDate = now.plus({ days: 1 });
      break;
    
    case 'depois de amanhã':
      targetDate = now.plus({ days: 2 });
      break;
    
    case 'segunda':
      targetDate = getNextWeekday(now, 1);
      break;
    
    case 'terça':
      targetDate = getNextWeekday(now, 2);
      break;
    
    case 'quarta':
      targetDate = getNextWeekday(now, 3);
      break;
    
    case 'quinta':
      targetDate = getNextWeekday(now, 4);
      break;
    
    case 'sexta':
      targetDate = getNextWeekday(now, 5);
      break;
    
    case 'sábado':
      targetDate = getNextWeekday(now, 6);
      break;
    
    case 'domingo':
      targetDate = getNextWeekday(now, 7);
      break;
    
    default:
      // Se não reconhecer, usar hoje
      targetDate = now;
      break;
  }

  const dayOfWeek = targetDate.weekday; // 1=segunda, 7=domingo
  const isBusinessDay = dayOfWeek >= 2 && dayOfWeek <= 6; // terça a sábado

  return {
    dateISO: targetDate.toISODate()!,
    dateRel,
    dayOfWeek,
    isBusinessDay
  };
}

/**
 * Resolve período do dia para horário específico
 */
export function resolvePeriodToTime(period: Period): string {
  switch (period) {
    case 'manhã':
      return '09:00'; // 9h da manhã
    case 'tarde':
      return '14:00'; // 2h da tarde
    case 'noite':
      return '19:00'; // 7h da noite
    default:
      return '09:00';
  }
}

/**
 * Combina data e horário em um DateTime completo
 */
export function combineDateAndTime(dateISO: string, timeISO?: string, period?: Period): DateTime {
  const finalTime = timeISO || (period ? resolvePeriodToTime(period) : '09:00');
  const [hours, minutes] = finalTime.split(':').map(Number);
  
  return DateTime.fromISO(dateISO, { zone: BAHIA_TIMEZONE })
    .set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
}

/**
 * Obtém o próximo dia da semana especificado
 */
function getNextWeekday(from: DateTime, targetWeekday: number): DateTime {
  const currentWeekday = from.weekday;
  let daysToAdd = targetWeekday - currentWeekday;
  
  // Se o dia já passou esta semana, ir para a próxima semana
  if (daysToAdd <= 0) {
    daysToAdd += 7;
  }
  
  return from.plus({ days: daysToAdd });
}

/**
 * Verifica se uma data é dia útil (terça a sábado)
 */
export function isBusinessDay(dateISO: string): boolean {
  const date = DateTime.fromISO(dateISO, { zone: BAHIA_TIMEZONE });
  const weekday = date.weekday;
  return weekday >= 2 && weekday <= 6;
}

/**
 * Obtém o próximo dia útil a partir de uma data
 */
export function getNextBusinessDay(dateISO: string): string {
  let date = DateTime.fromISO(dateISO, { zone: BAHIA_TIMEZONE });
  
  do {
    date = date.plus({ days: 1 });
  } while (!isBusinessDay(date.toISODate()!));
  
  return date.toISODate()!;
}

/**
 * Formata data para exibição em português brasileiro
 */
export function formatDateBR(dateISO: string): string {
  const date = DateTime.fromISO(dateISO, { zone: BAHIA_TIMEZONE });
  
  return date.toLocaleString({
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }, { locale: 'pt-BR' });
}

/**
 * Formata horário para exibição
 */
export function formatTimeBR(timeISO: string): string {
  const [hours, minutes] = timeISO.split(':');
  return `${hours}:${minutes}`;
}

/**
 * Obtém data e hora atual na Bahia
 */
export function getNowInBahia(): DateTime {
  return DateTime.now().setZone(BAHIA_TIMEZONE);
}

/**
 * Verifica se uma data/hora já passou
 */
export function isPastDateTime(dateISO: string, timeISO?: string): boolean {
  const now = getNowInBahia();
  const targetDateTime = combineDateAndTime(dateISO, timeISO);
  
  return targetDateTime < now;
}

/**
 * Resolve data e horário completos a partir dos campos extraídos pelo NLU
 */
export function resolveCompleteDateTime(
  dateRel?: string,
  dateISO?: string,
  timeISO?: string,
  period?: Period,
  referenceDate?: DateTime
): ResolvedDate {
  let resolved: ResolvedDate;
  
  if (dateRel) {
    // Resolver data relativa
    resolved = resolveDateRelative(dateRel, referenceDate);
  } else if (dateISO) {
    // Usar data ISO fornecida
    const date = DateTime.fromISO(dateISO, { zone: BAHIA_TIMEZONE });
    resolved = {
      dateISO,
      dayOfWeek: date.weekday,
      isBusinessDay: date.weekday >= 2 && date.weekday <= 6
    };
  } else {
    // Fallback para hoje
    resolved = resolveDateRelative('hoje', referenceDate);
  }
  
  // Adicionar informações de horário
  if (timeISO) {
    resolved.timeISO = timeISO;
  } else if (period) {
    resolved.period = period;
    resolved.timeISO = resolvePeriodToTime(period);
  }
  
  return resolved;
}