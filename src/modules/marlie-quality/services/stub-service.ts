import { logger } from '../../../utils/logger';
import { MarlieQualityConfig } from '../types';

// Tipos para os stubs
interface TrinksAppointment {
  id: number;
  status: { id: number; nome: string };
  cliente: { id: number; nome: string; telefone: string };
  servico: { id: string; nome: string };
  profissional: { id: number; nome: string };
  dataHoraInicio: string;
}

interface TrinksAvailabilityResponse {
  ok: boolean;
  message?: string;
}

interface EvolutionMessageResponse {
  status: 'SENT' | 'QUEUED';
  id: string;
}

// Dados simulados para testes
const MOCK_APPOINTMENTS: TrinksAppointment[] = [
  {
    id: 12345,
    status: { id: 1, nome: 'Confirmado' },
    cliente: { id: 101, nome: 'João Silva', telefone: '5573999887065' },
    servico: { id: 'SVC-001', nome: 'Corte de Cabelo' },
    profissional: { id: 201, nome: 'Maria Santos' },
    dataHoraInicio: '2024-01-15T14:00:00'
  },
  {
    id: 12346,
    status: { id: 1, nome: 'Confirmado' },
    cliente: { id: 102, nome: 'Ana Costa', telefone: '5573999887066' },
    servico: { id: 'SVC-002', nome: 'Manicure' },
    profissional: { id: 202, nome: 'Carla Lima' },
    dataHoraInicio: '2024-01-15T15:30:00'
  },
  {
    id: 12347,
    status: { id: 2, nome: 'Pendente' },
    cliente: { id: 103, nome: 'Pedro Oliveira', telefone: '5573999887067' },
    servico: { id: 'SVC-003', nome: 'Massagem' },
    profissional: { id: 203, nome: 'José Ferreira' },
    dataHoraInicio: '2024-01-15T16:00:00'
  }
];

const MOCK_SERVICES = [
  { id: 'SVC-001', nome: 'Corte de Cabelo', categoria: 'cabelo' },
  { id: 'SVC-002', nome: 'Manicure', categoria: 'unhas' },
  { id: 'SVC-003', nome: 'Massagem', categoria: 'bem-estar' },
  { id: 'SVC-UNAVAILABLE', nome: 'Serviço Indisponível', categoria: 'teste' }
];

export class StubService {
  private config: MarlieQualityConfig;
  private isEnabled: boolean;
  private failureFlags: Map<string, boolean> = new Map();
  private delayFlags: Map<string, number> = new Map();

  constructor(config: MarlieQualityConfig) {
    this.config = config;
    this.isEnabled = process.env.USE_TRINKS_STUBS === 'true';
    
    logger.info(`StubService inicializado - Stubs ${this.isEnabled ? 'ATIVADOS' : 'DESATIVADOS'}`);
  }

  // ==================== TRINKS STUBS ====================

  async stubFetchAppointments(params: {
    dataInicio: string;
    dataFim: string;
  }): Promise<{ items: TrinksAppointment[] }> {
    await this.simulateDelay('trinks.fetch_appointments');
    
    if (this.shouldFail('trinks.fetch_appointments')) {
      throw new Error('Stub: Falha simulada na busca de appointments');
    }

    logger.info('TrinksStub: Simulando fetch de appointments', params);
    
    // Filtra appointments por data (simulação simples)
    const startDate = new Date(params.dataInicio);
    const endDate = new Date(params.dataFim);
    
    const filteredAppointments = MOCK_APPOINTMENTS.filter(apt => {
      const aptDate = new Date(apt.dataHoraInicio);
      return aptDate >= startDate && aptDate <= endDate;
    });

    return {
      items: filteredAppointments
    };
  }

  async stubValidateAvailability(params: {
    service_id: string;
    start_iso: string;
  }): Promise<TrinksAvailabilityResponse> {
    await this.simulateDelay('trinks.validate_availability');
    
    if (this.shouldFail('trinks.validate_availability')) {
      throw new Error('Stub: Falha simulada na validação de disponibilidade');
    }

    logger.info('TrinksStub: Simulando validação de disponibilidade', params);
    
    // Simula diferentes cenários baseado no service_id
    if (params.service_id === 'SVC-UNAVAILABLE') {
      return {
        ok: false,
        message: 'Horário não disponível para este serviço'
      };
    }
    
    if (params.service_id === 'SVC-CONFLICT') {
      return {
        ok: false,
        message: 'Conflito de horário detectado'
      };
    }
    
    // Simula indisponibilidade em horários específicos
    const requestTime = new Date(params.start_iso);
    const hour = requestTime.getHours();
    
    if (hour < 8 || hour > 18) {
      return {
        ok: false,
        message: 'Horário fora do funcionamento'
      };
    }
    
    return {
      ok: true,
      message: 'Horário disponível'
    };
  }

  async stubCreateAppointment(params: {
    service_id: string;
    client_id: string;
    professional_id: string;
    start_iso: string;
  }): Promise<TrinksAppointment> {
    await this.simulateDelay('trinks.create_appointment');
    
    if (this.shouldFail('trinks.create_appointment')) {
      throw new Error('Stub: Falha simulada na criação de appointment');
    }

    logger.info('TrinksStub: Simulando criação de appointment', params);
    
    const service = MOCK_SERVICES.find(s => s.id === params.service_id);
    
    return {
      id: Math.floor(Math.random() * 100000) + 50000,
      status: { id: 1, nome: 'Confirmado' },
      cliente: {
        id: parseInt(params.client_id),
        nome: 'Cliente Teste',
        telefone: '5573999887065'
      },
      servico: {
        id: params.service_id,
        nome: service?.nome || 'Serviço Desconhecido'
      },
      profissional: {
        id: parseInt(params.professional_id),
        nome: 'Profissional Teste'
      },
      dataHoraInicio: params.start_iso
    };
  }

  // ==================== EVOLUTION STUBS ====================

  async stubSendMessage(params: {
    phone: string;
    text: string;
    media_url?: string;
  }): Promise<EvolutionMessageResponse> {
    await this.simulateDelay('evolution.send_message');
    
    if (this.shouldFail('evolution.send_message')) {
      throw new Error('Stub: Falha simulada no envio de mensagem');
    }

    logger.info('EvolutionStub: Simulando envio de mensagem', {
      phone: params.phone,
      textLength: params.text.length,
      hasMedia: !!params.media_url
    });
    
    // Simula diferentes cenários baseado no telefone
    if (params.phone.includes('9999')) {
      return {
        status: 'QUEUED',
        id: `msg_queued_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      };
    }
    
    return {
      status: 'SENT',
      id: `msg_sent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    };
  }

  async stubGetMessageStatus(messageId: string): Promise<{
    id: string;
    status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
    timestamp: string;
  }> {
    await this.simulateDelay('evolution.get_status');
    
    if (this.shouldFail('evolution.get_status')) {
      throw new Error('Stub: Falha simulada na consulta de status');
    }

    logger.info('EvolutionStub: Simulando consulta de status', { messageId });
    
    // Simula diferentes status baseado no ID
    let status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' = 'DELIVERED';
    
    if (messageId.includes('failed')) {
      status = 'FAILED';
    } else if (messageId.includes('read')) {
      status = 'READ';
    } else if (messageId.includes('sent')) {
      status = 'SENT';
    }
    
    return {
      id: messageId,
      status,
      timestamp: new Date().toISOString()
    };
  }

  // ==================== CONTROLE DE FALHAS ====================

  setFailureFlag(operation: string, shouldFail: boolean): void {
    this.failureFlags.set(operation, shouldFail);
    logger.info(`Stub failure flag definida: ${operation} = ${shouldFail}`);
  }

  setDelayFlag(operation: string, delayMs: number): void {
    this.delayFlags.set(operation, delayMs);
    logger.info(`Stub delay flag definida: ${operation} = ${delayMs}ms`);
  }

  clearAllFlags(): void {
    this.failureFlags.clear();
    this.delayFlags.clear();
    logger.info('Todas as flags de stub foram limpas');
  }

  private shouldFail(operation: string): boolean {
    return this.failureFlags.get(operation) || false;
  }

  private async simulateDelay(operation: string): Promise<void> {
    const delay = this.delayFlags.get(operation);
    if (delay && delay > 0) {
      logger.debug(`Simulando delay de ${delay}ms para ${operation}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // ==================== UTILITÁRIOS ====================

  isStubMode(): boolean {
    return this.isEnabled;
  }

  getAvailableOperations(): string[] {
    return [
      'trinks.fetch_appointments',
      'trinks.validate_availability',
      'trinks.create_appointment',
      'evolution.send_message',
      'evolution.get_status'
    ];
  }

  getStubStats(): {
    enabled: boolean;
    activeFailures: string[];
    activeDelays: { operation: string; delay: number }[];
  } {
    return {
      enabled: this.isEnabled,
      activeFailures: Array.from(this.failureFlags.entries())
        .filter(([, shouldFail]) => shouldFail)
        .map(([operation]) => operation),
      activeDelays: Array.from(this.delayFlags.entries())
        .filter(([, delay]) => delay > 0)
        .map(([operation, delay]) => ({ operation, delay }))
    };
  }

  // ==================== HELPERS PARA TESTES ====================

  generateTestData(type: 'appointment' | 'service' | 'client'): any {
    switch (type) {
      case 'appointment':
        return {
          id: Math.floor(Math.random() * 100000),
          service_id: 'SVC-001',
          client_id: '101',
          professional_id: '201',
          start_iso: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() // +2h
        };
        
      case 'service':
        return MOCK_SERVICES[Math.floor(Math.random() * MOCK_SERVICES.length)];
        
      case 'client':
        return {
          id: Math.floor(Math.random() * 1000) + 100,
          nome: `Cliente Teste ${Math.floor(Math.random() * 100)}`,
          telefone: `5573999${Math.floor(Math.random() * 900000) + 100000}`
        };
        
      default:
        throw new Error(`Tipo de dados não suportado: ${type}`);
    }
  }

  async cleanup(): Promise<void> {
    this.clearAllFlags();
    logger.info('StubService: Limpeza concluída');
  }
}