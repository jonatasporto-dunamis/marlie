/**
 * Serviço de Desambiguação Orientada por Catálogo
 * 
 * Resolve entradas ambíguas de serviços usando dados de popularidade
 * do catálogo local, apresentando top-3 opções para seleção rápida.
 * 
 * @author SyncBelle Dev
 * @version 1.0
 */

import { Pool } from 'pg';
import Redis from 'ioredis';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { promClient } from '../utils/metrics';

// =============================================================================
// INTERFACES E TIPOS
// =============================================================================

export interface DisambiguationConfig {
  nlp: {
    patterns: {
      numeric_1_3: string[];
      category_ambiguous: string[];
      specific_service: string[];
      stop_words: string[];
    };
  };
  responses: {
    top3_prompt: string;
    top2_prompt: string;
    single_option: string;
    invalid_choice: string;
    persisted_ok: string;
    no_options: string;
    catalog_error: string;
  };
  ux: {
    lists: {
      numbered_short: boolean;
      accept_numeric_only: number[];
      max_options: number;
      show_price: boolean;
      show_duration: boolean;
      currency_symbol: string;
    };
    persistence: {
      slots_to_keep: string[];
      reuse_on_next_turn: boolean;
      clear_on_new_session: boolean;
    };
    fallbacks: {
      max_disambiguation_attempts: number;
      fallback_to_manual: boolean;
      preserve_original_input: boolean;
    };
  };
}

export interface ServiceOption {
  servicoid: string;
  nomeservico: string;
  nomeservico_normalizado: string;
  profissionalid: string;
  categoria: string;
  preco: number;
  duracao: number;
  popularidade_30d?: number;
}

export interface DisambiguationContext {
  original_input: string;
  normalized_input: string;
  options: ServiceOption[];
  attempt_count: number;
  return_state?: string;
  user_phone: string;
  session_id: string;
}

export interface DisambiguationResult {
  success: boolean;
  selected_service?: ServiceOption;
  next_state: string;
  response_text: string;
  slots_to_set?: Record<string, any>;
  error?: string;
}

// =============================================================================
// MÉTRICAS PROMETHEUS
// =============================================================================

const metrics = {
  disambiguationPrompts: new promClient.Counter({
    name: 'catalog_disambig_prompts_total',
    help: 'Quantas vezes a lista top-3 foi apresentada',
    labelNames: ['category', 'options_count']
  }),
  
  numericChoices: new promClient.Counter({
    name: 'catalog_numeric_choices_total',
    help: 'Respostas 1–3 recebidas',
    labelNames: ['index']
  }),
  
  choicePersisted: new promClient.Counter({
    name: 'catalog_choice_persisted_total',
    help: 'Seleções persistidas em slots',
    labelNames: ['source']
  }),
  
  fallbackManual: new promClient.Counter({
    name: 'catalog_fallback_manual_total',
    help: 'Vezes que fallback manual foi usado',
    labelNames: ['reason']
  }),
  
  disambiguationDuration: new promClient.Summary({
    name: 'catalog_disambiguation_duration_seconds',
    help: 'Tempo gasto no processo de desambiguação'
  })
};

// =============================================================================
// SERVIÇO PRINCIPAL
// =============================================================================

export class CatalogDisambiguationService {
  private config: DisambiguationConfig;
  private db: Pool;
  private redis: Redis;
  private cachePrefix = 'disambig:';
  private cacheTTL = 300; // 5 minutos

  constructor(db: Pool, redis: Redis) {
    this.db = db;
    this.redis = redis;
    this.loadConfig();
  }

  /**
   * Carrega configuração do arquivo YAML
   */
  private loadConfig(): void {
    try {
      const configPath = path.join(__dirname, '../config/catalog-disambiguation.yaml');
      const configFile = fs.readFileSync(configPath, 'utf8');
      const fullConfig = yaml.load(configFile) as any;
      
      this.config = {
        nlp: fullConfig.nlp,
        responses: fullConfig.responses,
        ux: fullConfig.ux
      };
      
      logger.info('Configuração de desambiguação carregada', {
        patterns_count: Object.keys(this.config.nlp.patterns).length,
        responses_count: Object.keys(this.config.responses).length
      });
    } catch (error) {
      logger.error('Erro ao carregar configuração de desambiguação', { error });
      throw new Error('Falha ao inicializar serviço de desambiguação');
    }
  }

  /**
   * Verifica se uma entrada é ambígua e requer desambiguação
   */
  public isAmbiguous(input: string): boolean {
    const patterns = this.config.nlp.patterns.category_ambiguous;
    
    for (const pattern of patterns) {
      const regex = new RegExp(pattern);
      if (regex.test(input)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Verifica se uma entrada é uma escolha numérica válida (1-3)
   */
  public isNumericChoice(input: string): boolean {
    const patterns = this.config.nlp.patterns.numeric_1_3;
    
    for (const pattern of patterns) {
      const regex = new RegExp(pattern);
      if (regex.test(input)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Normaliza nome do serviço removendo stop words e caracteres especiais
   */
  public normalizeServiceName(input: string): string {
    let normalized = input.toLowerCase().trim();
    
    // Remove stop words
    const stopWords = this.config.nlp.patterns.stop_words;
    for (const pattern of stopWords) {
      const regex = new RegExp(pattern, 'g');
      normalized = normalized.replace(regex, ' ');
    }
    
    // Remove caracteres especiais e espaços extras
    normalized = normalized
      .replace(/[^a-záàâãéèêíìîóòôõúùûç\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    return normalized;
  }

  /**
   * Busca top-N serviços por categoria com base em popularidade dos últimos 30 dias
   */
  public async getTopServicesByCategory(
    category: string, 
    limit: number = 3
  ): Promise<ServiceOption[]> {
    const timer = metrics.disambiguationDuration.startTimer();
    
    try {
      // Verificar cache primeiro
      const cacheKey = `${this.cachePrefix}category:${category}:${limit}`;
      const cached = await this.redis.get(cacheKey);
      
      if (cached) {
        logger.debug('Cache hit para categoria', { category, limit });
        return JSON.parse(cached);
      }
      
      // Consulta ao banco com popularidade dos últimos 30 dias
      const query = `
        SELECT 
          sp.servicoid,
          sp.nomeservico,
          sp.nomeservico_normalizado,
          sp.profissionalid,
          sp.categoria,
          sp.preco,
          sp.duracao,
          COALESCE(pop.count, 0) as popularidade_30d
        FROM servicos_prof sp
        LEFT JOIN (
          SELECT 
            servicoid,
            COUNT(*) as count
          FROM agendamentos 
          WHERE created_at >= NOW() - INTERVAL '30 days'
            AND status IN ('confirmed', 'completed')
          GROUP BY servicoid
        ) pop ON sp.servicoid = pop.servicoid
        WHERE sp.categoria_normalizada = $1
          AND sp.ativo = true
        ORDER BY 
          COALESCE(pop.count, 0) DESC,
          sp.preco ASC,
          sp.nomeservico ASC
        LIMIT $2
      `;
      
      const result = await this.db.query(query, [category, limit]);
      const services = result.rows;
      
      // Cache resultado
      await this.redis.setex(cacheKey, this.cacheTTL, JSON.stringify(services));
      
      logger.info('Busca por categoria executada', {
        category,
        limit,
        found: services.length
      });
      
      return services;
    } catch (error) {
      logger.error('Erro ao buscar serviços por categoria', {
        category,
        limit,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      timer();
    }
  }

  /**
   * Busca serviços por similaridade textual
   */
  public async searchServicesByText(
    searchTerm: string, 
    limit: number = 3,
    similarityThreshold: number = 0.3
  ): Promise<ServiceOption[]> {
    const timer = metrics.disambiguationDuration.startTimer();
    
    try {
      // Verificar cache primeiro
      const cacheKey = `${this.cachePrefix}search:${searchTerm}:${limit}`;
      const cached = await this.redis.get(cacheKey);
      
      if (cached) {
        logger.debug('Cache hit para busca textual', { searchTerm, limit });
        return JSON.parse(cached);
      }
      
      // Consulta com busca textual e popularidade
      const query = `
        SELECT 
          sp.servicoid,
          sp.nomeservico,
          sp.nomeservico_normalizado,
          sp.profissionalid,
          sp.categoria,
          sp.preco,
          sp.duracao,
          COALESCE(pop.count, 0) as popularidade_30d,
          similarity(sp.nomeservico_normalizado, $1) as similarity_score
        FROM servicos_prof sp
        LEFT JOIN (
          SELECT 
            servicoid,
            COUNT(*) as count
          FROM agendamentos 
          WHERE created_at >= NOW() - INTERVAL '30 days'
            AND status IN ('confirmed', 'completed')
          GROUP BY servicoid
        ) pop ON sp.servicoid = pop.servicoid
        WHERE sp.ativo = true
          AND (
            sp.nomeservico_normalizado % $1
            OR sp.nomeservico_normalizado ILIKE '%' || $1 || '%'
            OR sp.categoria_normalizada ILIKE '%' || $1 || '%'
          )
          AND similarity(sp.nomeservico_normalizado, $1) >= $2
        ORDER BY 
          similarity(sp.nomeservico_normalizada, $1) DESC,
          COALESCE(pop.count, 0) DESC,
          sp.preco ASC
        LIMIT $3
      `;
      
      const result = await this.db.query(query, [searchTerm, similarityThreshold, limit]);
      const services = result.rows;
      
      // Cache resultado
      await this.redis.setex(cacheKey, this.cacheTTL, JSON.stringify(services));
      
      logger.info('Busca textual executada', {
        searchTerm,
        limit,
        similarityThreshold,
        found: services.length
      });
      
      return services;
    } catch (error) {
      logger.error('Erro ao buscar serviços por texto', {
        searchTerm,
        limit,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      timer();
    }
  }

  /**
   * Inicia processo de desambiguação
   */
  public async startDisambiguation(
    input: string,
    context: Partial<DisambiguationContext>
  ): Promise<DisambiguationResult> {
    try {
      const normalizedInput = this.normalizeServiceName(input);
      
      // Determinar tipo de busca
      let services: ServiceOption[];
      
      if (this.isAmbiguous(input)) {
        // Busca por categoria
        services = await this.getTopServicesByCategory(normalizedInput, 3);
        
        metrics.disambiguationPrompts.inc({
          category: normalizedInput,
          options_count: services.length.toString()
        });
      } else {
        // Busca textual
        services = await this.searchServicesByText(normalizedInput, 3);
      }
      
      // Gerar resposta baseada na quantidade de opções
      return this.generateDisambiguationResponse(services, input, context);
      
    } catch (error) {
      logger.error('Erro no processo de desambiguação', {
        input,
        context,
        error: error instanceof Error ? error.message : String(error)
      });
      
      return {
        success: false,
        next_state: 'FALLBACK_MANUAL_INPUT',
        response_text: this.config.responses.catalog_error,
        error: error.message
      };
    }
  }

  /**
   * Processa escolha numérica do usuário
   */
  public async processNumericChoice(
    choice: string,
    options: ServiceOption[],
    context: DisambiguationContext
  ): Promise<DisambiguationResult> {
    try {
      const choiceIndex = parseInt(choice.trim()) - 1;
      
      // Validar índice
      if (choiceIndex < 0 || choiceIndex >= options.length) {
        return {
          success: false,
          next_state: 'CATALOG_WAIT_CHOICE',
          response_text: this.config.responses.invalid_choice
        };
      }
      
      const selectedService = options[choiceIndex];
      
      // Registrar métrica
      metrics.numericChoices.inc({ index: (choiceIndex + 1).toString() });
      metrics.choicePersisted.inc({ source: 'catalog' });
      
      // Preparar slots para persistir
      const slotsToSet = {
        service_id: selectedService.servicoid,
        service_name: selectedService.nomeservico,
        service_norm: selectedService.nomeservico_normalizado,
        professional_id: selectedService.profissionalid,
        service_price: selectedService.preco,
        service_duration: selectedService.duracao,
        category: selectedService.categoria
      };
      
      // Gerar resposta de confirmação
      const responseText = this.config.responses.persisted_ok
        .replace('{{slots.service_name}}', selectedService.nomeservico);
      
      logger.info('Escolha numérica processada', {
        choice,
        selected_service: selectedService.nomeservico,
        user_phone: context.user_phone
      });
      
      return {
        success: true,
        selected_service: selectedService,
        next_state: context.return_state || 'VALIDATE_BEFORE_CONFIRM',
        response_text: responseText,
        slots_to_set: slotsToSet
      };
      
    } catch (error) {
      logger.error('Erro ao processar escolha numérica', {
        choice,
        options_count: options.length,
        context,
        error: error instanceof Error ? error.message : String(error)
      });
      
      return {
        success: false,
        next_state: 'CATALOG_WAIT_CHOICE',
        response_text: this.config.responses.invalid_choice,
        error: error.message
      };
    }
  }

  /**
   * Processa entrada manual (fallback)
   */
  public async processManualInput(
    input: string,
    context: DisambiguationContext
  ): Promise<DisambiguationResult> {
    try {
      const normalizedInput = this.normalizeServiceName(input);
      
      // Registrar métrica de fallback
      metrics.fallbackManual.inc({ reason: 'manual_input' });
      metrics.choicePersisted.inc({ source: 'manual' });
      
      // Preparar slots para persistir
      const slotsToSet = {
        service_name: input.trim(),
        service_norm: normalizedInput,
        manual_service: true
      };
      
      const responseText = `✅ Anotei **${input.trim()}**. Vamos encontrar um horário!`;
      
      logger.info('Entrada manual processada', {
        input,
        normalized: normalizedInput,
        user_phone: context.user_phone
      });
      
      return {
        success: true,
        next_state: context.return_state || 'VALIDATE_BEFORE_CONFIRM',
        response_text: responseText,
        slots_to_set: slotsToSet
      };
      
    } catch (error) {
      logger.error('Erro ao processar entrada manual', {
        input,
        context,
        error: error instanceof Error ? error.message : String(error)
      });
      
      return {
        success: false,
        next_state: 'FALLBACK_MANUAL_INPUT',
        response_text: 'Ocorreu um erro. Tente novamente.',
        error: error.message
      };
    }
  }

  /**
   * Gera resposta de desambiguação baseada nas opções encontradas
   */
  private generateDisambiguationResponse(
    services: ServiceOption[],
    originalInput: string,
    context: Partial<DisambiguationContext>
  ): DisambiguationResult {
    if (services.length === 0) {
      // Nenhuma opção encontrada
      metrics.fallbackManual.inc({ reason: 'no_options' });
      
      return {
        success: false,
        next_state: 'FALLBACK_MANUAL_INPUT',
        response_text: this.config.responses.no_options
          .replace('{{input.text}}', originalInput)
      };
    }
    
    if (services.length === 1) {
      // Apenas uma opção - pedir confirmação
      const service = services[0];
      const responseText = this.config.responses.single_option
        .replace('{{top3.0.nome}}', service.nomeservico)
        .replace('{{top3.0.duracao}}', service.duracao?.toString() || '—')
        .replace('{{top3.0.preco}}', service.preco?.toString() || '—');
      
      return {
        success: true,
        next_state: 'CATALOG_WAIT_CONFIRMATION',
        response_text: responseText
      };
    }
    
    // Múltiplas opções - apresentar lista numerada
    const template = services.length === 2 
      ? this.config.responses.top2_prompt 
      : this.config.responses.top3_prompt;
    
    let responseText = template;
    
    // Substituir variáveis do template
    services.forEach((service, index) => {
      responseText = responseText
        .replace(`{{top3.${index}.nome}}`, service.nomeservico)
        .replace(`{{top3.${index}.duracao}}`, service.duracao?.toString() || '—')
        .replace(`{{top3.${index}.preco}}`, service.preco?.toString() || '—');
    });
    
    return {
      success: true,
      next_state: 'CATALOG_WAIT_CHOICE',
      response_text: responseText
    };
  }

  /**
   * Limpa cache de desambiguação
   */
  public async clearCache(pattern?: string): Promise<void> {
    try {
      const searchPattern = pattern || `${this.cachePrefix}*`;
      const keys = await this.redis.keys(searchPattern);
      
      if (keys.length > 0) {
        await this.redis.del(...keys);
        logger.info('Cache de desambiguação limpo', {
          pattern: searchPattern,
          keys_deleted: keys.length
        });
      }
    } catch (error) {
      logger.error('Erro ao limpar cache de desambiguação', {
        pattern,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Obtém estatísticas do serviço
   */
  public async getStats(): Promise<Record<string, any>> {
    try {
      const stats = {
        cache_keys: 0,
        total_services: 0,
        active_categories: 0,
        avg_popularity: 0
      };
      
      // Contar chaves de cache
      const cacheKeys = await this.redis.keys(`${this.cachePrefix}*`);
      stats.cache_keys = cacheKeys.length;
      
      // Estatísticas do banco
      const dbStats = await this.db.query(`
        SELECT 
          COUNT(*) as total_services,
          COUNT(DISTINCT categoria) as active_categories,
          AVG(COALESCE(pop.count, 0)) as avg_popularity
        FROM servicos_prof sp
        LEFT JOIN (
          SELECT 
            servicoid,
            COUNT(*) as count
          FROM agendamentos 
          WHERE created_at >= NOW() - INTERVAL '30 days'
            AND status IN ('confirmed', 'completed')
          GROUP BY servicoid
        ) pop ON sp.servicoid = pop.servicoid
        WHERE sp.ativo = true
      `);
      
      if (dbStats.rows.length > 0) {
        const row = dbStats.rows[0];
        stats.total_services = parseInt(row.total_services);
        stats.active_categories = parseInt(row.active_categories);
        stats.avg_popularity = parseFloat(row.avg_popularity) || 0;
      }
      
      return stats;
    } catch (error) {
      logger.error('Erro ao obter estatísticas de desambiguação', {
        error: error instanceof Error ? error.message : String(error)
      });
      return {};
    }
  }
}

// =============================================================================
// INSTÂNCIA SINGLETON
// =============================================================================

let instance: CatalogDisambiguationService | null = null;

export function getCatalogDisambiguationService(
  db?: Pool, 
  redis?: Redis
): CatalogDisambiguationService {
  if (!instance && db && redis) {
    instance = new CatalogDisambiguationService(db, redis);
  }
  
  if (!instance) {
    throw new Error('CatalogDisambiguationService não foi inicializado');
  }
  
  return instance;
}

export function resetCatalogDisambiguationService(): void {
  instance = null;
}