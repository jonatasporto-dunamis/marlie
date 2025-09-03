import { Pool } from 'pg';
import { logger } from '../logger';
import { evolutionApi } from '../integrations/evolution';
import { MetricsHelper } from '../metrics';
import { DateTime } from 'luxon';
import { OptOutService } from '../services/opt-out';

interface MessageJob {
  id: string;
  tenant_id: string;
  phone_e164: string;
  kind: 'pre_visit' | 'no_show_check';
  run_at: Date;
  payload: any;
  status: 'pending' | 'sent' | 'failed' | 'canceled';
  attempts: number;
  last_error?: string;
}

interface JobPayload {
  booking_id: string;
  service_name: string;
  appointment_date: string;
  appointment_time: string;
  business_name: string;
  business_address?: string;
  business_phone?: string;
  [key: string]: any;
}

export class MessageSchedulerWorker {
  private db: Pool;
  private isRunning = false;
  private intervalId?: NodeJS.Timeout;
  private readonly POLL_INTERVAL_MS = 30000; // 30 seconds
  private readonly MAX_ATTEMPTS = 3;
  private readonly BACKOFF_BASE_MS = 5000; // 5 seconds
  private readonly TIMEZONE = 'America/Bahia';

  constructor(db: Pool) {
    this.db = db;
  }

  /**
   * Start the worker to process scheduled message jobs
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('MessageSchedulerWorker is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting MessageSchedulerWorker');
    
    // Process jobs immediately, then on interval
    this.processJobs();
    this.intervalId = setInterval(() => {
      this.processJobs();
    }, this.POLL_INTERVAL_MS);
  }

  /**
   * Stop the worker
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    logger.info('MessageSchedulerWorker stopped');
  }

  /**
   * Process all pending jobs that are due for execution
   */
  private async processJobs(): Promise<void> {
    try {
      const jobs = await this.getPendingJobs();
      
      if (jobs.length === 0) {
        return;
      }

      logger.info(`Processing ${jobs.length} pending message jobs`);
      
      for (const job of jobs) {
        await this.processJob(job);
      }
    } catch (error) {
      logger.error('Error processing message jobs:', error);
    }
  }

  /**
   * Get all pending jobs that are due for execution
   */
  private async getPendingJobs(): Promise<MessageJob[]> {
    const query = `
      SELECT id, tenant_id, phone_e164, kind, run_at, payload, status, attempts, last_error
      FROM message_jobs 
      WHERE status = 'pending' 
        AND run_at <= NOW()
        AND attempts < $1
      ORDER BY run_at ASC
      LIMIT 100
    `;
    
    const result = await this.db.query(query, [this.MAX_ATTEMPTS]);
    return result.rows;
  }

  /**
   * Process a single message job
   */
  private async processJob(job: MessageJob): Promise<void> {
    try {
      // Check if user has opted out
      const isOptedOut = await this.checkOptOut(job.tenant_id, job.phone_e164, job.kind);
      if (isOptedOut) {
        await this.markJobCanceled(job.id, 'User opted out of automated messages');
        return;
      }

      // Send the message
      const message = this.formatMessage(job.kind, job.payload);
      await evolutionApi.sendMessage(job.tenant_id, job.phone_e164, message);
      
      // Mark job as sent
      await this.markJobSent(job.id);
      
      // Update metrics
      this.updateMetrics(job.kind, 'sent');
      
      logger.info(`Message job ${job.id} sent successfully`, {
        tenant_id: job.tenant_id,
        phone: this.maskPhone(job.phone_e164),
        kind: job.kind
      });
      
    } catch (error) {
      await this.handleJobError(job, error as Error);
    }
  }

  /**
   * Check if user has opted out of this type of message
   */
  private async checkOptOut(tenantId: string, phone: string, messageType: string): Promise<boolean> {
    try {
      const optOutService = new OptOutService(this.db, evolutionApi);
      return await optOutService.isUserOptedOut(tenantId, phone, messageType as 'pre_visit' | 'no_show_check');
    } catch (error) {
      logger.error('Failed to check user opt-out status', {
        error,
        phone: this.maskPhone(phone),
        tenantId,
        messageType
      });
      return false; // Default to not opted out on error
    }
  }

  /**
   * Format message content based on job type and payload
   */
  private formatMessage(kind: string, payload: JobPayload): string {
    const { service_name, appointment_date, appointment_time, business_name, business_address } = payload;
    
    if (kind === 'pre_visit') {
      return this.formatPreVisitMessage({
        service_name,
        appointment_date,
        appointment_time,
        business_name,
        business_address
      });
    } else if (kind === 'no_show_check') {
      return this.formatNoShowCheckMessage({
        service_name,
        appointment_date,
        appointment_time,
        business_name
      });
    }
    
    throw new Error(`Unknown message kind: ${kind}`);
  }

  /**
   * Format pre-visit reminder message
   */
  private formatPreVisitMessage(data: Partial<JobPayload>): string {
    const { service_name, appointment_date, appointment_time, business_name, business_address } = data;
    
    let message = `🗓️ *Lembrete do seu agendamento*\n\n`;
    message += `📅 *Data:* ${appointment_date}\n`;
    message += `⏰ *Horário:* ${appointment_time}\n`;
    message += `💅 *Serviço:* ${service_name}\n`;
    message += `🏪 *Local:* ${business_name}\n`;
    
    if (business_address) {
      message += `📍 *Endereço:* ${business_address}\n`;
    }
    
    message += `\n✨ *Dicas importantes:*\n`;
    message += `• Chegue 10 minutos antes\n`;
    message += `• Traga um documento com foto\n`;
    message += `• Em caso de imprevisto, avise com antecedência\n\n`;
    message += `Estamos ansiosos para atendê-la! 💖\n\n`;
    message += `_Para não receber mais lembretes, responda PARAR_`;
    
    return message;
  }

  /**
   * Format no-show check message
   */
  private formatNoShowCheckMessage(data: Partial<JobPayload>): string {
    const { service_name, appointment_date, appointment_time, business_name } = data;
    
    let message = `⏰ *Confirmação de presença*\n\n`;
    message += `Olá! Seu agendamento é amanhã:\n\n`;
    message += `📅 *Data:* ${appointment_date}\n`;
    message += `⏰ *Horário:* ${appointment_time}\n`;
    message += `💅 *Serviço:* ${service_name}\n`;
    message += `🏪 *Local:* ${business_name}\n\n`;
    message += `*Você confirma sua presença?*\n\n`;
    message += `✅ Responda *SIM* para confirmar\n`;
    message += `❌ Responda *NÃO* se precisar remarcar\n\n`;
    message += `_Para não receber mais lembretes, responda PARAR_`;
    
    return message;
  }

  /**
   * Handle job execution error with retry logic
   */
  private async handleJobError(job: MessageJob, error: Error): Promise<void> {
    const newAttempts = job.attempts + 1;
    
    if (newAttempts >= this.MAX_ATTEMPTS) {
      // Max attempts reached, mark as failed
      await this.markJobFailed(job.id, error.message);
      this.updateMetrics(job.kind, 'failed');
      
      logger.error(`Message job ${job.id} failed permanently after ${newAttempts} attempts`, {
        tenant_id: job.tenant_id,
        phone: this.maskPhone(job.phone_e164),
        kind: job.kind,
        error: error.message
      });
    } else {
      // Schedule retry with exponential backoff
      const backoffMs = this.BACKOFF_BASE_MS * Math.pow(2, newAttempts - 1);
      const nextRunAt = new Date(Date.now() + backoffMs);
      
      await this.scheduleRetry(job.id, newAttempts, nextRunAt, error.message);
      
      logger.warn(`Message job ${job.id} failed, scheduling retry ${newAttempts}/${this.MAX_ATTEMPTS}`, {
        tenant_id: job.tenant_id,
        phone: this.maskPhone(job.phone_e164),
        kind: job.kind,
        next_run_at: nextRunAt.toISOString(),
        error: error.message
      });
    }
  }

  /**
   * Mark job as sent successfully
   */
  private async markJobSent(jobId: string): Promise<void> {
    const query = `
      UPDATE message_jobs 
      SET status = 'sent', attempts = attempts + 1, updated_at = NOW()
      WHERE id = $1
    `;
    await this.db.query(query, [jobId]);
  }

  /**
   * Mark job as failed permanently
   */
  private async markJobFailed(jobId: string, errorMessage: string): Promise<void> {
    const query = `
      UPDATE message_jobs 
      SET status = 'failed', attempts = attempts + 1, last_error = $2, updated_at = NOW()
      WHERE id = $1
    `;
    await this.db.query(query, [jobId, errorMessage]);
  }

  /**
   * Mark job as canceled (e.g., user opted out)
   */
  private async markJobCanceled(jobId: string, reason: string): Promise<void> {
    const query = `
      UPDATE message_jobs 
      SET status = 'canceled', last_error = $2, updated_at = NOW()
      WHERE id = $1
    `;
    await this.db.query(query, [jobId, reason]);
  }

  /**
   * Schedule job retry with backoff
   */
  private async scheduleRetry(jobId: string, attempts: number, nextRunAt: Date, errorMessage: string): Promise<void> {
    const query = `
      UPDATE message_jobs 
      SET attempts = $2, run_at = $3, last_error = $4, updated_at = NOW()
      WHERE id = $1
    `;
    await this.db.query(query, [jobId, attempts, nextRunAt, errorMessage]);
  }

  /**
   * Update metrics based on job execution result
   */
  private updateMetrics(kind: string, result: 'sent' | 'failed'): void {
    if (kind === 'pre_visit' && result === 'sent') {
      MetricsHelper.incrementPreVisitSent('default'); // TODO: Get actual tenant_id
    } else if (kind === 'no_show_check' && result === 'sent') {
      MetricsHelper.incrementNoShowCheckSent('default'); // TODO: Get actual tenant_id
    }
    // Add more specific metrics as needed
  }

  /**
   * Mask phone number for logging (privacy)
   */
  private maskPhone(phone: string): string {
    if (phone.length <= 6) return phone;
    const start = phone.substring(0, 3);
    const end = phone.substring(phone.length - 3);
    const middle = '*'.repeat(phone.length - 6);
    return `${start}${middle}${end}`;
  }

  /**
   * Schedule a new message job
   */
  static async scheduleJob(
    db: Pool,
    tenantId: string,
    phone: string,
    kind: 'pre_visit' | 'no_show_check',
    runAt: Date,
    payload: JobPayload
  ): Promise<string> {
    const query = `
      INSERT INTO message_jobs (tenant_id, phone_e164, kind, run_at, payload)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `;
    
    const result = await db.query(query, [
      tenantId,
      phone,
      kind,
      runAt,
      JSON.stringify(payload)
    ]);
    
    return result.rows[0].id;
  }

  /**
   * Calculate pre-visit reminder time (24-40h before appointment)
   */
  static calculatePreVisitTime(appointmentDate: Date): Date {
    // Schedule 32 hours before (middle of 24-40h window)
    return DateTime.fromJSDate(appointmentDate)
      .setZone('America/Bahia')
      .minus({ hours: 32 })
      .toJSDate();
  }

  /**
   * Calculate no-show check time (D-1 at 18:00 Bahia time)
   */
  static calculateNoShowCheckTime(appointmentDate: Date): Date {
    return DateTime.fromJSDate(appointmentDate)
      .setZone('America/Bahia')
      .minus({ days: 1 })
      .set({ hour: 18, minute: 0, second: 0, millisecond: 0 })
      .toJSDate();
  }
}

// Export singleton instance
export const messageSchedulerWorker = new MessageSchedulerWorker(
  // Will be injected with actual DB pool in main app
  {} as Pool
);