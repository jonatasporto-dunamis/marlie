/**
 * Rotas Administrativas - Módulo Marlie Quality
 * 
 * Endpoints para:
 * - Execução de seeds
 * - Execução de testes E2E
 * - Execução de testes de contrato
 * - Pipeline CI/CD
 * - Métricas e monitoramento
 */

import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger';
import { MarlieQualityModule } from './index';
import { authenticateAdmin } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validation';
import { z } from 'zod';

/**
 * Schemas de validação
 */
const SeedRequestSchema = z.object({
  rows: z.number().min(1).max(100).default(3)
});

const E2ETestRequestSchema = z.object({
  scenario: z.string().optional(),
  environment: z.enum(['staging', 'production']).default('staging'),
  timeout: z.number().min(1000).max(300000).default(30000)
});

const ContractTestRequestSchema = z.object({
  service: z.enum(['trinks', 'evolution', 'all']).default('all'),
  environment: z.enum(['staging', 'production']).default('staging')
});

const PipelineRequestSchema = z.object({
  stages: z.array(z.enum(['build', 'lint', 'test', 'scan', 'deploy'])).optional(),
  environment: z.enum(['staging', 'production']).default('staging'),
  strategy: z.enum(['rolling', 'blue-green', 'canary']).default('rolling'),
  rollbackOnFailure: z.boolean().default(true)
});

const StubFailureRequestSchema = z.object({
  operation: z.enum([
    'trinks.fetch_appointments',
    'trinks.validate_availability',
    'trinks.create_appointment',
    'evolution.send_message',
    'evolution.get_status'
  ]),
  shouldFail: z.boolean()
});

const StubDelayRequestSchema = z.object({
  operation: z.enum([
    'trinks.fetch_appointments',
    'trinks.validate_availability',
    'trinks.create_appointment',
    'evolution.send_message',
    'evolution.get_status'
  ]),
  delayMs: z.number().min(0).max(30000)
});

const TestDataRequestSchema = z.object({
  type: z.enum(['appointment', 'service', 'client'])
});

/**
 * Cria router com todas as rotas administrativas
 */
export function createQualityRoutes(qualityModule: MarlieQualityModule): Router {
  const router = Router();

  /**
   * Health Check
   */
  router.get('/health', async (req: Request, res: Response) => {
    try {
      const health = await qualityModule.getHealthStatus();
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        module: 'marlie-quality',
        ...health
      });
    } catch (error) {
      logger.error('Health check failed:', error);
      res.status(500).json({
        status: 'error',
        message: 'Health check failed',
        error: error.message
      });
    }
  });

  /**
   * Métricas do módulo
   */
  router.get('/metrics', authenticateAdmin, async (req: Request, res: Response) => {
    try {
      const metrics = await qualityModule.getMetrics();
      res.json({
        success: true,
        data: metrics,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get metrics:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get metrics',
        error: error.message
      });
    }
  });

  // ==================== SEEDS ====================

  /**
   * Carregar seeds básicos
   */
  router.post('/seed', 
    authenticateAdmin,
    validateRequest(SeedRequestSchema),
    async (req: Request, res: Response) => {
      try {
        const { rows } = req.body;
        
        logger.info(`Loading seeds with ${rows} rows`);
        const result = await qualityModule.loadBasicSeeds(rows);
        
        res.json({
          success: true,
          message: `Successfully loaded ${rows} seed records`,
          data: result,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        logger.error('Failed to load seeds:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to load seeds',
          error: error.message
        });
      }
    }
  );

  /**
   * Reset de dados de teste
   */
  router.post('/seed/reset', 
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        logger.info('Resetting test data');
        const result = await qualityModule.resetTestData();
        
        res.json({
          success: true,
          message: 'Test data reset successfully',
          data: result,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        logger.error('Failed to reset test data:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to reset test data',
          error: error.message
        });
      }
    }
  );

  /**
   * Status dos seeds
   */
  router.get('/seed/status', 
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const status = await qualityModule.getSeedStatus();
        
        res.json({
          success: true,
          data: status,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        logger.error('Failed to get seed status:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to get seed status',
          error: error.message
        });
      }
    }
  );

  // ==================== TESTES E2E ====================

  /**
   * Executar testes E2E
   */
  router.post('/test/e2e',
    authenticateAdmin,
    validateRequest(E2ETestRequestSchema),
    async (req: Request, res: Response) => {
      try {
        const { scenario, environment, timeout } = req.body;
        
        logger.info(`Running E2E tests`, { scenario, environment, timeout });
        
        // Executar de forma assíncrona para não bloquear a resposta
        const testPromise = qualityModule.runE2ETests({
          scenario,
          environment,
          timeout
        });
        
        // Responder imediatamente com ID de execução
        const executionId = `e2e-${Date.now()}`;
        
        res.json({
          success: true,
          message: 'E2E tests started',
          executionId,
          status: 'running',
          timestamp: new Date().toISOString()
        });
        
        // Processar resultado em background
        testPromise
          .then(result => {
            logger.info(`E2E tests completed: ${executionId}`, result);
          })
          .catch(error => {
            logger.error(`E2E tests failed: ${executionId}`, error);
          });
        
      } catch (error) {
        logger.error('Failed to start E2E tests:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to start E2E tests',
          error: error.message
        });
      }
    }
  );

  /**
   * Status dos testes E2E
   */
  router.get('/test/e2e/status/:executionId?',
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const { executionId } = req.params;
        const status = await qualityModule.getE2ETestStatus(executionId);
        
        res.json({
          success: true,
          data: status,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        logger.error('Failed to get E2E test status:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to get E2E test status',
          error: error.message
        });
      }
    }
  );

  // ==================== TESTES DE CONTRATO ====================

  /**
   * Executar testes de contrato
   */
  router.post('/test/contract',
    authenticateAdmin,
    validateRequest(ContractTestRequestSchema),
    async (req: Request, res: Response) => {
      try {
        const { service, environment } = req.body;
        
        logger.info(`Running contract tests`, { service, environment });
        
        const result = await qualityModule.runContractTests({
          service,
          environment
        });
        
        res.json({
          success: true,
          message: 'Contract tests completed',
          data: result,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        logger.error('Failed to run contract tests:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to run contract tests',
          error: error.message
        });
      }
    }
  );

  /**
   * Histórico de testes de contrato
   */
  router.get('/test/contract/history',
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const history = await qualityModule.getContractTestHistory();
        
        res.json({
          success: true,
          data: history,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        logger.error('Failed to get contract test history:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to get contract test history',
          error: error.message
        });
      }
    }
  );

  // ==================== STUBS ====================

  /**
   * Status dos stubs
   */
  router.get('/stubs/status',
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const status = await qualityModule.getStubStatus();
        
        res.json({
          success: true,
          data: status,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        logger.error('Failed to get stub status:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to get stub status',
          error: error.message
        });
      }
    }
  );

  /**
    * Configurar falha em stub
    */
   router.post('/stubs/failure',
     authenticateAdmin,
     validateRequest(StubFailureRequestSchema),
     async (req: Request, res: Response) => {
      try {
        const { operation, shouldFail } = req.body;
        
        await qualityModule.setStubFailure(operation, shouldFail);
        
        res.json({
          success: true,
          message: `Stub failure flag definida: ${operation} = ${shouldFail}`,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        logger.error('Failed to set stub failure:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to set stub failure',
          error: error.message
        });
      }
    }
  );

  /**
    * Configurar delay em stub
    */
   router.post('/stubs/delay',
     authenticateAdmin,
     validateRequest(StubDelayRequestSchema),
     async (req: Request, res: Response) => {
      try {
        const { operation, delayMs } = req.body;
        
        await qualityModule.setStubDelay(operation, delayMs);
        
        res.json({
          success: true,
          message: `Stub delay flag definida: ${operation} = ${delayMs}ms`,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        logger.error('Failed to set stub delay:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to set stub delay',
          error: error.message
        });
      }
    }
  );

  /**
   * Limpar todas as flags de stub
   */
  router.delete('/stubs/flags',
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        await qualityModule.clearStubFlags();
        
        res.json({
          success: true,
          message: 'Todas as flags de stub foram limpas',
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        logger.error('Failed to clear stub flags:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to clear stub flags',
          error: error.message
        });
      }
    }
  );

  /**
    * Gerar dados de teste
    */
   router.post('/stubs/test-data',
     authenticateAdmin,
     validateRequest(TestDataRequestSchema),
     async (req: Request, res: Response) => {
      try {
        const { type } = req.body;
        
        const data = await qualityModule.generateTestData(type);
        
        res.json({
          success: true,
          data,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        logger.error('Failed to generate test data:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to generate test data',
          error: error.message
        });
      }
    }
  );

  // ==================== PIPELINE CI/CD ====================

  /**
   * Executar pipeline completo
   */
  router.post('/pipeline/run',
    authenticateAdmin,
    validateRequest(PipelineRequestSchema),
    async (req: Request, res: Response) => {
      try {
        const { stages, environment, strategy, rollbackOnFailure } = req.body;
        
        logger.info(`Starting pipeline`, { stages, environment, strategy });
        
        // Executar de forma assíncrona
        const pipelinePromise = qualityModule.runPipeline({
          stages,
          environment,
          strategy,
          rollbackOnFailure
        });
        
        const executionId = `pipeline-${Date.now()}`;
        
        res.json({
          success: true,
          message: 'Pipeline started',
          executionId,
          status: 'running',
          timestamp: new Date().toISOString()
        });
        
        // Processar resultado em background
        pipelinePromise
          .then(result => {
            logger.info(`Pipeline completed: ${executionId}`, result);
          })
          .catch(error => {
            logger.error(`Pipeline failed: ${executionId}`, error);
          });
        
      } catch (error) {
        logger.error('Failed to start pipeline:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to start pipeline',
          error: error.message
        });
      }
    }
  );

  /**
   * Schema para validação da ferramenta qa.run_suite
   */
  const QARunSuiteSchema = z.object({
    suite: z.string().min(1, 'Nome da suíte é obrigatório')
  });

  /**
   * Rota webhook para ferramenta qa.run_suite
   */
  router.post('/run',
    authenticateAdmin,
    validateRequest(QARunSuiteSchema),
    async (req: Request, res: Response) => {
      try {
        const { suite } = req.body;
        
        logger.info('🧪 Executando suíte de testes via webhook', { suite });
        
        // Importar e executar ferramenta qa.run_suite
        const { runSuite } = await import('./tools/qa-run-suite');
        const result = await runSuite({ suite });
        
        // Responder com resultado da execução
        res.json(result);
        
      } catch (error) {
        logger.error('Erro ao executar suíte de testes:', error);
        res.status(500).json({
          success: false,
          suite: req.body.suite || 'unknown',
          status: 'fail',
          execution_time_ms: 0,
          tests_run: 0,
          tests_passed: 0,
          tests_failed: 1,
          error: error instanceof Error ? error.message : 'Erro desconhecido'
        });
      }
    }
  );

  /**
   * Status do pipeline
   */
  router.get('/pipeline/status/:executionId?',
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const { executionId } = req.params;
        const status = await qualityModule.getPipelineStatus(executionId);
        
        res.json({
          success: true,
          data: status,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        logger.error('Failed to get pipeline status:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to get pipeline status',
          error: error.message
        });
      }
    }
  );

  /**
   * Histórico de deploys
   */
  router.get('/pipeline/deploy/history',
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const history = await qualityModule.getDeployHistory();
        
        res.json({
          success: true,
          data: history,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        logger.error('Failed to get deploy history:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to get deploy history',
          error: error.message
        });
      }
    }
  );

  /**
   * Rollback para versão anterior
   */
  router.post('/pipeline/rollback',
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const { version, environment } = req.body;
        
        logger.info(`Initiating rollback`, { version, environment });
        
        const result = await qualityModule.rollbackDeploy({
          version,
          environment: environment || 'staging'
        });
        
        res.json({
          success: true,
          message: 'Rollback completed',
          data: result,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        logger.error('Failed to rollback:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to rollback',
          error: error.message
        });
      }
    }
  );

  /**
   * Cancelar execução
   */
  router.post('/cancel/:executionId',
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const { executionId } = req.params;
        
        logger.info(`Cancelling execution: ${executionId}`);
        
        await qualityModule.cancelExecution(executionId);
        
        res.json({
          success: true,
          message: `Execution ${executionId} cancelled`,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        logger.error('Failed to cancel execution:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to cancel execution',
          error: error.message
        });
      }
    }
  );

  // ==================== CONFIGURAÇÃO ====================

  /**
   * Obter configuração atual
   */
  router.get('/config',
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const config = await qualityModule.getConfig();
        
        res.json({
          success: true,
          data: config,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        logger.error('Failed to get config:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to get config',
          error: error.message
        });
      }
    }
  );

  /**
   * Atualizar configuração
   */
  router.put('/config',
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const newConfig = req.body;
        
        logger.info('Updating quality module config');
        
        await qualityModule.updateConfig(newConfig);
        
        res.json({
          success: true,
          message: 'Configuration updated successfully',
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        logger.error('Failed to update config:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to update config',
          error: error.message
        });
      }
    }
  );

  // ==================== LOGS ====================

  /**
   * Obter logs recentes
   */
  router.get('/logs',
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const { level, limit, since } = req.query;
        
        const logs = await qualityModule.getLogs({
          level: level as string,
          limit: limit ? parseInt(limit as string) : 100,
          since: since ? new Date(since as string) : undefined
        });
        
        res.json({
          success: true,
          data: logs,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        logger.error('Failed to get logs:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to get logs',
          error: error.message
        });
      }
    }
  );

  return router;
}

/**
 * Middleware de tratamento de erros específico para rotas de qualidade
 */
export function qualityErrorHandler(error: any, req: Request, res: Response, next: any) {
  logger.error('Quality route error:', {
    path: req.path,
    method: req.method,
    error: error.message,
    stack: error.stack
  });

  // Erros específicos do módulo de qualidade
  if (error.name === 'TestExecutionError') {
    return res.status(422).json({
      success: false,
      message: 'Test execution failed',
      error: error.message,
      details: error.details
    });
  }

  if (error.name === 'PipelineError') {
    return res.status(422).json({
      success: false,
      message: 'Pipeline execution failed',
      error: error.message,
      stage: error.stage,
      details: error.details
    });
  }

  if (error.name === 'SeedError') {
    return res.status(422).json({
      success: false,
      message: 'Seed operation failed',
      error: error.message,
      operation: error.operation
    });
  }

  // Erro genérico
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
}

/**
 * Exportações
 */
export {
  E2ETestRequestSchema,
  ContractTestRequestSchema,
  SeedRequestSchema,
  PipelineRequestSchema,
  StubFailureRequestSchema,
  StubDelayRequestSchema,
  TestDataRequestSchema,
  QARunSuiteSchema
};