import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';

export interface TrinksAvailabilityResult {
  available: boolean;
  confidence: 'explicit' | 'categorical' | 'ambiguous' | 'invalid';
  reason?: string;
  suggestedTimes?: string[];
}

export interface TrinksService {
  id: string;
  name: string;
  duration: number;
  price: string;
  category: string;
}

export interface TrinksProfessional {
  id: string;
  name: string;
  services: string[];
  available: boolean;
}

export class TrinksService {
  private client: AxiosInstance;
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 10000,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Marlie-Agent/1.0'
      }
    });

    // Configurar retry automático
    axiosRetry(this.client, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
               (error.response?.status === 429); // Rate limit
      }
    });
  }

  /**
   * Valida disponibilidade de um serviço antes de confirmar agendamento
   */
  async validateAvailability(
    serviceId: string,
    professionalId?: string,
    startIso?: string
  ): Promise<TrinksAvailabilityResult> {
    try {
      // Se não tem serviceId, é inválido
      if (!serviceId || serviceId.trim() === '') {
        return {
          available: false,
          confidence: 'invalid',
          reason: 'ID do serviço não fornecido'
        };
      }

      // Busca informações do serviço
      const service = await this.getServiceById(serviceId);
      if (!service) {
        return {
          available: false,
          confidence: 'invalid',
          reason: 'Serviço não encontrado'
        };
      }

      // Se não tem data/hora específica, é categórico
      if (!startIso) {
        return {
          available: true,
          confidence: 'categorical',
          reason: 'Serviço válido, mas precisa especificar data/hora'
        };
      }

      // Valida formato da data
      const requestedDate = new Date(startIso);
      if (isNaN(requestedDate.getTime())) {
        return {
          available: false,
          confidence: 'invalid',
          reason: 'Formato de data inválido'
        };
      }

      // Verifica se a data não é no passado
      const now = new Date();
      if (requestedDate < now) {
        return {
          available: false,
          confidence: 'invalid',
          reason: 'Data no passado'
        };
      }

      // Busca disponibilidade real via API
      const availability = await this.checkRealAvailability(
        serviceId,
        professionalId,
        startIso
      );

      return availability;
      
    } catch (error) {
      console.error('Erro ao validar disponibilidade:', error);
      return {
        available: false,
        confidence: 'invalid',
        reason: 'Erro interno na validação'
      };
    }
  }

  /**
   * Busca informações de um serviço específico
   */
  async getServiceById(serviceId: string): Promise<TrinksService | null> {
    try {
      const response = await this.client.get(`/services/${serviceId}`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      console.error('Erro ao buscar serviço:', error);
      return null;
    }
  }

  /**
   * Lista profissionais disponíveis para um serviço
   */
  async getProfessionalsForService(serviceId: string): Promise<TrinksProfessional[]> {
    try {
      const response = await this.client.get(`/services/${serviceId}/professionals`);
      return response.data || [];
    } catch (error) {
      console.error('Erro ao buscar profissionais:', error);
      return [];
    }
  }

  /**
   * Verifica disponibilidade real via API do Trinks
   */
  private async checkRealAvailability(
    serviceId: string,
    professionalId?: string,
    startIso?: string
  ): Promise<TrinksAvailabilityResult> {
    try {
      const params: any = {
        service_id: serviceId,
        date: startIso
      };

      if (professionalId) {
        params.professional_id = professionalId;
      }

      const response = await this.client.get('/availability', { params });
      const data = response.data;

      if (data.available) {
        return {
          available: true,
          confidence: 'explicit',
          reason: 'Horário disponível confirmado'
        };
      } else {
        return {
          available: false,
          confidence: 'explicit',
          reason: data.reason || 'Horário não disponível',
          suggestedTimes: data.suggested_times || []
        };
      }
      
    } catch (error) {
      console.error('Erro ao verificar disponibilidade real:', error);
      
      // Se a API está indisponível, assume disponível mas categórico
      return {
        available: true,
        confidence: 'categorical',
        reason: 'API temporariamente indisponível, validação manual necessária'
      };
    }
  }

  /**
   * Cria um agendamento no Trinks
   */
  async createAppointment(
    serviceId: string,
    professionalId: string,
    startIso: string,
    customerData: {
      name: string;
      phone: string;
      email?: string;
    }
  ): Promise<{ success: boolean; appointmentId?: string; error?: string }> {
    try {
      const response = await this.client.post('/appointments', {
        service_id: serviceId,
        professional_id: professionalId,
        start_time: startIso,
        customer: customerData
      });

      return {
        success: true,
        appointmentId: response.data.id
      };
      
    } catch (error) {
      console.error('Erro ao criar agendamento:', error);
      
      let errorMessage = 'Erro interno';
      if (axios.isAxiosError(error) && error.response) {
        errorMessage = error.response.data?.message || `Erro ${error.response.status}`;
      }
      
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Busca horários disponíveis para um serviço em uma data
   */
  async getAvailableSlots(
    serviceId: string,
    date: string,
    professionalId?: string
  ): Promise<string[]> {
    try {
      const params: any = {
        service_id: serviceId,
        date: date
      };

      if (professionalId) {
        params.professional_id = professionalId;
      }

      const response = await this.client.get('/available-slots', { params });
      return response.data.slots || [];
      
    } catch (error) {
      console.error('Erro ao buscar horários disponíveis:', error);
      return [];
    }
  }
}

/**
 * Factory function para criar instância do TrinksService
 */
export function getTrinksService(baseUrl: string, apiKey: string): TrinksService {
  return new TrinksService(baseUrl, apiKey);
}