import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { conversationController, ConversationController } from '../core/conversation-controller';
import { SyncbelleConfig, SyncbelleResponse, UserSession, ConversationMessage } from './syncbelle-router';
import { HumanHandoffService } from '../services/human-handoff';
import { MessageBuffer } from '../services/message-buffer';
import { ResponseTemplates } from '../services/response-templates';
import { ValidationService } from '../services/validation-service';
import { CatalogService } from '../services/catalog-service';
import { TrinksService } from '../services/trinks-service';

export interface StateBasedSyncbelleResponse extends SyncbelleResponse {
  state?: string;
  handoffActive?: boolean;
  contextUpdated?: boolean;
}

export class SyncbelleStateRouterAgent {
  private redis: Redis;
  private db: Pool;
  private config: SyncbelleConfig;
  private conversationController: ConversationController;
  private handoffService: HumanHandoffService;
  private messageBuffer: MessageBuffer;
  private responseTemplates: ResponseTemplates;
  private validationService: ValidationService;
  private catalogService: CatalogService;
  private trinksService: TrinksService;

  // Cache para compatibilidade com interface antiga
  private legacySessions: Map<string, UserSession> = new Map();
  private readonly SESSION_TTL_HOURS = 2;
  private readonly SESSION_KEY_PREFIX = 'marlie_session:';

  constructor(
    redis: Redis,
    db: Pool,
    messageBuffer: MessageBuffer,
    handoffService: HumanHandoffService,
    validationService: ValidationService,
    responseTemplates: ResponseTemplates,
    catalogService: CatalogService,
    trinksService: TrinksService,
    config: MarlieConfig = {
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 400,
      buffer_window_seconds: 30,
      safety: { profanity_filter: 'mild' }
    }
  ) {
    this.redis = redis;
    this.db = db;
    this.config = config;
    this.conversationController = conversationController;
    this.handoffService = handoffService;
    this.messageBuffer = messageBuffer;
    this.responseTemplates = responseTemplates;
    this.validationService = validationService;
    this.catalogService = catalogService;
    this.trinksService = trinksService;

    logger.info('MarlieStateRouterAgent initialized with state machine');
  }

  async processMessage(
    phone: string,
    message: string,
    tenantId: string,
    userInfo?: { first_name?: string; full_name?: string }
  ): Promise<StateBasedMarlieResponse> {
    try {
      logger.info(`Processing message from ${phone}: ${message}`);

      // Verificar se handoff está ativo primeiro
      const handoffActive = await this.handoffService.isHandoffActive(phone);
      if (handoffActive) {
        logger.info(`Handoff active for ${phone}, skipping bot response`);
        return {
          message: '',
          action: 'transfer_human',
          state: 'HUMAN_HANDOFF',
          handoffActive: true,
          metadata: {
            template_used: 'human_handoff_active',
            confidence: 1.0,
            detected_intent: 'human_handoff'
          }
        };
      }

      // Processar através da máquina de estados
      const result = await this.conversationController.processMessage({
        phone,
        message,
        tenant_id: tenantId,
        user_name: userInfo?.first_name || userInfo?.full_name,
        timestamp: new Date()
      });

      // Converter resposta da máquina de estados para formato Marlie
      const marlieResponse = await this.convertToMarlieResponse(result, phone, message);

      // Atualizar sessão legacy para compatibilidade
      await this.updateLegacySession(phone, tenantId, message, marlieResponse, userInfo);

      logger.info(`Response for ${phone}: ${marlieResponse.message} (state: ${result.state})`);
      return marlieResponse;

    } catch (error) {
      logger.error('Error processing message in state router:', error);
      return {
        message: 'Desculpe, ocorreu um erro interno. Tente novamente em alguns instantes.',
        action: 'send_message',
        state: 'START',
        metadata: {
          template_used: 'error_fallback',
          confidence: 0.0,
          detected_intent: 'error'
        }
      };
    }
  }

  private async convertToMarlieResponse(
    stateResult: any,
    phone: string,
    message: string
  ): Promise<StateBasedMarlieResponse> {
    const { reply, shouldRespond, state, handoffActive, error } = stateResult;

    if (error) {
      return {
        message: 'Desculpe, ocorreu um erro. Tente novamente.',
        action: 'send_message',
        state: 'START',
        metadata: {
          template_used: 'error_fallback',
          confidence: 0.0,
          detected_intent: 'error'
        }
      };
    }

    if (handoffActive) {
      return {
        message: '',
        action: 'transfer_human',
        state: 'HUMAN_HANDOFF',
        handoffActive: true,
        metadata: {
          template_used: 'human_handoff_active',
          confidence: 1.0,
          detected_intent: 'human_handoff'
        }
      };
    }

    if (!shouldRespond || !reply) {
      return {
        message: '',
        action: 'send_message',
        state,
        metadata: {
          template_used: 'no_response',
          confidence: 0.0,
          detected_intent: 'no_action'
        }
      };
    }

    // Determinar ação baseada no estado
    let action: MarlieResponse['action'] = 'send_message';
    let detectedIntent = 'unknown';
    let confidence = 0.8;

    switch (state) {
      case 'MENU_WAITING':
        detectedIntent = 'menu_display';
        confidence = 1.0;
        break;
      case 'SCHEDULING_ROUTING':
      case 'VALIDATE_BEFORE_CONFIRM':
        action = 'request_clarification';
        detectedIntent = 'schedule_request';
        confidence = 0.9;
        break;
      case 'SCHEDULING_CONFIRMED':
        action = 'schedule_appointment';
        detectedIntent = 'schedule_confirmed';
        confidence = 1.0;
        break;
      case 'INFO_ROUTING':
        action = 'provide_info';
        detectedIntent = 'info_request';
        confidence = 0.9;
        break;
      case 'CONFIRM_INTENT':
        action = 'request_clarification';
        detectedIntent = 'ambiguous_intent';
        confidence = 0.7;
        break;
    }

    return {
      message: reply,
      action,
      state,
      contextUpdated: true,
      metadata: {
        template_used: this.inferTemplateUsed(state, reply),
        confidence,
        detected_intent: detectedIntent
      }
    };
  }

  private inferTemplateUsed(state: string, reply: string): string {
    // Inferir template baseado no estado e conteúdo da resposta
    if (reply.includes('1') && reply.includes('2')) {
      return 'menu_welcome';
    }
    if (reply.includes('agend')) {
      return 'schedule_related';
    }
    if (reply.includes('informa')) {
      return 'info_related';
    }
    if (reply.includes('confirma')) {
      return 'confirmation_request';
    }
    if (reply.includes('opção')) {
      return 'invalid_option';
    }
    return `state_${state.toLowerCase()}`;
  }

  private async updateLegacySession(
    phone: string,
    tenantId: string,
    message: string,
    response: StateBasedMarlieResponse,
    userInfo?: { first_name?: string; full_name?: string }
  ): Promise<void> {
    try {
      let session = this.legacySessions.get(phone);
      
      if (!session) {
        session = {
          phone,
          state: 'initial',
          last_message_at: new Date(),
          context: {
            user: {
              phone,
              first_name: userInfo?.first_name || userInfo?.full_name?.split(' ')[0],
              tenant_id: tenantId
            }
          },
          conversation_history: []
        };
      }

      // Atualizar estado baseado na resposta da máquina de estados
      session.state = this.mapStateToLegacy(response.state || 'initial');
      session.last_message_at = new Date();
      
      // Adicionar mensagens ao histórico
      session.conversation_history.push({
        role: 'user',
        content: message,
        timestamp: new Date()
      });

      if (response.message) {
        session.conversation_history.push({
          role: 'assistant',
          content: response.message,
          timestamp: new Date()
        });
      }

      // Manter apenas últimas 20 mensagens
      if (session.conversation_history.length > 20) {
        session.conversation_history = session.conversation_history.slice(-20);
      }

      this.legacySessions.set(phone, session);
      await this.saveSession(session);
    } catch (error) {
      logger.error('Error updating legacy session:', error);
    }
  }

  private mapStateToLegacy(state: string): UserSession['state'] {
    switch (state) {
      case 'START':
        return 'initial';
      case 'MENU_WAITING':
        return 'awaiting_option';
      case 'SCHEDULING_ROUTING':
      case 'VALIDATE_BEFORE_CONFIRM':
        return 'processing_schedule';
      case 'INFO_ROUTING':
        return 'processing_info';
      case 'CONFIRM_INTENT':
        return 'awaiting_option';
      case 'SCHEDULING_CONFIRMED':
        return 'completed';
      default:
        return 'initial';
    }
  }

  private async saveSession(session: UserSession): Promise<void> {
    try {
      const key = `${this.SESSION_KEY_PREFIX}${session.phone}`;
      await this.redis.setex(
        key,
        this.SESSION_TTL_HOURS * 3600,
        JSON.stringify({
          ...session,
          last_message_at: session.last_message_at.toISOString()
        })
      );
    } catch (error) {
      logger.error('Error saving session:', error);
    }
  }

  // Métodos de compatibilidade com interface antiga
  async clearSession(phone: string): Promise<void> {
    try {
      // Limpar sessão legacy
      this.legacySessions.delete(phone);
      const key = `${this.SESSION_KEY_PREFIX}${phone}`;
      await this.redis.del(key);
      
      // Limpar contexto da máquina de estados
      await this.conversationController.resetConversation(phone);
      
      logger.info(`Session cleared for ${phone}`);
    } catch (error) {
      logger.error(`Error clearing session for ${phone}:`, error);
    }
  }

  async getSessionStats(): Promise<{
    active_sessions: number;
    sessions_by_state: Record<string, number>;
    avg_conversation_length: number;
  }> {
    try {
      const stats = this.conversationController.getStats();
      const sessionsByState: Record<string, number> = {};
      let totalMessages = 0;

      for (const session of this.legacySessions.values()) {
        sessionsByState[session.state] = (sessionsByState[session.state] || 0) + 1;
        totalMessages += session.conversation_history.length;
      }

      return {
        active_sessions: stats.activeConversations,
        sessions_by_state: sessionsByState,
        avg_conversation_length: this.legacySessions.size > 0 
          ? totalMessages / this.legacySessions.size 
          : 0
      };
    } catch (error) {
      logger.error('Error getting session stats:', error);
      return {
        active_sessions: 0,
        sessions_by_state: {},
        avg_conversation_length: 0
      };
    }
  }

  async cleanupExpiredSessions(): Promise<number> {
    try {
      const now = Date.now();
      const expiredThreshold = this.SESSION_TTL_HOURS * 60 * 60 * 1000;
      let cleanedCount = 0;

      for (const [phone, session] of this.legacySessions.entries()) {
        if (now - session.last_message_at.getTime() > expiredThreshold) {
          this.legacySessions.delete(phone);
          cleanedCount++;
        }
      }

      // Limpar cache da máquina de estados
      await this.conversationController.cleanupCache();

      if (cleanedCount > 0) {
        logger.info(`Cleaned up ${cleanedCount} expired sessions`);
      }

      return cleanedCount;
    } catch (error) {
      logger.error('Error cleaning up expired sessions:', error);
      return 0;
    }
  }

  // Métodos específicos da máquina de estados
  async setConversationSlot(
    phone: string,
    slotName: string,
    value: any
  ): Promise<boolean> {
    return await this.conversationController.setConversationSlot(phone, slotName, value);
  }

  async getConversationSlots(phone: string): Promise<Record<string, any> | null> {
    return await this.conversationController.getConversationSlots(phone);
  }

  async getConversationState(phone: string): Promise<string | null> {
    const context = await this.conversationController.getConversationState(phone);
    return context?.currentState || null;
  }
}

export function createMarlieStateRouter(
  redis: Redis,
  db: Pool,
  messageBuffer: MessageBuffer,
  handoffService: HumanHandoffService,
  validationService: ValidationService,
  responseTemplates: ResponseTemplates,
  catalogService: CatalogService,
  trinksService: TrinksService,
  config?: Partial<MarlieConfig>
): MarlieStateRouterAgent {
  const fullConfig: MarlieConfig = {
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 400,
    buffer_window_seconds: 30,
    safety: { profanity_filter: 'mild' },
    ...config
  };

  return new MarlieStateRouterAgent(
    redis,
    db,
    messageBuffer,
    handoffService,
    validationService,
    responseTemplates,
    catalogService,
    trinksService,
    fullConfig
  );
}