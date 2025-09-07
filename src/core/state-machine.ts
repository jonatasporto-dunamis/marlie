import { RedisClientType } from 'redis';
import { getRedis } from '../infra/redis';
import { logger } from '../utils/logger';
import { MessageBuffer } from '../services/message-buffer';
import { HumanHandoffService } from '../services/human-handoff';
import { ResponseTemplates } from '../services/response-templates';
import { ValidationService } from '../services/validation-service';
import { CatalogService } from '../services/catalog-service';
import { TrinksService } from '../services/trinks-service';
import { NLPPatterns, NLPResult } from './nlp-patterns';
import { getStateMachineConfigLoader, StateAction, StateDefinition } from './state-machine-config';

export interface UserContext {
  phone: string;
  first_name?: string;
  tenant_id: string;
}

export interface ConversationSlots {
  service_id?: string;
  category?: string;
  professional_id?: string;
  start_iso?: string;
  [key: string]: any;
}

export interface StateContext {
  user: UserContext;
  slots: ConversationSlots;
  variables: Record<string, any>;
  currentState: string;
  lastMessage?: string;
  messageHistory: string[];
}

export interface StateTransition {
  condition?: string;
  target: string;
  actions?: StateAction[];
}

export interface StateAction {
  type: 'reply' | 'set_variable' | 'call_tool' | 'transition' | 'check_override' | 'aggregate_buffer';
  template?: string;
  variable?: string;
  value?: any;
  tool?: string;
  args?: Record<string, any>;
  target?: string;
  save_as?: string;
}

export interface StateDefinition {
  description?: string;
  on_enter?: StateAction[];
  on_user_message?: StateAction[];
  on_user_message_or_slots?: StateAction[];
  transitions?: StateTransition[];
  stay?: boolean;
}

export class StateMachine {
  private redis: RedisClientType | null = null;
  private messageBuffer: MessageBuffer;
  private handoffService: HumanHandoffService;
  private responseTemplates: ResponseTemplates;
  private validationService: ValidationService;
  private catalogService: CatalogService;
  private trinksService: TrinksService;
  private nlpPatterns: NLPPatterns;
  private configLoader = getStateMachineConfigLoader();
  
  private readonly USER_CONTEXT_TTL = 3600; // 1 hora
  private readonly BUFFER_TTL = 30; // 30 segundos
  
  private config: any = null;

  private states: Record<string, StateDefinition> = {
    START: {
      on_enter: [
        { type: 'check_override', variable: 'HUMAN_OVERRIDE' },
        {
          type: 'reply',
          template: 'human_handoff_active',
          condition: '{{HUMAN_OVERRIDE == true}}'
        },
        {
          type: 'transition',
          target: 'HUMAN_HANDOFF',
          condition: '{{HUMAN_OVERRIDE == true}}'
        },
        {
          type: 'reply',
          template: 'menu_welcome',
          condition: '{{HUMAN_OVERRIDE != true}}'
        },
        {
          type: 'transition',
          target: 'MENU_WAITING',
          condition: '{{HUMAN_OVERRIDE != true}}'
        }
      ]
    },

    HUMAN_HANDOFF: {
      description: 'Pausa completa do bot enquanto HUMAN_OVERRIDE=true.',
      on_user_message: [
        { type: 'reply', template: 'human_handoff_active' }
      ],
      stay: true
    },

    MENU_WAITING: {
      description: 'Aguarda escolha 1/2; usa buffer de 30s para agrupar mensagens.',
      on_user_message: [
        { type: 'aggregate_buffer' },
        {
          type: 'transition',
          target: 'SCHEDULING_ROUTING',
          condition: '{{option_1 || explicit}}'
        },
        {
          type: 'transition',
          target: 'INFO_ROUTING',
          condition: '{{option_2}}'
        },
        {
          type: 'reply',
          template: 'confirm_intent',
          condition: '{{ambiguous}}'
        },
        {
          type: 'transition',
          target: 'CONFIRM_INTENT',
          condition: '{{ambiguous}}'
        },
        {
          type: 'reply',
          template: 'invalid_option',
          condition: '{{!option_1 && !option_2 && !explicit && !ambiguous}}'
        }
      ],
      stay: true
    },

    CONFIRM_INTENT: {
      description: 'Confirma intenção após trigger ambíguo; só segue com 1/2.',
      on_user_message: [
        {
          type: 'transition',
          target: 'SCHEDULING_ROUTING',
          condition: '{{option_1}}'
        },
        {
          type: 'transition',
          target: 'INFO_ROUTING',
          condition: '{{option_2}}'
        },
        {
          type: 'reply',
          template: 'invalid_option',
          condition: '{{!option_1 && !option_2}}'
        }
      ],
      stay: true
    },

    SCHEDULING_ROUTING: {
      description: 'Envia para o subfluxo de agendamento; antes de confirmar, validar.',
      on_enter: [
        { type: 'transition', target: 'VALIDATE_BEFORE_CONFIRM' }
      ]
    },

    VALIDATE_BEFORE_CONFIRM: {
      description: 'Regra forte: não confirmar se entidade for categoria ou ambígua.',
      on_user_message_or_slots: [
        {
          type: 'call_tool',
          tool: 'catalog.search_top_services',
          args: { query: '{{category || raw_query}}', limit: 3 },
          save_as: 'top3',
          condition: '{{!service_id || category || nlp.is_ambiguous(raw_query)}}'
        },
        {
          type: 'reply',
          template: 'clarify_service',
          condition: '{{!service_id || category || nlp.is_ambiguous(raw_query)}}'
        },
        {
          type: 'call_tool',
          tool: 'trinks.validate_availability',
          args: {
            service_id: '{{service_id}}',
            professional_id: '{{professional_id}}',
            start_iso: '{{start_iso}}'
          },
          save_as: 'validation',
          condition: '{{service_id && !category && !nlp.is_ambiguous(raw_query)}}'
        },
        {
          type: 'reply',
          template: 'validation_failed',
          condition: '{{validation && !validation.ok}}'
        },
        {
          type: 'call_tool',
          tool: 'catalog.search_top_services',
          args: { query: '{{raw_query}}', limit: 3 },
          save_as: 'top3',
          condition: '{{validation && !validation.ok}}'
        },
        {
          type: 'reply',
          template: 'clarify_service',
          condition: '{{validation && !validation.ok}}'
        },
        {
          type: 'transition',
          target: 'SCHEDULING_CONFIRMED',
          condition: '{{validation && validation.ok}}'
        }
      ],
      stay: true
    },

    INFO_ROUTING: {
      description: 'Encaminha para o subfluxo de informações (FAQ/horários, etc.).',
      on_enter: [
        { type: 'reply', template: 'info_response' }
      ]
    },

    SCHEDULING_CONFIRMED: {
      description: 'Estado terminal - agendamento confirmado'
    }
  };

  constructor() {
    this.messageBuffer = new MessageBuffer();
    this.handoffService = new HumanHandoffService();
    this.responseTemplates = new ResponseTemplates();
    this.validationService = new ValidationService();
    this.catalogService = new CatalogService();
    this.trinksService = new TrinksService();
    this.nlpPatterns = new NLPPatterns();
    this.initRedis();
    this.initializeConfig();
  }
  
  private async initializeConfig(): Promise<void> {
    try {
      this.config = await this.configLoader.loadConfig();
      logger.info('State machine initialized with YAML configuration');
    } catch (error) {
      logger.error('Failed to initialize state machine config:', error);
      throw error;
    }
  }

  private async initRedis(): Promise<void> {
    try {
      this.redis = await getRedis();
    } catch (error) {
      logger.error('Failed to initialize Redis for StateMachine:', error);
    }
  }

  async processMessage(
    message: string,
    context: StateContext
  ): Promise<{ reply?: string; newState: string; context: StateContext }> {
    try {
      // Garante que a configuração está carregada
      if (!this.config) {
        await this.initializeConfig();
      }

      const currentState = this.states[context.currentState];
      if (!currentState) {
        throw new Error(`Unknown state: ${context.currentState}`);
      }

      // Adicionar mensagem ao histórico
      context.messageHistory.push(message);
      context.lastMessage = message;

      // Processar ações do estado usando configuração YAML
      const result = await this.processStateFromConfig(context.currentState, context, message);

      return {
        reply: result.reply,
        newState: result.newState || context.currentState,
        context: result.context
      };
    } catch (error) {
      logger.error('Error processing message in state machine:', error);
      return {
        reply: 'Desculpe, ocorreu um erro. Tente novamente.',
        newState: 'START',
        context
      };
    }
  }

  /**
   * Processa estado baseado na configuração YAML
   */
  private async processStateFromConfig(
    stateName: string,
    context: StateContext,
    message?: string
  ): Promise<{ reply?: string; newState?: string; context: StateContext }> {
    try {
      // Usa configuração YAML se disponível, senão fallback para estados hardcoded
      const stateConfig = this.config?.states?.[stateName] || this.states[stateName];
      
      if (!stateConfig) {
        throw new Error(`Unknown state: ${stateName}`);
      }

      // Processar ações do estado atual
      const actions = stateConfig.on_user_message || stateConfig.on_user_message_or_slots || [];
      return await this.executeStateActions(actions, context, message);
    } catch (error) {
      logger.error('Error processing state from config:', error);
      throw error;
    }
  }

  async enterState(
    stateName: string,
    context: StateContext
  ): Promise<{ reply?: string; newState: string; context: StateContext }> {
    try {
      // Garante que a configuração está carregada
      if (!this.config) {
        await this.initializeConfig();
      }

      // Usa configuração YAML se disponível, senão fallback para estados hardcoded
      const state = this.config?.states?.[stateName] || this.states[stateName];
      if (!state) {
        throw new Error(`Unknown state: ${stateName}`);
      }

      context.currentState = stateName;

      if (state.on_enter) {
        const result = await this.executeStateActions(state.on_enter, context);
        return {
          reply: result.reply,
          newState: result.newState || stateName,
          context: result.context
        };
      }

      return { newState: stateName, context };
    } catch (error) {
      logger.error('Error entering state:', error);
      return {
        reply: 'Desculpe, ocorreu um erro. Tente novamente.',
        newState: 'START',
        context
      };
    }
  }

  /**
   * Executa ações de um estado baseadas na configuração YAML
   */
  private async executeStateActions(
    actions: StateAction[],
    context: StateContext,
    message?: string
  ): Promise<{ reply?: string; newState?: string; context: StateContext }> {
    let reply: string | undefined;
    let newState: string | undefined;
    let updatedContext = { ...context };

    for (const action of actions) {
      const result = await this.executeAction(action, updatedContext, message);
      
      if (result.reply) {
        reply = result.reply;
      }
      
      if (result.newState) {
        newState = result.newState;
        updatedContext.currentState = newState;
      }
      
      // Se a ação indica para parar o processamento
      if (result.shouldStop) {
        break;
      }
    }

    return { reply, newState, context: updatedContext };
  }

  /**
   * Executa uma ação individual baseada na configuração YAML
   */
  private async executeAction(
    action: StateAction,
    context: StateContext,
    message?: string
  ): Promise<{ reply?: string; newState?: string; shouldStop?: boolean }> {
    try {
      // Verificar condição se existir
      if (action.condition && !this.evaluateCondition(action.condition, context, message)) {
        return {};
      }

      switch (action.type) {
        case 'check_override':
          if (action.variable === 'HUMAN_OVERRIDE') {
            const isOverride = await this.handoffService.isHandoffActive(context.user.phone);
            context.variables[action.variable] = isOverride;
          }
          break;

        case 'aggregate_buffer':
          if (message) {
            const bufferedMessage = await this.messageBuffer.addMessage(
              context.user.phone,
              message
            );
            if (bufferedMessage) {
              context.lastMessage = bufferedMessage;
              // Atualizar variáveis NLP com mensagem agregada
              this.updateNLPVariables(context, bufferedMessage);
            }
          }
          break;

        case 'reply':
          if (action.template) {
            const reply = await this.responseTemplates.render(action.template, {
              user: context.user,
              ...context.variables
            });
            return { reply };
          }
          break;

        case 'transition':
          if (action.target) {
            return { newState: action.target };
          }
          break;

        case 'set_variable':
          if (action.variable && action.value !== undefined) {
            context.variables[action.variable] = action.value;
          }
          break;

        case 'call_tool':
          if (action.tool && action.args) {
            const toolResult = await this.callTool(action.tool, action.args, context);
            if (action.save_as) {
              context.variables[action.save_as] = toolResult;
            }
          }
          break;

        default:
          logger.warn(`Unknown action type: ${action.type}`);
      }
      
      return {};
    } catch (error) {
      logger.error('Error executing action:', error);
      return {};
    }
  }

  private evaluateCondition(
    condition: string,
    context: StateContext,
    message?: string
  ): boolean {
    try {
      // Atualizar variáveis NLP se houver mensagem
      if (message) {
        this.updateNLPVariables(context, message);
      }

      // Substituir variáveis na condição
      let evaluatedCondition = condition;
      
      // Substituir variáveis do contexto
      for (const [key, value] of Object.entries(context.variables)) {
        const regex = new RegExp(`{{${key}}}`, 'g');
        evaluatedCondition = evaluatedCondition.replace(regex, String(value));
      }

      // Substituir slots
      for (const [key, value] of Object.entries(context.slots)) {
        const regex = new RegExp(`{{${key}}}`, 'g');
        evaluatedCondition = evaluatedCondition.replace(regex, String(value || ''));
      }

      // Avaliação simples de condições booleanas
      if (evaluatedCondition.includes('==')) {
        const [left, right] = evaluatedCondition.split('==').map(s => s.trim());
        return left === right;
      }
      
      if (evaluatedCondition.includes('!=')) {
        const [left, right] = evaluatedCondition.split('!=').map(s => s.trim());
        return left !== right;
      }

      if (evaluatedCondition.includes('||')) {
        return evaluatedCondition.split('||').some(part => 
          part.trim() === 'true' || context.variables[part.trim()] === true
        );
      }

      if (evaluatedCondition.includes('&&')) {
        return evaluatedCondition.split('&&').every(part => 
          part.trim() === 'true' || context.variables[part.trim()] === true
        );
      }

      // Verificar se é uma variável booleana
      return context.variables[evaluatedCondition] === true;
    } catch (error) {
      logger.error('Error evaluating condition:', error);
      return false;
    }
  }

  /**
   * Atualiza variáveis NLP baseadas na entrada do usuário
   */
  private updateNLPVariables(context: StateContext, message: string): void {
    const analysis: NLPResult = this.nlpPatterns.analyze(message);
    
    // Detecta padrões principais
    context.variables.option_1 = analysis.intent === 'option_1';
    context.variables.option_2 = analysis.intent === 'option_2';
    context.variables.explicit = analysis.intent === 'explicit_schedule';
    context.variables.ambiguous = analysis.intent === 'ambiguous_schedule';
    context.variables.raw_query = message;
    
    // Adiciona função helper para verificar ambiguidade
    context.variables.is_ambiguous = (text: string) => {
      const result = this.nlpPatterns.analyze(text);
      return result.intent === 'ambiguous_schedule' || result.confidence < 0.7;
    };
  }
  
  /**
   * Avalia uma expressão template (ex: {{user.phone}}, {{nlp.option_1}})
   */
  private evaluateExpression(expression: string, context: StateContext): any {
    try {
      // Remove chaves duplas se existirem
      const cleanExpression = expression.replace(/^{{\s*|\s*}}$/g, '');
      
      // Avalia expressões simples
      if (cleanExpression.includes('==')) {
        const [left, right] = cleanExpression.split('==').map(s => s.trim());
        const leftValue = this.getValueFromPath(left, context);
        const rightValue = this.parseValue(right);
        return leftValue === rightValue;
      }
      
      if (cleanExpression.includes('||')) {
        const parts = cleanExpression.split('||').map(s => s.trim());
        return parts.some(part => this.getValueFromPath(part, context));
      }
      
      if (cleanExpression.includes('&&')) {
        const parts = cleanExpression.split('&&').map(s => s.trim());
        return parts.every(part => this.getValueFromPath(part, context));
      }
      
      if (cleanExpression.startsWith('!')) {
        const path = cleanExpression.substring(1);
        return !this.getValueFromPath(path, context);
      }
      
      // Avalia path simples
      return this.getValueFromPath(cleanExpression, context);
    } catch (error) {
      logger.warn(`Error evaluating expression: ${expression}`, error);
      return false;
    }
  }
  
  /**
   * Obtém valor de um caminho (ex: user.phone, nlp.option_1)
   */
  private getValueFromPath(path: string, context: StateContext): any {
    const parts = path.split('.');
    let current: any = {
      user: context.user,
      slots: context.slots,
      variables: context.variables
    };
    
    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        return undefined;
      }
    }
    
    return current;
  }
  
  /**
   * Converte string para valor apropriado
   */
  private parseValue(value: string): any {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    if (value === 'undefined') return undefined;
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
    return value.replace(/^["']|["']$/g, ''); // Remove aspas
  }

  private async callTool(
    toolName: string,
    args: Record<string, any>,
    context: StateContext
  ): Promise<any> {
    try {
      // Substituir variáveis nos argumentos
      const resolvedArgs = this.resolveVariables(args, context);

      switch (toolName) {
        case 'catalog.search_top_services':
          return await this.catalogService.searchTopServices(
            resolvedArgs.query,
            resolvedArgs.limit || 3,
            parseInt(context.user.tenant_id, 10)
          );

        case 'trinks.validate_availability':
          return await this.trinksService.validateAvailability(
            resolvedArgs.service_id,
            resolvedArgs.professional_id,
            resolvedArgs.start_iso
          );

        default:
          logger.warn(`Unknown tool: ${toolName}`);
          return null;
      }
    } catch (error) {
      logger.error(`Error calling tool ${toolName}:`, error);
      return null;
    }
  }

  private resolveVariables(obj: any, context: StateContext): any {
    if (typeof obj === 'string') {
      let resolved = obj;
      
      // Substituir variáveis do contexto
      for (const [key, value] of Object.entries(context.variables)) {
        const regex = new RegExp(`{{${key}}}`, 'g');
        resolved = resolved.replace(regex, String(value || ''));
      }

      // Substituir slots
      for (const [key, value] of Object.entries(context.slots)) {
        const regex = new RegExp(`{{${key}}}`, 'g');
        resolved = resolved.replace(regex, String(value || ''));
      }

      return resolved;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.resolveVariables(item, context));
    }

    if (typeof obj === 'object' && obj !== null) {
      const resolved: any = {};
      for (const [key, value] of Object.entries(obj)) {
        resolved[key] = this.resolveVariables(value, context);
      }
      return resolved;
    }

    return obj;
  }

  async saveContext(phone: string, context: StateContext): Promise<void> {
    try {
      if (!this.redis) {
        await this.initRedis();
      }
      
      if (this.redis) {
        await this.redis.setEx(
          `state:${phone}`,
          3600, // 1 hora
          JSON.stringify(context)
        );
      }
    } catch (error) {
      logger.error('Error saving context:', error);
    }
  }

  async loadContext(phone: string, tenantId: string): Promise<StateContext> {
    try {
      if (!this.redis) {
        await this.initRedis();
      }

      if (this.redis) {
        const saved = await this.redis.get(`state:${phone}`);
        if (saved) {
          return JSON.parse(saved as string);
        }
      }
    } catch (error) {
      logger.error('Error loading context:', error);
    }

    // Retornar contexto padrão
    return {
      user: { phone, tenant_id: tenantId },
      slots: {},
      variables: {},
      currentState: 'START',
      messageHistory: []
    };
  }
}