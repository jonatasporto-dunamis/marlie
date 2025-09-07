/**
 * Integração entre o módulo de upsell e a máquina de estados principal
 * 
 * Este arquivo conecta:
 * - Estados de upsell (UPSELL_WAIT, UPSELL_END)
 * - Processamento de respostas de aceite/recusa
 * - Persistência de contexto e métricas
 * - Observabilidade e logging
 */

import { Request, Response, NextFunction } from 'express';
import { UpsellService } from '../services/upsell-service';
import { UpsellScheduler } from '../services/upsell-scheduler';
import { logger } from '../utils/logger';
import { Counter, Gauge, Summary, register } from 'prom-client';

// =============================================================================
// MÉTRICAS PROMETHEUS
// =============================================================================

const upsellStateMachineTransitions = new Counter({
  name: 'upsell_state_machine_transitions_total',
  help: 'Total de transições da máquina de estados de upsell',
  labelNames: ['from_state', 'to_state', 'trigger', 'variant'],
  registers: [register]
});

const upsellProcessingDuration = new Summary({
  name: 'upsell_processing_duration_seconds',
  help: 'Duração do processamento de upsell',
  labelNames: ['result_type', 'variant'],
  registers: [register]
});

const activeUpsellSessions = new Gauge({
  name: 'upsell_active_sessions',
  help: 'Número de sessões ativas de upsell',
  registers: [register]
});

const upsellRevenue = new Counter({
  name: 'upsell_revenue_brl_total',
  help: 'Receita total de upsells em BRL',
  labelNames: ['service', 'variant'],
  registers: [register]
});

// =============================================================================
// INTERFACES
// =============================================================================

interface UpsellStateMachineContext {
  currentState: string;
  previousState?: string;
  slots: Record<string, any>;
  sessionId: string;
  userId: string;
  conversationId: string;
  appointmentId?: string;
  addon?: {
    id: string;
    nome: string;
    preco: string;
    preco_num: number;
    duracao: number;
  };
  variant?: {
    copy: 'A' | 'B';
    position: 'IMMEDIATE' | 'DELAY10';
  };
  metadata: Record<string, any>;
}

interface UpsellStateTransition {
  fromState: string;
  toState: string;
  trigger: string;
  action?: 'accepted' | 'declined' | 'timeout';
  variant?: string;
}

interface UpsellProcessingResult {
  shouldIntercept: boolean;
  newState?: string;
  response?: string;
  slots?: Record<string, any>;
  metadata?: Record<string, any>;
  action?: 'accepted' | 'declined' | 'ignored';
  revenue?: number;
}

// =============================================================================
// CLASSE PRINCIPAL DE INTEGRAÇÃO
// =============================================================================

export class UpsellStateMachineIntegration {
  private upsellService: UpsellService;
  private scheduler: UpsellScheduler;
  private isInitialized = false;

  constructor(upsellService: UpsellService, scheduler: UpsellScheduler) {
    this.upsellService = upsellService;
    this.scheduler = scheduler;
  }

  /**
   * Inicializa a integração
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      logger.info('Inicializando integração upsell-máquina de estados');
      
      // Verificar se serviços estão disponíveis
      if (!this.upsellService || !this.scheduler) {
        throw new Error('Serviços de upsell não disponíveis');
      }
      
      this.isInitialized = true;
      logger.info('Integração upsell-máquina de estados inicializada');
      
    } catch (error) {
      logger.error('Erro ao inicializar integração upsell-máquina de estados', { error });
      throw error;
    }
  }

  /**
   * Cria middleware para interceptar estados de upsell
   */
  createStateMachineMiddleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const context = this.extractUpsellContext(req);
        
        if (!context) {
          return next();
        }

        // Verificar se é um estado de upsell
        if (!this.isUpsellState(context.currentState)) {
          return next();
        }

        const userMessage = req.body.input?.text || req.body.message || '';
        const result = await this.processUpsellState(context, userMessage);

        if (result.shouldIntercept) {
          await this.handleUpsellIntercept(req, res, result);
          return;
        }

        next();
        
      } catch (error) {
        logger.error('Erro no middleware de upsell state machine', { error });
        next();
      }
    };
  }

  /**
   * Processa estados de upsell
   */
  private async processUpsellState(
    context: UpsellStateMachineContext, 
    userMessage: string
  ): Promise<UpsellProcessingResult> {
    const timer = upsellProcessingDuration.startTimer();
    const variant = context.variant ? `${context.variant.copy}-${context.variant.position}` : 'unknown';
    
    try {
      // Estado UPSELL_WAIT - aguardando resposta do usuário
      if (context.currentState === 'UPSELL_WAIT') {
        const result = await this.upsellService.processUpsellResponse(
          context.conversationId,
          context.userId,
          userMessage
        );

        if (!result) {
          // Mensagem não relacionada ao upsell
          timer({ result_type: 'ignored', variant });
          return { shouldIntercept: false };
        }

        if (result.action === 'accepted') {
          // Usuário aceitou o upsell
          const revenue = context.addon?.preco_num || 0;
          
          // Registrar métricas
          this.recordStateTransition({
            fromState: 'UPSELL_WAIT',
            toState: 'UPSELL_END',
            trigger: 'user_accepted',
            action: 'accepted',
            variant
          });

          if (revenue > 0) {
            upsellRevenue.inc({
              service: context.addon?.nome || 'unknown',
              variant
            }, revenue);
          }

          timer({ result_type: 'accepted', variant });
          return {
            shouldIntercept: true,
            newState: 'UPSELL_END',
            response: result.response,
            action: 'accepted',
            revenue,
            metadata: {
              ...context.metadata,
              upsell_result: 'accepted',
              addon_added: result.addonAdded || false
            }
          };
        }

        if (result.action === 'declined') {
          // Usuário recusou o upsell
          this.recordStateTransition({
            fromState: 'UPSELL_WAIT',
            toState: 'UPSELL_END',
            trigger: 'user_declined',
            action: 'declined',
            variant
          });

          timer({ result_type: 'declined', variant });
          return {
            shouldIntercept: true,
            newState: 'UPSELL_END',
            response: result.response,
            action: 'declined',
            metadata: {
              ...context.metadata,
              upsell_result: 'declined'
            }
          };
        }
      }

      // Estado UPSELL_END - finalizar fluxo
      if (context.currentState === 'UPSELL_END') {
        activeUpsellSessions.dec();
        
        timer({ result_type: 'ended', variant });
        return {
          shouldIntercept: true,
          newState: 'MAIN_MENU', // ou estado apropriado
          metadata: {
            ...context.metadata,
            upsell_completed: true
          }
        };
      }

      timer({ result_type: 'no_action', variant });
      return { shouldIntercept: false };
      
    } catch (error) {
      timer({ result_type: 'error', variant });
      logger.error('Erro ao processar estado de upsell', { error, context });
      return { shouldIntercept: false };
    }
  }

  /**
   * Lida com interceptação de estados de upsell
   */
  private async handleUpsellIntercept(
    req: Request,
    res: Response,
    result: UpsellProcessingResult
  ): Promise<void> {
    try {
      activeUpsellSessions.inc();

      // Construir resposta da máquina de estados
      const response = {
        status: 'success',
        data: {
          state: result.newState,
          response: result.response,
          slots: result.slots || {},
          metadata: {
            ...result.metadata,
            intercepted_by: 'upsell_state_machine',
            timestamp: new Date().toISOString(),
            action: result.action,
            revenue: result.revenue
          }
        }
      };

      res.json(response);
      
    } catch (error) {
      logger.error('Erro ao lidar com interceptação de upsell', { error, result });
      res.status(500).json({
        status: 'error',
        message: 'Erro interno no processamento de upsell'
      });
    }
  }

  /**
   * Extrai contexto de upsell da requisição
   */
  private extractUpsellContext(req: Request): UpsellStateMachineContext | null {
    try {
      const body = req.body;
      
      if (!body.currentState || !body.sessionId) {
        return null;
      }

      return {
        currentState: body.currentState,
        previousState: body.previousState,
        slots: body.slots || {},
        sessionId: body.sessionId,
        userId: body.userId || body.user_phone || '',
        conversationId: body.conversationId || body.conversation_id || body.sessionId,
        appointmentId: body.appointmentId || body.appointment_id,
        addon: body.addon,
        variant: body.variant,
        metadata: body.metadata || {}
      };
      
    } catch (error) {
      logger.error('Erro ao extrair contexto de upsell', { error });
      return null;
    }
  }

  /**
   * Verifica se é um estado de upsell
   */
  private isUpsellState(state: string): boolean {
    const upsellStates = ['UPSELL_WAIT', 'UPSELL_END'];
    return upsellStates.includes(state);
  }

  /**
   * Registra transição de estado
   */
  recordStateTransition(transition: UpsellStateTransition): void {
    upsellStateMachineTransitions.inc({
      from_state: transition.fromState,
      to_state: transition.toState,
      trigger: transition.trigger,
      variant: transition.variant || 'unknown'
    });

    logger.info('Transição de estado de upsell registrada', {
      transition,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Obtém estatísticas da integração
   */
  async getIntegrationStats(): Promise<Record<string, any>> {
    try {
      const activeSessions = await this.getActiveSessionsCount();
      const upsellStats = await this.upsellService.getMetrics({ period: '1d' });
      const schedulerStats = this.scheduler.getStats();

      return {
        integration: {
          initialized: this.isInitialized,
          activeSessions,
          timestamp: new Date().toISOString()
        },
        upsell: upsellStats,
        scheduler: schedulerStats,
        metrics: {
          transitions: await this.getTransitionMetrics(),
          processing: await this.getProcessingMetrics(),
          revenue: await this.getRevenueMetrics()
        }
      };
      
    } catch (error) {
      logger.error('Erro ao obter estatísticas de integração', { error });
      return {
        error: 'Erro ao obter estatísticas',
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Obtém contagem de sessões ativas
   */
  private async getActiveSessionsCount(): Promise<number> {
    try {
      const metric = await register.getSingleMetric('upsell_active_sessions');
      return metric ? (metric as any).get().values[0]?.value || 0 : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Obtém métricas de transições
   */
  private async getTransitionMetrics(): Promise<Record<string, any>> {
    try {
      const metric = await register.getSingleMetric('upsell_state_machine_transitions_total');
      return metric ? (metric as any).get() : {};
    } catch {
      return {};
    }
  }

  /**
   * Obtém métricas de processamento
   */
  private async getProcessingMetrics(): Promise<Record<string, any>> {
    try {
      const metric = await register.getSingleMetric('upsell_processing_duration_seconds');
      return metric ? (metric as any).get() : {};
    } catch {
      return {};
    }
  }

  /**
   * Obtém métricas de receita
   */
  private async getRevenueMetrics(): Promise<Record<string, any>> {
    try {
      const metric = await register.getSingleMetric('upsell_revenue_brl_total');
      return metric ? (metric as any).get() : {};
    } catch {
      return {};
    }
  }

  /**
   * Limpa recursos
   */
  async cleanup(): Promise<void> {
    try {
      logger.info('Limpando integração upsell-máquina de estados');
      
      // Reset métricas
      activeUpsellSessions.set(0);
      
      this.isInitialized = false;
      
    } catch (error) {
      logger.error('Erro ao limpar integração upsell-máquina de estados', { error });
    }
  }
}

// =============================================================================
// SINGLETON E FUNÇÕES DE CONVENIÊNCIA
// =============================================================================

let integrationInstance: UpsellStateMachineIntegration | null = null;

/**
 * Obtém instância singleton da integração
 */
export function getUpsellStateMachineIntegration(
  upsellService?: UpsellService,
  scheduler?: UpsellScheduler
): UpsellStateMachineIntegration {
  if (!integrationInstance && upsellService && scheduler) {
    integrationInstance = new UpsellStateMachineIntegration(upsellService, scheduler);
  }
  
  if (!integrationInstance) {
    throw new Error('Integração upsell-máquina de estados não inicializada');
  }
  
  return integrationInstance;
}

/**
 * Inicializa a integração
 */
export async function initializeUpsellStateMachineIntegration(
  upsellService: UpsellService,
  scheduler: UpsellScheduler
): Promise<void> {
  const integration = getUpsellStateMachineIntegration(upsellService, scheduler);
  await integration.initialize();
}

/**
 * Cria middleware da máquina de estados
 */
export function createUpsellStateMachineMiddleware(
  upsellService: UpsellService,
  scheduler: UpsellScheduler
) {
  const integration = getUpsellStateMachineIntegration(upsellService, scheduler);
  return integration.createStateMachineMiddleware();
}

/**
 * Limpa a integração
 */
export async function cleanupUpsellStateMachineIntegration(): Promise<void> {
  if (integrationInstance) {
    await integrationInstance.cleanup();
    integrationInstance = null;
  }
}

/**
 * Registra transição de estado externamente
 */
export function recordUpsellStateTransition(
  transition: UpsellStateTransition,
  upsellService?: UpsellService,
  scheduler?: UpsellScheduler
): void {
  try {
    const integration = getUpsellStateMachineIntegration(upsellService, scheduler);
    integration.recordStateTransition(transition);
  } catch (error) {
    logger.error('Erro ao registrar transição de estado de upsell', { error, transition });
  }
}