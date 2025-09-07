import { logger } from '../utils/logger';
import { getRedis } from '../infra/redis';
import { db } from '../db';
import { CatalogTrinksService, TrinksApiService } from './catalog-trinks-service';

/**
 * Interface para dados de serviço do Trinks
 */
export interface TrinksServiceData {
  profissionalid: number;
  servicoid: number;
  nomeservico: string;
  categoria: string;
  preco?: number;
  duracao?: number;
  updated_at: string;
  ativo: boolean;
}

/**
 * Interface para dados normalizados
 */
export interface NormalizedServiceData extends TrinksServiceData {
  nomeservico_normalizado: string;
  categoria_normalizada: string;
}

/**
 * Interface para relatório de diferenças
 */
export interface DiffReport {
  as_of_date: string;
  total_trinks: number;
  total_local: number;
  missing_in_local: number;
  extra_in_local: number;
  duplicates: number;
  phantoms: TrinksServiceData[];
  duplicates_detail: any[];
}

/**
 * Interface para watermark
 */
export interface SyncWatermark {
  updated_since_iso: string;
  last_seen_iso: string;
  sync_timestamp: string;
}

/**
 * Serviço de sincronização do catálogo Trinks
 */
export class CatalogSyncService {
  private trinksService: CatalogTrinksService;
  private redis: any;
  private readonly WATERMARK_KEY = 'catalog:watermark';
  private readonly SYNC_LOCK_KEY = 'catalog:sync:lock';
  private readonly SYNC_LOCK_TTL = 3600; // 1 hora

  constructor() {
    this.trinksService = new CatalogTrinksService();
    this.initRedis();
  }

  private async initRedis() {
    this.redis = await getRedis();
  }

  /**
   * Normaliza nome do serviço conforme especificação
   */
  private normalizeServiceName(name: string): string {
    if (!name) return '';

    let normalized = name
      .toLowerCase()
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Remove acentos
      .replace(/\s+/g, ' ') // Colapsa espaços
      .replace(/[\/\-_•]/g, ' ') // Remove símbolos
      .trim();

    // Mapeamento de sinônimos
    const synonymMap: Record<string, string> = {
      'progressiva': 'escova progressiva',
      'luzes': 'mechas/luzes',
      'pé e mão': 'mão e pé',
      'pe e mao': 'mão e pé'
    };

    // Aplica mapeamento de sinônimos
    for (const [synonym, canonical] of Object.entries(synonymMap)) {
      if (normalized.includes(synonym)) {
        normalized = normalized.replace(synonym, canonical);
      }
    }

    return normalized;
  }

  /**
   * Normaliza dados do serviço
   */
  private normalizeServiceData(service: TrinksServiceData): NormalizedServiceData {
    return {
      ...service,
      nomeservico_normalizado: this.normalizeServiceName(service.nomeservico),
      categoria_normalizada: this.normalizeServiceName(service.categoria)
    };
  }

  /**
   * Busca serviços do Trinks de forma incremental
   */
  async fetchServicesIncremental(updatedSinceIso: string, page: number = 1): Promise<{
    rows: TrinksServiceData[];
    hasMore: boolean;
    nextPage: number;
  }> {
    try {
      logger.info(`Fetching Trinks services since ${updatedSinceIso}, page ${page}`);

      // Busca serviços via API Trinks
      const response = await this.trinksService.getServices({
        updated_since: updatedSinceIso,
        page,
        limit: 100
      });

      const services: TrinksServiceData[] = response.data.map((item: TrinksApiService) => ({
        profissionalid: item.professional_id,
        servicoid: item.service_id,
        nomeservico: item.service_name,
        categoria: item.category,
        preco: item.price,
        duracao: item.duration,
        updated_at: item.updated_at,
        ativo: item.active
      }));

      return {
        rows: services,
        hasMore: response.has_more,
        nextPage: page + 1
      };
    } catch (error) {
      logger.error('Error fetching services from Trinks:', error);
      throw error;
    }
  }

  /**
   * Faz upsert dos serviços na base local
   */
  async upsertServicesProf(rows: NormalizedServiceData[]): Promise<void> {
    if (!rows.length) return;

    try {
      logger.info(`Upserting ${rows.length} services to local database`);

      const query = `
        INSERT INTO servicos_prof (
          profissionalid, servicoid, nomeservico, categoria,
          nomeservico_normalizado, categoria_normalizada,
          preco, duracao, updated_at, ativo
        ) VALUES ${rows.map((_, i) => `($${i * 10 + 1}, $${i * 10 + 2}, $${i * 10 + 3}, $${i * 10 + 4}, $${i * 10 + 5}, $${i * 10 + 6}, $${i * 10 + 7}, $${i * 10 + 8}, $${i * 10 + 9}, $${i * 10 + 10})`).join(', ')}
        ON CONFLICT (profissionalid, servicoid)
        DO UPDATE SET
          nomeservico = EXCLUDED.nomeservico,
          categoria = EXCLUDED.categoria,
          nomeservico_normalizado = EXCLUDED.nomeservico_normalizado,
          categoria_normalizada = EXCLUDED.categoria_normalizada,
          preco = EXCLUDED.preco,
          duracao = EXCLUDED.duracao,
          updated_at = EXCLUDED.updated_at,
          ativo = EXCLUDED.ativo,
          sync_timestamp = NOW()
      `;

      const values = rows.flatMap(row => [
        row.profissionalid,
        row.servicoid,
        row.nomeservico,
        row.categoria,
        row.nomeservico_normalizado,
        row.categoria_normalizada,
        row.preco,
        row.duracao,
        row.updated_at,
        row.ativo
      ]);

      await db.query(query, values);
      logger.info(`Successfully upserted ${rows.length} services`);
    } catch (error) {
      logger.error('Error upserting services:', error);
      throw error;
    }
  }

  /**
   * Salva watermark da sincronização
   */
  async saveWatermark(updatedSinceIso: string, lastSeenIso: string): Promise<void> {
    try {
      const watermark: SyncWatermark = {
        updated_since_iso: updatedSinceIso,
        last_seen_iso: lastSeenIso,
        sync_timestamp: new Date().toISOString()
      };

      await this.redis.set(this.WATERMARK_KEY, JSON.stringify(watermark));
      
      // Também salva no banco para persistência
      await db.query(`
        INSERT INTO sync_watermarks (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `, [this.WATERMARK_KEY, JSON.stringify(watermark)]);

      logger.info(`Watermark saved: ${lastSeenIso}`);
    } catch (error) {
      logger.error('Error saving watermark:', error);
      throw error;
    }
  }

  /**
   * Obtém watermark da última sincronização
   */
  async getWatermark(): Promise<SyncWatermark | null> {
    try {
      // Tenta Redis primeiro
      const redisValue = await this.redis.get(this.WATERMARK_KEY);
      if (redisValue) {
        return JSON.parse(redisValue);
      }

      // Fallback para banco
      const result = await db.query(
        'SELECT value FROM sync_watermarks WHERE key = $1',
        [this.WATERMARK_KEY]
      );

      if (result.rows.length > 0) {
        const watermark = JSON.parse(result.rows[0].value);
        // Restaura no Redis
        await this.redis.set(this.WATERMARK_KEY, JSON.stringify(watermark));
        return watermark;
      }

      return null;
    } catch (error) {
      logger.error('Error getting watermark:', error);
      return null;
    }
  }

  /**
   * Executa sincronização completa
   */
  async triggerFullSync(updatedSinceIso?: string): Promise<{ ok: boolean; watermark: string }> {
    const lockAcquired = await this.acquireSyncLock();
    if (!lockAcquired) {
      throw new Error('Sync already in progress');
    }

    try {
      // Determina ponto de partida
      const startTime = updatedSinceIso || 
        process.env.CATALOG_WATERMARK || 
        (await this.getWatermark())?.last_seen_iso || 
        '1970-01-01T00:00:00Z';

      logger.info(`Starting full sync from ${startTime}`);

      let page = 1;
      let lastSeenIso = startTime;
      let totalProcessed = 0;

      while (true) {
        // Busca página de serviços
        const result = await this.fetchServicesIncremental(startTime, page);
        
        if (!result.rows.length) break;

        // Normaliza dados
        const normalizedRows = result.rows.map(row => this.normalizeServiceData(row));

        // Faz upsert
        await this.upsertServicesProf(normalizedRows);

        // Atualiza último timestamp visto
        const maxUpdatedAt = Math.max(...result.rows.map(r => new Date(r.updated_at).getTime()));
        lastSeenIso = new Date(maxUpdatedAt).toISOString();

        totalProcessed += result.rows.length;
        logger.info(`Processed page ${page}, ${result.rows.length} services, total: ${totalProcessed}`);

        if (!result.hasMore) break;
        page = result.nextPage;
      }

      // Salva watermark final
      await this.saveWatermark(startTime, lastSeenIso);

      logger.info(`Full sync completed. Processed ${totalProcessed} services`);
      return { ok: true, watermark: lastSeenIso };
    } finally {
      await this.releaseSyncLock();
    }
  }

  /**
   * Computa relatório de diferenças diárias
   */
  async computeDailyDiffReport(asOfDate: string): Promise<DiffReport> {
    try {
      logger.info(`Computing diff report for ${asOfDate}`);

      // Conta totais
      const [trinksCount, localCount] = await Promise.all([
        this.trinksService.getServicesCount(),
        db.query('SELECT COUNT(*) as count FROM servicos_prof WHERE ativo = true')
      ]);

      const totalTrinks = trinksCount;
      const totalLocal = parseInt(localCount.rows[0].count);

      // Busca serviços que estão no Trinks mas não no local
      const missingQuery = `
        SELECT t.profissionalid, t.servicoid, t.nomeservico, t.categoria
        FROM trinks_services_snapshot t
        LEFT JOIN servicos_prof l ON t.profissionalid = l.profissionalid AND t.servicoid = l.servicoid
        WHERE l.servicoid IS NULL
        AND t.snapshot_date = $1
      `;
      const missingResult = await db.query(missingQuery, [asOfDate]);

      // Busca serviços que estão no local mas não no Trinks (fantasmas)
      const phantomsQuery = `
        SELECT l.profissionalid, l.servicoid, l.nomeservico, l.categoria
        FROM servicos_prof l
        LEFT JOIN trinks_services_snapshot t ON l.profissionalid = t.profissionalid AND l.servicoid = t.servicoid
        WHERE t.servicoid IS NULL
        AND l.ativo = true
        AND t.snapshot_date = $1
      `;
      const phantomsResult = await db.query(phantomsQuery, [asOfDate]);

      // Busca duplicatas (mesmo serviço normalizado para múltiplos IDs)
      const duplicatesQuery = `
        SELECT nomeservico_normalizado, categoria_normalizada, COUNT(*) as count,
               ARRAY_AGG(DISTINCT profissionalid || '-' || servicoid) as service_ids
        FROM servicos_prof
        WHERE ativo = true
        GROUP BY nomeservico_normalizado, categoria_normalizada
        HAVING COUNT(*) > 1
      `;
      const duplicatesResult = await db.query(duplicatesQuery);

      return {
        as_of_date: asOfDate,
        total_trinks: totalTrinks,
        total_local: totalLocal,
        missing_in_local: missingResult.rows.length,
        extra_in_local: phantomsResult.rows.length,
        duplicates: duplicatesResult.rows.length,
        phantoms: phantomsResult.rows,
        duplicates_detail: duplicatesResult.rows
      };
    } catch (error) {
      logger.error('Error computing diff report:', error);
      throw error;
    }
  }

  /**
   * Busca top-N serviços por categoria nos últimos 30 dias
   */
  async getTopNByCategory30d(categoriaNorm: string, n: number = 3): Promise<any[]> {
    try {
      const query = `
        SELECT sp.profissionalid, sp.servicoid, sp.nomeservico, sp.categoria,
               COUNT(a.id) as agendamentos_30d
        FROM servicos_prof sp
        LEFT JOIN agendamentos a ON sp.servicoid = a.service_id
          AND a.created_at >= NOW() - INTERVAL '30 days'
          AND a.status IN ('confirmed', 'completed')
        WHERE sp.categoria_normalizada = $1
          AND sp.ativo = true
        GROUP BY sp.profissionalid, sp.servicoid, sp.nomeservico, sp.categoria
        ORDER BY agendamentos_30d DESC, sp.nomeservico
        LIMIT $2
      `;

      const result = await db.query(query, [categoriaNorm, n]);
      return result.rows;
    } catch (error) {
      logger.error('Error getting top services by category:', error);
      throw error;
    }
  }

  /**
   * Busca textual por termo normalizado
   */
  async searchLike(termNorm: string, n: number = 3): Promise<any[]> {
    try {
      const query = `
        SELECT sp.profissionalid, sp.servicoid, sp.nomeservico, sp.categoria,
               COUNT(a.id) as agendamentos_30d,
               SIMILARITY(sp.nomeservico_normalizado, $1) as similarity
        FROM servicos_prof sp
        LEFT JOIN agendamentos a ON sp.servicoid = a.service_id
          AND a.created_at >= NOW() - INTERVAL '30 days'
          AND a.status IN ('confirmed', 'completed')
        WHERE sp.nomeservico_normalizado ILIKE '%' || $1 || '%'
          AND sp.ativo = true
        GROUP BY sp.profissionalid, sp.servicoid, sp.nomeservico, sp.categoria, sp.nomeservico_normalizado
        ORDER BY similarity DESC, agendamentos_30d DESC, sp.nomeservico
        LIMIT $2
      `;

      const result = await db.query(query, [termNorm, n]);
      return result.rows;
    } catch (error) {
      logger.error('Error searching services:', error);
      throw error;
    }
  }

  /**
   * Adquire lock para sincronização
   */
  private async acquireSyncLock(): Promise<boolean> {
    try {
      const result = await this.redis.set(
        this.SYNC_LOCK_KEY,
        Date.now().toString(),
        'EX',
        this.SYNC_LOCK_TTL,
        'NX'
      );
      return result === 'OK';
    } catch (error) {
      logger.error('Error acquiring sync lock:', error);
      return false;
    }
  }

  /**
   * Libera lock de sincronização
   */
  private async releaseSyncLock(): Promise<void> {
    try {
      await this.redis.del(this.SYNC_LOCK_KEY);
    } catch (error) {
      logger.error('Error releasing sync lock:', error);
    }
  }
}

export default CatalogSyncService;