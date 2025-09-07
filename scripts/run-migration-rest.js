require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  try {
    const migrationName = process.argv[2];
    if (!migrationName) {
      console.error('❌ Por favor, forneça o nome da migração como parâmetro');
      console.log('Uso: node scripts/run-migration-rest.js <nome-da-migração>');
      process.exit(1);
    }

    console.log(`🚀 Executando migração: ${migrationName}`);
    
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados');
    }
    
    // Ler arquivo de migração
    const migrationPath = path.join(__dirname, '..', 'migrations', migrationName);
    if (!fs.existsSync(migrationPath)) {
      throw new Error(`Arquivo de migração não encontrado: ${migrationPath}`);
    }
    
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
    console.log(`📄 Migração carregada: ${migrationSQL.length} caracteres`);
    
    // Configurar headers para autenticação
    const headers = {
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      'apikey': supabaseKey
    };
    
    // Tentar executar via API REST do Supabase
    console.log('🔧 Tentando executar migração via API REST...');
    
    try {
      // Primeiro, vamos testar se conseguimos acessar alguma tabela
      const testResponse = await axios.get(
        `${supabaseUrl}/rest/v1/`,
        { headers }
      );
      
      console.log('✅ Conexão com API REST estabelecida');
      console.log('📊 Resposta da API:', testResponse.status);
      
    } catch (apiError) {
      console.log('⚠️ Erro na API REST:', apiError.response?.data || apiError.message);
    }
    
    // Como alternativa, vamos criar um arquivo de migração que pode ser executado manualmente
    const outputPath = path.join(__dirname, '..', 'temp_migration_output.sql');
    fs.writeFileSync(outputPath, migrationSQL);
    
    console.log('📝 Migração preparada!');
    console.log('🔍 Para executar manualmente:');
    console.log('1. Acesse o painel do Supabase: https://supabase.com/dashboard/project/dlrkrrsbtvlmcirtbcop');
    console.log('2. Vá para "SQL Editor"');
    console.log('3. Cole o conteúdo do arquivo:', outputPath);
    console.log('4. Execute o SQL');
    
    console.log('\n📋 Conteúdo da migração:');
    console.log('=' .repeat(50));
    console.log(migrationSQL.substring(0, 500) + '...');
    console.log('=' .repeat(50));
    
  } catch (error) {
    console.error('❌ Erro durante a migração:', error.message);
    process.exit(1);
  }
}

runMigration();