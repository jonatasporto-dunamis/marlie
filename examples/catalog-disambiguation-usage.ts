/**
 * Exemplo de uso da desambiguação orientada por catálogo
 * 
 * Este arquivo demonstra como integrar o sistema de desambiguação
 * com diferentes cenários de uso na máquina de estados.
 */

import { Request, Response } from 'express';
import { 
  getCatalogDisambiguationService, 
  DisambiguationContext 
} from '../src/services/catalog-disambiguation-service';
import { getDisambiguationMiddleware } from '../src/middleware/catalog-disambiguation-middleware';
import { getCatalogStateMachineIntegration } from '../src/integrations/catalog-state-machine';

// =============================================================================
// EXEMPLO 1: USO DIRETO DO SERVIÇO DE DESAMBIGUAÇÃO
// =============================================================================

/**
 * Exemplo básico de como usar o serviço de desambiguação diretamente
 */
export async function exemploUsoBasico() {
  const service = getCatalogDisambiguationService();
  
  // Testar se entrada é ambígua
  const entradaAmbigua = 'cabelo';
  const isAmbiguous = service.isAmbiguous(entradaAmbigua);
  
  console.log(`"${entradaAmbigua}" é ambígua: ${isAmbiguous}`);
  
  if (isAmbiguous) {
    // Iniciar processo de desambiguação
    const resultado = await service.startDisambiguation(entradaAmbigua, {
      session_id: 'exemplo-session-123',
      user_phone: 'user-456'
    });
    
    console.log('Resultado da desambiguação:', resultado);
    
    // Simular escolha do usuário
    if (resultado.success && resultado.slots_to_set?.options && resultado.slots_to_set.options.length > 0) {
      // Criar contexto de desambiguação
      const context: DisambiguationContext = {
        original_input: entradaAmbigua,
        normalized_input: service.normalizeServiceName(entradaAmbigua),
        options: resultado.slots_to_set.options,
        attempt_count: 1,
        user_phone: 'user-456',
        session_id: 'exemplo-session-123'
      };
      
      const escolha = await service.processNumericChoice(
        '2', // Usuário escolheu opção 2
        resultado.slots_to_set.options,
        context
      );
      
      console.log('Escolha processada:', escolha);
    }
  }
}

// =============================================================================
// EXEMPLO 2: INTEGRAÇÃO COM MIDDLEWARE
// =============================================================================

/**
 * Exemplo de como usar o middleware em uma rota Express
 */
export function exemploMiddlewareExpress() {
  const middleware = getDisambiguationMiddleware();
  
  return async (req: Request, res: Response) => {
    try {
      const { message, sessionId } = req.body;
      
      // Verificar se há sessão ativa de desambiguação
      const session = await middleware.getDisambiguationSession(sessionId);
      const sessionExists = !!session;
      
      if (sessionExists) {
        // Processar mensagem no contexto da desambiguação
        const stateMachineContext = {
          current_state: 'CATALOG_WAIT_CHOICE',
          slots: req.body.slots || {},
          user_phone: req.body.user_phone || sessionId,
          session_id: sessionId,
          conversation_id: req.body.conversation_id || sessionId,
          input: {
            text: message,
            type: 'text' as const,
            timestamp: new Date()
          },
          metadata: req.body.metadata || {}
        };
        
        // Simular processamento do middleware
        const result = { status: 'processed', context: stateMachineContext };
        
        res.json({
          status: 'success',
          data: result
        });
        
      } else {
        // Verificar se mensagem requer desambiguação
        const service = getCatalogDisambiguationService();
        const isAmbiguous = service.isAmbiguous(message);
        
        if (isAmbiguous) {
          // Iniciar nova sessão de desambiguação
          const result = await service.startDisambiguation(message, {
            session_id: sessionId,
            user_phone: req.body.user_phone || sessionId,
            return_state: req.body.currentState || 'UNKNOWN'
          });
          
          res.json({
            status: 'disambiguation_started',
            data: result
          });
          
        } else {
          // Continuar fluxo normal
          res.json({
            status: 'no_disambiguation_needed',
            message: 'Entrada não requer desambiguação'
          });
        }
      }
      
    } catch (error) {
      console.error('Erro no middleware:', error);
      res.status(500).json({
        status: 'error',
        message: 'Erro interno'
      });
    }
  };
}

// =============================================================================
// EXEMPLO 3: INTEGRAÇÃO COMPLETA COM MÁQUINA DE ESTADOS
// =============================================================================

/**
 * Exemplo de como usar a integração completa com máquina de estados
 */
export function exemploIntegracaoCompleta() {
  const integration = getCatalogStateMachineIntegration();
  
  return async (req: Request, res: Response) => {
    try {
      // O middleware de integração já foi aplicado
      // Aqui processamos o resultado
      
      const context = {
        currentState: req.body.currentState,
        sessionId: req.body.sessionId,
        slots: req.body.slots || {},
        userId: req.body.userId,
        metadata: req.body.metadata || {}
      };
      
      // Obter estatísticas da integração
      const stats = await integration.getIntegrationStats();
      
      console.log('Estatísticas da integração:', stats);
      
      // Simular processamento da máquina de estados
      const response = {
        status: 'success',
        data: {
          state: context.currentState,
          message: 'Processado com sucesso',
          slots: context.slots,
          integration_stats: stats
        }
      };
      
      res.json(response);
      
    } catch (error) {
      console.error('Erro na integração:', error);
      res.status(500).json({
        status: 'error',
        message: 'Erro na integração com máquina de estados'
      });
    }
  };
}

// =============================================================================
// EXEMPLO 4: CENÁRIOS DE TESTE
// =============================================================================

/**
 * Cenários de teste para validar funcionalidade
 */
export async function exemplosCenariosTeste() {
  const service = getCatalogDisambiguationService();
  
  const cenarios = [
    {
      nome: 'Entrada ambígua - cabelo',
      entrada: 'cabelo',
      esperado: { ambigua: true, opcoes: 3 }
    },
    {
      nome: 'Entrada específica - corte masculino',
      entrada: 'corte masculino',
      esperado: { ambigua: false, opcoes: 1 }
    },
    {
      nome: 'Entrada numérica - escolha',
      entrada: '2',
      esperado: { numerica: true }
    },
    {
      nome: 'Entrada inválida',
      entrada: 'xyz123',
      esperado: { ambigua: false, opcoes: 0 }
    }
  ];
  
  console.log('\n=== EXECUTANDO CENÁRIOS DE TESTE ===\n');
  
  for (const cenario of cenarios) {
    console.log(`Testando: ${cenario.nome}`);
    console.log(`Entrada: "${cenario.entrada}"`);
    
    try {
      // Testar ambiguidade
      const isAmbiguous = service.isAmbiguous(cenario.entrada);
      console.log(`Ambígua: ${isAmbiguous}`);
      
      // Testar se é escolha numérica
      const isNumeric = service.isNumericChoice(cenario.entrada);
      console.log(`Numérica: ${isNumeric}`);
      
      // Testar normalização
      const normalized = service.normalizeServiceName(cenario.entrada);
      console.log(`Normalizada: "${normalized}"`);
      
      // Se ambígua, testar busca
      if (isAmbiguous) {
        const results = await service.getTopServicesByCategory(normalized, 3);
        console.log(`Opções encontradas: ${results.length}`);
        
        if (results.length > 0) {
          console.log('Primeira opção:', results[0]);
        }
      }
      
      console.log('✅ Cenário executado com sucesso\n');
      
    } catch (error) {
      console.log(`❌ Erro no cenário: ${error.message}\n`);
    }
  }
}

// =============================================================================
// EXEMPLO 5: MONITORAMENTO E MÉTRICAS
// =============================================================================

/**
 * Exemplo de como monitorar métricas da desambiguação
 */
export async function exemploMonitoramento() {
  const service = getCatalogDisambiguationService();
  const middleware = getDisambiguationMiddleware();
  const integration = getCatalogStateMachineIntegration();
  
  console.log('\n=== MÉTRICAS DE DESAMBIGUAÇÃO ===\n');
  
  try {
    // Estatísticas do serviço
    const serviceStats = await service.getStats();
    console.log('Estatísticas do serviço:', JSON.stringify(serviceStats, null, 2));
    
    // Estatísticas do middleware
    const middlewareStats = await middleware.getStats();
    console.log('Estatísticas do middleware:', JSON.stringify(middlewareStats, null, 2));
    
    // Estatísticas da integração
    const integrationStats = await integration.getIntegrationStats();
    console.log('Estatísticas da integração:', JSON.stringify(integrationStats, null, 2));
    
  } catch (error) {
    console.error('Erro ao obter métricas:', error);
  }
}

// =============================================================================
// EXEMPLO 6: LIMPEZA E MANUTENÇÃO
// =============================================================================

/**
 * Exemplo de operações de limpeza e manutenção
 */
export async function exemploLimpeza() {
  const service = getCatalogDisambiguationService();
  const middleware = getDisambiguationMiddleware();
  
  console.log('\n=== OPERAÇÕES DE LIMPEZA ===\n');
  
  try {
    // Limpar cache específico
    await service.clearCache('disambiguation:*');
    console.log('✅ Cache de desambiguação limpo');
    
    // Limpar todas as sessões
    const clearedSessions = await middleware.clearAllSessions();
    console.log(`✅ ${clearedSessions} sessões limpas`);
    
    // Limpar todas as sessões (não há método clearExpiredSessions específico)
    const allSessions = await middleware.clearAllSessions();
    console.log(`✅ ${allSessions} sessões removidas`);
    
  } catch (error) {
    console.error('Erro nas operações de limpeza:', error);
  }
}

// =============================================================================
// FUNÇÃO PRINCIPAL PARA EXECUTAR EXEMPLOS
// =============================================================================

/**
 * Executa todos os exemplos
 */
export async function executarExemplos() {
  console.log('🚀 Iniciando exemplos de desambiguação por catálogo\n');
  
  try {
    await exemploUsoBasico();
    await exemplosCenariosTeste();
    await exemploMonitoramento();
    await exemploLimpeza();
    
    console.log('\n✅ Todos os exemplos executados com sucesso!');
    
  } catch (error) {
    console.error('\n❌ Erro ao executar exemplos:', error);
  }
}

// Executar se chamado diretamente
if (require.main === module) {
  executarExemplos().catch(console.error);
}