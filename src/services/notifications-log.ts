import { pool } from '../infra/db';
import { logger } from '../utils/logger';

/**
 * Tipos de notificação
 */
export type NotificationKind = 'previsit' | 'noshow_yes' | 'noshow_no' | 'rebook' | 'audit';

/**
 * Interface para log de notificação
 */
export interface NotificationLog {
  id: string;
  tenantId: string;
  dedupeKey: string;
  phone: string;
  kind: NotificationKind;
  payload: any;
  sentAt: Date;
  createdAt: Date;
}

/**
 * Interface para estatísticas de notificações
 */
export interface NotificationStats {
  total: number;
  byKind: Record<NotificationKind, number>;
  lastSent: Date | null;
}

/**
 * Serviço para logging e deduplicação de notificações
 */
export class NotificationsLogService {
  private tenantId: string;

  constructor(tenantId: string) {
    this.tenantId = tenantId;
  }

  /**
   * Gera uma chave de deduplicação padronizada
   */
  static generateDedupeKey(
    type: string,
    appointmentId: string,
    additionalData?: string
  ): string {
    const baseKey = `${type}:${appointmentId}`;
    return additionalData ? `${baseKey}:${additionalData}` : baseKey;
  }

  /**
   * Verifica se uma notificação já foi enviada usando a função do banco
   */
  async checkDuplicate(dedupeKey: string): Promise<boolean> {
    try {
      const query = `SELECT notification_exists($1, $2) as exists`;
      const result = await pool.query(query, [this.tenantId, dedupeKey]);
      return result.rows[0]?.exists || false;
    } catch (error) {
      logger.error('Erro ao verificar duplicata', {
        error: error instanceof Error ? error.message : String(error),
        dedupeKey,
        tenantId: this.tenantId
      });
      throw error;
    }
  }

  /**
   * Verifica se uma notificação já foi enviada (deduplicação)
   */
  async hasNotification(dedupeKey: string): Promise<boolean> {
    try {
      const query = `
        SELECT 1 FROM notifications_log 
        WHERE tenant_id = $1 AND dedupe_key = $2
        LIMIT 1
      `;
      
      const result = await pool.query(query, [this.tenantId, dedupeKey]);
      return result.rows.length > 0;
    } catch (error) {
      logger.error('Erro ao verificar notificação existente', {
        error: error instanceof Error ? error.message : String(error),
        dedupeKey,
        tenantId: this.tenantId
      });
      throw error;
    }
  }

  /**
   * Registra uma notificação (idempotente por dedupe_key)
   */
  async logNotification(
    dedupeKey: string,
    phone: string,
    kind: NotificationKind,
    payload: any = {}
  ): Promise<NotificationLog | null> {
    try {
      // Usa a função do banco que implementa deduplicação automática
      const query = `SELECT log_notification($1, $2, $3, $4, $5) as notification_id`;
      const result = await pool.query(query, [
        this.tenantId,
        dedupeKey,
        phone,
        kind,
        JSON.stringify(payload)
      ]);

      const notificationId = result.rows[0]?.notification_id;
      
      if (!notificationId) {
        logger.info('Notificação já enviada (deduplicação)', {
          dedupeKey,
          phone,
          kind,
          tenantId: this.tenantId
        });
        return null;
      }

      // Busca os dados completos da notificação inserida
      const selectQuery = `
        SELECT * FROM notifications_log 
        WHERE id = $1 AND tenant_id = $2
      `;
      const selectResult = await pool.query(selectQuery, [notificationId, this.tenantId]);
      const log = selectResult.rows[0];
      
      logger.info('Notificação registrada', {
        id: log.id,
        dedupeKey,
        phone,
        kind,
        tenantId: this.tenantId
      });

      return {
        id: log.id,
        tenantId: log.tenant_id,
        dedupeKey: log.dedupe_key,
        phone: log.phone,
        kind: log.kind,
        payload: JSON.parse(log.payload),
        sentAt: log.sent_at,
        createdAt: log.created_at
      };
    } catch (error) {
      logger.error('Erro ao registrar notificação', {
        error: error instanceof Error ? error.message : String(error),
        dedupeKey,
        phone,
        kind,
        tenantId: this.tenantId
      });
      throw error;
    }
  }

  /**
   * Registra notificação com dados completos (versão estendida)
   */
  async logNotificationExtended(params: {
    dedupeKey: string;
    phone: string;
    kind: NotificationKind;
    status?: 'scheduled' | 'sent' | 'failed';
    scheduledFor?: string;
    payload?: any;
  }): Promise<NotificationLog | null> {
    const { dedupeKey, phone, kind, status = 'sent', scheduledFor, payload = {} } = params;
    
    const extendedPayload = {
      ...payload,
      status,
      ...(scheduledFor && { scheduledFor })
    };

    return this.logNotification(dedupeKey, phone, kind, extendedPayload);
  }

  /**
   * Obtém estatísticas de deduplicação
   */
  async getDeduplicationStats(days: number = 7): Promise<{
    totalAttempts: number;
    successfulSends: number;
    duplicatesBlocked: number;
    byKind: Record<NotificationKind, {
      attempts: number;
      sends: number;
      duplicates: number;
    }>;
  }> {
    try {
      const query = `
        SELECT 
          kind,
          COUNT(*) as total_attempts,
          COUNT(CASE WHEN sent_at IS NOT NULL THEN 1 END) as successful_sends,
          COUNT(*) - COUNT(CASE WHEN sent_at IS NOT NULL THEN 1 END) as duplicates_blocked
        FROM notifications_log
        WHERE tenant_id = $1 
        AND created_at >= NOW() - INTERVAL '${days} days'
        GROUP BY kind
      `;
      
      const result = await pool.query(query, [this.tenantId]);
      
      let totalAttempts = 0;
      let successfulSends = 0;
      let duplicatesBlocked = 0;
      const byKind: any = {};
      
      result.rows.forEach(row => {
        const attempts = parseInt(row.total_attempts);
        const sends = parseInt(row.successful_sends);
        const duplicates = parseInt(row.duplicates_blocked);
        
        totalAttempts += attempts;
        successfulSends += sends;
        duplicatesBlocked += duplicates;
        
        byKind[row.kind] = {
          attempts,
          sends,
          duplicates
        };
      });
      
      return {
        totalAttempts,
        successfulSends,
        duplicatesBlocked,
        byKind
      };
    } catch (error) {
      logger.error('Erro ao obter estatísticas de deduplicação', {
        error: error instanceof Error ? error.message : String(error),
        days,
        tenantId: this.tenantId
      });
      throw error;
    }
  }

  /**
   * Lista notificações por período
   */
  async getNotifications(
    dateFrom: string,
    dateTo: string,
    kind?: NotificationKind,
    limit: number = 100
  ): Promise<NotificationLog[]> {
    try {
      let query = `
        SELECT * FROM notifications_log 
        WHERE tenant_id = $1 
        AND sent_at >= $2 
        AND sent_at <= $3
      `;
      
      const params: any[] = [this.tenantId, dateFrom, dateTo];
      
      if (kind) {
        query += ` AND kind = $${params.length + 1}`;
        params.push(kind);
      }
      
      query += ` ORDER BY sent_at DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await pool.query(query, params);
      
      return result.rows.map(row => ({
        id: row.id,
        tenantId: row.tenant_id,
        dedupeKey: row.dedupe_key,
        phone: row.phone,
        kind: row.kind,
        payload: JSON.parse(row.payload),
        sentAt: row.sent_at,
        createdAt: row.created_at
      }));
    } catch (error) {
      logger.error('Erro ao buscar notificações', {
        error: error instanceof Error ? error.message : String(error),
        dateFrom,
        dateTo,
        kind,
        tenantId: this.tenantId
      });
      throw error;
    }
  }

  /**
   * Obtém estatísticas de notificações para uma data
   */
  async getStats(date: string): Promise<NotificationStats> {
    try {
      const query = `
        SELECT 
          kind,
          COUNT(*) as count,
          MAX(sent_at) as last_sent
        FROM notifications_log 
        WHERE tenant_id = $1 
        AND DATE(sent_at) = $2
        GROUP BY kind
      `;

      const result = await pool.query(query, [this.tenantId, date]);
      
      const byKind: Record<NotificationKind, number> = {
        previsit: 0,
        noshow_yes: 0,
        noshow_no: 0,
        rebook: 0,
        audit: 0
      };
      
      let total = 0;
      let lastSent: Date | null = null;
      
      for (const row of result.rows) {
        byKind[row.kind as NotificationKind] = parseInt(row.count);
        total += parseInt(row.count);
        
        if (!lastSent || row.last_sent > lastSent) {
          lastSent = row.last_sent;
        }
      }

      return { total, byKind, lastSent };
    } catch (error) {
      logger.error('Erro ao obter estatísticas', {
        error: error instanceof Error ? error.message : String(error),
        date,
        tenantId: this.tenantId
      });
      throw error;
    }
  }

  /**
   * Remove notificações antigas (limpeza)
   */
  async cleanup(daysToKeep: number = 90): Promise<number> {
    try {
      const query = `
        DELETE FROM notifications_log 
        WHERE tenant_id = $1 
        AND created_at < NOW() - INTERVAL '${daysToKeep} days'
      `;

      const result = await pool.query(query, [this.tenantId]);
      
      logger.info('Limpeza de notificações concluída', {
        deletedCount: result.rowCount,
        daysToKeep,
        tenantId: this.tenantId
      });

      return result.rowCount || 0;
    } catch (error) {
      logger.error('Erro na limpeza de notificações', {
        error: error instanceof Error ? error.message : String(error),
        daysToKeep,
        tenantId: this.tenantId
      });
      throw error;
    }
  }
}

/**
 * Factory function para criar instância do serviço
 */
export function createNotificationsLogService(tenantId: string): NotificationsLogService {
  return new NotificationsLogService(tenantId);
}