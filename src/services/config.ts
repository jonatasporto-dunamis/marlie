import crypto from 'crypto';
import { pool } from '../infra/db';
import { getRedis } from '../infra/redis';
import logger from '../utils/logger';

/**
 * ConfigService - Gerenciamento seguro de credenciais com criptografia AES-GCM
 * 
 * Funcionalidades:
 * - Criptografia AES-GCM para credenciais sensíveis
 * - Cache em memória e Redis (5-10 min TTL)
 * - Rotação de credenciais
 * - Isolamento por tenant
 */

export interface ConfigValue {
  value: string;
  type: 'credential' | 'setting' | 'api_key' | 'webhook_url';
  description?: string;
  lastRotated?: Date;
}

export interface EncryptedConfig {
  encrypted: string;
  iv: string;
  authTag: string;
  algorithm: string;
}

class ConfigService {
  private readonly algorithm = 'aes-256-gcm';
  private readonly keyLength = 32; // 256 bits
  private readonly ivLength = 16; // 128 bits
  private readonly tagLength = 16; // 128 bits
  
  // Cache em memória (primeiro nível)
  private memoryCache = new Map<string, { value: ConfigValue; expires: number }>();
  private readonly memoryCacheTTL = 5 * 60 * 1000; // 5 minutos
  
  // Cache Redis (segundo nível)
  private readonly redisCacheTTL = 10 * 60; // 10 minutos
  
  constructor() {
    // Limpar cache em memória periodicamente
    setInterval(() => {
      this.cleanMemoryCache();
    }, 60 * 1000); // A cada minuto
  }
  
  /**
   * Obter chave mestra de criptografia
   */
  private getMasterKey(): Buffer {
    const masterKey = process.env.KMS_MASTER_KEY;
    
    if (!masterKey) {
      throw new Error('KMS_MASTER_KEY environment variable is required');
    }
    
    // Se a chave for base64, decodificar
    if (masterKey.length === 44 && masterKey.endsWith('=')) {
      return Buffer.from(masterKey, 'base64');
    }
    
    // Se a chave for hex
    if (masterKey.length === 64) {
      return Buffer.from(masterKey, 'hex');
    }
    
    // Se for string simples, usar hash SHA-256
    return crypto.createHash('sha256').update(masterKey).digest();
  }
  
  /**
   * Criptografar valor usando AES-GCM
   */
  private encrypt(plaintext: string): EncryptedConfig {
    const key = this.getMasterKey();
    const iv = crypto.randomBytes(this.ivLength);
    
    const cipher = crypto.createCipher(this.algorithm, key);
    cipher.setAAD(Buffer.from('config-service')); // Additional Authenticated Data
    
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    return {
      encrypted,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      algorithm: this.algorithm
    };
  }
  
  /**
   * Descriptografar valor usando AES-GCM
   */
  private decrypt(encryptedConfig: EncryptedConfig): string {
    const key = this.getMasterKey();
    const iv = Buffer.from(encryptedConfig.iv, 'hex');
    const authTag = Buffer.from(encryptedConfig.authTag, 'hex');
    
    const decipher = crypto.createDecipher(encryptedConfig.algorithm, key);
    decipher.setAAD(Buffer.from('config-service'));
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encryptedConfig.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }
  
  /**
   * Gerar chave de cache
   */
  private getCacheKey(tenantId: string, configKey: string): string {
    return `config:${tenantId}:${configKey}`;
  }
  
  /**
   * Limpar cache em memória expirado
   */
  private cleanMemoryCache(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];
    
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.expires < now) {
        expiredKeys.push(key);
      }
    }
    
    expiredKeys.forEach(key => this.memoryCache.delete(key));
    
    if (expiredKeys.length > 0) {
      logger.debug(`Cleaned ${expiredKeys.length} expired config cache entries`);
    }
  }
  
  /**
   * Obter configuração do cache em memória
   */
  private getFromMemoryCache(cacheKey: string): ConfigValue | null {
    const entry = this.memoryCache.get(cacheKey);
    
    if (!entry) {
      return null;
    }
    
    if (entry.expires < Date.now()) {
      this.memoryCache.delete(cacheKey);
      return null;
    }
    
    return entry.value;
  }
  
  /**
   * Armazenar configuração no cache em memória
   */
  private setInMemoryCache(cacheKey: string, value: ConfigValue): void {
    this.memoryCache.set(cacheKey, {
      value,
      expires: Date.now() + this.memoryCacheTTL
    });
  }
  
  /**
   * Obter configuração do cache Redis
   */
  private async getFromRedisCache(cacheKey: string): Promise<ConfigValue | null> {
    try {
      const redis = getRedis();
      if (!redis) {
        return null;
      }
      
      const cached = await redis.get(cacheKey);
      if (!cached) {
        return null;
      }
      
      return JSON.parse(cached);
    } catch (error) {
      logger.warn('Error reading from Redis cache:', error);
      return null;
    }
  }
  
  /**
   * Armazenar configuração no cache Redis
   */
  private async setInRedisCache(cacheKey: string, value: ConfigValue): Promise<void> {
    try {
      const redis = getRedis();
      if (!redis) {
        return;
      }
      
      await redis.setex(cacheKey, this.redisCacheTTL, JSON.stringify(value));
    } catch (error) {
      logger.warn('Error writing to Redis cache:', error);
    }
  }
  
  /**
   * Invalidar cache para uma configuração específica
   */
  private async invalidateCache(tenantId: string, configKey: string): Promise<void> {
    const cacheKey = this.getCacheKey(tenantId, configKey);
    
    // Remover do cache em memória
    this.memoryCache.delete(cacheKey);
    
    // Remover do cache Redis
    try {
      const redis = getRedis();
      if (redis) {
        await redis.del(cacheKey);
      }
    } catch (error) {
      logger.warn('Error invalidating Redis cache:', error);
    }
  }
  
  /**
   * Obter configuração
   */
  async get(tenantId: string, configKey: string): Promise<ConfigValue | null> {
    const cacheKey = this.getCacheKey(tenantId, configKey);
    
    // 1. Tentar cache em memória
    let cached = this.getFromMemoryCache(cacheKey);
    if (cached) {
      logger.debug(`Config cache hit (memory): ${configKey}`);
      return cached;
    }
    
    // 2. Tentar cache Redis
    cached = await this.getFromRedisCache(cacheKey);
    if (cached) {
      logger.debug(`Config cache hit (Redis): ${configKey}`);
      // Armazenar no cache em memória para próximas consultas
      this.setInMemoryCache(cacheKey, cached);
      return cached;
    }
    
    // 3. Buscar no banco de dados
    try {
      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT config_value_encrypted, config_type, description, last_rotated_at
          FROM tenant_configs
          WHERE tenant_id = $1 AND config_key = $2 AND is_active = true
        `, [tenantId, configKey]);
        
        if (result.rows.length === 0) {
          logger.debug(`Config not found: ${tenantId}:${configKey}`);
          return null;
        }
        
        const row = result.rows[0];
        const encryptedConfig: EncryptedConfig = JSON.parse(row.config_value_encrypted);
        const decryptedValue = this.decrypt(encryptedConfig);
        
        const configValue: ConfigValue = {
          value: decryptedValue,
          type: row.config_type,
          description: row.description,
          lastRotated: row.last_rotated_at ? new Date(row.last_rotated_at) : undefined
        };
        
        // Armazenar em ambos os caches
        this.setInMemoryCache(cacheKey, configValue);
        await this.setInRedisCache(cacheKey, configValue);
        
        logger.debug(`Config loaded from database: ${configKey}`);
        return configValue;
        
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error getting config from database:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        tenantId,
        configKey
      });
      throw error;
    }
  }
  
  /**
   * Definir configuração
   */
  async set(
    tenantId: string,
    configKey: string,
    value: string,
    type: ConfigValue['type'] = 'credential',
    description?: string
  ): Promise<void> {
    try {
      const encryptedConfig = this.encrypt(value);
      const encryptedJson = JSON.stringify(encryptedConfig);
      
      const client = await pool.connect();
      try {
        await client.query(`
          INSERT INTO tenant_configs (
            tenant_id, config_key, config_value_encrypted, config_type, description, last_rotated_at
          )
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (tenant_id, config_key)
          DO UPDATE SET
            config_value_encrypted = EXCLUDED.config_value_encrypted,
            config_type = EXCLUDED.config_type,
            description = EXCLUDED.description,
            last_rotated_at = NOW(),
            updated_at = NOW()
        `, [tenantId, configKey, encryptedJson, type, description]);
        
        // Invalidar cache
        await this.invalidateCache(tenantId, configKey);
        
        logger.info('Config updated successfully', {
          tenantId,
          configKey,
          type
        });
        
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error setting config in database:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        tenantId,
        configKey,
        type
      });
      throw error;
    }
  }
  
  /**
   * Rotacionar configuração (gerar nova criptografia)
   */
  async rotate(tenantId: string, configKey: string): Promise<void> {
    try {
      // Obter valor atual
      const currentConfig = await this.get(tenantId, configKey);
      if (!currentConfig) {
        throw new Error(`Config not found: ${tenantId}:${configKey}`);
      }
      
      // Re-criptografar com nova chave/IV
      await this.set(
        tenantId,
        configKey,
        currentConfig.value,
        currentConfig.type,
        currentConfig.description
      );
      
      logger.info('Config rotated successfully', {
        tenantId,
        configKey
      });
      
    } catch (error) {
      logger.error('Error rotating config:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        tenantId,
        configKey
      });
      throw error;
    }
  }
  
  /**
   * Deletar configuração
   */
  async delete(tenantId: string, configKey: string): Promise<void> {
    try {
      const client = await pool.connect();
      try {
        await client.query(`
          UPDATE tenant_configs
          SET is_active = false, updated_at = NOW()
          WHERE tenant_id = $1 AND config_key = $2
        `, [tenantId, configKey]);
        
        // Invalidar cache
        await this.invalidateCache(tenantId, configKey);
        
        logger.info('Config deleted successfully', {
          tenantId,
          configKey
        });
        
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error deleting config:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        tenantId,
        configKey
      });
      throw error;
    }
  }
  
  /**
   * Listar todas as configurações de um tenant
   */
  async list(tenantId: string): Promise<Array<{ key: string; type: string; description?: string; lastRotated?: Date }>> {
    try {
      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT config_key, config_type, description, last_rotated_at
          FROM tenant_configs
          WHERE tenant_id = $1 AND is_active = true
          ORDER BY config_key
        `, [tenantId]);
        
        return result.rows.map(row => ({
          key: row.config_key,
          type: row.config_type,
          description: row.description,
          lastRotated: row.last_rotated_at ? new Date(row.last_rotated_at) : undefined
        }));
        
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error listing configs:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        tenantId
      });
      throw error;
    }
  }
  
  /**
   * Validar conexão com credenciais
   */
  async validateConnection(tenantId: string, configKey: string): Promise<boolean> {
    try {
      const config = await this.get(tenantId, configKey);
      if (!config) {
        return false;
      }
      
      // Implementar validação específica baseada no tipo
      switch (config.type) {
        case 'api_key':
          // Validação básica de formato de API key
          return config.value.length > 10 && /^[a-zA-Z0-9_-]+$/.test(config.value);
          
        case 'webhook_url':
          // Validação de URL
          try {
            new URL(config.value);
            return true;
          } catch {
            return false;
          }
          
        case 'credential':
        case 'setting':
        default:
          // Validação básica - não vazio
          return config.value.trim().length > 0;
      }
      
    } catch (error) {
      logger.error('Error validating connection:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        tenantId,
        configKey
      });
      return false;
    }
  }
  
  /**
   * Obter estatísticas do cache
   */
  getCacheStats(): { memorySize: number; memoryHitRate?: number } {
    return {
      memorySize: this.memoryCache.size
    };
  }
  
  /**
   * Limpar todos os caches
   */
  async clearAllCaches(): Promise<void> {
    // Limpar cache em memória
    this.memoryCache.clear();
    
    // Limpar cache Redis (padrão config:*)
    try {
      const redis = await getRedis();
      if (redis) {
        const keys = await redis.keys('config:*');
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      }
    } catch (error) {
      logger.warn('Error clearing Redis cache:', error);
    }
    
    logger.info('All config caches cleared');
  }
}

// Singleton instance
export const configService = new ConfigService();

// Helper functions for common config keys
export const getEvolutionConfig = (tenantId: string) => ({
  baseUrl: () => configService.get(tenantId, 'evolution_base_url'),
  apiKey: () => configService.get(tenantId, 'evolution_api_key'),
  instance: () => configService.get(tenantId, 'evolution_instance'),
  webhookToken: () => configService.get(tenantId, 'evolution_webhook_token')
});

export const getTrinksConfig = (tenantId: string) => ({
  baseUrl: () => configService.get(tenantId, 'trinks_base_url'),
  apiKey: () => configService.get(tenantId, 'trinks_api_key'),
  estabelecimentoId: () => configService.get(tenantId, 'trinks_estabelecimento_id')
});

export const getOpenAIConfig = (tenantId: string) => ({
  apiKey: () => configService.get(tenantId, 'openai_api_key'),
  model: () => configService.get(tenantId, 'openai_model')
});