require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

async function testSupabaseConnection() {
  try {
    console.log('🚀 Testando conexão direta com Supabase...');
    
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados');
    }
    
    console.log('📡 URL:', supabaseUrl);
    console.log('🔑 Service Role Key configurada:', supabaseKey ? 'Sim' : 'Não');
    
    // Criar cliente Supabase
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // Testar uma query simples
    console.log('🔍 Executando query de teste...');
    const { data, error } = await supabase
      .from('information_schema.tables')
      .select('table_name')
      .limit(1);
    
    if (error) {
      console.error('❌ Erro na query:', error);
      return;
    }
    
    console.log('✅ Conexão com Supabase bem-sucedida!');
    console.log('📊 Dados de teste:', data);
    
    // Testar execução de SQL direto
    console.log('🔧 Testando execução de SQL direto...');
    const { data: sqlData, error: sqlError } = await supabase.rpc('version');
    
    if (sqlError) {
      console.log('⚠️ SQL direto não disponível:', sqlError.message);
    } else {
      console.log('✅ SQL direto funcionando:', sqlData);
    }
    
  } catch (error) {
    console.error('❌ Erro durante o teste:', error.message);
    process.exit(1);
  }
}

testSupabaseConnection();