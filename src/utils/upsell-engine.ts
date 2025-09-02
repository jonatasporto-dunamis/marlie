import logger from '../utils/logger';
import { pg } from '../db/index';
// import { query } from '../db/index'; // Função não disponível no módulo db/index

// Interface para dados de upsell
export interface UpsellSuggestion {
  serviceId: number;
  serviceName: string;
  additionalPrice: number;
  description: string;
  combinedPrice?: number;
}

export interface UpsellContext {
  tenantId: string;
  phone: string;
  selectedServiceName: string;
  selectedServicePrice: number;
  conversationId?: string;
}

// Mapeamento de serviços complementares
const SERVICE_UPSELLS: Record<string, UpsellSuggestion[]> = {
  'cutilagem': [
    {
      serviceId: 0, // Será resolvido dinamicamente
      serviceName: 'esmaltação',
      additionalPrice: 15,
      description: 'Que tal finalizar com uma esmaltação? Fica perfeito!'
    }
  ],
  'manicure': [
    {
      serviceId: 0,
      serviceName: 'design de unhas',
      additionalPrice: 20,
      description: 'Quer deixar suas unhas ainda mais especiais com um design?'
    }
  ],
  'pedicure': [
    {
      serviceId: 0,
      serviceName: 'esfoliação dos pés',
      additionalPrice: 25,
      description: 'Que tal uma esfoliação para deixar seus pés ainda mais macios?'
    }
  ],
  'corte de cabelo': [
    {
      serviceId: 0,
      serviceName: 'escova',
      additionalPrice: 30,
      description: 'Quer finalizar com uma escova para um acabamento perfeito?'
    },
    {
      serviceId: 0,
      serviceName: 'hidratação',
      additionalPrice: 40,
      description: 'Que tal uma hidratação para nutrir seus cabelos?'
    }
  ],
  'design de sobrancelha': [
    {
      serviceId: 0,
      serviceName: 'tintura de sobrancelha',
      additionalPrice: 15,
      description: 'Quer realçar ainda mais com uma tintura?'
    }
  ],
  'limpeza de pele': [
    {
      serviceId: 0,
      serviceName: 'hidratação facial',
      additionalPrice: 35,
      description: 'Que tal finalizar com uma hidratação para nutrir sua pele?'
    }
  ]
};

// Classe para gerenciar upsells
export class UpsellEngine {
  private tenantId: string;

  constructor(tenantId: string) {
    this.tenantId = tenantId;
  }

  /**
   * Verifica se o usuário já recebeu upsell nesta conversa
   */
  private async hasReceivedUpsellInConversation(phone: string): Promise<boolean> {
    try {
      const result = await pg?.query(
        `SELECT COUNT(*) as count FROM upsell_tracking 
         WHERE tenant_id = $1 AND phone = $2 
         AND created_at > NOW() - INTERVAL '24 hours'`,
        [this.tenantId, phone]
      );
      
      if (!result) return false;
      
      return result.rows[0]?.count > 0;
    } catch (error) {
      logger.error('Erro ao verificar histórico de upsell:', error);
      return false;
    }
  }

  /**
   * Registra tentativa de upsell
   */
  private async recordUpsellAttempt(
    phone: string, 
    originalService: string, 
    suggestedService: string,
    accepted: boolean
  ): Promise<void> {
    try {
      if (!pg) return;
      
      await pg.query(
        `INSERT INTO upsell_tracking 
         (tenant_id, phone, original_service, suggested_service, accepted, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [this.tenantId, phone, originalService, suggestedService, accepted]
      );
    } catch (error) {
      logger.error('Erro ao registrar tentativa de upsell:', error);
    }
  }

  /**
   * Busca serviço complementar no catálogo
   */
  private async findComplementaryService(serviceName: string): Promise<{ id: number; price: number } | null> {
    try {
      // Primeiro tentar no catálogo local
      const localResult = await pg?.query(
        `SELECT servico_id as id, valor as price 
         FROM servicos_catalog 
         WHERE tenant_id = $1 AND LOWER(servico_nome) LIKE LOWER($2)
         LIMIT 1`,
        [this.tenantId, `%${serviceName}%`]
      );
      
      if (!localResult) return null;
      
      if (localResult.rows.length > 0) {
        return {
          id: localResult.rows[0].id,
          price: parseFloat(localResult.rows[0].price) || 0
        };
      }
      
      return null;
    } catch (error) {
      logger.error('Erro ao buscar serviço complementar:', error);
      return null;
    }
  }

  /**
   * Gera sugestão de upsell contextual
   */
  async generateUpsellSuggestion(context: UpsellContext): Promise<string | null> {
    try {
      // Verificar se já recebeu upsell recentemente
      const hasRecentUpsell = await this.hasReceivedUpsellInConversation(context.phone);
      if (hasRecentUpsell) {
        return null;
      }

      // Normalizar nome do serviço
      const normalizedService = context.selectedServiceName.toLowerCase().trim();
      
      // Buscar upsells disponíveis para o serviço
      const availableUpsells = SERVICE_UPSELLS[normalizedService] || [];
      
      if (availableUpsells.length === 0) {
        return null;
      }

      // Selecionar primeiro upsell disponível
      const selectedUpsell = availableUpsells[0];
      
      // Buscar informações do serviço complementar
      const serviceInfo = await this.findComplementaryService(selectedUpsell.serviceName);
      
      if (!serviceInfo) {
        return null;
      }

      // Calcular preço combinado
      const additionalPrice = serviceInfo.price || selectedUpsell.additionalPrice;
      const combinedPrice = context.selectedServicePrice + additionalPrice;
      
      // Registrar tentativa de upsell
      await this.recordUpsellAttempt(
        context.phone,
        context.selectedServiceName,
        selectedUpsell.serviceName,
        false // Ainda não foi aceito
      );

      // Gerar mensagem de upsell
      const upsellMessage = `${selectedUpsell.description}\n\n` +
        `💰 *${selectedUpsell.serviceName}* por apenas +R$ ${additionalPrice.toFixed(2)}\n` +
        `📋 *Total:* R$ ${combinedPrice.toFixed(2)} (${context.selectedServiceName} + ${selectedUpsell.serviceName})\n\n` +
        `Quer adicionar? Digite *sim* para incluir ou *não* para continuar apenas com ${context.selectedServiceName}.`;

      return upsellMessage;
    } catch (error) {
      logger.error('Erro ao gerar sugestão de upsell:', error);
      return null;
    }
  }

  /**
   * Processa resposta do usuário ao upsell
   */
  async processUpsellResponse(
    response: string, 
    context: UpsellContext
  ): Promise<{ accepted: boolean; message: string }> {
    try {
      const normalizedResponse = response.toLowerCase().trim();
      const positiveResponses = ['sim', 'yes', 'quero', 'aceito', 'vamos', 'ok', 'pode ser'];
      const negativeResponses = ['não', 'nao', 'no', 'não quero', 'só isso', 'so isso'];
      
      const accepted = positiveResponses.some(pos => normalizedResponse.includes(pos));
      const declined = negativeResponses.some(neg => normalizedResponse.includes(neg));
      
      if (accepted) {
        // Registrar aceitação
        await this.recordUpsellAttempt(
          context.phone,
          context.selectedServiceName,
          'upsell_service', // Será atualizado com o serviço específico
          true
        );
        
        return {
          accepted: true,
          message: `Perfeito! Vou incluir os dois serviços no seu agendamento. 😊`
        };
      } else if (declined) {
        return {
          accepted: false,
          message: `Sem problemas! Vamos continuar apenas com ${context.selectedServiceName}. 😊`
        };
      } else {
        // Resposta ambígua
        return {
          accepted: false,
          message: `Não entendi bem. Quer adicionar o serviço extra? Digite *sim* ou *não*.`
        };
      }
    } catch (error) {
      logger.error('Erro ao processar resposta de upsell:', error);
      return {
        accepted: false,
        message: `Vamos continuar apenas com ${context.selectedServiceName}. 😊`
      };
    }
  }

  /**
   * Obtém métricas de upsell
   */
  async getUpsellMetrics(days: number = 30): Promise<{
    totalAttempts: number;
    totalAccepted: number;
    conversionRate: number;
    averageAdditionalRevenue: number;
  }> {
    try {
      if (!pg) {
        return {
          totalAttempts: 0,
          totalAccepted: 0,
          conversionRate: 0,
          averageAdditionalRevenue: 0
        };
      }
      
      const result = await pg.query(
        `SELECT 
           COUNT(*) as total_attempts,
           COUNT(CASE WHEN accepted = true THEN 1 END) as total_accepted
         FROM upsell_tracking 
         WHERE tenant_id = $1 
         AND created_at > NOW() - INTERVAL '${days} days'`,
        [this.tenantId]
      );
      
      const totalAttempts = parseInt(result.rows[0]?.total_attempts) || 0;
      const totalAccepted = parseInt(result.rows[0]?.total_accepted) || 0;
      const conversionRate = totalAttempts > 0 ? (totalAccepted / totalAttempts) * 100 : 0;
      
      return {
        totalAttempts,
        totalAccepted,
        conversionRate,
        averageAdditionalRevenue: 0 // Seria calculado com dados de preços
      };
    } catch (error) {
      logger.error('Erro ao obter métricas de upsell:', error);
      return {
        totalAttempts: 0,
        totalAccepted: 0,
        conversionRate: 0,
        averageAdditionalRevenue: 0
      };
    }
  }
}

// Função auxiliar para detectar se o usuário está respondendo a um upsell
export function isUpsellResponse(text: string): boolean {
  const upsellKeywords = [
    'sim', 'não', 'nao', 'quero', 'aceito', 'vamos', 
    'ok', 'pode ser', 'não quero', 'só isso', 'so isso'
  ];
  
  const normalizedText = text.toLowerCase().trim();
  return upsellKeywords.some(keyword => normalizedText.includes(keyword));
}