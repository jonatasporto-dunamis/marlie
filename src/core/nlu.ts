import logger from '../utils/logger';
import { callLLM } from '../llm/openai';
import fs from 'fs';
import path from 'path';

interface NLUResult {
  intent: string;
  serviceName?: string;
  dateRel?: string;
  dateISO?: string;
  period?: string;
  timeISO?: string;
  professionalName?: string;
}

// Schema válido para validação
const VALID_SCHEMA_FIELDS = new Set([
  'intent',
  'serviceName', 
  'dateRel',
  'dateISO',
  'period',
  'timeISO',
  'professionalName'
]);

// Intents válidos
const VALID_INTENTS = new Set([
  'agendar',
  'remarcar', 
  'cancelar',
  'consultar_preco',
  'consultar_endereco',
  'confirmar',
  'negar',
  'saudacao',
  'outros'
]);

let nluPrompt: string | null = null;

/**
 * Carrega o prompt NLU do arquivo
 */
function loadNLUPrompt(): string {
  if (nluPrompt) {
    return nluPrompt;
  }
  
  try {
    const promptPath = path.join(process.cwd(), 'prompts', 'nlu.md');
    nluPrompt = fs.readFileSync(promptPath, 'utf-8');
    return nluPrompt;
  } catch (error) {
    logger.error('Failed to load NLU prompt:', error);
    throw new Error('NLU prompt file not found');
  }
}

/**
 * Processa entrada do usuário usando NLU
 */
export async function processNLU(
  userInput: string,
  context?: any
): Promise<NLUResult> {
  try {
    const prompt = loadNLUPrompt();
    
    // Construir prompt completo
    let fullPrompt = prompt + '\n\n';
    
    if (context) {
      fullPrompt += `Contexto da conversa: ${JSON.stringify(context)}\n\n`;
    }
    
    fullPrompt += `Entrada do usuário: "${userInput}"\n\n`;
    fullPrompt += 'IMPORTANTE: Retorne SOMENTE JSON válido, sem texto adicional ou formatação markdown.';
    
    // Chamar LLM
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: fullPrompt }
    ];
    const response = await callLLM(messages, 'gpt-3.5-turbo');
    
    if (!response.success || !response.content) {
      throw new Error('LLM call failed: ' + response.error);
    }
    
    // Validar e parsear resposta JSON
    const nluResult = validateAndParseNLUResponse(response.content, userInput);
    
    logger.info('NLU processing completed', {
      input: userInput,
      result: nluResult,
      hasContext: !!context
    });
    
    return nluResult;
    
  } catch (error) {
    logger.error('NLU processing failed:', {
      error,
      input: userInput,
      context
    });
    
    // Retornar resultado de fallback
    return {
      intent: 'outros'
    };
  }
}

/**
 * Valida e parseia resposta do NLU garantindo JSON-only
 */
function validateAndParseNLUResponse(response: string, originalInput: string): NLUResult {
  try {
    // Limpar resposta removendo possível formatação markdown
    let cleanResponse = response.trim();
    
    // Remover blocos de código markdown se existirem
    cleanResponse = cleanResponse.replace(/```json\s*/, '');
    cleanResponse = cleanResponse.replace(/```\s*$/, '');
    cleanResponse = cleanResponse.replace(/^```\s*/, '');
    
    // Tentar extrair JSON se houver texto adicional
    const jsonMatch = cleanResponse.match(/\{[^}]*\}/s);
    if (jsonMatch) {
      cleanResponse = jsonMatch[0];
    }
    
    // Parsear JSON
    const parsed = JSON.parse(cleanResponse);
    
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Response is not a valid object');
    }
    
    // Validar schema
    const validatedResult = validateNLUSchema(parsed, originalInput);
    
    return validatedResult;
    
  } catch (error) {
    logger.error('Failed to parse NLU response as JSON:', {
      error,
      response,
      originalInput
    });
    
    // Tentar fallback com regex para extrair intent básico
    const fallbackResult = extractFallbackIntent(originalInput);
    
    logger.warn('Using fallback NLU result:', {
      originalInput,
      fallbackResult
    });
    
    return fallbackResult;
  }
}

/**
 * Valida schema do resultado NLU
 */
function validateNLUSchema(parsed: any, originalInput: string): NLUResult {
  const result: NLUResult = {
    intent: 'outros' // Default
  };
  
  // Validar intent obrigatório
  if (typeof parsed.intent === 'string' && VALID_INTENTS.has(parsed.intent)) {
    result.intent = parsed.intent;
  } else {
    logger.warn('Invalid or missing intent in NLU response:', {
      intent: parsed.intent,
      originalInput
    });
  }
  
  // Validar campos opcionais
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'intent') continue; // Já processado
    
    if (!VALID_SCHEMA_FIELDS.has(key)) {
      logger.warn('Invalid schema field in NLU response:', {
        field: key,
        value,
        originalInput
      });
      continue;
    }
    
    if (typeof value === 'string' && value.trim().length > 0) {
      (result as any)[key] = value.trim();
    }
  }
  
  // Validações específicas
  if (result.timeISO && !isValidTimeFormat(result.timeISO)) {
    logger.warn('Invalid timeISO format, removing field:', {
      timeISO: result.timeISO,
      originalInput
    });
    delete result.timeISO;
  }
  
  if (result.dateISO && !isValidDateFormat(result.dateISO)) {
    logger.warn('Invalid dateISO format, removing field:', {
      dateISO: result.dateISO,
      originalInput
    });
    delete result.dateISO;
  }
  
  if (result.period && !['manhã', 'tarde', 'noite'].includes(result.period)) {
    logger.warn('Invalid period value, removing field:', {
      period: result.period,
      originalInput
    });
    delete result.period;
  }
  
  return result;
}

/**
 * Extrai intent básico usando regex como fallback
 */
function extractFallbackIntent(input: string): NLUResult {
  const normalizedInput = input.toLowerCase().trim();
  
  // Padrões básicos para fallback
  if (/\b(agendar|quero|preciso|dá pra)\b/.test(normalizedInput)) {
    return { intent: 'agendar' };
  }
  
  if (/\b(remarcar|reagendar|mudar)\b/.test(normalizedInput)) {
    return { intent: 'remarcar' };
  }
  
  if (/\b(cancelar|desmarcar)\b/.test(normalizedInput)) {
    return { intent: 'cancelar' };
  }
  
  if (/\b(preço|preco|valor|quanto|custa)\b/.test(normalizedInput)) {
    return { intent: 'consultar_preco' };
  }
  
  if (/\b(endereço|endereco|localização|localizacao|onde)\b/.test(normalizedInput)) {
    return { intent: 'consultar_endereco' };
  }
  
  if (/\b(sim|tá bom|beleza|confirmo|pode ser|massa)\b/.test(normalizedInput)) {
    return { intent: 'confirmar' };
  }
  
  if (/\b(não|nao|num|não rola|num rola|não dá|num dá)\b/.test(normalizedInput)) {
    return { intent: 'negar' };
  }
  
  if (/\b(oi|olá|ola|bom dia|boa tarde|boa noite)\b/.test(normalizedInput)) {
    return { intent: 'saudacao' };
  }
  
  return { intent: 'outros' };
}

/**
 * Valida formato de horário (HH:MM)
 */
function isValidTimeFormat(time: string): boolean {
  const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
  return timeRegex.test(time);
}

/**
 * Valida formato de data (YYYY-MM-DD)
 */
function isValidDateFormat(date: string): boolean {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) {
    return false;
  }
  
  // Verificar se é uma data válida
  const parsedDate = new Date(date);
  return !isNaN(parsedDate.getTime()) && parsedDate.toISOString().startsWith(date);
}

/**
 * Processa entrada com contexto de conversa
 */
export async function processNLUWithContext(
  userInput: string,
  conversationContext: {
    currentStep?: string;
    currentService?: string;
    currentDate?: string;
    previousIntents?: string[];
  }
): Promise<NLUResult> {
  return processNLU(userInput, conversationContext);
}

/**
 * Valida se uma resposta NLU está no formato JSON-only correto
 */
export function validateJSONOnlyResponse(response: string): {
  isValid: boolean;
  parsed?: NLUResult;
  error?: string;
} {
  try {
    const result = validateAndParseNLUResponse(response, 'validation_test');
    return {
      isValid: true,
      parsed: result
    };
  } catch (error) {
    return {
      isValid: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Extrai informações de serviço do texto
 */
export function extractServiceName(input: string): string | undefined {
  const normalizedInput = input.toLowerCase();
  
  // Lista de serviços conhecidos
  const services = [
    'cutilagem', 'esmaltação', 'progressiva', 'design de sobrancelha',
    'manicure', 'pedicure', 'hidratação', 'escova', 'corte', 'coloração',
    'luzes', 'babyliss', 'chapinha'
  ];
  
  for (const service of services) {
    if (normalizedInput.includes(service)) {
      return service;
    }
  }
  
  return undefined;
}

/**
 * Extrai informações temporais do texto
 */
export function extractTemporalInfo(input: string): {
  dateRel?: string;
  period?: string;
  timeISO?: string;
} {
  const normalizedInput = input.toLowerCase();
  const result: any = {};
  
  // Datas relativas
  if (/\b(hoje|hj)\b/.test(normalizedInput)) {
    result.dateRel = 'hoje';
  } else if (/\b(amanhã|amanha)\b/.test(normalizedInput)) {
    result.dateRel = 'amanhã';
  }
  
  // Períodos
  if (/\b(cedinho|cedim|manhã|manha|antes do almoço)\b/.test(normalizedInput)) {
    result.period = 'manhã';
  } else if (/\b(tarde|tardinha|tardim|depois do almoço|finalzinho da tarde)\b/.test(normalizedInput)) {
    result.period = 'tarde';
  } else if (/\b(noite|noitinha|noitim)\b/.test(normalizedInput)) {
    result.period = 'noite';
  }
  
  // Horários específicos
  const timeMatch = normalizedInput.match(/\b(\d{1,2}):?(\d{2})?\s*h?\b/);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1]);
    const minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
    
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      result.timeISO = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    }
  }
  
  return result;
}