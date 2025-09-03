import logger from '../utils/logger';
import { MetricsHelper } from '../metrics';
import { createHash } from 'crypto';

// Configurações do A/B test
interface ABTestConfig {
  enabled: boolean;
  trafficSplit: number; // Porcentagem para variante A (0-100)
  targetMessages: number; // Meta de mensagens até agendamento
}

// Variantes do A/B test
export enum ABVariant {
  CONTROL = 'control',     // Sem sugestões proativas
  TREATMENT = 'treatment'  // Com sugestões proativas
}

// Tipos de sugestão proativa
export enum SuggestionType {
  TIME_SLOTS = 'time_slots',
  SERVICES = 'services',
  PROFESSIONALS = 'professionals',
  QUICK_ACTIONS = 'quick_actions'
}

/**
 * Obtém configuração do A/B test a partir das variáveis de ambiente
 */
function getABTestConfig(): ABTestConfig {
  const enabled = process.env.SUGESTOES_PROATIVAS === 'on';
  const trafficSplit = parseInt(process.env.AB_TRAFFIC_SPLIT || '50');
  const targetMessages = parseInt(process.env.UX_TARGET_MSGS || '7');
  
  return {
    enabled,
    trafficSplit: Math.max(0, Math.min(100, trafficSplit)),
    targetMessages: Math.max(1, targetMessages)
  };
}

/**
 * Determina a variante do A/B test para um usuário
 * Usa hash consistente baseado no phone para garantir que o mesmo usuário
 * sempre receba a mesma variante
 */
export function getABVariant(phone: string, tenantId: string): ABVariant {
  const config = getABTestConfig();
  
  if (!config.enabled) {
    return ABVariant.CONTROL;
  }
  
  // Criar hash consistente baseado no phone + tenant
  const hash = createHash('md5')
    .update(`${phone}:${tenantId}:proactive_suggestions`)
    .digest('hex');
  
  // Converter primeiros 8 caracteres do hash para número
  const hashNumber = parseInt(hash.substring(0, 8), 16);
  const percentage = (hashNumber % 100) + 1; // 1-100
  
  const variant = percentage <= config.trafficSplit ? ABVariant.TREATMENT : ABVariant.CONTROL;
  
  logger.debug('AB test variant determined:', {
    phone,
    tenantId,
    variant,
    percentage,
    trafficSplit: config.trafficSplit
  });
  
  return variant;
}

/**
 * Verifica se sugestões proativas devem ser mostradas
 */
export function shouldShowProactiveSuggestions(
  phone: string, 
  tenantId: string,
  currentStep?: string
): boolean {
  const variant = getABVariant(phone, tenantId);
  
  if (variant === ABVariant.CONTROL) {
    return false;
  }
  
  // Lógica adicional para quando mostrar sugestões
  // Por exemplo, não mostrar em certos steps
  const skipSteps = ['CONFIRMACAO', 'FINALIZADO', 'CANCELADO'];
  if (currentStep && skipSteps.includes(currentStep)) {
    return false;
  }
  
  return true;
}

/**
 * Registra que sugestões proativas foram mostradas
 */
export function trackProactiveSuggestionsShown(
  phone: string,
  tenantId: string,
  suggestionType: SuggestionType,
  count: number = 1
): void {
  const variant = getABVariant(phone, tenantId);
  
  MetricsHelper.incrementProactiveSuggestionsShown(
    tenantId,
    variant,
    suggestionType
  );
  
  logger.info('Proactive suggestions shown:', {
    phone,
    tenantId,
    variant,
    suggestionType,
    count
  });
}

/**
 * Registra que uma sugestão proativa foi clicada/aceita
 */
export function trackProactiveSuggestionClicked(
  phone: string,
  tenantId: string,
  suggestionType: SuggestionType
): void {
  const variant = getABVariant(phone, tenantId);
  
  MetricsHelper.incrementProactiveSuggestionsClicked(
    tenantId,
    variant,
    suggestionType
  );
  
  logger.info('Proactive suggestion clicked:', {
    phone,
    tenantId,
    variant,
    suggestionType
  });
}

/**
 * Registra um passo da conversa para análise de UX
 */
export function trackConversationStep(
  phone: string,
  tenantId: string,
  step: string,
  outcome: 'progress' | 'booking' | 'abandon'
): void {
  const variant = getABVariant(phone, tenantId);
  
  MetricsHelper.incrementConversationSteps(
    tenantId,
    variant,
    outcome
  );
  
  logger.debug('Conversation step tracked:', {
    phone,
    tenantId,
    variant,
    step,
    outcome
  });
}

/**
 * Registra uma conversão (agendamento confirmado)
 */
export function trackConversion(
  phone: string,
  tenantId: string,
  conversionType: 'booking_confirmed' | 'first_try_booking' | 'quick_booking',
  metadata?: {
    stepsCount?: number;
    timeToConversion?: number;
    serviceId?: string;
  }
): void {
  const variant = getABVariant(phone, tenantId);
  
  MetricsHelper.incrementABTestConversions(
    tenantId,
    variant,
    conversionType
  );
  
  // Verificar se atingiu a meta de mensagens
  const config = getABTestConfig();
  if (metadata?.stepsCount && metadata.stepsCount <= config.targetMessages) {
    MetricsHelper.incrementABTestConversions(
      tenantId,
      variant,
      'target_messages_achieved'
    );
  }
  
  logger.info('Conversion tracked:', {
    phone,
    tenantId,
    variant,
    conversionType,
    metadata
  });
}

/**
 * Obtém estatísticas do A/B test para análise
 */
export async function getABTestStats(tenantId: string): Promise<{
  config: ABTestConfig;
  variants: {
    [key in ABVariant]: {
      suggestionsShown: number;
      suggestionsClicked: number;
      conversions: number;
      conversionRate: number;
    }
  };
}> {
  const config = getABTestConfig();
  
  // Em uma implementação real, você buscaria essas métricas do Prometheus
  // Por enquanto, retornamos uma estrutura de exemplo
  return {
    config,
    variants: {
      [ABVariant.CONTROL]: {
        suggestionsShown: 0,
        suggestionsClicked: 0,
        conversions: 0,
        conversionRate: 0
      },
      [ABVariant.TREATMENT]: {
        suggestionsShown: 0,
        suggestionsClicked: 0,
        conversions: 0,
        conversionRate: 0
      }
    }
  };
}

/**
 * Middleware para adicionar informações de A/B test ao contexto da conversa
 */
export function addABTestContext(
  phone: string,
  tenantId: string,
  context: any
): any {
  const variant = getABVariant(phone, tenantId);
  const config = getABTestConfig();
  
  return {
    ...context,
    abTest: {
      variant,
      enabled: config.enabled,
      shouldShowProactive: shouldShowProactiveSuggestions(phone, tenantId, context.currentStep),
      targetMessages: config.targetMessages
    }
  };
}

/**
 * Gera sugestões proativas baseadas no contexto
 */
export function generateProactiveSuggestions(
  phone: string,
  tenantId: string,
  context: {
    currentStep?: string;
    serviceName?: string;
    dateISO?: string;
    period?: string;
    professionalName?: string;
  }
): {
  type: SuggestionType;
  suggestions: string[];
  priority: number;
}[] {
  if (!shouldShowProactiveSuggestions(phone, tenantId, context.currentStep)) {
    return [];
  }
  
  const suggestions: {
    type: SuggestionType;
    suggestions: string[];
    priority: number;
  }[] = [];
  
  // Sugestões baseadas no step atual
  switch (context.currentStep) {
    case 'SERVICE_NAME':
      suggestions.push({
        type: SuggestionType.SERVICES,
        suggestions: [
          '💅 Cutilagem + Esmaltação',
          '✨ Design de Sobrancelha',
          '💇‍♀️ Corte + Escova'
        ],
        priority: 1
      });
      break;
      
    case 'DATE_TIME':
      if (context.serviceName) {
        suggestions.push({
          type: SuggestionType.TIME_SLOTS,
          suggestions: [
            '🌅 Manhã (9h às 12h)',
            '☀️ Tarde (14h às 17h)',
            '🌙 Noite (18h às 20h)'
          ],
          priority: 1
        });
      }
      break;
      
    case 'PROFESSIONAL':
      suggestions.push({
        type: SuggestionType.PROFESSIONALS,
        suggestions: [
          '⭐ Profissional mais avaliado',
          '🔥 Especialista no serviço',
          '📅 Próximo disponível'
        ],
        priority: 2
      });
      break;
  }
  
  // Sempre incluir ações rápidas se não houver outras sugestões
  if (suggestions.length === 0) {
    suggestions.push({
      type: SuggestionType.QUICK_ACTIONS,
      suggestions: [
        '📍 Ver localização',
        '💰 Consultar preços',
        '📞 Falar com atendente'
      ],
      priority: 3
    });
  }
  
  // Registrar que sugestões foram mostradas
  suggestions.forEach(suggestion => {
    trackProactiveSuggestionsShown(
      phone,
      tenantId,
      suggestion.type,
      suggestion.suggestions.length
    );
  });
  
  return suggestions.sort((a, b) => a.priority - b.priority);
}

/**
 * Processa clique em sugestão proativa
 */
export function handleProactiveSuggestionClick(
  phone: string,
  tenantId: string,
  suggestionType: SuggestionType,
  selectedSuggestion: string
): {
  action: string;
  data?: any;
} {
  // Registrar o clique
  trackProactiveSuggestionClicked(phone, tenantId, suggestionType);
  
  // Determinar ação baseada no tipo de sugestão
  switch (suggestionType) {
    case SuggestionType.SERVICES:
      return {
        action: 'set_service',
        data: { serviceName: selectedSuggestion }
      };
      
    case SuggestionType.TIME_SLOTS:
      return {
        action: 'set_period',
        data: { period: extractPeriodFromSuggestion(selectedSuggestion) }
      };
      
    case SuggestionType.PROFESSIONALS:
      return {
        action: 'set_professional_preference',
        data: { preference: selectedSuggestion }
      };
      
    case SuggestionType.QUICK_ACTIONS:
      return {
        action: 'quick_action',
        data: { action: selectedSuggestion }
      };
      
    default:
      return {
        action: 'unknown'
      };
  }
}

/**
 * Extrai período de uma sugestão de horário
 */
function extractPeriodFromSuggestion(suggestion: string): string {
  if (suggestion.includes('Manhã') || suggestion.includes('manhã')) {
    return 'manhã';
  }
  if (suggestion.includes('Tarde') || suggestion.includes('tarde')) {
    return 'tarde';
  }
  if (suggestion.includes('Noite') || suggestion.includes('noite')) {
    return 'noite';
  }
  return 'tarde'; // default
}

/**
 * Valida se o A/B test está configurado corretamente
 */
export function validateABTestConfig(): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const config = getABTestConfig();
  
  if (config.trafficSplit < 0 || config.trafficSplit > 100) {
    errors.push('AB_TRAFFIC_SPLIT deve estar entre 0 e 100');
  }
  
  if (config.targetMessages < 1) {
    errors.push('UX_TARGET_MSGS deve ser maior que 0');
  }
  
  if (config.enabled && !process.env.SUGESTOES_PROATIVAS) {
    errors.push('SUGESTOES_PROATIVAS deve ser definida quando o A/B test está ativo');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}