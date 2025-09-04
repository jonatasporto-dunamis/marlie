import { Pool } from 'pg';

export interface CatalogService {
  id: string;
  tenant_id: string;
  nome: string;
  categoria: string;
  duracao: number;
  preco: string;
  ativo: boolean;
}

export interface CatalogSearchResult {
  services: CatalogService[];
  total: number;
}

export class CatalogService {
  constructor(private db: Pool) {}

  /**
   * Busca os top-N serviços mais relevantes para um termo/categoria
   */
  async searchTopServices(
    query: string,
    tenantId: string,
    limit: number = 3
  ): Promise<CatalogService[]> {
    try {
      const searchTerm = `%${query.toLowerCase()}%`;
      
      const result = await this.db.query(
        `
        SELECT 
          id, tenant_id, nome, categoria, duracao, preco, ativo
        FROM catalog_services 
        WHERE 
          tenant_id = $1 
          AND ativo = true
          AND (
            LOWER(nome) LIKE $2 
            OR LOWER(categoria) LIKE $2
            OR LOWER(descricao) LIKE $2
          )
        ORDER BY 
          CASE 
            WHEN LOWER(nome) = LOWER($3) THEN 1
            WHEN LOWER(nome) LIKE $2 THEN 2
            WHEN LOWER(categoria) = LOWER($3) THEN 3
            WHEN LOWER(categoria) LIKE $2 THEN 4
            ELSE 5
          END,
          nome ASC
        LIMIT $4
        `,
        [tenantId, searchTerm, query.toLowerCase(), limit]
      );

      return result.rows;
    } catch (error) {
      console.error('Erro ao buscar serviços no catálogo:', error);
      return [];
    }
  }

  /**
   * Busca um serviço específico por ID
   */
  async getServiceById(
    serviceId: string,
    tenantId: string
  ): Promise<CatalogService | null> {
    try {
      const result = await this.db.query(
        `
        SELECT 
          id, tenant_id, nome, categoria, duracao, preco, ativo
        FROM catalog_services 
        WHERE id = $1 AND tenant_id = $2 AND ativo = true
        `,
        [serviceId, tenantId]
      );

      return result.rows[0] || null;
    } catch (error) {
      console.error('Erro ao buscar serviço por ID:', error);
      return null;
    }
  }

  /**
   * Lista todas as categorias disponíveis
   */
  async getCategories(tenantId: string): Promise<string[]> {
    try {
      const result = await this.db.query(
        `
        SELECT DISTINCT categoria
        FROM catalog_services 
        WHERE tenant_id = $1 AND ativo = true
        ORDER BY categoria ASC
        `,
        [tenantId]
      );

      return result.rows.map(row => row.categoria);
    } catch (error) {
      console.error('Erro ao buscar categorias:', error);
      return [];
    }
  }

  /**
   * Verifica se um termo é muito genérico (categoria vs serviço específico)
   */
  async isGenericCategory(
    query: string,
    tenantId: string
  ): Promise<boolean> {
    try {
      const categories = await this.getCategories(tenantId);
      const queryLower = query.toLowerCase();
      
      // Se o termo corresponde exatamente a uma categoria
      const isExactCategory = categories.some(
        cat => cat.toLowerCase() === queryLower
      );
      
      if (isExactCategory) {
        // Verifica quantos serviços existem nesta categoria
        const result = await this.db.query(
          `
          SELECT COUNT(*) as count
          FROM catalog_services 
          WHERE 
            tenant_id = $1 
            AND ativo = true
            AND LOWER(categoria) = $2
          `,
          [tenantId, queryLower]
        );
        
        const serviceCount = parseInt(result.rows[0].count);
        
        // Se há mais de 1 serviço na categoria, é genérico
        return serviceCount > 1;
      }
      
      return false;
    } catch (error) {
      console.error('Erro ao verificar se categoria é genérica:', error);
      return false;
    }
  }
}

/**
 * Factory function para criar instância do CatalogService
 */
export function getCatalogService(db: Pool): CatalogService {
  return new CatalogService(db);
}