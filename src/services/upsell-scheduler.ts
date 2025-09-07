import { logger } from '../utils/logger';
import { UpsellService } from './upsell-service';
import cron from 'node-cron';

/**
 * Serviço de agendamento para upsells com delay
 * 
 * Gerencia execuções futuras de upsells, permitindo delays configuráveis
 * e retry automático em caso de falhas.
 */

export interface ScheduledUpsell {
  id: string;
  conversationId: string;
  phone: string;
  appointmentId: string;
  primaryServiceId: string;
  customerName?: string;
  scheduledFor: Date;
  variant: {
    copy: 'A' | 'B';
    position: 'IMMEDIATE' | 'DELAY10';
  };
  attempts: number;
  maxAttempts: number;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  createdAt: Date;
  lastAttemptAt?: Date;
  error?: string;
}

export interface UpsellSchedulerConfig {
  enabled: boolean;
  checkIntervalMinutes: number;
  maxAttempts: number;
  retryDelayMinutes: number;
  cleanupAfterDays: number;
}

export class UpsellScheduler {
  private config: UpsellSchedulerConfig;
  private upsellService: UpsellService;
  private scheduledJobs: Map<string, ScheduledUpsell> = new Map();
  private cronJob?: cron.ScheduledTask;
  private isRunning = false;

  constructor(upsellService: UpsellService, config: UpsellSchedulerConfig) {
    this.upsellService = upsellService;
    this.config = config;
  }

  /**
   * Inicia o scheduler
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('UpsellScheduler já está em execução');
      return;
    }

    if (!this.config.enabled) {
      logger.info('UpsellScheduler está desabilitado');
      return;
    }

    try {
      // Carregar jobs pendentes do banco
      await this.loadPendingJobs();

      // Configurar cron job para verificação periódica
      const cronPattern = `*/${this.config.checkIntervalMinutes} * * * *`;
      this.cronJob = cron.schedule(cronPattern, async () => {
        await this.processScheduledJobs();
      }, {
        scheduled: false
      });

      this.cronJob.start();
      this.isRunning = true;

      logger.info('UpsellScheduler iniciado', {
        checkInterval: this.config.checkIntervalMinutes,
        pendingJobs: this.scheduledJobs.size
      });

    } catch (error) {
      logger.error('Erro ao iniciar UpsellScheduler:', error);
      throw error;
    }
  }

  /**
   * Para o scheduler
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      if (this.cronJob) {
        this.cronJob.stop();
        this.cronJob = undefined;
      }

      // Salvar jobs pendentes no banco
      await this.savePendingJobs();

      this.isRunning = false;
      logger.info('UpsellScheduler parado');

    } catch (error) {
      logger.error('Erro ao parar UpsellScheduler:', error);
    }
  }

  /**
   * Agenda um upsell para execução futura
   */
  async scheduleUpsell(
    conversationId: string,
    phone: string,
    appointmentId: string,
    primaryServiceId: string,
    delayMinutes: number,
    variant: { copy: 'A' | 'B'; position: 'IMMEDIATE' | 'DELAY10' },
    customerName?: string
  ): Promise<string> {
    try {
      const jobId = this.generateJobId(conversationId, appointmentId);
      const scheduledFor = new Date(Date.now() + delayMinutes * 60 * 1000);

      const scheduledUpsell: ScheduledUpsell = {
        id: jobId,
        conversationId,
        phone,
        appointmentId,
        primaryServiceId,
        customerName,
        scheduledFor,
        variant,
        attempts: 0,
        maxAttempts: this.config.maxAttempts,
        status: 'pending',
        createdAt: new Date()
      };

      // Adicionar ao mapa em memória
      this.scheduledJobs.set(jobId, scheduledUpsell);

      // Salvar no banco de dados
      await this.saveScheduledJob(scheduledUpsell);

      logger.info('Upsell agendado', {
        jobId,
        conversationId,
        scheduledFor: scheduledFor.toISOString(),
        delayMinutes,
        variant
      });

      return jobId;

    } catch (error) {
      logger.error('Erro ao agendar upsell:', error);
      throw error;
    }
  }

  /**
   * Cancela um upsell agendado
   */
  async cancelScheduledUpsell(jobId: string): Promise<boolean> {
    try {
      const job = this.scheduledJobs.get(jobId);
      if (!job) {
        logger.warn('Job não encontrado para cancelamento', { jobId });
        return false;
      }

      if (job.status === 'processing') {
        logger.warn('Não é possível cancelar job em processamento', { jobId });
        return false;
      }

      job.status = 'cancelled';
      this.scheduledJobs.set(jobId, job);

      // Atualizar no banco
      await this.updateScheduledJob(job);

      logger.info('Upsell cancelado', { jobId });
      return true;

    } catch (error) {
      logger.error('Erro ao cancelar upsell agendado:', error);
      return false;
    }
  }

  /**
   * Processa jobs agendados que estão prontos para execução
   */
  private async processScheduledJobs(): Promise<void> {
    try {
      const now = new Date();
      const readyJobs = Array.from(this.scheduledJobs.values())
        .filter(job => 
          job.status === 'pending' && 
          job.scheduledFor <= now
        );

      if (readyJobs.length === 0) {
        return;
      }

      logger.debug('Processando jobs agendados', { count: readyJobs.length });

      for (const job of readyJobs) {
        await this.executeScheduledJob(job);
      }

      // Limpar jobs antigos
      await this.cleanupOldJobs();

    } catch (error) {
      logger.error('Erro ao processar jobs agendados:', error);
    }
  }

  /**
   * Executa um job agendado
   */
  private async executeScheduledJob(job: ScheduledUpsell): Promise<void> {
    try {
      // Marcar como processando
      job.status = 'processing';
      job.attempts++;
      job.lastAttemptAt = new Date();
      this.scheduledJobs.set(job.id, job);

      logger.info('Executando upsell agendado', {
        jobId: job.id,
        conversationId: job.conversationId,
        attempt: job.attempts
      });

      // Executar o upsell
      const context = {
        conversationId: job.conversationId,
        phone: job.phone,
        appointmentId: job.appointmentId,
        primaryServiceId: job.primaryServiceId,
        customerName: job.customerName
      };

      await this.upsellService.processBookingConfirmation(context, job.variant);

      // Marcar como concluído
      job.status = 'completed';
      job.error = undefined;
      this.scheduledJobs.set(job.id, job);

      await this.updateScheduledJob(job);

      logger.info('Upsell agendado executado com sucesso', {
        jobId: job.id,
        conversationId: job.conversationId
      });

    } catch (error) {
      logger.error('Erro ao executar upsell agendado:', error);

      job.error = error instanceof Error ? error.message : String(error);

      // Verificar se deve tentar novamente
      if (job.attempts < job.maxAttempts) {
        // Reagendar para retry
        job.status = 'pending';
        job.scheduledFor = new Date(Date.now() + this.config.retryDelayMinutes * 60 * 1000);
        
        logger.info('Reagendando upsell para retry', {
          jobId: job.id,
          attempt: job.attempts,
          nextAttempt: job.scheduledFor.toISOString()
        });
      } else {
        // Marcar como falhou
        job.status = 'failed';
        
        logger.error('Upsell agendado falhou após todas as tentativas', {
          jobId: job.id,
          attempts: job.attempts,
          error: job.error
        });
      }

      this.scheduledJobs.set(job.id, job);
      await this.updateScheduledJob(job);
    }
  }

  /**
   * Limpa jobs antigos do sistema
   */
  private async cleanupOldJobs(): Promise<void> {
    try {
      const cutoffDate = new Date(Date.now() - this.config.cleanupAfterDays * 24 * 60 * 60 * 1000);
      
      const jobsToRemove = Array.from(this.scheduledJobs.values())
        .filter(job => 
          (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') &&
          job.createdAt < cutoffDate
        );

      if (jobsToRemove.length === 0) {
        return;
      }

      for (const job of jobsToRemove) {
        this.scheduledJobs.delete(job.id);
      }

      // Remover do banco
      await this.deleteOldJobs(cutoffDate);

      logger.info('Jobs antigos removidos', { count: jobsToRemove.length });

    } catch (error) {
      logger.error('Erro ao limpar jobs antigos:', error);
    }
  }

  /**
   * Gera ID único para o job
   */
  private generateJobId(conversationId: string, appointmentId: string): string {
    const timestamp = Date.now();
    const hash = Buffer.from(`${conversationId}-${appointmentId}-${timestamp}`)
      .toString('base64')
      .replace(/[^a-zA-Z0-9]/g, '')
      .substring(0, 16);
    
    return `upsell_${hash}_${timestamp}`;
  }

  /**
   * Obtém estatísticas do scheduler
   */
  getStats(): {
    isRunning: boolean;
    totalJobs: number;
    pendingJobs: number;
    processingJobs: number;
    completedJobs: number;
    failedJobs: number;
    cancelledJobs: number;
  } {
    const jobs = Array.from(this.scheduledJobs.values());
    
    return {
      isRunning: this.isRunning,
      totalJobs: jobs.length,
      pendingJobs: jobs.filter(j => j.status === 'pending').length,
      processingJobs: jobs.filter(j => j.status === 'processing').length,
      completedJobs: jobs.filter(j => j.status === 'completed').length,
      failedJobs: jobs.filter(j => j.status === 'failed').length,
      cancelledJobs: jobs.filter(j => j.status === 'cancelled').length
    };
  }

  // Métodos de persistência (implementação específica do banco)
  
  private async loadPendingJobs(): Promise<void> {
    // TODO: Implementar carregamento do banco
    // const jobs = await db.query('SELECT * FROM upsell_scheduled_jobs WHERE status IN ($1, $2)', ['pending', 'processing']);
    // for (const job of jobs) {
    //   this.scheduledJobs.set(job.id, job);
    // }
    logger.debug('Carregando jobs pendentes do banco (não implementado)');
  }

  private async savePendingJobs(): Promise<void> {
    // TODO: Implementar salvamento no banco
    logger.debug('Salvando jobs pendentes no banco (não implementado)');
  }

  private async saveScheduledJob(job: ScheduledUpsell): Promise<void> {
    // TODO: Implementar salvamento no banco
    // await db.query(`
    //   INSERT INTO upsell_scheduled_jobs (
    //     id, conversation_id, phone, appointment_id, primary_service_id,
    //     customer_name, scheduled_for, variant_copy, variant_position,
    //     attempts, max_attempts, status, created_at
    //   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    // `, [job.id, job.conversationId, job.phone, job.appointmentId, job.primaryServiceId,
    //     job.customerName, job.scheduledFor, job.variant.copy, job.variant.position,
    //     job.attempts, job.maxAttempts, job.status, job.createdAt]);
    logger.debug('Salvando job agendado no banco', { jobId: job.id });
  }

  private async updateScheduledJob(job: ScheduledUpsell): Promise<void> {
    // TODO: Implementar atualização no banco
    // await db.query(`
    //   UPDATE upsell_scheduled_jobs SET
    //     attempts = $2, status = $3, last_attempt_at = $4, error = $5
    //   WHERE id = $1
    // `, [job.id, job.attempts, job.status, job.lastAttemptAt, job.error]);
    logger.debug('Atualizando job agendado no banco', { jobId: job.id, status: job.status });
  }

  private async deleteOldJobs(cutoffDate: Date): Promise<void> {
    // TODO: Implementar remoção do banco
    // await db.query(`
    //   DELETE FROM upsell_scheduled_jobs 
    //   WHERE status IN ('completed', 'failed', 'cancelled') 
    //   AND created_at < $1
    // `, [cutoffDate]);
    logger.debug('Removendo jobs antigos do banco', { cutoffDate: cutoffDate.toISOString() });
  }
}

/**
 * Configuração padrão do scheduler
 */
export const defaultSchedulerConfig: UpsellSchedulerConfig = {
  enabled: true,
  checkIntervalMinutes: 1, // Verificar a cada minuto
  maxAttempts: 3,
  retryDelayMinutes: 5,
  cleanupAfterDays: 7
};

export default UpsellScheduler;