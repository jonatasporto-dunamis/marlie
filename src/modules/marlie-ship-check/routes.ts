import { Router } from 'express';
import { z } from 'zod';
import { logger } from '../../utils/logger';
import { runShipCheck } from './index';
import { TestExecutor } from './tools/test-executor';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

const router = Router();

// Schema de validação para execução de ship check
const ShipCheckRunSchema = z.object({
  environment: z.enum(['development', 'staging', 'production']).optional().default('development'),
  dry_run: z.boolean().optional().default(false),
  skip_ci_cd: z.boolean().optional().default(false),
  config_path: z.string().optional()
});

// Schema para execução de suite específica
const SuiteRunSchema = z.object({
  suite: z.string(),
  environment: z.enum(['development', 'staging', 'production']).optional().default('development')
});

/**
 * POST /ship-check/run
 * Executa verificação completa de entregáveis + CI/CD
 */
router.post('/run', async (req, res) => {
  try {
    const params = ShipCheckRunSchema.parse(req.body);
    
    logger.info(`🚀 Iniciando ship check - ambiente: ${params.environment}`);
    
    // Executar ship check
    const result = await runShipCheck(params.config_path);
    
    // Determinar status HTTP baseado no resultado
    const statusCode = result.success ? 200 : 422;
    
    res.status(statusCode).json({
      success: result.success,
      environment: params.environment,
      dry_run: params.dry_run,
      deliverables: result.deliverables,
      ci_cd: result.ci_cd,
      duration_ms: result.duration_ms,
      errors: result.errors,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('❌ Erro ao executar ship check:', error);
    
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * POST /ship-check/suite
 * Executa apenas uma suite específica de testes
 */
router.post('/suite', async (req, res) => {
  try {
    const params = SuiteRunSchema.parse(req.body);
    
    logger.info(`🧪 Executando suite: ${params.suite}`);
    
    // Carregar configuração
    const configPath = path.join(__dirname, 'config', 'ship-check.yaml');
    const configContent = fs.readFileSync(configPath, 'utf8');
    const config = yaml.load(configContent) as any;
    
    // Encontrar suite
    const suite = config.tests.suites.find((s: any) => s.name === params.suite);
    if (!suite) {
      return res.status(404).json({
        success: false,
        error: `Suite não encontrada: ${params.suite}`,
        available_suites: config.tests.suites.map((s: any) => s.name)
      });
    }
    
    // Executar suite
    const executor = new TestExecutor();
    const result = await executor.executeSuite(suite, config.env);
    
    const statusCode = result.success ? 200 : 422;
    
    res.status(statusCode).json({
      success: result.success,
      suite: result.suite,
      environment: params.environment,
      steps_passed: result.steps_passed,
      steps_failed: result.steps_failed,
      total_steps: result.total_steps,
      duration_ms: result.duration_ms,
      errors: result.errors,
      variables: result.variables,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('❌ Erro ao executar suite:', error);
    
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /ship-check/status
 * Obtém status atual do sistema e últimas execuções
 */
router.get('/status', async (req, res) => {
  try {
    // Verificar saúde básica dos componentes
    const healthChecks = {
      api: true, // Se chegou aqui, API está funcionando
      redis: false,
      database: false,
      evolution_api: false,
      trinks_api: false
    };
    
    // TODO: Implementar verificações reais de saúde
    // Por enquanto, retornar status básico
    
    res.json({
      success: true,
      system_health: healthChecks,
      last_ship_check: {
        timestamp: null,
        success: null,
        duration_ms: null
      },
      available_suites: ['deliverables_checklist'],
      environments: ['development', 'staging', 'production'],
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('❌ Erro ao obter status:', error);
    
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /ship-check/config
 * Retorna configuração atual (sem dados sensíveis)
 */
router.get('/config', async (req, res) => {
  try {
    const configPath = path.join(__dirname, 'config', 'ship-check.yaml');
    const configContent = fs.readFileSync(configPath, 'utf8');
    const config = yaml.load(configContent) as any;
    
    // Remover dados sensíveis
    const sanitizedConfig = {
      module: config.module,
      tools: config.tools?.map((tool: any) => ({
        name: tool.name,
        description: tool.description
      })),
      tests: {
        suites: config.tests?.suites?.map((suite: any) => ({
          name: suite.name,
          steps_count: suite.steps?.length || 0
        }))
      },
      ci_cd: {
        stages: config.ci_cd?.stages?.map((stage: any) => ({
          name: stage.name,
          commands_count: stage.run?.length || 0
        }))
      },
      notifications: config.notifications ? {
        slack: !!config.notifications.slack,
        email: !!config.notifications.email
      } : null,
      metrics: config.metrics,
      rollback: config.rollback,
      security: config.security
    };
    
    res.json({
      success: true,
      config: sanitizedConfig,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('❌ Erro ao obter configuração:', error);
    
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * POST /ship-check/validate
 * Valida configuração sem executar
 */
router.post('/validate', async (req, res) => {
  try {
    const { config_path } = req.body;
    
    const configFile = config_path || path.join(__dirname, 'config', 'ship-check.yaml');
    
    if (!fs.existsSync(configFile)) {
      return res.status(404).json({
        success: false,
        error: 'Arquivo de configuração não encontrado',
        path: configFile
      });
    }
    
    const configContent = fs.readFileSync(configFile, 'utf8');
    const config = yaml.load(configContent) as any;
    
    // Validações básicas
    const validations = {
      has_module: !!config.module,
      has_env: !!config.env,
      has_tools: !!config.tools && Array.isArray(config.tools),
      has_tests: !!config.tests && !!config.tests.suites,
      has_ci_cd: !!config.ci_cd && !!config.ci_cd.stages,
      valid_yaml: true // Se chegou aqui, YAML é válido
    };
    
    const isValid = Object.values(validations).every(v => v === true);
    
    res.json({
      success: isValid,
      validations,
      config_path: configFile,
      suites_count: config.tests?.suites?.length || 0,
      stages_count: config.ci_cd?.stages?.length || 0,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('❌ Erro ao validar configuração:', error);
    
    res.status(400).json({
      success: false,
      error: error.message,
      validations: {
        valid_yaml: false
      },
      timestamp: new Date().toISOString()
    });
  }
});

export { router as shipCheckRoutes };

// Exportar schemas para uso em outros módulos
export {
  ShipCheckRunSchema,
  SuiteRunSchema
};