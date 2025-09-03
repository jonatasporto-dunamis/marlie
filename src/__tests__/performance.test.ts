import { MessageScheduler } from '../services/scheduler';
import { db } from '../db';
import { EvolutionAPI } from '../integrations/evolution';
import { jest } from '@jest/globals';
import { performance } from 'perf_hooks';

// Mock do Evolution API Client
jest.mock('../integrations/evolution');
const mockEvolutionClient = EvolutionAPI as jest.MockedClass<typeof EvolutionAPI>;

describe('Performance Tests', () => {
  let scheduler: MessageScheduler;
  const mockTenantId = 'perf-test-tenant';
  
  // Configurações de performance (podem ser ajustadas via ENV)
  const TARGET_JOBS_PER_MINUTE = parseInt(process.env.PERF_TARGET_JOBS_PER_MINUTE || '60');
  const MAX_LATENCY_MS = parseInt(process.env.PERF_MAX_LATENCY_MS || '100');
  const BATCH_SIZE = parseInt(process.env.WORKER_BATCH_SIZE || '50');
  const CONCURRENT_CONVERSATIONS = parseInt(process.env.PERF_CONCURRENT_CONVERSATIONS || '10');

  beforeEach(async () => {
    scheduler = new MessageScheduler();
    
    // Limpar dados de teste
    await (db as any).query('DELETE FROM message_jobs WHERE tenant_id = $1', [mockTenantId]);
    
    // Mock rápido da API (simular resposta em 10ms)
    (mockEvolutionClient.prototype.sendMessage as jest.Mock) = jest.fn().mockImplementation(() => {
      return new Promise<boolean>(resolve => {
        setTimeout(() => resolve(true), 10);
      });
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Worker Throughput', () => {
    it(`should process at least ${TARGET_JOBS_PER_MINUTE} jobs per minute`, async () => {
      const jobCount = Math.min(TARGET_JOBS_PER_MINUTE, 100); // Limitar para testes
      const scheduledFor = new Date(Date.now() - 1000);
      
      // Criar jobs em lote
      const jobCreationStart = performance.now();
      const jobIds = [];
      
      for (let i = 0; i < jobCount; i++) {
        const jobId = await scheduler.schedulePreVisitReminder(
          mockTenantId,
          `5511999999${String(i).padStart(3, '0')}`,
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
      
      const jobCreationEnd = performance.now();
      const creationTime = jobCreationEnd - jobCreationStart;
      
      console.log(`Created ${jobCount} jobs in ${creationTime.toFixed(2)}ms`);
      
      // Processar jobs e medir tempo
      const processingStart = performance.now();
      const processedCount = await scheduler.processPendingJobs(BATCH_SIZE);
      const processingEnd = performance.now();
      
      const processingTime = processingEnd - processingStart;
      const jobsPerSecond = (processedCount / processingTime) * 1000;
      const jobsPerMinute = jobsPerSecond * 60;
      
      console.log(`Processed ${processedCount} jobs in ${processingTime.toFixed(2)}ms`);
      console.log(`Throughput: ${jobsPerMinute.toFixed(2)} jobs/minute`);
      
      expect(processedCount).toBe(Math.min(jobCount, BATCH_SIZE));
      expect(jobsPerMinute).toBeGreaterThanOrEqual(TARGET_JOBS_PER_MINUTE);
      
      // Verificar que jobs foram processados corretamente
      const completedJobs = await (db as any).query(
        'SELECT COUNT(*) FROM message_jobs WHERE tenant_id = $1 AND status = $2',
        [mockTenantId, 'completed']
      );
      
      expect(parseInt(completedJobs.rows[0].count)).toBe(processedCount);
    }, 30000);

    it('should maintain throughput with multiple batches', async () => {
      const totalJobs = TARGET_JOBS_PER_MINUTE;
      const batchSize = Math.min(BATCH_SIZE, 25);
      const expectedBatches = Math.ceil(totalJobs / batchSize);
      
      const scheduledFor = new Date(Date.now() - 1000);
      
      // Criar jobs
      for (let i = 0; i < totalJobs; i++) {
        await scheduler.schedulePreVisitReminder(
          mockTenantId,
          `5511999999${String(i).padStart(3, '0')}`,
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
      
      // Processar em múltiplos batches
      const batchTimes = [];
      let totalProcessed = 0;
      
      const overallStart = performance.now();
      
      while (totalProcessed < totalJobs) {
        const batchStart = performance.now();
        const processed = await scheduler.processPendingJobs(batchSize);
        const batchEnd = performance.now();
        
        if (processed === 0) break; // Não há mais jobs
        
        const batchTime = batchEnd - batchStart;
        batchTimes.push(batchTime);
        totalProcessed += processed;
        
        console.log(`Batch processed ${processed} jobs in ${batchTime.toFixed(2)}ms`);
      }
      
      const overallEnd = performance.now();
      const totalTime = overallEnd - overallStart;
      
      // Calcular estatísticas
      const avgBatchTime = batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length;
      const jobsPerMinute = (totalProcessed / totalTime) * 60 * 1000;
      
      console.log(`Total: ${totalProcessed} jobs in ${totalTime.toFixed(2)}ms`);
      console.log(`Average batch time: ${avgBatchTime.toFixed(2)}ms`);
      console.log(`Overall throughput: ${jobsPerMinute.toFixed(2)} jobs/minute`);
      
      expect(totalProcessed).toBe(totalJobs);
      expect(jobsPerMinute).toBeGreaterThanOrEqual(TARGET_JOBS_PER_MINUTE * 0.8); // 80% do target
      expect(avgBatchTime).toBeLessThan(5000); // Menos de 5 segundos por batch
    }, 60000);
  });

  describe('Conversation Latency Impact', () => {
    it('should not degrade conversation latency during job processing', async () => {
      // Simular processamento de jobs em background
      const jobCount = 50;
      const scheduledFor = new Date(Date.now() - 1000);
      
      // Criar jobs
      for (let i = 0; i < jobCount; i++) {
        await scheduler.schedulePreVisitReminder(
          mockTenantId,
          `5511999999${String(i).padStart(3, '0')}`,
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
      
      // Simular conversas simultâneas durante processamento
      const conversationLatencies = [];
      
      // Iniciar processamento de jobs em background
      const jobProcessingPromise = scheduler.processPendingJobs();
      
      // Simular operações de conversa
      for (let i = 0; i < CONCURRENT_CONVERSATIONS; i++) {
        const conversationStart = performance.now();
        
        // Simular operações típicas de conversa
        await simulateConversationOperations();
        
        const conversationEnd = performance.now();
        const latency = conversationEnd - conversationStart;
        conversationLatencies.push(latency);
      }
      
      // Aguardar conclusão do processamento
      await jobProcessingPromise;
      
      // Analisar latências
      const avgLatency = conversationLatencies.reduce((a, b) => a + b, 0) / conversationLatencies.length;
      const maxLatency = Math.max(...conversationLatencies);
      const p95Latency = conversationLatencies.sort((a, b) => a - b)[Math.floor(conversationLatencies.length * 0.95)];
      
      console.log(`Conversation latencies during job processing:`);
      console.log(`Average: ${avgLatency.toFixed(2)}ms`);
      console.log(`Max: ${maxLatency.toFixed(2)}ms`);
      console.log(`P95: ${p95Latency.toFixed(2)}ms`);
      
      expect(avgLatency).toBeLessThan(MAX_LATENCY_MS);
      expect(p95Latency).toBeLessThan(MAX_LATENCY_MS * 2);
      expect(maxLatency).toBeLessThan(MAX_LATENCY_MS * 3);
    }, 30000);

    it('should handle concurrent job processing and conversations', async () => {
      const jobCount = 30;
      const conversationCount = 10;
      
      // Criar jobs
      const scheduledFor = new Date(Date.now() - 1000);
      for (let i = 0; i < jobCount; i++) {
        await scheduler.schedulePreVisitReminder(
          mockTenantId,
          `5511999999${String(i).padStart(3, '0')}`,
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
      
      // Executar jobs e conversas simultaneamente
      const startTime = performance.now();
      
      const [jobResults, conversationResults] = await Promise.all([
        // Processamento de jobs
        scheduler.processPendingJobs(),
        
        // Conversas simultâneas
        Promise.all(Array(conversationCount).fill(0).map(async (_, i) => {
          const conversationStart = performance.now();
          await simulateConversationOperations();
          const conversationEnd = performance.now();
          return {
            id: i,
            latency: conversationEnd - conversationStart
          };
        }))
      ]);
      
      const endTime = performance.now();
      const totalTime = endTime - startTime;
      
      // Analisar resultados
      const processedJobs = jobResults;
      const avgConversationLatency = conversationResults.reduce((sum, conv) => sum + conv.latency, 0) / conversationResults.length;
      
      console.log(`Concurrent execution completed in ${totalTime.toFixed(2)}ms`);
      console.log(`Jobs processed: ${processedJobs}`);
      console.log(`Average conversation latency: ${avgConversationLatency.toFixed(2)}ms`);
      
      expect(processedJobs).toBeGreaterThan(0);
      expect(avgConversationLatency).toBeLessThan(MAX_LATENCY_MS);
      expect(totalTime).toBeLessThan(10000); // Menos de 10 segundos total
    }, 30000);
  });

  describe('Resource Usage', () => {
    it('should not cause memory leaks during intensive processing', async () => {
      const initialMemory = process.memoryUsage();
      
      // Processar muitos jobs em sequência
      for (let batch = 0; batch < 5; batch++) {
        const jobCount = 20;
        const scheduledFor = new Date(Date.now() - 1000);
        
        // Criar jobs
        for (let i = 0; i < jobCount; i++) {
          await scheduler.schedulePreVisitReminder(
            mockTenantId,
            `5511999999${String(batch * jobCount + i).padStart(3, '0')}`,
            `booking-${batch}-${i}`,
            `agend-${batch}-${i}`,
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
        
        // Processar jobs
        await scheduler.processPendingJobs();
        
        // Forçar garbage collection se disponível
        if (global.gc) {
          global.gc();
        }
      }
      
      const finalMemory = process.memoryUsage();
      const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;
      const memoryIncreaseMB = memoryIncrease / 1024 / 1024;
      
      console.log(`Memory usage:`);
      console.log(`Initial: ${(initialMemory.heapUsed / 1024 / 1024).toFixed(2)}MB`);
      console.log(`Final: ${(finalMemory.heapUsed / 1024 / 1024).toFixed(2)}MB`);
      console.log(`Increase: ${memoryIncreaseMB.toFixed(2)}MB`);
      
      // Permitir algum aumento de memória, mas não excessivo
      expect(memoryIncreaseMB).toBeLessThan(50); // Menos de 50MB de aumento
    }, 60000);

    it('should handle database connection efficiently', async () => {
      const connectionStart = performance.now();
      
      // Fazer múltiplas operações de banco
      const operations = [];
      for (let i = 0; i < 20; i++) {
        operations.push(
          (db as any).query('SELECT COUNT(*) FROM message_jobs WHERE tenant_id = $1', [mockTenantId])
        );
      }
      
      const results = await Promise.all(operations);
      const connectionEnd = performance.now();
      
      const totalTime = connectionEnd - connectionStart;
      const avgTimePerQuery = totalTime / operations.length;
      
      console.log(`Database operations:`);
      console.log(`Total time: ${totalTime.toFixed(2)}ms`);
      console.log(`Average per query: ${avgTimePerQuery.toFixed(2)}ms`);
      
      expect(results).toHaveLength(20);
      expect(avgTimePerQuery).toBeLessThan(50); // Menos de 50ms por query
      expect(totalTime).toBeLessThan(1000); // Menos de 1 segundo total
    });
  });

  describe('Error Recovery Performance', () => {
    it('should handle API failures without significant performance degradation', async () => {
      // Mock falhas intermitentes na API
      let callCount = 0;
      (mockEvolutionClient.prototype.sendMessage as jest.Mock) = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount % 3 === 0) {
          return Promise.reject(new Error('API temporarily unavailable'));
        }
        return new Promise<boolean>(resolve => {
          setTimeout(() => resolve(true), 10);
        });
      });
      
      const jobCount = 30;
      const scheduledFor = new Date(Date.now() - 1000);
      
      // Criar jobs
      for (let i = 0; i < jobCount; i++) {
        await scheduler.schedulePreVisitReminder(
          mockTenantId,
          `5511999999${String(i).padStart(3, '0')}`,
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
      
      // Processar com falhas
      const processingStart = performance.now();
      const processedCount = await scheduler.processPendingJobs();
      const processingEnd = performance.now();
      
      const processingTime = processingEnd - processingStart;
      
      // Verificar resultados
      const completedJobs = await (db as any).query(
        'SELECT COUNT(*) FROM message_jobs WHERE tenant_id = $1 AND status = $2',
        [mockTenantId, 'completed']
      );
      
      const failedJobs = await (db as any).query(
        'SELECT COUNT(*) FROM message_jobs WHERE tenant_id = $1 AND status = $2',
        [mockTenantId, 'failed']
      );
      
      const completedCount = parseInt(completedJobs.rows[0].count);
      const failedCount = parseInt(failedJobs.rows[0].count);
      
      console.log(`Error recovery performance:`);
      console.log(`Processing time: ${processingTime.toFixed(2)}ms`);
      console.log(`Completed: ${completedCount}, Failed: ${failedCount}`);
      
      expect(processedCount).toBe(jobCount);
      expect(completedCount).toBeGreaterThan(0);
      expect(failedCount).toBeGreaterThan(0);
      expect(processingTime).toBeLessThan(15000); // Menos de 15 segundos mesmo com falhas
    }, 30000);
  });
});

// Função auxiliar para simular operações de conversa
async function simulateConversationOperations(): Promise<void> {
  // Simular operações típicas de uma conversa
  const operations = [
    // Consulta ao banco
    (db as any).query('SELECT 1'),
    
    // Processamento de texto (simular)
    new Promise(resolve => setTimeout(resolve, Math.random() * 10)),
    
    // Outra consulta
    (db as any).query('SELECT COUNT(*) FROM message_jobs LIMIT 1'),
    
    // Mais processamento
    new Promise(resolve => setTimeout(resolve, Math.random() * 5))
  ];
  
  await Promise.all(operations);
}