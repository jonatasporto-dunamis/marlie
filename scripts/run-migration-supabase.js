require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  try {
    const migrationName = process.argv[2];
    if (!migrationName) {
      console.error('❌ Por favor, forneça o nome da migração como parâmetro');
      console.log('Uso: node scripts/run-migration-supabase.js <nome-da-migração>');
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
    
    // Criar cliente Supabase
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // Dividir o SQL em comandos individuais (separados por ;)
    const commands = migrationSQL
      .split(';')
      .map(cmd => cmd.trim())
      .filter(cmd => cmd.length > 0 && !cmd.startsWith('--'));
    
    console.log(`🔧 Executando ${commands.length} comandos SQL...`);
    
    // Executar cada comando
    for (let i = 0; i < commands.length; i++) {
      const command = commands[i];
      if (command.trim()) {
        console.log(`📝 Executando comando ${i + 1}/${commands.length}...`);
        
        try {
          const { data, error } = await supabase.rpc('exec_sql', {
            sql_query: command
          });
          
          if (error) {
            console.error(`❌ Erro no comando ${i + 1}:`, error);
            // Continuar com os próximos comandos mesmo se um falhar
          } else {
            console.log(`✅ Comando ${i + 1} executado com sucesso`);
          }
        } catch (cmdError) {
          console.error(`❌ Erro no comando ${i + 1}:`, cmdError.message);
          // Continuar com os próximos comandos
        }
      }
    }
    
    console.log('🎉 Migração concluída!');
    
  } catch (error) {
    console.error('❌ Erro durante a migração:', error.message);
    process.exit(1);
  }
}

runMigration();