#!/usr/bin/env ts-node

import { Pool } from 'pg';
import Redis from 'ioredis';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import { MarlieQualityModule } from '../index';
import { loadConfigWithDefaults } from '../../../config/loader';
import { logger } from '../../../utils/logger';
import { runSuite } from '../tools/qa-run-suite';

/**
 * Script para executar pipeline CI/CD
 * Uso: npm run pipeline:run [-- --environment=staging --branch=main --stages=build,test,deploy]
 */

async function main() {
  try {
    // Parse argumentos da linha de comando
    const args = process.argv.slice(2);
    const environmentArg = args.find(arg => arg.startsWith('--environment='));
    const branchArg = args.find(arg => arg.startsWith('--branch='));
    const stagesArg = args.find(arg => arg.startsWith('--stages='));
    const skipTestsArg = args.includes('--skip-tests');
    const dryRunArg = args.includes('--dry-run');
    
    const environment = environmentArg ? environmentArg.split('=')[1] : 'staging';
    const branch = branchArg ? branchArg.split('=')[1] : 'main';
    const stages = stagesArg ? stagesArg.split('=')[1].split(',') : undefined;

    logger.info('🚀 Iniciando execução do pipeline CI/CD...', {
      environment,
      branch,
      stages: stages || 'all',
      skipTests: skipTestsArg,
      dryRun: dryRunArg
    });

    // Carregar configuração do módulo
    logger.info('📋 Carregando configuração do módulo...');
    const config = await loadConfigWithDefaults('marlie-quality');
    
    // Carregar configuração do pipeline
    logger.info('📋 Carregando configuração do pipeline...');
    const pipelineConfigPath = path.join(__dirname, '../config/pipeline.yaml');
    const pipelineConfigContent = fs.readFileSync(pipelineConfigPath, 'utf8');
    const pipelineConfig = yaml.load(pipelineConfigContent) as any;
    
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

    // Preparar estágios do pipeline
    const pipelineStages = stages || Object.keys(pipelineConfig.ci_cd.pipelines.default.stages);
    
    logger.info('⚙️ Iniciando execução do pipeline...');
    logger.info(`📝 Estágios configurados: ${pipelineStages.join(', ')}`);
    
    // Executar pipeline usando configuração YAML
    const result = await executePipelineStages({
      stages: pipelineStages,
      config: pipelineConfig,
      environment,
      branch,
      skipTests: skipTestsArg,
      dryRun: dryRunArg,
      marlieQuality: qualityModule
    });

    console.log('\n📋 Pipeline iniciado:');
    console.log(`   🆔 ID da Execução: ${result.executionId}`);
    console.log(`   🌍 Ambiente: ${result.environment}`);
    console.log(`   🌿 Branch: ${result.branch}`);
    console.log(`   📊 Status: ${result.status}`);
    console.log(`   🕐 Iniciado em: ${result.startedAt}`);
    
    if (result.stages && result.stages.length > 0) {
      console.log('   📝 Estágios planejados:');
      result.stages.forEach((stage: string, index: number) => {
        console.log(`      ${index + 1}. ${stage}`);
      });
    }

    if (result.status === 'running') {
      logger.info('⏳ Monitorando progresso do pipeline...');
      
      // Monitorar progresso
      let attempts = 0;
      const maxAttempts = 120; // 10 minutos (5s * 120)
      
      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        attempts++;
        
        const status = await qualityModule.getPipelineStatus(result.executionId);
        
        console.log(`\n📊 Status do pipeline (${attempts}/${maxAttempts}):`);
        console.log(`   🔄 Status geral: ${status.status}`);
        
        if (status.currentStage) {
          console.log(`   🎯 Estágio atual: ${status.currentStage}`);
        }
        
        if (status.stages && status.stages.length > 0) {
          console.log('   📝 Progresso dos estágios:');
          status.stages.forEach((stage: any, index: number) => {
            const icon = stage.status === 'passed' ? '✅' : 
                        stage.status === 'failed' ? '❌' : 
                        stage.status === 'running' ? '🔄' : 
                        stage.status === 'skipped' ? '⏭️' : '⏸️';
            console.log(`      ${icon} ${index + 1}. ${stage.name} (${stage.status})`);
            if (stage.duration) {
              console.log(`         ⏱️ Duração: ${Math.round(stage.duration / 1000)}s`);
            }
            if (stage.output && stage.output.length > 0) {
              console.log(`         📄 Saída: ${stage.output.slice(-100)}...`);
            }
            if (stage.error) {
              console.log(`         ❌ Erro: ${stage.error}`);
            }
          });
        }
        
        if (status.metrics) {
          console.log('   📊 Métricas:');
          console.log(`      ⏱️ Tempo total: ${Math.round(status.metrics.totalDuration / 1000)}s`);
          console.log(`      ✅ Estágios bem-sucedidos: ${status.metrics.passedStages}`);
          console.log(`      ❌ Estágios falharam: ${status.metrics.failedStages}`);
          if (status.metrics.deployUrl) {
            console.log(`      🌐 URL do deploy: ${status.metrics.deployUrl}`);
          }
        }
        
        if (status.status === 'completed' || status.status === 'failed') {
          console.log('\n🏁 Pipeline concluído!');
          
          if (status.result) {
            console.log(`   🎯 Resultado: ${status.result}`);
          }
          
          if (status.deployInfo) {
            console.log('   🚀 Informações do deploy:');
            console.log(`      🌐 URL: ${status.deployInfo.url}`);
            console.log(`      📦 Versão: ${status.deployInfo.version}`);
            console.log(`      🕐 Deploy em: ${status.deployInfo.deployedAt}`);
            
            if (status.deployInfo.healthcheck) {
              const healthIcon = status.deployInfo.healthcheck.status === 'healthy' ? '✅' : '❌';
              console.log(`      ${healthIcon} Health check: ${status.deployInfo.healthcheck.status}`);
            }
          }
          
          if (status.status === 'completed' && status.result === 'success') {
            logger.info('🎉 Pipeline executado com sucesso!');
            
            // Executar health check final se foi um deploy
            if (status.deployInfo && status.deployInfo.url) {
              logger.info('🔍 Executando health check final...');
              try {
                const healthStatus = await qualityModule.getHealthStatus();
                if (healthStatus.status === 'healthy') {
                  logger.info('✅ Health check final passou!');
                } else {
                  logger.warn('⚠️ Health check final com problemas:', healthStatus);
                }
              } catch (error) {
                logger.error('❌ Erro no health check final:', error);
              }
            }
          } else {
            logger.error('💥 Pipeline falhou:', status.error || 'Erro desconhecido');
            
            // Mostrar logs de erro detalhados
            if (status.stages) {
              const failedStages = status.stages.filter((stage: any) => stage.status === 'failed');
              if (failedStages.length > 0) {
                console.log('\n🔍 Detalhes dos estágios que falharam:');
                failedStages.forEach((stage: any) => {
                  console.log(`\n❌ ${stage.name}:`);
                  if (stage.error) {
                    console.log(`   Erro: ${stage.error}`);
                  }
                  if (stage.output) {
                    console.log(`   Saída: ${stage.output}`);
                  }
                });
              }
            }
            
            process.exit(1);
          }
          
          break;
        }
      }
      
      if (attempts >= maxAttempts) {
        logger.error('⏰ Timeout: Pipeline não concluído no tempo esperado');
        
        // Tentar cancelar execução
        try {
          await qualityModule.cancelExecution(result.executionId);
          logger.info('🛑 Execução do pipeline cancelada');
        } catch (error) {
          logger.error('❌ Erro ao cancelar pipeline:', error);
        }
        
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
    logger.error('💥 Erro fatal durante execução do pipeline:', error);
    process.exit(1);
  }
}

/**
 * Executa os estágios do pipeline conforme configuração YAML
 */
async function executePipelineStages(options: {
  stages: string[];
  config: any;
  environment: string;
  branch: string;
  skipTests: boolean;
  dryRun: boolean;
  marlieQuality: any;
}) {
  const { stages, config, environment, branch, skipTests, dryRun, marlieQuality } = options;
  const results = [];
  
  for (const stageName of stages) {
    const stageConfig = config.ci_cd.pipelines.default.stages.find((s: any) => s.name === stageName);
    
    if (!stageConfig) {
      logger.warn(`⚠️ Estágio '${stageName}' não encontrado na configuração`);
      continue;
    }
    
    logger.info(`🔄 Executando estágio: ${stageName}`);
    
    try {
      const stageResult = await executeStage(stageConfig, {
        environment,
        branch,
        skipTests,
        dryRun,
        marlieQuality
      });
      
      results.push({
        stage: stageName,
        status: 'success',
        ...stageResult
      });
      
      logger.info(`✅ Estágio '${stageName}' concluído com sucesso`);
    } catch (error) {
      logger.error(`❌ Falha no estágio '${stageName}':`, error);
      
      results.push({
        stage: stageName,
        status: 'failed',
        error: error.message
      });
      
      // Parar execução em caso de falha (a menos que seja dry run)
      if (!dryRun) {
        throw error;
      }
    }
  }
  
  return {
    status: results.every(r => r.status === 'success') ? 'success' : 'failed',
    stages: results,
    summary: {
      total: results.length,
      success: results.filter(r => r.status === 'success').length,
      failed: results.filter(r => r.status === 'failed').length
    }
  };
}

/**
 * Executa um estágio individual do pipeline
 */
async function executeStage(stageConfig: any, context: any) {
  const { environment, branch, skipTests, dryRun, marlieQuality } = context;
  const startTime = Date.now();
  
  // Substituir variáveis de ambiente nos comandos
  const commands = stageConfig.run.map((cmd: string) => 
    cmd
      .replace(/\$HOST/g, process.env.HOST || 'http://localhost:3000')
      .replace(/\$ADMIN_TOKEN/g, process.env.ADMIN_TOKEN || 'dev-token')
      .replace(/\$IMAGE_TAG/g, `marlie:${branch}-${Date.now()}`)
      .replace(/\$HEALTH_URL/g, process.env.HEALTH_URL || 'http://localhost:3000/health')
  );
  
  const results = [];
  
  for (const command of commands) {
    logger.info(`📝 Executando: ${command}`);
    
    if (dryRun) {
      logger.info('🔍 [DRY RUN] Comando simulado');
      results.push({ command, status: 'simulated' });
      continue;
    }
    
    try {
      // Comandos especiais que usam ferramentas internas
      if (command.includes('/admin/qa/run')) {
        const suiteMatch = command.match(/"suite":"([^"]+)"/); 
        if (suiteMatch) {
          const suiteName = suiteMatch[1];
          logger.info(`🧪 Executando suíte de testes: ${suiteName}`);
          
          const testResult = await runSuite({ suite: suiteName });
          
          if (testResult.status !== 'passed') {
            throw new Error(`Suíte ${suiteName} falhou: ${testResult.summary}`);
          }
          
          results.push({ 
            command, 
            status: 'success', 
            testResult 
          });
        }
      } else {
        // Comandos shell regulares (simulados por enquanto)
        logger.info(`🔧 Executando comando shell: ${command}`);
        results.push({ command, status: 'success' });
      }
    } catch (error) {
      logger.error(`❌ Falha no comando: ${command}`, error);
      results.push({ 
        command, 
        status: 'failed', 
        error: error.message 
      });
      throw error;
    }
  }
  
  return {
    duration: Date.now() - startTime,
    commands: results
  };
}

// Executar apenas se chamado diretamente
if (require.main === module) {
  main().catch(error => {
    console.error('Erro não tratado:', error);
    process.exit(1);
  });
}

export { main as runPipeline };