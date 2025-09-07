const Sequencer = require('@jest/test-sequencer').default;

class IntegrationTestSequencer extends Sequencer {
  /**
   * Ordena os testes de integração para execução otimizada
   * 1. Testes básicos de fluxo primeiro
   * 2. Testes de edge cases por último
   * 3. Testes de performance no final
   */
  sort(tests) {
    // Cria uma cópia do array para não modificar o original
    const testsCopy = Array.from(tests);
    
    return testsCopy.sort((testA, testB) => {
      const pathA = testA.path;
      const pathB = testB.path;
      
      // Prioridade 1: Testes de fluxos completos
      if (pathA.includes('complete-flows') && !pathB.includes('complete-flows')) {
        return -1;
      }
      if (!pathA.includes('complete-flows') && pathB.includes('complete-flows')) {
        return 1;
      }
      
      // Prioridade 2: Testes de edge cases
      if (pathA.includes('edge-cases') && !pathB.includes('edge-cases')) {
        return 1;
      }
      if (!pathA.includes('edge-cases') && pathB.includes('edge-cases')) {
        return -1;
      }
      
      // Prioridade 3: Testes RLS (já existentes)
      if (pathA.includes('rls') && !pathB.includes('rls')) {
        return -1;
      }
      if (!pathA.includes('rls') && pathB.includes('rls')) {
        return 1;
      }
      
      // Ordem alfabética para o resto
      return pathA.localeCompare(pathB);
    });
  }
}

module.exports = IntegrationTestSequencer;