#!/usr/bin/env ts-node

/**
 * Script para executar testes de contrato
 * 
 * Uso:
 *   npm run contract-tests
 *   npm run contract-tests -- --suite=trinks_fetch_contract
 *   npm run contract-tests -- --environment=production --timeout=15000
 */

import { MarlieQualityModule } from '../index';
import { logger } from '../../../utils/logger';
import { Pool } from 'pg';
import Redis from 'ioredis';
import * as yaml from 'yaml';
import * as fs from 'fs';
import * as path from 'path';

// Configuração de argumentos
interface ContractTestArgs {
  suite?: string;
  environment: 'staging' | 'production';
  timeout: number;
  verbose: boolean;
  useStubs: boolean;
  help: boolean;
}

function parseArgs(): ContractTestArgs {
  const args = process.argv.slice(2);
  const parsed: ContractTestArgs = {
    environment: 'staging',
    timeout: 10000,
    verbose: false,
    useStubs: true,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg.startsWith('--suite=')) {
      parsed.suite = arg.split('=')[1];
    } else if (arg.startsWith('--environment=')) {
      parsed.environment = arg.split('=')[1] as 'staging' | 'production';
    } else if (arg.startsWith('--timeout=')) {
      parsed.timeout = parseInt(arg.split('=')[1]);
    } else if (arg === '--verbose' || arg === '-v') {
      parsed.verbose = true;
    } else if (arg === '--no-stubs') {
      parsed.useStubs = false;
    }
  }

  return parsed;
}

function showHelp(): void {
  console.log(`
Script de Testes de Contrato - Marlie Quality

Uso:
  npm run contract-tests [opções]

Opções:
  --suite=<nome>           Executar suite específica
  --environment=<env>      Ambiente (staging|production) [padrão: staging]
  --timeout=<ms>           Timeout em milissegundos [padrão: 10000]
  --verbose, -v            Saída detalhada
  --no-stubs               Usar APIs reais ao invés de stubs
  --help, -h               Mostrar esta ajuda

Exemplos:
  npm run contract-tests
  npm run contract-tests -- --suite=trinks_fetch_contract
  npm run contract-tests -- --environment=production --no-stubs
  npm run contract-tests -- --verbose --timeout=15000
`);
}

async function loadConfig(): Promise<any> {
  const configPath = path.join(__dirname, '../../../config/marlie-quality.yaml');
  
  if (!fs.existsSync(configPath)) {
    throw new Error(`Arquivo de configuração não encontrado: ${configPath}`);
  }
  
  const configContent = fs.readFileSync(configPath, 'utf8');
  return yaml.parse(configContent);
}

async function setupDatabase(config: any): Promise<Pool> {
  const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    user: config.database.username,
    password: config.database.password,
    ssl: config.database.ssl
  });
  
  // Testar conexão
  await pool.query('SELECT 1');
  logger.info('Conexão com PostgreSQL estabelecida');
  
  return pool;
}

async function setupRedis(config: any): Promise<Redis> {
  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    db: config.redis.db || 0
  });
  
  // Testar conexão
  await redis.ping();
  logger.info('Conexão com Redis estabelecida');
  
  return redis;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function printResults(results: any, verbose: boolean): void {
  console.log('\n' + '='.repeat(60));
  console.log('RESULTADOS DOS TESTES DE CONTRATO');
  console.log('='.repeat(60));
  
  if (results.total_suites) {
    // Múltiplas suites
    console.log(`\nTotal de suites: ${results.total_suites}`);
    console.log(`Sucesso geral: ${results.overall_success ? '✅ SIM' : '❌ NÃO'}`);
    
    for (const result of results.results) {
      const status = result.success ? '✅' : '❌';
      console.log(`\n${status} ${result.suite} (${formatDuration(result.duration)})`);
      
      if (verbose || !result.success) {
        console.log(`   Steps: ${result.steps.length}`);
        console.log(`   Timestamp: ${result.timestamp}`);
        
        if (result.error) {
          console.log(`   Erro: ${result.error}`);
        }
        
        if (verbose) {
          for (const step of result.steps) {
            const stepStatus = step.success ? '✓' : '✗';
            console.log(`     ${stepStatus} ${step.action} (${formatDuration(step.duration)})`);
            if (!step.success && step.error) {
              console.log(`       Erro: ${step.error}`);
            }
          }
        }
      }
    }
  } else {
    // Suite única
    const status = results.success ? '✅' : '❌';
    console.log(`\n${status} ${results.suite} (${formatDuration(results.duration)})`);
    console.log(`Steps: ${results.steps.length}`);
    console.log(`Timestamp: ${results.timestamp}`);
    
    if (results.error) {
      console.log(`Erro: ${results.error}`);
    }
    
    if (verbose) {
      console.log('\nDetalhes dos steps:');
      for (const step of results.steps) {
        const stepStatus = step.success ? '✓' : '✗';
        console.log(`  ${stepStatus} ${step.action} (${formatDuration(step.duration)})`);
        if (step.result && typeof step.result === 'object') {
          console.log(`    Resultado: ${JSON.stringify(step.result, null, 2).substring(0, 200)}...`);
        }
        if (!step.success && step.error) {
          console.log(`    Erro: ${step.error}`);
        }
      }
    }
  }
  
  console.log('\n' + '='.repeat(60));
}

async function main(): Promise<void> {
  const args = parseArgs();
  
  if (args.help) {
    showHelp();
    process.exit(0);
  }
  
  console.log('🧪 Iniciando testes de contrato...');
  console.log(`Ambiente: ${args.environment}`);
  console.log(`Timeout: ${args.timeout}ms`);
  console.log(`Usar stubs: ${args.useStubs ? 'Sim' : 'Não'}`);
  if (args.suite) {
    console.log(`Suite específica: ${args.suite}`);
  }
  
  let pgPool: Pool | undefined;
  let redis: Redis | undefined;
  let qualityModule: MarlieQualityModule | undefined;
  
  try {
    // Carregar configuração
    const config = await loadConfig();
    
    // Configurar variáveis de ambiente para stubs
    if (args.useStubs) {
      process.env.USE_TRINKS_STUBS = 'true';
    }
    
    // Configurar conexões
    pgPool = await setupDatabase(config);
    redis = await setupRedis(config);
    
    // Inicializar módulo
    qualityModule = new MarlieQualityModule(config, pgPool, redis);
    await qualityModule.initialize();
    
    console.log('✅ Módulo inicializado com sucesso\n');
    
    // Executar testes
    const startTime = Date.now();
    let results;
    
    if (args.suite) {
      console.log(`Executando suite: ${args.suite}`);
      results = await qualityModule.runContractTests(args.suite);
    } else {
      console.log('Executando todas as suites de contrato');
      results = await qualityModule.runContractTests();
    }
    
    const totalDuration = Date.now() - startTime;
    
    // Exibir resultados
    printResults(results, args.verbose);
    
    console.log(`\nTempo total: ${formatDuration(totalDuration)}`);
    
    // Determinar código de saída
    const success = results.overall_success !== undefined 
      ? results.overall_success 
      : results.success;
      
    if (success) {
      console.log('\n🎉 Todos os testes passaram!');
      process.exit(0);
    } else {
      console.log('\n💥 Alguns testes falharam!');
      process.exit(1);
    }
    
  } catch (error) {
    logger.error('Erro durante execução dos testes:', error);
    console.error('\n❌ Erro durante execução dos testes:');
    console.error(error.message);
    
    if (args.verbose && error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    
    process.exit(1);
    
  } finally {
    // Limpeza
    try {
      if (qualityModule) {
        await qualityModule.shutdown();
      }
      if (redis) {
        await redis.quit();
      }
      if (pgPool) {
        await pgPool.end();
      }
      console.log('\n🧹 Limpeza concluída');
    } catch (cleanupError) {
      logger.error('Erro durante limpeza:', cleanupError);
    }
  }
}

// Executar script
if (require.main === module) {
  main().catch(error => {
    console.error('Erro fatal:', error);
    process.exit(1);
  });
}

export { main as runContractTests };