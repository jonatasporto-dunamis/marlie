const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Arquivos essenciais que implementamos
const essentialFiles = [
  'src/services/catalog-service.ts',
  'src/services/trinks-service.ts', 
  'src/services/validation-service.ts',
  'src/services/response-templates.ts',
  'src/services/human-handoff.ts',
  'src/services/message-buffer.ts',
  'src/core/nlp-patterns.ts'
];

console.log('🚀 Compilando arquivos essenciais do Agente Marlie...');

// Criar diretório dist se não existir
if (!fs.existsSync('dist')) {
  fs.mkdirSync('dist', { recursive: true });
}

if (!fs.existsSync('dist/services')) {
  fs.mkdirSync('dist/services', { recursive: true });
}

if (!fs.existsSync('dist/core')) {
  fs.mkdirSync('dist/core', { recursive: true });
}

try {
  // Compilar cada arquivo essencial individualmente
  for (const file of essentialFiles) {
    console.log(`📝 Compilando ${file}...`);
    const outputDir = path.dirname(file.replace('src/', 'dist/'));
    execSync(`npx tsc ${file} --outDir ${outputDir} --skipLibCheck --target ES2020 --module commonjs --esModuleInterop --allowSyntheticDefaultImports --strict false`, { stdio: 'inherit' });
  }
  
  console.log('✅ Compilação dos arquivos essenciais concluída!');
  
  // Tentar compilar o resto com --skipLibCheck
  console.log('🔧 Tentando compilar arquivos restantes...');
  try {
    execSync('npx tsc --skipLibCheck --noEmitOnError', { stdio: 'inherit' });
    console.log('✅ Compilação completa bem-sucedida!');
  } catch (error) {
    console.log('⚠️ Alguns arquivos falharam na compilação, mas os essenciais estão prontos.');
  }
  
} catch (error) {
  console.error('❌ Erro na compilação:', error.message);
  process.exit(1);
}