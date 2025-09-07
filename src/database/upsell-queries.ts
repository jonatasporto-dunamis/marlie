import { Pool, PoolClient } from 'pg';
import { logger } from '../utils/logger';

/**
 * Queries e funções de banco de dados para o módulo marlie-upsell
 * 
 * Fornece interface tipada para todas as operações de banco relacionadas
 * ao sistema de upsells, incluindo eventos, métricas e agendamentos.
 */

export interface UpsellEvent {
  id: string;
  tenantId: string;
  conversationId: string;
  phone: string;
  event: 'shown' | 'accepted' | 'declined' | 'scheduled' | 'error';
  addonId?: string;
  addonName?: string;
  addonPriceBrl?: number;
  addonDurationMin?: number;
  appointmentId?: string;
  primaryServiceId?: string;
  customerName?: string;
  variantCopy?: 'A' | 'B';
  variantPosition?: 'IMMEDIATE' | 'DELAY10';
  responseText?: string;
  processingTimeMs?: number;
  errorMessage?: string;
  createdAt: Date;
  processedAt?: Date;
}

export interface ScheduledJob {
  id: string;
  tenantId: string;
  conversationId: string;
  phone: string;
  appointmentId: string;
  primaryServiceId: string;
  customerName?: string;
  scheduledFor: Date;
  variantCopy: 'A' | 'B';
  variantPosition: 'IMMEDIATE' | 'DELAY10';
  attempts: number;
  maxAttempts: number;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  createdAt: Date;
  lastAttemptAt?: Date;
  completedAt?: Date;
  errorMessage?: string;
}

export interface ConversationState {
  conversationId: string;
  tenantId: string;
  hasUpsellShown: boolean;
  upsellShownAt?: Date;
  lastEvent?: string;
  lastEventAt?: Date;
  lastAddonId?: string;
  lastVariantCopy?: string;
  lastVariantPosition?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsellMetrics {
  totalShown: number;
  totalAccepted: number;
  totalDeclined: number;
  totalScheduled: number;
  totalErrors: number;
  conversionRate: number;
  totalRevenueBrl: number;
  avgAddonPriceBrl: number;
  avgProcessingTimeMs: number;
}

export interface ConversionReport {
  date: Date;
  variantCopy: string;
  variantPosition: string;
  shownCount: number;
  acceptedCount: number;
  declinedCount: number;
  conversionRatePercent: number;
  totalRevenueBrl: number;
  avgAddonPriceBrl: number;
}

export class UpsellDatabase {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Registra um evento de upsell
   */
  async logEvent(
    tenantId: string,
    event: Omit<UpsellEvent, 'id' | 'tenantId' | 'createdAt'>
  ): Promise<string> {
    const client = await this.pool.connect();
    try {
      const query = `
        INSERT INTO upsell_events (
          tenant_id, conversation_id, phone, event, addon_id, addon_name,
          addon_price_brl, addon_duration_min, appointment_id, primary_service_id,
          customer_name, variant_copy, variant_position, response_text,
          processing_time_ms, error_message, processed_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
        ) RETURNING id
      `;

      const values = [
        tenantId,
        event.conversationId,
        event.phone,
        event.event,
        event.addonId,
        event.addonName,
        event.addonPriceBrl,
        event.addonDurationMin,
        event.appointmentId,
        event.primaryServiceId,
        event.customerName,
        event.variantCopy,
        event.variantPosition,
        event.responseText,
        event.processingTimeMs,
        event.errorMessage,
        event.processedAt
      ];

      const result = await client.query(query, values);
      return result.rows[0].id;

    } catch (error) {
      logger.error('Erro ao registrar evento de upsell:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Verifica se já houve upsell para uma conversa
   */
  async hasUpsellShown(tenantId: string, conversationId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const query = `
        SELECT has_upsell_shown 
        FROM upsell_conversation_state 
        WHERE conversation_id = $1 AND tenant_id = $2
      `;

      const result = await client.query(query, [conversationId, tenantId]);
      return result.rows[0]?.has_upsell_shown || false;

    } catch (error) {
      logger.error('Erro ao verificar estado da conversa:', error);
      return false;
    } finally {
      client.release();
    }
  }

  /**
   * Obtém estado completo da conversa
   */
  async getConversationState(
    tenantId: string, 
    conversationId: string
  ): Promise<ConversationState | null> {
    const client = await this.pool.connect();
    try {
      const query = `
        SELECT 
          conversation_id, tenant_id, has_upsell_shown, upsell_shown_at,
          last_event, last_event_at, last_addon_id, last_variant_copy,
          last_variant_position, created_at, updated_at
        FROM upsell_conversation_state 
        WHERE conversation_id = $1 AND tenant_id = $2
      `;

      const result = await client.query(query, [conversationId, tenantId]);
      
      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        conversationId: row.conversation_id,
        tenantId: row.tenant_id,
        hasUpsellShown: row.has_upsell_shown,
        upsellShownAt: row.upsell_shown_at,
        lastEvent: row.last_event,
        lastEventAt: row.last_event_at,
        lastAddonId: row.last_addon_id,
        lastVariantCopy: row.last_variant_copy,
        lastVariantPosition: row.last_variant_position,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };

    } catch (error) {
      logger.error('Erro ao obter estado da conversa:', error);
      return null;
    } finally {
      client.release();
    }
  }

  /**
   * Salva job agendado
   */
  async saveScheduledJob(job: Omit<ScheduledJob, 'createdAt'>): Promise<void> {
    const client = await this.pool.connect();
    try {
      const query = `
        INSERT INTO upsell_scheduled_jobs (
          id, tenant_id, conversation_id, phone, appointment_id,
          primary_service_id, customer_name, scheduled_for,
          variant_copy, variant_position, attempts, max_attempts, status
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
        )
      `;

      const values = [
        job.id,
        job.tenantId,
        job.conversationId,
        job.phone,
        job.appointmentId,
        job.primaryServiceId,
        job.customerName,
        job.scheduledFor,
        job.variantCopy,
        job.variantPosition,
        job.attempts,
        job.maxAttempts,
        job.status
      ];

      await client.query(query, values);

    } catch (error) {
      logger.error('Erro ao salvar job agendado:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Atualiza job agendado
   */
  async updateScheduledJob(
    jobId: string,
    updates: Partial<Pick<ScheduledJob, 'attempts' | 'status' | 'lastAttemptAt' | 'completedAt' | 'errorMessage' | 'scheduledFor'>>
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      const setParts: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (updates.attempts !== undefined) {
        setParts.push(`attempts = $${paramIndex++}`);
        values.push(updates.attempts);
      }

      if (updates.status !== undefined) {
        setParts.push(`status = $${paramIndex++}`);
        values.push(updates.status);
      }

      if (updates.lastAttemptAt !== undefined) {
        setParts.push(`last_attempt_at = $${paramIndex++}`);
        values.push(updates.lastAttemptAt);
      }

      if (updates.completedAt !== undefined) {
        setParts.push(`completed_at = $${paramIndex++}`);
        values.push(updates.completedAt);
      }

      if (updates.errorMessage !== undefined) {
        setParts.push(`error_message = $${paramIndex++}`);
        values.push(updates.errorMessage);
      }

      if (updates.scheduledFor !== undefined) {
        setParts.push(`scheduled_for = $${paramIndex++}`);
        values.push(updates.scheduledFor);
      }

      if (setParts.length === 0) {
        return;
      }

      const query = `
        UPDATE upsell_scheduled_jobs 
        SET ${setParts.join(', ')}
        WHERE id = $${paramIndex}
      `;

      values.push(jobId);
      await client.query(query, values);

    } catch (error) {
      logger.error('Erro ao atualizar job agendado:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Obtém jobs pendentes para execução
   */
  async getPendingJobs(tenantId: string, limit = 100): Promise<ScheduledJob[]> {
    const client = await this.pool.connect();
    try {
      const query = `
        SELECT 
          id, tenant_id, conversation_id, phone, appointment_id,
          primary_service_id, customer_name, scheduled_for,
          variant_copy, variant_position, attempts, max_attempts,
          status, created_at, last_attempt_at, completed_at, error_message
        FROM upsell_scheduled_jobs 
        WHERE tenant_id = $1 
          AND status = 'pending' 
          AND scheduled_for <= NOW()
        ORDER BY scheduled_for ASC
        LIMIT $2
      `;

      const result = await client.query(query, [tenantId, limit]);
      
      return result.rows.map(row => ({
        id: row.id,
        tenantId: row.tenant_id,
        conversationId: row.conversation_id,
        phone: row.phone,
        appointmentId: row.appointment_id,
        primaryServiceId: row.primary_service_id,
        customerName: row.customer_name,
        scheduledFor: row.scheduled_for,
        variantCopy: row.variant_copy,
        variantPosition: row.variant_position,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        status: row.status,
        createdAt: row.created_at,
        lastAttemptAt: row.last_attempt_at,
        completedAt: row.completed_at,
        errorMessage: row.error_message
      }));

    } catch (error) {
      logger.error('Erro ao obter jobs pendentes:', error);
      return [];
    } finally {
      client.release();
    }
  }

  /**
   * Obtém métricas de upsell por período
   */
  async getMetrics(
    tenantId: string,
    options: {
      period?: string;
      variant?: string;
      dateFrom?: Date;
      dateTo?: Date;
    } = {}
  ): Promise<UpsellMetrics> {
    const client = await this.pool.connect();
    try {
      let whereClause = 'WHERE tenant_id = $1';
      const values: any[] = [tenantId];
      let paramIndex = 2;

      // Filtro por período
      if (options.dateFrom && options.dateTo) {
        whereClause += ` AND created_at BETWEEN $${paramIndex} AND $${paramIndex + 1}`;
        values.push(options.dateFrom, options.dateTo);
        paramIndex += 2;
      } else if (options.period) {
        const days = this.parsePeriodToDays(options.period);
        whereClause += ` AND created_at >= NOW() - INTERVAL '${days} days'`;
      }

      // Filtro por variante
      if (options.variant) {
        const [copy, position] = options.variant.split('_');
        if (copy) {
          whereClause += ` AND variant_copy = $${paramIndex++}`;
          values.push(copy);
        }
        if (position) {
          whereClause += ` AND variant_position = $${paramIndex++}`;
          values.push(position);
        }
      }

      const query = `
        SELECT 
          COUNT(*) FILTER (WHERE event = 'shown') as total_shown,
          COUNT(*) FILTER (WHERE event = 'accepted') as total_accepted,
          COUNT(*) FILTER (WHERE event = 'declined') as total_declined,
          COUNT(*) FILTER (WHERE event = 'scheduled') as total_scheduled,
          COUNT(*) FILTER (WHERE event = 'error') as total_errors,
          COALESCE(
            ROUND(
              (COUNT(*) FILTER (WHERE event = 'accepted')::DECIMAL / 
               NULLIF(COUNT(*) FILTER (WHERE event = 'shown'), 0)) * 100, 2
            ), 0
          ) as conversion_rate,
          COALESCE(SUM(addon_price_brl) FILTER (WHERE event = 'accepted'), 0) as total_revenue_brl,
          COALESCE(AVG(addon_price_brl) FILTER (WHERE event = 'accepted'), 0) as avg_addon_price_brl,
          COALESCE(AVG(processing_time_ms), 0) as avg_processing_time_ms
        FROM upsell_events 
        ${whereClause}
      `;

      const result = await client.query(query, values);
      const row = result.rows[0];

      return {
        totalShown: parseInt(row.total_shown),
        totalAccepted: parseInt(row.total_accepted),
        totalDeclined: parseInt(row.total_declined),
        totalScheduled: parseInt(row.total_scheduled),
        totalErrors: parseInt(row.total_errors),
        conversionRate: parseFloat(row.conversion_rate),
        totalRevenueBrl: parseFloat(row.total_revenue_brl),
        avgAddonPriceBrl: parseFloat(row.avg_addon_price_brl),
        avgProcessingTimeMs: parseFloat(row.avg_processing_time_ms)
      };

    } catch (error) {
      logger.error('Erro ao obter métricas:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Obtém relatório de conversão
   */
  async getConversionReport(
    tenantId: string,
    options: {
      period?: string;
      groupBy?: 'hour' | 'day' | 'week';
      variant?: string;
    } = {}
  ): Promise<ConversionReport[]> {
    const client = await this.pool.connect();
    try {
      const groupBy = options.groupBy || 'day';
      const truncFunction = {
        hour: 'hour',
        day: 'day',
        week: 'week'
      }[groupBy];

      let whereClause = 'WHERE tenant_id = $1';
      const values: any[] = [tenantId];
      let paramIndex = 2;

      if (options.period) {
        const days = this.parsePeriodToDays(options.period);
        whereClause += ` AND created_at >= NOW() - INTERVAL '${days} days'`;
      }

      if (options.variant) {
        const [copy, position] = options.variant.split('_');
        if (copy) {
          whereClause += ` AND variant_copy = $${paramIndex++}`;
          values.push(copy);
        }
        if (position) {
          whereClause += ` AND variant_position = $${paramIndex++}`;
          values.push(position);
        }
      }

      const query = `
        SELECT 
          DATE_TRUNC('${truncFunction}', created_at) as date,
          COALESCE(variant_copy, 'unknown') as variant_copy,
          COALESCE(variant_position, 'unknown') as variant_position,
          COUNT(*) FILTER (WHERE event = 'shown') as shown_count,
          COUNT(*) FILTER (WHERE event = 'accepted') as accepted_count,
          COUNT(*) FILTER (WHERE event = 'declined') as declined_count,
          COALESCE(
            ROUND(
              (COUNT(*) FILTER (WHERE event = 'accepted')::DECIMAL / 
               NULLIF(COUNT(*) FILTER (WHERE event = 'shown'), 0)) * 100, 2
            ), 0
          ) as conversion_rate_percent,
          COALESCE(SUM(addon_price_brl) FILTER (WHERE event = 'accepted'), 0) as total_revenue_brl,
          COALESCE(AVG(addon_price_brl) FILTER (WHERE event = 'accepted'), 0) as avg_addon_price_brl
        FROM upsell_events 
        ${whereClause}
        GROUP BY DATE_TRUNC('${truncFunction}', created_at), variant_copy, variant_position
        ORDER BY date DESC, variant_copy, variant_position
      `;

      const result = await client.query(query, values);
      
      return result.rows.map(row => ({
        date: row.date,
        variantCopy: row.variant_copy,
        variantPosition: row.variant_position,
        shownCount: parseInt(row.shown_count),
        acceptedCount: parseInt(row.accepted_count),
        declinedCount: parseInt(row.declined_count),
        conversionRatePercent: parseFloat(row.conversion_rate_percent),
        totalRevenueBrl: parseFloat(row.total_revenue_brl),
        avgAddonPriceBrl: parseFloat(row.avg_addon_price_brl)
      }));

    } catch (error) {
      logger.error('Erro ao obter relatório de conversão:', error);
      return [];
    } finally {
      client.release();
    }
  }

  /**
   * Obtém eventos com filtros e paginação
   */
  async getEvents(
    tenantId: string,
    options: {
      page?: number;
      limit?: number;
      event?: string;
      variant?: string;
      dateFrom?: Date;
      dateTo?: Date;
      conversationId?: string;
    } = {}
  ): Promise<{ events: UpsellEvent[]; total: number }> {
    const client = await this.pool.connect();
    try {
      const page = options.page || 1;
      const limit = Math.min(options.limit || 50, 100);
      const offset = (page - 1) * limit;

      let whereClause = 'WHERE tenant_id = $1';
      const values: any[] = [tenantId];
      let paramIndex = 2;

      if (options.event) {
        whereClause += ` AND event = $${paramIndex++}`;
        values.push(options.event);
      }

      if (options.variant) {
        const [copy, position] = options.variant.split('_');
        if (copy) {
          whereClause += ` AND variant_copy = $${paramIndex++}`;
          values.push(copy);
        }
        if (position) {
          whereClause += ` AND variant_position = $${paramIndex++}`;
          values.push(position);
        }
      }

      if (options.dateFrom) {
        whereClause += ` AND created_at >= $${paramIndex++}`;
        values.push(options.dateFrom);
      }

      if (options.dateTo) {
        whereClause += ` AND created_at <= $${paramIndex++}`;
        values.push(options.dateTo);
      }

      if (options.conversationId) {
        whereClause += ` AND conversation_id = $${paramIndex++}`;
        values.push(options.conversationId);
      }

      // Query para contar total
      const countQuery = `SELECT COUNT(*) as total FROM upsell_events ${whereClause}`;
      const countResult = await client.query(countQuery, values);
      const total = parseInt(countResult.rows[0].total);

      // Query para obter eventos
      const eventsQuery = `
        SELECT 
          id, tenant_id, conversation_id, phone, event, addon_id, addon_name,
          addon_price_brl, addon_duration_min, appointment_id, primary_service_id,
          customer_name, variant_copy, variant_position, response_text,
          processing_time_ms, error_message, created_at, processed_at
        FROM upsell_events 
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;

      values.push(limit, offset);
      const eventsResult = await client.query(eventsQuery, values);

      const events = eventsResult.rows.map(row => ({
        id: row.id,
        tenantId: row.tenant_id,
        conversationId: row.conversation_id,
        phone: row.phone,
        event: row.event,
        addonId: row.addon_id,
        addonName: row.addon_name,
        addonPriceBrl: row.addon_price_brl,
        addonDurationMin: row.addon_duration_min,
        appointmentId: row.appointment_id,
        primaryServiceId: row.primary_service_id,
        customerName: row.customer_name,
        variantCopy: row.variant_copy,
        variantPosition: row.variant_position,
        responseText: row.response_text,
        processingTimeMs: row.processing_time_ms,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        processedAt: row.processed_at
      }));

      return { events, total };

    } catch (error) {
      logger.error('Erro ao obter eventos:', error);
      return { events: [], total: 0 };
    } finally {
      client.release();
    }
  }

  /**
   * Executa limpeza de dados antigos
   */
  async cleanupOldData(daysToKeep = 90): Promise<number> {
    const client = await this.pool.connect();
    try {
      const result = await client.query('SELECT cleanup_old_upsell_data($1)', [daysToKeep]);
      return result.rows[0].cleanup_old_upsell_data;

    } catch (error) {
      logger.error('Erro ao limpar dados antigos:', error);
      return 0;
    } finally {
      client.release();
    }
  }

  /**
   * Converte período em string para número de dias
   */
  private parsePeriodToDays(period: string): number {
    const match = period.match(/^(\d+)([hdwmy])$/);
    if (!match) {
      return 7; // Default: 7 dias
    }

    const [, num, unit] = match;
    const value = parseInt(num);

    switch (unit) {
      case 'h': return Math.max(1, Math.ceil(value / 24)); // Horas para dias
      case 'd': return value;
      case 'w': return value * 7;
      case 'm': return value * 30;
      case 'y': return value * 365;
      default: return 7;
    }
  }
}

export default UpsellDatabase;