import { Router, Request, Response } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { getHumanHandoffService } from '../../services/human-handoff';
import { redis, db } from '../../config/database';
import { logger } from '../../utils/logger';
import { authenticateAdmin } from '../../middleware/auth';

const router = Router();
const handoffService = getHumanHandoffService(redis, db);

/**
 * @route POST /admin/handoff/enable
 * @desc Ativa handoff humano para um telefone específico
 * @access Admin
 */
router.post('/enable',
  authenticateAdmin,
  [
    body('phone')
      .notEmpty()
      .withMessage('Telefone é obrigatório')
      .matches(/^\+?[1-9]\d{1,14}$/)
      .withMessage('Formato de telefone inválido'),
    body('reason')
      .optional()
      .isLength({ max: 500 })
      .withMessage('Motivo deve ter no máximo 500 caracteres'),
    body('ttlHours')
      .optional()
      .isInt({ min: 1, max: 168 })
      .withMessage('TTL deve ser entre 1 e 168 horas')
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Dados inválidos',
          errors: errors.array()
        });
      }

      const { phone, reason = 'Ativado via painel admin', ttlHours } = req.body;
      const enabledBy = req.user?.id || 'admin';

      const success = await handoffService.enableHandoff(
        phone,
        enabledBy,
        reason,
        ttlHours
      );

      if (success) {
        const status = await handoffService.getHandoffStatus(phone);
        
        res.json({
          success: true,
          message: 'Handoff ativado com sucesso',
          data: status
        });
        
        logger.info(`Handoff enabled for ${phone} by ${enabledBy}`);
      } else {
        res.status(500).json({
          success: false,
          message: 'Erro ao ativar handoff'
        });
      }
    } catch (error) {
      logger.error('Error enabling handoff:', error);
      res.status(500).json({
        success: false,
        message: 'Erro interno do servidor'
      });
    }
  }
);

/**
 * @route POST /admin/handoff/disable
 * @desc Desativa handoff humano para um telefone específico
 * @access Admin
 */
router.post('/disable',
  authenticateAdmin,
  [
    body('phone')
      .notEmpty()
      .withMessage('Telefone é obrigatório')
      .matches(/^\+?[1-9]\d{1,14}$/)
      .withMessage('Formato de telefone inválido')
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Dados inválidos',
          errors: errors.array()
        });
      }

      const { phone } = req.body;
      const disabledBy = req.user?.id || 'admin';

      const success = await handoffService.disableHandoff(phone, disabledBy);

      if (success) {
        res.json({
          success: true,
          message: 'Handoff desativado com sucesso'
        });
        
        logger.info(`Handoff disabled for ${phone} by ${disabledBy}`);
      } else {
        res.status(500).json({
          success: false,
          message: 'Erro ao desativar handoff'
        });
      }
    } catch (error) {
      logger.error('Error disabling handoff:', error);
      res.status(500).json({
        success: false,
        message: 'Erro interno do servidor'
      });
    }
  }
);

/**
 * @route GET /admin/handoff/status/:phone
 * @desc Obtém status do handoff para um telefone
 * @access Admin
 */
router.get('/status/:phone',
  authenticateAdmin,
  [
    param('phone')
      .matches(/^\+?[1-9]\d{1,14}$/)
      .withMessage('Formato de telefone inválido')
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Dados inválidos',
          errors: errors.array()
        });
      }

      const { phone } = req.params;
      
      const status = await handoffService.getHandoffStatus(phone);
      const isActive = await handoffService.isHandoffActive(phone);
      const isGlobalActive = await handoffService.isGlobalHandoffActive();

      res.json({
        success: true,
        data: {
          phone,
          status,
          isActive,
          isGlobalActive
        }
      });
    } catch (error) {
      logger.error('Error getting handoff status:', error);
      res.status(500).json({
        success: false,
        message: 'Erro interno do servidor'
      });
    }
  }
);

/**
 * @route GET /admin/handoff/list
 * @desc Lista todos os handoffs ativos
 * @access Admin
 */
router.get('/list',
  authenticateAdmin,
  [
    query('page')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Página deve ser um número positivo'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limite deve ser entre 1 e 100')
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Dados inválidos',
          errors: errors.array()
        });
      }

      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      
      const allHandoffs = await handoffService.listActiveHandoffs();
      const isGlobalActive = await handoffService.isGlobalHandoffActive();
      
      // Paginação simples
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + limit;
      const paginatedHandoffs = allHandoffs.slice(startIndex, endIndex);
      
      res.json({
        success: true,
        data: {
          handoffs: paginatedHandoffs,
          pagination: {
            page,
            limit,
            total: allHandoffs.length,
            totalPages: Math.ceil(allHandoffs.length / limit)
          },
          globalHandoff: {
            isActive: isGlobalActive
          }
        }
      });
    } catch (error) {
      logger.error('Error listing handoffs:', error);
      res.status(500).json({
        success: false,
        message: 'Erro interno do servidor'
      });
    }
  }
);

/**
 * @route POST /admin/handoff/global/enable
 * @desc Ativa handoff global (todos os telefones)
 * @access Admin
 */
router.post('/global/enable',
  authenticateAdmin,
  [
    body('ttlHours')
      .optional()
      .isInt({ min: 1, max: 24 })
      .withMessage('TTL deve ser entre 1 e 24 horas para handoff global')
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Dados inválidos',
          errors: errors.array()
        });
      }

      const { ttlHours = 1 } = req.body;
      const enabledBy = req.user?.id || 'admin';

      const success = await handoffService.enableGlobalHandoff(enabledBy, ttlHours);

      if (success) {
        res.json({
          success: true,
          message: `Handoff global ativado por ${ttlHours} hora(s)`,
          data: {
            ttlHours,
            enabledBy,
            enabledAt: new Date()
          }
        });
        
        logger.warn(`Global handoff enabled by ${enabledBy} for ${ttlHours}h`);
      } else {
        res.status(500).json({
          success: false,
          message: 'Erro ao ativar handoff global'
        });
      }
    } catch (error) {
      logger.error('Error enabling global handoff:', error);
      res.status(500).json({
        success: false,
        message: 'Erro interno do servidor'
      });
    }
  }
);

/**
 * @route POST /admin/handoff/global/disable
 * @desc Desativa handoff global
 * @access Admin
 */
router.post('/global/disable',
  authenticateAdmin,
  async (req: Request, res: Response) => {
    try {
      const disabledBy = req.user?.id || 'admin';

      const success = await handoffService.disableGlobalHandoff(disabledBy);

      if (success) {
        res.json({
          success: true,
          message: 'Handoff global desativado com sucesso'
        });
        
        logger.info(`Global handoff disabled by ${disabledBy}`);
      } else {
        res.status(500).json({
          success: false,
          message: 'Erro ao desativar handoff global'
        });
      }
    } catch (error) {
      logger.error('Error disabling global handoff:', error);
      res.status(500).json({
        success: false,
        message: 'Erro interno do servidor'
      });
    }
  }
);

/**
 * @route POST /admin/handoff/cleanup
 * @desc Limpa handoffs expirados
 * @access Admin
 */
router.post('/cleanup',
  authenticateAdmin,
  async (req: Request, res: Response) => {
    try {
      const cleanedCount = await handoffService.cleanupExpiredHandoffs();

      res.json({
        success: true,
        message: `${cleanedCount} handoffs expirados foram removidos`,
        data: {
          cleanedCount
        }
      });
      
      logger.info(`Cleaned up ${cleanedCount} expired handoffs via admin`);
    } catch (error) {
      logger.error('Error cleaning up handoffs:', error);
      res.status(500).json({
        success: false,
        message: 'Erro interno do servidor'
      });
    }
  }
);

/**
 * @route GET /admin/handoff/stats
 * @desc Obtém estatísticas dos handoffs
 * @access Admin
 */
router.get('/stats',
  authenticateAdmin,
  async (req: Request, res: Response) => {
    try {
      const activeHandoffs = await handoffService.listActiveHandoffs();
      const isGlobalActive = await handoffService.isGlobalHandoffActive();
      
      // Estatísticas básicas
      const stats = {
        totalActive: activeHandoffs.length,
        globalActive: isGlobalActive,
        byReason: {} as Record<string, number>,
        byEnabledBy: {} as Record<string, number>,
        expiringIn1Hour: 0,
        expiringIn24Hours: 0
      };
      
      const now = new Date();
      const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
      const twentyFourHoursFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      
      activeHandoffs.forEach(handoff => {
        // Por motivo
        const reason = handoff.reason || 'Não especificado';
        stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;
        
        // Por quem ativou
        const enabledBy = handoff.enabledBy || 'Desconhecido';
        stats.byEnabledBy[enabledBy] = (stats.byEnabledBy[enabledBy] || 0) + 1;
        
        // Expirando em breve
        if (handoff.expiresAt) {
          const expiresAt = new Date(handoff.expiresAt);
          if (expiresAt <= oneHourFromNow) {
            stats.expiringIn1Hour++;
          } else if (expiresAt <= twentyFourHoursFromNow) {
            stats.expiringIn24Hours++;
          }
        }
      });

      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('Error getting handoff stats:', error);
      res.status(500).json({
        success: false,
        message: 'Erro interno do servidor'
      });
    }
  }
);

export default router;