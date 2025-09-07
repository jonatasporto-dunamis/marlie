import { pool } from '../config/database';
import { logger } from '../utils/logger';
import { TrinksApiService } from './trinks-api';
import { NotificationsLogService } from './notifications-log';

export interface AuditDivergence {
  id: string;
  tenantId: string;
  auditDate: string;
  appointmentId: string;
  patientPhone: string;
  appointmentStart: string;
  professionalName: string;
  serviceName: string;
  divergenceType: 'missing_notification' | 'extra_notification' | 'wrong_timing';
  expectedNotification: string;
  actualNotification?: string;
  severity: 'low' | 'medium' | 'high';
  resolved: boolean;
  createdAt: Date;
}

export interface AuditStats {
  totalAppointments: number;
  totalNotifications: number;
  divergences: number;
  divergenceRate: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
}

/**
 * Serviço de auditoria para detectar divergências entre agenda real e notificações
 */
export class AuditService {
  private tenantId: string;
  private trinksApi: TrinksApiService;
  private notificationsLog: NotificationsLogService;

  constructor(tenantId: string, trinksApi: TrinksApiService) {
    this.tenantId = tenantId;
    this.trinksApi = trinksApi;
    this.notificationsLog = new NotificationsLogService(tenantId);
  }

  /**
   * Executa auditoria completa para uma data específica
   */
  async runDailyAudit(auditDate: string): Promise<{
    divergences: AuditDivergence[];
    stats: AuditStats;
  }> {
    try {
      logger.info('Iniciando auditoria diária', {
        tenantId: this.tenantId,
        auditDate
      });

      // 1. Buscar todos os agendamentos do dia na API Trinks
      const appointments = await this.trinksApi.getAppointmentsByDate(auditDate);
      
      // 2. Buscar todas as notificações enviadas para o dia
      const notifications = await this.getNotificationsByDate(auditDate);
      
      // 3. Detectar divergências
      const divergences = await this.detectDivergences(appointments, notifications, auditDate);
      
      // 4. Salvar divergências no banco
      for (const divergence of divergences) {
        await this.saveDivergence(divergence);
      }
      
      // 5. Calcular estatísticas
      const stats = this.calculateStats(appointments, notifications, divergences);
      
      logger.info('Auditoria concluída', {
        tenantId: this.tenantId,
        auditDate,
        totalDivergences: divergences.length,
        divergenceRate: stats.divergenceRate
      });
      
      return { divergences, stats };
    } catch (error) {
      logger.error('Erro na auditoria diária', {
        error: error instanceof Error ? error.message : String(error),
        tenantId: this.tenantId,
        auditDate
      });
      throw error;
    }
  }

  /**
   * Detecta divergências entre agendamentos e notificações
   */
  private async detectDivergences(
    appointments: any[],
    notifications: any[],
    auditDate: string
  ): Promise<AuditDivergence[]> {
    const divergences: AuditDivergence[] = [];
    
    // Criar mapa de notificações por appointment_id
    const notificationMap = new Map();
    notifications.forEach(notif => {
      const appointmentId = this.extractAppointmentIdFromPayload(notif.payload);
      if (appointmentId) {
        if (!notificationMap.has(appointmentId)) {
          notificationMap.set(appointmentId, []);
        }
        notificationMap.get(appointmentId).push(notif);
      }
    });
    
    // Verificar cada agendamento
    for (const appointment of appointments) {
      const appointmentNotifications = notificationMap.get(appointment.id) || [];
      
      // Verificar se deveria ter pré-visita
      const shouldHavePrevisit = this.shouldHavePrevisitNotification(appointment);
      const hasPrevisit = appointmentNotifications.some(n => n.kind === 'previsit');
      
      if (shouldHavePrevisit && !hasPrevisit) {
        divergences.push({
          id: `missing_previsit_${appointment.id}`,
          tenantId: this.tenantId,
          auditDate,
          appointmentId: appointment.id,
          patientPhone: appointment.patient_phone,
          appointmentStart: appointment.start_datetime,
          professionalName: appointment.professional_name,
          serviceName: appointment.service_name,
          divergenceType: 'missing_notification',
          expectedNotification: 'previsit',
          severity: 'high',
          resolved: false,
          createdAt: new Date()
        });
      }
      
      // Verificar timing das notificações
      for (const notification of appointmentNotifications) {
        const timingIssue = this.checkNotificationTiming(appointment, notification);
        if (timingIssue) {
          divergences.push({
            id: `wrong_timing_${notification.id}`,
            tenantId: this.tenantId,
            auditDate,
            appointmentId: appointment.id,
            patientPhone: appointment.patient_phone,
            appointmentStart: appointment.start_datetime,
            professionalName: appointment.professional_name,
            serviceName: appointment.service_name,
            divergenceType: 'wrong_timing',
            expectedNotification: notification.kind,
            actualNotification: notification.kind,
            severity: timingIssue.severity,
            resolved: false,
            createdAt: new Date()
          });
        }
      }
    }
    
    // Verificar notificações órfãs (sem agendamento correspondente)
    const appointmentIds = new Set(appointments.map(a => a.id));
    for (const notification of notifications) {
      const appointmentId = this.extractAppointmentIdFromPayload(notification.payload);
      if (appointmentId && !appointmentIds.has(appointmentId)) {
        divergences.push({
          id: `extra_notification_${notification.id}`,
          tenantId: this.tenantId,
          auditDate,
          appointmentId: appointmentId,
          patientPhone: notification.phone,
          appointmentStart: 'unknown',
          professionalName: 'unknown',
          serviceName: 'unknown',
          divergenceType: 'extra_notification',
          expectedNotification: 'none',
          actualNotification: notification.kind,
          severity: 'medium',
          resolved: false,
          createdAt: new Date()
        });
      }
    }
    
    return divergences;
  }

  /**
   * Verifica se um agendamento deveria ter notificação de pré-visita
   */
  private shouldHavePrevisitNotification(appointment: any): boolean {
    const appointmentDate = new Date(appointment.start_datetime);
    const now = new Date();
    
    // Só deve ter pré-visita se o agendamento é no futuro
    return appointmentDate > now;
  }

  /**
   * Verifica timing de uma notificação
   */
  private checkNotificationTiming(appointment: any, notification: any): {
    severity: 'low' | 'medium' | 'high';
    issue: string;
  } | null {
    const appointmentDate = new Date(appointment.start_datetime);
    const notificationDate = new Date(notification.sent_at);
    const hoursDiff = (appointmentDate.getTime() - notificationDate.getTime()) / (1000 * 60 * 60);
    
    if (notification.kind === 'previsit') {
      // Pré-visita deve ser enviada entre 12-36 horas antes
      if (hoursDiff < 12) {
        return {
          severity: 'high',
          issue: 'Pré-visita enviada muito próxima do agendamento'
        };
      }
      if (hoursDiff > 36) {
        return {
          severity: 'medium',
          issue: 'Pré-visita enviada muito cedo'
        };
      }
    }
    
    return null;
  }

  /**
   * Extrai appointment_id do payload da notificação
   */
  private extractAppointmentIdFromPayload(payload: any): string | null {
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        return null;
      }
    }
    
    return payload?.appointment_id || payload?.appointmentId || null;
  }

  /**
   * Busca notificações por data
   */
  private async getNotificationsByDate(date: string): Promise<any[]> {
    const query = `
      SELECT * FROM notifications_log
      WHERE tenant_id = $1
      AND DATE(sent_at) = $2
      ORDER BY sent_at
    `;
    
    const result = await pool.query(query, [this.tenantId, date]);
    return result.rows;
  }

  /**
   * Salva divergência no banco
   */
  private async saveDivergence(divergence: AuditDivergence): Promise<void> {
    const query = `
      INSERT INTO audit_divergences (
        id, tenant_id, audit_date, appointment_id, patient_phone,
        appointment_start, professional_name, service_name,
        divergence_type, expected_notification, actual_notification,
        severity, resolved, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
      )
      ON CONFLICT (id) DO NOTHING
    `;
    
    await pool.query(query, [
      divergence.id,
      divergence.tenantId,
      divergence.auditDate,
      divergence.appointmentId,
      divergence.patientPhone,
      divergence.appointmentStart,
      divergence.professionalName,
      divergence.serviceName,
      divergence.divergenceType,
      divergence.expectedNotification,
      divergence.actualNotification,
      divergence.severity,
      divergence.resolved,
      divergence.createdAt
    ]);
  }

  /**
   * Calcula estatísticas da auditoria
   */
  private calculateStats(
    appointments: any[],
    notifications: any[],
    divergences: AuditDivergence[]
  ): AuditStats {
    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    
    divergences.forEach(div => {
      byType[div.divergenceType] = (byType[div.divergenceType] || 0) + 1;
      bySeverity[div.severity] = (bySeverity[div.severity] || 0) + 1;
    });
    
    return {
      totalAppointments: appointments.length,
      totalNotifications: notifications.length,
      divergences: divergences.length,
      divergenceRate: appointments.length > 0 ? divergences.length / appointments.length : 0,
      byType,
      bySeverity
    };
  }

  /**
   * Obtém divergências por período
   */
  async getDivergences(
    startDate: string,
    endDate: string,
    resolved?: boolean
  ): Promise<AuditDivergence[]> {
    let query = `
      SELECT * FROM audit_divergences
      WHERE tenant_id = $1
      AND audit_date BETWEEN $2 AND $3
    `;
    
    const params = [this.tenantId, startDate, endDate];
    
    if (resolved !== undefined) {
      query += ` AND resolved = $${params.length + 1}`;
      params.push(resolved);
    }
    
    query += ` ORDER BY created_at DESC`;
    
    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Marca divergência como resolvida
   */
  async resolveDivergence(divergenceId: string): Promise<void> {
    const query = `
      UPDATE audit_divergences
      SET resolved = true, resolved_at = NOW()
      WHERE id = $1 AND tenant_id = $2
    `;
    
    await pool.query(query, [divergenceId, this.tenantId]);
  }
}

/**
 * Factory function para criar instância do AuditService
 */
export function createAuditService(
  tenantId: string,
  trinksApi: TrinksApiService
): AuditService {
  return new AuditService(tenantId, trinksApi);
}