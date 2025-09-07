#!/usr/bin/env ts-node

import { logger } from '../../utils/logger';
import { loadConfigWithDefaults } from '../../config/loader';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import { runSuite } from '../marlie-quality/tools/qa-run-suite';
import { execSync } from 'child_process';

interface ShipCheckConfig {
  module: {
    name: string;
    language: string;
    description: string;
  };
  env: {
    timezone: string;
    BASE_URL: string;
    ADMIN_TOKEN: string;
    GRAFANA_URL: string;
    GRAFANA_TOKEN: string;
  };
  tools: Array<{
    name: string;
    description: string;
    input_schema: any;
  }>;
  tests: {
    suites: Array<{
      name: string;
      steps: any[];
    }>;
  };
  ci_cd: {
    stages: Array<{
      name: string;
      run: string[];
    }>;
  };
}

interface ShipCheckResult {
  success: boolean;
  deliverables: {
    P01_menu_rigido: boolean;
    P02_buffer_30s: boolean;
    P04_handoff_humano: boolean;
    P16_dashboards_grafana: boolean;
    P27_sync_trinks: boolean;
  };
  ci_cd: {
    suite_test: boolean;
    install: boolean;
    build: boolean;
    git_push: boolean;
    deploy_railway: boolean;
  };
  errors: string[];
  duration_ms: number;
}

export class ShipCheckService {
  private config: ShipCheckConfig;
  private errors: string[] = [];

  constructor(config: ShipCheckConfig) {
    this.config = config;
  }

  async runShipCheck(): Promise<ShipCheckResult> {
    const startTime = Date.now();
    logger.info('🚀 Iniciando verificação de entregáveis e deploy');

    const result: ShipCheckResult = {
      success: false,
      deliverables: {
        P01_menu_rigido: false,
        P02_buffer_30s: false,
        P04_handoff_humano: false,
        P16_dashboards_grafana: false,
        P27_sync_trinks: false
      },
      ci_cd: {
        suite_test: false,
        install: false,
        build: false,
        git_push: false,
        deploy_railway: false
      },
      errors: [],
      duration_ms: 0
    };

    try {
      // 1. Executar suite de testes dos entregáveis
      logger.info('📋 Verificando entregáveis...');
      const suiteResult = await this.runDeliverablesCheck();
      result.ci_cd.suite_test = suiteResult.success;
      
      if (suiteResult.success) {
        result.deliverables = {
          P01_menu_rigido: true,
          P02_buffer_30s: true,
          P04_handoff_humano: true,
          P16_dashboards_grafana: true,
          P27_sync_trinks: true
        };
      } else {
        this.errors.push(`Falha na verificação de entregáveis: ${suiteResult.error}`);
      }

      // 2. Executar pipeline CI/CD
      if (result.ci_cd.suite_test) {
        logger.info('🔧 Executando pipeline CI/CD...');
        await this.runCICDPipeline(result);
      } else {
        logger.warn('⚠️ Pulando CI/CD devido a falhas nos entregáveis');
      }

      result.success = result.ci_cd.suite_test && 
                      result.ci_cd.install && 
                      result.ci_cd.build && 
                      result.ci_cd.git_push && 
                      result.ci_cd.deploy_railway;

    } catch (error) {
      this.errors.push(`Erro geral: ${error instanceof Error ? error.message : String(error)}`);
      logger.error('❌ Erro durante ship check:', error);
    }

    result.errors = this.errors;
    result.duration_ms = Date.now() - startTime;

    if (result.success) {
      logger.info('✅ Ship check concluído com sucesso!');
    } else {
      logger.error('❌ Ship check falhou:', result.errors);
    }

    return result;
  }

  private async runDeliverablesCheck(): Promise<{ success: boolean; error?: string }> {
    try {
      const suiteResult = await runSuite({ suite: 'deliverables_checklist' });
      return {
        success: suiteResult.status === 'pass',
        error: suiteResult.status === 'fail' ? suiteResult.error : undefined
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async runCICDPipeline(result: ShipCheckResult): Promise<void> {
    const stages = this.config.ci_cd.stages;

    for (const stage of stages) {
      logger.info(`🔄 Executando estágio: ${stage.name}`);
      
      try {
        for (const command of stage.run) {
          const resolvedCommand = this.resolveVariables(command);
          logger.debug(`Executando: ${resolvedCommand}`);
          
          execSync(resolvedCommand, { 
            stdio: 'inherit',
            cwd: process.cwd(),
            timeout: 300000 // 5 minutos
          });
        }
        
        // Marcar estágio como sucesso
        switch (stage.name) {
          case 'run_suite_deliverables':
            result.ci_cd.suite_test = true;
            break;
          case 'install':
            result.ci_cd.install = true;
            break;
          case 'build':
            result.ci_cd.build = true;
            break;
          case 'git_push':
            result.ci_cd.git_push = true;
            break;
          case 'deploy_railway':
            result.ci_cd.deploy_railway = true;
            break;
        }
        
        logger.info(`✅ Estágio ${stage.name} concluído`);
        
      } catch (error) {
        this.errors.push(`Falha no estágio ${stage.name}: ${error instanceof Error ? error.message : String(error)}`);
        logger.error(`❌ Falha no estágio ${stage.name}:`, error);
        break; // Para o pipeline em caso de erro
      }
    }
  }

  private resolveVariables(command: string): string {
    let resolved = command;
    
    // Substituir variáveis de ambiente
    resolved = resolved.replace(/\{\{env\.([^}]+)\}\}/g, (match, envVar) => {
      return process.env[envVar] || (this.config.env as any)[envVar] || match;
    });
    
    // Substituir funções especiais
    resolved = resolved.replace(/\{\{today_local_date\(([^)]+)\)\}\}/g, (match, timezone) => {
      const now = new Date();
      return now.toLocaleDateString('pt-BR', { timeZone: timezone.replace(/"/g, '') });
    });
    
    return resolved;
  }
}

export async function runShipCheck(configPath?: string): Promise<ShipCheckResult> {
  try {
    // Carregar configuração
    const configFile = configPath || path.join(__dirname, 'config', 'ship-check.yaml');
    const configContent = fs.readFileSync(configFile, 'utf8');
    const config = yaml.load(configContent) as ShipCheckConfig;
    
    // Mesclar com configurações padrão
    const mergedConfig = {
      ...config,
      env: {
        ...config.env,
        BASE_URL: process.env.BASE_URL || config.env.BASE_URL,
        ADMIN_TOKEN: process.env.ADMIN_TOKEN || config.env.ADMIN_TOKEN,
        GRAFANA_URL: process.env.GRAFANA_URL || config.env.GRAFANA_URL,
        GRAFANA_TOKEN: process.env.GRAFANA_TOKEN || config.env.GRAFANA_TOKEN
      }
    };
    
    const service = new ShipCheckService(mergedConfig);
    return await service.runShipCheck();
    
  } catch (error) {
    logger.error('❌ Erro ao executar ship check:', error);
    return {
      success: false,
      deliverables: {
        P01_menu_rigido: false,
        P02_buffer_30s: false,
        P04_handoff_humano: false,
        P16_dashboards_grafana: false,
        P27_sync_trinks: false
      },
      ci_cd: {
        suite_test: false,
        install: false,
        build: false,
        git_push: false,
        deploy_railway: false
      },
      errors: [error instanceof Error ? error.message : String(error)],
      duration_ms: 0
    };
  }
}

// Execução direta via CLI
if (require.main === module) {
  const configPath = process.argv[2];
  
  runShipCheck(configPath)
    .then(result => {
      console.log('\n📊 Resultado do Ship Check:');
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('❌ Erro fatal:', error);
      process.exit(1);
    });
}