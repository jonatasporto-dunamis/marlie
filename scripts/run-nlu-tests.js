#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configurações dos testes de NLU
const NLU_TEST_CONFIG = {
  testFile: 'src/__tests__/nlu-regression.test.ts',
  coverageThreshold: {
    statements: 80,
    branches: 70,
    functions: 80,
    lines: 80
  },
  maxTestTime: 30000, // 30 segundos
  retryAttempts: 2
};

function runCommand(command, options = {}) {
  try {
    console.log(`🔄 Executando: ${command}`);
    const result = execSync(command, {
      stdio: 'inherit',
      encoding: 'utf8',
      ...options
    });
    return { success: true, result };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function checkPrerequisites() {
  console.log('🔍 Verificando pré-requisitos...');
  
  // Verificar se o dataset existe
  const datasetPath = path.join(__dirname, '..', 'src', '__tests__', 'nlu-dataset.json');
  if (!fs.existsSync(datasetPath)) {
    console.error('❌ Dataset NLU não encontrado:', datasetPath);
    process.exit(1);
  }
  
  // Verificar se o arquivo de teste existe
  const testPath = path.join(__dirname, '..', NLU_TEST_CONFIG.testFile);
  if (!fs.existsSync(testPath)) {
    console.error('❌ Arquivo de teste NLU não encontrado:', testPath);
    process.exit(1);
  }
  
  console.log('✅ Pré-requisitos verificados');
}

function runNLUTests() {
  console.log('🧪 Executando testes de regressão NLU...');
  
  const testCommand = `npx jest ${NLU_TEST_CONFIG.testFile} --verbose --coverage --detectOpenHandles`;
  
  let attempt = 1;
  while (attempt <= NLU_TEST_CONFIG.retryAttempts) {
    console.log(`\n📋 Tentativa ${attempt}/${NLU_TEST_CONFIG.retryAttempts}`);
    
    const result = runCommand(testCommand);
    
    if (result.success) {
      console.log('✅ Testes de NLU executados com sucesso!');
      return true;
    } else {
      console.warn(`⚠️ Tentativa ${attempt} falhou:`, result.error);
      attempt++;
      
      if (attempt <= NLU_TEST_CONFIG.retryAttempts) {
        console.log('🔄 Tentando novamente em 3 segundos...');
        execSync('timeout 3', { stdio: 'ignore' }).catch(() => {});
      }
    }
  }
  
  console.error('❌ Todos os testes de NLU falharam após', NLU_TEST_CONFIG.retryAttempts, 'tentativas');
  return false;
}

function runSpecificTests() {
  console.log('🎯 Executando testes específicos por categoria...');
  
  const categories = [
    'Intent and Slots Extraction',
    'Dialect Recognition', 
    'Shortcut Detection',
    'Service Name Extraction',
    'Date and Time Extraction',
    'Error Handling'
  ];
  
  const results = {};
  
  categories.forEach(category => {
    console.log(`\n🔍 Testando categoria: ${category}`);
    const command = `npx jest ${NLU_TEST_CONFIG.testFile} --testNamePattern="${category}" --silent`;
    const result = runCommand(command, { stdio: 'pipe' });
    results[category] = result.success;
    
    if (result.success) {
      console.log(`✅ ${category}: PASSOU`);
    } else {
      console.log(`❌ ${category}: FALHOU`);
    }
  });
  
  return results;
}

function generateReport(results) {
  console.log('\n📊 Gerando relatório de testes NLU...');
  
  const reportPath = path.join(__dirname, '..', 'reports', 'nlu-test-report.json');
  const reportDir = path.dirname(reportPath);
  
  // Criar diretório de relatórios se não existir
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }
  
  const report = {
    timestamp: new Date().toISOString(),
    testResults: results,
    summary: {
      totalCategories: Object.keys(results).length,
      passedCategories: Object.values(results).filter(Boolean).length,
      failedCategories: Object.values(results).filter(r => !r).length
    },
    config: NLU_TEST_CONFIG
  };
  
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log('📄 Relatório salvo em:', reportPath);
  
  return report;
}

function main() {
  console.log('🚀 Iniciando testes de regressão NLU para Marcleia Abade');
  console.log('=' .repeat(60));
  
  try {
    // 1. Verificar pré-requisitos
    checkPrerequisites();
    
    // 2. Executar todos os testes
    const allTestsSuccess = runNLUTests();
    
    // 3. Executar testes específicos por categoria
    const categoryResults = runSpecificTests();
    
    // 4. Gerar relatório
    const report = generateReport(categoryResults);
    
    // 5. Resumo final
    console.log('\n' + '=' .repeat(60));
    console.log('📋 RESUMO DOS TESTES NLU');
    console.log('=' .repeat(60));
    console.log(`✅ Categorias aprovadas: ${report.summary.passedCategories}`);
    console.log(`❌ Categorias reprovadas: ${report.summary.failedCategories}`);
    console.log(`📊 Taxa de sucesso: ${Math.round((report.summary.passedCategories / report.summary.totalCategories) * 100)}%`);
    
    if (allTestsSuccess && report.summary.failedCategories === 0) {
      console.log('\n🎉 Todos os testes de NLU passaram com sucesso!');
      process.exit(0);
    } else {
      console.log('\n⚠️ Alguns testes falharam. Verifique o relatório para detalhes.');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('💥 Erro durante execução dos testes:', error.message);
    process.exit(1);
  }
}

// Executar apenas se chamado diretamente
if (require.main === module) {
  main();
}

module.exports = {
  runNLUTests,
  runSpecificTests,
  generateReport,
  NLU_TEST_CONFIG
};