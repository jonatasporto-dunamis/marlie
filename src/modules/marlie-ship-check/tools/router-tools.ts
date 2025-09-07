import { logger } from '../../../utils/logger';
import { replyForMessage } from '../../../orchestrator/dialog';
import { getRedis } from '../../../infra/redis';

interface InjectMessageParams {
  phone: string;
  text: string;
  instanceId?: string;
  tenantId?: string;
}

interface InjectMessageResult {
  success: boolean;
  messageId?: string;
  response?: {
    text?: string;
    state?: string;
    actions?: string[];
  };
  error?: string;
  duration_ms: number;
}

/**
 * Ferramenta para injetar mensagens mock como se fossem do WhatsApp
 * Útil para testes automatizados dos fluxos de conversa
 */
export async function injectMockMessage(params: InjectMessageParams): Promise<InjectMessageResult> {
  const startTime = Date.now();
  
  try {
    logger.debug(`📱 Injetando mensagem mock: ${params.phone} -> "${params.text}"`);
    
    // Validar parâmetros
    if (!params.phone || !params.text) {
      throw new Error('Phone e text são obrigatórios');
    }
    
    // Normalizar número de telefone
    const normalizedPhone = normalizePhoneNumber(params.phone);
    
    // Criar payload mock do webhook do WhatsApp
    const mockWebhookPayload = {
      instanceId: params.instanceId || 'test-instance',
      data: {
        key: {
          remoteJid: `${normalizedPhone}@s.whatsapp.net`,
          fromMe: false,
          id: generateMessageId()
        },
        message: {
          conversation: params.text
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName: 'Test User',
        participant: `${normalizedPhone}@s.whatsapp.net`
      }
    };
    
    // Processar mensagem através do orquestrador
    const messageText = mockWebhookPayload.data.message.conversation;
    const phoneNumber = mockWebhookPayload.data.key.remoteJid.split('@')[0];
    const contactInfo = { pushName: mockWebhookPayload.data.pushName };
    
    const response = await replyForMessage(messageText, phoneNumber, contactInfo);
    
    const duration = Date.now() - startTime;
    
    logger.debug(`✅ Mensagem processada em ${duration}ms`);
    
    return {
      success: true,
      messageId: mockWebhookPayload.data.key.id,
      response: {
        text: response,
        state: 'processed',
        actions: []
      },
      duration_ms: duration
    };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logger.error(`❌ Erro ao injetar mensagem mock:`, error);
    
    return {
      success: false,
      error: error.message || 'Erro desconhecido',
      duration_ms: duration
    };
  }
}

/**
 * Aguarda um período específico (útil para testes de timing)
 */
export async function waitMs(ms: number): Promise<{ success: boolean; duration_ms: number }> {
  const startTime = Date.now();
  
  logger.debug(`⏱️ Aguardando ${ms}ms...`);
  
  await new Promise(resolve => setTimeout(resolve, ms));
  
  const actualDuration = Date.now() - startTime;
  
  logger.debug(`✅ Aguardou ${actualDuration}ms`);
  
  return {
    success: true,
    duration_ms: actualDuration
  };
}

/**
 * Obtém o estado atual de uma conversa
 */
export async function getConversationState(phone: string, tenantId?: string): Promise<{
  success: boolean;
  state?: string;
  context?: any;
  error?: string;
}> {
  try {
    const redis = await getRedis();
    const normalizedPhone = normalizePhoneNumber(phone);
    const key = `conversation:${tenantId || 'test-tenant'}:${normalizedPhone}`;
    
    const data = await redis.get(key);
    
    if (!data) {
      return {
        success: true,
        state: 'INITIAL',
        context: {}
      };
    }
    
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    
    return {
      success: true,
      state: parsed.state,
      context: parsed.context
    };
    
  } catch (error) {
    logger.error(`❌ Erro ao obter estado da conversa:`, error);
    
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Limpa o estado de uma conversa (útil para testes)
 */
export async function clearConversationState(phone: string, tenantId?: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const redis = await getRedis();
    const normalizedPhone = normalizePhoneNumber(phone);
    const key = `conversation:${tenantId || 'test-tenant'}:${normalizedPhone}`;
    
    await redis.del(key);
    
    logger.debug(`🧹 Estado da conversa limpo: ${normalizedPhone}`);
    
    return { success: true };
    
  } catch (error) {
    logger.error(`❌ Erro ao limpar estado da conversa:`, error);
    
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Normaliza número de telefone para formato padrão
 */
function normalizePhoneNumber(phone: string): string {
  // Remove caracteres não numéricos
  const cleaned = phone.replace(/\D/g, '');
  
  // Garante que tenha código do país (55 para Brasil)
  if (cleaned.length === 11 && cleaned.startsWith('55')) {
    return cleaned;
  }
  
  if (cleaned.length === 11) {
    return `55${cleaned}`;
  }
  
  if (cleaned.length === 10) {
    return `55${cleaned}`;
  }
  
  return cleaned;
}

/**
 * Gera ID único para mensagem
 */
function generateMessageId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substr(2, 5);
  return `test_${timestamp}_${random}`;
}

/**
 * Valida se uma resposta contém textos esperados
 */
export function validateResponseContains(response: string, expectedTexts: string[]): {
  success: boolean;
  matches: string[];
  missing: string[];
} {
  const matches: string[] = [];
  const missing: string[] = [];
  
  for (const expected of expectedTexts) {
    if (response.toLowerCase().includes(expected.toLowerCase())) {
      matches.push(expected);
    } else {
      missing.push(expected);
    }
  }
  
  return {
    success: missing.length === 0,
    matches,
    missing
  };
}

/**
 * Valida se o estado da conversa é o esperado
 */
export function validateState(actualState: string, expectedState: string): boolean {
  return actualState === expectedState;
}