import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import axios from 'axios';
import * as trinks from './integrations/trinks';
import { initPersistence, setConversationState, getConversationState, recordAppointmentAttempt } from './db/index';
import jwt from 'jsonwebtoken';
import { getAllConversationStates } from './db/index';
import axiosRetry from 'axios-retry';

const app = express();
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

// Basic healthcheck
app.get('/health', (_req, res) => {
  console.log('Healthcheck accessed');
  res.json({ status: 'ok', name: 'Marliê API' });
});

// Evolution webhook receiver (incoming WhatsApp messages)
app.post('/webhooks/evolution', async (req, res) => {
  try {
    const payload = req.body;

    // Suporta formatos: events by Evolution (ex.: MESSAGES_UPSERT) e payloads genéricos
    let number: string | null = null;
    let text: string | undefined;

    if (Array.isArray(payload?.messages) && payload?.messages[0]) {
      const first = payload.messages[0];
      number = normalizeNumber(first?.key?.remoteJid || first?.from || first?.number);
      text = extractTextFromMessage(first?.message || first);
    } else if (payload?.message || payload?.number || payload?.from) {
      number = normalizeNumber(payload?.message?.key?.remoteJid || payload?.number || payload?.from);
      text = extractTextFromMessage(payload?.message || payload);
    }

    console.log('Incoming:', { number, text, event: payload?.event || payload?.type });

    if (number && text) {
      // salva estado mínimo da conversa
      await setConversationState(number, { etapaAtual: 'mensagem_recebida', lastText: text });
      const { replyForMessage } = await import('./orchestrator/dialog');
      const answer = await replyForMessage(text);
      await sendWhatsappText(number, answer);
      // registra resposta
      await setConversationState(number, { etapaAtual: 'mensagem_respondida', lastText: text, slots: { lastAnswer: answer } });
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

// Endpoints administrativos simples
app.get('/admin', (_req, res) => {
  res.json({
    status: 'ok',
    name: 'Marliê Admin',
    endpoints: [
      '/health',
      '/admin/state/:phone (GET)',
      '/admin/state/:phone (POST)'
    ]
  });
});

app.get('/admin/state/:phone', async (req, res) => {
  try {
    const state = await getConversationState('default', req.params.phone);
    res.json({ phone: req.params.phone, state });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

app.post('/admin/state/:phone', async (req, res) => {
  try {
    await setConversationState('default', req.params.phone, req.body || {});
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

// No handler de webhook, se houver uso de estado, adicionar tenant_id
// Por enquanto, o webhook não usa estado diretamente, mas se necessário, integrar.

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
    try {
      const { servicoId, clienteId, dataHoraInicio, duracaoEmMinutos, valor, confirmado, observacoes, profissionalId } = req.body || {};
      const idempotencyKey = `ag:${clienteId}:${servicoId}:${dataHoraInicio}:${profissionalId ?? 'any'}`;
      await recordAppointmentAttempt({
        tenantId: 'default',
        servicoId,
        profissionalId,
        clienteId,
        dataHoraInicio,
        duracaoEmMinutos,
        valor,
        confirmado,
        observacoes,
        idempotencyKey,
        trinksPayload: req.body,
        trinksResponse: e?.response?.data,
        status: 'erro',
      });
    } catch {}
    res.status(e?.response?.status || 500).json({ error: e?.message, data: e?.response?.data });
  }
});

// Inicializa Postgres/Redis na subida do servidor, mas não bloqueia o startup
(async () => {
  try {
    // Init persistence (Redis/Postgres)
    console.log('Initializing persistence...');

    // parse SSL mode
    const sslMode = String(env.DATABASE_SSL || '').trim().toLowerCase();
    const databaseSsl = sslMode === 'no-verify' ? 'no-verify' : (sslMode === 'true' || sslMode === '1' ? true : undefined);

    await initPersistence({
      redisUrl: env.REDIS_URL || null,
      databaseUrl: env.DATABASE_URL || null,
      databaseSsl,
    });
    console.log('Persistence initialized');
  } catch (e) {
    console.error('Persistence init failed:', (e as any)?.message || e);
  }
})();

const port = Number(env.PORT || 3000);
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});



// Util: normalizar número para somente dígitos (DDI+DDD+NÚMERO)
function normalizeNumber(input?: string): string | null {
  if (!input) return null;
  const jid = input.includes('@') ? input.split('@')[0] : input;
  const digits = jid.replace(/\D+/g, '');
  return digits.length ? digits : null;
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

// Middleware de autenticação JWT
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default_secret');
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Token inválido' });
  }
};

// Endpoint de login admin
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    const token = jwt.sign({ username }, process.env.JWT_SECRET || 'default_secret', { expiresIn: '1h' });
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Credenciais inválidas' });
  }
});

// Aplicar middleware às rotas admin
app.get('/admin', authMiddleware, (req, res) => {
  res.json({
    status: 'ok',
    name: 'Marliê Admin',
    endpoints: [
      '/health',
      '/admin/state/:phone (GET)',
      '/admin/state/:phone (POST)'
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

// No handler de webhook, se houver uso de estado, adicionar tenant_id
// Por enquanto, o webhook não usa estado diretamente, mas se necessário, integrar.

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
    try {
      const { servicoId, clienteId, dataHoraInicio, duracaoEmMinutos, valor, confirmado, observacoes, profissionalId } = req.body || {};
      const idempotencyKey = `ag:${clienteId}:${servicoId}:${dataHoraInicio}:${profissionalId ?? 'any'}`;
      await recordAppointmentAttempt({
        tenantId: 'default',
        servicoId,
        profissionalId,
        clienteId,
        dataHoraInicio,
        duracaoEmMinutos,
        valor,
        confirmado,
        observacoes,
        idempotencyKey,
        trinksPayload: req.body,
        trinksResponse: e?.response?.data,
        status: 'erro',
      });
    } catch {}
    res.status(e?.response?.status || 500).json({ error: e?.message, data: e?.response?.data });
  }
});

// Inicializa Postgres/Redis na subida do servidor, mas não bloqueia o startup
(async () => {
  try {
    // Init persistence (Redis/Postgres)
    console.log('Initializing persistence...');

    // parse SSL mode
    const sslMode = String(env.DATABASE_SSL || '').trim().toLowerCase();
    const databaseSsl = sslMode === 'no-verify' ? 'no-verify' : (sslMode === 'true' || sslMode === '1' ? true : undefined);

    await initPersistence({
      redisUrl: env.REDIS_URL || null,
      databaseUrl: env.DATABASE_URL || null,
      databaseSsl,
    });
    console.log('Persistence initialized');
  } catch (e) {
    console.error('Persistence init failed:', (e as any)?.message || e);
  }
})();

const port = Number(env.PORT || 3000);
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});



// Util: normalizar número para somente dígitos (DDI+DDD+NÚMERO)
function normalizeNumber(input?: string): string | null {
  if (!input) return null;
  const jid = input.includes('@') ? input.split('@')[0] : input;
  const digits = jid.replace(/\D+/g, '');
  return digits.length ? digits : null;
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
app.get('/admin/states', authMiddleware, async (req, res) => {
  try {
    const states = await getAllConversationStates('default');
    res.json(states);
  } catch (error) {
    console.error('Error fetching states:', error);
    res.status(500).json({ error: 'Failed to fetch states' });
  }
});
// Aplicar middleware às rotas admin
app.get('/admin', authMiddleware, (req, res) => {
  res.json({
    status: 'ok',
    name: 'Marliê Admin',
    endpoints: [
      '/health',
      '/admin/state/:phone (GET)',
      '/admin/state/:phone (POST)'
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

// No handler de webhook, se houver uso de estado, adicionar tenant_id
// Por enquanto, o webhook não usa estado diretamente, mas se necessário, integrar.

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
    try {
      const { servicoId, clienteId, dataHoraInicio, duracaoEmMinutos, valor, confirmado, observacoes, profissionalId } = req.body || {};
      const idempotencyKey = `ag:${clienteId}:${servicoId}:${dataHoraInicio}:${profissionalId ?? 'any'}`;
      await recordAppointmentAttempt({
        tenantId: 'default',
        servicoId,
        profissionalId,
        clienteId,
        dataHoraInicio,
        duracaoEmMinutos,
        valor,
        confirmado,
        observacoes,
        idempotencyKey,
        trinksPayload: req.body,
        trinksResponse: e?.response?.data,
        status: 'erro',
      });
    } catch {}
    res.status(e?.response?.status || 500).json({ error: e?.message, data: e?.response?.data });
  }
});

// Inicializa Postgres/Redis na subida do servidor, mas não bloqueia o startup
(async () => {
  try {
    // Init persistence (Redis/Postgres)
    console.log('Initializing persistence...');

    // parse SSL mode
    const sslMode = String(env.DATABASE_SSL || '').trim().toLowerCase();
    const databaseSsl = sslMode === 'no-verify' ? 'no-verify' : (sslMode === 'true' || sslMode === '1' ? true : undefined);

    await initPersistence({
      redisUrl: env.REDIS_URL || null,
      databaseUrl: env.DATABASE_URL || null,
      databaseSsl,
    });
    console.log('Persistence initialized');
  } catch (e) {
    console.error('Persistence init failed:', (e as any)?.message || e);
  }
})();

const port = Number(env.PORT || 3000);
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});



// Util: normalizar número para somente dígitos (DDI+DDD+NÚMERO)
function normalizeNumber(input?: string): string | null {
  if (!input) return null;
  const jid = input.includes('@') ? input.split('@')[0] : input;
  const digits = jid.replace(/\D+/g, '');
  return digits.length ? digits : null;
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
async function sendMessageToEvolution(phone: string, text: string) {
  try {
    const response = await evolutionClient.post('/message/sendText/' + env.EVOLUTION_INSTANCE, {
      number: phone,
      options: { delay: 1200 },
      content: { text },
    });
    console.log('Mensagem enviada para Evolution:', response.data);
  } catch (error) {
    console.error('Erro ao enviar mensagem para Evolution:', error);
    throw new Error('Falha ao enviar resposta');
  }
}
app.get('/admin/states', authMiddleware, async (req, res) => {
  try {
    const states = await getAllConversationStates('default');
    res.json(states);
  } catch (error) {
    console.error('Error fetching states:', error);
    res.status(500).json({ error: 'Failed to fetch states' });
  }
});
// Aplicar middleware às rotas admin
app.get('/admin', authMiddleware, (req, res) => {
  res.json({
    status: 'ok',
    name: 'Marliê Admin',
    endpoints: [
      '/health',
      '/admin/state/:phone (GET)',
      '/admin/state/:phone (POST)'
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

// No handler de webhook, se houver uso de estado, adicionar tenant_id
// Por enquanto, o webhook não usa estado diretamente, mas se necessário, integrar.

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
    try {
      const { servicoId, clienteId, dataHoraInicio, duracaoEmMinutos, valor, confirmado, observacoes, profissionalId } = req.body || {};
      const idempotencyKey = `ag:${clienteId}:${servicoId}:${dataHoraInicio}:${profissionalId ?? 'any'}`;
      await recordAppointmentAttempt({
        tenantId: 'default',
        servicoId,
        profissionalId,
        clienteId,
        dataHoraInicio,
        duracaoEmMinutos,
        valor,
        confirmado,
        observacoes,
        idempotencyKey,
        trinksPayload: req.body,
        trinksResponse: e?.response?.data,
        status: 'erro',
      });
    } catch {}
    res.status(e?.response?.status || 500).json({ error: e?.message, data: e?.response?.data });
  }
});

// Inicializa Postgres/Redis na subida do servidor, mas não bloqueia o startup
(async () => {
  try {
    // Init persistence (Redis/Postgres)
    console.log('Initializing persistence...');

    // parse SSL mode
    const sslMode = String(env.DATABASE_SSL || '').trim().toLowerCase();
    const databaseSsl = sslMode === 'no-verify' ? 'no-verify' : (sslMode === 'true' || sslMode === '1' ? true : undefined);

    await initPersistence({
      redisUrl: env.REDIS_URL || null,
      databaseUrl: env.DATABASE_URL || null,
      databaseSsl,
    });
    console.log('Persistence initialized');
  } catch (e) {
    console.error('Persistence init failed:', (e as any)?.message || e);
  }
})();

const port = Number(env.PORT || 3000);
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});



// Util: normalizar número para somente dígitos (DDI+DDD+NÚMERO)
function normalizeNumber(input?: string): string | null {
  if (!input) return null;
  const jid = input.includes('@') ? input.split('@')[0] : input;
  const digits = jid.replace(/\D+/g, '');
  return digits.length ? digits : null;
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