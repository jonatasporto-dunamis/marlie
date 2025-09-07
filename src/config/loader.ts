import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { logger } from '../utils/logger';

interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl?: boolean;
}

interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
}

interface ModuleConfig {
  name: string;
  version: string;
  enabled: boolean;
}

interface QualityConfig {
  module: ModuleConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  tests: {
    e2e_suites: any[];
    contract_suites: any[];
  };
  seeds: {
    default_rows: number;
    types: string[];
  };
  pipeline: {
    timeout_ms: number;
    parallel_execution: boolean;
    stages: string[];
  };
  metrics: {
    enabled: boolean;
    port?: number;
  };
  logs: {
    level: string;
    format: string;
  };
}

/**
 * Carrega configuração de um módulo específico
 */
export async function loadConfig(moduleName: string): Promise<QualityConfig> {
  try {
    const configPath = path.join(__dirname, `${moduleName}.yaml`);
    
    if (!fs.existsSync(configPath)) {
      throw new Error(`Configuration file not found: ${configPath}`);
    }

    const fileContent = fs.readFileSync(configPath, 'utf8');
    const config = yaml.load(fileContent) as QualityConfig;

    // Aplicar variáveis de ambiente
    const processedConfig = applyEnvironmentVariables(config);
    
    // Validar configuração
    validateConfig(processedConfig);
    
    logger.info(`Configuration loaded successfully for module: ${moduleName}`);
    return processedConfig;
    
  } catch (error) {
    logger.error(`Failed to load configuration for module ${moduleName}:`, error);
    throw error;
  }
}

/**
 * Aplica variáveis de ambiente na configuração
 */
function applyEnvironmentVariables(config: QualityConfig): QualityConfig {
  const processed = JSON.parse(JSON.stringify(config));
  
  // Database
  if (process.env.DB_HOST) processed.database.host = process.env.DB_HOST;
  if (process.env.DB_PORT) processed.database.port = parseInt(process.env.DB_PORT);
  if (process.env.DB_NAME) processed.database.database = process.env.DB_NAME;
  if (process.env.DB_USER) processed.database.username = process.env.DB_USER;
  if (process.env.DB_PASSWORD) processed.database.password = process.env.DB_PASSWORD;
  if (process.env.DB_SSL) processed.database.ssl = process.env.DB_SSL === 'true';
  
  // Redis
  if (process.env.REDIS_HOST) processed.redis.host = process.env.REDIS_HOST;
  if (process.env.REDIS_PORT) processed.redis.port = parseInt(process.env.REDIS_PORT);
  if (process.env.REDIS_PASSWORD) processed.redis.password = process.env.REDIS_PASSWORD;
  if (process.env.REDIS_DB) processed.redis.db = parseInt(process.env.REDIS_DB);
  
  // Timeouts
  if (process.env.E2E_TEST_TIMEOUT) {
    const timeout = parseInt(process.env.E2E_TEST_TIMEOUT);
    if (timeout > 0) processed.pipeline.timeout_ms = timeout;
  }
  
  // Logs
  if (process.env.QUALITY_LOG_LEVEL) processed.logs.level = process.env.QUALITY_LOG_LEVEL;
  if (process.env.QUALITY_LOG_FORMAT) processed.logs.format = process.env.QUALITY_LOG_FORMAT;
  
  // Métricas
  if (process.env.METRICS_ENABLED) processed.metrics.enabled = process.env.METRICS_ENABLED === 'true';
  if (process.env.METRICS_PORT) processed.metrics.port = parseInt(process.env.METRICS_PORT);
  
  return processed;
}

/**
 * Valida a configuração carregada
 */
function validateConfig(config: QualityConfig): void {
  const errors: string[] = [];
  
  // Validar módulo
  if (!config.module?.name) {
    errors.push('module.name is required');
  }
  
  if (!config.module?.version) {
    errors.push('module.version is required');
  }
  
  // Validar database
  if (!config.database?.host) {
    errors.push('database.host is required');
  }
  
  if (!config.database?.port || config.database.port <= 0) {
    errors.push('database.port must be a positive number');
  }
  
  if (!config.database?.database) {
    errors.push('database.database is required');
  }
  
  if (!config.database?.username) {
    errors.push('database.username is required');
  }
  
  // Validar redis
  if (!config.redis?.host) {
    errors.push('redis.host is required');
  }
  
  if (!config.redis?.port || config.redis.port <= 0) {
    errors.push('redis.port must be a positive number');
  }
  
  // Validar testes
  if (!Array.isArray(config.tests?.e2e_suites)) {
    errors.push('tests.e2e_suites must be an array');
  }
  
  if (!Array.isArray(config.tests?.contract_suites)) {
    errors.push('tests.contract_suites must be an array');
  }
  
  // Validar seeds
  if (!config.seeds?.default_rows || config.seeds.default_rows <= 0) {
    errors.push('seeds.default_rows must be a positive number');
  }
  
  if (!Array.isArray(config.seeds?.types)) {
    errors.push('seeds.types must be an array');
  }
  
  // Validar pipeline
  if (!config.pipeline?.timeout_ms || config.pipeline.timeout_ms <= 0) {
    errors.push('pipeline.timeout_ms must be a positive number');
  }
  
  if (!Array.isArray(config.pipeline?.stages)) {
    errors.push('pipeline.stages must be an array');
  }
  
  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }
}

/**
 * Carrega configuração com fallback para valores padrão
 */
export async function loadConfigWithDefaults(moduleName: string): Promise<QualityConfig> {
  try {
    return await loadConfig(moduleName);
  } catch (error) {
    logger.warn(`Failed to load config for ${moduleName}, using defaults:`, error);
    
    return {
      module: {
        name: moduleName,
        version: '1.0.0',
        enabled: true
      },
      database: {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME || 'marlie_dev',
        username: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'password',
        ssl: process.env.DB_SSL === 'true'
      },
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD || undefined,
        db: parseInt(process.env.REDIS_DB || '0')
      },
      tests: {
        e2e_suites: [],
        contract_suites: []
      },
      seeds: {
        default_rows: 5,
        types: ['clients', 'services', 'professionals']
      },
      pipeline: {
        timeout_ms: 300000,
        parallel_execution: false,
        stages: ['setup', 'seeds', 'contract', 'e2e', 'cleanup']
      },
      metrics: {
        enabled: process.env.METRICS_ENABLED === 'true',
        port: parseInt(process.env.METRICS_PORT || '9090')
      },
      logs: {
        level: process.env.QUALITY_LOG_LEVEL || 'info',
        format: process.env.QUALITY_LOG_FORMAT || 'json'
      }
    };
  }
}

/**
 * Recarrega configuração em tempo de execução
 */
export async function reloadConfig(moduleName: string): Promise<QualityConfig> {
  logger.info(`Reloading configuration for module: ${moduleName}`);
  return await loadConfig(moduleName);
}

export type { QualityConfig, DatabaseConfig, RedisConfig, ModuleConfig };