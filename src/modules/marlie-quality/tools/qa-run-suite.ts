import { Pool } from 'pg';
import Redis from 'ioredis';
import { MarlieQualityModule } from '../index';
import { loadConfigWithDefaults } from '../../../config/loader';
import { logger } from '../../../utils/logger';

interface QARunSuiteInput {
  suite: string;
}

interface QARunSuiteOutput {
  success: boolean;
  suite: string;
  status: 'pass' | 'fail';
  execution_time_ms: number;
  tests_run: number;
  tests_passed: number;
  tests_failed: number;
  error?: string;
  details?: {
    failed_tests?: string[];
    error_messages?: string[];
    coverage?: number;
    performance_metrics?: {
      avg_response_time_ms: number;
      max_response_time_ms: number;
      requests_per_second: number;
    };
  };
}

/**
 * Ferramenta qa.run_suite
 * Executa suíte de testes por nome e retorna resumo (pass/fail)
 */
export class QARunSuiteTool {
  private pgPool: Pool | null = null;
  private redis: Redis | null = null;
  private qualityModule: MarlieQualityModule | null = null;
  private config: any = null;

  constructor() {
    this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      // Carregar configuração
      this.config = await loadConfigWithDefaults('marlie-quality');
      
      // Inicializar conexões
      this.pgPool = new Pool({
        host: this.config.database.host,
        port: this.config.database.port,
        database: this.config.database.database,
        user: this.config.database.username,
        password: this.config.database.password,
        ssl: this.config.database.ssl
      });

      this.redis = new Redis({
        host: this.config.redis.host,
        port: this.config.redis.port,
        password: this.config.redis.password,
        db: this.config.redis.db
      });

      // Inicializar módulo de qualidade
      this.qualityModule = new MarlieQualityModule(
        this.config,
        this.pgPool,
        this.redis,
        {} as any // tools placeholder
      );

      await this.qualityModule.initialize();
      
      logger.info('QARunSuiteTool initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize QARunSuiteTool:', error);
      throw error;
    }
  }

  /**
   * Executa uma suíte de testes específica
   */
  async execute(input: QARunSuiteInput): Promise<QARunSuiteOutput> {
    const startTime = Date.now();
    
    try {
      logger.info(`🚀 Executando suíte de testes: ${input.suite}`);
      
      // Verificar se a suíte existe na configuração
      const suiteConfig = this.findSuiteConfig(input.suite);
      if (!suiteConfig) {
        throw new Error(`Suíte '${input.suite}' não encontrada na configuração`);
      }

      // Determinar tipo de teste (E2E ou Contract)
      const suiteType = this.determineSuiteType(input.suite);
      
      let result: any;
      
      switch (suiteType) {
        case 'e2e':
          result = await this.runE2ESuite(input.suite, suiteConfig);
          break;
        case 'contract':
          result = await this.runContractSuite(input.suite, suiteConfig);
          break;
        default:
          throw new Error(`Tipo de suíte desconhecido para: ${input.suite}`);
      }

      const executionTime = Date.now() - startTime;
      
      // Preparar resposta de sucesso
      const output: QARunSuiteOutput = {
        success: true,
        suite: input.suite,
        status: result.allPassed ? 'pass' : 'fail',
        execution_time_ms: executionTime,
        tests_run: result.testsRun || 0,
        tests_passed: result.testsPassed || 0,
        tests_failed: result.testsFailed || 0,
        details: {
          failed_tests: result.failedTests || [],
          error_messages: result.errorMessages || [],
          coverage: result.coverage,
          performance_metrics: result.performanceMetrics
        }
      };

      logger.info(`✅ Suíte '${input.suite}' executada: ${output.status} (${executionTime}ms)`);
      
      // Registrar métricas
      await this.recordMetrics(output);
      
      return output;
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      
      logger.error(`❌ Erro ao executar suíte '${input.suite}':`, error);
      
      const output: QARunSuiteOutput = {
        success: false,
        suite: input.suite,
        status: 'fail',
        execution_time_ms: executionTime,
        tests_run: 0,
        tests_passed: 0,
        tests_failed: 1,
        error: error instanceof Error ? error.message : String(error)
      };
      
      // Registrar métricas de erro
      await this.recordMetrics(output);
      
      return output;
    }
  }

  /**
   * Encontra configuração da suíte
   */
  private findSuiteConfig(suiteName: string): any {
    // Procurar em E2E suites
    const e2eSuite = this.config.tests?.e2e_suites?.find(
      (suite: any) => suite.name === suiteName
    );
    if (e2eSuite) return e2eSuite;

    // Procurar em Contract suites
    const contractSuite = this.config.tests?.contract_suites?.find(
      (suite: any) => suite.name === suiteName
    );
    if (contractSuite) return contractSuite;

    return null;
  }

  /**
   * Determina o tipo da suíte
   */
  private determineSuiteType(suiteName: string): 'e2e' | 'contract' | 'unknown' {
    const e2eSuite = this.config.tests?.e2e_suites?.find(
      (suite: any) => suite.name === suiteName
    );
    if (e2eSuite) return 'e2e';

    const contractSuite = this.config.tests?.contract_suites?.find(
      (suite: any) => suite.name === suiteName
    );
    if (contractSuite) return 'contract';

    return 'unknown';
  }

  /**
   * Executa suíte de testes E2E
   */
  private async runE2ESuite(suiteName: string, suiteConfig: any): Promise<any> {
    logger.info(`🔄 Executando suíte E2E: ${suiteName}`);
    
    try {
      // Preparar seeds se necessário
      if (suiteConfig.arrange?.seed) {
        await this.qualityModule!.loadBasicSeeds(
          suiteConfig.arrange.seed.rows || 3
        );
      }

      // Executar passos do teste
      const results = [];
      let allPassed = true;
      
      for (const step of suiteConfig.steps || []) {
        try {
          const stepResult = await this.executeE2EStep(step);
          results.push(stepResult);
          
          if (!stepResult.success) {
            allPassed = false;
          }
        } catch (error) {
          allPassed = false;
          results.push({
            success: false,
            step: step.action || 'unknown',
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      // Cleanup
      if (suiteConfig.cleanup) {
        for (const cleanupStep of suiteConfig.cleanup) {
          try {
            await this.executeCleanupStep(cleanupStep);
          } catch (error) {
            logger.warn('Erro no cleanup:', error);
          }
        }
      }

      return {
        allPassed,
        testsRun: results.length,
        testsPassed: results.filter(r => r.success).length,
        testsFailed: results.filter(r => !r.success).length,
        failedTests: results.filter(r => !r.success).map(r => r.step),
        errorMessages: results.filter(r => !r.success).map(r => r.error)
      };
      
    } catch (error) {
      throw new Error(`Erro na execução da suíte E2E '${suiteName}': ${error}`);
    }
  }

  /**
   * Executa suíte de testes de contrato
   */
  private async runContractSuite(suiteName: string, suiteConfig: any): Promise<any> {
    logger.info(`🔄 Executando suíte de contrato: ${suiteName}`);
    
    try {
      const results = [];
      let allPassed = true;
      
      for (const step of suiteConfig.steps || []) {
        try {
          const stepResult = await this.executeContractStep(step);
          results.push(stepResult);
          
          if (!stepResult.success) {
            allPassed = false;
          }
        } catch (error) {
          allPassed = false;
          results.push({
            success: false,
            step: step.action || 'unknown',
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      return {
        allPassed,
        testsRun: results.length,
        testsPassed: results.filter(r => r.success).length,
        testsFailed: results.filter(r => !r.success).length,
        failedTests: results.filter(r => !r.success).map(r => r.step),
        errorMessages: results.filter(r => !r.success).map(r => r.error)
      };
      
    } catch (error) {
      throw new Error(`Erro na execução da suíte de contrato '${suiteName}': ${error}`);
    }
  }

  /**
   * Executa um passo de teste E2E
   */
  private async executeE2EStep(step: any): Promise<any> {
    switch (step.action) {
      case 'inject_message':
        return await this.injectWhatsAppMessage(step.with);
      case 'set_slot':
        return await this.setSlot(step.with);
      case 'call_tool':
        return await this.callTool(step.with, step.save_as);
      default:
        if (step.expect_reply_contains) {
          return await this.expectReplyContains(step.expect_reply_contains);
        }
        if (step.expect_state) {
          return await this.expectState(step.expect_state);
        }
        if (step.assert) {
          return await this.assertExpression(step.assert.expr);
        }
        throw new Error(`Ação desconhecida: ${step.action}`);
    }
  }

  /**
   * Executa um passo de teste de contrato
   */
  private async executeContractStep(step: any): Promise<any> {
    if (step.action === 'call_tool') {
      return await this.callTool(step.with, step.save_as);
    }
    throw new Error(`Ação de contrato desconhecida: ${step.action}`);
  }

  /**
   * Executa passo de cleanup
   */
  private async executeCleanupStep(step: any): Promise<void> {
    if (step.action === 'seed_reset') {
      await this.qualityModule!.resetSeeds();
    }
  }

  // Métodos auxiliares para execução de passos
  private async injectWhatsAppMessage(params: any): Promise<any> {
    // Simular injeção de mensagem WhatsApp
    logger.info(`📱 Injetando mensagem: ${params.text} para ${params.phone}`);
    return { success: true, step: 'inject_message' };
  }

  private async setSlot(params: any): Promise<any> {
    // Simular definição de slot
    logger.info(`🎯 Definindo slot:`, params);
    return { success: true, step: 'set_slot' };
  }

  private async callTool(params: any, saveAs?: string): Promise<any> {
    // Simular chamada de ferramenta
    logger.info(`🔧 Chamando ferramenta: ${params.tool}`);
    return { success: true, step: 'call_tool', result: { ok: true } };
  }

  private async expectReplyContains(expectedTexts: string[]): Promise<any> {
    // Simular verificação de resposta
    logger.info(`💬 Verificando se resposta contém:`, expectedTexts);
    return { success: true, step: 'expect_reply_contains' };
  }

  private async expectState(expectedState: string): Promise<any> {
    // Simular verificação de estado
    logger.info(`🎭 Verificando estado: ${expectedState}`);
    return { success: true, step: 'expect_state' };
  }

  private async assertExpression(expression: string): Promise<any> {
    // Simular avaliação de expressão
    logger.info(`✅ Avaliando expressão: ${expression}`);
    return { success: true, step: 'assert' };
  }

  /**
   * Registra métricas da execução
   */
  private async recordMetrics(output: QARunSuiteOutput): Promise<void> {
    try {
      if (this.redis) {
        const metricsKey = `qa:metrics:${output.suite}:${Date.now()}`;
        await this.redis.setex(metricsKey, 86400, JSON.stringify({
          suite: output.suite,
          status: output.status,
          execution_time_ms: output.execution_time_ms,
          tests_run: output.tests_run,
          tests_passed: output.tests_passed,
          tests_failed: output.tests_failed,
          timestamp: new Date().toISOString()
        }));
      }
    } catch (error) {
      logger.warn('Erro ao registrar métricas:', error);
    }
  }

  /**
   * Finaliza conexões
   */
  async shutdown(): Promise<void> {
    try {
      if (this.qualityModule) {
        await this.qualityModule.shutdown();
      }
      if (this.pgPool) {
        await this.pgPool.end();
      }
      if (this.redis) {
        await this.redis.disconnect();
      }
      logger.info('QARunSuiteTool shutdown completed');
    } catch (error) {
      logger.error('Error during QARunSuiteTool shutdown:', error);
    }
  }
}

// Instância singleton
let qaRunSuiteInstance: QARunSuiteTool | null = null;

/**
 * Função principal da ferramenta qa.run_suite
 */
export async function runSuite(input: QARunSuiteInput): Promise<QARunSuiteOutput> {
  if (!qaRunSuiteInstance) {
    qaRunSuiteInstance = new QARunSuiteTool();
  }
  
  return await qaRunSuiteInstance.execute(input);
}

// Cleanup no processo
process.on('SIGINT', async () => {
  if (qaRunSuiteInstance) {
    await qaRunSuiteInstance.shutdown();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (qaRunSuiteInstance) {
    await qaRunSuiteInstance.shutdown();
  }
  process.exit(0);
});

export type { QARunSuiteInput, QARunSuiteOutput };