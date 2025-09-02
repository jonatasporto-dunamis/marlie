import { Request, Response, NextFunction } from 'express';
import client from 'prom-client';
import logger from '../utils/logger';

// Configurar coleta de métricas padrão
client.collectDefaultMetrics();

// Contadores personalizados
export const conversationsStartedTotal = new client.Counter({
  name: 'conversations_started_total',
  help: 'Total number of conversations started',
  labelNames: ['tenant_id']
});

export const serviceSuggestionsShownTotal = new client.Counter({
  name: 'service_suggestions_shown_total',
  help: 'Total number of service suggestions shown to users',
  labelNames: ['tenant_id', 'service_name']
});

export const bookingsConfirmedTotal = new client.Counter({
  name: 'bookings_confirmed_total',
  help: 'Total number of bookings confirmed',
  labelNames: ['tenant_id', 'service_name']
});

export const apiTrinksErrorsTotal = new client.Counter({
  name: 'api_trinks_errors_total',
  help: 'Total number of Trinks API errors',
  labelNames: ['code', 'endpoint']
});

// Histograma para tempo de resposta
export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10]
});

// Gauge para conexões ativas
export const activeConnections = new client.Gauge({
  name: 'active_connections',
  help: 'Number of active connections'
});

// Middleware para coletar métricas HTTP
export const metricsMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Incrementar conexões ativas
  activeConnections.inc();
  
  const startTime = Date.now();
  
  // Interceptar o método end para capturar métricas
  const originalEnd = res.end.bind(res);
  res.end = function(...args: any[]) {
    const duration = (Date.now() - startTime) / 1000;
    
    // Registrar duração da requisição
    httpRequestDuration
      .labels(req.method, req.route?.path || req.path, res.statusCode.toString())
      .observe(duration);
    
    // Decrementar conexões ativas
    activeConnections.dec();
    
    return originalEnd(...args);
  } as any;
  
  next();
};

// Função para incrementar conversas iniciadas
export const incrementConversationsStarted = (tenantId: string = 'default') => {
  conversationsStartedTotal.labels(tenantId).inc();
  logger.info('Conversation started metric incremented', { tenantId });
};

// Função para incrementar sugestões de serviço
export const incrementServiceSuggestions = (tenantId: string = 'default', serviceName: string) => {
  serviceSuggestionsShownTotal.labels(tenantId, serviceName).inc();
  logger.info('Service suggestion metric incremented', { tenantId, serviceName });
};

// Função para incrementar agendamentos confirmados
export const incrementBookingsConfirmed = (tenantId: string = 'default', serviceName: string) => {
  bookingsConfirmedTotal.labels(tenantId, serviceName).inc();
  logger.info('Booking confirmed metric incremented', { tenantId, serviceName });
};

// Função para incrementar erros da API Trinks
export const incrementTrinksErrors = (code: string, endpoint: string) => {
  apiTrinksErrorsTotal.labels(code, endpoint).inc();
  logger.warn('Trinks API error metric incremented', { code, endpoint });
};

// Endpoint para expor métricas
export const metricsHandler = async (req: Request, res: Response) => {
  try {
    res.set('Content-Type', client.register.contentType);
    const metrics = await client.register.metrics();
    res.end(metrics);
  } catch (error) {
    logger.error('Error generating metrics', { error });
    res.status(500).end('Error generating metrics');
  }
};