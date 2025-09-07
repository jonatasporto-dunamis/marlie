import cron from 'node-cron';
import { logger } from '../utils/logger';
import { CatalogSyncService } from './catalog-sync';
import { db } from '../db';

/**
 * Interface para configuração do scheduler
 */
export interface SchedulerConfig {
  syncCron: string;
  snapshotCron: string;
  cleanupCron: string;
  enabled: boolean;
  backfillOnBoot: boolean;
}

/**
 * Serviço de agendamento para sincronização do catálogo
 */
export class CatalogScheduler {
  private catalogSync: CatalogSyncService;
  private config: SchedulerConfig;
  private syncTask?: cron.ScheduledTask;
  private snapshotTask?: cron.ScheduledTask;
  private cleanupTask?: cron.ScheduledTask;
  private isRunning: boolean = false;

  constructor(config?: Partial<SchedulerConfig>) {
    this.catalogSync = new CatalogSyncService();
    this.config = {
      syncCron: config?.syncCron || process.env.CATALOG_SYNC_CRON || '15 */1 * * *', // A cada 1h no minuto 15
      snapshotCron: config?.snapshotCron || process.env.CATALOG_SNAPSHOT_CRON || '0 2 * * *', // Diariamente às 2h
      cleanupCron: config?.cleanupCron || process.env.CATALOG_CLEANUP_CRON || '0 3 * * 0', // Semanalmente domingo às 3h
      enabled: config?.enabled ?? (process.env.CATALOG_SCHEDULER_ENABLED !== 'false'),
      backfillOnBoot: config?.backfillOnBoot ?? (process.env.CATALOG_BACKFILL_ON_BOOT === 'true')
    };

    logger.info('CatalogScheduler initialized', {
      config: this.config
    });
  }

  /**
   * Inicia o scheduler
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('CatalogScheduler is already running');
      return;
    }

    if (!this.config.enabled) {
      logger.info('CatalogScheduler is disabled');
      return;
    }

    try {
      // Executa backfill se configurado
      if (this.config.backfillOnBoot) {
        await this.executeBackfill();
      }

      // Agenda sincronização incremental
      this.syncTask = cron.schedule(this.config.syncCron, async () => {
        await this.executeIncrementalSync();
      }, {
        scheduled: false,
        timezone: process.env.TZ || 'America/Sao_Paulo'
      });

      // Agenda snapshot diário
      this.snapshotTask = cron.schedule(this.config.snapshotCron, async () => {
        await this.executeSnapshotCreation();
      }, {
        scheduled: false,
        timezone: process.env.TZ || 'America/Sao_Paulo'
      });

      // Agenda limpeza semanal
      this.cleanupTask = cron.schedule(this.config.cleanupCron, async () => {
        await this.executeCleanup();
      }, {
        scheduled: false,
        timezone: process.env.TZ || 'America/Sao_Paulo'
      });

      // Inicia as tarefas
      this.syncTask.start();
      this.snapshotTask.start();
      this.cleanupTask.start();

      this.isRunning = true;
      
      logger.info('CatalogScheduler started successfully', {
        syncCron: this.config.syncCron,
        snapshotCron: this.config.snapshotCron,
        cleanupCron: this.config.cleanupCron
      });
    } catch (error) {
      logger.error('Error starting CatalogScheduler:', error);
      throw error;
    }
  }

  /**
   * Para o scheduler
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('CatalogScheduler is not running');
      return;
    }

    try {
      if (this.syncTask) {
        this.syncTask.stop();
        this.syncTask.destroy();
      }

      if (this.snapshotTask) {
        this.snapshotTask.stop();
        this.snapshotTask.destroy();
      }

      if (this.cleanupTask) {
        this.cleanupTask.stop();
        this.cleanupTask.destroy();
      }

      this.isRunning = false;
      
      logger.info('CatalogScheduler stopped successfully');
    } catch (error) {
      logger.error('Error stopping CatalogScheduler:', error);
      throw error;
    }
  }

  /**
   * Executa backfill inicial
   */
  private async executeBackfill(): Promise<void> {
    try {
      logger.info('Starting catalog backfill on boot');
      
      const logId = await this.logSyncStart('backfill');
      
      const result = await this.catalogSync.triggerFullSync();
      
      await this.logSyncComplete(logId, {
        records_processed: 0, // Será atualizado pelo catalogSync
        watermark_after: { last_seen_iso: result.watermark }
      });
      
      logger.info('Catalog backfill completed successfully', {
        watermark: result.watermark
      });
    } catch (error) {
      logger.error('Error in catalog backfill:', error);
      // Não propaga o erro para não impedir o boot
    }
  }

  /**
   * Executa sincronização incremental
   */
  private async executeIncrementalSync(): Promise<void> {
    try {
      logger.info('Starting scheduled incremental sync');
      
      const logId = await this.logSyncStart('incremental');
      
      // Obtém watermark atual
      const watermark = await this.catalogSync.getWatermark();
      const startTime = watermark?.last_seen_iso || '1970-01-01T00:00:00Z';
      
      const result = await this.catalogSync.triggerFullSync(startTime);
      
      await this.logSyncComplete(logId, {
        records_processed: 0, // Será atualizado pelo catalogSync
        watermark_before: watermark,
        watermark_after: { last_seen_iso: result.watermark }
      });
      
      logger.info('Scheduled incremental sync completed', {
        watermark: result.watermark
      });
    } catch (error) {
      logger.error('Error in scheduled incremental sync:', error);
      // Log do erro mas não propaga
    }
  }

  /**
   * Executa criação de snapshot diário
   */
  private async executeSnapshotCreation(): Promise<void> {
    try {
      logger.info('Starting daily snapshot creation');
      
      const today = new Date().toISOString().split('T')[0];
      
      // Chama função do banco para criar snapshot
      const result = await db.query(
        'SELECT create_daily_snapshot($1) as inserted_count',
        [today]
      );
      
      const insertedCount = result.rows[0]?.inserted_count || 0;
      
      logger.info('Daily snapshot created successfully', {
        date: today,
        inserted_count: insertedCount
      });
    } catch (error) {
      logger.error('Error creating daily snapshot:', error);
    }
  }

  /**
   * Executa limpeza de dados antigos
   */
  private async executeCleanup(): Promise<void> {
    try {
      logger.info('Starting weekly cleanup');
      
      const cleanupTasks = [
        // Remove snapshots antigos (mais de 30 dias)
        {
          name: 'old_snapshots',
          query: `DELETE FROM trinks_services_snapshot 
                   WHERE snapshot_date < CURRENT_DATE - INTERVAL '30 days'`
        },
        // Remove logs antigos (mais de 90 dias)
        {
          name: 'old_sync_logs',
          query: `DELETE FROM catalog_sync_logs 
                   WHERE created_at < NOW() - INTERVAL '90 days'`
        },
        // Remove watermarks antigos (mantém apenas o mais recente)
        {
          name: 'old_watermarks',
          query: `DELETE FROM sync_watermarks 
                   WHERE key LIKE 'catalog:%' 
                   AND updated_at < NOW() - INTERVAL '7 days'
                   AND key != 'catalog:watermark'`
        }
      ];

      const results: Record<string, number> = {};
      
      for (const task of cleanupTasks) {
        try {
          const result = await db.query(task.query);
          results[task.name] = result.rowCount || 0;
          
          logger.debug(`Cleanup task ${task.name} completed`, {
            deleted_rows: results[task.name]
          });
        } catch (error) {
          logger.error(`Error in cleanup task ${task.name}:`, error);
          results[task.name] = -1;
        }
      }
      
      logger.info('Weekly cleanup completed', { results });
    } catch (error) {
      logger.error('Error in weekly cleanup:', error);
    }
  }

  /**
   * Registra início de sincronização
   */
  private async logSyncStart(syncType: string): Promise<number> {
    try {
      const result = await db.query(`
        INSERT INTO catalog_sync_logs (sync_type, status, started_at)
        VALUES ($1, 'started', NOW())
        RETURNING id
      `, [syncType]);
      
      return result.rows[0].id;
    } catch (error) {
      logger.error('Error logging sync start:', error);
      return -1;
    }
  }

  /**
   * Registra conclusão de sincronização
   */
  private async logSyncComplete(logId: number, data: {
    records_processed?: number;
    records_inserted?: number;
    records_updated?: number;
    records_failed?: number;
    error_message?: string;
    watermark_before?: any;
    watermark_after?: any;
    metadata?: any;
  }): Promise<void> {
    if (logId === -1) return;
    
    try {
      await db.query(`
        UPDATE catalog_sync_logs 
        SET 
          status = CASE WHEN $2 IS NULL THEN 'completed' ELSE 'failed' END,
          completed_at = NOW(),
          records_processed = COALESCE($3, 0),
          records_inserted = COALESCE($4, 0),
          records_updated = COALESCE($5, 0),
          records_failed = COALESCE($6, 0),
          error_message = $2,
          watermark_before = $7,
          watermark_after = $8,
          metadata = $9
        WHERE id = $1
      `, [
        logId,
        data.error_message || null,
        data.records_processed || 0,
        data.records_inserted || 0,
        data.records_updated || 0,
        data.records_failed || 0,
        data.watermark_before ? JSON.stringify(data.watermark_before) : null,
        data.watermark_after ? JSON.stringify(data.watermark_after) : null,
        data.metadata ? JSON.stringify(data.metadata) : null
      ]);
    } catch (error) {
      logger.error('Error logging sync completion:', error);
    }
  }

  /**
   * Obtém status do scheduler
   */
  getStatus(): {
    isRunning: boolean;
    config: SchedulerConfig;
    nextRuns: {
      sync?: string;
      snapshot?: string;
      cleanup?: string;
    };
  } {
    const nextRuns: any = {};
    
    if (this.syncTask) {
      nextRuns.sync = this.syncTask.nextDate()?.toISOString();
    }
    
    if (this.snapshotTask) {
      nextRuns.snapshot = this.snapshotTask.nextDate()?.toISOString();
    }
    
    if (this.cleanupTask) {
      nextRuns.cleanup = this.cleanupTask.nextDate()?.toISOString();
    }
    
    return {
      isRunning: this.isRunning,
      config: this.config,
      nextRuns
    };
  }

  /**
   * Força execução de sincronização
   */
  async forceSyncNow(): Promise<{ ok: boolean; watermark?: string; error?: string }> {
    try {
      logger.info('Force sync triggered manually');
      
      const result = await this.catalogSync.triggerFullSync();
      
      return {
        ok: true,
        watermark: result.watermark
      };
    } catch (error) {
      logger.error('Error in force sync:', error);
      
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

// Instância singleton
let schedulerInstance: CatalogScheduler | null = null;

/**
 * Obtém instância singleton do scheduler
 */
export function getCatalogScheduler(config?: Partial<SchedulerConfig>): CatalogScheduler {
  if (!schedulerInstance) {
    schedulerInstance = new CatalogScheduler(config);
  }
  return schedulerInstance;
}

/**
 * Inicializa o scheduler
 */
export async function initializeCatalogScheduler(config?: Partial<SchedulerConfig>): Promise<CatalogScheduler> {
  const scheduler = getCatalogScheduler(config);
  await scheduler.start();
  return scheduler;
}

/**
 * Para o scheduler
 */
export async function shutdownCatalogScheduler(): Promise<void> {
  if (schedulerInstance) {
    await schedulerInstance.stop();
    schedulerInstance = null;
  }
}

export default CatalogScheduler;