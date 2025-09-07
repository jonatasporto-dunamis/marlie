#!/usr/bin/env node

/**
 * Script para testar a conexão com o Supabase
 * Valida configurações, conectividade e funcionalidades básicas
 */

const { Pool } = require('pg');
const { parse } = require('pg-connection-string');
require('dotenv').config();

const logger = {
  info: (msg, meta = {}) => console.log(`[INFO] ${msg}`, meta),
  error: (msg, meta = {}) => console.error(`[ERROR] ${msg}`, meta),
  warn: (msg, meta = {}) => console.warn(`[WARN] ${msg}`, meta),
  success: (msg, meta = {}) => console.log(`[SUCCESS] ✅ ${msg}`, meta)
};

async function testSupabaseConnection() {
  logger.info('🚀 Iniciando teste de conexão com Supabase...');
  
  // Verificar variáveis de ambiente
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.error('❌ DATABASE_URL não configurada');
    process.exit(1);
  }
  
  // Parse da URL de conexão
  const config = parse(databaseUrl);
  const isSupabase = config.host && (config.host.includes('supabase.co') || config.host.includes('pooler.supabase.com'));
  
  if (!isSupabase) {
    logger.warn('⚠️  A URL do banco não parece ser do Supabase');
  }
  
  // Configurar pool de conexões
  const poolConfig = {
    ...config,
    ssl: isSupabase ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };
  
  if (isSupabase) {
    poolConfig.application_name = 'syncbelle-test';
    poolConfig.statement_timeout = 30000;
    poolConfig.query_timeout = 30000;
  }
  
  const pool = new Pool(poolConfig);
  
  try {
    // Teste 1: Conectividade básica
    logger.info('🔌 Testando conectividade básica...');
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as current_time, version() as pg_version');
    logger.success('Conexão estabelecida com sucesso', {
      timestamp: result.rows[0].current_time,
      version: result.rows[0].pg_version.split(' ')[0]
    });
    client.release();
    
    // Teste 2: Verificar extensões necessárias
    logger.info('🔧 Verificando extensões necessárias...');
    const extensionsResult = await pool.query(`
      SELECT extname, extversion 
      FROM pg_extension 
      WHERE extname IN ('uuid-ossp', 'pgcrypto', 'pg_stat_statements')
      ORDER BY extname
    `);
    
    const requiredExtensions = ['uuid-ossp', 'pgcrypto'];
    const installedExtensions = extensionsResult.rows.map(row => row.extname);
    
    for (const ext of requiredExtensions) {
      if (installedExtensions.includes(ext)) {
        logger.success(`Extensão ${ext} instalada`);
      } else {
        logger.error(`❌ Extensão ${ext} não encontrada`);
      }
    }
    
    // Teste 3: Verificar tabelas principais
    logger.info('📋 Verificando tabelas principais...');
    const tablesResult = await pool.query(`
      SELECT table_name, 
             (SELECT COUNT(*) FROM information_schema.columns 
              WHERE table_name = t.table_name AND column_name = 'tenant_id') as has_tenant_id
      FROM information_schema.tables t
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      AND table_name IN ('tenants', 'tenant_configs', 'contacts', 'conversation_states')
      ORDER BY table_name
    `);
    
    if (tablesResult.rows.length === 0) {
      logger.warn('⚠️  Nenhuma tabela principal encontrada. Execute as migrações primeiro.');
    } else {
      tablesResult.rows.forEach(row => {
        const multiTenant = row.has_tenant_id > 0 ? '(multi-tenant)' : '';
        logger.success(`Tabela ${row.table_name} encontrada ${multiTenant}`);
      });
    }
    
    // Teste 4: Verificar RLS (Row Level Security)
    logger.info('🔒 Verificando Row Level Security...');
    try {
      const rlsResult = await pool.query(`
        SELECT schemaname, tablename, rowsecurity
        FROM pg_tables 
        WHERE schemaname = 'public'
        AND tablename IN ('tenants', 'tenant_configs', 'contacts', 'conversation_states')
        ORDER BY tablename
      `);
      
      rlsResult.rows.forEach(row => {
        if (row.rowsecurity) {
          logger.success(`RLS habilitado na tabela ${row.tablename}`);
        } else {
          logger.warn(`⚠️  RLS não habilitado na tabela ${row.tablename}`);
        }
      });
    } catch (error) {
      logger.warn('⚠️  Não foi possível verificar RLS (versão do PostgreSQL pode não suportar)');
    }
    
    // Teste 5: Testar funções customizadas
    logger.info('⚙️  Testando funções customizadas...');
    try {
      await pool.query("SELECT set_tenant_id('test-tenant')");
      const tenantResult = await pool.query("SELECT get_current_tenant_id() as current_tenant");
      logger.success('Funções de tenant funcionando', {
        current_tenant: tenantResult.rows[0].current_tenant
      });
    } catch (error) {
      logger.warn('⚠️  Funções de tenant não encontradas. Execute a migração 023_supabase_setup.sql');
    }
    
    // Teste 6: Performance básica
    logger.info('⚡ Testando performance básica...');
    const startTime = Date.now();
    await pool.query('SELECT COUNT(*) FROM information_schema.tables');
    const queryTime = Date.now() - startTime;
    
    if (queryTime < 100) {
      logger.success(`Query executada em ${queryTime}ms`);
    } else if (queryTime < 500) {
      logger.warn(`⚠️  Query executada em ${queryTime}ms (aceitável)`);
    } else {
      logger.error(`❌ Query lenta: ${queryTime}ms`);
    }
    
    // Teste 7: Verificar configurações do Supabase
    if (isSupabase) {
      logger.info('☁️  Verificando configurações específicas do Supabase...');
      try {
        const configResult = await pool.query(`
          SELECT name, setting, unit, context 
          FROM pg_settings 
          WHERE name IN ('max_connections', 'shared_buffers', 'work_mem', 'timezone')
          ORDER BY name
        `);
        
        configResult.rows.forEach(row => {
          logger.info(`${row.name}: ${row.setting}${row.unit || ''}`);
        });
      } catch (error) {
        logger.warn('⚠️  Não foi possível verificar configurações do PostgreSQL');
      }
    }
    
    logger.success('🎉 Todos os testes concluídos com sucesso!');
    logger.info('📝 Próximos passos:');
    logger.info('   1. Execute as migrações se ainda não executou');
    logger.info('   2. Configure as variáveis de ambiente de produção');
    logger.info('   3. Teste a aplicação completa');
    
  } catch (error) {
    logger.error('❌ Erro durante os testes:', {
      message: error.message,
      code: error.code,
      detail: error.detail
    });
    
    // Sugestões baseadas no tipo de erro
    if (error.code === 'ENOTFOUND') {
      logger.info('💡 Sugestão: Verifique se a URL do banco está correta');
    } else if (error.code === 'ECONNREFUSED') {
      logger.info('💡 Sugestão: Verifique se o Supabase está acessível e as credenciais estão corretas');
    } else if (error.code === '28P01') {
      logger.info('💡 Sugestão: Verifique a senha do banco de dados');
    } else if (error.code === '3D000') {
      logger.info('💡 Sugestão: Verifique se o nome do banco está correto');
    }
    
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Executar teste se chamado diretamente
if (require.main === module) {
  testSupabaseConnection().catch(error => {
    logger.error('Erro não tratado:', error);
    process.exit(1);
  });
}

module.exports = { testSupabaseConnection };