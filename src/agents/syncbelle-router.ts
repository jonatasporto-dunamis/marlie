import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { MessageBuffer } from '../services/message-buffer';
import { HumanHandoffService } from '../services/human-handoff';
import { ValidationService } from '../services/validation-service';
import { ResponseTemplateService, TemplateContext } from '../services/response-templates';
import { CatalogService } from '../services/catalog-service';
import { TrinksService } from '../services/trinks-service';
import { NLPPatterns } from '../core/nlp-patterns';

export interface SyncbelleConfig {
  temperature: number;
  top_p: number;
  max_tokens: number;
  buffer_window_seconds: number;
  safety: {
    profanity_filter: 'mild' | 'strict' | 'off';
  };
}

export interface UserSession {
  phone: string;
  state: 'initial' | 'menu_shown' | 'awaiting_option' | 'processing_schedule' | 'processing_info' | 'confirming_service' | 'completed';
  last_message_at: Date;
  context: TemplateContext;
  selected_option?: '1' | '2';
  pending_service_id?: string;
  conversation_history: ConversationMessage[];
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export interface SyncbelleResponse {
  message: string;
  action: 'send_message' | 'transfer_human' | 'schedule_appointment' | 'provide_info' | 'request_clarification';
  metadata?: {
    template_used?: string;
    confidence?: number;
    detected_intent?: string;
    suggestions?: any[];
  };
}

export class SyncbelleRouterAgent {
  private redis: Redis;
  private db: Pool;
  private config: SyncbelleConfig;
  private messageBuffer: MessageBuffer;
  private handoffService: HumanHandoffService;
  private validationService: ValidationService;
  private templateService: ResponseTemplateService;
  private catalogService: CatalogService;
  private trinksService: TrinksService;
  private nlpPatterns: NLPPatterns;
  private sessions: Map<string, UserSession> = new Map();
  
  private readonly SESSION_TTL_HOURS = 2;
  private readonly SESSION_KEY_PREFIX = 'marlie_session:';

  constructor(
    redis: Redis,
    db: Pool,
    messageBuffer: MessageBuffer,
    handoffService: HumanHandoffService,
    validationService: ValidationService,
    templateService: ResponseTemplateService,
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
    this.messageBuffer = messageBuffer;
    this.handoffService = handoffService;
    this.validationService = validationService;
    this.templateService = templateService;
    this.catalogService = catalogService;
    this.trinksService = trinksService;
    this.nlpPatterns = new NLPPatterns();
  }

  /**
   * Processa mensagem recebida do usuário
   */
  async processMessage(
    phone: string,
    message: string,
    tenantId: string,
    userInfo?: { first_name?: string; full_name?: string }
  ): Promise<MarlieResponse> {
    try {
      // 1. Verifica handoff humano
      const isHandoffActive = await this.handoffService.isHandoffActive(phone);
      if (isHandoffActive) {
        return {
          message: this.templateService.render('human_handoff_active', 
            this.templateService.createUserContext(phone, userInfo?.first_name, userInfo?.full_name)
          ),
          action: 'transfer_human',
          metadata: { template_used: 'human_handoff_active' }
        };
      }

      // 2. Aplica buffer temporal para agrupar mensagens
      const bufferedMessage = await this.messageBuffer.addMessage(phone, message);
      if (!bufferedMessage.isComplete) {
        // Mensagem ainda está no buffer, não processa ainda
        return {
          message: '', // Não responde ainda
          action: 'send_message',
          metadata: { template_used: 'buffer_waiting' }
        };
      }

      // 3. Usa mensagem completa do buffer
      const completeMessage = bufferedMessage.completeMessage || message;
      
      // 4. Obtém ou cria sessão do usuário
      const session = await this.getOrCreateSession(phone, tenantId, userInfo);
      
      // 5. Adiciona mensagem ao histórico
      session.conversation_history.push({
        role: 'user',
        content: completeMessage,
        timestamp: new Date()
      });
      
      // 6. Processa baseado no estado atual
      const response = await this.processBasedOnState(session, completeMessage, tenantId);
      
      // 7. Adiciona resposta ao histórico
      session.conversation_history.push({
        role: 'assistant',
        content: response.message,
        timestamp: new Date()
      });
      
      // 8. Salva sessão atualizada
      await this.saveSession(session);
      
      return response;
    } catch (error) {
      logger.error(`Error processing message for ${phone}:`, error);
      return {
        message: 'Desculpe, ocorreu um erro interno. Tente novamente em alguns instantes.',
        action: 'send_message',
        metadata: { template_used: 'error_occurred' }
      };
    }
  }

  /**
   * Processa mensagem baseada no estado atual da sessão
   */
  private async processBasedOnState(
    session: UserSession,
    message: string,
    tenantId: string
  ): Promise<MarlieResponse> {
    const normalizedMessage = message.toLowerCase().trim();
    
    switch (session.state) {
      case 'initial':
        return await this.handleInitialState(session);
        
      case 'menu_shown':
      case 'awaiting_option':
        return await this.handleMenuResponse(session, normalizedMessage, tenantId);
        
      case 'processing_schedule':
        return await this.handleScheduleRequest(session, message, tenantId);
        
      case 'processing_info':
        return await this.handleInfoRequest(session, normalizedMessage);
        
      case 'confirming_service':
        return await this.handleServiceConfirmation(session, normalizedMessage, tenantId);
        
      default:
        // Reset para estado inicial se estado inválido
        session.state = 'initial';
        return await this.handleInitialState(session);
    }
  }

  /**
   * Manipula estado inicial - mostra menu de boas-vindas
   */
  private async handleInitialState(session: UserSession): Promise<MarlieResponse> {
    session.state = 'menu_shown';
    
    const message = this.templateService.render('menu_welcome', session.context);
    
    return {
      message,
      action: 'send_message',
      metadata: {
          template_used: 'menu_welcome'
        }
    };
  }

  /**
   * Manipula resposta ao menu principal
   */
  private async handleMenuResponse(
    session: UserSession,
    message: string,
    tenantId: string
  ): Promise<MarlieResponse> {
    // Detecta opção usando NLP patterns
    const menuOption = this.nlpPatterns.isValidMenuOption(message);
    const schedulingIntent = this.nlpPatterns.hasSchedulingIntent(message);
    
    const option1Match = menuOption === '1';
    const option2Match = menuOption === '2';
    const explicitSchedule = schedulingIntent.hasIntent && schedulingIntent.isExplicit;
    const ambiguousSchedule = schedulingIntent.hasIntent && !schedulingIntent.isExplicit;
    
    // Opção 1: Agendar
    if (option1Match || explicitSchedule) {
      session.selected_option = '1';
      session.state = 'processing_schedule';
      
      return {
        message: 'Perfeito! Vou ajudar você a agendar um atendimento. 📅\n\nQual serviço você gostaria de agendar?',
        action: 'send_message',
        metadata: {
          detected_intent: 'schedule',
          confidence: option1Match ? 0.9 : 0.7,
          state_transition: 'menu_shown -> processing_schedule'
        }
      };
    }
    
    // Opção 2: Informações
    if (option2Match) {
      session.selected_option = '2';
      session.state = 'processing_info';
      
      const businessInfoMessage = this.templateService.render('business_info', session.context);
      
      return {
        message: businessInfoMessage + '\n\nPrecisa de mais alguma informação?',
        action: 'provide_info',
        metadata: {
          template_used: 'business_info',
          detected_intent: 'info',
          confidence: 0.9,
          state_transition: 'menu_shown -> processing_info'
        }
      };
    }
    
    // Agendamento ambíguo - pede confirmação
    if (ambiguousSchedule) {
      const confirmMessage = this.templateService.render('confirm_intent', session.context);
      
      return {
        message: confirmMessage,
        action: 'request_clarification',
        metadata: {
          template_used: 'confirm_intent',
          detected_intent: 'ambiguous',
          confidence: 0.5
        }
      };
    }
    
    // Opção inválida
    session.state = 'awaiting_option';
    const invalidOptionMessage = this.templateService.render('invalid_option', session.context);
    
    return {
      message: invalidOptionMessage,
      action: 'request_clarification',
      metadata: {
        template_used: 'invalid_option',
        detected_intent: 'invalid',
        confidence: 0.1
      }
    };
  }

  /**
   * Manipula solicitação de agendamento
   */
  private async handleScheduleRequest(
    session: UserSession,
    message: string,
    tenantId: string
  ): Promise<MarlieResponse> {
    try {
      // Valida intenção do serviço
      const validation = await this.validationService.validateServiceIntent({
        query: message,
        tenantId
      });
      
      if (!validation.isValid) {
        if (validation.category === 'category' || validation.category === 'ambiguous') {
          // Mostra opções para escolha
          if (validation.suggestions && validation.suggestions.length > 0) {
            session.state = 'confirming_service';
            
            const context = this.templateService.addServicesToContext(
              session.context,
              validation.suggestions
            );
            
            const message = this.templateService.render('clarify_service', context);
            
            return {
              message,
              action: 'request_clarification',
              metadata: {
                template_used: 'clarify_service',
                suggestions: validation.suggestions,
                validation_category: validation.category
              }
            };
          }
        }
        
        // Validação falhou
        const message = this.templateService.render('validation_failed', session.context);
        
        return {
          message,
          action: 'request_clarification',
          metadata: {
            template_used: 'validation_failed',
            validation_reason: validation.reason
          }
        };
      }
      
      // Serviço válido - prossegue com agendamento
      if (validation.suggestions && validation.suggestions.length > 0) {
        const service = validation.suggestions[0];
        session.pending_service_id = service.id;
        
        return {
          message: `Ótima escolha! **${service.nome}** (${service.duracao}min - ${service.preco})\n\nAgora preciso que você escolha a data e horário. Que dia e horário prefere?`,
          action: 'schedule_appointment',
          metadata: {
            template_used: 'service_selected',
            confidence: validation.confidence
          }
        };
      }
      
      return {
        message: 'Não consegui identificar o serviço. Pode ser mais específico?',
        action: 'request_clarification'
      };
    } catch (error) {
      logger.error('Error handling schedule request:', error);
      return {
        message: 'Ocorreu um erro ao processar sua solicitação. Tente novamente.',
        action: 'send_message',
        metadata: { template_used: 'error_occurred' }
      };
    }
  }

  /**
   * Manipula solicitação de informações
   */
  private async handleInfoRequest(
    session: UserSession,
    message: string
  ): Promise<MarlieResponse> {
    // Verifica se quer voltar ao menu ou fazer agendamento
    const option1Match = this.nlpPatterns.isValidMenuOption(message, '1');
    const explicitSchedule = this.nlpPatterns.hasSchedulingIntent(message);
    
    if (option1Match || explicitSchedule) {
      session.selected_option = '1';
      session.state = 'processing_schedule';
      
      return {
        message: 'Perfeito! Vou ajudar você a agendar um atendimento. 📅\n\nQual serviço você gostaria de agendar?',
        action: 'send_message',
        metadata: {
          detected_intent: 'schedule'
        }
      };
    }
    
    // Fornece informações adicionais ou volta ao menu
    const businessInfo = this.templateService.render('business_info', session.context);
    
    return {
      message: businessInfo + '\n\nGostaria de agendar um atendimento? Responda **1** para Agendar.',
      action: 'provide_info',
      metadata: {
        template_used: 'business_info'
      }
    };
  }

  /**
   * Manipula confirmação de serviço
   */
  private async handleServiceConfirmation(
    session: UserSession,
    message: string,
    tenantId: string
  ): Promise<MarlieResponse> {
    // Verifica se escolheu uma das opções (1, 2, 3)
    const optionMatch = message.match(/^\s*([123])\s*$/);
    
    if (optionMatch) {
      const optionIndex = parseInt(optionMatch[1]) - 1;
      
      // Busca serviços do contexto (assumindo que foram salvos)
      const suggestions = session.context.top3;
      
      if (suggestions && suggestions[optionIndex]) {
        const selectedService = suggestions[optionIndex];
        session.pending_service_id = selectedService.id;
        session.state = 'processing_schedule';
        
        return {
          message: `Perfeito! **${selectedService.nome}** (${selectedService.duracao}min - ${selectedService.preco})\n\nAgora preciso que você escolha a data e horário. Que dia e horário prefere?`,
          action: 'schedule_appointment',
          metadata: {
            template_used: 'service_selected'
          }
        };
      }
    }
    
    // Opção inválida
    return {
      message: 'Por favor, escolha uma das opções numeradas (1, 2 ou 3) ou descreva melhor o serviço que deseja.',
      action: 'request_clarification',
      metadata: {
        template_used: 'invalid_option'
      }
    };
  }

  /**
   * Obtém ou cria sessão do usuário
   */
  private async getOrCreateSession(
    phone: string,
    tenantId: string,
    userInfo?: { first_name?: string; full_name?: string }
  ): Promise<UserSession> {
    // Tenta carregar da memória
    let session = this.sessions.get(phone);
    
    if (!session) {
      // Tenta carregar do Redis
      try {
        const sessionKey = `${this.SESSION_KEY_PREFIX}${phone}`;
        const sessionData = await this.redis.get(sessionKey);
        
        if (sessionData) {
          session = JSON.parse(sessionData);
          // Reconstrói objetos Date
          if (session) {
            session.last_message_at = new Date(session.last_message_at);
            session.conversation_history = session.conversation_history.map(msg => ({
              ...msg,
              timestamp: new Date(msg.timestamp)
            }));
          }
        }
      } catch (error) {
        logger.error(`Error loading session for ${phone}:`, error);
      }
    }
    
    // Cria nova sessão se não encontrou
    if (!session) {
      session = {
        phone,
        state: 'initial',
        last_message_at: new Date(),
        context: this.templateService.createUserContext(
          phone,
          userInfo?.first_name,
          userInfo?.full_name
        ),
        conversation_history: []
      };
    }
    
    // Atualiza timestamp
    session.last_message_at = new Date();
    
    // Salva na memória
    this.sessions.set(phone, session);
    
    return session;
  }

  /**
   * Salva sessão no Redis
   */
  private async saveSession(session: UserSession): Promise<void> {
    try {
      const sessionKey = `${this.SESSION_KEY_PREFIX}${session.phone}`;
      const ttlSeconds = this.SESSION_TTL_HOURS * 3600;
      
      await this.redis.setex(
        sessionKey,
        ttlSeconds,
        JSON.stringify(session)
      );
    } catch (error) {
      logger.error(`Error saving session for ${session.phone}:`, error);
    }
  }

  /**
   * Limpa sessão do usuário
   */
  async clearSession(phone: string): Promise<void> {
    try {
      this.sessions.delete(phone);
      
      const sessionKey = `${this.SESSION_KEY_PREFIX}${phone}`;
      await this.redis.del(sessionKey);
      
      logger.info(`Session cleared for ${phone}`);
    } catch (error) {
      logger.error(`Error clearing session for ${phone}:`, error);
    }
  }

  /**
   * Obtém estatísticas das sessões ativas
   */
  async getSessionStats(): Promise<{
    active_sessions: number;
    sessions_by_state: Record<string, number>;
    avg_conversation_length: number;
  }> {
    try {
      const pattern = `${this.SESSION_KEY_PREFIX}*`;
      const keys = await this.redis.keys(pattern);
      
      const stateCount: Record<string, number> = {};
      let totalMessages = 0;
      let sessionCount = 0;
      
      for (const key of keys) {
        const sessionData = await this.redis.get(key);
        if (sessionData) {
          try {
            const session = JSON.parse(sessionData);
            stateCount[session.state] = (stateCount[session.state] || 0) + 1;
            totalMessages += session.conversation_history.length;
            sessionCount++;
          } catch (error) {
            // Ignora sessões com dados inválidos
          }
        }
      }
      
      return {
        active_sessions: sessionCount,
        sessions_by_state: stateCount,
        avg_conversation_length: sessionCount > 0 ? totalMessages / sessionCount : 0
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

  /**
   * Limpa sessões expiradas
   */
  async cleanupExpiredSessions(): Promise<number> {
    try {
      const pattern = `${this.SESSION_KEY_PREFIX}*`;
      const keys = await this.redis.keys(pattern);
      
      let cleanedCount = 0;
      const expiryThreshold = new Date(Date.now() - this.SESSION_TTL_HOURS * 60 * 60 * 1000);
      
      for (const key of keys) {
        const sessionData = await this.redis.get(key);
        if (sessionData) {
          try {
            const session = JSON.parse(sessionData);
            const lastMessageAt = new Date(session.last_message_at);
            
            if (lastMessageAt < expiryThreshold) {
              await this.redis.del(key);
              this.sessions.delete(session.phone);
              cleanedCount++;
            }
          } catch (error) {
            // Remove sessões com dados inválidos
            await this.redis.del(key);
            cleanedCount++;
          }
        }
      }
      
      if (cleanedCount > 0) {
        logger.info(`Cleaned up ${cleanedCount} expired sessions`);
      }
      
      return cleanedCount;
    } catch (error) {
      logger.error('Error cleaning up expired sessions:', error);
      return 0;
    }
  }
}

// Factory function
export function createSyncbelleRouter(
  redis: Redis,
  db: Pool,
  messageBuffer: MessageBuffer,
  handoffService: HumanHandoffService,
  validationService: ValidationService,
  templateService: ResponseTemplateService,
  catalogService: CatalogService,
  trinksService: TrinksService,
  config?: Partial<SyncbelleConfig>
): SyncbelleRouterAgent {
  const defaultConfig: SyncbelleConfig = {
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 400,
    buffer_window_seconds: 30,
    safety: { profanity_filter: 'mild' }
  };
  
  return new SyncbelleRouterAgent(
    redis,
    db,
    messageBuffer,
    handoffService,
    validationService,
    templateService,
    catalogService,
    trinksService,
    { ...defaultConfig, ...config }
  );
}