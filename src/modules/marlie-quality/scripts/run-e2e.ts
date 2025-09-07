#!/usr/bin/env ts-node

import { Pool } from 'pg';
import Redis from 'ioredis';
import { MarlieQualityModule } from '../index';
import { loadConfig } from '../../../config/loader';
import { logger } from '../../../utils/logger';

/**
 * Script para executar testes E2E
 * Uso: npm run e2e:run [-- --scenario=basic_flow --environment=staging]
 */

async function main() {
  try {
    // Parse argumentos da linha de comando
    const args = process.argv.slice(2);
    const scenarioArg = args.find(arg => arg.startsWith('--scenario='));
    const environmentArg = args.find(arg => arg.startsWith('--environment='));
    const timeoutArg = args.find(arg => arg.startsWith('--timeout='));
    
    const scenario = scenarioArg ? scenarioArg.split('=')[1] : 'basic_flow';
    const environment = environmentArg ? environmentArg.split('=')[1] : 'staging';
    const timeout = timeoutArg ? parseInt(timeoutArg.split('=')[1]) : 30000;

    logger.info('🧪 Iniciando execução de testes E2E...', {
      scenario,
      environment,
      timeout
    });

    // Carregar configuração
    const config = await loadConfig('marlie-quality');
    
    // Conectar ao banco e Redis
    const pgPool = new Pool({
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      user: config.database.username,
      password: config.database.password,
      ssl: config.database.ssl
    });

    const redis = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      db: config.redis.db || 0
    });

    // Inicializar módulo
    const qualityModule = new MarlieQualityModule(pgPool, redis, config);
    await qualityModule.initialize();

    // Executar teste E2E
    logger.info('🚀 Iniciando execução do cenário E2E...');
    const result = await qualityModule.runE2ETests({
      scenario,
      environment,
      timeout
    });

    console.log('\n📋 Resultado da execução:');
    console.log(`   🆔 ID da Execução: ${result.executionId}`);
    console.log(`   📝 Cenário: ${result.scenario}`);
    console.log(`   🌍 Ambiente: ${result.environment}`);
    console.log(`   📊 Status: ${result.status}`);
    console.log(`   🕐 Iniciado em: ${result.startedAt}`);

    if (result.status === 'running') {
      logger.info('⏳ Aguardando conclusão do teste...');
      
      // Monitorar progresso
      let attempts = 0;
      const maxAttempts = Math.ceil(timeout / 5000); // Check a cada 5 segundos
      
      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        attempts++;
        
        const status = await qualityModule.getE2ETestStatus(result.executionId);
        
        console.log(`\n📊 Status atual (${attempts}/${maxAttempts}):`);
        console.log(`   🔄 Status: ${status.status}`);
        
        if (status.steps && status.steps.length > 0) {
          console.log('   📝 Passos:');
          status.steps.forEach((step: any, index: number) => {
            const icon = step.status === 'passed' ? '✅' : 
                        step.status === 'failed' ? '❌' : 
                        step.status === 'running' ? '🔄' : '⏸️';
            console.log(`      ${icon} ${index + 1}. ${step.name} (${step.status})`);
            if (step.duration) {
              console.log(`         ⏱️ Duração: ${step.duration}ms`);
            }
            if (step.error) {
              console.log(`         ❌ Erro: ${step.error}`);
            }
          });
        }
        
        if (status.status === 'completed' || status.status === 'failed') {
          console.log('\n🏁 Teste concluído!');
          
          if (status.result) {
            console.log(`   🎯 Resultado: ${status.result}`);
          }
          
          if (status.metrics) {
            console.log('   📊 Métricas:');
            console.log(`      ⏱️ Tempo total: ${status.metrics.totalDuration}ms`);
            console.log(`      ✅ Passos bem-sucedidos: ${status.metrics.passedSteps}`);
            console.log(`      ❌ Passos falharam: ${status.metrics.failedSteps}`);
            console.log(`      📈 Taxa de sucesso: ${status.metrics.successRate}%`);
          }
          
          if (status.status === 'completed' && status.result === 'success') {
            logger.info('🎉 Teste E2E executado com sucesso!');
          } else {
            logger.error('💥 Teste E2E falhou:', status.error || 'Erro desconhecido');
            process.exit(1);
          }
          
          break;
        }
      }
      
      if (attempts >= maxAttempts) {
        logger.error('⏰ Timeout: Teste E2E não concluído no tempo esperado');
        process.exit(1);
      }
    }

    // Finalizar conexões
    await qualityModule.shutdown();
    await pgPool.end();
    await redis.disconnect();

    logger.info('✨ Processo concluído!');
    process.exit(0);

  } catch (error) {
    logger.error('💥 Erro fatal durante execução do teste E2E:', error);
    process.exit(1);
  }
}

// Executar apenas se chamado diretamente
if (require.main === module) {
  main().catch(error => {
    console.error('Erro não tratado:', error);
    process.exit(1);
  });
}

export { main as runE2ETests };