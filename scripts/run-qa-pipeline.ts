#!/usr/bin/env ts-node

/**
 * Script de exemplo para executar pipeline de qualidade
 * 
 * Uso:
 * npm run qa:pipeline -- --env staging --branch main
 * npm run qa:pipeline -- --env production --branch release --stages lint,test
 * npm run qa:pipeline -- --dry-run --stages e2e_tests
 */

import { runPipeline } from '../src/modules/marlie-quality/scripts/run-pipeline';
import { logger } from '../src/utils/logger';

async function main() {
  try {
    logger.info('🚀 Iniciando pipeline de qualidade Marlie...');
    
    // Executar pipeline com argumentos da linha de comando
    await runPipeline();
    
    logger.info('✅ Pipeline de qualidade concluído com sucesso!');
    process.exit(0);
  } catch (error) {
    logger.error('❌ Pipeline de qualidade falhou:', error);
    process.exit(1);
  }
}

// Executar apenas se chamado diretamente
if (require.main === module) {
  main();
}

export { main };