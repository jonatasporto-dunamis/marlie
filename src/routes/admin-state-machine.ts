import { Router, Request, Response } from 'express';
import { getStateMachineIntegration } from '../core/state-machine-integration';
import { logger } from '../utils/logger';
import { authenticateAdmin } from '../middleware/auth';

const router = Router();

/**
 * Interface para requisições de handoff
 */
interface HandoffRequest {
  phone: string;
  enabled: boolean;
  reason?: string;
}

/**
 * Interface para resposta de status
 */
interface StatusResponse {
  success: boolean;
  message: string;
  data?: any;
}

/**
 * POST /admin/handoff/:phone
 * Ativa/desativa handoff humano para um usuário específico
 */
router.post('/handoff/:phone', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const { phone } = req.params;
    const { enabled, reason }: { enabled: boolean; reason?: string } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'Campo "enabled" deve ser um boolean'
      } as StatusResponse);
    }

    const integration = getStateMachineIntegration();
    await integration.setHumanHandoff(phone, enabled);

    logger.info(`Admin ${req.user?.id} ${enabled ? 'enabled' : 'disabled'} handoff for ${phone}`, {
      reason,
      adminId: req.user?.id
    });

    res.json({
      success: true,
      message: `Handoff ${enabled ? 'ativado' : 'desativado'} para ${phone}`,
      data: {
        phone,
        enabled,
        reason,
        timestamp: new Date().toISOString()
      }
    } as StatusResponse);
  } catch (error) {
    logger.error('Error setting handoff:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    } as StatusResponse);
  }
});

/**
 * GET /admin/conversation/:phone
 * Obtém o estado atual de uma conversa
 */
router.get('/conversation/:phone', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const { phone } = req.params;
    const integration = getStateMachineIntegration();
    const state = await integration.getConversationState(phone);

    res.json({
      success: true,
      message: 'Estado da conversa obtido com sucesso',
      data: state
    } as StatusResponse);
  } catch (error) {
    logger.error('Error getting conversation state:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao obter estado da conversa'
    } as StatusResponse);
  }
});

/**
 * DELETE /admin/conversation/:phone
 * Reseta uma conversa
 */
router.delete('/conversation/:phone', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const { phone } = req.params;
    const integration = getStateMachineIntegration();
    await integration.resetConversation(phone);

    logger.info(`Admin ${req.user?.id} reset conversation for ${phone}`);

    res.json({
      success: true,
      message: `Conversa resetada para ${phone}`
    } as StatusResponse);
  } catch (error) {
    logger.error('Error resetting conversation:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao resetar conversa'
    } as StatusResponse);
  }
});

/**
 * GET /admin/metrics
 * Obtém métricas da máquina de estados
 */
router.get('/metrics', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const integration = getStateMachineIntegration();
    const metrics = await integration.getMetrics();

    res.json({
      success: true,
      message: 'Métricas obtidas com sucesso',
      data: metrics
    } as StatusResponse);
  } catch (error) {
    logger.error('Error getting metrics:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao obter métricas'
    } as StatusResponse);
  }
});

/**
 * POST /admin/cleanup
 * Executa limpeza de dados expirados
 */
router.post('/cleanup', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const integration = getStateMachineIntegration();
    await integration.cleanup();

    logger.info(`Admin ${req.user?.id} executed cleanup`);

    res.json({
      success: true,
      message: 'Limpeza executada com sucesso'
    } as StatusResponse);
  } catch (error) {
    logger.error('Error during cleanup:', error);
    res.status(500).json({
      success: false,
      message: 'Erro durante limpeza'
    } as StatusResponse);
  }
});

/**
 * GET /admin/config
 * Obtém configuração atual da máquina de estados
 */
router.get('/config', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const integration = getStateMachineIntegration();
    
    // Obtém configuração sem dados sensíveis
    const config = {
      enableStateMachine: process.env.ENABLE_STATE_MACHINE === 'true',
      fallbackToLegacy: process.env.FALLBACK_TO_LEGACY !== 'false',
      debugMode: process.env.DEBUG_STATE_MACHINE === 'true',
      redisPrefix: process.env.REDIS_PREFIX || 'marlie'
    };

    res.json({
      success: true,
      message: 'Configuração obtida com sucesso',
      data: config
    } as StatusResponse);
  } catch (error) {
    logger.error('Error getting config:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao obter configuração'
    } as StatusResponse);
  }
});

/**
 * POST /admin/test-message
 * Testa o processamento de uma mensagem
 */
router.post('/test-message', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const { phone, message, metadata } = req.body;

    if (!phone || !message) {
      return res.status(400).json({
        success: false,
        message: 'Campos "phone" e "message" são obrigatórios'
      } as StatusResponse);
    }

    const integration = getStateMachineIntegration();
    const response = await integration.processMessage(phone, message, metadata);

    logger.info(`Admin ${req.user?.id} tested message for ${phone}`);

    res.json({
      success: true,
      message: 'Mensagem processada com sucesso',
      data: response
    } as StatusResponse);
  } catch (error) {
    logger.error('Error testing message:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao processar mensagem de teste'
    } as StatusResponse);
  }
});

/**
 * GET /admin/health
 * Verifica saúde da máquina de estados
 */
router.get('/health', async (req: Request, res: Response) => {
  try {
    const integration = getStateMachineIntegration();
    const metrics = await integration.getMetrics();
    
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      metrics,
      version: process.env.npm_package_version || '1.0.0'
    };

    res.json({
      success: true,
      message: 'Sistema saudável',
      data: health
    } as StatusResponse);
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(503).json({
      success: false,
      message: 'Sistema com problemas',
      data: {
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString()
      }
    } as StatusResponse);
  }
});

export default router;