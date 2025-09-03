import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import { getMetrics, MetricsHelper } from '../metrics/index';

// Middleware de métricas atualizado para usar o novo sistema Prometheus

// Middleware para coletar métricas HTTP
export const metricsMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();
  
  // Interceptar o final da resposta
  const originalEnd = res.end;
  res.end = function(chunk?: any, encoding?: any, callback?: () => void) {
    const duration = (Date.now() - startTime) / 1000;
    
    // Registrar duração da requisição usando o novo sistema
    try {
      MetricsHelper.recordHttpRequestDuration(
        req.method,
        req.route?.path || req.path,
        res.statusCode,
        duration
      );
    } catch (error) {
      logger.warn('Failed to record HTTP request duration:', error);
    }

    // Chamar o método original
    return originalEnd.call(this, chunk, encoding, callback);
  };

  next();
};

// Handler para endpoint /metrics
export const metricsHandler = async (req: Request, res: Response) => {
  try {
    const metrics = await getMetrics();
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.end(metrics);
  } catch (error) {
    logger.error('Error collecting metrics:', error);
    res.status(500).end('Error collecting metrics');
  }
};

// Funções auxiliares para incrementar contadores (mantidas para compatibilidade)
export const incrementConversationsStarted = (tenantId: string, channel: string = 'whatsapp') => {
  MetricsHelper.incrementConversationsStarted(tenantId, channel);
};

export const incrementServiceSuggestions = (tenantId: string, suggestionCount: number) => {
  MetricsHelper.incrementServiceSuggestionsShown(tenantId, suggestionCount);
};

export const incrementBookingsConfirmed = (tenantId: string, serviceId: string, professionalId?: string) => {
  MetricsHelper.incrementBookingsConfirmed(tenantId, serviceId, professionalId);
};

export const incrementTrinksErrors = (code: string, endpoint: string, method: string = 'GET') => {
  MetricsHelper.incrementTrinksErrors(code, endpoint, method);
};

// Novas funções para métricas adicionais
export const recordServiceSuggestionDuration = (tenantId: string, duration: number, cacheHit: boolean = false) => {
  MetricsHelper.recordServiceSuggestionDuration(tenantId, duration, cacheHit);
};

export const recordTrinksApiDuration = (endpoint: string, method: string, statusCode: number, duration: number) => {
  MetricsHelper.recordTrinksApiDuration(endpoint, method, statusCode, duration);
};

export const incrementFirstTryBooking = (tenantId: string, serviceId: string) => {
  MetricsHelper.incrementFirstTryBooking(tenantId, serviceId);
};

export const incrementCacheHits = (cacheType: string, keyPattern: string) => {
  MetricsHelper.incrementCacheHits(cacheType, keyPattern);
};

export const incrementCacheMisses = (cacheType: string, keyPattern: string) => {
  MetricsHelper.incrementCacheMisses(cacheType, keyPattern);
};