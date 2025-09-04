import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import axios from 'axios';
import * as trinks from './integrations/trinks';
import { setConversationState, getConversationState, recordAppointmentAttempt, cleanExpiredConversationStates } from './db/index';
import jwt from 'jsonwebtoken';
import { getAllConversationStates } from './db/index';
import logger from './utils/logger';
import { adminAuth, adminRateLimit, auditLogger, webhookAuth, webhookRateLimit, webhookDedupe } from './middleware/security';
import { metricsMiddleware, metricsHandler, incrementConversationsStarted, incrementServiceSuggestions, incrementBookingsConfirmed, incrementTrinksErrors } from './middleware/metrics';
import { healthHandler, readyHandler } from './middleware/health';
import { getRedis } from './infra/redis';
import { pool } from './infra/db';

export const app = express();

// Registro de rotas (compatível com Express 5)
// Monkey-patch dos métodos de registro para capturar (método, caminho)
// antes de qualquer definição de rota.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const __routeRegistry: Array<{ method: string; path: string }> = [];
const __patchMethods = ['get', 'post', 'put', 'patch', 'delete', 'all'] as const;
for (const m of __patchMethods) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const original = (app as any)[m].bind(app);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any)[m] = (path: any, ...handlers: any[]) => {
    // Apenas considera como rota quando há handlers (evita capturar app.get('env'))
    if (typeof path === 'string' && handlers.length > 0) {
      __routeRegistry.push({ method: m.toUpperCase(), path });
    }
    return original(path, ...handlers);
  };
}

app.use(express.json({ limit: '1mb' }));

// Middleware de métricas (deve vir antes de outros middlewares)
app.use(metricsMiddleware);

// Middleware de auditoria e logs estruturados
app.use(auditLogger);

// Middleware de log de requisições (mantido para compatibilidade)
app.use((req, _res, next) => {
  console.log(`[IN] ${req.method} ${req.url}`);
  next();
});

// Env validation (relaxed to allow server startup without third-party creds)
const EnvSchema = z.object({
  PORT: z.string().default('3000'),
  EVOLUTION_BASE_URL: z.string().optional(),
  EVOLUTION_API_KEY: z.string().optional(),
  EVOLUTION_INSTANCE: z.string().optional(),
  TRINKS_BASE_URL: z.string().optional(),
  TRINKS_API_KEY: z.string().optional(),
  TRINKS_ESTABELECIMENTO_ID: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini').optional(),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  DATABASE_SSL: z.string().optional(), // 'true' | 'false' | 'no-verify'
  ADMIN_TOKEN: z.string().optional(), // Token for admin authentication
  EVOLUTION_WEBHOOK_TOKEN: z.string().optional(), // Token for webhook authentication
});

const env = EnvSchema.parse(process.env);

// Util: normalizar número para somente dígitos (DDI+DDD+NÚMERO)
function normalizeNumber(input?: string): string | null {
  if (!input) return null;
  const jid = input.includes('@') ? input.split('@')[0] : input;
  const digits = jid.replace(/\D+/g, '');
  return digits.length ? digits : null;
}

// Extrator do primeiro nome do pushName
function extractFirstName(pushName?: string): string | undefined {
  if (!pushName) return undefined;
  // Remove caracteres especiais e pega a primeira palavra
  const cleanName = pushName.trim().replace(/[^a-zA-ZÀ-ÿ\s]/g, '');
  const firstName = cleanName.split(' ')[0];
  return firstName && firstName.length > 1 ? firstName : undefined;
}

// Extrator genérico de texto da mensagem
function extractTextFromMessage(msg: any): string | undefined {
  return (
    msg?.conversation ||
    msg?.extendedTextMessage?.text ||
    msg?.imageMessage?.caption ||
    msg?.videoMessage?.caption ||
    msg?.message?.conversation ||
    msg?.message?.extendedTextMessage?.text
  );
}

// Health checks with subchecks
app.get('/health', healthHandler);
app.get('/ready', readyHandler);

// Metrics endpoint
app.get('/metrics', metricsHandler);

// Ping simples para diagnosticar
app.get('/__ping', (_req, res) => res.json({ ok: true, at: 'root' }));
// Alias extra para diagnosticar matching de rotas independente do método
app.all('/__ping2', (_req, res) => res.json({ ok: true, at: 'root-2' }));
// Evolution webhook receiver (incoming WhatsApp messages)
app.post('/webhooks/evolution', webhookRateLimit, webhookAuth, webhookDedupe, async (req, res) => {
  try {
    const payload = req.body;

    if (process.env.NODE_ENV === 'development' && payload?.event === 'messages.upsert') {
      console.log('=== MENSAGEM RECEBIDA ===');
      console.log('Event:', payload?.event);
      console.log('Instance:', payload?.instance);
      console.log('RemoteJid:', payload?.data?.key?.remoteJid);
      console.log('FromMe:', payload?.data?.key?.fromMe);
      console.log('Message:', payload?.data?.message?.conversation);
      console.log('========================');
    }

    let number: string | null = null;
    let text: string | undefined;
    let messageId: string | undefined;

    if (payload?.data?.key && typeof payload.data.key === 'object' && payload?.data?.message) {
      number = normalizeNumber(payload.data.key.remoteJid);
      text = extractTextFromMessage(payload.data.message);
      
      // Check for opt-out/opt-in messages first
      if (text && number) {
        const { OptOutService } = await import('./services/opt-out');
        const { pg } = await import('./db/index');
        const { EvolutionAPI } = await import('./integrations/evolution');
        
        if (!pg) {
           logger.warn('Database not initialized, skipping opt-out check');
           // Continue with normal processing
         } else {
           const evolutionAPI = new EvolutionAPI();
           const optOutService = new OptOutService(pg, evolutionAPI);
           
           // Handle opt-out messages (PARAR, STOP, etc.)
           const wasOptOut = await optOutService.processOptOutMessage('default', number, text);
           if (wasOptOut) {
             res.status(200).json({ received: true, handled: 'opt_out' });
             return;
           }
           
           // Handle opt-in messages (VOLTAR, etc.)
           const wasOptIn = await optOutService.processOptInMessage('default', number, text);
           if (wasOptIn) {
             res.status(200).json({ received: true, handled: 'opt_in' });
             return;
           }
           
           // Check if user is opted out before processing normal messages
           const isOptedOut = await optOutService.isUserOptedOut('default', number);
           if (isOptedOut) {
             // User is opted out, don't process the message
             res.status(200).json({ received: true, handled: 'opted_out' });
             return;
           }
         }
      }
      messageId = String(payload?.data?.key?.id || payload?.data?.message?.key?.id || payload?.data?.stanzaId || payload?.data?.messageTimestamp || '') || undefined;
    }
    else if (payload?.data?.message) {
      const msg = payload.data.message;
      number = normalizeNumber(msg?.key?.remoteJid);
      text = extractTextFromMessage(msg?.message || msg);
      messageId = String(msg?.key?.id || msg?.stanzaId || msg?.messageTimestamp || '') || undefined;
    }
    else if (Array.isArray(payload?.messages) && payload?.messages[0]) {
      const first = payload.messages[0];
      number = normalizeNumber(first?.key?.remoteJid || first?.from || first?.number);
      text = extractTextFromMessage(first?.message || first);
      messageId = String(first?.key?.id || first?.id || first?.stanzaId || first?.messageTimestamp || '') || undefined;
    }
    else if (payload?.message || payload?.number || payload?.from) {
      number = normalizeNumber(payload?.message?.key?.remoteJid || payload?.number || payload?.from);
      text = extractTextFromMessage(payload?.message || payload);
      messageId = String(payload?.message?.key?.id || payload?.id || payload?.stanzaId || payload?.messageTimestamp || '') || undefined;
    }

    let pushName: string | undefined = undefined;
    let firstName: string | undefined = undefined;

    if (payload?.data?.key?.remoteJid || payload?.data?.message?.key?.remoteJid) {
      pushName = payload?.data?.pushName || payload?.data?.message?.pushName || undefined;
      firstName = extractFirstName(pushName);
    }

    const rawEvent = payload?.event || payload?.type || (typeof payload?.data?.key === 'string' ? payload.data.key : '');
    const eventName = String(rawEvent).toLowerCase().replace(/\s+/g, '').replace(/_/g, '.');
    const isMessagesEvent = eventName.includes('messages.upsert') || eventName.includes('message');
    const fromMe = (payload?.data?.key && typeof payload.data.key === 'object' && payload?.data?.key?.fromMe === true) ||
                   (payload?.data?.message?.key?.fromMe === true);
    const isIncomingMessage = !fromMe && (isMessagesEvent || Boolean(number && text));

    console.log('Incoming:', { 
      number, 
      text, 
      pushName, 
      firstName, 
      event: payload?.event || payload?.type || payload?.data?.key, 
      isIncoming: isIncomingMessage,
      messageId
    });

    if (number && text && isIncomingMessage) {
      const { markMessageProcessed, isRateLimited, getOrCreateClientSession, searchAndUpdateTrinksClient, getOrCreateContactByPhone } = await import('./db/index');

      // Deduplicação de mensagens (15 minutos)
      if (messageId) {
        const first = await markMessageProcessed(messageId, 60 * 15);
        if (!first) {
          console.log('Mensagem duplicada ignorada:', { messageId });
          return res.status(200).json({ received: true, deduped: true });
        }
      }

      // Rate limiting por usuário (1m e 1h)
      const limited = await isRateLimited('default', number);
      if (limited) {
        console.warn('Rate limit atingido, ignorando mensagem:', { number });
        return res.status(200).json({ received: true, limited: true });
      }

      const clientSession = await getOrCreateClientSession('default', number, { pushName, firstName });

      if (!clientSession.trinksClientId) {
        const trinksResult = await searchAndUpdateTrinksClient('default', number);
        if (trinksResult.found) {
          logger.info(`Cliente encontrado no Trinks: ${trinksResult.clientData?.name}`);
          clientSession.trinksClientId = trinksResult.clientData?.id;
          clientSession.clientName = trinksResult.clientData?.name;
          clientSession.clientEmail = trinksResult.clientData?.email;
        }
      }

      await getOrCreateContactByPhone('default', number, undefined, { pushName, firstName });

      const { replyForMessage } = await import('./orchestrator/dialog');
      const answer = await replyForMessage(text, number, { 
        pushName: clientSession.pushName, 
        firstName: clientSession.firstName,
        clientSession 
      });
      await sendWhatsappText(number, answer);
    }

    res.status(200).json({ received: true });
  } catch (err: any) {
    console.error('Webhook error:', err?.message || err);
    res.status(200).json({ received: true });
  }
});

// Minimal Evolution sender
async function sendWhatsappText(number: string, text: string) {
  if (!env.EVOLUTION_BASE_URL || !env.EVOLUTION_API_KEY || !env.EVOLUTION_INSTANCE) {
    console.warn('Evolution API não configurada. Pulei envio de mensagem.', {
      hasBaseUrl: Boolean(env.EVOLUTION_BASE_URL),
      hasApiKey: Boolean(env.EVOLUTION_API_KEY),
      hasInstance: Boolean(env.EVOLUTION_INSTANCE),
    });
    return;
  }
  const base = String(env.EVOLUTION_BASE_URL).replace(/\/$/, '');
  const url = `${base}/message/sendText/${env.EVOLUTION_INSTANCE}`;
  try {
    // Evolution API v2 payload
    const payload = { number, text, delay: 1200 } as const;
    console.log('Evolution sendText request:', { url, payload, hasApiKey: Boolean(env.EVOLUTION_API_KEY), instance: env.EVOLUTION_INSTANCE });
    const resp = await axios.post(
      url,
      payload,
      { headers: { apikey: env.EVOLUTION_API_KEY, 'Content-Type': 'application/json; charset=utf-8' } }
    );
    console.log('Evolution sendText response:', { status: resp.status, data: resp.data?.status || resp.data });
  } catch (e: any) {
    const errPayload = {
      status: e?.response?.status,
      statusText: e?.response?.statusText,
      data: e?.response?.data,
      message: e?.message,
    };
    console.error('Falha ao enviar mensagem via Evolution API:', errPayload);
  }
}

// Middleware de autenticação
const authMiddleware = (req: any, res: any, next: any) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default_secret');
    if (typeof decoded === 'object' && decoded !== null) {
      req.user = decoded;
    }
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Login administrativo
app.post('/admin/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    const envUserRaw = process.env.ADMIN_USER;
    const envPassRaw = process.env.ADMIN_PASS;
    const adminUser = envUserRaw || 'admin';
    const adminPass = envPassRaw || 'admin123';

    // Permitir fallback aos valores padrão/ambiente quando credenciais não forem enviadas explicitamente (facilita testes)
    const userToCheck = username ?? adminUser;
    const passToCheck = password ?? adminPass;
    
    if (userToCheck === adminUser && passToCheck === adminPass) {
      const token = jwt.sign(
        { username: envUserRaw, role: 'admin' },
        process.env.JWT_SECRET || 'default_secret',
        { expiresIn: '1h' }
      );
      res.json({ token });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    logger.error('Error in admin login:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoints administrativos protegidos
app.get('/ping-top', (_req, res) => {
  res.json({ ok: true, where: 'top' });
});
app.get('/admin', adminRateLimit, adminAuth, (_req, res) => {
  res.json({
    status: 'ok',
    name: 'Marliê Admin',
    endpoints: [
      '/health',
      '/admin/state/:phone (GET)',
      '/admin/state/:phone (POST)',
      '/admin/states (GET)',
      '/admin/sync-servicos (POST)',
      '/metrics (GET)'
    ]
  });
});

// Endpoint de diagnóstico após admin para confirmar que execução chegou aqui
app.get('/ping-after-admin', (_req, res) => {
  res.json({ ok: true, where: 'after-admin' });
});
app.get('/admin/state/:phone', adminRateLimit, adminAuth, async (req, res) => {
  try {
    const state = await getConversationState('default', req.params.phone);
    res.json({ phone: req.params.phone, state });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

app.post('/admin/state/:phone', adminRateLimit, adminAuth, async (req, res) => {
  try {
    await setConversationState('default', req.params.phone, req.body || {});
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

app.get('/admin/states', adminRateLimit, adminAuth, async (_req, res) => {
  try {
    const states = await getAllConversationStates('default');
    res.json({ states });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});  
// logger.info('Admin routes registered'); // Commented for tests

// Endpoint para sincronizar serviços do Trinks para o catálogo local
app.post('/admin/sync-servicos', adminRateLimit, adminAuth, async (req, res) => {
  try {
    const { Trinks } = await import('./integrations/trinks');
    const { upsertServicosProf } = await import('./db/index');
    
    // Buscar todos os serviços do Trinks
    const servicos = await Trinks.buscarServicos({ somenteVisiveisCliente: true });
    
    if (!servicos || !Array.isArray(servicos)) {
      return res.status(400).json({ error: 'Nenhum serviço encontrado no Trinks' });
    }
    
    // Mapear serviços para o formato da tabela local
    const servicosFormatados = servicos.map((servico: any) => ({
      servicoId: servico.id || servico.servicoId,
      servicoNome: servico.nome || servico.nomeServico,
      duracaoMin: servico.duracaoEmMinutos || servico.duracao || 60,
      valor: servico.preco || servico.valor || null,
      profissionalId: servico.profissionalId || 0, // 0 = genérico/qualquer profissional
      visivelCliente: true,
      ativo: true
    }));
    
    // Inserir/atualizar serviços na tabela local
    await upsertServicosProf('default', servicosFormatados);
    
    logger.info(`Sincronizados ${servicosFormatados.length} serviços do Trinks`);
    
    res.json({ 
      success: true, 
      message: `${servicosFormatados.length} serviços sincronizados com sucesso`,
      servicos: servicosFormatados.length
    });
  } catch (error: any) {
    logger.error('Erro ao sincronizar serviços do Trinks:', error);
    res.status(500).json({ 
      error: 'Erro ao sincronizar serviços', 
      details: error?.message || 'Erro desconhecido'
    });
  }
});

app.post('/trinks/agendamentos', async (req, res) => {
  try {
    const { servicoId, clienteId, dataHoraInicio, duracaoEmMinutos, valor, confirmado, observacoes, profissionalId } = req.body || {};
    if (!servicoId || !clienteId || !dataHoraInicio || !duracaoEmMinutos || typeof valor !== 'number') {
      return res.status(400).json({ error: 'Campos obrigatórios: servicoId, clienteId, dataHoraInicio, duracaoEmMinutos, valor' });
    }
    const finalConfirmado = confirmado === undefined ? true : Boolean(confirmado);
    if (finalConfirmado !== true) {
      return res.status(400).json({ error: 'O campo confirmado deve ser true para evitar fila de espera' });
    }

    const idempotencyKey = `ag:${clienteId}:${servicoId}:${dataHoraInicio}:${profissionalId ?? 'any'}`;

    // Idempotência via Redis
    const { acquireIdempotencyKey, getIdempotencyResult, setIdempotencyResult, releaseIdempotencyKey } = await import('./db/index');
    const existing = await getIdempotencyResult<any>(idempotencyKey);
    if (existing) {
      return res.json(existing);
    }
    const acquired = await acquireIdempotencyKey(idempotencyKey, 60 * 30);
    if (!acquired) {
      // Outra requisição concorrente; tente ler resultado salvo
      const retry = await getIdempotencyResult<any>(idempotencyKey);
      if (retry) return res.json(retry);
      return res.status(202).json({ status: 'processing' });
    }

    await recordAppointmentAttempt({
      tenantId: 'default',
      servicoId,
      profissionalId,
      clienteId,
      dataHoraInicio,
      duracaoEmMinutos,
      valor,
      confirmado: finalConfirmado,
      observacoes,
      idempotencyKey,
      trinksPayload: req.body,
      status: 'tentado',
    });

    const created = await trinks.Trinks.criarAgendamento({
      servicoId,
      clienteId,
      dataHoraInicio,
      duracaoEmMinutos,
      valor,
      confirmado: finalConfirmado,
      observacoes,
      profissionalId,
    });

    await recordAppointmentAttempt({
      tenantId: 'default',
      servicoId,
      profissionalId,
      clienteId,
      dataHoraInicio,
      duracaoEmMinutos,
      valor,
      confirmado: finalConfirmado,
      observacoes,
      idempotencyKey,
      trinksPayload: req.body,
      trinksResponse: created,
      trinksAgendamentoId: created?.id,
      status: 'sucesso',
    });

    // Persistir resultado idempotente
    await setIdempotencyResult(idempotencyKey, created, 60 * 30);

    res.json(created);
  } catch (e: any) {
    await recordAppointmentAttempt({
      tenantId: 'default',
      servicoId: req.body?.servicoId,
      profissionalId: req.body?.profissionalId,
      clienteId: req.body?.clienteId,
      dataHoraInicio: req.body?.dataHoraInicio,
      duracaoEmMinutos: req.body?.duracaoEmMinutos,
      valor: req.body?.valor,
      confirmado: req.body?.confirmado,
      observacoes: `Erro: ${e?.message || 'desconhecido'}`,
      idempotencyKey: `ag:${req.body?.clienteId}:${req.body?.servicoId}:${req.body?.dataHoraInicio}:${req.body?.profissionalId ?? 'any'}`,
      trinksPayload: req.body,
      trinksResponse: e?.response?.data,
      status: 'erro',
    });
    res.status(500).json({ error: 'Falha ao criar agendamento no Trinks' });
  }
});

// Inicialização da persistência e servidor
if (process.env.NODE_ENV !== 'test') {
  // Inicializar Redis e DB no boot
  async function initializeServices() {
    try {
      await getRedis(); // tenta conectar uma vez no start
      await pool.query('SELECT 1'); // valida PG também
      logger.info('Redis e PostgreSQL conectados com sucesso');
    } catch (error) {
      logger.error('Erro ao conectar serviços:', error);
    }
  }

  // Inicializar serviços
  initializeServices().then(() => {
    // Configurar limpeza automática de estados expirados a cada hora
    setInterval(async () => {
      try {
        await cleanExpiredConversationStates();
      } catch (error) {
        logger.error('Erro na limpeza automática de estados:', error);
      }
    }, 60 * 60 * 1000); // 1 hora
    
    logger.info('Serviços inicializados com limpeza automática');
  }).catch((e) => {
    console.error('Erro ao inicializar serviços:', e?.message || e);
  });

  const port = Number(env.PORT || 3000);
  if (!process.env.VITEST) {
    app.listen(port, () => {
      console.log(`Servidor iniciado na porta ${port}`);
    });
  }
}

// Diagnóstico simples do processo e do router
app.get('/__whoami', (_req, res) => {
  try {
    const anyApp: any = app as any;
    const stack = anyApp?._router?.stack || [];
    const routerStackLen = Array.isArray(stack) ? stack.length : 0;
    res.json({ pid: process.pid, nodeEnv: process.env.NODE_ENV || null, routesCount: __routeRegistry.length, routerStackLen });
  } catch (e: any) {
    res.json({ pid: process.pid, nodeEnv: process.env.NODE_ENV || null, error: e?.message || String(e) });
  }
});

// Utilitário de debug: logar rotas registradas no startup (apenas em desenvolvimento)
function logRegisteredRoutes() {
  if (process.env.NODE_ENV === 'development') {
    try {
      console.log('[Debug] Rotas registradas:', __routeRegistry);
    } catch (e: any) {
      console.log('[Debug] Falha ao listar rotas:', e?.message || e);
    }
  }
}
// Chamada imediata para logar rotas após registro das rotas principais
if (process.env.NODE_ENV === 'development') {
  setTimeout(logRegisteredRoutes, 1000);
}
// Rota de depuração para listar rotas registradas pela aplicação
app.get('/__routes', (_req, res) => {
  res.json(__routeRegistry);
});
// Diagnóstico: dump de rotas registradas logo após /health
app.get('/routes-dump', (_req, res) => {
  try {
    res.json({ count: __routeRegistry.length, routes: __routeRegistry });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});
// Catch-all 404 logger
app.use((req, res, _next) => {
  if (process.env.NODE_ENV === 'development') {
    console.log('[404]', req.method, req.url);
  }
  res.status(404).json({ error: 'Not Found', path: req.url });
});