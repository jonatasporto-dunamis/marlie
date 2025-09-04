import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { createMarlieRouter } from '../../agents/marlie-router';
import { getMessageBufferService } from '../../services/message-buffer';
import { getHumanHandoffService } from '../../services/human-handoff';
import { getValidationService } from '../../services/validation-service';
import { getResponseTemplateService } from '../../services/response-templates';
import { getCatalogService } from '../../services/catalog-service';
import { getTrinksService } from '../../services/trinks-service';
import { redis, db } from '../../config/database';
import { logger } from '../../utils/logger';
import { verifyWhatsAppWebhook } from '../../middleware/whatsapp-auth';

const router = Router();

// Inicializa serviços
const messageBuffer = getMessageBufferService(redis);
const handoffService = getHumanHandoffService(redis, db);
const catalogService = getCatalogService(db);
const trinksService = getTrinksService();
const validationService = getValidationService(catalogService, trinksService);
const templateService = getResponseTemplateService();

// Cria agente Marlie
const marlieAgent = createMarlieRouter(
  redis,
  db,
  messageBuffer,
  handoffService,
  validationService,
  templateService,
  catalogService,
  trinksService
);

/**
 * @route GET /whatsapp/webhook
 * @desc Verificação do webhook do WhatsApp
 * @access Public (com verificação de token)
 */
router.get('/webhook', (req: Request, res: Response) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // Verifica se é uma requisição de verificação
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      logger.info('WhatsApp webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      logger.warn('WhatsApp webhook verification failed');
      res.status(403).send('Forbidden');
    }
  } catch (error) {
    logger.error('Error in webhook verification:', error);
    res.status(500).send('Internal Server Error');
  }
});

/**
 * @route POST /whatsapp/webhook
 * @desc Recebe mensagens do WhatsApp
 * @access Public (com verificação de assinatura)
 */
router.post('/webhook',
  verifyWhatsAppWebhook,
  [
    body('object')
      .equals('whatsapp_business_account')
      .withMessage('Objeto deve ser whatsapp_business_account'),
    body('entry')
      .isArray({ min: 1 })
      .withMessage('Entry deve ser um array não vazio')
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        logger.warn('Invalid webhook payload:', errors.array());
        return res.status(400).json({
          success: false,
          message: 'Payload inválido',
          errors: errors.array()
        });
      }

      const { entry } = req.body;
      
      // Processa cada entrada
      for (const entryItem of entry) {
        if (entryItem.changes) {
          for (const change of entryItem.changes) {
            if (change.field === 'messages' && change.value?.messages) {
              await processMessages(change.value.messages, change.value.metadata);
            }
          }
        }
      }

      // Responde rapidamente para o WhatsApp
      res.status(200).json({ success: true });
    } catch (error) {
      logger.error('Error processing webhook:', error);
      res.status(500).json({
        success: false,
        message: 'Erro interno do servidor'
      });
    }
  }
);

/**
 * Processa mensagens recebidas
 */
async function processMessages(messages: any[], metadata: any): Promise<void> {
  for (const message of messages) {
    try {
      // Ignora mensagens que não são de texto por enquanto
      if (message.type !== 'text') {
        logger.info(`Ignoring non-text message type: ${message.type}`);
        continue;
      }

      const phone = message.from;
      const messageText = message.text?.body;
      const messageId = message.id;
      const timestamp = new Date(parseInt(message.timestamp) * 1000);

      if (!phone || !messageText) {
        logger.warn('Missing phone or message text:', { phone, messageText });
        continue;
      }

      logger.info(`Processing message from ${phone}: ${messageText}`);

      // Extrai informações do usuário se disponível
      const userInfo = extractUserInfo(message);
      
      // Obtém tenant_id do metadata ou configuração
      const tenantId = metadata?.phone_number_id || process.env.DEFAULT_TENANT_ID || 'default';

      // Processa mensagem com Marlie
      const response = await marlieAgent.processMessage(
        phone,
        messageText,
        tenantId,
        userInfo
      );

      // Envia resposta se necessário
      if (response.message && response.message.trim().length > 0) {
        await sendWhatsAppMessage(phone, response.message, metadata?.phone_number_id);
        
        // Log da resposta
        logger.info(`Sent response to ${phone}: ${response.action}`);
      }

      // Processa ações especiais
      await handleSpecialActions(response, phone, tenantId);

    } catch (error) {
      logger.error(`Error processing message ${message.id}:`, error);
    }
  }
}

/**
 * Extrai informações do usuário da mensagem
 */
function extractUserInfo(message: any): { first_name?: string; full_name?: string } {
  const profile = message.profile || {};
  
  return {
    first_name: profile.name?.split(' ')[0],
    full_name: profile.name
  };
}

/**
 * Processa ações especiais do agente
 */
async function handleSpecialActions(
  response: any,
  phone: string,
  tenantId: string
): Promise<void> {
  switch (response.action) {
    case 'transfer_human':
      // Notifica sistema de atendimento humano
      await notifyHumanAgent(phone, response.metadata);
      break;
      
    case 'schedule_appointment':
      // Inicia fluxo de agendamento
      await initiateSchedulingFlow(phone, response.metadata, tenantId);
      break;
      
    case 'provide_info':
      // Log de fornecimento de informações
      logger.info(`Provided info to ${phone}`);
      break;
      
    default:
      // Ação padrão - apenas log
      logger.debug(`Action ${response.action} for ${phone}`);
  }
}

/**
 * Notifica agente humano sobre transferência
 */
async function notifyHumanAgent(phone: string, metadata: any): Promise<void> {
  try {
    // Aqui você pode integrar com sistema de tickets, Slack, etc.
    logger.info(`Human handoff requested for ${phone}`, metadata);
    
    // Exemplo: enviar notificação para Slack ou sistema de tickets
    // await notifySlack(`Handoff solicitado para ${phone}`);
    // await createTicket(phone, metadata);
  } catch (error) {
    logger.error('Error notifying human agent:', error);
  }
}

/**
 * Inicia fluxo de agendamento
 */
async function initiateSchedulingFlow(
  phone: string,
  metadata: any,
  tenantId: string
): Promise<void> {
  try {
    logger.info(`Scheduling flow initiated for ${phone}`, metadata);
    
    // Aqui você pode integrar com sistema de agendamento
    // await createPendingAppointment(phone, metadata.service_selected, tenantId);
  } catch (error) {
    logger.error('Error initiating scheduling flow:', error);
  }
}

/**
 * Envia mensagem via WhatsApp Business API
 */
async function sendWhatsAppMessage(
  to: string,
  message: string,
  phoneNumberId?: string
): Promise<void> {
  try {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const defaultPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    
    if (!accessToken || (!phoneNumberId && !defaultPhoneNumberId)) {
      throw new Error('WhatsApp credentials not configured');
    }

    const url = `https://graph.facebook.com/v18.0/${phoneNumberId || defaultPhoneNumberId}/messages`;
    
    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: {
        body: message
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`WhatsApp API error: ${response.status} - ${errorData}`);
    }

    const result = await response.json();
    logger.debug('WhatsApp message sent successfully:', result);
  } catch (error) {
    logger.error('Error sending WhatsApp message:', error);
    throw error;
  }
}

/**
 * @route POST /whatsapp/send
 * @desc Envia mensagem via WhatsApp (para testes)
 * @access Admin
 */
router.post('/send',
  [
    body('to')
      .notEmpty()
      .withMessage('Destinatário é obrigatório')
      .matches(/^\+?[1-9]\d{1,14}$/)
      .withMessage('Formato de telefone inválido'),
    body('message')
      .notEmpty()
      .withMessage('Mensagem é obrigatória')
      .isLength({ max: 4096 })
      .withMessage('Mensagem muito longa')
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Dados inválidos',
          errors: errors.array()
        });
      }

      const { to, message } = req.body;
      
      await sendWhatsAppMessage(to, message);
      
      res.json({
        success: true,
        message: 'Mensagem enviada com sucesso'
      });
    } catch (error) {
      logger.error('Error sending test message:', error);
      res.status(500).json({
        success: false,
        message: 'Erro ao enviar mensagem'
      });
    }
  }
);

/**
 * @route GET /whatsapp/stats
 * @desc Obtém estatísticas do WhatsApp
 * @access Admin
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const sessionStats = await marlieAgent.getSessionStats();
    const handoffStats = await handoffService.listActiveHandoffs();
    
    res.json({
      success: true,
      data: {
        sessions: sessionStats,
        activeHandoffs: handoffStats.length,
        timestamp: new Date()
      }
    });
  } catch (error) {
    logger.error('Error getting WhatsApp stats:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao obter estatísticas'
    });
  }
});

/**
 * @route POST /whatsapp/cleanup
 * @desc Limpa sessões e dados expirados
 * @access Admin
 */
router.post('/cleanup', async (req: Request, res: Response) => {
  try {
    const [cleanedSessions, cleanedHandoffs, cleanedBuffers] = await Promise.all([
      marlieAgent.cleanupExpiredSessions(),
      handoffService.cleanupExpiredHandoffs(),
      messageBuffer.cleanup()
    ]);
    
    res.json({
      success: true,
      message: 'Limpeza concluída com sucesso',
      data: {
        cleanedSessions,
        cleanedHandoffs,
        cleanedBuffers
      }
    });
    
    logger.info('WhatsApp cleanup completed', {
      cleanedSessions,
      cleanedHandoffs,
      cleanedBuffers
    });
  } catch (error) {
    logger.error('Error during cleanup:', error);
    res.status(500).json({
      success: false,
      message: 'Erro durante limpeza'
    });
  }
});

export default router;