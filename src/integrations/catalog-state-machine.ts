/**
 * Integração entre o módulo de catálogo e a máquina de estados principal
 * 
 * Este arquivo conecta:
 * - CatalogDisambiguationMiddleware com a máquina de estados
 * - Estados de desambiguação (CATALOG_DISAMBIGUATION, CATALOG_WAIT_CHOICE)
 * - Persistência de slots e contexto de sessão
 * - Métricas e observabilidade
 */

import { Request, Response, NextFunction } from 'express';
import { getDisambiguationMiddleware } from '../middleware/catalog-disambiguation-middleware';
import { getCatalogDisambiguationService } from '../services/catalog-disambiguation-service';
import { logger } from '../utils/logger';
import { Counter, Gauge, Summary, register } from 'prom-client';

// =============================================================================
// MÉTRICAS PROMETHEUS
// =============================================================================

const stateMachineTransitions = new Counter({
  name: 'state_machine_transitions_total',
  help: 'Total de transições da máquina de estados',
  labelNames: ['from_state', 'to_state', 'trigger'],
  registers: [register]
});

const catalogDisambiguationDuration = new Summary({
  name: 'catalog_disambiguation_duration_seconds',
  help: 'Duração do processo de desambiguação',
  labelNames: ['result_type'],
  registers: [register]
});

const activeDisambiguationSessions = new Gauge({
  name: 'catalog_disambiguation_active_sessions',
  help: 'Número de sessões ativas de desambiguação',
  registers: [register]
});

// =============================================================================
// INTERFACES
// =============================================================================

interface StateMachineContext {
  currentState: string;
  previousState?: string;
  slots: Record<string, any>;
  sessionId: string;
  userId: string;
  metadata: Record<string, any>;
}

interface StateTransition {
  fromState: string;
  toState: string;
  trigger: string;
  conditions?: Record<string, any>;
  actions?: string[];
}

interface DisambiguationResult {
  shouldIntercept: boolean;
  newState?: string;
  response?: string;
  slots?: Record<string, any>;
  metadata?: Record<string, any>;
}

// =============================================================================
// CLASSE PRINCIPAL DE INTEGRAÇÃO
// =============================================================================

export class CatalogStateMachineIntegration {
  private middleware = getDisambiguationMiddleware();
  private service = getCatalogDisambiguationService();
  private isInitialized = false;

  /**
   * Inicializa a integração
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      logger.info('Inicializando integração catálogo-máquina de estados');
      
      // Verificar se serviços estão disponíveis
      await this.middleware.getStats();
      await this.service.getStats();
      
      this.isInitialized = true;
      logger.info('Integração catálogo-máquina de estados inicializada');
      
    } catch (error) {
      logger.error('Erro ao inicializar integração catálogo-máquina de estados', { error });
      throw error;
    }
  }

  /**
   * Middleware Express para interceptar transições de estado
   */
  createStateMachineMiddleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!this.isInitialized) {
          return next();
        }

        const context = this.extractStateMachineContext(req);
        if (!context) {
          return next();
        }

        // Verificar se deve interceptar para desambiguação
        const result = await this.processStateTransition(context, req.body.message);
        
        if (result.shouldIntercept) {
          // Interceptar e processar via desambiguação
          await this.handleDisambiguationIntercept(req, res, result);
          return;
        }

        // Continuar fluxo normal
        next();
        
      } catch (error) {
        logger.error('Erro no middleware de integração', { error });
        next(error);
      }
    };
  }

  /**
   * Processa transição de estado e determina se deve interceptar
   */
  private async processStateTransition(
    context: StateMachineContext, 
    userMessage: string
  ): Promise<DisambiguationResult> {
    const timer = catalogDisambiguationDuration.startTimer();
    
    try {
      // Estados que podem ser interceptados para desambiguação
      const interceptableStates = [
        'VALIDATE_BEFORE_CONFIRM',
        'COLLECT_SERVICE_INFO',
        'MENU_CHOICE',
        'CATALOG_DISAMBIGUATION',
        'CATALOG_WAIT_CHOICE'
      ];

      if (!interceptableStates.includes(context.currentState)) {
        timer({ result_type: 'no_intercept' });
        return { shouldIntercept: false };
      }

      // Verificar se já está em fluxo de desambiguação
      if (context.currentState.startsWith('CATALOG_')) {
        const result = await this.middleware.handleDisambiguationState(
          {
            current_state: context.currentState,
            previous_state: context.previousState,
            slots: context.slots,
            user_phone: context.userId,
            session_id: context.sessionId,
            conversation_id: context.sessionId,
            input: {
              text: userMessage,
              type: 'text',
              timestamp: new Date()
            },
            metadata: context.metadata
          },
          {} as any, // req mock
          {} as any  // res mock
        );
        
        timer({ result_type: 'disambiguation_continue' });
        return {
          shouldIntercept: true,
          newState: result.next_state,
          response: result.response_text,
          slots: result.slots_to_set,
          metadata: context.metadata
        };
      }

      // Verificar se entrada requer desambiguação
      const isAmbiguous = this.service.isAmbiguous(userMessage);
      if (isAmbiguous) {
        const result = await this.service.startDisambiguation(userMessage, {
          session_id: context.sessionId,
          original_input: userMessage,
          normalized_input: userMessage.toLowerCase(),
          options: [],
          attempt_count: 0,
          user_phone: context.userId
        });
        
        timer({ result_type: 'disambiguation_start' });
        return {
          shouldIntercept: true,
          newState: 'CATALOG_DISAMBIGUATION',
          response: result.response_text,
          slots: result.slots_to_set,
          metadata: context.metadata
        };
      }

      timer({ result_type: 'no_ambiguity' });
      return { shouldIntercept: false };
      
    } catch (error) {
      timer({ result_type: 'error' });
      logger.error('Erro ao processar transição de estado', { error, context });
      return { shouldIntercept: false };
    }
  }

  /**
   * Lida com interceptação para desambiguação
   */
  private async handleDisambiguationIntercept(
    req: Request,
    res: Response,
    result: DisambiguationResult
  ): Promise<void> {
    try {
      // Atualizar métricas
      stateMachineTransitions.inc({
        from_state: req.body.currentState || 'unknown',
        to_state: result.newState || 'unknown',
        trigger: 'catalog_disambiguation'
      });

      activeDisambiguationSessions.inc();

      // Construir resposta da máquina de estados
      const response = {
        status: 'success',
        data: {
          state: result.newState,
          response: result.response,
          slots: result.slots || {},
          metadata: {
            ...result.metadata,
            intercepted_by: 'catalog_disambiguation',
            timestamp: new Date().toISOString()
          }
        }
      };

      res.json(response);
      
    } catch (error) {
      logger.error('Erro ao lidar com interceptação', { error, result });
      res.status(500).json({
        status: 'error',
        message: 'Erro interno na desambiguação'
      });
    }
  }

  /**
   * Extrai contexto da máquina de estados da requisição
   */
  private extractStateMachineContext(req: Request): StateMachineContext | null {
    try {
      const body = req.body;
      
      if (!body.sessionId || !body.currentState) {
        return null;
      }

      return {
        currentState: body.currentState,
        previousState: body.previousState,
        slots: body.slots || {},
        sessionId: body.sessionId,
        userId: body.userId || body.sessionId,
        metadata: body.metadata || {}
      };
      
    } catch (error) {
      logger.error('Erro ao extrair contexto da máquina de estados', { error });
      return null;
    }
  }

  /**
   * Registra transição de estado para métricas
   */
  recordStateTransition(transition: StateTransition): void {
    stateMachineTransitions.inc({
      from_state: transition.fromState,
      to_state: transition.toState,
      trigger: transition.trigger
    });
  }

  /**
   * Obtém estatísticas da integração
   */
  async getIntegrationStats(): Promise<Record<string, any>> {
    try {
      const [middlewareStats, serviceStats] = await Promise.all([
        this.middleware.getStats(),
        this.service.getStats()
      ]);

      return {
        integration: {
          initialized: this.isInitialized,
          active_sessions: await this.getActiveSessionsCount()
        },
        middleware: middlewareStats,
        service: serviceStats,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      logger.error('Erro ao obter estatísticas de integração', { error });
      return {
        integration: {
          initialized: this.isInitialized,
          error: error instanceof Error ? error.message : String(error)
        },
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Obtém número de sessões ativas
   */
  private async getActiveSessionsCount(): Promise<number> {
    try {
      const stats = await this.middleware.getStats();
      return stats.active_sessions || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Limpa recursos e sessões
   */
  async cleanup(): Promise<void> {
    try {
      logger.info('Limpando recursos da integração catálogo-máquina de estados');
      
      await this.middleware.clearAllSessions();
      await this.service.clearCache();
      
      activeDisambiguationSessions.set(0);
      
      logger.info('Recursos da integração limpos');
      
    } catch (error) {
      logger.error('Erro ao limpar recursos da integração', { error });
    }
  }
}

// =============================================================================
// INSTÂNCIA SINGLETON
// =============================================================================

let integrationInstance: CatalogStateMachineIntegration | null = null;

/**
 * Obtém instância singleton da integração
 */
export function getCatalogStateMachineIntegration(): CatalogStateMachineIntegration {
  if (!integrationInstance) {
    integrationInstance = new CatalogStateMachineIntegration();
  }
  return integrationInstance;
}

/**
 * Inicializa a integração
 */
export async function initializeCatalogStateMachineIntegration(): Promise<void> {
  const integration = getCatalogStateMachineIntegration();
  await integration.initialize();
}

/**
 * Middleware Express para usar na aplicação
 */
export function createCatalogStateMachineMiddleware() {
  const integration = getCatalogStateMachineIntegration();
  return integration.createStateMachineMiddleware();
}

/**
 * Limpa recursos da integração
 */
export async function cleanupCatalogStateMachineIntegration(): Promise<void> {
  if (integrationInstance) {
    await integrationInstance.cleanup();
    integrationInstance = null;
  }
}