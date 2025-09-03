#!/usr/bin/env ts-node

import { pg, initPersistence } from '../../src/db/index';
import logger from '../../src/utils/logger';

interface DuplicateGroup {
  tenant_id: string;
  servico_nome: string;
  profissional_id: number;
  ids: number[];
  count: number;
}

/**
 * Script de manutenção para consolidar duplicatas antigas na tabela servicos_prof
 * Remove duplicatas lógicas baseadas em (tenant_id, lower(servico_nome), profissional_id)
 * Mantém o registro mais recente (maior last_synced_at) de cada grupo
 */
async function consolidateDuplicates(): Promise<void> {
  try {
    await initPersistence({ redisUrl: null, databaseUrl: process.env.DATABASE_URL, databaseSsl: false });
    
    if (!pg) {
      throw new Error('Conexão com banco de dados não disponível');
    }

    logger.info('Iniciando processo de consolidação de duplicatas...');

    // 1. Identificar grupos de duplicatas
    const duplicatesQuery = `
      SELECT 
        tenant_id,
        lower(trim(servico_nome)) as servico_nome,
        profissional_id,
        array_agg(id ORDER BY last_synced_at DESC) as ids,
        count(*) as count
      FROM servicos_prof 
      GROUP BY tenant_id, lower(trim(servico_nome)), profissional_id
      HAVING count(*) > 1
      ORDER BY count DESC
    `;

    const duplicatesResult = await pg.query(duplicatesQuery);
    const duplicateGroups: DuplicateGroup[] = duplicatesResult.rows;

    if (duplicateGroups.length === 0) {
      logger.info('Nenhuma duplicata encontrada. Catálogo já está limpo.');
      return;
    }

    logger.info(`Encontrados ${duplicateGroups.length} grupos de duplicatas`);
    
    let totalRemoved = 0;
    let totalConsolidated = 0;

    // 2. Para cada grupo, manter apenas o mais recente
    for (const group of duplicateGroups) {
      const [keepId, ...removeIds] = group.ids;
      
      if (removeIds.length === 0) continue;

      logger.debug(`Consolidando grupo: ${group.tenant_id}/${group.servico_nome}/${group.profissional_id}`);
      logger.debug(`Mantendo ID ${keepId}, removendo IDs: ${removeIds.join(', ')}`);

      // Remover duplicatas (manter apenas o primeiro ID que é o mais recente)
      const deleteQuery = `
        DELETE FROM servicos_prof 
        WHERE id = ANY($1)
      `;
      
      const deleteResult = await pg.query(deleteQuery, [removeIds]);
      const removedCount = deleteResult.rowCount || 0;
      
      totalRemoved += removedCount;
      totalConsolidated++;
      
      logger.debug(`Removidos ${removedCount} registros duplicados`);
    }

    // 3. Atualizar estatísticas da tabela
    await pg.query('ANALYZE servicos_prof');

    logger.info(`Consolidação concluída:`);
    logger.info(`- ${totalConsolidated} grupos consolidados`);
    logger.info(`- ${totalRemoved} registros duplicados removidos`);
    logger.info(`- Tabela analisada para atualizar estatísticas`);

    // 4. Verificar resultado final
    const finalCheckQuery = `
      SELECT count(*) as remaining_duplicates
      FROM (
        SELECT tenant_id, lower(trim(servico_nome)), profissional_id, count(*)
        FROM servicos_prof 
        GROUP BY tenant_id, lower(trim(servico_nome)), profissional_id
        HAVING count(*) > 1
      ) duplicates
    `;
    
    const finalCheck = await pg.query(finalCheckQuery);
    const remainingDuplicates = parseInt(finalCheck.rows[0]?.remaining_duplicates || '0');
    
    if (remainingDuplicates > 0) {
      logger.warn(`Ainda existem ${remainingDuplicates} grupos com duplicatas. Execute novamente se necessário.`);
    } else {
      logger.info('✅ Catálogo totalmente limpo - nenhuma duplicata restante.');
    }

  } catch (error) {
    logger.error('Erro durante consolidação de duplicatas:', error);
    throw error;
  }
}

/**
 * Função para executar análise sem modificar dados (dry-run)
 */
async function analyzeDuplicates(): Promise<void> {
  try {
    await initPersistence({ redisUrl: null, databaseUrl: process.env.DATABASE_URL, databaseSsl: false });
    
    if (!pg) {
      throw new Error('Conexão com banco de dados não disponível');
    }

    logger.info('Analisando duplicatas (modo somente leitura)...');

    const analysisQuery = `
      SELECT 
        tenant_id,
        lower(trim(servico_nome)) as servico_nome,
        profissional_id,
        count(*) as duplicates,
        array_agg(id ORDER BY last_synced_at DESC) as ids,
        array_agg(last_synced_at ORDER BY last_synced_at DESC) as sync_dates
      FROM servicos_prof 
      GROUP BY tenant_id, lower(trim(servico_nome)), profissional_id
      HAVING count(*) > 1
      ORDER BY count(*) DESC
      LIMIT 20
    `;

    const result = await pg.query(analysisQuery);
    
    if (result.rows.length === 0) {
      logger.info('✅ Nenhuma duplicata encontrada.');
      return;
    }

    logger.info(`Encontradas duplicatas em ${result.rows.length} grupos (mostrando top 20):`);
    
    for (const row of result.rows) {
      logger.info(`- ${row.tenant_id}/${row.servico_nome}/${row.profissional_id}: ${row.duplicates} registros`);
      logger.info(`  IDs: ${row.ids.join(', ')}`);
    }

    // Estatísticas gerais
    const statsQuery = `
      SELECT 
        count(*) as total_groups_with_duplicates,
        sum(duplicate_count - 1) as total_duplicates_to_remove
      FROM (
        SELECT count(*) as duplicate_count
        FROM servicos_prof 
        GROUP BY tenant_id, lower(trim(servico_nome)), profissional_id
        HAVING count(*) > 1
      ) groups
    `;
    
    const stats = await pg.query(statsQuery);
    const totalGroups = stats.rows[0]?.total_groups_with_duplicates || 0;
    const totalToRemove = stats.rows[0]?.total_duplicates_to_remove || 0;
    
    logger.info(`\nResumo:`);
    logger.info(`- ${totalGroups} grupos com duplicatas`);
    logger.info(`- ${totalToRemove} registros seriam removidos`);
    
  } catch (error) {
    logger.error('Erro durante análise de duplicatas:', error);
    throw error;
  }
}

// Execução do script
if (require.main === module) {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run') || args.includes('--analyze');
  
  const main = async () => {
    try {
      if (isDryRun) {
        await analyzeDuplicates();
      } else {
        await consolidateDuplicates();
      }
      process.exit(0);
    } catch (error) {
      logger.error('Script falhou:', error);
      process.exit(1);
    }
  };
  
  main();
}

export { consolidateDuplicates, analyzeDuplicates };