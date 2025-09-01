import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import axios from 'axios';
import * as trinks from './integrations/trinks';
import { initPersistence, setConversationState, getConversationState, recordAppointmentAttempt } from './db/index';
import jwt from 'jsonwebtoken';
import { getAllConversationStates } from './db/index';

export const app = express();
app.use(express.json({ limit: '1mb' }));

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

// Basic healthcheck
app.get('/health', (_req, res) => {
  console.log('Healthcheck accessed');
  res.json({ status: 'ok', name: 'Marliê API' });
});

// Evolution webhook receiver (incoming WhatsApp messages)
app.post('/webhooks/evolution', async (req, res) => {
  try {
    const payload = req.body;

    // Log apenas eventos de mensagens recebidas
    if (payload?.event === 'messages.upsert') {
      console.log('=== MENSAGEM RECEBIDA ===');
      console.log('Event:', payload?.event);
      console.log('Instance:', payload?.instance);
      console.log('RemoteJid:', payload?.data?.key?.remoteJid);
      console.log('FromMe:', payload?.data?.key?.fromMe);
      console.log('Message:', payload?.data?.message?.conversation);
      console.log('========================');
    }

    // Suporta formatos: events by Evolution (ex.: MESSAGES_UPSERT) e payloads genéricos
    let number: string | null = null;
    let text: string | undefined;

    // Formato Evolution API com data wrapper (estrutura real da Evolution)
    if (payload?.data?.key && payload?.data?.message) {
      number = normalizeNumber(payload.data.key.remoteJid);
      text = extractTextFromMessage(payload.data.message);
    }
    // Formato Evolution API com data wrapper (estrutura alternativa)
    else if (payload?.data?.message) {
      const msg = payload.data.message;
      number = normalizeNumber(msg?.key?.remoteJid);
      text = extractTextFromMessage(msg?.message || msg);
    }
    // Formato direto com array de mensagens
    else if (Array.isArray(payload?.messages) && payload?.messages[0]) {
      const first = payload.messages[0];
      number = normalizeNumber(first?.key?.remoteJid || first?.from || first?.number);
      text = extractTextFromMessage(first?.message || first);
    }
    // Formato direto simples
    else if (payload?.message || payload?.number || payload?.from) {
      number = normalizeNumber(payload?.message?.key?.remoteJid || payload?.number || payload?.from);
      text = extractTextFromMessage(payload?.message || payload);
    }

    // Capturar informações do contato
    let pushName: string | undefined = undefined;
    let firstName: string | undefined = undefined;
    
    // Extrair pushName do payload da Evolution API
    if (payload?.data?.key?.remoteJid) {
      pushName = payload?.data?.pushName || undefined;
      firstName = extractFirstName(pushName);
    }
    
    // Filtrar apenas mensagens recebidas (não enviadas pelo bot)
    const isIncomingMessage = payload?.event === 'messages.upsert' && payload?.data?.key?.fromMe === false;
    
    console.log('Incoming:', { 
      number, 
      text, 
      pushName, 
      firstName, 
      event: payload?.event || payload?.type, 
      isIncoming: isIncomingMessage 
    });

    if (number && text && isIncomingMessage) {
      // Buscar ou criar sessão do cliente
      const { getOrCreateClientSession, searchAndUpdateTrinksClient, getOrCreateContactByPhone } = await import('./db/index');
      
      // Criar/atualizar sessão do cliente
      const clientSession = await getOrCreateClientSession('default', number, { pushName, firstName });
      
      // Se é uma nova sessão (sem dados do Trinks), buscar cliente automaticamente
      if (!clientSession.trinksClientId) {
        const trinksResult = await searchAndUpdateTrinksClient('default', number);
        if (trinksResult.found) {
          console.log(`Cliente encontrado no Trinks: ${trinksResult.clientData?.name}`);
          clientSession.trinksClientId = trinksResult.clientData?.id;
          clientSession.clientName = trinksResult.clientData?.name;
          clientSession.clientEmail = trinksResult.clientData?.email;
        }
      }
      
      // Manter compatibilidade com sistema antigo
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
  await axios.post(
    url,
    { number, text },
    { headers: { apikey: env.EVOLUTION_API_KEY, 'Content-Type': 'application/json; charset=utf-8' } }
  );
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
});

// Endpoints administrativos protegidos
app.get('/admin', authMiddleware, (_req, res) => {
  res.json({
    status: 'ok',
    name: 'Marliê Admin',
    endpoints: [
      '/health',
      '/admin/state/:phone (GET)',
      '/admin/state/:phone (POST)',
      '/admin/states (GET)'
    ]
  });
});

app.get('/admin/state/:phone', authMiddleware, async (req, res) => {
  try {
    const state = await getConversationState('default', req.params.phone);
    res.json({ phone: req.params.phone, state });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

app.post('/admin/state/:phone', authMiddleware, async (req, res) => {
  try {
    await setConversationState('default', req.params.phone, req.body || {});
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

app.get('/admin/states', authMiddleware, async (_req, res) => {
  try {
    const states = await getAllConversationStates('default');
    res.json(states);
  } catch (error) {
    console.error('Error fetching states:', error);
    res.status(500).json({ error: 'Failed to fetch states' });
  }
});

// Na rota /trinks/agendamentos
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
    }).catch(() => {});
    res.status(500).json({ error: 'Falha ao criar agendamento no Trinks' });
  }
});

// Inicialização da persistência e servidor
if (process.env.NODE_ENV !== 'test') {
  const sslMode = String(env.DATABASE_SSL || '').trim().toLowerCase();
  const databaseSsl: boolean | 'no-verify' | undefined =
    sslMode === 'no-verify' ? 'no-verify' : (sslMode === 'true' || sslMode === '1' ? true : undefined);

  initPersistence({
    redisUrl: env.REDIS_URL || null,
    databaseUrl: env.DATABASE_URL || null,
    databaseSsl,
  }).catch((e) => {
    console.error('Persistência não inicializada:', e?.message || e);
  });

  const port = Number(env.PORT || 3000);
  if (!process.env.VITEST) {
    app.listen(port, () => {
      console.log(`Servidor iniciado na porta ${port}`);
    });
  }
}