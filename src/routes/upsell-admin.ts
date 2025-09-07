import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { UpsellService } from '../services/upsell-service';
import { UpsellScheduler } from '../services/upsell-scheduler';
import { adminAuth } from '../middleware/admin-auth';
import { piiMaskingMiddleware } from '../middleware/pii-masking';

/**
 * Rotas administrativas para o módulo de upsell
 * 
 * Fornece endpoints para monitoramento, configuração e análise
 * de performance do sistema de upsells.
 */

export function createUpsellAdminRoutes(
  upsellService: UpsellService,
  scheduler: UpsellScheduler
): Router {
  const router = Router();

  // Aplicar autenticação admin em todas as rotas
  router.use(adminAuth());
  
  // Aplicar mascaramento de PII nos logs
  router.use(piiMaskingMiddleware());

  /**
   * GET /admin/upsell/metrics
   * Retorna métricas gerais de performance
   */
  router.get('/metrics', async (req: Request, res: Response) => {
    try {
      const { period = '7d', variant } = req.query;
      
      const metrics = await upsellService.getMetrics({
        period: period as string,
        variant: variant as string
      });

      res.json({
        success: true,
        data: metrics,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Erro ao obter métricas de upsell:', error);
      res.status(500).json({
        success: false,
        error: 'Erro interno do servidor'
      });
    }
  });

  /**
   * GET /admin/upsell/metrics/conversion
   * Retorna métricas detalhadas de conversão
   */
  router.get('/metrics/conversion', async (req: Request, res: Response) => {
    try {
      const { 
        period = '7d', 
        groupBy = 'day',
        variant,
        serviceId 
      } = req.query;

      const conversionMetrics = await upsellService.getConversionMetrics({
        period: period as string,
        groupBy: groupBy as 'hour' | 'day' | 'week',
        variant: variant as string,
        serviceId: serviceId as string
      });

      res.json({
        success: true,
        data: conversionMetrics,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Erro ao obter métricas de conversão:', error);
      res.status(500).json({
        success: false,
        error: 'Erro interno do servidor'
      });
    }
  });

  /**
   * GET /admin/upsell/metrics/ab-test
   * Retorna resultados do teste A/B
   */
  router.get('/metrics/ab-test', async (req: Request, res: Response) => {
    try {
      const { period = '7d' } = req.query;
      
      const abTestResults = await upsellService.getABTestResults(period as string);

      res.json({
        success: true,
        data: abTestResults,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Erro ao obter resultados do teste A/B:', error);
      res.status(500).json({
        success: false,
        error: 'Erro interno do servidor'
      });
    }
  });

  /**
   * GET /admin/upsell/events
   * Lista eventos de upsell com filtros
   */
  router.get('/events', async (req: Request, res: Response) => {
    try {
      const {
        page = 1,
        limit = 50,
        event,
        variant,
        dateFrom,
        dateTo,
        conversationId
      } = req.query;

      const events = await upsellService.getEvents({
        page: parseInt(page as string),
        limit: Math.min(parseInt(limit as string), 100),
        event: event as string,
        variant: variant as string,
        dateFrom: dateFrom ? new Date(dateFrom as string) : undefined,
        dateTo: dateTo ? new Date(dateTo as string) : undefined,
        conversationId: conversationId as string
      });

      res.json({
        success: true,
        data: events,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Erro ao obter eventos de upsell:', error);
      res.status(500).json({
        success: false,
        error: 'Erro interno do servidor'
      });
    }
  });

  /**
   * GET /admin/upsell/scheduler/status
   * Retorna status do scheduler
   */
  router.get('/scheduler/status', async (req: Request, res: Response) => {
    try {
      const stats = scheduler.getStats();
      
      res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Erro ao obter status do scheduler:', error);
      res.status(500).json({
        success: false,
        error: 'Erro interno do servidor'
      });
    }
  });

  /**
   * POST /admin/upsell/scheduler/cancel/:jobId
   * Cancela um job agendado
   */
  router.post('/scheduler/cancel/:jobId', async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;
      
      if (!jobId) {
        return res.status(400).json({
          success: false,
          error: 'Job ID é obrigatório'
        });
      }

      const cancelled = await scheduler.cancelScheduledUpsell(jobId);
      
      if (!cancelled) {
        return res.status(404).json({
          success: false,
          error: 'Job não encontrado ou não pode ser cancelado'
        });
      }

      res.json({
        success: true,
        message: 'Job cancelado com sucesso',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Erro ao cancelar job agendado:', error);
      res.status(500).json({
        success: false,
        error: 'Erro interno do servidor'
      });
    }
  });

  /**
   * GET /admin/upsell/config
   * Retorna configuração atual do módulo
   */
  router.get('/config', async (req: Request, res: Response) => {
    try {
      const config = upsellService.getConfig();
      
      // Remover informações sensíveis
      const safeConfig = {
        ...config,
        security: {
          ...config.security,
          auth: config.security.auth ? '***masked***' : undefined
        }
      };

      res.json({
        success: true,
        data: safeConfig,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Erro ao obter configuração:', error);
      res.status(500).json({
        success: false,
        error: 'Erro interno do servidor'
      });
    }
  });

  /**
   * PUT /admin/upsell/config
   * Atualiza configuração do módulo
   */
  router.put('/config', async (req: Request, res: Response) => {
    try {
      const { config } = req.body;
      
      if (!config) {
        return res.status(400).json({
          success: false,
          error: 'Configuração é obrigatória'
        });
      }

      await upsellService.updateConfig(config);
      
      res.json({
        success: true,
        message: 'Configuração atualizada com sucesso',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Erro ao atualizar configuração:', error);
      res.status(500).json({
        success: false,
        error: 'Erro interno do servidor'
      });
    }
  });

  /**
   * POST /admin/upsell/test
   * Executa teste manual de upsell
   */
  router.post('/test', async (req: Request, res: Response) => {
    try {
      const {
        conversationId,
        phone,
        appointmentId,
        primaryServiceId,
        customerName,
        variant
      } = req.body;

      if (!conversationId || !phone || !appointmentId || !primaryServiceId) {
        return res.status(400).json({
          success: false,
          error: 'Dados obrigatórios: conversationId, phone, appointmentId, primaryServiceId'
        });
      }

      const context = {
        conversationId,
        phone,
        appointmentId,
        primaryServiceId,
        customerName
      };

      const result = await upsellService.processBookingConfirmation(context, variant);
      
      res.json({
        success: true,
        data: result,
        message: 'Teste de upsell executado com sucesso',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Erro ao executar teste de upsell:', error);
      res.status(500).json({
        success: false,
        error: 'Erro interno do servidor'
      });
    }
  });

  /**
   * GET /admin/upsell/revenue
   * Retorna métricas de receita gerada
   */
  router.get('/revenue', async (req: Request, res: Response) => {
    try {
      const { 
        period = '30d',
        groupBy = 'day',
        variant 
      } = req.query;

      const revenueMetrics = await upsellService.getRevenueMetrics({
        period: period as string,
        groupBy: groupBy as 'day' | 'week' | 'month',
        variant: variant as string
      });

      res.json({
        success: true,
        data: revenueMetrics,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Erro ao obter métricas de receita:', error);
      res.status(500).json({
        success: false,
        error: 'Erro interno do servidor'
      });
    }
  });

  /**
   * GET /admin/upsell/performance
   * Retorna análise de performance por serviço
   */
  router.get('/performance', async (req: Request, res: Response) => {
    try {
      const { period = '30d' } = req.query;
      
      const performance = await upsellService.getPerformanceByService(period as string);

      res.json({
        success: true,
        data: performance,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Erro ao obter análise de performance:', error);
      res.status(500).json({
        success: false,
        error: 'Erro interno do servidor'
      });
    }
  });

  /**
   * POST /admin/upsell/export
   * Exporta dados para análise
   */
  router.post('/export', async (req: Request, res: Response) => {
    try {
      const {
        type = 'events',
        format = 'csv',
        period = '30d',
        filters = {}
      } = req.body;

      const exportData = await upsellService.exportData({
        type: type as 'events' | 'metrics' | 'revenue',
        format: format as 'csv' | 'json',
        period: period as string,
        filters
      });

      // Configurar headers para download
      const filename = `upsell_${type}_${new Date().toISOString().split('T')[0]}.${format}`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
      } else {
        res.setHeader('Content-Type', 'application/json');
      }

      res.send(exportData);

    } catch (error) {
      logger.error('Erro ao exportar dados:', error);
      res.status(500).json({
        success: false,
        error: 'Erro interno do servidor'
      });
    }
  });

  /**
   * GET /admin/upsell/health
   * Health check do módulo de upsell
   */
  router.get('/health', async (req: Request, res: Response) => {
    try {
      const health = await upsellService.getHealthStatus();
      const schedulerStats = scheduler.getStats();
      
      const overallHealth = {
        status: health.status === 'healthy' && schedulerStats.isRunning ? 'healthy' : 'unhealthy',
        service: health,
        scheduler: schedulerStats,
        timestamp: new Date().toISOString()
      };

      const statusCode = overallHealth.status === 'healthy' ? 200 : 503;
      res.status(statusCode).json({
        success: overallHealth.status === 'healthy',
        data: overallHealth
      });

    } catch (error) {
      logger.error('Erro ao verificar saúde do módulo:', error);
      res.status(503).json({
        success: false,
        error: 'Erro interno do servidor',
        status: 'unhealthy'
      });
    }
  });

  return router;
}

export default createUpsellAdminRoutes;