import { Pool } from 'pg';
import { RedisClientType } from 'redis';
import logger from '../utils/logger';
import { Trinks } from '../integrations/trinks';
import { MetricsHelper } from '../metrics/index';

interface UserPreferences {
  phone_e164: string;
  tenant_id: string;
  professional_id_pref?: string;
  slot_window_pref?: 'morning' | 'afternoon' | 'evening';
  service_top: Array<{
    service_id: string;
    service_name: string;
    count: number;
  }>;
  preferred_days: number[];
  preferred_start_time: string;
  preferred_end_time: string;
  total_bookings: number;
  successful_bookings: number;
}

interface SlotPopularity {
  service_id?: string;
  professional_id?: string;
  day_of_week: number;
  hour_slot: number;
  booking_count: number;
  success_rate: number;
}

interface RecommendedSlot {
  timeISO: string;
  displayTime: string;
  professionalId?: string;
  professionalName?: string;
  score: number;
  reasons: string[];
  available: boolean;
}

interface RecommendSlotsParams {
  tenantId: string;
  phone: string;
  dateISO: string;
  period?: 'morning' | 'afternoon' | 'evening';
  serviceId?: string;
  professionalId?: string;
  maxSlots?: number;
}

/**
 * Busca preferências do usuário no banco de dados
 */
export async function getUserPreferences(
  db: Pool,
  phone: string,
  tenantId: string = 'default'
): Promise<UserPreferences | null> {
  try {
    const result = await db.query(
      `SELECT * FROM user_prefs WHERE phone_e164 = $1 AND tenant_id = $2`,
      [phone, tenantId]
    );
    
    return result.rows[0] || null;
  } catch (error) {
    logger.error('Error fetching user preferences:', { error, phone, tenantId });
    return null;
  }
}

/**
 * Atualiza preferências do usuário baseado no histórico
 */
export async function updateUserPreferences(
  db: Pool,
  phone: string,
  tenantId: string,
  updates: Partial<UserPreferences>
): Promise<void> {
  try {
    const existing = await getUserPreferences(db, phone, tenantId);
    
    if (existing) {
      // Update existing preferences
      const setClause = [];
      const values = [];
      let paramIndex = 3;
      
      for (const [key, value] of Object.entries(updates)) {
        if (key !== 'phone_e164' && key !== 'tenant_id' && value !== undefined) {
          setClause.push(`${key} = $${paramIndex}`);
          values.push(value);
          paramIndex++;
        }
      }
      
      if (setClause.length > 0) {
        await db.query(
          `UPDATE user_prefs SET ${setClause.join(', ')} WHERE phone_e164 = $1 AND tenant_id = $2`,
          [phone, tenantId, ...values]
        );
      }
    } else {
      // Insert new preferences
      await db.query(
        `INSERT INTO user_prefs (phone_e164, tenant_id, professional_id_pref, slot_window_pref, service_top, preferred_days, preferred_start_time, preferred_end_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (phone_e164) DO UPDATE SET
           professional_id_pref = EXCLUDED.professional_id_pref,
           slot_window_pref = EXCLUDED.slot_window_pref,
           service_top = EXCLUDED.service_top,
           preferred_days = EXCLUDED.preferred_days,
           preferred_start_time = EXCLUDED.preferred_start_time,
           preferred_end_time = EXCLUDED.preferred_end_time`,
        [
          phone,
          tenantId,
          updates.professional_id_pref || null,
          updates.slot_window_pref || null,
          JSON.stringify(updates.service_top || []),
          updates.preferred_days || [],
          updates.preferred_start_time || '09:00',
          updates.preferred_end_time || '18:00'
        ]
      );
    }
  } catch (error) {
    logger.error('Error updating user preferences:', { error, phone, tenantId });
  }
}

/**
 * Busca popularidade global de slots
 */
export async function getSlotPopularity(
  db: Pool,
  tenantId: string,
  serviceId?: string,
  professionalId?: string
): Promise<SlotPopularity[]> {
  try {
    let query = `
      SELECT service_id, professional_id, day_of_week, hour_slot, booking_count, success_rate
      FROM slot_popularity
      WHERE tenant_id = $1
    `;
    const params = [tenantId];
    let paramIndex = 2;
    
    if (serviceId) {
      query += ` AND (service_id = $${paramIndex} OR service_id IS NULL)`;
      params.push(serviceId);
      paramIndex++;
    }
    
    if (professionalId) {
      query += ` AND (professional_id = $${paramIndex} OR professional_id IS NULL)`;
      params.push(professionalId);
      paramIndex++;
    }
    
    query += ` ORDER BY booking_count DESC, success_rate DESC LIMIT 50`;
    
    const result = await db.query(query, params);
    return result.rows;
  } catch (error) {
    logger.error('Error fetching slot popularity:', { error, tenantId, serviceId, professionalId });
    return [];
  }
}

/**
 * Calcula score de um slot baseado em disponibilidade, preferências e popularidade
 */
function calculateSlotScore(
  timeISO: string,
  available: boolean,
  userPrefs: UserPreferences | null,
  popularity: SlotPopularity[],
  professionalId?: string
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  
  // 1. Disponibilidade real (peso 40)
  if (available) {
    score += 40;
    reasons.push('Horário disponível');
  } else {
    return { score: 0, reasons: ['Horário indisponível'] };
  }
  
  const slotDate = new Date(timeISO);
  const dayOfWeek = slotDate.getDay();
  const hour = slotDate.getHours();
  const timeStr = slotDate.toTimeString().substring(0, 5);
  
  // 2. Preferências do usuário (peso 35)
  if (userPrefs) {
    // Profissional preferido
    if (userPrefs.professional_id_pref && professionalId === userPrefs.professional_id_pref) {
      score += 15;
      reasons.push('Profissional preferido');
    }
    
    // Janela de horário preferida
    if (userPrefs.slot_window_pref) {
      const isPreferredWindow = (
        (userPrefs.slot_window_pref === 'morning' && hour >= 6 && hour < 12) ||
        (userPrefs.slot_window_pref === 'afternoon' && hour >= 12 && hour < 18) ||
        (userPrefs.slot_window_pref === 'evening' && hour >= 18 && hour < 22)
      );
      
      if (isPreferredWindow) {
        score += 10;
        reasons.push(`Período preferido (${userPrefs.slot_window_pref})`);
      }
    }
    
    // Dias preferidos
    if (userPrefs.preferred_days.includes(dayOfWeek)) {
      score += 5;
      reasons.push('Dia da semana preferido');
    }
    
    // Horário preferido
    if (timeStr >= userPrefs.preferred_start_time && timeStr <= userPrefs.preferred_end_time) {
      score += 5;
      reasons.push('Dentro do horário preferido');
    }
  }
  
  // 3. Popularidade global (peso 25)
  const popularSlot = popularity.find(p => 
    p.day_of_week === dayOfWeek && 
    p.hour_slot === hour &&
    (!p.professional_id || p.professional_id === professionalId)
  );
  
  if (popularSlot) {
    const popularityScore = Math.min(25, (popularSlot.booking_count / 10) + (popularSlot.success_rate * 15));
    score += popularityScore;
    reasons.push(`Horário popular (${popularSlot.booking_count} agendamentos)`);
  }
  
  return { score, reasons };
}

/**
 * Gera slots de horário para um dia específico
 */
function generateTimeSlots(
  dateISO: string,
  period?: 'morning' | 'afternoon' | 'evening'
): string[] {
  const slots: string[] = [];
  const baseDate = new Date(dateISO + 'T00:00:00-03:00'); // Bahia timezone
  
  let startHour = 8;
  let endHour = 18;
  
  if (period === 'morning') {
    startHour = 8;
    endHour = 12;
  } else if (period === 'afternoon') {
    startHour = 12;
    endHour = 18;
  } else if (period === 'evening') {
    startHour = 18;
    endHour = 21;
  }
  
  for (let hour = startHour; hour < endHour; hour++) {
    for (let minute = 0; minute < 60; minute += 30) {
      const slotDate = new Date(baseDate);
      slotDate.setHours(hour, minute, 0, 0);
      slots.push(slotDate.toISOString());
    }
  }
  
  return slots;
}

/**
 * Função principal para recomendar slots ordenados por relevância
 */
export async function recommendSlots(
  db: Pool,
  redis: RedisClientType,
  params: RecommendSlotsParams
): Promise<RecommendedSlot[]> {
  const startTime = Date.now();
  const { tenantId, phone, dateISO, period, serviceId, professionalId, maxSlots = 3 } = params;
  
  try {
    // 1. Buscar preferências do usuário
    const userPrefs = await getUserPreferences(db, phone, tenantId);
    
    // 2. Buscar popularidade global
    const popularity = await getSlotPopularity(db, tenantId, serviceId, professionalId);
    
    // 3. Gerar slots candidatos
    const candidateSlots = generateTimeSlots(dateISO, period);
    
    // 4. Verificar disponibilidade real via Trinks
    const availableSlots = new Set<string>();
    
    if (professionalId) {
      try {
        const agenda = await Trinks.buscarAgendaPorProfissional({
          data: dateISO,
          servicoId: params.serviceId || '1',
          servicoDuracao: '60',
          profissionalId: professionalId
        });
        
        // Assumir que agenda retorna slots ocupados, então os não listados estão disponíveis
        const occupiedSlots = new Set(agenda.map((item: any) => item.timeISO));
        
        candidateSlots.forEach(slot => {
          if (!occupiedSlots.has(slot)) {
            availableSlots.add(slot);
          }
        });
      } catch (error) {
        logger.warn('Error checking availability, assuming all slots available:', error);
        candidateSlots.forEach(slot => availableSlots.add(slot));
      }
    } else {
      // Se não há profissional específico, assumir disponibilidade
      candidateSlots.forEach(slot => availableSlots.add(slot));
    }
    
    // 5. Calcular scores e ordenar
    const scoredSlots: RecommendedSlot[] = candidateSlots.map(timeISO => {
      const available = availableSlots.has(timeISO);
      const { score, reasons } = calculateSlotScore(
        timeISO,
        available,
        userPrefs,
        popularity,
        professionalId
      );
      
      const slotDate = new Date(timeISO);
      const displayTime = slotDate.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Bahia'
      });
      
      return {
        timeISO,
        displayTime,
        professionalId,
        score,
        reasons,
        available
      };
    });
    
    // 6. Ordenar por score e filtrar apenas disponíveis
    const recommendedSlots = scoredSlots
      .filter(slot => slot.available)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSlots);
    
    // 7. Registrar métricas
    const duration = Date.now() - startTime;
    MetricsHelper.recordServiceSuggestionDuration(tenantId, duration, false);
    MetricsHelper.incrementServiceSuggestionsShown(tenantId, recommendedSlots.length);
    
    logger.info('Slots recommended successfully', {
      tenantId,
      phone,
      dateISO,
      period,
      candidateCount: candidateSlots.length,
      availableCount: availableSlots.size,
      recommendedCount: recommendedSlots.length,
      duration
    });
    
    return recommendedSlots;
    
  } catch (error) {
    logger.error('Error recommending slots:', {
      error,
      tenantId,
      phone,
      dateISO,
      period
    });
    
    // Fallback: retornar slots básicos sem personalização
    const fallbackSlots = generateTimeSlots(dateISO, period)
      .slice(0, maxSlots)
      .map(timeISO => {
        const slotDate = new Date(timeISO);
        const displayTime = slotDate.toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'America/Bahia'
        });
        
        return {
          timeISO,
          displayTime,
          professionalId,
          score: 10,
          reasons: ['Horário padrão'],
          available: true
        };
      });
    
    return fallbackSlots;
  }
}

/**
 * Atualiza estatísticas de popularidade após um agendamento
 */
export async function updateSlotPopularity(
  db: Pool,
  tenantId: string,
  timeISO: string,
  serviceId?: string,
  professionalId?: string,
  success: boolean = true
): Promise<void> {
  try {
    const slotDate = new Date(timeISO);
    const dayOfWeek = slotDate.getDay();
    const hourSlot = slotDate.getHours();
    
    await db.query(
      `INSERT INTO slot_popularity (tenant_id, service_id, professional_id, day_of_week, hour_slot, booking_count, success_rate)
       VALUES ($1, $2, $3, $4, $5, 1, $6)
       ON CONFLICT (tenant_id, service_id, professional_id, day_of_week, hour_slot)
       DO UPDATE SET
         booking_count = slot_popularity.booking_count + 1,
         success_rate = (slot_popularity.success_rate * slot_popularity.booking_count + $6) / (slot_popularity.booking_count + 1),
         last_updated = NOW()`,
      [tenantId, serviceId, professionalId, dayOfWeek, hourSlot, success ? 1.0 : 0.0]
    );
  } catch (error) {
    logger.error('Error updating slot popularity:', {
      error,
      tenantId,
      timeISO,
      serviceId,
      professionalId,
      success
    });
  }
}