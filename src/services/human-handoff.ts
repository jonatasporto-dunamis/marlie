import { RedisClientType } from 'redis';
import { Pool } from 'pg';
import { logger } from '../utils/logger';

export interface HandoffStatus {
  phone: string;
  enabled: boolean;
  enabledAt?: Date;
  enabledBy?: string;
  reason?: string;
  expiresAt?: Date;
}

export interface HandoffConfig {
  defaultTtlHours: number;
  maxTtlHours: number;
  enablePersistence: boolean;
}

export class HumanHandoffService {
  private redis: RedisClientType;
  private db: Pool;
  private config: HandoffConfig;
  private readonly HANDOFF_KEY_PREFIX = 'handoff:';
  private readonly GLOBAL_HANDOFF_KEY = 'global_handoff';

  constructor(
    redis: RedisClientType, 
    db: Pool, 
    config: HandoffConfig = {
      defaultTtlHours: 24,
      maxTtlHours: 168, // 7 days
      enablePersistence: true
    }
  ) {
    this.redis = redis;
    this.db = db;
    this.config = config;
  }

  /**
   * Ativa handoff humano para um telefone específico
   */
  async enableHandoff(
    phone: string, 
    enabledBy: string = 'system',
    reason: string = 'Manual activation',
    ttlHours?: number
  ): Promise<boolean> {
    try {
      const effectiveTtl = Math.min(
        ttlHours || this.config.defaultTtlHours,
        this.config.maxTtlHours
      );
      
      const handoffData: HandoffStatus = {
        phone,
        enabled: true,
        enabledAt: new Date(),
        enabledBy,
        reason,
        expiresAt: new Date(Date.now() + effectiveTtl * 60 * 60 * 1000)
      };

      // Store in Redis with TTL
      const redisKey = `${this.HANDOFF_KEY_PREFIX}${phone}`;
      const ttlSeconds = effectiveTtl * 3600;
      
      await this.redis.setEx(
        redisKey,
        ttlSeconds,
        JSON.stringify(handoffData)
      );

      // Persist to database if enabled
      if (this.config.enablePersistence) {
        await this.persistHandoffStatus(handoffData);
      }

      logger.info(`Handoff enabled for phone ${phone} by ${enabledBy}, expires in ${effectiveTtl}h`);
      
      return true;
    } catch (error) {
      logger.error(`Failed to enable handoff for phone ${phone}:`, error);
      return false;
    }
  }

  /**
   * Desativa handoff humano para um telefone específico
   */
  async disableHandoff(phone: string, disabledBy: string = 'system'): Promise<boolean> {
    try {
      const redisKey = `${this.HANDOFF_KEY_PREFIX}${phone}`;
      
      // Remove from Redis
      await this.redis.del(redisKey);

      // Update database if persistence is enabled
      if (this.config.enablePersistence) {
        await this.db.query(
          `UPDATE human_handoffs 
           SET enabled = false, disabled_at = NOW(), disabled_by = $1 
           WHERE phone = $2 AND enabled = true`,
          [disabledBy, phone]
        );
      }

      logger.info(`Handoff disabled for phone ${phone} by ${disabledBy}`);
      
      return true;
    } catch (error) {
      logger.error(`Failed to disable handoff for phone ${phone}:`, error);
      return false;
    }
  }

  /**
   * Verifica se handoff está ativo para um telefone
   */
  async isHandoffActive(phone: string): Promise<boolean> {
    try {
      // Check global handoff first
      const globalHandoff = await this.redis.get(this.GLOBAL_HANDOFF_KEY);
      if (globalHandoff === 'true') {
        return true;
      }

      // Check phone-specific handoff
      const redisKey = `${this.HANDOFF_KEY_PREFIX}${phone}`;
      const handoffData = await this.redis.get(redisKey);
      
      if (handoffData) {
        try {
          const status: HandoffStatus = JSON.parse(handoffData as string);
          
          // Check if expired
          if (status.expiresAt && new Date() > new Date(status.expiresAt)) {
            await this.disableHandoff(phone, 'system_expiry');
            return false;
          }
          
          return status.enabled;
        } catch (parseError) {
          logger.error('Failed to parse handoff data:', parseError);
          await this.redis.del(redisKey);
          return false;
        }
      }

      return false;
    } catch (error) {
      logger.error(`Failed to check handoff status for phone ${phone}:`, error);
      return false;
    }
  }

  /**
   * Obtém status detalhado do handoff
   */
  async getHandoffStatus(phone: string): Promise<HandoffStatus | null> {
    try {
      const redisKey = `${this.HANDOFF_KEY_PREFIX}${phone}`;
      const handoffData = await this.redis.get(redisKey);
      
      if (handoffData) {
        const status: HandoffStatus = JSON.parse(handoffData as string);
        
        // Check if expired
        if (status.expiresAt && new Date() > new Date(status.expiresAt)) {
          await this.disableHandoff(phone, 'system_expiry');
          return null;
        }
        
        return status;
      }

      return null;
    } catch (error) {
      logger.error(`Failed to get handoff status for phone ${phone}:`, error);
      return null;
    }
  }

  /**
   * Ativa handoff global (todos os telefones)
   */
  async enableGlobalHandoff(
    enabledBy: string = 'admin',
    ttlHours: number = 1
  ): Promise<boolean> {
    try {
      const ttlSeconds = ttlHours * 3600;
      await this.redis.setEx(this.GLOBAL_HANDOFF_KEY, ttlSeconds, 'true');
      
      logger.warn(`Global handoff enabled by ${enabledBy} for ${ttlHours}h`);
      
      return true;
    } catch (error) {
      logger.error('Failed to enable global handoff:', error);
      return false;
    }
  }

  /**
   * Desativa handoff global
   */
  async disableGlobalHandoff(disabledBy: string = 'admin'): Promise<boolean> {
    try {
      await this.redis.del(this.GLOBAL_HANDOFF_KEY);
      
      logger.info(`Global handoff disabled by ${disabledBy}`);
      
      return true;
    } catch (error) {
      logger.error('Failed to disable global handoff:', error);
      return false;
    }
  }

  /**
   * Verifica se handoff global está ativo
   */
  async isGlobalHandoffActive(): Promise<boolean> {
    try {
      const globalHandoff = await this.redis.get(this.GLOBAL_HANDOFF_KEY);
      return globalHandoff === 'true';
    } catch (error) {
      logger.error('Failed to check global handoff status:', error);
      return false;
    }
  }

  /**
   * Lista todos os handoffs ativos
   */
  async listActiveHandoffs(): Promise<HandoffStatus[]> {
    try {
      const pattern = `${this.HANDOFF_KEY_PREFIX}*`;
      const keys = await this.redis.keys(pattern);
      
      const activeHandoffs: HandoffStatus[] = [];
      
      for (const key of keys) {
        const data = await this.redis.get(key);
        if (data) {
          try {
            const status: HandoffStatus = JSON.parse(data as string);
            
            // Check if expired
            if (status.expiresAt && new Date() > new Date(status.expiresAt)) {
              await this.redis.del(key);
              continue;
            }
            
            activeHandoffs.push(status);
          } catch (parseError) {
            logger.error(`Failed to parse handoff data for key ${key}:`, parseError);
            await this.redis.del(key);
          }
        }
      }
      
      return activeHandoffs;
    } catch (error) {
      logger.error('Failed to list active handoffs:', error);
      return [];
    }
  }

  /**
   * Limpa handoffs expirados
   */
  async cleanupExpiredHandoffs(): Promise<number> {
    try {
      const pattern = `${this.HANDOFF_KEY_PREFIX}*`;
      const keys = await this.redis.keys(pattern);
      
      let cleanedCount = 0;
      const now = new Date();
      
      for (const key of keys) {
        const data = await this.redis.get(key);
        if (data) {
          try {
            const status: HandoffStatus = JSON.parse(data as string);
            
            if (status.expiresAt && now > new Date(status.expiresAt)) {
              await this.redis.del(key);
              cleanedCount++;
            }
          } catch (parseError) {
            // Invalid data, delete it
            await this.redis.del(key);
            cleanedCount++;
          }
        }
      }
      
      if (cleanedCount > 0) {
        logger.info(`Cleaned up ${cleanedCount} expired handoffs`);
      }
      
      return cleanedCount;
    } catch (error) {
      logger.error('Error cleaning up expired handoffs:', error);
      return 0;
    }
  }

  /**
   * Persiste status do handoff no banco de dados
   */
  private async persistHandoffStatus(status: HandoffStatus): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO human_handoffs 
         (phone, enabled, enabled_at, enabled_by, reason, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (phone) 
         DO UPDATE SET 
           enabled = $2,
           enabled_at = $3,
           enabled_by = $4,
           reason = $5,
           expires_at = $6`,
        [
          status.phone,
          status.enabled,
          status.enabledAt,
          status.enabledBy,
          status.reason,
          status.expiresAt
        ]
      );
    } catch (error) {
      logger.error('Failed to persist handoff status:', error);
      // Don't throw - Redis is primary, DB is backup
    }
  }

  /**
   * Inicializa tabela de handoffs se não existir
   */
  async initializeDatabase(): Promise<void> {
    try {
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS human_handoffs (
          id SERIAL PRIMARY KEY,
          phone VARCHAR(20) UNIQUE NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT false,
          enabled_at TIMESTAMP WITH TIME ZONE,
          enabled_by VARCHAR(100),
          disabled_at TIMESTAMP WITH TIME ZONE,
          disabled_by VARCHAR(100),
          reason TEXT,
          expires_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        
        CREATE INDEX IF NOT EXISTS idx_human_handoffs_phone ON human_handoffs(phone);
        CREATE INDEX IF NOT EXISTS idx_human_handoffs_enabled ON human_handoffs(enabled);
        CREATE INDEX IF NOT EXISTS idx_human_handoffs_expires_at ON human_handoffs(expires_at);
      `);
      
      logger.info('Human handoffs database initialized');
    } catch (error) {
      logger.error('Failed to initialize handoffs database:', error);
      throw error;
    }
  }
}

// Singleton instance
let handoffServiceInstance: HumanHandoffService | null = null;

export function getHumanHandoffService(
  redis: RedisClientType, 
  db: Pool, 
  config?: HandoffConfig
): HumanHandoffService {
  if (!handoffServiceInstance) {
    handoffServiceInstance = new HumanHandoffService(redis, db, config);
  }
  return handoffServiceInstance;
}

export function resetHumanHandoffService(): void {
  handoffServiceInstance = null;
}