import express from 'express';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { maskPII } from '../middleware/pii-masking';

/**
 * Módulo Marlie Upsell - P5 Upsell e Receita (v1)
 * 
 * Exibe no máximo 1 upsell por conversa após confirmação do agendamento.
 * A/B testing de copy (A|B) e posição (IMEDIATA|+10min).
 * Tracking de exibição, aceite e receita.
 * Meta: taxa de aceite ≥5% em 14 dias.
 */

// ==================== INTERFACES E TIPOS ====================

export interface MarlieUpsellConfig {
  env: {
    timezone: string;
    upsellEnabled: boolean;
    upsellDelayMin: number;
    upsellCopyAWeight: number;
    upsellPosImmediateWeight: number;
    adminToken: string;
  };
  security: {
    auth: string;
    piiMasking: boolean;
  };
  nlp: {
    patterns: {
      acceptNumeric1: string[];
      acceptWords: string[];
      declineWords: string[];
    };
  };
  responses: {
    copyA: string;
    copyB: string;
    confirmAdded: string;
    addedPending: string;
    declined: string;
    nothingToOffer: string;
    alreadyOffered: string;
  };
}

export interface UpsellVariant {
  copy: 'A' | 'B';
  position: 'IMMEDIATE' | 'DELAY10';
}

export interface UpsellEvent {
  conversationId: string;
  phone: string;
  event: 'shown' | 'accepted' | 'declined' | 'scheduled';
  addonId?: string;
  addonName?: string;
  variantCopy?: 'A' | 'B';
  variantPos?: 'IMMEDIATE' | 'DELAY10';
  priceBrl?: number;
  timestamp?: Date;
}

export interface RecommendedAddon {
  id: string;
  nome: string;
  duracao: number;
  preco: string;
  priceBrl: number;
}

export interface UpsellMetrics {
  totalShown: number;
  totalAccepted: number;
  totalDeclined: number;
  conversionRate: number;
  revenueGenerated: number;
  variantPerformance: {
    copyA: { shown: number; accepted: number; rate: number };
    copyB: { shown: number; accepted: number; rate: number };
  };
  positionPerformance: {
    immediate: { shown: number; accepted: number; rate: number };
    delayed: { shown: number; accepted: number; rate: number };
  };
}

// ==================== CONFIGURAÇÃO PADRÃO ====================

export function getDefaultUpsellConfig(): MarlieUpsellConfig {
  return {
    env: {
      timezone: process.env.TIMEZONE || 'America/Bahia',
      upsellEnabled: process.env.UPSELL_ENABLED !== 'false',
      upsellDelayMin: parseInt(process.env.UPSELL_DELAY_MIN || '10'),
      upsellCopyAWeight: parseFloat(process.env.UPSELL_COPY_A_WEIGHT || '0.5'),
      upsellPosImmediateWeight: parseFloat(process.env.UPSELL_POS_IMMEDIATE_WEIGHT || '0.5'),
      adminToken: process.env.ADMIN_TOKEN || 'default-admin-token'
    },
    security: {
      auth: `bearer:${process.env.ADMIN_TOKEN || 'default-admin-token'}`,
      piiMasking: true
    },
    nlp: {
      patterns: {
        acceptNumeric1: ['^\\s*1\\s*$'],
        acceptWords: [
          '(?i)\\b(sim|quero|aceito|adicionar|pode sim)\\b'
        ],
        declineWords: [
          '(?i)\\b(nao|não|talvez depois|agora não)\\b'
        ]
      }
    },
    responses: {
      copyA: 'Dica rápida: **{{addon.nome}}** ({{addon.duracao}}min) por **{{addon.preco}}**. Quer adicionar ao seu atendimento? Responda **1**.',
      copyB: 'Potencialize seu resultado: **{{addon.nome}}** ({{addon.duracao}}min). Valor **{{addon.preco}}**. Deseja incluir? Responda **1**.',
      confirmAdded: 'Perfeito! Adicionei **{{addon.nome}}** ao seu atendimento. ✅',
      addedPending: 'Certo! Vou ajustar sua agenda com **{{addon.nome}}** e te confirmo já. 😉',
      declined: 'Tudo bem! Seguimos com o que já foi confirmado. 🙌',
      nothingToOffer: ' ',
      alreadyOffered: ' '
    }
  };
}

// ==================== VALIDAÇÃO DE SCHEMAS ====================

const UpsellEventSchema = z.object({
  conversationId: z.string(),
  phone: z.string(),
  event: z.enum(['shown', 'accepted', 'declined', 'scheduled']),
  addonId: z.string().optional(),
  addonName: z.string().optional(),
  variantCopy: z.enum(['A', 'B']).optional(),
  variantPos: z.enum(['IMMEDIATE', 'DELAY10']).optional(),
  priceBrl: z.number().optional()
});

const RecommendedAddonSchema = z.object({
  id: z.string(),
  nome: z.string(),
  duracao: z.number(),
  preco: z.string(),
  priceBrl: z.number()
});

// ==================== CLASSE PRINCIPAL ====================

export class MarlieUpsellModule {
  private app: express.Express;
  private config: MarlieUpsellConfig;
  private pgPool: Pool;
  private redis: Redis;
  private initialized: boolean = false;

  constructor(
    app: express.Express,
    config: MarlieUpsellConfig,
    dependencies: {
      pgPool: Pool;
      redis: Redis;
    }
  ) {
    this.app = app;
    this.config = config;
    this.pgPool = dependencies.pgPool;
    this.redis = dependencies.redis;
  }

  /**
   * Inicializa o módulo de upsell
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Inicializando módulo Marlie Upsell...');

      // Verificar dependências
      await this.checkDependencies();

      // Criar tabelas se necessário
      await this.createTables();

      // Registrar middlewares
      this.registerMiddlewares();

      // Registrar rotas
      this.registerRoutes();

      this.initialized = true;
      logger.info('Módulo Marlie Upsell inicializado com sucesso');
    } catch (error) {
      logger.error('Erro ao inicializar módulo Marlie Upsell:', error);
      throw error;
    }
  }

  /**
   * Verifica se as dependências estão disponíveis
   */
  private async checkDependencies(): Promise<void> {
    try {
      // Verificar PostgreSQL
      await this.pgPool.query('SELECT 1');
      
      // Verificar Redis
      await this.redis.ping();
      
      logger.info('Dependências do módulo Upsell verificadas');
    } catch (error) {
      logger.error('Erro ao verificar dependências:', error);
      throw new Error('Dependências não disponíveis para módulo Upsell');
    }
  }

  /**
   * Cria as tabelas necessárias para o módulo
   */
  private async createTables(): Promise<void> {
    const createUpsellEventsTable = `
      CREATE TABLE IF NOT EXISTS upsell_events (
        id SERIAL PRIMARY KEY,
        conversation_id VARCHAR(255) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        event VARCHAR(20) NOT NULL,
        addon_id VARCHAR(100),
        addon_name VARCHAR(255),
        variant_copy VARCHAR(1),
        variant_pos VARCHAR(20),
        price_brl DECIMAL(10,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        tenant_id VARCHAR(100) DEFAULT 'default'
      );
    `;

    const createUpsellConversationsTable = `
      CREATE TABLE IF NOT EXISTS upsell_conversations (
        id SERIAL PRIMARY KEY,
        conversation_id VARCHAR(255) UNIQUE NOT NULL,
        has_upsell BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        tenant_id VARCHAR(100) DEFAULT 'default'
      );
    `;

    const createIndexes = `
      CREATE INDEX IF NOT EXISTS idx_upsell_events_conversation_id ON upsell_events(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_upsell_events_event ON upsell_events(event);
      CREATE INDEX IF NOT EXISTS idx_upsell_events_created_at ON upsell_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_upsell_conversations_conversation_id ON upsell_conversations(conversation_id);
    `;

    try {
      await this.pgPool.query(createUpsellEventsTable);
      await this.pgPool.query(createUpsellConversationsTable);
      await this.pgPool.query(createIndexes);
      
      logger.info('Tabelas do módulo Upsell criadas/verificadas');
    } catch (error) {
      logger.error('Erro ao criar tabelas do módulo Upsell:', error);
      throw error;
    }
  }

  /**
   * Registra middlewares necessários
   */
  private registerMiddlewares(): void {
    // Middleware para mascaramento de PII se habilitado
    if (this.config.security.piiMasking) {
      this.app.use('/admin/upsell', maskPII);
    }
  }

  /**
   * Registra as rotas do módulo
   */
  private registerRoutes(): void {
    // Rota para métricas de upsell
    this.app.get('/admin/upsell/metrics', async (req, res) => {
      try {
        const metrics = await this.getMetrics();
        res.json(metrics);
      } catch (error) {
        logger.error('Erro ao obter métricas de upsell:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
      }
    });

    // Rota para configuração de upsell
    this.app.get('/admin/upsell/config', (req, res) => {
      res.json({
        enabled: this.config.env.upsellEnabled,
        delayMin: this.config.env.upsellDelayMin,
        copyAWeight: this.config.env.upsellCopyAWeight,
        posImmediateWeight: this.config.env.upsellPosImmediateWeight
      });
    });

    // Rota para processar resposta de upsell
    this.app.post('/webhook/upsell-response', async (req, res) => {
      try {
        const { conversationId, phone, message } = req.body;
        await this.processUpsellResponse(conversationId, phone, message);
        res.json({ ok: true });
      } catch (error) {
        logger.error('Erro ao processar resposta de upsell:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
      }
    });

    // Rota para executar upsell agendado
    this.app.post('/internal/upsell/execute', async (req, res) => {
      try {
        const { conversationId, phone, appointmentId, primaryServiceId } = req.body;
        await this.executeScheduledUpsell(conversationId, phone, appointmentId, primaryServiceId);
        res.json({ ok: true });
      } catch (error) {
        logger.error('Erro ao executar upsell agendado:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
      }
    });
  }

  /**
   * Determina a variante A/B para o upsell
   */
  private determineVariant(): UpsellVariant {
    const copyRandom = Math.random();
    const posRandom = Math.random();

    return {
      copy: copyRandom < this.config.env.upsellCopyAWeight ? 'A' : 'B',
      position: posRandom < this.config.env.upsellPosImmediateWeight ? 'IMMEDIATE' : 'DELAY10'
    };
  }

  /**
   * Verifica se já houve oferta para a conversa
   */
  async hasUpsell(conversationId: string): Promise<boolean> {
    try {
      const result = await this.pgPool.query(
        'SELECT has_upsell FROM upsell_conversations WHERE conversation_id = $1',
        [conversationId]
      );
      
      return result.rows.length > 0 && result.rows[0].has_upsell;
    } catch (error) {
      logger.error('Erro ao verificar upsell existente:', error);
      return false;
    }
  }

  /**
   * Registra evento de upsell
   */
  async logUpsellEvent(event: UpsellEvent): Promise<void> {
    try {
      // Validar dados
      const validatedEvent = UpsellEventSchema.parse(event);
      
      // Mascarar PII se necessário
      const maskedPhone = this.config.security.piiMasking ? 
        maskPII(validatedEvent.phone) : validatedEvent.phone;

      // Inserir evento
      await this.pgPool.query(
        `INSERT INTO upsell_events 
         (conversation_id, phone, event, addon_id, addon_name, variant_copy, variant_pos, price_brl)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          validatedEvent.conversationId,
          maskedPhone,
          validatedEvent.event,
          validatedEvent.addonId,
          validatedEvent.addonName,
          validatedEvent.variantCopy,
          validatedEvent.variantPos,
          validatedEvent.priceBrl
        ]
      );

      // Marcar conversa como tendo upsell se for evento 'shown'
      if (validatedEvent.event === 'shown') {
        await this.pgPool.query(
          `INSERT INTO upsell_conversations (conversation_id, has_upsell)
           VALUES ($1, TRUE)
           ON CONFLICT (conversation_id) DO UPDATE SET has_upsell = TRUE`,
          [validatedEvent.conversationId]
        );
      }

      logger.info(`Evento de upsell registrado: ${validatedEvent.event}`, {
        conversationId: validatedEvent.conversationId,
        event: validatedEvent.event
      });
    } catch (error) {
      logger.error('Erro ao registrar evento de upsell:', error);
      throw error;
    }
  }

  /**
   * Obtém métricas de performance do upsell
   */
  async getMetrics(days: number = 14): Promise<UpsellMetrics> {
    try {
      const dateLimit = new Date();
      dateLimit.setDate(dateLimit.getDate() - days);

      // Métricas gerais
      const generalMetrics = await this.pgPool.query(
        `SELECT 
           event,
           variant_copy,
           variant_pos,
           COUNT(*) as count,
           SUM(COALESCE(price_brl, 0)) as revenue
         FROM upsell_events 
         WHERE created_at >= $1
         GROUP BY event, variant_copy, variant_pos`,
        [dateLimit]
      );

      const metrics: UpsellMetrics = {
        totalShown: 0,
        totalAccepted: 0,
        totalDeclined: 0,
        conversionRate: 0,
        revenueGenerated: 0,
        variantPerformance: {
          copyA: { shown: 0, accepted: 0, rate: 0 },
          copyB: { shown: 0, accepted: 0, rate: 0 }
        },
        positionPerformance: {
          immediate: { shown: 0, accepted: 0, rate: 0 },
          delayed: { shown: 0, accepted: 0, rate: 0 }
        }
      };

      // Processar resultados
      for (const row of generalMetrics.rows) {
        const count = parseInt(row.count);
        const revenue = parseFloat(row.revenue) || 0;

        if (row.event === 'shown') {
          metrics.totalShown += count;
          
          if (row.variant_copy === 'A') {
            metrics.variantPerformance.copyA.shown += count;
          } else if (row.variant_copy === 'B') {
            metrics.variantPerformance.copyB.shown += count;
          }
          
          if (row.variant_pos === 'IMMEDIATE') {
            metrics.positionPerformance.immediate.shown += count;
          } else if (row.variant_pos === 'DELAY10') {
            metrics.positionPerformance.delayed.shown += count;
          }
        } else if (row.event === 'accepted') {
          metrics.totalAccepted += count;
          metrics.revenueGenerated += revenue;
          
          if (row.variant_copy === 'A') {
            metrics.variantPerformance.copyA.accepted += count;
          } else if (row.variant_copy === 'B') {
            metrics.variantPerformance.copyB.accepted += count;
          }
          
          if (row.variant_pos === 'IMMEDIATE') {
            metrics.positionPerformance.immediate.accepted += count;
          } else if (row.variant_pos === 'DELAY10') {
            metrics.positionPerformance.delayed.accepted += count;
          }
        } else if (row.event === 'declined') {
          metrics.totalDeclined += count;
        }
      }

      // Calcular taxas de conversão
      metrics.conversionRate = metrics.totalShown > 0 ? 
        (metrics.totalAccepted / metrics.totalShown) * 100 : 0;
      
      metrics.variantPerformance.copyA.rate = metrics.variantPerformance.copyA.shown > 0 ?
        (metrics.variantPerformance.copyA.accepted / metrics.variantPerformance.copyA.shown) * 100 : 0;
      
      metrics.variantPerformance.copyB.rate = metrics.variantPerformance.copyB.shown > 0 ?
        (metrics.variantPerformance.copyB.accepted / metrics.variantPerformance.copyB.shown) * 100 : 0;
      
      metrics.positionPerformance.immediate.rate = metrics.positionPerformance.immediate.shown > 0 ?
        (metrics.positionPerformance.immediate.accepted / metrics.positionPerformance.immediate.shown) * 100 : 0;
      
      metrics.positionPerformance.delayed.rate = metrics.positionPerformance.delayed.shown > 0 ?
        (metrics.positionPerformance.delayed.accepted / metrics.positionPerformance.delayed.shown) * 100 : 0;

      return metrics;
    } catch (error) {
      logger.error('Erro ao obter métricas de upsell:', error);
      throw error;
    }
  }

  /**
   * Processa resposta do usuário ao upsell
   */
  async processUpsellResponse(conversationId: string, phone: string, message: string): Promise<void> {
    // Implementação será feita no próximo arquivo
    // Esta é apenas a estrutura base
  }

  /**
   * Executa upsell agendado
   */
  async executeScheduledUpsell(conversationId: string, phone: string, appointmentId: string, primaryServiceId: string): Promise<void> {
    // Implementação será feita no próximo arquivo
    // Esta é apenas a estrutura base
  }

  /**
   * Obtém estatísticas do módulo
   */
  async getStats(): Promise<any> {
    return {
      module: 'marlie-upsell',
      initialized: this.initialized,
      config: {
        enabled: this.config.env.upsellEnabled,
        delayMin: this.config.env.upsellDelayMin,
        copyAWeight: this.config.env.upsellCopyAWeight,
        posImmediateWeight: this.config.env.upsellPosImmediateWeight
      },
      metrics: await this.getMetrics()
    };
  }

  /**
   * Finaliza o módulo
   */
  async shutdown(): Promise<void> {
    this.initialized = false;
    logger.info('Módulo Marlie Upsell finalizado');
  }
}

// ==================== FUNÇÃO DE CRIAÇÃO ====================

export function createMarlieUpsellModule(
  app: express.Express,
  config?: Partial<MarlieUpsellConfig>,
  dependencies?: {
    pgPool: Pool;
    redis: Redis;
  }
): MarlieUpsellModule {
  const fullConfig = {
    ...getDefaultUpsellConfig(),
    ...config
  };

  if (!dependencies?.pgPool || !dependencies?.redis) {
    throw new Error('Dependências PostgreSQL e Redis são obrigatórias para o módulo Upsell');
  }

  return new MarlieUpsellModule(app, fullConfig, dependencies);
}

export default MarlieUpsellModule;