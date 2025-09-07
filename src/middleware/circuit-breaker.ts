import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

interface CircuitBreakerConfig {
  error_rate_window: string; // e.g., '2m'
  error_rate_threshold: number; // e.g., 0.25 (25%)
  open_for_seconds: number;
  backoff: {
    base_ms: number;
    max_ms: number;
    jitter: boolean;
  };
}

interface DependencyConfig {
  name: string;
  match_tools: string[];
}

interface CircuitState {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failures: number;
  successes: number;
  lastFailureTime: number;
  nextAttemptTime: number;
  windowStart: number;
  totalRequests: number;
}

interface NotificationConfig {
  on_open: {
    channel: string;
    template: string;
  };
  on_close: {
    channel: string;
    template: string;
  };
}

/**
 * Circuit Breaker para proteger integrações externas
 */
export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private dependencies: DependencyConfig[];
  private notifications: NotificationConfig;
  private circuits = new Map<string, CircuitState>();
  private windowMs: number;

  constructor(
    config: CircuitBreakerConfig,
    dependencies: DependencyConfig[],
    notifications: NotificationConfig
  ) {
    this.config = config;
    this.dependencies = dependencies;
    this.notifications = notifications;
    this.windowMs = this.parseTimeWindow(config.error_rate_window);
    
    // Inicializar circuitos para cada dependência
    dependencies.forEach(dep => {
      this.circuits.set(dep.name, this.createInitialState());
    });

    // Limpeza periódica de estatísticas antigas
    setInterval(() => this.cleanupOldStats(), 60000); // 1 minuto
  }

  /**
   * Cria estado inicial do circuito
   */
  private createInitialState(): CircuitState {
    return {
      state: 'CLOSED',
      failures: 0,
      successes: 0,
      lastFailureTime: 0,
      nextAttemptTime: 0,
      windowStart: Date.now(),
      totalRequests: 0
    };
  }

  /**
   * Converte string de tempo para milissegundos
   */
  private parseTimeWindow(timeStr: string): number {
    const match = timeStr.match(/(\d+)([smh])/);
    if (!match) return 120000; // 2 minutos padrão
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    switch (unit) {
      case 's': return value * 1000;
      case 'm': return value * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      default: return 120000;
    }
  }

  /**
   * Middleware para interceptar chamadas de ferramentas
   */
  middleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      const toolName = this.extractToolName(req);
      if (!toolName) {
        return next();
      }

      const dependency = this.findDependencyForTool(toolName);
      if (!dependency) {
        return next();
      }

      const circuit = this.circuits.get(dependency.name);
      if (!circuit) {
        return next();
      }

      // Verificar se o circuito está aberto
      if (await this.shouldRejectRequest(dependency.name, circuit)) {
        logger.warn('Circuit breaker: Request rejected', {
          dependency: dependency.name,
          tool: toolName,
          state: circuit.state,
          path: req.path
        });

        return res.status(503).json({
          error: 'Service temporarily unavailable',
          dependency: dependency.name,
          retryAfter: Math.ceil((circuit.nextAttemptTime - Date.now()) / 1000)
        });
      }

      // Interceptar resposta para registrar sucesso/falha
      const originalSend = res.send;
      const originalJson = res.json;
      
      res.send = function(body: any) {
        this.recordResult(dependency.name, res.statusCode < 500);
        return originalSend.call(this, body);
      }.bind(this);

      res.json = function(obj: any) {
        this.recordResult(dependency.name, res.statusCode < 500);
        return originalJson.call(this, obj);
      }.bind(this);

      next();
    };
  }

  /**
   * Extrai nome da ferramenta da requisição
   */
  private extractToolName(req: Request): string | null {
    // Extrair de headers, path ou body conforme necessário
    const toolHeader = req.headers['x-tool-name'] as string;
    if (toolHeader) return toolHeader;

    // Extrair do path para rotas específicas
    const pathMatch = req.path.match(/\/(trinks|evolution)\//);
    if (pathMatch) return pathMatch[1];

    // Extrair do body para chamadas de API
    if (req.body?.tool) return req.body.tool;

    return null;
  }

  /**
   * Encontra dependência para uma ferramenta
   */
  private findDependencyForTool(toolName: string): DependencyConfig | null {
    return this.dependencies.find(dep => 
      dep.match_tools.some(pattern => 
        this.matchesPattern(toolName, pattern)
      )
    ) || null;
  }

  /**
   * Verifica se ferramenta corresponde ao padrão
   */
  private matchesPattern(toolName: string, pattern: string): boolean {
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      return toolName.startsWith(prefix);
    }
    return toolName === pattern;
  }

  /**
   * Verifica se deve rejeitar a requisição
   */
  private async shouldRejectRequest(depName: string, circuit: CircuitState): Promise<boolean> {
    const now = Date.now();

    switch (circuit.state) {
      case 'CLOSED':
        return false;
        
      case 'OPEN':
        if (now >= circuit.nextAttemptTime) {
          // Transição para HALF_OPEN
          circuit.state = 'HALF_OPEN';
          logger.info('Circuit breaker: Transitioning to HALF_OPEN', { dependency: depName });
          return false;
        }
        return true;
        
      case 'HALF_OPEN':
        // Permitir apenas uma requisição por vez em HALF_OPEN
        return false;
        
      default:
        return false;
    }
  }

  /**
   * Registra resultado de uma chamada
   */
  public recordResult(depName: string, success: boolean): void {
    const circuit = this.circuits.get(depName);
    if (!circuit) return;

    const now = Date.now();
    
    // Reset da janela se necessário
    if (now - circuit.windowStart > this.windowMs) {
      circuit.windowStart = now;
      circuit.failures = 0;
      circuit.successes = 0;
      circuit.totalRequests = 0;
    }

    circuit.totalRequests++;

    if (success) {
      circuit.successes++;
      
      if (circuit.state === 'HALF_OPEN') {
        // Sucesso em HALF_OPEN -> fechar circuito
        this.closeCircuit(depName, circuit);
      }
    } else {
      circuit.failures++;
      circuit.lastFailureTime = now;
      
      if (circuit.state === 'HALF_OPEN') {
        // Falha em HALF_OPEN -> abrir circuito novamente
        this.openCircuit(depName, circuit);
      } else if (circuit.state === 'CLOSED') {
        // Verificar se deve abrir o circuito
        this.checkAndOpenCircuit(depName, circuit);
      }
    }

    logger.debug('Circuit breaker: Result recorded', {
      dependency: depName,
      success,
      state: circuit.state,
      failures: circuit.failures,
      successes: circuit.successes,
      totalRequests: circuit.totalRequests
    });
  }

  /**
   * Verifica se deve abrir o circuito
   */
  private checkAndOpenCircuit(depName: string, circuit: CircuitState): void {
    if (circuit.totalRequests < 5) {
      // Mínimo de requisições para avaliar
      return;
    }

    const errorRate = circuit.failures / circuit.totalRequests;
    
    if (errorRate >= this.config.error_rate_threshold) {
      this.openCircuit(depName, circuit);
    }
  }

  /**
   * Abre o circuito
   */
  private openCircuit(depName: string, circuit: CircuitState): void {
    circuit.state = 'OPEN';
    circuit.nextAttemptTime = Date.now() + (this.config.open_for_seconds * 1000);
    
    logger.warn('Circuit breaker: OPENED', {
      dependency: depName,
      errorRate: circuit.failures / circuit.totalRequests,
      threshold: this.config.error_rate_threshold,
      nextAttempt: new Date(circuit.nextAttemptTime).toISOString()
    });

    // Enviar notificação
    this.sendNotification('open', depName);
  }

  /**
   * Fecha o circuito
   */
  private closeCircuit(depName: string, circuit: CircuitState): void {
    circuit.state = 'CLOSED';
    circuit.failures = 0;
    circuit.successes = 0;
    circuit.totalRequests = 0;
    circuit.windowStart = Date.now();
    
    logger.info('Circuit breaker: CLOSED', {
      dependency: depName
    });

    // Enviar notificação
    this.sendNotification('close', depName);
  }

  /**
   * Envia notificação
   */
  private async sendNotification(type: 'open' | 'close', depName: string): Promise<void> {
    try {
      const config = type === 'open' ? this.notifications.on_open : this.notifications.on_close;
      const message = config.template.replace('{{dep}}', depName);
      
      // Implementar envio baseado no canal
      if (config.channel === 'telegram') {
        await this.sendTelegramNotification(message);
      }
      
      logger.info('Circuit breaker notification sent', {
        type,
        dependency: depName,
        channel: config.channel,
        message
      });
    } catch (error) {
      logger.error('Failed to send circuit breaker notification', {
        error: error instanceof Error ? error.message : 'Unknown error',
        type,
        dependency: depName
      });
    }
  }

  /**
   * Envia notificação via Telegram
   */
  private async sendTelegramNotification(message: string): Promise<void> {
    // Implementação básica - pode ser expandida
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    if (!telegramToken || !chatId) {
      logger.warn('Telegram notification not configured');
      return;
    }

    // Aqui seria feita a chamada para a API do Telegram
    logger.info('Telegram notification would be sent', { message });
  }

  /**
   * Limpa estatísticas antigas
   */
  private cleanupOldStats(): void {
    const now = Date.now();
    
    for (const [depName, circuit] of this.circuits.entries()) {
      if (now - circuit.windowStart > this.windowMs * 2) {
        // Reset estatísticas muito antigas
        circuit.failures = 0;
        circuit.successes = 0;
        circuit.totalRequests = 0;
        circuit.windowStart = now;
      }
    }
  }

  /**
   * Obtém status de todos os circuitos
   */
  public getStatus(): Record<string, any> {
    const status: Record<string, any> = {};
    
    for (const [depName, circuit] of this.circuits.entries()) {
      status[depName] = {
        state: circuit.state,
        errorRate: circuit.totalRequests > 0 ? circuit.failures / circuit.totalRequests : 0,
        failures: circuit.failures,
        successes: circuit.successes,
        totalRequests: circuit.totalRequests,
        nextAttemptTime: circuit.nextAttemptTime,
        windowStart: circuit.windowStart
      };
    }
    
    return status;
  }
}

/**
 * Factory function para criar circuit breaker
 */
export function createCircuitBreaker(
  config: Partial<CircuitBreakerConfig> = {},
  dependencies: DependencyConfig[] = [],
  notifications: Partial<NotificationConfig> = {}
) {
  const defaultConfig: CircuitBreakerConfig = {
    error_rate_window: process.env.CB_ERROR_WINDOW || '2m',
    error_rate_threshold: parseFloat(process.env.CB_ERRRATE_LIMIT || '0.25'),
    open_for_seconds: parseInt(process.env.CB_OPEN_SECS || '60'),
    backoff: {
      base_ms: 300,
      max_ms: 3000,
      jitter: true
    }
  };

  const defaultDependencies: DependencyConfig[] = [
    { name: 'trinks', match_tools: ['trinks.*'] },
    { name: 'evolution', match_tools: ['evolution.*'] }
  ];

  const defaultNotifications: NotificationConfig = {
    on_open: {
      channel: 'telegram',
      template: '⚠️ Breaker {{dep}} ABERTO.'
    },
    on_close: {
      channel: 'telegram', 
      template: '✅ Breaker {{dep}} FECHADO.'
    }
  };

  const finalConfig = { ...defaultConfig, ...config };
  const finalDependencies = dependencies.length > 0 ? dependencies : defaultDependencies;
  const finalNotifications = { ...defaultNotifications, ...notifications };

  return new CircuitBreaker(finalConfig, finalDependencies, finalNotifications);
}

/**
 * Circuit breaker pré-configurado
 */
export const defaultCircuitBreaker = createCircuitBreaker();

/**
 * Middleware pré-configurado
 */
export const circuitBreakerMiddleware = defaultCircuitBreaker.middleware();