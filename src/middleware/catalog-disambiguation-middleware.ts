/**
 * Middleware de Integração - Desambiguação por Catálogo
 * 
 * Conecta o serviço de desambiguação com a máquina de estados principal,
 * gerenciando transições, contexto e persistência de dados.
 * 
 * @author SyncBelle Dev
 * @version 1.0
 */

import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { 
  CatalogDisambiguationService, 
  DisambiguationContext, 
  DisambiguationResult,
  getCatalogDisambiguationService 
} from '../services/catalog-disambiguation-service';
import { logger } from '../utils/logger';
import { promClient } from '../utils/metrics';

// =============================================================================
// INTERFACES E TIPOS
// =============================================================================

export interface StateMachineContext {
  current_state: string;
  previous_state?: string;
  slots: Record<string, any>;
  user_phone: string;
  session_id: string;
  conversation_id: string;
  input: {
    text: string;
    type: 'text' | 'audio' | 'button';
    timestamp: Date;
  };
  metadata: Record<string, any>;
}

export interface DisambiguationSession {
  context: DisambiguationContext;
  options: any[];
  attempt_count: number;
  created_at: Date;
  expires_at: Date;
}

export interface MiddlewareConfig {
  session_ttl: number; // TTL da sessão em segundos
  max_attempts: number; // Máximo de tentativas de desambiguação
  cache_prefix: string; // Prefixo para chaves Redis
  fallback_state: string; // Estado de fallback
  return_states: Record<string, string>; // Mapeamento de estados de retorno
}

// =============================================================================
// MÉTRICAS
// =============================================================================

const metrics = {
  middlewareInvocations: new promClient.Counter({
    name: 'disambiguation_middleware_invocations_total',
    help: 'Total de invocações do middleware de desambiguação',
    labelNames: ['state', 'action']
  }),
  
  sessionTransitions: new promClient.Counter({
    name: 'disambiguation_session_transitions_total',
    help: 'Total de transições de estado na desambiguação',
    labelNames: ['from_state', 'to_state']
  }),
  
  sessionDuration: new promClient.Histogram({
    name: 'disambiguation_session_duration_seconds',
    help: 'Duração das sessões de desambiguação',
    buckets: [1, 5, 10, 30, 60, 120]
  }),
  
  errorRate: new promClient.Counter({
    name: 'disambiguation_errors_total',
    help: 'Total de erros no processo de desambiguação',
    labelNames: ['error_type', 'state']
  })
};

// =============================================================================
// MIDDLEWARE PRINCIPAL
// =============================================================================

export class CatalogDisambiguationMiddleware {
  private disambiguationService: CatalogDisambiguationService;
  private redis: Redis;
  private config: MiddlewareConfig;

  constructor(
    db: Pool, 
    redis: Redis, 
    config: Partial<MiddlewareConfig> = {}
  ) {
    this.redis = redis;
    this.disambiguationService = getCatalogDisambiguationService(db, redis);
    
    this.config = {
      session_ttl: config.session_ttl || 1800, // 30 minutos
      max_attempts: config.max_attempts || 3,
      cache_prefix: config.cache_prefix || 'disambig_session:',
      fallback_state: config.fallback_state || 'FALLBACK_MANUAL_INPUT',
      return_states: config.return_states || {
        'COLLECT_SERVICE': 'VALIDATE_BEFORE_CONFIRM',
        'VALIDATE_BEFORE_CONFIRM': 'SCHEDULE_APPOINTMENT',
        'default': 'VALIDATE_BEFORE_CONFIRM'
      }
    };
  }

  /**
   * Middleware principal para interceptar estados de desambiguação
   */
  public handle() {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const context = req.body as StateMachineContext;
        
        // Verificar se deve interceptar para desambiguação
        if (this.shouldIntercept(context)) {
          await this.handleDisambiguation(context, req, res);
          return;
        }
        
        // Verificar se está em estado de desambiguação
        if (this.isDisambiguationState(context.current_state)) {
          await this.handleDisambiguationState(context, req, res);
          return;
        }
        
        // Continuar fluxo normal
        next();
        
      } catch (error) {
        logger.error('Erro no middleware de desambiguação', {
          error: error.message,
          stack: error.stack,
          request_body: req.body
        });
        
        metrics.errorRate.inc({
          error_type: 'middleware_error',
          state: req.body?.current_state || 'unknown'
        });
        
        // Fallback para fluxo normal em caso de erro
        next();
      }
    };
  }

  /**
   * Verifica se deve interceptar para iniciar desambiguação
   */
  private shouldIntercept(context: StateMachineContext): boolean {
    const input = context.input.text;
    
    // Verificar se entrada é ambígua
    if (!this.disambiguationService.isAmbiguous(input)) {
      return false;
    }
    
    // Verificar estados que permitem interceptação
    const interceptStates = [
      'COLLECT_SERVICE',
      'VALIDATE_BEFORE_CONFIRM',
      'PROCESS_SERVICE_INPUT'
    ];
    
    return interceptStates.includes(context.current_state);
  }

  /**
   * Verifica se está em estado de desambiguação
   */
  private isDisambiguationState(state: string): boolean {
    const disambiguationStates = [
      'CATALOG_DISAMBIGUATION',
      'CATALOG_WAIT_CHOICE',
      'CATALOG_WAIT_CONFIRMATION',
      'FALLBACK_MANUAL_INPUT'
    ];
    
    return disambiguationStates.includes(state);
  }

  /**
   * Manipula início do processo de desambiguação
   */
  private async handleDisambiguation(
    context: StateMachineContext,
    req: Request,
    res: Response
  ): Promise<void> {
    const timer = metrics.sessionDuration.startTimer();
    
    try {
      metrics.middlewareInvocations.inc({
        state: context.current_state,
        action: 'start_disambiguation'
      });
      
      // Criar contexto de desambiguação
      const disambigContext: Partial<DisambiguationContext> = {
        original_input: context.input.text,
        normalized_input: this.disambiguationService.normalizeServiceName(context.input.text),
        attempt_count: 1,
        return_state: this.getReturnState(context.current_state),
        user_phone: context.user_phone,
        session_id: context.session_id
      };
      
      // Iniciar desambiguação
      const result = await this.disambiguationService.startDisambiguation(
        context.input.text,
        disambigContext
      );
      
      // Salvar sessão se necessário
      if (result.success && result.next_state !== 'FALLBACK_MANUAL_INPUT') {
        await this.saveDisambiguationSession(
          context.session_id,
          disambigContext as DisambiguationContext,
          [] // Opções serão salvas no próximo estado
        );
      }
      
      // Preparar resposta
      const response = this.buildStateResponse(
        context,
        result.next_state,
        result.response_text,
        result.slots_to_set
      );
      
      metrics.sessionTransitions.inc({
        from_state: context.current_state,
        to_state: result.next_state
      });
      
      res.json(response);
      
    } catch (error) {
      logger.error('Erro ao iniciar desambiguação', {
        context,
        error: error.message
      });
      
      metrics.errorRate.inc({
        error_type: 'start_disambiguation_error',
        state: context.current_state
      });
      
      // Fallback para estado manual
      const fallbackResponse = this.buildStateResponse(
        context,
        this.config.fallback_state,
        'Ocorreu um erro. Por favor, me diga qual serviço você gostaria de agendar.'
      );
      
      res.json(fallbackResponse);
    } finally {
      timer();
    }
  }

  /**
   * Manipula estados de desambiguação
   */
  private async handleDisambiguationState(
    context: StateMachineContext,
    req: Request,
    res: Response
  ): Promise<void> {
    try {
      metrics.middlewareInvocations.inc({
        state: context.current_state,
        action: 'handle_disambiguation_state'
      });
      
      let result: DisambiguationResult;
      
      switch (context.current_state) {
        case 'CATALOG_WAIT_CHOICE':
          result = await this.handleNumericChoice(context);
          break;
          
        case 'CATALOG_WAIT_CONFIRMATION':
          result = await this.handleConfirmation(context);
          break;
          
        case 'FALLBACK_MANUAL_INPUT':
          result = await this.handleManualInput(context);
          break;
          
        default:
          throw new Error(`Estado de desambiguação não reconhecido: ${context.current_state}`);
      }
      
      // Limpar sessão se processo foi concluído
      if (result.success && !this.isDisambiguationState(result.next_state)) {
        await this.clearDisambiguationSession(context.session_id);
      }
      
      // Preparar resposta
      const response = this.buildStateResponse(
        context,
        result.next_state,
        result.response_text,
        result.slots_to_set
      );
      
      metrics.sessionTransitions.inc({
        from_state: context.current_state,
        to_state: result.next_state
      });
      
      res.json(response);
      
    } catch (error) {
      logger.error('Erro ao processar estado de desambiguação', {
        state: context.current_state,
        context,
        error: error.message
      });
      
      metrics.errorRate.inc({
        error_type: 'disambiguation_state_error',
        state: context.current_state
      });
      
      // Fallback
      const fallbackResponse = this.buildStateResponse(
        context,
        this.config.fallback_state,
        'Ocorreu um erro. Vamos tentar novamente.'
      );
      
      res.json(fallbackResponse);
    }
  }

  /**
   * Manipula escolha numérica
   */
  private async handleNumericChoice(context: StateMachineContext): Promise<DisambiguationResult> {
    // Recuperar sessão
    const session = await this.getDisambiguationSession(context.session_id);
    if (!session) {
      throw new Error('Sessão de desambiguação não encontrada');
    }
    
    // Verificar se é escolha numérica válida
    if (!this.disambiguationService.isNumericChoice(context.input.text)) {
      return {
        success: false,
        next_state: 'CATALOG_WAIT_CHOICE',
        response_text: 'Por favor, responda com **1**, **2** ou **3**.'
      };
    }
    
    // Processar escolha
    return await this.disambiguationService.processNumericChoice(
      context.input.text,
      session.options,
      session.context
    );
  }

  /**
   * Manipula confirmação sim/não
   */
  private async handleConfirmation(context: StateMachineContext): Promise<DisambiguationResult> {
    const input = context.input.text.toLowerCase().trim();
    
    // Padrões de confirmação
    const affirmativePatterns = [
      /^\s*(sim|s|yes|y|ok|confirmo|confirmar)\s*$/i,
      /^\s*(1|um)\s*$/i
    ];
    
    const negativePatterns = [
      /^\s*(não|nao|n|no|cancelar|cancel)\s*$/i,
      /^\s*(2|dois)\s*$/i
    ];
    
    const isAffirmative = affirmativePatterns.some(pattern => pattern.test(input));
    const isNegative = negativePatterns.some(pattern => pattern.test(input));
    
    if (isAffirmative) {
      // Confirmar opção única
      const session = await this.getDisambiguationSession(context.session_id);
      if (!session || !session.options[0]) {
        throw new Error('Opção para confirmação não encontrada');
      }
      
      const selectedService = session.options[0];
      
      return {
        success: true,
        selected_service: selectedService,
        next_state: session.context.return_state || 'VALIDATE_BEFORE_CONFIRM',
        response_text: `✅ Perfeito! Anotei **${selectedService.nomeservico}** para seguirmos.`,
        slots_to_set: {
          service_id: selectedService.servicoid,
          service_name: selectedService.nomeservico,
          service_norm: selectedService.nomeservico_normalizado,
          professional_id: selectedService.profissionalid,
          service_price: selectedService.preco,
          service_duration: selectedService.duracao,
          category: selectedService.categoria
        }
      };
    }
    
    if (isNegative) {
      // Rejeitar e ir para entrada manual
      return {
        success: false,
        next_state: 'FALLBACK_MANUAL_INPUT',
        response_text: 'Sem problemas! Me diga qual serviço você gostaria de agendar.'
      };
    }
    
    // Resposta inválida
    return {
      success: false,
      next_state: 'CATALOG_WAIT_CONFIRMATION',
      response_text: 'Por favor, responda **sim** para confirmar ou **não** para escolher outro serviço.'
    };
  }

  /**
   * Manipula entrada manual
   */
  private async handleManualInput(context: StateMachineContext): Promise<DisambiguationResult> {
    const session = await this.getDisambiguationSession(context.session_id);
    const disambigContext = session?.context || {
      user_phone: context.user_phone,
      session_id: context.session_id,
      return_state: this.getReturnState('FALLBACK_MANUAL_INPUT')
    } as DisambiguationContext;
    
    return await this.disambiguationService.processManualInput(
      context.input.text,
      disambigContext
    );
  }

  /**
   * Salva sessão de desambiguação no Redis
   */
  private async saveDisambiguationSession(
    sessionId: string,
    context: DisambiguationContext,
    options: any[]
  ): Promise<void> {
    try {
      const session: DisambiguationSession = {
        context,
        options,
        attempt_count: context.attempt_count || 1,
        created_at: new Date(),
        expires_at: new Date(Date.now() + this.config.session_ttl * 1000)
      };
      
      const key = `${this.config.cache_prefix}${sessionId}`;
      await this.redis.setex(
        key,
        this.config.session_ttl,
        JSON.stringify(session)
      );
      
      logger.debug('Sessão de desambiguação salva', {
        session_id: sessionId,
        options_count: options.length,
        ttl: this.config.session_ttl
      });
      
    } catch (error) {
      logger.error('Erro ao salvar sessão de desambiguação', {
        session_id: sessionId,
        error: error.message
      });
    }
  }

  /**
   * Recupera sessão de desambiguação do Redis
   */
  public async getDisambiguationSession(sessionId: string): Promise<DisambiguationSession | null> {
    try {
      const key = `${this.config.cache_prefix}${sessionId}`;
      const data = await this.redis.get(key);
      
      if (!data) {
        return null;
      }
      
      const session = JSON.parse(data) as DisambiguationSession;
      
      // Verificar se sessão expirou
      if (new Date() > new Date(session.expires_at)) {
        await this.clearDisambiguationSession(sessionId);
        return null;
      }
      
      return session;
      
    } catch (error) {
      logger.error('Erro ao recuperar sessão de desambiguação', {
        session_id: sessionId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Remove sessão de desambiguação
   */
  private async clearDisambiguationSession(sessionId: string): Promise<void> {
    try {
      const key = `${this.config.cache_prefix}${sessionId}`;
      await this.redis.del(key);
      
      logger.debug('Sessão de desambiguação removida', {
        session_id: sessionId
      });
      
    } catch (error) {
      logger.error('Erro ao remover sessão de desambiguação', {
        session_id: sessionId,
        error: error.message
      });
    }
  }

  /**
   * Determina estado de retorno baseado no estado atual
   */
  private getReturnState(currentState: string): string {
    return this.config.return_states[currentState] || this.config.return_states.default;
  }

  /**
   * Constrói resposta da máquina de estados
   */
  private buildStateResponse(
    context: StateMachineContext,
    nextState: string,
    responseText: string,
    slotsToSet?: Record<string, any>
  ): any {
    const response = {
      current_state: nextState,
      previous_state: context.current_state,
      response: {
        text: responseText,
        type: 'text',
        timestamp: new Date().toISOString()
      },
      slots: {
        ...context.slots,
        ...(slotsToSet || {})
      },
      metadata: {
        ...context.metadata,
        disambiguation_processed: true,
        processing_timestamp: new Date().toISOString()
      }
    };
    
    return response;
  }

  /**
   * Obtém estatísticas do middleware
   */
  public async getStats(): Promise<Record<string, any>> {
    try {
      // Contar sessões ativas
      const activeSessionKeys = await this.redis.keys(`${this.config.cache_prefix}*`);
      
      return {
        active_sessions: activeSessionKeys.length,
        config: this.config,
        service_stats: await this.disambiguationService.getStats()
      };
    } catch (error) {
      logger.error('Erro ao obter estatísticas do middleware', {
        error: error.message
      });
      return {};
    }
  }

  /**
   * Limpa todas as sessões de desambiguação
   */
  public async clearAllSessions(): Promise<number> {
    try {
      const keys = await this.redis.keys(`${this.config.cache_prefix}*`);
      
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
      
      logger.info('Todas as sessões de desambiguação foram limpas', {
        sessions_cleared: keys.length
      });
      
      return keys.length;
    } catch (error) {
      logger.error('Erro ao limpar sessões de desambiguação', {
        error: error.message
      });
      return 0;
    }
  }
}

// =============================================================================
// FACTORY E HELPERS
// =============================================================================

let middlewareInstance: CatalogDisambiguationMiddleware | null = null;

export function createDisambiguationMiddleware(
  db: Pool,
  redis: Redis,
  config?: Partial<MiddlewareConfig>
): CatalogDisambiguationMiddleware {
  middlewareInstance = new CatalogDisambiguationMiddleware(db, redis, config);
  return middlewareInstance;
}

export function getDisambiguationMiddleware(): CatalogDisambiguationMiddleware {
  if (!middlewareInstance) {
    throw new Error('Middleware de desambiguação não foi inicializado');
  }
  return middlewareInstance;
}

export function resetDisambiguationMiddleware(): void {
  middlewareInstance = null;
}