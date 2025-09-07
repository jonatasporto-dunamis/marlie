import { Pool } from 'pg';
import Redis from 'ioredis';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { MarlieUpsellConfig, UpsellVariant, UpsellEvent, RecommendedAddon } from '../modules/marlie-upsell';
import { maskPII } from '../middleware/pii-masking';
import { UpsellDatabase } from '../database/upsell-queries';
import { UpsellScheduler } from './upsell-scheduler';
import { UpsellStateMachineIntegration } from '../integrations/upsell-state-machine';
import { Metrics } from '../utils/metrics';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Serviço de Upsell - Lógica principal do módulo
 * 
 * Responsável por:
 * - Determinar quando oferecer upsell
 * - Selecionar addon recomendado
 * - Aplicar A/B testing
 * - Processar respostas do usuário
 * - Integrar com Trinks e WhatsApp
 */

export interface UpsellTools {
  catalogRecommendedAddon: (primaryServiceId: string) => Promise<RecommendedAddon | null>;
  waSendMessage: (phone: string, text: string) => Promise<void>;
  schedulerEnqueue: (runAtIso: string, route: string, payload: any) => Promise<void>;
  trinksAppendService: (appointmentId: string, serviceId: string) => Promise<void>;
}

export interface UpsellContext {
  conversationId: string;
  phone: string;
  appointmentId: string;
  primaryServiceId: string;
  customerName?: string;
}

export class UpsellService extends EventEmitter {
  private config: MarlieUpsellConfig;
  private pgPool: Pool;
  private redis: Redis;
  private tools: UpsellTools;
  private database: UpsellDatabase;
  private scheduler: UpsellScheduler;
  private stateMachine: UpsellStateMachineIntegration;
  private metrics: Metrics;
  private stateMachineConfig: any;
  private conversationCache: Map<string, any> = new Map();
  private abTestingCache: Map<string, UpsellVariant> = new Map();

  constructor(
    config: MarlieUpsellConfig,
    pgPool: Pool,
    redis: Redis,
    tools: UpsellTools
  ) {
    super();
    this.config = config;
    this.pgPool = pgPool;
    this.redis = redis;
    this.tools = tools;
    this.database = new UpsellDatabase();
    this.scheduler = new UpsellScheduler({
      defaultDelay: config.env?.upsellDelayMin || 10,
      maxRetries: 3,
      retryDelay: 60
    });
    this.stateMachine = new UpsellStateMachineIntegration();
    this.metrics = new Metrics('upsell');
    
    this.loadStateMachineConfig();
    this.setupEventListeners();
  }

  private loadStateMachineConfig(): void {
    try {
      const configPath = path.join(__dirname, '../config/upsell-state-machine.yaml');
      const configContent = fs.readFileSync(configPath, 'utf8');
      this.stateMachineConfig = yaml.load(configContent);
      logger.info('State machine config loaded successfully');
    } catch (error) {
      logger.error('Failed to load state machine config:', error);
      throw new Error('State machine configuration is required');
    }
  }

  private setupEventListeners(): void {
    this.scheduler.on('job:completed', this.handleScheduledUpsell.bind(this));
    this.scheduler.on('job:failed', this.handleScheduledUpsellFailure.bind(this));
    
    this.on('upsell:shown', this.updateMetrics.bind(this));
    this.on('upsell:accepted', this.updateMetrics.bind(this));
    this.on('upsell:declined', this.updateMetrics.bind(this));
    
    // State machine events
    this.stateMachine.on('state:transition', this.handleStateTransition.bind(this));
    this.stateMachine.on('upsell:completed', this.handleUpsellCompleted.bind(this));
  }

  async initialize(): Promise<void> {
    try {
      await this.database.initialize();
      await this.scheduler.start();
      await this.stateMachine.initialize();
      logger.info('UpsellService initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize UpsellService:', error);
      throw error;
    }
  }

  private handleScheduledUpsell(job: any): void {
    logger.info('Scheduled upsell job completed', { jobId: job.id });
  }

  private handleScheduledUpsellFailure(job: any, error: Error): void {
    logger.error('Scheduled upsell job failed', { jobId: job.id, error });
  }

  private updateMetrics(event: any): void {
    this.metrics.increment(`upsell.${event.type}`);
  }

  private handleStateTransition(transition: any): void {
    logger.debug('State transition occurred', transition);
  }

  private handleUpsellCompleted(result: any): void {
    logger.info('Upsell completed', result);
  }

  /**
   * Processa confirmação de agendamento e decide se deve oferecer upsell
   */
  async processBookingConfirmation(context: UpsellContext): Promise<void> {
    try {
      // Verificar se upsell está habilitado
      if (!this.config.env.upsellEnabled) {
        logger.debug('Upsell desabilitado, pulando oferta');
        return;
      }

      // Verificar se já houve oferta nesta conversa (deduplicação)
      const hasExistingUpsell = await this.hasUpsell(context.conversationId);
      if (hasExistingUpsell) {
        logger.debug('Upsell já oferecido nesta conversa, pulando', {
          conversationId: context.conversationId
        });
        return;
      }

      // Obter recomendação de addon
      const recommendedAddon = await this.getRecommendedAddon(context.primaryServiceId);
      if (!recommendedAddon) {
        logger.debug('Nenhum addon recomendado encontrado', {
          primaryServiceId: context.primaryServiceId
        });
        
        // Log evento de "nada para oferecer"
        await this.logUpsellEvent({
          conversationId: context.conversationId,
          phone: context.phone,
          event: 'shown',
          addonId: 'none',
          addonName: 'nothing_to_offer'
        });
        return;
      }

      // Determinar variante A/B
      const variant = this.determineVariant();

      // Decidir quando enviar (imediato ou com delay)
      if (variant.position === 'IMMEDIATE') {
        await this.sendUpsellOffer(context, recommendedAddon, variant);
      } else {
        await this.scheduleUpsellOffer(context, recommendedAddon, variant);
      }

    } catch (error) {
      logger.error('Erro ao processar confirmação de agendamento para upsell:', error);
    }
  }

  /**
   * Envia oferta de upsell imediatamente
   */
  private async sendUpsellOffer(
    context: UpsellContext,
    addon: RecommendedAddon,
    variant: UpsellVariant
  ): Promise<void> {
    try {
      // Gerar mensagem baseada na variante
      const message = this.generateUpsellMessage(addon, variant.copy);

      // Enviar mensagem via WhatsApp
      await this.tools.waSendMessage(context.phone, message);

      // Registrar evento
      await this.logUpsellEvent({
        conversationId: context.conversationId,
        phone: context.phone,
        event: 'shown',
        addonId: addon.id,
        addonName: addon.nome,
        variantCopy: variant.copy,
        variantPos: variant.position,
        priceBrl: addon.priceBrl
      });

      // Armazenar contexto no Redis para processar resposta
      await this.storeUpsellContext(context.conversationId, {
        ...context,
        addon,
        variant
      });

      logger.info('Oferta de upsell enviada', {
        conversationId: context.conversationId,
        addonId: addon.id,
        variant
      });

    } catch (error) {
      logger.error('Erro ao enviar oferta de upsell:', error);
      throw error;
    }
  }

  /**
   * Agenda oferta de upsell para envio posterior
   */
  private async scheduleUpsellOffer(
    context: UpsellContext,
    addon: RecommendedAddon,
    variant: UpsellVariant
  ): Promise<void> {
    try {
      // Calcular horário de execução
      const executeAt = new Date();
      executeAt.setMinutes(executeAt.getMinutes() + this.config.env.upsellDelayMin);

      // Agendar execução
      await this.tools.schedulerEnqueue(
        executeAt.toISOString(),
        '/internal/upsell/execute',
        {
          conversationId: context.conversationId,
          phone: context.phone,
          appointmentId: context.appointmentId,
          primaryServiceId: context.primaryServiceId,
          addon,
          variant
        }
      );

      // Registrar evento de agendamento
      await this.logUpsellEvent({
        conversationId: context.conversationId,
        phone: context.phone,
        event: 'scheduled',
        addonId: addon.id,
        addonName: addon.nome,
        variantCopy: variant.copy,
        variantPos: variant.position,
        priceBrl: addon.priceBrl
      });

      logger.info('Oferta de upsell agendada', {
        conversationId: context.conversationId,
        addonId: addon.id,
        executeAt: executeAt.toISOString(),
        variant
      });

    } catch (error) {
      logger.error('Erro ao agendar oferta de upsell:', error);
      throw error;
    }
  }

  /**
   * Executa oferta de upsell agendada
   */
  async executeScheduledUpsell(payload: any): Promise<void> {
    try {
      const { conversationId, phone, addon, variant } = payload;

      // Verificar se ainda não houve resposta
      const hasResponse = await this.redis.get(`upsell:response:${conversationId}`);
      if (hasResponse) {
        logger.debug('Upsell já teve resposta, cancelando execução agendada', {
          conversationId
        });
        return;
      }

      // Enviar oferta
      const message = this.generateUpsellMessage(addon, variant.copy);
      await this.tools.waSendMessage(phone, message);

      // Registrar evento
      await this.logUpsellEvent({
        conversationId,
        phone,
        event: 'shown',
        addonId: addon.id,
        addonName: addon.nome,
        variantCopy: variant.copy,
        variantPos: variant.position,
        priceBrl: addon.priceBrl
      });

      // Armazenar contexto
      await this.storeUpsellContext(conversationId, payload);

      logger.info('Oferta de upsell agendada executada', {
        conversationId,
        addonId: addon.id
      });

    } catch (error) {
      logger.error('Erro ao executar oferta de upsell agendada:', error);
    }
  }

  /**
   * Processa resposta do usuário ao upsell
   */
  async processUpsellResponse(conversationId: string, phone: string, message: string): Promise<void> {
    try {
      // Recuperar contexto do upsell
      const context = await this.getUpsellContext(conversationId);
      if (!context) {
        logger.debug('Contexto de upsell não encontrado', { conversationId });
        return;
      }

      // Analisar resposta
      const response = this.analyzeResponse(message);
      
      if (response === 'accept') {
        await this.handleUpsellAcceptance(context);
      } else if (response === 'decline') {
        await this.handleUpsellDecline(context);
      } else {
        // Resposta ambígua, não processar
        logger.debug('Resposta ambígua ao upsell, ignorando', {
          conversationId,
          message
        });
        return;
      }

      // Marcar como respondido
      await this.redis.setex(`upsell:response:${conversationId}`, 3600, response);

      // Limpar contexto
      await this.clearUpsellContext(conversationId);

    } catch (error) {
      logger.error('Erro ao processar resposta de upsell:', error);
    }
  }

  /**
   * Processa aceitação do upsell
   */
  private async handleUpsellAcceptance(context: any): Promise<void> {
    try {
      const { conversationId, phone, appointmentId, addon, variant } = context;

      // Adicionar serviço ao agendamento via Trinks
      await this.tools.trinksAppendService(appointmentId, addon.id);

      // Enviar confirmação
      const confirmMessage = this.config.responses.confirmAdded
        .replace('{{addon.nome}}', addon.nome);
      
      await this.tools.waSendMessage(phone, confirmMessage);

      // Registrar evento de aceitação
      await this.logUpsellEvent({
        conversationId,
        phone,
        event: 'accepted',
        addonId: addon.id,
        addonName: addon.nome,
        variantCopy: variant.copy,
        variantPos: variant.position,
        priceBrl: addon.priceBrl
      });

      logger.info('Upsell aceito e processado', {
        conversationId,
        addonId: addon.id,
        revenue: addon.priceBrl
      });

    } catch (error) {
      logger.error('Erro ao processar aceitação de upsell:', error);
      
      // Enviar mensagem de erro amigável
      const errorMessage = this.config.responses.addedPending
        .replace('{{addon.nome}}', context.addon.nome);
      
      await this.tools.waSendMessage(context.phone, errorMessage);
    }
  }

  /**
   * Processa recusa do upsell
   */
  private async handleUpsellDecline(context: any): Promise<void> {
    try {
      const { conversationId, phone, addon, variant } = context;

      // Enviar mensagem de confirmação da recusa
      await this.tools.waSendMessage(phone, this.config.responses.declined);

      // Registrar evento de recusa
      await this.logUpsellEvent({
        conversationId,
        phone,
        event: 'declined',
        addonId: addon.id,
        addonName: addon.nome,
        variantCopy: variant.copy,
        variantPos: variant.position,
        priceBrl: addon.priceBrl
      });

      logger.info('Upsell recusado', {
        conversationId,
        addonId: addon.id
      });

    } catch (error) {
      logger.error('Erro ao processar recusa de upsell:', error);
    }
  }

  /**
   * Analisa resposta do usuário usando NLP patterns
   */
  private analyzeResponse(message: string): 'accept' | 'decline' | 'unknown' {
    const normalizedMessage = message.toLowerCase().trim();

    // Verificar padrão numérico "1"
    for (const pattern of this.config.nlp.patterns.acceptNumeric1) {
      const regex = new RegExp(pattern);
      if (regex.test(normalizedMessage)) {
        return 'accept';
      }
    }

    // Verificar palavras de aceitação
    for (const pattern of this.config.nlp.patterns.acceptWords) {
      const regex = new RegExp(pattern);
      if (regex.test(normalizedMessage)) {
        return 'accept';
      }
    }

    // Verificar palavras de recusa
    for (const pattern of this.config.nlp.patterns.declineWords) {
      const regex = new RegExp(pattern);
      if (regex.test(normalizedMessage)) {
        return 'decline';
      }
    }

    return 'unknown';
  }

  /**
   * Gera mensagem de upsell baseada na variante
   */
  private generateUpsellMessage(addon: RecommendedAddon, copyVariant: 'A' | 'B'): string {
    const template = copyVariant === 'A' ? 
      this.config.responses.copyA : 
      this.config.responses.copyB;

    return template
      .replace('{{addon.nome}}', addon.nome)
      .replace('{{addon.duracao}}', addon.duracao.toString())
      .replace('{{addon.preco}}', addon.preco);
  }

  /**
   * Determina variante A/B para o upsell
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
   * Obtém recomendação de addon via ferramenta catalog
   */
  private async getRecommendedAddon(primaryServiceId: string): Promise<RecommendedAddon | null> {
    try {
      return await this.tools.catalogRecommendedAddon(primaryServiceId);
    } catch (error) {
      logger.error('Erro ao obter addon recomendado:', error);
      return null;
    }
  }

  /**
   * Verifica se já houve oferta para a conversa
   */
  private async hasUpsell(conversationId: string): Promise<boolean> {
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
  private async logUpsellEvent(event: UpsellEvent): Promise<void> {
    try {
      // Mascarar PII se necessário
      const maskedPhone = this.config.security.piiMasking ? 
        maskPII(event.phone) : event.phone;

      // Inserir evento
      await this.pgPool.query(
        `INSERT INTO upsell_events 
         (conversation_id, phone, event, addon_id, addon_name, variant_copy, variant_pos, price_brl)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          event.conversationId,
          maskedPhone,
          event.event,
          event.addonId,
          event.addonName,
          event.variantCopy,
          event.variantPos,
          event.priceBrl
        ]
      );

      // Marcar conversa como tendo upsell se for evento 'shown'
      if (event.event === 'shown') {
        await this.pgPool.query(
          `INSERT INTO upsell_conversations (conversation_id, has_upsell)
           VALUES ($1, TRUE)
           ON CONFLICT (conversation_id) DO UPDATE SET has_upsell = TRUE`,
          [event.conversationId]
        );
      }

      logger.debug(`Evento de upsell registrado: ${event.event}`, {
        conversationId: event.conversationId,
        event: event.event
      });
    } catch (error) {
      logger.error('Erro ao registrar evento de upsell:', error);
      throw error;
    }
  }

  /**
   * Armazena contexto do upsell no Redis
   */
  private async storeUpsellContext(conversationId: string, context: any): Promise<void> {
    try {
      const key = `upsell:context:${conversationId}`;
      await this.redis.setex(key, 3600, JSON.stringify(context)); // 1 hora de TTL
    } catch (error) {
      logger.error('Erro ao armazenar contexto de upsell:', error);
    }
  }

  /**
   * Recupera contexto do upsell do Redis
   */
  private async getUpsellContext(conversationId: string): Promise<any | null> {
    try {
      const key = `upsell:context:${conversationId}`;
      const data = await this.redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error('Erro ao recuperar contexto de upsell:', error);
      return null;
    }
  }

  /**
   * Remove contexto do upsell do Redis
   */
  private async clearUpsellContext(conversationId: string): Promise<void> {
    try {
      const key = `upsell:context:${conversationId}`;
      await this.redis.del(key);
    } catch (error) {
      logger.error('Erro ao limpar contexto de upsell:', error);
    }
  }

  /**
   * Obtém estatísticas do serviço
   */
  async getStats(): Promise<any> {
    try {
      const totalEvents = await this.pgPool.query(
        'SELECT event, COUNT(*) as count FROM upsell_events GROUP BY event'
      );

      const recentActivity = await this.pgPool.query(
        `SELECT DATE(created_at) as date, event, COUNT(*) as count 
         FROM upsell_events 
         WHERE created_at >= NOW() - INTERVAL '7 days'
         GROUP BY DATE(created_at), event
         ORDER BY date DESC`
      );

      return {
        service: 'upsell-service',
        totalEvents: totalEvents.rows,
        recentActivity: recentActivity.rows,
        config: {
          enabled: this.config.env.upsellEnabled,
          delayMin: this.config.env.upsellDelayMin,
          copyAWeight: this.config.env.upsellCopyAWeight,
          posImmediateWeight: this.config.env.upsellPosImmediateWeight
        }
      };
    } catch (error) {
      logger.error('Erro ao obter estatísticas do serviço de upsell:', error);
      return { error: 'Erro ao obter estatísticas' };
    }
  }
}

export default UpsellService;