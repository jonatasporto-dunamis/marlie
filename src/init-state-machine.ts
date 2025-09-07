/**
 * Script de inicialização da Máquina de Estados
 * 
 * Este arquivo deve ser importado na inicialização da aplicação
 * para configurar e ativar a nova máquina de estados.
 */

import { initializeStateMachineIntegration, StateMachineIntegrationConfig } from './core/state-machine-integration';
import { logger } from './utils/logger';
import { getRedis } from './infra/redis';

/**
 * Configuração padrão da máquina de estados
 */
const DEFAULT_CONFIG: StateMachineIntegrationConfig = {
  enableStateMachine: process.env.ENABLE_STATE_MACHINE === 'true',
  fallbackToLegacy: process.env.FALLBACK_TO_LEGACY !== 'false',
  debugMode: process.env.DEBUG_STATE_MACHINE === 'true',
  redisPrefix: process.env.REDIS_PREFIX || 'marlie'
};

/**
 * Inicializa a máquina de estados
 */
export async function initializeStateMachine(config?: Partial<StateMachineIntegrationConfig>) {
  try {
    logger.info('🚀 Initializing State Machine...');
    
    // Merge configuração personalizada com padrão
    const finalConfig = { ...DEFAULT_CONFIG, ...config };
    
    // Log da configuração (sem dados sensíveis)
    logger.info('State Machine Configuration:', {
      enableStateMachine: finalConfig.enableStateMachine,
      fallbackToLegacy: finalConfig.fallbackToLegacy,
      debugMode: finalConfig.debugMode,
      redisPrefix: finalConfig.redisPrefix
    });
    
    // Verifica dependências
    await checkDependencies();
    
    // Inicializa a integração
    const integration = await initializeStateMachineIntegration(finalConfig);
    
    // Configura limpeza automática
    if (process.env.CLEANUP_INTERVAL) {
      const intervalMinutes = parseInt(process.env.CLEANUP_INTERVAL, 10);
      setInterval(async () => {
        try {
          await integration.cleanup();
          logger.debug('Automatic cleanup completed');
        } catch (error) {
          logger.error('Error during automatic cleanup:', error);
        }
      }, intervalMinutes * 60 * 1000);
      
      logger.info(`🧹 Automatic cleanup scheduled every ${intervalMinutes} minutes`);
    }
    
    // Log de sucesso
    if (finalConfig.enableStateMachine) {
      logger.info('✅ State Machine initialized successfully');
    } else {
      logger.info('⚠️  State Machine disabled, using legacy router');
    }
    
    return integration;
  } catch (error) {
    logger.error('❌ Failed to initialize State Machine:', error);
    
    if (!DEFAULT_CONFIG.fallbackToLegacy) {
      throw error;
    }
    
    logger.warn('🔄 Falling back to legacy router due to initialization error');
    return null;
  }
}

/**
 * Verifica se todas as dependências estão disponíveis
 */
async function checkDependencies() {
  const checks = [];
  
  // Verifica Redis
  checks.push(checkRedis());
  
  // Verifica variáveis de ambiente obrigatórias
  checks.push(checkEnvironmentVariables());
  
  // Verifica arquivos de configuração
  checks.push(checkConfigurationFiles());
  
  await Promise.all(checks);
}

/**
 * Verifica conexão com Redis
 */
async function checkRedis() {
  try {
    const redis = await getRedis();
    if (!redis) {
      throw new Error('Redis client not available');
    }
    
    const result = await redis.ping();
    
    if (result !== 'PONG') {
      throw new Error('Redis ping failed');
    }
    
    logger.debug('✅ Redis connection verified');
  } catch (error) {
    logger.error('❌ Redis connection failed:', error);
    throw new Error('Redis is required for State Machine');
  }
}

/**
 * Verifica variáveis de ambiente obrigatórias
 */
async function checkEnvironmentVariables() {
  const required = [
    'REDIS_URL'
  ];
  
  const missing = required.filter(env => !process.env[env]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  
  logger.debug('✅ Environment variables verified');
}

/**
 * Verifica arquivos de configuração
 */
async function checkConfigurationFiles() {
  const fs = require('fs').promises;
  const path = require('path');
  
  const configFile = path.join(__dirname, 'core', 'state-machine-config.yaml');
  
  try {
    await fs.access(configFile);
    logger.debug('✅ Configuration files verified');
  } catch (error) {
    throw new Error(`Configuration file not found: ${configFile}`);
  }
}

/**
 * Graceful shutdown da máquina de estados
 */
export async function shutdownStateMachine() {
  try {
    logger.info('🛑 Shutting down State Machine...');
    
    // Aqui você pode adicionar lógica de cleanup específica
    // Por exemplo, salvar estados pendentes, fechar conexões, etc.
    
    const redis = await getRedis();
    if (redis) {
      await redis.quit();
    }
    
    logger.info('✅ State Machine shutdown completed');
  } catch (error) {
    logger.error('❌ Error during State Machine shutdown:', error);
  }
}

/**
 * Middleware para Express que adiciona a máquina de estados ao request
 */
export function createStateMachineMiddleware() {
  return (req: any, res: any, next: any) => {
    // A integração já está disponível globalmente via singleton
    // Este middleware pode ser usado para adicionar funcionalidades específicas
    next();
  };
}

/**
 * Utilitário para verificar se a máquina de estados está ativa
 */
export function isStateMachineEnabled(): boolean {
  return process.env.ENABLE_STATE_MACHINE === 'true';
}

/**
 * Utilitário para obter configuração atual
 */
export function getStateMachineConfig(): StateMachineIntegrationConfig {
  return {
    enableStateMachine: process.env.ENABLE_STATE_MACHINE === 'true',
    fallbackToLegacy: process.env.FALLBACK_TO_LEGACY !== 'false',
    debugMode: process.env.DEBUG_STATE_MACHINE === 'true',
    redisPrefix: process.env.REDIS_PREFIX || 'marlie'
  };
}

// Configuração de handlers para sinais do sistema
if (process.env.NODE_ENV !== 'test') {
  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gracefully');
    await shutdownStateMachine();
    process.exit(0);
  });
  
  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down gracefully');
    await shutdownStateMachine();
    process.exit(0);
  });
  
  process.on('uncaughtException', async (error) => {
    logger.error('Uncaught exception:', error);
    await shutdownStateMachine();
    process.exit(1);
  });
  
  process.on('unhandledRejection', async (reason, promise) => {
    logger.error('Unhandled rejection at:', promise, 'reason:', reason);
    await shutdownStateMachine();
    process.exit(1);
  });
}

export default {
  initializeStateMachine,
  shutdownStateMachine,
  createStateMachineMiddleware,
  isStateMachineEnabled,
  getStateMachineConfig
};