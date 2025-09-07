import { StateMachine } from './state-machine';
import { ConversationController } from './conversation-controller';
import { MarlieStateRouterAgent } from '../agents/marlie-state-router';
import { getRedisClient } from '../services/redis-client';
import { logger } from '../utils/logger';

/**
 * Interface para configuração da integração
 */
export interface StateMachineIntegrationConfig {
  enableStateMachine: boolean;
  fallbackToLegacy: boolean;
  debugMode: boolean;
  redisPrefix: string;
}

/**
 * Classe principal para integração da máquina de estados
 */
export class StateMachineIntegration {
  private stateMachine: StateMachine;
  private conversationController: ConversationController;
  private marlieRouter: MarlieStateRouterAgent;
  private config: StateMachineIntegrationConfig;

  constructor(config: StateMachineIntegrationConfig) {
    this.config = config;
    this.stateMachine = new StateMachine();
    this.conversationController = new ConversationController(this.stateMachine);
    this.marlieRouter = new MarlieStateRouterAgent();
  }

  /**
   * Inicializa a integração
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing State Machine Integration...');
      
      // Inicializa a máquina de estados
      await this.stateMachine.initializeConfig();
      
      // Verifica conexão com Redis
      const redis = getRedisClient();
      await redis.ping();
      
      logger.info('State Machine Integration initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize State Machine Integration:', error);
      throw error;
    }
  }

  /**
   * Processa uma mensagem usando a nova arquitetura
   */
  async processMessage(phone: string, message: string, metadata?: any): Promise<any> {
    try {
      if (!this.config.enableStateMachine) {
        logger.debug('State machine disabled, using legacy router');
        return await this.marlieRouter.processMessage(phone, message, metadata);
      }

      // Processa com a nova máquina de estados
      const response = await this.conversationController.processMessage({
        phone,
        text: message,
        timestamp: new Date(),
        metadata
      });

      if (this.config.debugMode) {
        logger.debug('State machine response:', {
          phone,
          currentState: response.currentState,
          responseText: response.text,
          nextActions: response.nextActions
        });
      }

      return response;
    } catch (error) {
      logger.error('Error processing message with state machine:', error);
      
      if (this.config.fallbackToLegacy) {
        logger.warn('Falling back to legacy router');
        return await this.marlieRouter.processMessage(phone, message, metadata);
      }
      
      throw error;
    }
  }

  /**
   * Ativa/desativa handoff humano para um usuário
   */
  async setHumanHandoff(phone: string, enabled: boolean): Promise<void> {
    try {
      await this.conversationController.setHumanHandoff(phone, enabled);
      logger.info(`Human handoff ${enabled ? 'enabled' : 'disabled'} for ${phone}`);
    } catch (error) {
      logger.error('Error setting human handoff:', error);
      throw error;
    }
  }

  /**
   * Obtém o estado atual de uma conversa
   */
  async getConversationState(phone: string): Promise<any> {
    try {
      return await this.conversationController.getUserContext(phone);
    } catch (error) {
      logger.error('Error getting conversation state:', error);
      throw error;
    }
  }

  /**
   * Reseta uma conversa
   */
  async resetConversation(phone: string): Promise<void> {
    try {
      await this.conversationController.resetConversation(phone);
      logger.info(`Conversation reset for ${phone}`);
    } catch (error) {
      logger.error('Error resetting conversation:', error);
      throw error;
    }
  }

  /**
   * Obtém métricas da máquina de estados
   */
  async getMetrics(): Promise<any> {
    try {
      const redis = getRedisClient();
      const prefix = this.config.redisPrefix;
      
      // Coleta métricas básicas
      const activeConversations = await redis.keys(`${prefix}:context:*`);
      const humanHandoffs = await redis.keys(`${prefix}:handoff:*`);
      const buffers = await redis.keys(`${prefix}:buffer:*`);
      
      return {
        activeConversations: activeConversations.length,
        humanHandoffs: humanHandoffs.length,
        activeBuffers: buffers.length,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Error getting metrics:', error);
      throw error;
    }
  }

  /**
   * Limpa dados expirados
   */
  async cleanup(): Promise<void> {
    try {
      await this.conversationController.cleanup();
      logger.info('State machine cleanup completed');
    } catch (error) {
      logger.error('Error during cleanup:', error);
      throw error;
    }
  }
}

/**
 * Instância singleton da integração
 */
let integrationInstance: StateMachineIntegration | null = null;

/**
 * Obtém a instância da integração
 */
export function getStateMachineIntegration(config?: StateMachineIntegrationConfig): StateMachineIntegration {
  if (!integrationInstance) {
    const defaultConfig: StateMachineIntegrationConfig = {
      enableStateMachine: process.env.ENABLE_STATE_MACHINE === 'true',
      fallbackToLegacy: process.env.FALLBACK_TO_LEGACY !== 'false',
      debugMode: process.env.DEBUG_STATE_MACHINE === 'true',
      redisPrefix: process.env.REDIS_PREFIX || 'marlie'
    };
    
    integrationInstance = new StateMachineIntegration(config || defaultConfig);
  }
  
  return integrationInstance;
}

/**
 * Inicializa a integração da máquina de estados
 */
export async function initializeStateMachineIntegration(config?: StateMachineIntegrationConfig): Promise<StateMachineIntegration> {
  const integration = getStateMachineIntegration(config);
  await integration.initialize();
  return integration;
}

/**
 * Middleware para Express que adiciona a integração ao request
 */
export function stateMachineMiddleware(req: any, res: any, next: any): void {
  req.stateMachine = getStateMachineIntegration();
  next();
}

export default StateMachineIntegration;