import { Pool } from 'pg';
import logger from './logger';
import * as trinks from '../integrations/trinks';

// Interface para preferências do usuário
export interface UserPreferences {
  phoneNumber: string;
  preferredProfessional?: string;
  preferredTimeSlots: TimeSlotPreference[];
  frequentServices: ServiceFrequency[];
  lastUpdated: Date;
}

export interface TimeSlotPreference {
  startTime: string; // HH:MM
  endTime: string;   // HH:MM
  frequency: number; // quantas vezes escolheu nessa janela
  recency: number;   // peso baseado em quão recente foi
}

export interface ServiceFrequency {
  serviceName: string;
  frequency: number;
  recency: number;
  lastBooked: Date;
}

export interface RecommendedSlot {
  time: string;
  available: boolean;
  score: number; // pontuação de recomendação
  reason: 'availability' | 'user_preference' | 'popularity';
}

// Classe principal do motor de recomendação
export class RecommendationEngine {
  private db: Pool;
  
  constructor(database: Pool) {
    this.db = database;
  }
  
  // Registrar preferência de agendamento
  async recordBookingPreference(
    phoneNumber: string,
    serviceName: string,
    dateTime: string,
    professionalName?: string
  ): Promise<void> {
    try {
      const bookingDate = new Date(dateTime);
      const timeSlot = bookingDate.toTimeString().substring(0, 5); // HH:MM
      
      // Registrar preferência de horário
      await this.updateTimeSlotPreference(phoneNumber, timeSlot);
      
      // Registrar preferência de serviço
      await this.updateServiceFrequency(phoneNumber, serviceName);
      
      // Registrar preferência de profissional
      if (professionalName) {
        await this.updateProfessionalPreference(phoneNumber, professionalName);
      }
      
      logger.info('Preferência de agendamento registrada', {
        phoneNumber,
        serviceName,
        timeSlot,
        professionalName
      });
      
    } catch (error) {
      logger.error('Erro ao registrar preferência de agendamento:', error);
    }
  }
  
  // Atualizar preferência de horário
  private async updateTimeSlotPreference(phoneNumber: string, timeSlot: string): Promise<void> {
    const query = `
      INSERT INTO user_time_preferences (phone_number, time_slot, frequency, last_used)
      VALUES ($1, $2, 1, NOW())
      ON CONFLICT (phone_number, time_slot)
      DO UPDATE SET 
        frequency = user_time_preferences.frequency + 1,
        last_used = NOW()
    `;
    
    await this.db.query(query, [phoneNumber, timeSlot]);
  }
  
  // Atualizar frequência de serviço
  private async updateServiceFrequency(phoneNumber: string, serviceName: string): Promise<void> {
    const query = `
      INSERT INTO user_service_preferences (phone_number, service_name, frequency, last_used)
      VALUES ($1, $2, 1, NOW())
      ON CONFLICT (phone_number, service_name)
      DO UPDATE SET 
        frequency = user_service_preferences.frequency + 1,
        last_used = NOW()
    `;
    
    await this.db.query(query, [phoneNumber, serviceName]);
  }
  
  // Atualizar preferência de profissional
  private async updateProfessionalPreference(phoneNumber: string, professionalName: string): Promise<void> {
    const query = `
      INSERT INTO user_professional_preferences (phone_number, professional_name, frequency, last_used)
      VALUES ($1, $2, 1, NOW())
      ON CONFLICT (phone_number, professional_name)
      DO UPDATE SET 
        frequency = user_professional_preferences.frequency + 1,
        last_used = NOW()
    `;
    
    await this.db.query(query, [phoneNumber, professionalName]);
  }
  
  // Função principal: recomendar slots
  async recommendSlots(
    tenantId: string,
    phoneNumber: string,
    date: string,
    period?: 'manha' | 'tarde' | 'noite'
  ): Promise<RecommendedSlot[]> {
    try {
      // 1. Obter disponibilidade real (prioridade 1)
      const availableSlots = await this.getAvailableSlots(date, period);
      
      // 2. Obter preferências do usuário (prioridade 2)
      const userPreferences = await this.getUserPreferences(phoneNumber);
      
      // 3. Obter popularidade geral (prioridade 3)
      const popularityScores = await this.getPopularityScores(period);
      
      // 4. Calcular pontuações e ordenar
      const recommendedSlots = this.calculateRecommendationScores(
        availableSlots,
        userPreferences,
        popularityScores
      );
      
      // Retornar no máximo 3 slots
      return recommendedSlots.slice(0, 3);
      
    } catch (error) {
      logger.error('Erro ao recomendar slots:', error);
      
      // Fallback: retornar slots básicos disponíveis
      return await this.getBasicAvailableSlots(date, period);
    }
  }
  
  // Obter slots disponíveis via Trinks
  private async getAvailableSlots(date: string, period?: string): Promise<string[]> {
    try {
      const timeWindows = this.getTimeWindowsForPeriod(period);
      const availableSlots: string[] = [];
      
      for (const window of timeWindows) {
        const slots = await this.generateTimeSlots(window.start, window.end, 30); // 30 min intervals
        
        for (const slot of slots) {
          const dateTime = `${date}T${slot}:00`;
          const isAvailable = await this.checkSlotAvailability(dateTime);
          
          if (isAvailable) {
            availableSlots.push(slot);
          }
        }
      }
      
      return availableSlots;
      
    } catch (error) {
      logger.error('Erro ao obter slots disponíveis:', error);
      return [];
    }
  }
  
  // Verificar disponibilidade de um slot específico
  private async checkSlotAvailability(dateTime: string): Promise<boolean> {
    try {
      // Simular verificação via Trinks
      // Na implementação real, você faria uma chamada para a API Trinks
      // TODO: Implementar verificação de disponibilidade quando disponível na API Trinks
      // const disponibilidade = await trinks.Trinks.verificarDisponibilidade({
      //   dataHora: dateTime,
      //   servicoId: 'default'
      // });
      const disponibilidade = { disponivel: true }; // Implementação temporária
      
      return disponibilidade?.disponivel === true;
      
    } catch (error) {
      logger.error('Erro ao verificar disponibilidade:', error);
      return false;
    }
  }
  
  // Obter preferências do usuário
  private async getUserPreferences(phoneNumber: string): Promise<UserPreferences> {
    try {
      // Buscar preferências de horário
      const timePrefsQuery = `
        SELECT time_slot, frequency, last_used
        FROM user_time_preferences
        WHERE phone_number = $1
        ORDER BY frequency DESC, last_used DESC
        LIMIT 10
      `;
      
      const timePrefsResult = await this.db.query(timePrefsQuery, [phoneNumber]);
      
      // Buscar preferências de serviço
      const servicePrefsQuery = `
        SELECT service_name, frequency, last_used
        FROM user_service_preferences
        WHERE phone_number = $1
        ORDER BY frequency DESC, last_used DESC
        LIMIT 5
      `;
      
      const servicePrefsResult = await this.db.query(servicePrefsQuery, [phoneNumber]);
      
      // Buscar profissional preferido
      const professionalQuery = `
        SELECT professional_name, frequency
        FROM user_professional_preferences
        WHERE phone_number = $1
        ORDER BY frequency DESC, last_used DESC
        LIMIT 1
      `;
      
      const professionalResult = await this.db.query(professionalQuery, [phoneNumber]);
      
      return {
        phoneNumber,
        preferredProfessional: professionalResult.rows[0]?.professional_name,
        preferredTimeSlots: timePrefsResult.rows.map(row => ({
          startTime: row.time_slot,
          endTime: this.addMinutes(row.time_slot, 30),
          frequency: row.frequency,
          recency: this.calculateRecencyScore(row.last_used)
        })),
        frequentServices: servicePrefsResult.rows.map(row => ({
          serviceName: row.service_name,
          frequency: row.frequency,
          recency: this.calculateRecencyScore(row.last_used),
          lastBooked: row.last_used
        })),
        lastUpdated: new Date()
      };
      
    } catch (error) {
      logger.error('Erro ao obter preferências do usuário:', error);
      return {
        phoneNumber,
        preferredTimeSlots: [],
        frequentServices: [],
        lastUpdated: new Date()
      };
    }
  }
  
  // Obter pontuações de popularidade geral
  private async getPopularityScores(period?: string): Promise<Map<string, number>> {
    try {
      const query = `
        SELECT 
          EXTRACT(HOUR FROM created_at) as hour,
          COUNT(*) as booking_count
        FROM agendamentos
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY EXTRACT(HOUR FROM created_at)
        ORDER BY booking_count DESC
      `;
      
      const result = await this.db.query(query);
      const popularityMap = new Map<string, number>();
      
      result.rows.forEach(row => {
        const hour = String(row.hour).padStart(2, '0');
        const timeSlot = `${hour}:00`;
        popularityMap.set(timeSlot, row.booking_count);
      });
      
      return popularityMap;
      
    } catch (error) {
      logger.error('Erro ao obter pontuações de popularidade:', error);
      return new Map();
    }
  }
  
  // Calcular pontuações de recomendação
  private calculateRecommendationScores(
    availableSlots: string[],
    userPreferences: UserPreferences,
    popularityScores: Map<string, number>
  ): RecommendedSlot[] {
    const recommendations: RecommendedSlot[] = [];
    
    for (const slot of availableSlots) {
      let score = 100; // Base score para disponibilidade
      let reason: 'availability' | 'user_preference' | 'popularity' = 'availability';
      
      // Bonus por preferência do usuário (prioridade 2)
      const userTimePreference = userPreferences.preferredTimeSlots.find(pref => 
        this.isTimeInRange(slot, pref.startTime, pref.endTime)
      );
      
      if (userTimePreference) {
        const userBonus = (userTimePreference.frequency * 10) + (userTimePreference.recency * 5);
        score += userBonus;
        reason = 'user_preference';
      }
      
      // Bonus por popularidade geral (prioridade 3)
      const popularityScore = popularityScores.get(slot) || 0;
      if (popularityScore > 0) {
        score += popularityScore * 2;
        if (reason === 'availability') {
          reason = 'popularity';
        }
      }
      
      recommendations.push({
        time: slot,
        available: true,
        score,
        reason
      });
    }
    
    // Ordenar por pontuação (maior primeiro)
    return recommendations.sort((a, b) => b.score - a.score);
  }
  
  // Funções auxiliares
  private getTimeWindowsForPeriod(period?: string): { start: string; end: string }[] {
    switch (period) {
      case 'manha':
        return [{ start: '09:00', end: '12:00' }];
      case 'tarde':
        return [{ start: '13:30', end: '17:30' }];
      case 'noite':
        return [{ start: '18:00', end: '20:00' }];
      default:
        return [
          { start: '09:00', end: '12:00' },
          { start: '13:30', end: '17:30' },
          { start: '18:00', end: '20:00' }
        ];
    }
  }
  
  private generateTimeSlots(startTime: string, endTime: string, intervalMinutes: number): string[] {
    const slots: string[] = [];
    const start = this.timeToMinutes(startTime);
    const end = this.timeToMinutes(endTime);
    
    for (let minutes = start; minutes < end; minutes += intervalMinutes) {
      slots.push(this.minutesToTime(minutes));
    }
    
    return slots;
  }
  
  private timeToMinutes(time: string): number {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  }
  
  private minutesToTime(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
  }
  
  private addMinutes(time: string, minutesToAdd: number): string {
    const totalMinutes = this.timeToMinutes(time) + minutesToAdd;
    return this.minutesToTime(totalMinutes);
  }
  
  private isTimeInRange(time: string, startTime: string, endTime: string): boolean {
    const timeMinutes = this.timeToMinutes(time);
    const startMinutes = this.timeToMinutes(startTime);
    const endMinutes = this.timeToMinutes(endTime);
    
    return timeMinutes >= startMinutes && timeMinutes <= endMinutes;
  }
  
  private calculateRecencyScore(lastUsed: Date): number {
    const daysSince = (Date.now() - lastUsed.getTime()) / (1000 * 60 * 60 * 24);
    
    if (daysSince <= 7) return 10;      // Última semana
    if (daysSince <= 30) return 7;      // Último mês
    if (daysSince <= 90) return 4;      // Últimos 3 meses
    return 1;                           // Mais antigo
  }
  
  // Fallback para slots básicos
  private async getBasicAvailableSlots(date: string, period?: string): Promise<RecommendedSlot[]> {
    const timeWindows = this.getTimeWindowsForPeriod(period);
    const basicSlots: RecommendedSlot[] = [];
    
    for (const window of timeWindows) {
      const slots = this.generateTimeSlots(window.start, window.end, 30);
      
      slots.slice(0, 3).forEach(slot => {
        basicSlots.push({
          time: slot,
          available: true,
          score: 50, // Score básico
          reason: 'availability'
        });
      });
    }
    
    return basicSlots.slice(0, 3);
  }
  
  // Obter estatísticas de first-try booking
  async getFirstTryBookingStats(phoneNumber?: string): Promise<{
    totalBookings: number;
    firstTryBookings: number;
    firstTryRate: number;
  }> {
    try {
      let query = `
        SELECT 
          COUNT(*) as total_bookings,
          COUNT(CASE WHEN first_try_booking = true THEN 1 END) as first_try_bookings
        FROM agendamentos
        WHERE created_at >= NOW() - INTERVAL '30 days'
      `;
      
      const params: any[] = [];
      
      if (phoneNumber) {
        query += ' AND phone_number = $1';
        params.push(phoneNumber);
      }
      
      const result = await this.db.query(query, params);
      const row = result.rows[0];
      
      const totalBookings = parseInt(row.total_bookings) || 0;
      const firstTryBookings = parseInt(row.first_try_bookings) || 0;
      const firstTryRate = totalBookings > 0 ? (firstTryBookings / totalBookings) * 100 : 0;
      
      return {
        totalBookings,
        firstTryBookings,
        firstTryRate
      };
      
    } catch (error) {
      logger.error('Erro ao obter estatísticas de first-try booking:', error);
      return {
        totalBookings: 0,
        firstTryBookings: 0,
        firstTryRate: 0
      };
    }
  }
}

// Função de conveniência para criar instância
export function createRecommendationEngine(database: Pool): RecommendationEngine {
  return new RecommendationEngine(database);
}

// Função principal exportada para uso no dialog
export async function recommendSlots(
  tenantId: string,
  phoneNumber: string,
  date: string,
  period?: 'manha' | 'tarde' | 'noite'
): Promise<RecommendedSlot[]> {
  try {
    // TODO: Implementar conexão com banco quando getDatabase estiver disponível
    // const { getDatabase } = await import('../db/index');
    // const db = getDatabase();
    // const engine = new RecommendationEngine(db);
    
    // Implementação temporária sem banco
    logger.warn('RecommendationEngine: Usando implementação temporária sem banco');
    return [];
    
  } catch (error) {
    logger.error('Erro na função recommendSlots:', error);
    return [];
  }
}