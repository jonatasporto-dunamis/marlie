import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { logger } from '../utils/logger';

export interface StateAction {
  type: 'reply' | 'transition' | 'tool' | 'check_override' | 'if' | 'elif' | 'else' | 'stay' | 'done' | 'route_to_subflow' | 'aggregate_buffer' | 'match' | 'detect_entity' | 'wait_user_choice_map_to_service_id' | 'set_variable' | 'call_tool';
  template?: string;
  target?: string;
  tool?: string;
  args?: Record<string, any>;
  save_as?: string;
  var?: string;
  for?: string;
  condition?: string;
  then?: StateAction[];
  else?: StateAction[];
  patterns?: Record<string, string>;
  [key: string]: any;
}

export interface StateDefinition {
  description?: string;
  on_enter?: StateAction[];
  on_user_message?: StateAction[];
  on_user_message_or_slots?: StateAction[];
  on_exit?: StateAction[];
}

export interface WebhookConfig {
  method: string;
  path: string;
  auth?: string;
  effect: StateAction[];
}

export interface MetricGoal {
  name: string;
  description: string;
}

export interface MetricCounter {
  name: string;
}

export interface AcceptanceTest {
  name: string;
  input?: string[];
  input_bursts?: Array<{ at_ms: number; text: string }>;
  slots?: Record<string, any>;
  expected: {
    state_sequence?: string[];
    reply_contains?: string;
    merged_text?: string;
    next_state?: string;
  };
}

export interface BufferConfig {
  timeout_ms: number;
  max_messages: number;
  redis_key_prefix: string;
}

export interface HandoffConfig {
  redis_key_prefix: string;
  default_timeout_hours: number;
  admin_endpoints: string[];
}

export interface ValidationConfig {
  require_service_id: boolean;
  reject_categories: boolean;
  ambiguity_threshold: number;
  max_clarification_attempts: number;
}

export interface StateMachineConfig {
  state_machine: {
    initial_state: string;
    states: Record<string, StateDefinition>;
    terminal_states: string[];
    routing?: {
      webhooks?: Record<string, WebhookConfig>;
    };
    metrics?: {
      goals?: MetricGoal[];
      counters?: MetricCounter[];
    };
    acceptance_tests?: AcceptanceTest[];
  };
  buffer: BufferConfig;
  handoff: HandoffConfig;
  validation: ValidationConfig;
}

export class StateMachineConfigLoader {
  private config: StateMachineConfig | null = null;
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath || path.join(__dirname, 'state-machine-config.yaml');
  }

  /**
   * Carrega a configuração do arquivo YAML
   */
  async loadConfig(): Promise<StateMachineConfig> {
    try {
      if (!fs.existsSync(this.configPath)) {
        throw new Error(`Configuration file not found: ${this.configPath}`);
      }

      const fileContent = fs.readFileSync(this.configPath, 'utf8');
      const parsedConfig = yaml.load(fileContent) as StateMachineConfig;
      
      this.validateConfig(parsedConfig);
      this.config = parsedConfig;
      
      logger.info(`State machine configuration loaded from ${this.configPath}`);
      return this.config;
    } catch (error) {
      logger.error('Failed to load state machine configuration:', error);
      throw error;
    }
  }

  /**
   * Retorna a configuração carregada
   */
  getConfig(): StateMachineConfig {
    if (!this.config) {
      throw new Error('Configuration not loaded. Call loadConfig() first.');
    }
    return this.config;
  }

  /**
   * Retorna a definição de um estado específico
   */
  getStateDefinition(stateName: string): StateDefinition {
    const config = this.getConfig();
    const state = config.state_machine.states[stateName];
    
    if (!state) {
      throw new Error(`State not found: ${stateName}`);
    }
    
    return state;
  }

  /**
   * Retorna o estado inicial
   */
  getInitialState(): string {
    return this.getConfig().state_machine.initial_state;
  }

  /**
   * Verifica se um estado é terminal
   */
  isTerminalState(stateName: string): boolean {
    const config = this.getConfig();
    return config.state_machine.terminal_states.includes(stateName);
  }

  /**
   * Retorna a configuração do buffer
   */
  getBufferConfig(): BufferConfig {
    return this.getConfig().buffer;
  }

  /**
   * Retorna a configuração do handoff
   */
  getHandoffConfig(): HandoffConfig {
    return this.getConfig().handoff;
  }

  /**
   * Retorna a configuração de validação
   */
  getValidationConfig(): ValidationConfig {
    return this.getConfig().validation;
  }

  /**
   * Retorna os testes de aceitação
   */
  getAcceptanceTests(): AcceptanceTest[] {
    return this.getConfig().state_machine.acceptance_tests || [];
  }

  /**
   * Retorna as métricas configuradas
   */
  getMetrics(): { goals: MetricGoal[]; counters: MetricCounter[] } {
    const metrics = this.getConfig().state_machine.metrics;
    return {
      goals: metrics?.goals || [],
      counters: metrics?.counters || []
    };
  }

  /**
   * Retorna os webhooks configurados
   */
  getWebhooks(): Record<string, WebhookConfig> {
    return this.getConfig().state_machine.routing?.webhooks || {};
  }

  /**
   * Valida a estrutura da configuração
   */
  private validateConfig(config: any): void {
    if (!config.state_machine) {
      throw new Error('Missing state_machine section in configuration');
    }

    if (!config.state_machine.initial_state) {
      throw new Error('Missing initial_state in state_machine configuration');
    }

    if (!config.state_machine.states || typeof config.state_machine.states !== 'object') {
      throw new Error('Missing or invalid states section in configuration');
    }

    // Verifica se o estado inicial existe
    if (!config.state_machine.states[config.state_machine.initial_state]) {
      throw new Error(`Initial state '${config.state_machine.initial_state}' not found in states`);
    }

    // Verifica se todos os estados terminais existem
    if (config.state_machine.terminal_states) {
      for (const terminalState of config.state_machine.terminal_states) {
        if (!config.state_machine.states[terminalState]) {
          throw new Error(`Terminal state '${terminalState}' not found in states`);
        }
      }
    }

    // Valida configurações obrigatórias
    if (!config.buffer) {
      throw new Error('Missing buffer configuration');
    }

    if (!config.handoff) {
      throw new Error('Missing handoff configuration');
    }

    if (!config.validation) {
      throw new Error('Missing validation configuration');
    }

    logger.info('State machine configuration validation passed');
  }

  /**
   * Recarrega a configuração do arquivo
   */
  async reloadConfig(): Promise<StateMachineConfig> {
    this.config = null;
    return this.loadConfig();
  }

  /**
   * Salva a configuração atual no arquivo
   */
  async saveConfig(config: StateMachineConfig): Promise<void> {
    try {
      this.validateConfig(config);
      const yamlContent = yaml.dump(config, {
        indent: 2,
        lineWidth: 120,
        noRefs: true
      });
      
      fs.writeFileSync(this.configPath, yamlContent, 'utf8');
      this.config = config;
      
      logger.info(`State machine configuration saved to ${this.configPath}`);
    } catch (error) {
      logger.error('Failed to save state machine configuration:', error);
      throw error;
    }
  }
}

// Singleton instance
let configLoaderInstance: StateMachineConfigLoader | null = null;

export function getStateMachineConfigLoader(): StateMachineConfigLoader {
  if (!configLoaderInstance) {
    configLoaderInstance = new StateMachineConfigLoader();
  }
  return configLoaderInstance;
}

export function resetStateMachineConfigLoader(): void {
  configLoaderInstance = null;
}