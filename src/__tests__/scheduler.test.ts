import { MessageScheduler } from '../services/scheduler';
import { OptOutService } from '../services/opt-out';
import { db } from '../db';
import { EvolutionAPI } from '../integrations/evolution';
import { MetricsHelper } from '../metrics';
import { jest } from '@jest/globals';

// Mock do Evolution API Client
jest.mock('../integrations/evolution');
const mockEvolutionClient = EvolutionAPI as jest.MockedClass<typeof EvolutionAPI>;

describe('Message Scheduler System', () => {
  let scheduler: MessageScheduler;
  let optOutService: OptOutService;
  const mockTenantId = 'test-tenant';
  const mockPhone = '5511999999999';
  const mockBookingId = 'booking-123';
  const mockAgendamentoId = 'agend-456';

  beforeEach(async () => {
    scheduler = new MessageScheduler();
    optOutService = new OptOutService(db as any, mockEvolutionClient as any);
    
    // Limpar dados de teste
    await (db as any).query('DELETE FROM message_jobs WHERE tenant_id = $1', [mockTenantId]);
    await (db as any).query('DELETE FROM user_opt_outs WHERE tenant_id = $1', [mockTenantId]);
    
    // Mock das métricas
    jest.spyOn(MetricsHelper, 'incrementPreVisitSent').mockImplementation(() => {});
    jest.spyOn(MetricsHelper, 'incrementNoShowCheckSent').mockImplementation(() => {});
    jest.spyOn(MetricsHelper, 'incrementNoShowPrevented').mockImplementation(() => {});
    jest.spyOn(MetricsHelper, 'incrementUserOptOut').mockImplementation(() => {});
    
    // Mock do Evolution API
    jest.spyOn(mockEvolutionClient.prototype, 'sendMessage').mockResolvedValue({ success: true } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Job Creation', () => {
    it('should create pre_visit job correctly', async () => {
      const scheduledFor = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h no futuro
      
      const jobId = await scheduler.schedulePreVisitReminder(
        mockTenantId,
        mockPhone,
        mockBookingId,
        mockAgendamentoId,
        scheduledFor,
        {
          cliente_nome: 'João Silva',
          servico_nome: 'Corte de Cabelo',
          profissional_nome: 'Maria',
          data_agendamento: '2024-01-15',
          horario: '14:00',
          local: 'Salão Central'
        }
      );
      
      expect(jobId).toBeDefined();
      
      // Verificar se foi criado no banco
      const result = await (db as any).query(
        'SELECT * FROM message_jobs WHERE id = $1',
        [jobId]
      );
      
      expect(result.rows).toHaveLength(1);
      const job = result.rows[0];
      expect(job.job_type).toBe('pre_visit');
      expect(job.tenant_id).toBe(mockTenantId);
      expect(job.phone_e164).toBe(mockPhone);
      expect(job.status).toBe('pending');
      expect(new Date(job.scheduled_for)).toEqual(scheduledFor);
    });

    it('should create no_show_check job correctly', async () => {
      const scheduledFor = new Date(Date.now() + 18 * 60 * 60 * 1000); // 18h no futuro
      
      const jobId = await scheduler.scheduleNoShowCheck(
        mockTenantId,
        mockPhone,
        mockBookingId,
        mockAgendamentoId,
        scheduledFor,
        {
          cliente_nome: 'João Silva',
          servico_nome: 'Corte de Cabelo',
          data_agendamento: '2024-01-15',
          horario: '14:00'
        }
      );
      
      expect(jobId).toBeDefined();
      
      // Verificar se foi criado no banco
      const result = await (db as any).query(
        'SELECT * FROM message_jobs WHERE id = $1',
        [jobId]
      );
      
      expect(result.rows).toHaveLength(1);
      const job = result.rows[0];
      expect(job.job_type).toBe('no_show_check');
      expect(job.tenant_id).toBe(mockTenantId);
      expect(job.phone_e164).toBe(mockPhone);
      expect(job.status).toBe('pending');
    });

    it('should not create duplicate jobs for same booking', async () => {
      const scheduledFor = new Date(Date.now() + 24 * 60 * 60 * 1000);
      
      // Criar primeiro job
      const jobId1 = await scheduler.schedulePreVisitReminder(
        mockTenantId,
        mockPhone,
        mockBookingId,
        mockAgendamentoId,
        scheduledFor,
        {
          cliente_nome: 'João Silva',
          servico_nome: 'Corte de Cabelo',
          profissional_nome: 'Maria',
          data_agendamento: '2024-01-15',
          horario: '14:00',
          local: 'Salão Central'
        }
      );
      
      // Tentar criar segundo job para mesmo booking
      const jobId2 = await scheduler.schedulePreVisitReminder(
        mockTenantId,
        mockPhone,
        mockBookingId,
        mockAgendamentoId,
        scheduledFor,
        {
          cliente_nome: 'João Silva',
          servico_nome: 'Corte de Cabelo',
          profissional_nome: 'Maria',
          data_agendamento: '2024-01-15',
          horario: '14:00',
          local: 'Salão Central'
        }
      );
      
      // Deve retornar o mesmo ID ou null
      expect(jobId2).toBeNull();
      
      // Verificar que só existe um job
      const result = await (db as any).query(
        'SELECT * FROM message_jobs WHERE booking_id = $1 AND job_type = $2',
        [mockBookingId, 'pre_visit']
      );
      
      expect(result.rows).toHaveLength(1);
    });
  });

  describe('Job Execution', () => {
    it('should execute pre_visit job successfully', async () => {
      // Criar job
      const scheduledFor = new Date(Date.now() - 1000); // 1 segundo no passado
      const jobId = await scheduler.schedulePreVisitReminder(
        mockTenantId,
        mockPhone,
        mockBookingId,
        mockAgendamentoId,
        scheduledFor,
        {
          cliente_nome: 'João Silva',
          servico_nome: 'Corte de Cabelo',
          profissional_nome: 'Maria',
          data_agendamento: '2024-01-15',
          horario: '14:00',
          local: 'Salão Central'
        }
      );
      
      // Executar jobs pendentes
      const processedCount = await scheduler.processPendingJobs();
      expect(processedCount).toBe(1);
      
      // Verificar se job foi marcado como completed
      const result = await (db as any).query(
        'SELECT * FROM message_jobs WHERE id = $1',
        [jobId]
      );
      
      expect(result.rows[0].status).toBe('completed');
      expect(result.rows[0].executed_at).toBeDefined();
      
      // Verificar se mensagem foi enviada
      expect(mockEvolutionClient.prototype.sendMessage).toHaveBeenCalledTimes(1);
      
      // Verificar se métrica foi incrementada
      expect(MetricsHelper.incrementPreVisitSent).toHaveBeenCalledWith(mockTenantId);
    });

    it('should execute no_show_check job successfully', async () => {
      // Criar job
      const scheduledFor = new Date(Date.now() - 1000);
      const jobId = await scheduler.scheduleNoShowCheck(
        mockTenantId,
        mockPhone,
        mockBookingId,
        mockAgendamentoId,
        scheduledFor,
        {
          cliente_nome: 'João Silva',
          servico_nome: 'Corte de Cabelo',
          data_agendamento: '2024-01-15',
          horario: '14:00'
        }
      );
      
      // Executar jobs pendentes
      const processedCount = await scheduler.processPendingJobs();
      expect(processedCount).toBe(1);
      
      // Verificar se job foi marcado como completed
      const result = await (db as any).query(
        'SELECT * FROM message_jobs WHERE id = $1',
        [jobId]
      );
      
      expect(result.rows[0].status).toBe('completed');
      
      // Verificar se mensagem foi enviada
      expect(mockEvolutionClient.prototype.sendMessage).toHaveBeenCalledTimes(1);
      
      // Verificar se métrica foi incrementada
      expect(MetricsHelper.incrementNoShowCheckSent).toHaveBeenCalledWith(mockTenantId);
    });

    it('should process multiple jobs in batch', async () => {
      const scheduledFor = new Date(Date.now() - 1000);
      
      // Criar múltiplos jobs
      const jobIds = [];
      for (let i = 0; i < 5; i++) {
        const jobId = await scheduler.schedulePreVisitReminder(
          mockTenantId,
          `551199999999${i}`,
          `booking-${i}`,
          `agend-${i}`,
          scheduledFor,
          {
            cliente_nome: `Cliente ${i}`,
            servico_nome: 'Corte de Cabelo',
            profissional_nome: 'Maria',
            data_agendamento: '2024-01-15',
            horario: '14:00',
            local: 'Salão Central'
          }
        );
        jobIds.push(jobId);
      }
      
      // Executar jobs pendentes
      const processedCount = await scheduler.processPendingJobs();
      expect(processedCount).toBe(5);
      
      // Verificar se todos foram processados
      const result = await (db as any).query(
        'SELECT * FROM message_jobs WHERE id = ANY($1)',
        [jobIds]
      );
      
      expect(result.rows).toHaveLength(5);
      result.rows.forEach((job: any) => {
        expect(job.status).toBe('completed');
      });
    });
  });

  describe('Retry Logic', () => {
    it('should retry failed jobs up to max attempts', async () => {
      // Mock falha na API
      jest.spyOn(mockEvolutionClient.prototype, 'sendMessage').mockRejectedValue(new Error('API Error') as any);
      
      // Criar job
      const scheduledFor = new Date(Date.now() - 1000);
      const jobId = await scheduler.schedulePreVisitReminder(
        mockTenantId,
        mockPhone,
        mockBookingId,
        mockAgendamentoId,
        scheduledFor,
        {
          cliente_nome: 'João Silva',
          servico_nome: 'Corte de Cabelo',
          profissional_nome: 'Maria',
          data_agendamento: '2024-01-15',
          horario: '14:00',
          local: 'Salão Central'
        }
      );
      
      // Executar jobs (deve falhar)
      await scheduler.processPendingJobs();
      
      // Verificar se job foi marcado como failed e retry_count incrementado
      const result = await (db as any).query(
        'SELECT * FROM message_jobs WHERE id = $1',
        [jobId]
      );
      
      expect(result.rows[0].status).toBe('failed');
      expect(result.rows[0].retry_count).toBe(1);
      expect(result.rows[0].last_error).toContain('API Error');
    });

    it('should mark job as permanently failed after max retries', async () => {
      // Mock falha na API
      jest.spyOn(mockEvolutionClient.prototype, 'sendMessage').mockRejectedValue(new Error('Persistent Error') as any);
      
      // Criar job e simular múltiplas tentativas
      const scheduledFor = new Date(Date.now() - 1000);
      const jobId = await scheduler.schedulePreVisitReminder(
        mockTenantId,
        mockPhone,
        mockBookingId,
        mockAgendamentoId,
        scheduledFor,
        {
          cliente_nome: 'João Silva',
          servico_nome: 'Corte de Cabelo',
          profissional_nome: 'Maria',
          data_agendamento: '2024-01-15',
          horario: '14:00',
          local: 'Salão Central'
        }
      );
      
      // Simular 3 tentativas (max retries)
      for (let i = 0; i < 3; i++) {
        await scheduler.processPendingJobs();
      }
      
      // Verificar se job foi marcado como permanently failed
      const result = await (db as any).query(
        'SELECT * FROM message_jobs WHERE id = $1',
        [jobId]
      );
      
      expect(result.rows[0].status).toBe('permanently_failed');
      expect(result.rows[0].retry_count).toBe(3);
    });

    it('should succeed on retry after initial failure', async () => {
      // Mock falha na primeira tentativa, sucesso na segunda
      jest.spyOn(mockEvolutionClient.prototype, 'sendMessage')
          .mockRejectedValueOnce(new Error('Temporary Error') as any)
          .mockResolvedValueOnce({ success: true } as any);
      
      // Criar job
      const scheduledFor = new Date(Date.now() - 1000);
      const jobId = await scheduler.schedulePreVisitReminder(
        mockTenantId,
        mockPhone,
        mockBookingId,
        mockAgendamentoId,
        scheduledFor,
        {
          cliente_nome: 'João Silva',
          servico_nome: 'Corte de Cabelo',
          profissional_nome: 'Maria',
          data_agendamento: '2024-01-15',
          horario: '14:00',
          local: 'Salão Central'
        }
      );
      
      // Primeira tentativa (falha)
      await scheduler.processPendingJobs();
      
      // Segunda tentativa (sucesso)
      await scheduler.processPendingJobs();
      
      // Verificar se job foi marcado como completed
      const result = await (db as any).query(
        'SELECT * FROM message_jobs WHERE id = $1',
        [jobId]
      );
      
      expect(result.rows[0].status).toBe('completed');
      expect(result.rows[0].retry_count).toBe(1);
    });
  });

  describe('Opt-out Respect', () => {
    it('should not send message to opted-out user', async () => {
      // Registrar opt-out
      await optOutService.registerOptOut(mockTenantId, mockPhone, 'all');
      
      // Criar job
      const scheduledFor = new Date(Date.now() - 1000);
      const jobId = await scheduler.schedulePreVisitReminder(
        mockTenantId,
        mockPhone,
        mockBookingId,
        mockAgendamentoId,
        scheduledFor,
        {
          cliente_nome: 'João Silva',
          servico_nome: 'Corte de Cabelo',
          profissional_nome: 'Maria',
          data_agendamento: '2024-01-15',
          horario: '14:00',
          local: 'Salão Central'
        }
      );
      
      // Executar jobs
      const processedCount = await scheduler.processPendingJobs();
      expect(processedCount).toBe(1);
      
      // Verificar se job foi marcado como skipped
      const result = await (db as any).query(
        'SELECT * FROM message_jobs WHERE id = $1',
        [jobId]
      );
      
      expect(result.rows[0].status).toBe('skipped');
      expect(result.rows[0].last_error).toContain('opted out');
      
      // Verificar que mensagem NÃO foi enviada
      expect(mockEvolutionClient.prototype.sendMessage).not.toHaveBeenCalled();
    });

    it('should respect specific opt-out types', async () => {
      // Registrar opt-out apenas para pre_visit
      await optOutService.registerOptOut(mockTenantId, mockPhone, 'pre_visit');
      
      // Criar job pre_visit
      const scheduledFor = new Date(Date.now() - 1000);
      const preVisitJobId = await scheduler.schedulePreVisitReminder(
        mockTenantId,
        mockPhone,
        mockBookingId,
        mockAgendamentoId,
        scheduledFor,
        {
          cliente_nome: 'João Silva',
          servico_nome: 'Corte de Cabelo',
          profissional_nome: 'Maria',
          data_agendamento: '2024-01-15',
          horario: '14:00',
          local: 'Salão Central'
        }
      );
      
      // Criar job no_show_check
      const noShowJobId = await scheduler.scheduleNoShowCheck(
        mockTenantId,
        mockPhone,
        `${mockBookingId}-2`,
        `${mockAgendamentoId}-2`,
        scheduledFor,
        {
          cliente_nome: 'João Silva',
          servico_nome: 'Corte de Cabelo',
          data_agendamento: '2024-01-15',
          horario: '14:00'
        }
      );
      
      // Executar jobs
      await scheduler.processPendingJobs();
      
      // Verificar resultados
      const preVisitResult = await (db as any).query(
        'SELECT * FROM message_jobs WHERE id = $1',
        [preVisitJobId]
      );
      
      const noShowResult = await (db as any).query(
        'SELECT * FROM message_jobs WHERE id = $1',
        [noShowJobId]
      );
      
      // Pre-visit deve ser skipped
      expect(preVisitResult.rows[0].status).toBe('skipped');
      
      // No-show deve ser completed
      expect(noShowResult.rows[0].status).toBe('completed');
      
      // Apenas uma mensagem deve ter sido enviada
      expect(mockEvolutionClient.prototype.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('Performance and Batch Processing', () => {
    it('should respect batch size limit', async () => {
      const batchSize = 3;
      const scheduledFor = new Date(Date.now() - 1000);
      
      // Criar mais jobs que o batch size
      for (let i = 0; i < 5; i++) {
        await scheduler.schedulePreVisitReminder(
          mockTenantId,
          `551199999999${i}`,
          `booking-${i}`,
          `agend-${i}`,
          scheduledFor,
          {
            cliente_nome: `Cliente ${i}`,
            servico_nome: 'Corte de Cabelo',
            profissional_nome: 'Maria',
            data_agendamento: '2024-01-15',
            horario: '14:00',
            local: 'Salão Central'
          }
        );
      }
      
      // Executar com batch size limitado
      const processedCount = await scheduler.processPendingJobs(batchSize);
      expect(processedCount).toBe(batchSize);
      
      // Verificar que apenas batch size jobs foram processados
      const completedResult = await (db as any).query(
        'SELECT COUNT(*) FROM message_jobs WHERE status = $1',
        ['completed']
      );
      
      expect(parseInt(completedResult.rows[0].count)).toBe(batchSize);
    });

    it('should process jobs within reasonable time', async () => {
      const jobCount = 10;
      const scheduledFor = new Date(Date.now() - 1000);
      
      // Criar múltiplos jobs
      for (let i = 0; i < jobCount; i++) {
        await scheduler.schedulePreVisitReminder(
          mockTenantId,
          `551199999999${i}`,
          `booking-${i}`,
          `agend-${i}`,
          scheduledFor,
          {
            cliente_nome: `Cliente ${i}`,
            servico_nome: 'Corte de Cabelo',
            profissional_nome: 'Maria',
            data_agendamento: '2024-01-15',
            horario: '14:00',
            local: 'Salão Central'
          }
        );
      }
      
      // Medir tempo de processamento
      const startTime = Date.now();
      const processedCount = await scheduler.processPendingJobs();
      const endTime = Date.now();
      
      const processingTime = endTime - startTime;
      const timePerJob = processingTime / processedCount;
      
      expect(processedCount).toBe(jobCount);
      expect(timePerJob).toBeLessThan(1000); // Menos de 1 segundo por job
    });
  });
});