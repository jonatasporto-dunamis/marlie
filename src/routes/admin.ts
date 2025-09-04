import { Router, Request, Response } from 'express';
import { adminAuth, requireAdminToken } from '../middleware/tokenAuth';
import { adminRateLimit } from '../middleware/rateLimiting';
import { ConfigService } from '../services/config';
import { getCurrentTenantId } from '../middleware/tenant';
import logger from '../utils/logger';
import { maskPIIInObject } from '../middleware/piiMasking';

const router = Router();
const configService = new ConfigService();

/**
 * Interface para requisições de configuração
 */
interface ConfigRequest {
  key: string;
  value: string;
  description?: string;
  category?: string;
}

interface ConfigUpdateRequest {
  value: string;
  description?: string;
}

/**
 * Aplicar middlewares de segurança a todas as rotas admin
 */
router.use(adminRateLimit);
router.use(adminAuth);
router.use(requireAdminToken);

/**
 * GET /admin/health
 * Health check específico para admin
 */
router.get('/health', async (req: Request, res: Response) => {
  try {
    const tenantId = getCurrentTenantId(req) || 'default';
    
    // Verificar se o ConfigService está funcionando
    const testKey = '__health_check__';
    await configService.set(tenantId, testKey, 'ok', 'Health check test');
    const testValue = await configService.get(tenantId, testKey);
    await configService.delete(tenantId, testKey);
    
    const isHealthy = testValue === 'ok';
    
    logger.info('Admin health check', {
      tenantId,
      healthy: isHealthy,
      ip: req.ip
    });
    
    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      services: {
        configService: isHealthy ? 'ok' : 'error'
      }
    });
    
  } catch (error) {
    logger.error('Admin health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Health check failed'
    });
  }
});

/**
 * GET /admin/configs
 * Listar todas as configurações do tenant
 */
router.get('/configs', async (req: Request, res: Response) => {
  try {
    const tenantId = getCurrentTenantId(req) || 'default';
    const { category, includeValues } = req.query;
    
    const configs = await configService.list(tenantId, category as string);
    
    // Mascarar valores sensíveis se não explicitamente solicitado
    const shouldIncludeValues = includeValues === 'true';
    const maskedConfigs = configs.map(config => ({
      ...config,
      value: shouldIncludeValues ? config.value : '[REDACTED]',
      encrypted: true // Indicar que o valor está criptografado
    }));
    
    logger.info('Admin configs listed', {
      tenantId,
      count: configs.length,
      category: category || 'all',
      includeValues: shouldIncludeValues,
      ip: req.ip
    });
    
    res.json({
      success: true,
      data: maskedConfigs,
      meta: {
        count: configs.length,
        tenant: tenantId,
        category: category || 'all'
      }
    });
    
  } catch (error) {
    logger.error('Error listing configs:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to list configurations'
    });
  }
});

/**
 * GET /admin/configs/:key
 * Obter uma configuração específica
 */
router.get('/configs/:key', async (req: Request, res: Response) => {
  try {
    const tenantId = getCurrentTenantId(req) || 'default';
    const { key } = req.params;
    const { decrypt } = req.query;
    
    if (!key) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Configuration key is required'
      });
    }
    
    const config = await configService.getWithMetadata(tenantId, key);
    
    if (!config) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Configuration not found'
      });
    }
    
    // Mascarar valor se não explicitamente solicitado para descriptografar
    const shouldDecrypt = decrypt === 'true';
    const responseConfig = {
      ...config,
      value: shouldDecrypt ? config.value : '[REDACTED]'
    };
    
    logger.info('Admin config retrieved', {
      tenantId,
      key,
      decrypt: shouldDecrypt,
      ip: req.ip
    });
    
    res.json({
      success: true,
      data: responseConfig
    });
    
  } catch (error) {
    logger.error('Error getting config:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to get configuration'
    });
  }
});

/**
 * POST /admin/configs
 * Criar uma nova configuração
 */
router.post('/configs', async (req: Request, res: Response) => {
  try {
    const tenantId = getCurrentTenantId(req) || 'default';
    const { key, value, description, category }: ConfigRequest = req.body;
    
    if (!key || !value) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Key and value are required'
      });
    }
    
    // Verificar se a configuração já existe
    const existing = await configService.get(tenantId, key);
    if (existing) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'Configuration already exists'
      });
    }
    
    await configService.set(tenantId, key, value, description, category);
    
    logger.info('Admin config created', {
      tenantId,
      key,
      category: category || 'default',
      hasDescription: !!description,
      ip: req.ip
    });
    
    res.status(201).json({
      success: true,
      message: 'Configuration created successfully',
      data: {
        key,
        tenant: tenantId,
        category: category || 'default',
        created: true
      }
    });
    
  } catch (error) {
    logger.error('Error creating config:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to create configuration'
    });
  }
});

/**
 * PUT /admin/configs/:key
 * Atualizar uma configuração existente
 */
router.put('/configs/:key', async (req: Request, res: Response) => {
  try {
    const tenantId = getCurrentTenantId(req) || 'default';
    const { key } = req.params;
    const { value, description }: ConfigUpdateRequest = req.body;
    
    if (!key || !value) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Key and value are required'
      });
    }
    
    // Verificar se a configuração existe
    const existing = await configService.get(tenantId, key);
    if (!existing) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Configuration not found'
      });
    }
    
    await configService.set(tenantId, key, value, description);
    
    logger.info('Admin config updated', {
      tenantId,
      key,
      hasDescription: !!description,
      ip: req.ip
    });
    
    res.json({
      success: true,
      message: 'Configuration updated successfully',
      data: {
        key,
        tenant: tenantId,
        updated: true
      }
    });
    
  } catch (error) {
    logger.error('Error updating config:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to update configuration'
    });
  }
});

/**
 * DELETE /admin/configs/:key
 * Deletar uma configuração
 */
router.delete('/configs/:key', async (req: Request, res: Response) => {
  try {
    const tenantId = getCurrentTenantId(req) || 'default';
    const { key } = req.params;
    
    if (!key) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Configuration key is required'
      });
    }
    
    // Verificar se a configuração existe
    const existing = await configService.get(tenantId, key);
    if (!existing) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Configuration not found'
      });
    }
    
    await configService.delete(tenantId, key);
    
    logger.info('Admin config deleted', {
      tenantId,
      key,
      ip: req.ip
    });
    
    res.json({
      success: true,
      message: 'Configuration deleted successfully',
      data: {
        key,
        tenant: tenantId,
        deleted: true
      }
    });
    
  } catch (error) {
    logger.error('Error deleting config:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to delete configuration'
    });
  }
});

/**
 * POST /admin/configs/:key/rotate
 * Rotacionar uma configuração (gerar novo valor)
 */
router.post('/configs/:key/rotate', async (req: Request, res: Response) => {
  try {
    const tenantId = getCurrentTenantId(req) || 'default';
    const { key } = req.params;
    const { description } = req.body;
    
    if (!key) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Configuration key is required'
      });
    }
    
    // Verificar se a configuração existe
    const existing = await configService.get(tenantId, key);
    if (!existing) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Configuration not found'
      });
    }
    
    const newValue = await configService.rotate(tenantId, key, description);
    
    logger.info('Admin config rotated', {
      tenantId,
      key,
      hasDescription: !!description,
      ip: req.ip
    });
    
    res.json({
      success: true,
      message: 'Configuration rotated successfully',
      data: {
        key,
        tenant: tenantId,
        rotated: true,
        newValue: newValue // Retornar o novo valor para o admin
      }
    });
    
  } catch (error) {
    logger.error('Error rotating config:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to rotate configuration'
    });
  }
});

/**
 * POST /admin/configs/validate
 * Validar configurações de integração
 */
router.post('/configs/validate', async (req: Request, res: Response) => {
  try {
    const tenantId = getCurrentTenantId(req) || 'default';
    const { service, configs } = req.body;
    
    if (!service || !configs) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Service and configs are required'
      });
    }
    
    const validationResults: any = {
      service,
      valid: false,
      errors: [],
      warnings: []
    };
    
    // Validação específica por serviço
    switch (service.toLowerCase()) {
      case 'evolution':
        validationResults.valid = await validateEvolutionConfig(configs);
        break;
        
      case 'trinks':
        validationResults.valid = await validateTrinksConfig(configs);
        break;
        
      case 'openai':
        validationResults.valid = await validateOpenAIConfig(configs);
        break;
        
      default:
        validationResults.errors.push(`Unknown service: ${service}`);
    }
    
    logger.info('Admin config validation', {
      tenantId,
      service,
      valid: validationResults.valid,
      errorCount: validationResults.errors.length,
      ip: req.ip
    });
    
    res.json({
      success: true,
      data: validationResults
    });
    
  } catch (error) {
    logger.error('Error validating configs:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to validate configurations'
    });
  }
});

/**
 * GET /admin/tenants
 * Listar tenants disponíveis (apenas para super admin)
 */
router.get('/tenants', async (req: Request, res: Response) => {
  try {
    // Esta funcionalidade seria implementada com uma query no banco
    // Por enquanto, retornar informação básica
    
    const tenantId = getCurrentTenantId(req) || 'default';
    
    logger.info('Admin tenants listed', {
      requestedBy: tenantId,
      ip: req.ip
    });
    
    res.json({
      success: true,
      data: [
        {
          id: 'default',
          name: 'Default Tenant',
          active: true,
          created_at: new Date().toISOString()
        }
      ],
      meta: {
        count: 1,
        requestedBy: tenantId
      }
    });
    
  } catch (error) {
    logger.error('Error listing tenants:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to list tenants'
    });
  }
});

/**
 * Funções auxiliares de validação
 */
async function validateEvolutionConfig(configs: any): Promise<boolean> {
  // Implementar validação específica do Evolution API
  const required = ['api_url', 'api_key', 'instance_name'];
  return required.every(key => configs[key]);
}

async function validateTrinksConfig(configs: any): Promise<boolean> {
  // Implementar validação específica do Trinks
  const required = ['api_url', 'api_key', 'company_id'];
  return required.every(key => configs[key]);
}

async function validateOpenAIConfig(configs: any): Promise<boolean> {
  // Implementar validação específica do OpenAI
  const required = ['api_key'];
  return required.every(key => configs[key]);
}

export default router;