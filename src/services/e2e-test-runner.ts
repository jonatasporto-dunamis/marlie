/**
 * Serviço de Testes E2E (End-to-End)
 * 
 * Responsável por:
 * - Simular fluxo completo WhatsApp → diálogo → confirmação → Trinks
 * - Executar cenários de teste automatizados
 * - Validar integrações entre componentes
 * - Gerar relatórios de execução
 */

import { logger } from '../utils/logger';
import { MarlieQualityConfig, QualityTools } from '../modules/marlie-quality';
import axios, { AxiosInstance } from 'axios';
import { EventEmitter } from 'events';

/**
 * Cenários de teste disponíveis
 */
export type TestScenario = 
  | 'full_flow'
  | 'whatsapp_only'
  | 'dialog_only'
  | 'trinks_only'
  | 'error_handling'
  | 'performance';

/**
 * Resultado de um teste E2E
 */
export interface E2ETestResult {
  scenario: TestScenario;
  success: boolean;
  duration: number;
  steps: Array<{
    name: string;
    success: boolean;
    duration: number;
    error?: string;
    data?: any;
  }>;
  summary: {
    totalSteps: number;
    successfulSteps: number;
    failedSteps: number;
    averageStepDuration: number;
  };
  errors?: string[];
}

/**
 * Configuração de um passo de teste
 */
interface TestStep {
  name: string;
  timeout: number;
  retries: number;
  execute: () => Promise<any>;
  validate?: (result: any) => boolean;
}

/**
 * Dados de teste para simulação
 */
interface TestData {
  client: {
    phone: string;
    name: string;
  };
  service: {
    id: string;
    name: string;
  };
  professional: {
    id: string;
    name: string;
  };
  appointment: {
    date: string;
    time: string;
  };
}

/**
 * Serviço de Testes E2E
 */
export class E2ETestRunner extends EventEmitter {
  private config: MarlieQualityConfig;
  private tools: QualityTools;
  private whatsappClient: AxiosInstance;
  private apiClient: AxiosInstance;
  private trinksClient: AxiosInstance;
  private isInitialized: boolean = false;

  constructor(config: MarlieQualityConfig, tools: QualityTools) {
    super();
    this.config = config;
    this.tools = tools;

    // Configurar clientes HTTP
    this.whatsappClient = axios.create({
      baseURL: config.integrations?.evolution?.base_url || 'http://localhost:8080',
      timeout: config.tests?.e2e?.timeout || 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    this.apiClient = axios.create({
      baseURL: process.env.API_BASE_URL || 'http://localhost:3000',
      timeout: config.tests?.e2e?.timeout || 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    this.trinksClient = axios.create({
      baseURL: config.integrations?.trinks?.base_url || 'https://api.trinks.com',
      timeout: config.tests?.e2e?.timeout || 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Inicializa o runner de testes E2E
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      logger.info('Initializing E2ETestRunner...');

      // Verificar conectividade com APIs
      await this.verifyConnectivity();

      // Configurar interceptors para logging
      this.setupHttpInterceptors();

      this.isInitialized = true;
      logger.info('E2ETestRunner initialized successfully');

    } catch (error) {
      logger.error('Failed to initialize E2ETestRunner:', error);
      throw error;
    }
  }

  /**
   * Executa um cenário de teste
   */
  async runScenario(scenario: TestScenario): Promise<E2ETestResult> {
    if (!this.isInitialized) {
      throw new Error('E2ETestRunner must be initialized before running scenarios');
    }

    const startTime = Date.now();
    logger.info(`Starting E2E test scenario: ${scenario}`);

    try {
      const steps = this.getScenarioSteps(scenario);
      const testData = this.generateTestData();
      const stepResults = [];

      for (const step of steps) {
        const stepResult = await this.executeStep(step, testData);
        stepResults.push(stepResult);

        // Parar execução se passo crítico falhar
        if (!stepResult.success && this.isCriticalStep(step.name)) {
          logger.warn(`Critical step failed: ${step.name}`);
          break;
        }
      }

      const duration = Date.now() - startTime;
      const successfulSteps = stepResults.filter(s => s.success).length;
      const failedSteps = stepResults.filter(s => !s.success).length;

      const result: E2ETestResult = {
        scenario,
        success: failedSteps === 0,
        duration,
        steps: stepResults,
        summary: {
          totalSteps: stepResults.length,
          successfulSteps,
          failedSteps,
          averageStepDuration: stepResults.length > 0 
            ? stepResults.reduce((sum, s) => sum + s.duration, 0) / stepResults.length 
            : 0
        },
        errors: stepResults.filter(s => s.error).map(s => s.error!)
      };

      logger.info(`E2E test scenario ${scenario} completed`, {
        success: result.success,
        duration,
        steps: result.summary
      });

      this.emit('scenario_completed', result);
      return result;

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`E2E test scenario ${scenario} failed:`, error);

      const result: E2ETestResult = {
        scenario,
        success: false,
        duration,
        steps: [],
        summary: {
          totalSteps: 0,
          successfulSteps: 0,
          failedSteps: 1,
          averageStepDuration: 0
        },
        errors: [(error as Error).message]
      };

      this.emit('scenario_failed', result);
      return result;
    }
  }

  /**
   * Obtém os passos para um cenário específico
   */
  private getScenarioSteps(scenario: TestScenario): TestStep[] {
    switch (scenario) {
      case 'full_flow':
        return [
          {
            name: 'send_whatsapp_message',
            timeout: 10000,
            retries: 2,
            execute: () => this.sendWhatsAppMessage()
          },
          {
            name: 'process_dialog',
            timeout: 15000,
            retries: 1,
            execute: () => this.processDialog()
          },
          {
            name: 'confirm_appointment',
            timeout: 10000,
            retries: 2,
            execute: () => this.confirmAppointment()
          },
          {
            name: 'sync_with_trinks',
            timeout: 20000,
            retries: 3,
            execute: () => this.syncWithTrinks()
          },
          {
            name: 'validate_booking',
            timeout: 10000,
            retries: 1,
            execute: () => this.validateBooking()
          }
        ];

      case 'whatsapp_only':
        return [
          {
            name: 'send_whatsapp_message',
            timeout: 10000,
            retries: 2,
            execute: () => this.sendWhatsAppMessage()
          },
          {
            name: 'receive_whatsapp_response',
            timeout: 15000,
            retries: 1,
            execute: () => this.receiveWhatsAppResponse()
          }
        ];

      case 'dialog_only':
        return [
          {
            name: 'start_dialog',
            timeout: 5000,
            retries: 1,
            execute: () => this.startDialog()
          },
          {
            name: 'process_intent',
            timeout: 10000,
            retries: 2,
            execute: () => this.processIntent()
          },
          {
            name: 'generate_response',
            timeout: 8000,
            retries: 1,
            execute: () => this.generateResponse()
          }
        ];

      case 'trinks_only':
        return [
          {
            name: 'authenticate_trinks',
            timeout: 5000,
            retries: 2,
            execute: () => this.authenticateWithTrinks()
          },
          {
            name: 'create_booking',
            timeout: 15000,
            retries: 3,
            execute: () => this.createTrinksBooking()
          },
          {
            name: 'confirm_booking',
            timeout: 10000,
            retries: 2,
            execute: () => this.confirmTrinksBooking()
          }
        ];

      case 'error_handling':
        return [
          {
            name: 'test_invalid_input',
            timeout: 5000,
            retries: 0,
            execute: () => this.testInvalidInput()
          },
          {
            name: 'test_api_timeout',
            timeout: 2000,
            retries: 0,
            execute: () => this.testApiTimeout()
          },
          {
            name: 'test_error_recovery',
            timeout: 10000,
            retries: 1,
            execute: () => this.testErrorRecovery()
          }
        ];

      case 'performance':
        return [
          {
            name: 'measure_response_time',
            timeout: 30000,
            retries: 0,
            execute: () => this.measureResponseTime()
          },
          {
            name: 'test_concurrent_requests',
            timeout: 45000,
            retries: 0,
            execute: () => this.testConcurrentRequests()
          },
          {
            name: 'measure_memory_usage',
            timeout: 15000,
            retries: 0,
            execute: () => this.measureMemoryUsage()
          }
        ];

      default:
        throw new Error(`Unknown test scenario: ${scenario}`);
    }
  }

  /**
   * Executa um passo de teste
   */
  private async executeStep(step: TestStep, testData: TestData): Promise<{
    name: string;
    success: boolean;
    duration: number;
    error?: string;
    data?: any;
  }> {
    const startTime = Date.now();
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= step.retries) {
      try {
        logger.debug(`Executing step: ${step.name} (attempt ${attempt + 1})`);
        
        const result = await Promise.race([
          step.execute(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Step timeout')), step.timeout)
          )
        ]);

        // Validar resultado se função de validação fornecida
        if (step.validate && !step.validate(result)) {
          throw new Error('Step validation failed');
        }

        const duration = Date.now() - startTime;
        logger.debug(`Step ${step.name} completed successfully in ${duration}ms`);

        return {
          name: step.name,
          success: true,
          duration,
          data: result
        };

      } catch (error) {
        lastError = error as Error;
        attempt++;
        
        if (attempt <= step.retries) {
          logger.warn(`Step ${step.name} failed, retrying (${attempt}/${step.retries}):`, (error as Error).message);
          await this.delay(1000 * attempt); // Backoff exponencial
        }
      }
    }

    const duration = Date.now() - startTime;
    logger.error(`Step ${step.name} failed after ${step.retries + 1} attempts:`, lastError?.message);

    return {
      name: step.name,
      success: false,
      duration,
      error: lastError?.message || 'Unknown error'
    };
  }

  /**
   * Implementações dos passos de teste
   */
  private async sendWhatsAppMessage(): Promise<any> {
    const message = {
      to: '+5571999999999',
      type: 'text',
      text: {
        body: 'Olá! Gostaria de agendar um horário.'
      }
    };

    if (this.config.tests?.useTrinksStubs) {
      // Simular envio em ambiente de teste
      await this.delay(500);
      return { messageId: 'test-msg-001', status: 'sent' };
    }

    const response = await this.whatsappClient.post('/messages', message);
    return response.data;
  }

  private async receiveWhatsAppResponse(): Promise<any> {
    if (this.config.tests?.useTrinksStubs) {
      await this.delay(1000);
      return { messageId: 'test-response-001', content: 'Claro! Vou te ajudar com o agendamento.' };
    }

    // Simular recebimento de resposta
    const response = await this.whatsappClient.get('/messages/test-msg-001');
    return response.data;
  }

  private async processDialog(): Promise<any> {
    const dialogRequest = {
      message: 'Gostaria de agendar um horário',
      context: {
        phone: '+5571999999999',
        sessionId: 'test-session-001'
      }
    };

    const response = await this.apiClient.post('/dialog/process', dialogRequest);
    return response.data;
  }

  private async startDialog(): Promise<any> {
    const response = await this.apiClient.post('/dialog/start', {
      phone: '+5571999999999'
    });
    return response.data;
  }

  private async processIntent(): Promise<any> {
    const response = await this.apiClient.post('/dialog/intent', {
      message: 'Quero agendar um corte de cabelo',
      sessionId: 'test-session-001'
    });
    return response.data;
  }

  private async generateResponse(): Promise<any> {
    const response = await this.apiClient.post('/dialog/response', {
      intent: 'schedule_appointment',
      entities: {
        service: 'corte de cabelo',
        date: 'amanhã'
      }
    });
    return response.data;
  }

  private async confirmAppointment(): Promise<any> {
    const appointmentData = {
      clientPhone: '+5571999999999',
      serviceId: 'seed-service-001',
      professionalId: 'seed-professional-001',
      scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    };

    const response = await this.apiClient.post('/appointments/confirm', appointmentData);
    return response.data;
  }

  private async authenticateWithTrinks(): Promise<any> {
    if (this.config.tests?.useTrinksStubs) {
      await this.delay(200);
      return { token: 'test-token-001', expiresIn: 3600 };
    }

    const response = await this.trinksClient.post('/auth/login', {
      username: process.env.TRINKS_USERNAME,
      password: process.env.TRINKS_PASSWORD
    });
    return response.data;
  }

  private async createTrinksBooking(): Promise<any> {
    const bookingData = {
      clientName: 'Cliente Teste',
      clientPhone: '+5571999999999',
      service: 'Corte de Cabelo',
      professional: 'Profissional 1',
      date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    };

    if (this.config.tests?.useTrinksStubs) {
      await this.delay(1000);
      return { bookingId: 'test-booking-001', status: 'created' };
    }

    const response = await this.trinksClient.post('/bookings', bookingData);
    return response.data;
  }

  private async confirmTrinksBooking(): Promise<any> {
    if (this.config.tests?.useTrinksStubs) {
      await this.delay(500);
      return { bookingId: 'test-booking-001', status: 'confirmed' };
    }

    const response = await this.trinksClient.patch('/bookings/test-booking-001/confirm');
    return response.data;
  }

  private async syncWithTrinks(): Promise<any> {
    const syncData = {
      appointmentId: 'seed-appointment-001',
      action: 'create'
    };

    const response = await this.apiClient.post('/integrations/trinks/sync', syncData);
    return response.data;
  }

  private async validateBooking(): Promise<any> {
    const response = await this.apiClient.get('/appointments/seed-appointment-001/status');
    return response.data;
  }

  private async testInvalidInput(): Promise<any> {
    try {
      await this.apiClient.post('/dialog/process', { invalid: 'data' });
      throw new Error('Expected validation error');
    } catch (error) {
      if ((error as any).response?.status === 400) {
        return { error: 'validation_error', handled: true };
      }
      throw error;
    }
  }

  private async testApiTimeout(): Promise<any> {
    // Simular timeout
    await this.delay(5000);
    return { timeout: true };
  }

  private async testErrorRecovery(): Promise<any> {
    // Testar recuperação de erro
    const response = await this.apiClient.post('/test/error-recovery', {
      simulateError: true
    });
    return response.data;
  }

  private async measureResponseTime(): Promise<any> {
    const iterations = 10;
    const times = [];

    for (let i = 0; i < iterations; i++) {
      const start = Date.now();
      await this.apiClient.get('/health');
      times.push(Date.now() - start);
    }

    return {
      iterations,
      averageTime: times.reduce((sum, time) => sum + time, 0) / times.length,
      minTime: Math.min(...times),
      maxTime: Math.max(...times)
    };
  }

  private async testConcurrentRequests(): Promise<any> {
    const concurrency = 5;
    const requests = [];

    for (let i = 0; i < concurrency; i++) {
      requests.push(this.apiClient.get('/health'));
    }

    const start = Date.now();
    const results = await Promise.allSettled(requests);
    const duration = Date.now() - start;

    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    return {
      concurrency,
      duration,
      successful,
      failed,
      throughput: (successful / duration) * 1000
    };
  }

  private async measureMemoryUsage(): Promise<any> {
    const memBefore = process.memoryUsage();
    
    // Simular operação que consome memória
    const data = new Array(100000).fill('test data');
    await this.delay(1000);
    
    const memAfter = process.memoryUsage();
    
    return {
      before: memBefore,
      after: memAfter,
      delta: {
        rss: memAfter.rss - memBefore.rss,
        heapUsed: memAfter.heapUsed - memBefore.heapUsed,
        heapTotal: memAfter.heapTotal - memBefore.heapTotal
      }
    };
  }

  /**
   * Métodos auxiliares
   */
  private generateTestData(): TestData {
    return {
      client: {
        phone: '+5571999999999',
        name: 'Cliente Teste E2E'
      },
      service: {
        id: 'seed-service-001',
        name: 'Corte de Cabelo'
      },
      professional: {
        id: 'seed-professional-001',
        name: 'Profissional 1'
      },
      appointment: {
        date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        time: '14:00'
      }
    };
  }

  private isCriticalStep(stepName: string): boolean {
    const criticalSteps = [
      'send_whatsapp_message',
      'authenticate_trinks',
      'confirm_appointment'
    ];
    return criticalSteps.includes(stepName);
  }

  private async verifyConnectivity(): Promise<void> {
    try {
      // Verificar API local
      await this.apiClient.get('/health');
      logger.info('Local API connectivity verified');
    } catch (error) {
      logger.warn('Local API not available, some tests may fail');
    }

    if (!this.config.tests?.useTrinksStubs) {
      try {
        // Verificar APIs externas apenas se não estiver usando stubs
        await this.trinksClient.get('/health');
        logger.info('Trinks API connectivity verified');
      } catch (error) {
        logger.warn('Trinks API not available, using fallback behavior');
      }
    }
  }

  private setupHttpInterceptors(): void {
    // Interceptor para requests
    [this.apiClient, this.whatsappClient, this.trinksClient].forEach(client => {
      client.interceptors.request.use(
        (config) => {
          logger.debug(`HTTP Request: ${config.method?.toUpperCase()} ${config.url}`);
          return config;
        },
        (error) => {
          logger.error('HTTP Request Error:', error);
          return Promise.reject(error);
        }
      );

      client.interceptors.response.use(
        (response) => {
          logger.debug(`HTTP Response: ${response.status} ${response.config.url}`);
          return response;
        },
        (error) => {
          logger.error(`HTTP Response Error: ${error.response?.status} ${error.config?.url}`);
          return Promise.reject(error);
        }
      );
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Finaliza o runner
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down E2ETestRunner...');
    this.removeAllListeners();
    this.isInitialized = false;
    logger.info('E2ETestRunner shutdown completed');
  }
}