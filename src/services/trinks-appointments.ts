import { logger } from '../utils/logger';
import { configService } from './config';
import axios, { AxiosInstance } from 'axios';

/**
 * Interface para agendamento da API Trinks
 */
export interface TrinksAppointment {
  id: string;
  clienteId: string;
  profissionalId: string;
  servicoId: string;
  dataHoraInicio: string; // ISO string
  dataHoraFim: string;
  status: 'agendado' | 'confirmado' | 'cancelado' | 'realizado' | 'falta';
  cliente: {
    nome: string;
    telefone: string;
    email?: string;
  };
  servico: {
    nome: string;
    duracao: number;
  };
  profissional: {
    nome: string;
  };
}

/**
 * Interface para slot disponível
 */
export interface TrinksSlot {
  dataHoraInicio: string;
  dataHoraFim: string;
  profissionalId: string;
  servicoId: string;
  disponivel: boolean;
}

/**
 * Interface para resposta de busca de agendamentos
 */
export interface TrinksAppointmentsResponse {
  agendamentos: TrinksAppointment[];
  total: number;
  page: number;
  totalPages: number;
}

/**
 * Interface para resposta de busca de slots
 */
export interface TrinksSlotsResponse {
  slots: TrinksSlot[];
  total: number;
}

/**
 * Configuração de retry com backoff exponencial
 */
interface RetryConfig {
  attempts: number;
  backoffMsBase: number;
  backoffMsMax: number;
  jitter: boolean;
}

/**
 * Serviço para integração com API Trinks para agendamentos
 */
export class TrinksAppointmentsService {
  private client: AxiosInstance;
  private tenantId: string;
  private retryConfig: RetryConfig = {
    attempts: 3,
    backoffMsBase: 500,
    backoffMsMax: 5000,
    jitter: true
  };

  constructor(tenantId: string) {
    this.tenantId = tenantId;
    this.client = axios.create({
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SyncBelle-AutoMsg/1.0'
      }
    });

    this.setupInterceptors();
  }

  /**
   * Configura interceptors para autenticação e logging
   */
  private setupInterceptors(): void {
    // Request interceptor para adicionar autenticação
    this.client.interceptors.request.use(async (config) => {
      const baseUrlConfig = await configService.get(this.tenantId, 'trinks_base_url');
      const apiKeyConfig = await configService.get(this.tenantId, 'trinks_api_key');

      if (!baseUrlConfig?.value || !apiKeyConfig?.value) {
        throw new Error('Configuração Trinks não encontrada');
      }

      config.baseURL = baseUrlConfig.value;
      config.headers['Authorization'] = `Bearer ${apiKeyConfig.value}`;

      logger.info('Trinks API Request', {
        method: config.method,
        url: config.url,
        tenantId: this.tenantId
      });

      return config;
    });

    // Response interceptor para logging
    this.client.interceptors.response.use(
      (response) => {
        logger.info('Trinks API Response', {
          status: response.status,
          url: response.config.url,
          tenantId: this.tenantId
        });
        return response;
      },
      (error) => {
        logger.error('Trinks API Error', {
          status: error.response?.status,
          url: error.config?.url,
          message: error instanceof Error ? error.message : String(error),
          tenantId: this.tenantId
        });
        throw error;
      }
    );
  }

  /**
   * Executa operação com retry e backoff exponencial
   */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= this.retryConfig.attempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        
        if (attempt === this.retryConfig.attempts) {
          break;
        }

        // Calcula delay com backoff exponencial
        let delay = Math.min(
          this.retryConfig.backoffMsBase * Math.pow(2, attempt - 1),
          this.retryConfig.backoffMsMax
        );

        // Adiciona jitter se habilitado
        if (this.retryConfig.jitter) {
          delay += Math.random() * 1000;
        }

        logger.warn(`Tentativa ${attempt} falhou, tentando novamente em ${delay}ms`, {
          error: error instanceof Error ? error.message : String(error),
          tenantId: this.tenantId
        });

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * Lista agendamentos em janela de tempo
   */
  async fetchAppointments(
    dataInicio: string,
    dataFim: string,
    page: number = 1
  ): Promise<TrinksAppointmentsResponse> {
    return this.withRetry(async () => {
      const response = await this.client.get('/agendamentos', {
        params: {
          dataInicio,
          dataFim,
          page,
          limit: 50
        }
      });

      return response.data;
    });
  }

  /**
   * Obtém agendamento por ID
   */
  async getAppointment(id: string): Promise<TrinksAppointment> {
    return this.withRetry(async () => {
      const response = await this.client.get(`/agendamentos/${id}`);
      return response.data;
    });
  }

  /**
   * Busca próximos slots disponíveis
   */
  async searchSlots(
    serviceId: string,
    professionalId: string | null,
    dateFromIso: string,
    limit: number = 3
  ): Promise<TrinksSlotsResponse> {
    return this.withRetry(async () => {
      const params: any = {
        servicoId: serviceId,
        dataInicio: dateFromIso,
        limit
      };

      if (professionalId) {
        params.profissionalId = professionalId;
      }

      const response = await this.client.get('/slots-disponiveis', {
        params
      });

      return response.data;
    });
  }

  /**
   * Reagenda um agendamento
   */
  async rebookAppointment(
    appointmentId: string,
    newStartIso: string,
    serviceId: string,
    professionalId?: string
  ): Promise<TrinksAppointment> {
    return this.withRetry(async () => {
      const payload: any = {
        novaDataHoraInicio: newStartIso,
        servicoId: serviceId
      };

      if (professionalId) {
        payload.profissionalId = professionalId;
      }

      const response = await this.client.put(`/agendamentos/${appointmentId}/reagendar`, payload);
      return response.data;
    });
  }

  /**
   * Cancela um agendamento
   */
  async cancelAppointment(appointmentId: string, motivo?: string): Promise<void> {
    return this.withRetry(async () => {
      await this.client.put(`/agendamentos/${appointmentId}/cancelar`, {
        motivo: motivo || 'Cancelamento automático'
      });
    });
  }
}

/**
 * Factory function para criar instância do serviço
 */
export function createTrinksAppointmentsService(tenantId: string): TrinksAppointmentsService {
  return new TrinksAppointmentsService(tenantId);
}