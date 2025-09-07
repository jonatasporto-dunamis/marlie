import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { logger } from '../utils/logger';
import { CatalogSyncService } from '../services/catalog-sync';
import { CatalogTrinksService } from '../services/catalog-trinks-service';
import { getCatalogDisambiguationService } from '../services/catalog-disambiguation-service';
import { getDisambiguationMiddleware } from '../middleware/catalog-disambiguation-middleware';
import { authenticateAdmin } from '../middleware/auth';

/**
 * Interface para request de sincronização completa
 */
interface TriggerFullSyncRequest {
  updated_since_iso?: string;
}

/**
 * Interface para request de relatório de diferenças
 */
interface DailyDiffRequest {
  as_of_date: string;
}

/**
 * Rotas administrativas para o módulo de catálogo
 */
const router = Router();
const catalogSync = new CatalogSyncService();

/**
 * POST /admin/sync/servicos
 * Trigger sincronização completa do catálogo
 */
router.post('/sync/servicos', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const { updated_since_iso }: TriggerFullSyncRequest = req.body;
    
    logger.info('Admin triggered full catalog sync', {
      updated_since_iso,
      admin_user: req.user?.id
    });

    // Determina ponto de partida
    const startTime = updated_since_iso || 
      process.env.CATALOG_WATERMARK || 
      '1970-01-01T00:00:00Z';

    // Executa sincronização
    const result = await catalogSync.triggerFullSync(startTime);

    logger.info('Full catalog sync completed', {
      watermark: result.watermark,
      admin_user: req.user?.id
    });

    res.json({
      ok: true,
      watermark: result.watermark,
      started_from: startTime,
      completed_at: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error in full catalog sync:', error);
    
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * POST /admin/sync/diff
 * Gera relatório de diferenças diárias
 */
router.post('/sync/diff', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const { as_of_date }: DailyDiffRequest = req.body;
    
    if (!as_of_date) {
      return res.status(400).json({
        ok: false,
        error: 'as_of_date is required (format: YYYY-MM-DD)',
        timestamp: new Date().toISOString()
      });
    }

    // Valida formato da data
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(as_of_date)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid date format. Use YYYY-MM-DD',
        timestamp: new Date().toISOString()
      });
    }

    logger.info('Admin requested daily diff report', {
      as_of_date,
      admin_user: req.user?.id
    });

    // Gera relatório
    const diffReport = await catalogSync.computeDailyDiffReport(as_of_date);

    logger.info('Daily diff report generated', {
      as_of_date,
      total_trinks: diffReport.total_trinks,
      total_local: diffReport.total_local,
      missing_in_local: diffReport.missing_in_local,
      extra_in_local: diffReport.extra_in_local,
      duplicates: diffReport.duplicates,
      admin_user: req.user?.id
    });

    res.json(diffReport);
  } catch (error) {
    logger.error('Error generating daily diff report:', error);
    
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /admin/sync/status
 * Obtém status da sincronização
 */
router.get('/sync/status', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const watermark = await catalogSync.getWatermark();
    
    res.json({
      ok: true,
      watermark,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting sync status:', error);
    
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /admin/catalog/stats
 * Obtém estatísticas do catálogo
 */
router.get('/catalog/stats', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    // Busca estatísticas locais
    const localStatsQuery = `
      SELECT 
        COUNT(*) as total_services,
        COUNT(DISTINCT profissionalid) as total_professionals,
        COUNT(CASE WHEN ativo = true THEN 1 END) as active_services,
        COUNT(DISTINCT categoria_normalizada) as categories,
        MAX(updated_at) as last_updated,
        MAX(sync_timestamp) as last_sync
      FROM servicos_prof
    `;
    
    const localStats = await catalogSync['db'].query(localStatsQuery);
    const stats = localStats.rows[0];

    // Busca watermark
    const watermark = await catalogSync.getWatermark();

    res.json({
      ok: true,
      local_stats: {
        total_services: parseInt(stats.total_services),
        total_professionals: parseInt(stats.total_professionals),
        active_services: parseInt(stats.active_services),
        categories: parseInt(stats.categories),
        last_updated: stats.last_updated,
        last_sync: stats.last_sync
      },
      sync_info: watermark,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting catalog stats:', error);
    
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /admin/catalog/search
 * Busca serviços no catálogo local
 */
router.get('/catalog/search', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const { term, category, limit = '10' } = req.query;
    
    if (!term && !category) {
      return res.status(400).json({
        ok: false,
        error: 'Either term or category parameter is required',
        timestamp: new Date().toISOString()
      });
    }

    const limitNum = parseInt(limit as string) || 10;
    
    let results: any[] = [];
    
    if (term) {
      // Busca por termo
      const termNorm = term.toString().toLowerCase().trim();
      results = await catalogSync.searchLike(termNorm, limitNum);
    } else if (category) {
      // Busca por categoria
      const categoryNorm = category.toString().toLowerCase().trim();
      results = await catalogSync.getTopNByCategory30d(categoryNorm, limitNum);
    }

    res.json({
      ok: true,
      results,
      query: { term, category, limit: limitNum },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error searching catalog:', error);
    
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /admin/catalog/health
 * Verifica saúde do módulo de catálogo
 */
router.get('/catalog/health', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const checks = {
      database: false,
      redis: false,
      trinks_api: false,
      sync_status: 'unknown'
    };

    // Verifica banco de dados
    try {
      await catalogSync['db'].query('SELECT 1');
      checks.database = true;
    } catch (error) {
      logger.warn('Database health check failed:', error);
    }

    // Verifica Redis
    try {
      await catalogSync['redis'].ping();
      checks.redis = true;
    } catch (error) {
      logger.warn('Redis health check failed:', error);
    }

    // Verifica API Trinks
    try {
      await catalogSync['trinksService'].healthCheck();
      checks.trinks_api = true;
    } catch (error) {
      logger.warn('Trinks API health check failed:', error);
    }

    // Verifica status da sincronização
    try {
      const watermark = await catalogSync.getWatermark();
      if (watermark) {
        const lastSync = new Date(watermark.sync_timestamp);
        const hoursSinceSync = (Date.now() - lastSync.getTime()) / (1000 * 60 * 60);
        
        if (hoursSinceSync < 2) {
          checks.sync_status = 'healthy';
        } else if (hoursSinceSync < 24) {
          checks.sync_status = 'warning';
        } else {
          checks.sync_status = 'critical';
        }
      }
    } catch (error) {
      logger.warn('Sync status check failed:', error);
    }

    const isHealthy = checks.database && checks.redis && checks.trinks_api;
    
    res.status(isHealthy ? 200 : 503).json({
      ok: isHealthy,
      checks,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error in catalog health check:', error);
    
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

// =============================================================================
// ENDPOINTS DE DESAMBIGUAÇÃO
// =============================================================================

/**
 * GET /admin/disambiguation/stats
 * Obtém estatísticas do serviço de desambiguação
 */
router.get('/disambiguation/stats', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const disambiguationService = getCatalogDisambiguationService();
    const middleware = getDisambiguationMiddleware();
    
    const [serviceStats, middlewareStats] = await Promise.all([
      disambiguationService.getStats(),
      middleware.getStats()
    ]);
    
    res.json({
      status: 'success',
      data: {
        service: serviceStats,
        middleware: middlewareStats,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    logger.error('Erro ao obter estatísticas de desambiguação', { error });
    res.status(500).json({
      status: 'error',
      message: 'Erro ao obter estatísticas',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /admin/disambiguation/test
 * Testa processo de desambiguação com entrada específica
 */
router.post('/disambiguation/test', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const { input, context } = req.body;
    
    if (!input) {
      return res.status(400).json({
        status: 'error',
        message: 'Campo "input" é obrigatório'
      });
    }
    
    const disambiguationService = getCatalogDisambiguationService();
    
    // Testar se entrada é ambígua
    const isAmbiguous = disambiguationService.isAmbiguous(input);
    
    // Testar normalização
    const normalized = disambiguationService.normalizeServiceName(input);
    
    // Testar busca
    let searchResults = [];
    if (isAmbiguous) {
      searchResults = await disambiguationService.getTopServicesByCategory(normalized, 3);
    } else {
      searchResults = await disambiguationService.searchServicesByText(normalized, 3);
    }
    
    // Simular processo completo
    const result = await disambiguationService.startDisambiguation(input, context || {});
    
    res.json({
      status: 'success',
      data: {
        input: {
          original: input,
          normalized,
          is_ambiguous: isAmbiguous
        },
        search_results: searchResults,
        disambiguation_result: result,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    logger.error('Erro no teste de desambiguação', { error, input: req.body.input });
    res.status(500).json({
      status: 'error',
      message: 'Erro no teste de desambiguação',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * DELETE /admin/disambiguation/cache
 * Limpa cache de desambiguação
 */
router.delete('/disambiguation/cache', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const { pattern } = req.query;
    
    const disambiguationService = getCatalogDisambiguationService();
    await disambiguationService.clearCache(pattern as string);
    
    logger.info('Cache de desambiguação limpo', {
      pattern,
      admin_user: (req as any).user?.id
    });
    
    res.json({
      status: 'success',
      message: 'Cache limpo com sucesso',
      pattern: pattern || 'all',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('Erro ao limpar cache de desambiguação', { error });
    res.status(500).json({
      status: 'error',
      message: 'Erro ao limpar cache',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * DELETE /admin/disambiguation/sessions
 * Limpa todas as sessões ativas de desambiguação
 */
router.delete('/disambiguation/sessions', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const middleware = getDisambiguationMiddleware();
    const clearedCount = await middleware.clearAllSessions();
    
    logger.info('Sessões de desambiguação limpas', {
      sessions_cleared: clearedCount,
      admin_user: (req as any).user?.id
    });
    
    res.json({
      status: 'success',
      message: 'Sessões limpas com sucesso',
      sessions_cleared: clearedCount,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('Erro ao limpar sessões de desambiguação', { error });
    res.status(500).json({
      status: 'error',
      message: 'Erro ao limpar sessões',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /admin/disambiguation/popular-categories
 * Obtém categorias mais populares para análise
 */
router.get('/disambiguation/popular-categories', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const { days = '30', limit = '10' } = req.query;
    
    const db = (req as any).app.locals.db as Pool;
    
    const query = `
      SELECT 
        sp.categoria,
        sp.categoria_normalizada,
        COUNT(DISTINCT sp.servicoid) as total_services,
        COUNT(a.id) as total_bookings,
        AVG(sp.preco) as avg_price,
        AVG(sp.duracao) as avg_duration
      FROM servicos_prof sp
      LEFT JOIN agendamentos a ON sp.servicoid = a.servicoid
        AND a.created_at >= NOW() - INTERVAL '${days} days'
        AND a.status IN ('confirmed', 'completed')
      WHERE sp.ativo = true
      GROUP BY sp.categoria, sp.categoria_normalizada
      ORDER BY COUNT(a.id) DESC, COUNT(DISTINCT sp.servicoid) DESC
      LIMIT $1
    `;
    
    const result = await db.query(query, [limit]);
    
    res.json({
      status: 'success',
      data: {
        categories: result.rows,
        period_days: parseInt(days as string),
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    logger.error('Erro ao obter categorias populares', { error });
    res.status(500).json({
      status: 'error',
      message: 'Erro ao obter categorias populares',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /admin/disambiguation/ambiguous-patterns
 * Lista padrões ambíguos configurados e suas estatísticas
 */
router.get('/disambiguation/ambiguous-patterns', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const disambiguationService = getCatalogDisambiguationService();
    
    // Carregar configuração (seria melhor expor via método público)
    const fs = require('fs');
    const yaml = require('js-yaml');
    const path = require('path');
    
    const configPath = path.join(__dirname, '../config/catalog-disambiguation.yaml');
    const configFile = fs.readFileSync(configPath, 'utf8');
    const config = yaml.load(configFile);
    
    const patterns = config.nlp.patterns.category_ambiguous;
    
    // Para cada padrão, buscar estatísticas de uso
    const db = (req as any).app.locals.db as Pool;
    const patternStats = [];
    
    for (const pattern of patterns) {
      try {
        // Simular busca para obter estatísticas
        const regex = new RegExp(pattern, 'i');
        const sampleTerms = ['cabelo', 'unha', 'sobrancelha', 'maquiagem', 'escova'];
        const matchingTerms = sampleTerms.filter(term => regex.test(term));
        
        patternStats.push({
          pattern,
          matching_sample_terms: matchingTerms,
          is_active: true
        });
      } catch (error) {
        patternStats.push({
          pattern,
          error: 'Padrão regex inválido',
          is_active: false
        });
      }
    }
    
    res.json({
      status: 'success',
      data: {
        patterns: patternStats,
        total_patterns: patterns.length,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    logger.error('Erro ao obter padrões ambíguos', { error });
    res.status(500).json({
      status: 'error',
      message: 'Erro ao obter padrões ambíguos',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;