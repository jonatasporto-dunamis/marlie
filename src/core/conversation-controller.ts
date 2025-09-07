import { StateMachine, StateContext, UserContext } from './state-machine';
import { logger } from '../utils/logger';
import { HumanHandoffService } from '../services/human-handoff';
import { MessageBuffer } from '../services/message-buffer';
import { getRedis } from '../infra/redis';
import { pool } from '../infra/db';

export interface ConversationMessage {
  phone: string;
  message: string;
  tenant_id: string;
  user_name?: string;
  timestamp?: Date;
}

export interface ConversationResponse {
  reply?: string;
  shouldRespond: boolean;
  state: string;
  handoffActive?: boolean;
  error?: string;
}

export class ConversationController {
  private stateMachine: StateMachine;
  private handoffService!: HumanHandoffService;
  private messageBuffer!: MessageBuffer;
  private activeConversations: Map<string, StateContext> = new Map();

  constructor() {
    this.stateMachine = new StateMachine();
    this.initializeServices();
  }

  private async initializeServices(): Promise<void> {
    const redis = await getRedis();
    if (!redis) {
      throw new Error('Failed to initialize Redis connection');
    }
    this.handoffService = new HumanHandoffService(redis, pool);
    this.messageBuffer = new MessageBuffer(redis);
  }

  async processMessage(input: ConversationMessage): Promise<ConversationResponse> {
    try {
      const { phone, message, tenant_id, user_name } = input;
      
      logger.info(`Processing message from ${phone}: ${message}`);

      // Verificar se handoff está ativo
      const handoffActive = await this.handoffService.isHandoffActive(phone);
      if (handoffActive) {
        logger.info(`Handoff active for ${phone}, skipping bot response`);
        return {
          shouldRespond: false,
          state: 'HUMAN_HANDOFF',
          handoffActive: true
        };
      }

      // Carregar ou criar contexto da conversa
      let context = this.activeConversations.get(phone);
      if (!context) {
        context = await this.stateMachine.loadContext(phone, tenant_id);
        
        // Configurar informações do usuário
        context.user = {
          phone,
          tenant_id,
          first_name: user_name || this.extractFirstName(user_name)
        };

        this.activeConversations.set(phone, context);
      }

      // Se é o primeiro contato, entrar no estado START
      if (context.currentState === 'START' || !context.currentState) {
        const enterResult = await this.stateMachine.enterState('START', context);
        context = enterResult.context;
        
        // Se o estado START já gerou uma resposta, retornar
        if (enterResult.reply) {
          await this.saveAndCacheContext(phone, context);
          return {
            reply: enterResult.reply,
            shouldRespond: true,
            state: enterResult.newState
          };
        }
      }

      // Processar mensagem do usuário
      const result = await this.stateMachine.processMessage(message, context);
      
      // Atualizar contexto
      context = result.context;
      context.currentState = result.newState;

      // Se houve transição de estado, executar ações de entrada
      if (result.newState !== context.currentState) {
        const enterResult = await this.stateMachine.enterState(result.newState, context);
        context = enterResult.context;
        
        // Se a entrada no novo estado gerou uma resposta, usar ela
        if (enterResult.reply && !result.reply) {
          result.reply = enterResult.reply;
        }
      }

      // Salvar contexto atualizado
      await this.saveAndCacheContext(phone, context);

      return {
        reply: result.reply,
        shouldRespond: !!result.reply,
        state: result.newState
      };

    } catch (error) {
      logger.error('Error in conversation controller:', error);
      return {
        reply: 'Desculpe, ocorreu um erro interno. Tente novamente em alguns instantes.',
        shouldRespond: true,
        state: 'START',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async resetConversation(phone: string): Promise<void> {
    try {
      logger.info(`Resetting conversation for ${phone}`);
      
      // Remover do cache local
      this.activeConversations.delete(phone);
      
      // Limpar buffer de mensagens
      await this.messageBuffer.flushBuffer(phone);
      
      // Limpar contexto salvo
      await this.stateMachine.saveContext(phone, {
        user: { phone, tenant_id: '' },
        slots: {},
        variables: {},
        currentState: 'START',
        messageHistory: []
      });
      
      logger.info(`Conversation reset completed for ${phone}`);
    } catch (error) {
      logger.error(`Error resetting conversation for ${phone}:`, error);
    }
  }

  async getConversationState(phone: string): Promise<StateContext | null> {
    try {
      // Primeiro verificar cache local
      const cached = this.activeConversations.get(phone);
      if (cached) {
        return cached;
      }

      // Carregar do Redis
      const context = await this.stateMachine.loadContext(phone, '');
      return context.currentState ? context : null;
    } catch (error) {
      logger.error(`Error getting conversation state for ${phone}:`, error);
      return null;
    }
  }

  async setConversationSlot(
    phone: string, 
    slotName: string, 
    value: any
  ): Promise<boolean> {
    try {
      let context = this.activeConversations.get(phone);
      if (!context) {
        context = await this.stateMachine.loadContext(phone, '');
        if (!context.currentState) {
          return false;
        }
      }

      context.slots[slotName] = value;
      await this.saveAndCacheContext(phone, context);
      
      logger.info(`Set slot ${slotName}=${value} for ${phone}`);
      return true;
    } catch (error) {
      logger.error(`Error setting slot for ${phone}:`, error);
      return false;
    }
  }

  async getConversationSlots(phone: string): Promise<Record<string, any> | null> {
    try {
      const context = await this.getConversationState(phone);
      return context?.slots || null;
    } catch (error) {
      logger.error(`Error getting slots for ${phone}:`, error);
      return null;
    }
  }

  private async saveAndCacheContext(phone: string, context: StateContext): Promise<void> {
    try {
      // Salvar no cache local
      this.activeConversations.set(phone, context);
      
      // Salvar no Redis
      await this.stateMachine.saveContext(phone, context);
    } catch (error) {
      logger.error(`Error saving context for ${phone}:`, error);
    }
  }

  private extractFirstName(fullName?: string): string | undefined {
    if (!fullName) return undefined;
    return fullName.split(' ')[0];
  }

  // Método para limpeza periódica do cache
  async cleanupCache(): Promise<void> {
    try {
      const maxCacheSize = 1000;
      const maxAge = 30 * 60 * 1000; // 30 minutos
      const now = Date.now();

      if (this.activeConversations.size > maxCacheSize) {
        // Remover entradas mais antigas
        const entries = Array.from(this.activeConversations.entries());
        const toRemove = entries
          .sort((a, b) => {
            const aTime = a[1].messageHistory.length > 0 ? now : 0;
            const bTime = b[1].messageHistory.length > 0 ? now : 0;
            return aTime - bTime;
          })
          .slice(0, entries.length - maxCacheSize);

        for (const [phone] of toRemove) {
          this.activeConversations.delete(phone);
        }

        logger.info(`Cleaned up ${toRemove.length} cached conversations`);
      }
    } catch (error) {
      logger.error('Error cleaning up cache:', error);
    }
  }

  // Estatísticas para monitoramento
  getStats(): {
    activeConversations: number;
    cacheSize: number;
  } {
    return {
      activeConversations: this.activeConversations.size,
      cacheSize: this.activeConversations.size
    };
  }
}

// Singleton instance
export const conversationController = new ConversationController();

// Limpeza periódica do cache (a cada 15 minutos)
setInterval(() => {
  conversationController.cleanupCache();
}, 15 * 60 * 1000);