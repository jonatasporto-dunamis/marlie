import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { UpsellService, UpsellContext } from '../services/upsell-service';

/**
 * Middleware para interceptar confirmações de agendamento e disparar upsells
 * 
 * Este middleware deve ser aplicado nas rotas que confirmam agendamentos
 * para automaticamente processar oportunidades de upsell.
 */

export interface UpsellTriggerConfig {
  enabled: boolean;
  routes: string[]; // Rotas onde o middleware deve ser ativo
  extractors: {
    conversationId: (req: Request) => string;
    phone: (req: Request) => string;
    appointmentId: (req: Request) => string;
    primaryServiceId: (req: Request) => string;
    customerName?: (req: Request) => string;
  };
}

/**
 * Cria middleware de trigger de upsell
 */
export function createUpsellTriggerMiddleware(
  upsellService: UpsellService,
  config: UpsellTriggerConfig
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Verificar se o middleware está habilitado
      if (!config.enabled) {
        return next();
      }

      // Verificar se a rota atual deve processar upsell
      const currentRoute = req.route?.path || req.path;
      const shouldProcess = config.routes.some(route => {
        // Suporte a wildcards simples
        const pattern = route.replace('*', '.*');
        const regex = new RegExp(`^${pattern}$`);
        return regex.test(currentRoute);
      });

      if (!shouldProcess) {
        return next();
      }

      // Executar a rota original primeiro
      next();

      // Processar upsell após a resposta (não bloquear a resposta)
      setImmediate(async () => {
        try {
          await processUpsellTrigger(req, upsellService, config);
        } catch (error) {
          logger.error('Erro no processamento assíncrono de upsell:', error);
        }
      });

    } catch (error) {
      logger.error('Erro no middleware de trigger de upsell:', error);
      // Não bloquear a requisição principal
      next();
    }
  };
}

/**
 * Processa o trigger de upsell de forma assíncrona
 */
async function processUpsellTrigger(
  req: Request,
  upsellService: UpsellService,
  config: UpsellTriggerConfig
): Promise<void> {
  try {
    // Extrair dados da requisição
    const context: UpsellContext = {
      conversationId: config.extractors.conversationId(req),
      phone: config.extractors.phone(req),
      appointmentId: config.extractors.appointmentId(req),
      primaryServiceId: config.extractors.primaryServiceId(req),
      customerName: config.extractors.customerName?.(req)
    };

    // Validar dados obrigatórios
    if (!context.conversationId || !context.phone || !context.appointmentId || !context.primaryServiceId) {
      logger.warn('Dados insuficientes para processar upsell', {
        conversationId: context.conversationId,
        phone: context.phone ? '***masked***' : undefined,
        appointmentId: context.appointmentId,
        primaryServiceId: context.primaryServiceId
      });
      return;
    }

    logger.debug('Processando trigger de upsell', {
      conversationId: context.conversationId,
      appointmentId: context.appointmentId,
      primaryServiceId: context.primaryServiceId
    });

    // Processar upsell
    await upsellService.processBookingConfirmation(context);

  } catch (error) {
    logger.error('Erro ao processar trigger de upsell:', error);
  }
}

/**
 * Middleware específico para webhooks do WhatsApp
 * Detecta confirmações de agendamento em mensagens
 */
export function createWhatsAppUpsellMiddleware(
  upsellService: UpsellService,
  config: {
    enabled: boolean;
    confirmationPatterns: string[]; // Padrões regex para detectar confirmações
  }
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!config.enabled) {
        return next();
      }

      // Executar rota original primeiro
      next();

      // Processar detecção de confirmação de forma assíncrona
      setImmediate(async () => {
        try {
          await detectBookingConfirmation(req, upsellService, config);
        } catch (error) {
          logger.error('Erro na detecção de confirmação de agendamento:', error);
        }
      });

    } catch (error) {
      logger.error('Erro no middleware de WhatsApp upsell:', error);
      next();
    }
  };
}

/**
 * Detecta confirmações de agendamento em mensagens do WhatsApp
 */
async function detectBookingConfirmation(
  req: Request,
  upsellService: UpsellService,
  config: { confirmationPatterns: string[] }
): Promise<void> {
  try {
    const { body } = req;
    
    // Verificar se é uma mensagem de confirmação
    const messageText = body?.message?.text || body?.text || '';
    
    const isConfirmation = config.confirmationPatterns.some(pattern => {
      const regex = new RegExp(pattern, 'i');
      return regex.test(messageText);
    });

    if (!isConfirmation) {
      return;
    }

    // Extrair dados da mensagem
    const conversationId = body?.conversation_id || body?.from;
    const phone = body?.from || body?.phone;
    
    if (!conversationId || !phone) {
      logger.warn('Dados insuficientes na mensagem de confirmação', {
        conversationId,
        phone: phone ? '***masked***' : undefined
      });
      return;
    }

    // Buscar dados do agendamento no contexto da conversa
    // (Esta implementação dependeria do sistema de estado da conversa)
    logger.debug('Confirmação de agendamento detectada via WhatsApp', {
      conversationId,
      messageText: messageText.substring(0, 50) + '...'
    });

    // TODO: Implementar busca de dados do agendamento
    // const bookingData = await getBookingDataFromConversation(conversationId);
    // if (bookingData) {
    //   await upsellService.processBookingConfirmation(bookingData);
    // }

  } catch (error) {
    logger.error('Erro ao detectar confirmação de agendamento:', error);
  }
}

/**
 * Middleware para interceptar respostas de upsell
 */
export function createUpsellResponseMiddleware(
  upsellService: UpsellService,
  config: {
    enabled: boolean;
    responsePatterns: string[]; // Padrões que indicam resposta a upsell
  }
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!config.enabled) {
        return next();
      }

      // Executar rota original primeiro
      next();

      // Processar resposta de upsell de forma assíncrona
      setImmediate(async () => {
        try {
          await processUpsellResponse(req, upsellService, config);
        } catch (error) {
          logger.error('Erro no processamento de resposta de upsell:', error);
        }
      });

    } catch (error) {
      logger.error('Erro no middleware de resposta de upsell:', error);
      next();
    }
  };
}

/**
 * Processa respostas de upsell
 */
async function processUpsellResponse(
  req: Request,
  upsellService: UpsellService,
  config: { responsePatterns: string[] }
): Promise<void> {
  try {
    const { body } = req;
    const messageText = body?.message?.text || body?.text || '';
    const conversationId = body?.conversation_id || body?.from;
    const phone = body?.from || body?.phone;

    if (!conversationId || !phone || !messageText) {
      return;
    }

    // Verificar se a mensagem parece ser uma resposta a upsell
    const isUpsellResponse = config.responsePatterns.some(pattern => {
      const regex = new RegExp(pattern, 'i');
      return regex.test(messageText);
    });

    if (!isUpsellResponse) {
      return;
    }

    logger.debug('Possível resposta de upsell detectada', {
      conversationId,
      messageText: messageText.substring(0, 50) + '...'
    });

    // Processar resposta
    await upsellService.processUpsellResponse(conversationId, phone, messageText);

  } catch (error) {
    logger.error('Erro ao processar resposta de upsell:', error);
  }
}

/**
 * Configuração padrão para extratores comuns
 */
export const defaultExtractors = {
  // Extrator para rotas de agendamento padrão
  booking: {
    conversationId: (req: Request) => req.body?.conversation_id || req.body?.from || req.params?.conversationId,
    phone: (req: Request) => req.body?.phone || req.body?.from || req.params?.phone,
    appointmentId: (req: Request) => req.body?.appointment_id || req.body?.appointmentId || req.params?.appointmentId,
    primaryServiceId: (req: Request) => req.body?.service_id || req.body?.serviceId || req.params?.serviceId,
    customerName: (req: Request) => req.body?.customer_name || req.body?.customerName
  },

  // Extrator para webhooks do Trinks
  trinks: {
    conversationId: (req: Request) => req.body?.metadata?.conversation_id || req.body?.external_id,
    phone: (req: Request) => req.body?.customer?.phone || req.body?.phone,
    appointmentId: (req: Request) => req.body?.id || req.body?.appointment_id,
    primaryServiceId: (req: Request) => req.body?.services?.[0]?.id || req.body?.service_id,
    customerName: (req: Request) => req.body?.customer?.name
  },

  // Extrator para webhooks do WhatsApp/Evolution
  whatsapp: {
    conversationId: (req: Request) => req.body?.key?.remoteJid || req.body?.from,
    phone: (req: Request) => req.body?.key?.remoteJid?.replace('@s.whatsapp.net', '') || req.body?.from,
    appointmentId: (req: Request) => req.body?.metadata?.appointment_id,
    primaryServiceId: (req: Request) => req.body?.metadata?.service_id,
    customerName: (req: Request) => req.body?.pushName || req.body?.metadata?.customer_name
  }
};

/**
 * Padrões padrão para detecção de confirmações e respostas
 */
export const defaultPatterns = {
  confirmations: [
    'agendamento confirmado',
    'seu horário está confirmado',
    'agendado com sucesso',
    'confirmação.*agendamento',
    'horário.*confirmado'
  ],
  
  upsellResponses: [
    '^\\s*1\\s*$',
    '\\b(sim|quero|aceito|adicionar|pode sim)\\b',
    '\\b(nao|não|talvez depois|agora não)\\b'
  ]
};

export default {
  createUpsellTriggerMiddleware,
  createWhatsAppUpsellMiddleware,
  createUpsellResponseMiddleware,
  defaultExtractors,
  defaultPatterns
};