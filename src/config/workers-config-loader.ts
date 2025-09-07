import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';

interface WorkerStep {
  set?: Record<string, any>;
  paginate?: {
    tool: string;
    args: Record<string, any>;
    retry?: string;
    on_page?: WorkerStep[];
  };
  for_each?: string;
  do?: WorkerStep[];
  tool?: string;
  args?: Record<string, any>;
  save_as?: string;
  if?: string;
  then?: { continue?: boolean } | WorkerStep[];
  metric_gauge_set?: {
    name: string;
    labels?: Record<string, string>;
    value: string;
  };
}

interface WorkerConfig {
  enabled: string | boolean;
  cron: string;
  timezone?: string;
  steps?: WorkerStep[];
}

interface RetryPolicyConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  jitter: boolean;
  backoffMultiplier?: number;
}

interface WorkersYamlConfig {
  workers: Record<string, WorkerConfig>;
  retry_policy: {
    network: RetryPolicyConfig;
    database: RetryPolicyConfig;
  };
  defaults: {
    timezone: string;
    previsit_hour: number;
    audit_enabled: boolean;
    previsit_enabled: boolean;
  };
  templates: {
    previsit: {
      default: string;
      with_location: string;
    };
    confirmation: {
      confirmed: string;
      rescheduled: string;
    };
  };
  monitoring: {
    metrics: {
      enabled: boolean;
      retention_hours: number;
    };
    alerts: {
      high_divergence_threshold: number;
      failed_sends_threshold: number;
    };
    health_checks: {
      trinks_api: boolean;
      whatsapp_api: boolean;
      database: boolean;
      redis: boolean;
    };
  };
}

interface ProcessedWorkerConfig {
  enabled: boolean;
  cron: string;
  timezone: string;
}

interface ProcessedWorkersConfig {
  previsit_daily: ProcessedWorkerConfig;
  divergence_audit_hourly: ProcessedWorkerConfig;
}

class WorkersConfigLoader {
  private logger: Logger;
  private configPath: string;
  private rawConfig: WorkersYamlConfig | null = null;

  constructor(logger: Logger, configPath?: string) {
    this.logger = logger;
    this.configPath = configPath || path.join(__dirname, 'workers-config.yaml');
  }

  /**
   * Carrega e processa a configuração dos workers
   */
  public loadConfig(): ProcessedWorkersConfig {
    try {
      // Carrega arquivo YAML
      const fileContent = fs.readFileSync(this.configPath, 'utf8');
      this.rawConfig = yaml.load(fileContent) as WorkersYamlConfig;

      if (!this.rawConfig) {
        throw new Error('Configuração YAML inválida');
      }

      // Processa configurações com interpolação de variáveis
      const processedConfig = this.processConfig(this.rawConfig);

      this.logger.info('Configuração dos workers carregada com sucesso');
      return processedConfig;

    } catch (error) {
      this.logger.error('Erro ao carregar configuração dos workers:', error);
      throw error;
    }
  }

  /**
   * Processa a configuração interpolando variáveis de ambiente
   */
  private processConfig(config: WorkersYamlConfig): ProcessedWorkersConfig {
    const env = process.env;
    const defaults = config.defaults;

    return {
      previsit_daily: {
        enabled: this.interpolateBoolean(
          config.workers.previsit_daily.enabled,
          env.PREVISIT_ENABLED,
          defaults.previsit_enabled
        ),
        cron: this.interpolateString(
          config.workers.previsit_daily.cron,
          {
            'env.PREVISIT_HOUR': env.PREVISIT_HOUR || defaults.previsit_hour.toString()
          }
        ),
        timezone: this.interpolateString(
          config.workers.previsit_daily.timezone || '{{env.TIMEZONE}}',
          {
            'env.TIMEZONE': env.TIMEZONE || defaults.timezone
          }
        )
      },
      divergence_audit_hourly: {
        enabled: this.interpolateBoolean(
          config.workers.divergence_audit_hourly.enabled,
          env.AUDIT_ENABLED,
          defaults.audit_enabled
        ),
        cron: config.workers.divergence_audit_hourly.cron,
        timezone: this.interpolateString(
          config.workers.divergence_audit_hourly.timezone || '{{env.TIMEZONE}}',
          {
            'env.TIMEZONE': env.TIMEZONE || defaults.timezone
          }
        )
      }
    };
  }

  /**
   * Interpola string com variáveis
   */
  private interpolateString(template: string, variables: Record<string, string>): string {
    let result = template;
    
    for (const [key, value] of Object.entries(variables)) {
      const pattern = new RegExp(`{{${key}}}`, 'g');
      result = result.replace(pattern, value);
    }
    
    return result;
  }

  /**
   * Interpola valor booleano
   */
  private interpolateBoolean(
    template: string | boolean,
    envValue: string | undefined,
    defaultValue: boolean
  ): boolean {
    if (typeof template === 'boolean') {
      return template;
    }

    // Se é uma template string, resolve a variável
    if (template.includes('{{env.')) {
      const value = envValue || defaultValue.toString();
      return this.parseBoolean(value);
    }

    return this.parseBoolean(template);
  }

  /**
   * Converte string para boolean
   */
  private parseBoolean(value: string): boolean {
    const normalized = value.toLowerCase().trim();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }

  /**
   * Obtém configuração de retry policy
   */
  public getRetryPolicy(): {
    network: RetryPolicyConfig;
    database: RetryPolicyConfig;
  } {
    if (!this.rawConfig) {
      throw new Error('Configuração não carregada');
    }

    return this.rawConfig.retry_policy;
  }

  /**
   * Obtém templates de mensagens
   */
  public getTemplates(): WorkersYamlConfig['templates'] {
    if (!this.rawConfig) {
      throw new Error('Configuração não carregada');
    }

    return this.rawConfig.templates;
  }

  /**
   * Obtém configuração de monitoramento
   */
  public getMonitoringConfig(): WorkersYamlConfig['monitoring'] {
    if (!this.rawConfig) {
      throw new Error('Configuração não carregada');
    }

    return this.rawConfig.monitoring;
  }

  /**
   * Obtém configuração de defaults
   */
  public getDefaults(): WorkersYamlConfig['defaults'] {
    if (!this.rawConfig) {
      throw new Error('Configuração não carregada');
    }

    return this.rawConfig.defaults;
  }

  /**
   * Valida se todas as variáveis de ambiente necessárias estão definidas
   */
  public validateEnvironment(): { valid: boolean; missing: string[] } {
    const required = [
      'PREVISIT_ENABLED',
      'PREVISIT_HOUR',
      'AUDIT_ENABLED',
      'TIMEZONE'
    ];

    const missing: string[] = [];
    
    for (const envVar of required) {
      if (!process.env[envVar]) {
        missing.push(envVar);
      }
    }

    return {
      valid: missing.length === 0,
      missing
    };
  }

  /**
   * Gera configuração de exemplo para .env
   */
  public generateEnvExample(): string {
    const defaults = this.rawConfig?.defaults;
    
    return `# Workers Configuration
PREVISIT_ENABLED=${defaults?.previsit_enabled || true}
PREVISIT_HOUR=${defaults?.previsit_hour || 18}
AUDIT_ENABLED=${defaults?.audit_enabled || true}
TIMEZONE=${defaults?.timezone || 'America/Sao_Paulo'}

# Trinks API Configuration
TRINKS_API_URL=https://api.trinks.com
TRINKS_API_TOKEN=your_trinks_token_here

# WhatsApp Configuration
WHATSAPP_API_URL=https://your-whatsapp-api.com
WHATSAPP_API_TOKEN=your_whatsapp_token_here
`;
  }

  /**
   * Recarrega configuração (útil para hot reload)
   */
  public reloadConfig(): ProcessedWorkersConfig {
    this.rawConfig = null;
    return this.loadConfig();
  }
}

/**
 * Factory function para criar instância do loader
 */
export function createWorkersConfigLoader(
  logger: Logger,
  configPath?: string
): WorkersConfigLoader {
  return new WorkersConfigLoader(logger, configPath);
}

export {
  WorkersConfigLoader,
  WorkersYamlConfig,
  ProcessedWorkersConfig,
  ProcessedWorkerConfig,
  RetryPolicyConfig,
  WorkerStep,
  WorkerConfig
};