import { Pool } from 'pg';
import { db } from '../db';
import { MessageSchedulerWorker } from '../scheduler/worker';
import logger from '../utils/logger';

export interface SchedulerJobData {
  cliente_nome: string;
  servico_nome: string;
  profissional_nome?: string;
  data_agendamento: string;
  horario: string;
  local?: string;
}

export class MessageScheduler {
  private db: Pool;
  private worker: MessageSchedulerWorker;

  constructor(database?: Pool) {
    this.db = database || db!;
    this.worker = new MessageSchedulerWorker(this.db);
  }

  /**
   * Schedule a pre-visit reminder message
   */
  async schedulePreVisitReminder(
    tenantId: string,
    phone: string,
    bookingId: string,
    agendamentoId: string,
    scheduledFor: Date,
    data: SchedulerJobData
  ): Promise<string | null> {
    try {
      // Check for existing job to prevent duplicates
      const existingJob = await this.db.query(
        'SELECT id FROM message_jobs WHERE tenant_id = $1 AND booking_id = $2 AND kind = $3',
        [tenantId, bookingId, 'pre_visit']
      );

      if (existingJob.rows.length > 0) {
        logger.warn('Pre-visit job already exists for booking', { tenantId, bookingId });
        return null;
      }

      const payload = {
        booking_id: bookingId,
        agendamento_id: agendamentoId,
        service_name: data.servico_nome || '',
        appointment_date: data.data_agendamento || '',
        appointment_time: data.horario || '',
        business_name: 'SyncBelle',
        business_address: data.local || '',
        client_name: data.cliente_nome || '',
        professional_name: data.profissional_nome || ''
      };

      return await MessageSchedulerWorker.scheduleJob(
        this.db,
        tenantId,
        phone,
        'pre_visit',
        scheduledFor,
        payload
      );
    } catch (error) {
      logger.error('Error scheduling pre-visit reminder:', error);
      throw error;
    }
  }

  /**
   * Schedule a no-show check message
   */
  async scheduleNoShowCheck(
    tenantId: string,
    phone: string,
    bookingId: string,
    agendamentoId: string,
    scheduledFor: Date,
    data: Partial<SchedulerJobData>
  ): Promise<string | null> {
    try {
      // Check for existing job to prevent duplicates
      const existingJob = await this.db.query(
        'SELECT id FROM message_jobs WHERE tenant_id = $1 AND booking_id = $2 AND kind = $3',
        [tenantId, bookingId, 'no_show_check']
      );

      if (existingJob.rows.length > 0) {
        logger.warn('No-show check job already exists for booking', { tenantId, bookingId });
        return null;
      }

      const payload = {
        booking_id: bookingId,
        agendamento_id: agendamentoId,
        service_name: data.servico_nome || '',
        appointment_date: data.data_agendamento || '',
        appointment_time: data.horario || '',
        business_name: 'SyncBelle',
        client_name: data.cliente_nome || ''
      };

      return await MessageSchedulerWorker.scheduleJob(
        this.db,
        tenantId,
        phone,
        'no_show_check',
        scheduledFor,
        payload
      );
    } catch (error) {
      logger.error('Error scheduling no-show check:', error);
      throw error;
    }
  }

  /**
   * Process pending jobs and return count of processed jobs
   */
  async processPendingJobs(batchSize?: number): Promise<number> {
    try {
      const limit = batchSize || 50;
      
      // Get pending jobs
      const result = await this.db.query(
        `SELECT * FROM message_jobs 
         WHERE status = 'pending' AND run_at <= NOW() 
         ORDER BY run_at ASC 
         LIMIT $1`,
        [limit]
      );

      const jobs = result.rows;
      let processedCount = 0;

      for (const job of jobs) {
        try {
          await this.processJob(job);
          processedCount++;
        } catch (error) {
          logger.error('Error processing job:', { jobId: job.id, error });
          await this.markJobFailed(job.id, (error as Error).message);
        }
      }

      return processedCount;
    } catch (error) {
      logger.error('Error processing pending jobs:', error);
      throw error;
    }
  }

  /**
   * Process a single job
   */
  private async processJob(job: any): Promise<void> {
    // Check opt-out status
    const optedOut = await this.checkOptOut(job.tenant_id, job.phone_e164, job.kind);
    if (optedOut) {
      await this.markJobSkipped(job.id, 'User opted out');
      return;
    }

    // Send message via Evolution API
    const { evolutionAPI } = require('../integrations/evolution');
    const message = this.formatMessage(job.kind, JSON.parse(job.payload));
    
    try {
      await evolutionAPI.sendMessage(job.phone_e164, message);
      await this.markJobCompleted(job.id);
      
      // Update metrics
      const { MetricsHelper } = require('../metrics');
      if (job.kind === 'pre_visit') {
        MetricsHelper.incrementPreVisitSent(job.tenant_id);
      } else if (job.kind === 'no_show_check') {
        MetricsHelper.incrementNoShowCheckSent(job.tenant_id);
      }
    } catch (error) {
      await this.handleJobError(job, error as Error);
    }
  }

  /**
   * Check if user has opted out
   */
  private async checkOptOut(tenantId: string, phone: string, messageType: string): Promise<boolean> {
    const { OptOutService } = require('./opt-out');
    const optOutService = new OptOutService();
    return await optOutService.isOptedOut(tenantId, phone, messageType);
  }

  /**
   * Format message based on job type
   */
  private formatMessage(kind: string, payload: any): string {
    if (kind === 'pre_visit') {
      return `Olá! Lembramos que você tem um agendamento de ${payload.service_name} amanhã às ${payload.appointment_time}. Confirme sua presença respondendo SIM. Para cancelar, responda CANCELAR.`;
    } else if (kind === 'no_show_check') {
      return `Olá! Seu agendamento de ${payload.service_name} é hoje às ${payload.appointment_time}. Confirme sua presença respondendo SIM.`;
    }
    return 'Mensagem de lembrete';
  }

  /**
   * Mark job as completed
   */
  private async markJobCompleted(jobId: string): Promise<void> {
    await this.db.query(
      'UPDATE message_jobs SET status = $1, executed_at = NOW() WHERE id = $2',
      ['completed', jobId]
    );
  }

  /**
   * Mark job as skipped
   */
  private async markJobSkipped(jobId: string, reason: string): Promise<void> {
    await this.db.query(
      'UPDATE message_jobs SET status = $1, last_error = $2, executed_at = NOW() WHERE id = $3',
      ['skipped', reason, jobId]
    );
  }

  /**
   * Mark job as failed
   */
  private async markJobFailed(jobId: string, errorMessage: string): Promise<void> {
    await this.db.query(
      'UPDATE message_jobs SET status = $1, last_error = $2, attempts = attempts + 1 WHERE id = $3',
      ['failed', errorMessage, jobId]
    );
  }

  /**
   * Handle job error with retry logic
   */
  private async handleJobError(job: any, error: Error): Promise<void> {
    const maxAttempts = 3;
    const newAttempts = job.attempts + 1;

    if (newAttempts >= maxAttempts) {
      await this.db.query(
        'UPDATE message_jobs SET status = $1, last_error = $2, attempts = $3 WHERE id = $4',
        ['permanently_failed', error.message, newAttempts, job.id]
      );
    } else {
      await this.db.query(
        'UPDATE message_jobs SET status = $1, last_error = $2, attempts = $3, retry_count = $4 WHERE id = $5',
        ['failed', error.message, newAttempts, newAttempts, job.id]
      );
    }
  }
}