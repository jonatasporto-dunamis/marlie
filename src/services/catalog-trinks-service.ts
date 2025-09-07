import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { logger } from '../utils/logger';

/**
 * Interface para parâmetros de busca de serviços
 */
export interface GetServicesParams {
  updated_since?: string;
  page?: number;
  limit?: number;
  professional_id?: number;
  category?: string;
  active_only?: boolean;
}

/**
 * Interface para resposta da API Trinks
 */
export interface TrinksApiResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
  has_more: boolean;
}

/**
 * Interface para dados de serviço da API Trinks
 */
export interface TrinksApiService {
  professional_id: number;
  service_id: number;
  service_name: string;
  category: string;
  price?: number;
  duration?: number;
  updated_at: string;
  created_at: string;
  active: boolean;
  description?: string;
}

/**
 * Interface para dados de profissional da API Trinks
 */
export interface TrinksApiProfessional {
  professional_id: number;
  name: string;
  email: string;
  phone: string;
  active: boolean;
  updated_at: string;
  created_at: string;
}

/**
 * Serviço para integração com API Trinks - Catálogo
 */
export class CatalogTrinksService {
  private client: AxiosInstance;
  private readonly baseURL: string;
  private readonly apiToken: string;
  private readonly timeout: number;

  constructor() {
    this.baseURL = process.env.TRINKS_CATALOG_API_URL || process.env.TRINKS_API_URL || 'https://api.trinks.com.br';
    this.apiToken = process.env.TRINKS_CATALOG_API_TOKEN || process.env.TRINKS_API_TOKEN || '';
    this.timeout = parseInt(process.env.TRINKS_API_TIMEOUT || '30000');

    if (!this.apiToken) {
      throw new Error('TRINKS_CATALOG_API_TOKEN or TRINKS_API_TOKEN environment variable is required');
    }

    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: this.timeout,
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Marlie-Bot-Catalog/1.0'
      }
    });

    // Interceptor para logs
    this.client.interceptors.request.use(
      (config) => {
        logger.debug(`Trinks Catalog API Request: ${config.method?.toUpperCase()} ${config.url}`, {
          params: config.params,
          headers: { ...config.headers, Authorization: '[REDACTED]' }
        });
        return config;
      },
      (error) => {
        logger.error('Trinks Catalog API Request Error:', error);
        return Promise.reject(error);
      }
    );

    this.client.interceptors.response.use(
      (response) => {
        logger.debug(`Trinks Catalog API Response: ${response.status} ${response.config.url}`, {
          data_length: Array.isArray(response.data?.data) ? response.data.data.length : 'N/A'
        });
        return response;
      },
      (error) => {
        logger.error('Trinks Catalog API Response Error:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          url: error.config?.url,
          message: error.message
        });
        return Promise.reject(error);
      }
    );
  }

  /**
   * Busca serviços da API Trinks para sincronização
   */
  async getServices(params: GetServicesParams = {}): Promise<TrinksApiResponse<TrinksApiService>> {
    try {
      const queryParams: any = {
        page: params.page || 1,
        limit: params.limit || 100
      };

      if (params.updated_since) {
        queryParams.updated_since = params.updated_since;
      }

      if (params.professional_id) {
        queryParams.professional_id = params.professional_id;
      }

      if (params.category) {
        queryParams.category = params.category;
      }

      if (params.active_only !== undefined) {
        queryParams.active = params.active_only;
      }

      const response: AxiosResponse<TrinksApiResponse<TrinksApiService>> = await this.client.get(
        '/v1/catalog/services',
        { params: queryParams }
      );

      return response.data;
    } catch (error) {
      logger.error('Error fetching services from Trinks Catalog API:', error);
      throw this.handleApiError(error);
    }
  }

  /**
   * Busca um serviço específico por ID
   */
  async getService(serviceId: number): Promise<TrinksApiService> {
    try {
      const response: AxiosResponse<{ data: TrinksApiService }> = await this.client.get(
        `/v1/catalog/services/${serviceId}`
      );

      return response.data.data;
    } catch (error) {
      logger.error(`Error fetching service ${serviceId} from Trinks Catalog API:`, error);
      throw this.handleApiError(error);
    }
  }

  /**
   * Busca profissionais da API Trinks
   */
  async getProfessionals(params: {
    page?: number;
    limit?: number;
    updated_since?: string;
    active_only?: boolean;
  } = {}): Promise<TrinksApiResponse<TrinksApiProfessional>> {
    try {
      const queryParams: any = {
        page: params.page || 1,
        limit: params.limit || 100
      };

      if (params.updated_since) {
        queryParams.updated_since = params.updated_since;
      }

      if (params.active_only !== undefined) {
        queryParams.active = params.active_only;
      }

      const response: AxiosResponse<TrinksApiResponse<TrinksApiProfessional>> = await this.client.get(
        '/v1/catalog/professionals',
        { params: queryParams }
      );

      return response.data;
    } catch (error) {
      logger.error('Error fetching professionals from Trinks Catalog API:', error);
      throw this.handleApiError(error);
    }
  }

  /**
   * Busca contagem total de serviços
   */
  async getServicesCount(): Promise<number> {
    try {
      const response = await this.getServices({ page: 1, limit: 1 });
      return response.pagination.total;
    } catch (error) {
      logger.error('Error fetching services count from Trinks Catalog API:', error);
      throw this.handleApiError(error);
    }
  }

  /**
   * Verifica se a API está disponível
   */
  async healthCheck(): Promise<{ status: string; timestamp: string }> {
    try {
      const response: AxiosResponse<{ status: string; timestamp: string }> = await this.client.get(
        '/v1/health'
      );

      return response.data;
    } catch (error) {
      logger.error('Trinks Catalog API health check failed:', error);
      throw this.handleApiError(error);
    }
  }

  /**
   * Busca serviços por categoria
   */
  async getServicesByCategory(category: string, params: {
    page?: number;
    limit?: number;
    active_only?: boolean;
  } = {}): Promise<TrinksApiResponse<TrinksApiService>> {
    return this.getServices({
      ...params,
      category
    });
  }

  /**
   * Busca serviços de um profissional específico
   */
  async getServicesByProfessional(professionalId: number, params: {
    page?: number;
    limit?: number;
    active_only?: boolean;
  } = {}): Promise<TrinksApiResponse<TrinksApiService>> {
    return this.getServices({
      ...params,
      professional_id: professionalId
    });
  }

  /**
   * Busca snapshot de serviços para uma data específica
   */
  async getServicesSnapshot(date: string): Promise<TrinksApiService[]> {
    try {
      const response: AxiosResponse<{ data: TrinksApiService[] }> = await this.client.get(
        `/v1/catalog/snapshots/${date}/services`
      );

      return response.data.data;
    } catch (error) {
      logger.error(`Error fetching services snapshot for ${date}:`, error);
      throw this.handleApiError(error);
    }
  }

  /**
   * Trata erros da API
   */
  private handleApiError(error: any): Error {
    if (error.response) {
      // Erro de resposta HTTP
      const status = error.response.status;
      const message = error.response.data?.message || error.response.statusText;
      
      switch (status) {
        case 401:
          return new Error(`Trinks Catalog API: Unauthorized - ${message}`);
        case 403:
          return new Error(`Trinks Catalog API: Forbidden - ${message}`);
        case 404:
          return new Error(`Trinks Catalog API: Not Found - ${message}`);
        case 429:
          return new Error(`Trinks Catalog API: Rate Limit Exceeded - ${message}`);
        case 500:
          return new Error(`Trinks Catalog API: Internal Server Error - ${message}`);
        default:
          return new Error(`Trinks Catalog API Error (${status}): ${message}`);
      }
    } else if (error.request) {
      // Erro de rede
      return new Error(`Trinks Catalog API: Network Error - ${error.message}`);
    } else {
      // Erro de configuração
      return new Error(`Trinks Catalog API: Configuration Error - ${error.message}`);
    }
  }

  /**
   * Obtém estatísticas da API
   */
  async getApiStats(): Promise<{
    services_count: number;
    professionals_count: number;
    last_updated: string;
    api_status: string;
  }> {
    try {
      const [servicesCount, healthStatus] = await Promise.all([
        this.getServicesCount(),
        this.healthCheck()
      ]);

      return {
        services_count: servicesCount,
        professionals_count: 0, // Não implementado ainda
        last_updated: new Date().toISOString(),
        api_status: healthStatus.status
      };
    } catch (error) {
      logger.error('Error fetching Catalog API stats:', error);
      throw error;
    }
  }
}

export default CatalogTrinksService;