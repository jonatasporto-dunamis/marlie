#!/usr/bin/env ts-node

import { Pool } from 'pg';
import Redis from 'ioredis';
import { MarlieQualityModule } from '../index';
import { loadConfig } from '../../../config/loader';
import { logger } from '../../../utils/logger';
import axios from 'axios';

/**
 * Script para verificar saúde do sistema
 * Uso: npm run health:check [-- --detailed --services=database,redis,apis]
 */

interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  services: Record<string, any>;
  metrics?: Record<string, any>;
  version?: string;
  uptime?: number;
}

async function checkDatabase(pgPool: Pool): Promise<any> {
  try {
    const start = Date.now();
    const result = await pgPool.query('SELECT 1 as health_check, NOW() as timestamp');
    const duration = Date.now() - start;
    
    return {
      status: 'healthy',
      responseTime: duration,
      timestamp: result.rows[0].timestamp,
      connection: 'active'
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
      connection: 'failed'
    };
  }
}

async function checkRedis(redis: Redis): Promise<any> {
  try {
    const start = Date.now();
    await redis.ping();
    const duration = Date.now() - start;
    
    const info = await redis.info('server');
    const lines = info.split('\r\n');
    const version = lines.find(line => line.startsWith('redis_version:'))?.split(':')[1];
    const uptime = lines.find(line => line.startsWith('uptime_in_seconds:'))?.split(':')[1];
    
    return {
      status: 'healthy',
      responseTime: duration,
      version,
      uptime: uptime ? parseInt(uptime) : undefined,
      connection: 'active'
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
      connection: 'failed'
    };
  }
}

async function checkExternalAPI(name: string, url: string, timeout = 5000): Promise<any> {
  try {
    const start = Date.now();
    const response = await axios.get(url, {
      timeout,
      validateStatus: (status) => status < 500 // Aceitar 4xx como OK
    });
    const duration = Date.now() - start;
    
    return {
      status: response.status < 400 ? 'healthy' : 'degraded',
      responseTime: duration,
      httpStatus: response.status,
      url,
      reachable: true
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
      url,
      reachable: false
    };
  }
}

async function main() {
  try {
    // Parse argumentos da linha de comando
    const args = process.argv.slice(2);
    const detailedArg = args.includes('--detailed');
    const servicesArg = args.find(arg => arg.startsWith('--services='));
    const timeoutArg = args.find(arg => arg.startsWith('--timeout='));
    
    const services = servicesArg ? servicesArg.split('=')[1].split(',') : ['database', 'redis', 'apis'];
    const timeout = timeoutArg ? parseInt(timeoutArg.split('=')[1]) : 10000;

    logger.info('🔍 Iniciando health check do sistema...', {
      services,
      detailed: detailedArg,
      timeout
    });

    const startTime = Date.now();
    const healthResult: HealthCheckResult = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {},
      version: process.env.npm_package_version || '1.0.0',
      uptime: process.uptime()
    };

    // Carregar configuração
    const config = await loadConfig('marlie-quality');
    
    let pgPool: Pool | undefined;
    let redis: Redis | undefined;
    let qualityModule: MarlieQualityModule | undefined;

    try {
      // Conectar ao banco se solicitado
      if (services.includes('database')) {
        logger.info('🗄️ Verificando banco de dados...');
        pgPool = new Pool({
          host: config.database.host,
          port: config.database.port,
          database: config.database.database,
          user: config.database.username,
          password: config.database.password,
          ssl: config.database.ssl,
          connectionTimeoutMillis: timeout
        });

        healthResult.services.database = await checkDatabase(pgPool);
      }

      // Conectar ao Redis se solicitado
      if (services.includes('redis')) {
        logger.info('🔴 Verificando Redis...');
        redis = new Redis({
          host: config.redis.host,
          port: config.redis.port,
          db: config.redis.db || 0,
          connectTimeout: timeout,
          lazyConnect: true
        });

        healthResult.services.redis = await checkRedis(redis);
      }

      // Verificar APIs externas se solicitado
      if (services.includes('apis')) {
        logger.info('🌐 Verificando APIs externas...');
        
        const apiChecks = [];
        
        // Trinks API
        if (config.contract?.apis?.trinks?.baseUrl) {
          apiChecks.push(
            checkExternalAPI('trinks', `${config.contract.apis.trinks.baseUrl}/health`, timeout)
              .then(result => ({ name: 'trinks', ...result }))
          );
        }
        
        // Evolution API
        if (config.contract?.apis?.evolution?.baseUrl) {
          apiChecks.push(
            checkExternalAPI('evolution', `${config.contract.apis.evolution.baseUrl}/health`, timeout)
              .then(result => ({ name: 'evolution', ...result }))
          );
        }
        
        if (apiChecks.length > 0) {
          const apiResults = await Promise.allSettled(apiChecks);
          healthResult.services.apis = {};
          
          apiResults.forEach((result, index) => {
            if (result.status === 'fulfilled') {
              healthResult.services.apis[result.value.name] = result.value;
            } else {
              const apiName = index === 0 ? 'trinks' : 'evolution';
              healthResult.services.apis[apiName] = {
                status: 'unhealthy',
                error: result.reason?.message || 'Check failed',
                reachable: false
              };
            }
          });
        }
      }

      // Verificar módulo de qualidade se possível
      if (pgPool && redis && services.includes('quality-module')) {
        logger.info('🧪 Verificando módulo de qualidade...');
        try {
          qualityModule = new MarlieQualityModule(pgPool, redis, config);
          await qualityModule.initialize();
          
          const moduleHealth = await qualityModule.getHealthStatus();
          healthResult.services.qualityModule = {
            status: moduleHealth.status === 'healthy' ? 'healthy' : 'degraded',
            ...moduleHealth
          };
        } catch (error) {
          healthResult.services.qualityModule = {
            status: 'unhealthy',
            error: error instanceof Error ? error.message : 'Module check failed'
          };
        }
      }

      // Determinar status geral
      const serviceStatuses = Object.values(healthResult.services).map((service: any) => service.status);
      
      if (serviceStatuses.some(status => status === 'unhealthy')) {
        healthResult.status = 'unhealthy';
      } else if (serviceStatuses.some(status => status === 'degraded')) {
        healthResult.status = 'degraded';
      }

      // Adicionar métricas se detalhado
      if (detailedArg) {
        healthResult.metrics = {
          totalCheckTime: Date.now() - startTime,
          servicesChecked: Object.keys(healthResult.services).length,
          healthyServices: serviceStatuses.filter(s => s === 'healthy').length,
          degradedServices: serviceStatuses.filter(s => s === 'degraded').length,
          unhealthyServices: serviceStatuses.filter(s => s === 'unhealthy').length
        };
      }

    } finally {
      // Finalizar conexões
      if (qualityModule) {
        await qualityModule.shutdown();
      }
      if (pgPool) {
        await pgPool.end();
      }
      if (redis) {
        await redis.disconnect();
      }
    }

    // Exibir resultados
    const statusIcon = healthResult.status === 'healthy' ? '✅' : 
                      healthResult.status === 'degraded' ? '⚠️' : '❌';
    
    console.log(`\n${statusIcon} Status geral: ${healthResult.status.toUpperCase()}`);
    console.log(`🕐 Verificado em: ${healthResult.timestamp}`);
    console.log(`⏱️ Tempo de verificação: ${Date.now() - startTime}ms`);
    
    if (healthResult.version) {
      console.log(`📦 Versão: ${healthResult.version}`);
    }
    
    if (healthResult.uptime) {
      console.log(`⏰ Uptime: ${Math.round(healthResult.uptime)}s`);
    }

    console.log('\n📊 Status dos serviços:');
    Object.entries(healthResult.services).forEach(([serviceName, serviceData]: [string, any]) => {
      const serviceIcon = serviceData.status === 'healthy' ? '✅' : 
                         serviceData.status === 'degraded' ? '⚠️' : '❌';
      
      console.log(`   ${serviceIcon} ${serviceName}: ${serviceData.status}`);
      
      if (detailedArg) {
        if (serviceData.responseTime) {
          console.log(`      ⏱️ Tempo de resposta: ${serviceData.responseTime}ms`);
        }
        if (serviceData.version) {
          console.log(`      📦 Versão: ${serviceData.version}`);
        }
        if (serviceData.error) {
          console.log(`      ❌ Erro: ${serviceData.error}`);
        }
        if (serviceData.url) {
          console.log(`      🌐 URL: ${serviceData.url}`);
        }
      }
    });

    if (healthResult.metrics && detailedArg) {
      console.log('\n📈 Métricas detalhadas:');
      console.log(`   🔍 Serviços verificados: ${healthResult.metrics.servicesChecked}`);
      console.log(`   ✅ Saudáveis: ${healthResult.metrics.healthyServices}`);
      console.log(`   ⚠️ Degradados: ${healthResult.metrics.degradedServices}`);
      console.log(`   ❌ Não saudáveis: ${healthResult.metrics.unhealthyServices}`);
      console.log(`   ⏱️ Tempo total: ${healthResult.metrics.totalCheckTime}ms`);
    }

    // Salvar resultado em JSON se solicitado
    if (args.includes('--json')) {
      console.log('\n📄 Resultado em JSON:');
      console.log(JSON.stringify(healthResult, null, 2));
    }

    // Exit code baseado no status
    if (healthResult.status === 'unhealthy') {
      logger.error('💥 Sistema não saudável!');
      process.exit(1);
    } else if (healthResult.status === 'degraded') {
      logger.warn('⚠️ Sistema com problemas, mas operacional');
      process.exit(0);
    } else {
      logger.info('🎉 Sistema saudável!');
      process.exit(0);
    }

  } catch (error) {
    logger.error('💥 Erro fatal durante health check:', error);
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

export { main as healthCheck };