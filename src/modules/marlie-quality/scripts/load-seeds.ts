#!/usr/bin/env ts-node

import { Pool } from 'pg';
import Redis from 'ioredis';
import { MarlieQualityModule } from '../index';
import { loadConfig } from '../../../config/loader';
import { logger } from '../../../utils/logger';

/**
 * Script para carregar seeds de dados de teste
 * Uso: npm run seed:load [-- --rows=5]
 */

async function main() {
  try {
    // Parse argumentos da linha de comando
    const args = process.argv.slice(2);
    const rowsArg = args.find(arg => arg.startsWith('--rows='));
    const rows = rowsArg ? parseInt(rowsArg.split('=')[1]) : 3;

    logger.info('🌱 Iniciando carregamento de seeds...', { rows });

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

    // Executar seeds
    logger.info('📊 Carregando dados básicos...');
    const result = await qualityModule.runSeeds({ rows });

    if (result.success) {
      logger.info('✅ Seeds carregados com sucesso!', {
        inserted: result.inserted,
        executionTime: `${result.executionTime}ms`
      });

      // Exibir estatísticas
      console.log('\n📈 Estatísticas dos dados inseridos:');
      console.log(`   👥 Clientes: ${result.inserted.customers}`);
      console.log(`   🛍️  Serviços: ${result.inserted.services}`);
      console.log(`   👨‍💼 Profissionais: ${result.inserted.professionals}`);
      console.log(`   📅 Agendamentos: ${result.inserted.appointments}`);
      console.log(`   ⏱️  Tempo de execução: ${result.executionTime}ms`);
    } else {
      logger.error('❌ Erro ao carregar seeds:', result.error);
      process.exit(1);
    }

    // Finalizar conexões
    await qualityModule.shutdown();
    await pgPool.end();
    await redis.disconnect();

    logger.info('🎉 Processo concluído com sucesso!');
    process.exit(0);

  } catch (error) {
    logger.error('💥 Erro fatal durante o carregamento de seeds:', error);
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

export { main as loadSeeds };