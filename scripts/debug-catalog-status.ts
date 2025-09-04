/**
 * Script de depuração para verificar status das otimizações de catálogo
 * Executa verificações de integridade e performance
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function checkTableExists(): Promise<boolean> {
  const result = await pool.query(`
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'servicos_prof'
  `);
  return result.rows.length > 0;
}

async function checkColumnExists(): Promise<boolean> {
  const result = await pool.query(`
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
      AND table_name = 'servicos_prof' 
      AND column_name = 'servico_nome_norm'
  `);
  return result.rows.length > 0;
}

async function checkIndexes(): Promise<any[]> {
  const result = await pool.query(`
    SELECT 
      indexname,
      indexdef,
      schemaname,
      tablename
    FROM pg_indexes 
    WHERE tablename = 'servicos_prof'
      AND indexname IN ('idx_servicos_prof_lookup', 'idx_servicos_prof_servico', 'uniq_servico_nome_norm')
    ORDER BY indexname
  `);
  return result.rows;
}

async function checkDataIntegrity(): Promise<any> {
  const result = await pool.query(`
    SELECT 
      COUNT(*) as total_records,
      COUNT(CASE WHEN servico_nome_norm IS NOT NULL THEN 1 END) as with_normalized_name,
      COUNT(CASE WHEN ativo = true AND visivel_cliente = true THEN 1 END) as active_visible,
      COUNT(DISTINCT tenant_id) as unique_tenants
    FROM servicos_prof
  `);
  return result.rows[0];
}

async function testNormalization(): Promise<any[]> {
  const result = await pool.query(`
    SELECT 
      servico_nome,
      servico_nome_norm,
      CASE 
        WHEN servico_nome_norm = lower(btrim(servico_nome)) THEN 'OK'
        ELSE 'ERRO'
      END as normalization_status
    FROM servicos_prof 
    WHERE servico_nome_norm IS NOT NULL
    LIMIT 10
  `);
  return result.rows;
}

async function checkDuplicates(): Promise<any[]> {
  const result = await pool.query(`
    SELECT 
      tenant_id,
      servico_nome_norm,
      COUNT(*) as count,
      array_agg(servico_nome) as service_names
    FROM servicos_prof 
    WHERE servico_nome_norm IS NOT NULL
    GROUP BY tenant_id, servico_nome_norm
    HAVING COUNT(*) > 1
    ORDER BY count DESC
    LIMIT 10
  `);
  return result.rows;
}

async function testPerformance(): Promise<any> {
  // Buscar um tenant com dados para teste
  const tenantResult = await pool.query(`
    SELECT tenant_id, COUNT(*) as service_count
    FROM servicos_prof 
    WHERE ativo = true AND visivel_cliente = true
    GROUP BY tenant_id
    ORDER BY service_count DESC
    LIMIT 1
  `);

  if (tenantResult.rows.length === 0) {
    return { error: 'Nenhum tenant com serviços ativos encontrado' };
  }

  const { tenant_id, service_count } = tenantResult.rows[0];

  // Testar performance da consulta
  const start = Date.now();
  const searchResult = await pool.query(`
    SELECT servico_id, servico_nome
    FROM servicos_prof
    WHERE tenant_id = $1
      AND ativo = true
      AND visivel_cliente = true
      AND servico_nome_norm LIKE 'a%'
    ORDER BY servico_nome_norm
    LIMIT 20
  `, [tenant_id]);
  const duration = Date.now() - start;

  // Verificar plano de execução
  const explainResult = await pool.query(`
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT servico_id, servico_nome
    FROM servicos_prof
    WHERE tenant_id = $1
      AND ativo = true
      AND visivel_cliente = true
      AND servico_nome_norm LIKE 'a%'
    ORDER BY servico_nome_norm
    LIMIT 20
  `, [tenant_id]);

  return {
    tenant_id,
    service_count,
    query_duration_ms: duration,
    results_found: searchResult.rows.length,
    execution_plan: explainResult.rows.map(row => row['QUERY PLAN'])
  };
}

async function main() {
  try {
    console.log('🔍 Verificando status das otimizações de catálogo...\n');

    // 1. Verificar tabela
    const tableExists = await checkTableExists();
    console.log(`✅ Tabela servicos_prof existe: ${tableExists}`);
    
    if (!tableExists) {
      console.log('❌ Tabela não encontrada. Execute as migrações primeiro.');
      return;
    }

    // 2. Verificar coluna normalizada
    const columnExists = await checkColumnExists();
    console.log(`✅ Coluna servico_nome_norm existe: ${columnExists}`);

    // 3. Verificar índices
    const indexes = await checkIndexes();
    console.log(`\n📊 Índices encontrados (${indexes.length}):`);
    indexes.forEach(idx => {
      console.log(`  - ${idx.indexname}`);
      console.log(`    ${idx.indexdef}`);
    });

    // 4. Verificar integridade dos dados
    const integrity = await checkDataIntegrity();
    console.log(`\n📈 Integridade dos dados:`);
    console.log(`  - Total de registros: ${integrity.total_records}`);
    console.log(`  - Com nome normalizado: ${integrity.with_normalized_name}`);
    console.log(`  - Ativos e visíveis: ${integrity.active_visible}`);
    console.log(`  - Tenants únicos: ${integrity.unique_tenants}`);

    // 5. Testar normalização
    if (columnExists) {
      const normalizationTest = await testNormalization();
      console.log(`\n🔤 Teste de normalização (amostra):`);
      normalizationTest.forEach(row => {
        console.log(`  "${row.servico_nome}" -> "${row.servico_nome_norm}" [${row.normalization_status}]`);
      });
    }

    // 6. Verificar duplicados
    const duplicates = await checkDuplicates();
    if (duplicates.length > 0) {
      console.log(`\n⚠️  Duplicados encontrados (${duplicates.length}):`);
      duplicates.forEach(dup => {
        console.log(`  - Tenant ${dup.tenant_id}: "${dup.servico_nome_norm}" (${dup.count}x)`);
        console.log(`    Nomes: ${dup.service_names.join(', ')}`);
      });
    } else {
      console.log(`\n✅ Nenhum duplicado encontrado`);
    }

    // 7. Teste de performance
    console.log(`\n⚡ Teste de performance:`);
    const perfTest = await testPerformance();
    if (perfTest.error) {
      console.log(`  ❌ ${perfTest.error}`);
    } else {
      console.log(`  - Tenant testado: ${perfTest.tenant_id} (${perfTest.service_count} serviços)`);
      console.log(`  - Duração da consulta: ${perfTest.query_duration_ms}ms`);
      console.log(`  - Resultados encontrados: ${perfTest.results_found}`);
      console.log(`  - Performance: ${perfTest.query_duration_ms < 50 ? '✅ BOA' : '⚠️  LENTA'} (meta: <50ms)`);
      
      const planText = perfTest.execution_plan.join(' ');
      const usesIndex = planText.includes('idx_servicos_prof_lookup');
      console.log(`  - Uso de índice: ${usesIndex ? '✅ SIM' : '❌ NÃO'}`);
    }

    console.log(`\n🎉 Verificação concluída!`);

  } catch (error) {
    console.error('❌ Erro durante verificação:', error);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main();
}

export { main as debugCatalogStatus };