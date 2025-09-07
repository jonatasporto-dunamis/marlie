import axios, { AxiosResponse } from 'axios';
import { logger } from '../../../utils/logger';

interface HttpGetJsonParams {
  url: string;
  headers?: Record<string, string>;
}

interface HttpPostJsonParams {
  url: string;
  body: any;
  headers?: Record<string, string>;
}

interface HttpToolResult {
  success: boolean;
  data?: any;
  status?: number;
  error?: string;
  duration_ms: number;
}

/**
 * Ferramenta HTTP GET JSON
 * Executa requisições GET e retorna dados JSON
 */
export async function httpGetJson(params: HttpGetJsonParams): Promise<HttpToolResult> {
  const startTime = Date.now();
  
  try {
    logger.debug(`🌐 HTTP GET: ${params.url}`);
    
    const response: AxiosResponse = await axios.get(params.url, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Marlie-ShipCheck/1.0',
        ...params.headers
      },
      timeout: 30000, // 30 segundos
      validateStatus: (status) => status < 500 // Aceita 4xx como válido
    });
    
    const duration = Date.now() - startTime;
    
    logger.debug(`✅ HTTP GET sucesso: ${response.status} em ${duration}ms`);
    
    return {
      success: response.status >= 200 && response.status < 400,
      data: response.data,
      status: response.status,
      duration_ms: duration
    };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    
    if (axios.isAxiosError(error)) {
      logger.error(`❌ HTTP GET erro: ${error.response?.status} - ${error.message}`);
      
      return {
        success: false,
        data: error.response?.data,
        status: error.response?.status,
        error: error.message,
        duration_ms: duration
      };
    }
    
    logger.error(`❌ HTTP GET erro inesperado:`, error);
    
    return {
      success: false,
      error: error.message || 'Erro desconhecido',
      duration_ms: duration
    };
  }
}

/**
 * Ferramenta HTTP POST JSON
 * Executa requisições POST com payload JSON
 */
export async function httpPostJson(params: HttpPostJsonParams): Promise<HttpToolResult> {
  const startTime = Date.now();
  
  try {
    logger.debug(`🌐 HTTP POST: ${params.url}`);
    logger.debug(`📤 Payload:`, params.body);
    
    const response: AxiosResponse = await axios.post(params.url, params.body, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Marlie-ShipCheck/1.0',
        ...params.headers
      },
      timeout: 30000, // 30 segundos
      validateStatus: (status) => status < 500 // Aceita 4xx como válido
    });
    
    const duration = Date.now() - startTime;
    
    logger.debug(`✅ HTTP POST sucesso: ${response.status} em ${duration}ms`);
    
    return {
      success: response.status >= 200 && response.status < 400,
      data: response.data,
      status: response.status,
      duration_ms: duration
    };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    
    if (axios.isAxiosError(error)) {
      logger.error(`❌ HTTP POST erro: ${error.response?.status} - ${error.message}`);
      
      return {
        success: false,
        data: error.response?.data,
        status: error.response?.status,
        error: error.message,
        duration_ms: duration
      };
    }
    
    logger.error(`❌ HTTP POST erro inesperado:`, error);
    
    return {
      success: false,
      error: error.message || 'Erro desconhecido',
      duration_ms: duration
    };
  }
}

/**
 * Utilitário para validar URLs
 */
export function validateUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Utilitário para resolver variáveis em URLs
 */
export function resolveUrlVariables(url: string, variables: Record<string, string>): string {
  let resolved = url;
  
  for (const [key, value] of Object.entries(variables)) {
    const pattern = new RegExp(`\\{\\{env\\.${key}\\}\\}`, 'g');
    resolved = resolved.replace(pattern, value);
  }
  
  return resolved;
}

/**
 * Utilitário para sanitizar headers sensíveis nos logs
 */
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized = { ...headers };
  
  const sensitiveKeys = ['authorization', 'x-api-key', 'x-auth-token', 'cookie'];
  
  for (const key of sensitiveKeys) {
    if (sanitized[key.toLowerCase()]) {
      sanitized[key.toLowerCase()] = '***MASKED***';
    }
  }
  
  return sanitized;
}