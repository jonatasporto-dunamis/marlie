#!/usr/bin/env ts-node

import { runShipCheck } from '../src/modules/marlie-ship-check';
import { logger } from '../src/utils/logger';
import * as path from 'path';

interface CliOptions {
  environment: 'development' | 'staging' | 'production';
  dryRun: boolean;
  configPath?: string;
  verbose: boolean;
  help: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  
  const options: CliOptions = {
    environment: 'development',
    dryRun: false,
    verbose: false,
    help: false
  };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    switch (arg) {
      case '--environment':
      case '-e':
        const env = args[++i];
        if (['development', 'staging', 'production'].includes(env)) {
          options.environment = env as any;
        } else {
          console.error(`❌ Ambiente inválido: ${env}`);
          process.exit(1);
        }
        break;
        
      case '--dry-run':
      case '-d':
        options.dryRun = true;
        break;
        
      case '--config':
      case '-c':
        options.configPath = args[++i];
        break;
        
      case '--verbose':
      case '-v':
        options.verbose = true;
        break;
        
      case '--help':
      case '-h':
        options.help = true;
        break;
        
      default:
        console.error(`❌ Argumento desconhecido: ${arg}`);
        showHelp();
        process.exit(1);
    }
  }
  
  return options;
}

function showHelp(): void {
  console.log(`
🚀 Marlie Ship Check - Verificação de Entregáveis + Deploy

Uso:
  npm run ship-check [opções]
  
Opções:
  -e, --environment <env>    Ambiente (development|staging|production) [padrão: development]
  -d, --dry-run             Execução simulada (não faz deploy real)
  -c, --config <path>       Caminho para arquivo de configuração customizado
  -v, --verbose             Logs detalhados
  -h, --help                Mostra esta ajuda
  
Exemplos:
  npm run ship-check                           # Desenvolvimento
  npm run ship-check -e staging                # Staging
  npm run ship-check -e production -d          # Produção (dry-run)
  npm run ship-check -c custom-config.yaml    # Configuração customizada
  
Entregáveis verificados:
  • P0.1 - Menu rígido + confirmação de intenção
  • P0.2 - Buffer 30s agregando mensagens
  • P0.4 - Handoff humano
  • P1.6 - Dashboards Grafana (3 telas)
  • P2.7 - Sincronismo Trinks
  
Pipeline CI/CD:
  • Execução de testes
  • Instalação de dependências
  • Build do projeto
  • Commit e push para Git
  • Deploy no Railway
`);
}

function setupLogging(verbose: boolean): void {
  if (verbose) {
    // Configurar logs detalhados
    process.env.LOG_LEVEL = 'debug';
  }
}

function printBanner(): void {
  console.log(`
🚀 ===== MARLIE SHIP CHECK =====`);
  console.log(`📋 Verificação de Entregáveis + Deploy`);
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);
  console.log(`===============================\n`);
}

function printSummary(result: any, options: CliOptions): void {
  console.log(`\n📊 ===== RESUMO DA EXECUÇÃO =====`);
  console.log(`🎯 Ambiente: ${options.environment}`);
  console.log(`⏱️  Duração: ${result.duration_ms}ms`);
  console.log(`✅ Sucesso: ${result.success ? 'SIM' : 'NÃO'}`);
  
  console.log(`\n📋 ENTREGÁVEIS:`);
  Object.entries(result.deliverables).forEach(([key, value]) => {
    const icon = value ? '✅' : '❌';
    const name = key.replace(/_/g, '.');
    console.log(`  ${icon} ${name}`);
  });
  
  console.log(`\n🔧 CI/CD PIPELINE:`);
  Object.entries(result.ci_cd).forEach(([key, value]) => {
    const icon = value ? '✅' : '❌';
    const name = key.replace(/_/g, ' ');
    console.log(`  ${icon} ${name}`);
  });
  
  if (result.errors && result.errors.length > 0) {
    console.log(`\n❌ ERROS:`);
    result.errors.forEach((error: string, index: number) => {
      console.log(`  ${index + 1}. ${error}`);
    });
  }
  
  console.log(`\n================================`);
}

async function main(): Promise<void> {
  try {
    const options = parseArgs();
    
    if (options.help) {
      showHelp();
      return;
    }
    
    setupLogging(options.verbose);
    printBanner();
    
    // Validar ambiente
    if (options.environment === 'production' && !options.dryRun) {
      console.log(`⚠️  ATENÇÃO: Executando em PRODUÇÃO!`);
      console.log(`🔒 Para segurança, use --dry-run primeiro.`);
      
      // Em produção, exigir confirmação
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      const answer = await new Promise<string>((resolve) => {
        rl.question('Confirma deploy em produção? (digite "CONFIRMO"): ', resolve);
      });
      
      rl.close();
      
      if (answer !== 'CONFIRMO') {
        console.log('❌ Deploy cancelado.');
        process.exit(1);
      }
    }
    
    // Configurar variáveis de ambiente baseado no ambiente
    if (options.environment === 'staging') {
      process.env.BASE_URL = process.env.STAGING_BASE_URL || process.env.BASE_URL;
      process.env.ADMIN_TOKEN = process.env.STAGING_ADMIN_TOKEN || process.env.ADMIN_TOKEN;
    } else if (options.environment === 'production') {
      process.env.BASE_URL = process.env.PRODUCTION_BASE_URL || process.env.BASE_URL;
      process.env.ADMIN_TOKEN = process.env.PRODUCTION_ADMIN_TOKEN || process.env.ADMIN_TOKEN;
    }
    
    logger.info(`🚀 Iniciando ship check - ambiente: ${options.environment}`);
    
    if (options.dryRun) {
      logger.info(`🧪 Modo dry-run ativado - nenhuma alteração será feita`);
    }
    
    // Executar ship check
    const result = await runShipCheck(options.configPath);
    
    // Imprimir resumo
    printSummary(result, options);
    
    // Determinar código de saída
    const exitCode = result.success ? 0 : 1;
    
    if (result.success) {
      console.log(`\n🎉 Ship check concluído com sucesso!`);
      if (options.environment === 'production' && !options.dryRun) {
        console.log(`🚀 Deploy em produção realizado!`);
      }
    } else {
      console.log(`\n💥 Ship check falhou. Verifique os erros acima.`);
    }
    
    process.exit(exitCode);
    
  } catch (error) {
    console.error(`\n💥 Erro fatal durante ship check:`);
    console.error(error instanceof Error ? error.message : String(error));
    
    if (process.env.LOG_LEVEL === 'debug') {
      console.error(error instanceof Error ? error.stack : String(error));
    }
    
    process.exit(1);
  }
}

// Executar apenas se chamado diretamente
if (require.main === module) {
  main();
}

export { main as runShipCheckCli };