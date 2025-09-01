import { chatCompletion, ChatMessage } from '../llm/openai';
import * as trinks from '../integrations/trinks';
import { getConversationState, setConversationState, recordAppointmentAttempt, addMessageToHistory } from '../db/index';

function normalizeNumber(input?: string): string | null {
  if (!input) return null;
  const jid = input.includes('@') ? input.split('@')[0] : input;
  const digits = jid.replace(/\D+/g, '');
  return digits.length ? digits : null;
}

type Extracted = {
  intent: 'faq' | 'hours' | 'create_user' | 'schedule' | 'other';
  question?: string;
  // cadastro
  name?: string;
  phone?: string;
  email?: string;
  // agendamento
  serviceName?: string;
  date?: string; // preferencialmente ISO ou "aaaa-mm-dd"
  time?: string; // preferencialmente HH:mm
  professionalName?: string;
  // slots persistentes
  slots?: any;
};

async function extractIntentAndSlots(text: string): Promise<Extracted> {
  const system: ChatMessage = {
    role: 'system',
    content:
      'Você é Marliê, assistente do Ateliê Marcleia Abade. Extraia intenção e slots do usuário e responda APENAS em JSON. Campos: intent (faq|hours|create_user|schedule|other), question, name, phone, email, serviceName, date (ISO ou aaaa-mm-dd), time (HH:mm), professionalName.',
  };
  const user: ChatMessage = { role: 'user', content: text };
  let raw = '';
  try {
    raw = await chatCompletion([system, user]);
  } catch {
    return { intent: 'other' };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      intent: parsed.intent || 'other',
      question: parsed.question,
      name: parsed.name,
      phone: parsed.phone,
      email: parsed.email,
      serviceName: parsed.serviceName,
      date: parsed.date,
      time: parsed.time,
      professionalName: parsed.professionalName,
    } as Extracted;
  } catch {
    return { intent: 'other' };
  }
}

async function ensureTrinksClientByPhone(whatsPhone: string, nameFallback?: string) {
  try {
    const found = await trinks.Trinks.buscarClientes({ telefone: whatsPhone });
    const first = Array.isArray(found?.data) ? found.data[0] : (found?.[0] ?? null);
    if (first?.id) return first;
  } catch {}
  // cria cliente mínimo
  const payload = {
    nome: nameFallback || `Cliente ${whatsPhone}`,
    telefone: whatsPhone,
  };
  try {
    const created = await trinks.Trinks.criarCliente(payload);
    return created;
  } catch (e: any) {
    throw new Error('Não foi possível localizar/criar cliente no Trinks');
  }
}

async function resolveServiceInfoByName(nameLike: string): Promise<{ id: number; duracaoEmMinutos: number; valor: number } | null> {
  try {
    const services = await trinks.Trinks.buscarServicos({ nome: nameLike });
    const list = services?.data || services || [];
    const first = Array.isArray(list) ? list[0] : null;
    if (!first) return null;
    const id = Number(first.id ?? first.servicoId ?? first.codigo ?? 0);
    const dur = Number(first.duracaoEmMinutos ?? first.duracao ?? first.duracao_minutos ?? 30);
    const val = Number(first.valor ?? first.preco ?? first.precoAtual ?? 0);
    if (!id) return null;
    return { id, duracaoEmMinutos: isNaN(dur) ? 30 : dur, valor: isNaN(val) ? 0 : val };
  } catch (e) {
    return null;
  }
}

function combineDateTime(date?: string, time?: string): string | null {
  if (!date || !time) return null;
  const d = new Date(`${date}T${time}:00`);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

export async function replyForMessage(text: string, phoneNumber?: string, contactInfo?: { pushName?: string; firstName?: string; clientSession?: any }): Promise<string> {
  // Tenta um fluxo orquestrado para cadastro/agendamento; se não, responde genericamente
  const number = normalizeNumber(phoneNumber) || undefined;
  const currentState = number ? await getConversationState('default', number) : null;
  const slots = { ...(currentState?.slots || {}) } as any;
  
  // Adicionar mensagem do usuário ao histórico
  const messageHistory = addMessageToHistory(currentState?.messageHistory, 'user', text);

  // Atualizar sessão do cliente com dados da conversa
  const { updateClientSession } = await import('../db/index');
  
  // Recuperar slots persistentes da sessão
  let persistentSlots = currentState?.slots || {};
  
  // Se há slots de agendamento em andamento, manter contexto
  if (persistentSlots.nomeServico || persistentSlots.data || persistentSlots.hora) {
    console.log('Contexto de agendamento detectado:', persistentSlots);
  }
  
  const sessionData = {
    currentStep: currentState?.etapaAtual || 'inicio',
    slots: persistentSlots,
    lastMessage: text,
    messageCount: messageHistory.length,
    lastActivity: new Date().toISOString()
  };
  
  if (number) {
    await updateClientSession('default', number, { sessionData });
  }

  // 1) Usa LLM para detectar intenção/slots
  let extracted = await extractIntentAndSlots(text);
  
  // Mesclar slots extraídos com slots persistentes
  extracted.slots = { ...persistentSlots };
  
  // Atualizar slots com dados extraídos
  if (extracted.serviceName) extracted.slots.nomeServico = extracted.serviceName;
  if (extracted.date) extracted.slots.data = extracted.date;
  if (extracted.time) extracted.slots.hora = extracted.time;
  if (extracted.name) extracted.slots.nome = extracted.name;
  if (extracted.phone) extracted.slots.telefone = extracted.phone;

  // 2) Se havia um slot aguardando, prioriza interpretação direta do texto
  const awaiting = slots.awaiting as string | undefined;
  if (awaiting) {
    switch (awaiting) {
      case 'name':
        extracted = { intent: 'create_user', name: text, phone: extracted.phone } as Extracted;
        break;
      case 'phone':
        extracted = { intent: 'create_user', name: extracted.name || slots.name, phone: text } as Extracted;
        break;
      case 'serviceName':
        extracted = { intent: 'schedule', serviceName: text, date: extracted.date, time: extracted.time } as Extracted;
        break;
      case 'date':
        extracted = { intent: 'schedule', serviceName: extracted.serviceName || slots.serviceName, date: text, time: extracted.time } as Extracted;
        break;
      case 'time':
        extracted = { intent: 'schedule', serviceName: extracted.serviceName || slots.serviceName, date: extracted.date || slots.date, time: text } as Extracted;
        break;
    }
  }

  if (extracted.intent === 'hours') {
    const greeting = contactInfo?.firstName ? `${contactInfo.firstName}, funcionamos` : 'Funcionamos';
    return `${greeting} de terça a sábado, das 10h às 19h. Como posso ajudar no seu atendimento hoje?`;
  }

  if (extracted.intent === 'create_user') {
    const name = extracted.name || slots.name;
    const phone = normalizeNumber(extracted.phone || number || slots.phone || '');
    if (!name) {
      await setConversationState('default', number || 'unknown', { slots: { ...slots, awaiting: 'name' } });
      const greeting = contactInfo?.firstName ? `Claro, ${contactInfo.firstName}!` : 'Claro!';
      return `${greeting} Para seu cadastro, qual é seu nome completo?`;
    }
    if (!phone) {
      await setConversationState('default', number || 'unknown', { slots: { ...slots, name, awaiting: 'phone' } });
      return 'Perfeito, poderia me informar seu telefone (com DDD)?';
    }
    try {
      await ensureTrinksClientByPhone(phone, name);
      await setConversationState('default', number || 'unknown', { slots: { ...slots, name, phone, awaiting: undefined } });
      const greeting = contactInfo?.firstName ? `${contactInfo.firstName}, seu cadastro` : 'Cadastro';
      return `${greeting} foi localizado/criado com sucesso! Posso te ajudar com agendamento agora?`;
    } catch (e: any) {
      return 'Tive um problema para criar seu cadastro. Pode tentar novamente em instantes, por favor?';
    }
  }

  if (extracted.intent === 'schedule') {
    const serviceName = extracted.slots?.nomeServico || extracted.serviceName;
    const date = extracted.slots?.data || extracted.date;
    const time = extracted.slots?.hora || extracted.time;

    console.log('Agendamento - Slots atuais:', { serviceName, date, time });

    if (!serviceName) {
      const updatedSlots = { ...extracted.slots, awaiting: 'serviceName' };
      await setConversationState('default', number || 'unknown', { 
        slots: updatedSlots,
        messageHistory,
        contactInfo,
        etapaAtual: 'aguardando_servico',
        lastText: text
      });
      
      // Resposta mais natural sem repetir nome
      if (messageHistory.length <= 2) {
        const greeting = contactInfo?.firstName ? `Ótimo, ${contactInfo.firstName}!` : 'Ótimo!';
        return `${greeting} Qual serviço você deseja agendar?`;
      } else {
        return 'Qual serviço você gostaria de agendar?';
      }
    }

    // tentar resolver serviço no Trinks
    const info = await resolveServiceInfoByName(serviceName);
    if (!info) {
      const updatedSlots = { ...extracted.slots, awaiting: 'serviceName' };
      await setConversationState('default', number || 'unknown', { 
        slots: updatedSlots,
        messageHistory,
        contactInfo,
        etapaAtual: 'aguardando_servico',
        lastText: text
      });
      return 'Não encontrei esse serviço. Poderia informar o nome exatamente como aparece no nosso catálogo?';
    }

    if (!date) {
      const updatedSlots = { ...extracted.slots, nomeServico: serviceName, awaiting: 'date' };
      await setConversationState('default', number || 'unknown', { 
        slots: updatedSlots,
        messageHistory,
        contactInfo,
        etapaAtual: 'aguardando_data',
        lastText: text
      });
      return `Perfeito! Para qual data você deseja agendar a ${serviceName.toLowerCase()}?`;
    }
    if (!time) {
      const updatedSlots = { ...extracted.slots, nomeServico: serviceName, data: date, awaiting: 'time' };
      await setConversationState('default', number || 'unknown', { 
        slots: updatedSlots,
        messageHistory,
        contactInfo,
        etapaAtual: 'aguardando_horario',
        lastText: text
      });
      return 'E qual horário prefere? (ex: 14:30)';
    }

    const iso = combineDateTime(date, time);
    if (!iso) {
      const updatedSlots = { ...extracted.slots, nomeServico: serviceName, data: date, awaiting: 'time' };
      await setConversationState('default', number || 'unknown', { 
        slots: updatedSlots,
        messageHistory,
        contactInfo,
        etapaAtual: 'aguardando_horario',
        lastText: text
      });
      return 'Não consegui interpretar data/horário. Poderia me confirmar o horário? (ex: 14:30)';
    }

    const clientPhone = number || normalizeNumber(extracted.phone || '') || undefined;
    if (!clientPhone) {
      const updatedSlots = { ...extracted.slots, nomeServico: serviceName, data: date, hora: time, awaiting: 'phone' };
      await setConversationState('default', 'unknown', { 
        slots: updatedSlots,
        messageHistory,
        contactInfo,
        etapaAtual: 'aguardando_telefone',
        lastText: text
      });
      return 'Para concluir, me informe o seu telefone com DDD.';
    }

    try {
      const client = await ensureTrinksClientByPhone(clientPhone);
      const created = await trinks.Trinks.criarAgendamento({
        servicoId: info.id,
        clienteId: Number(client?.id || client?.clienteId || client?.codigo || 0),
        dataHoraInicio: iso,
        duracaoEmMinutos: info.duracaoEmMinutos,
        valor: info.valor || 0,
        confirmado: true,
      });

      await recordAppointmentAttempt({
        tenantId: 'default',
        phone: clientPhone,
        servicoId: info.id,
        clienteId: Number(client?.id || client?.clienteId || client?.codigo || 0),
        dataHoraInicio: iso,
        duracaoEmMinutos: info.duracaoEmMinutos,
        valor: info.valor || 0,
        confirmado: true,
        observacoes: `Agendado via WhatsApp`,
        idempotencyKey: `ag:${clientPhone}:${info.id}:${iso}`,
        trinksPayload: { serviceName, info },
        trinksResponse: created,
        trinksAgendamentoId: created?.id,
        status: 'sucesso',
      });

      const finalSlots = { ...extracted.slots, nomeServico: serviceName, data: date, hora: time, lastAgendamentoId: created?.id, awaiting: undefined };
      await setConversationState('default', number || 'unknown', { slots: finalSlots });
      return `Agendamento realizado com sucesso! Serviço: ${serviceName}. Data: ${date} às ${time}. Qualquer dúvida, estou por aqui.`;
    } catch (e: any) {
      await recordAppointmentAttempt({
        tenantId: 'default',
        phone: clientPhone!,
        servicoId: info.id,
        clienteId: null as any,
        dataHoraInicio: iso,
        duracaoEmMinutos: info.duracaoEmMinutos,
        valor: info.valor || 0,
        confirmado: true,
        observacoes: 'Erro ao tentar agendar via WhatsApp',
        idempotencyKey: `ag:${clientPhone}:${info.id}:${iso}`,
        trinksPayload: { serviceName, info },
        trinksResponse: (e as any)?.response?.data,
        status: 'erro',
      }).catch(() => {});
      return 'Não consegui concluir o agendamento agora. Pode tentar novamente em alguns instantes ou falar com um atendente?';
    }
  }

  // fallback: resposta genérica com contexto histórico
  const clientSession = contactInfo?.clientSession;
  const isKnownClient = clientSession?.clientName;
  const firstName = contactInfo?.firstName;
  
  let contextInfo = '';
  if (isKnownClient) {
    contextInfo = ` O cliente ${clientSession.clientName} já está cadastrado no sistema.`;
  } else if (firstName) {
    contextInfo = ` O primeiro nome do cliente é ${firstName}.`;
  }
  
  const system: ChatMessage = {
    role: 'system',
    content: `Você é Marliê, assistente virtual do Ateliê Marcleia Abade. 

COMUNICAÇÃO:
- Seja natural, simpática e conversacional
- EVITE repetir o nome do cliente em toda mensagem
- Use o nome apenas quando necessário (primeira interação, confirmações importantes)
- Mantenha o contexto da conversa anterior
- Seja objetiva mas calorosa

AGENDAMENTO:
- Para agendamentos: colete serviço, data e horário de forma natural
- Confirme os detalhes antes de finalizar
- Se já tiver algumas informações, não peça novamente

CADASTRO:
- Para novos clientes: solicite nome completo e contato
- Se não souber algo, peça para reformular ou ofereça atendimento humano

CONTEXTO:${contextInfo}`,
  };
  
  // Construir mensagens com histórico para manter contexto
  const messages: ChatMessage[] = [system];
  
  // Adicionar histórico de mensagens (últimas 10 mensagens para não exceder limite de tokens)
  const recentHistory = messageHistory.slice(-10);
  for (const msg of recentHistory) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      messages.push({ role: msg.role, content: msg.content });
    }
  }
  
  try {
    const answer = await chatCompletion(messages);
    
    // Adicionar resposta do assistente ao histórico
    const updatedHistory = addMessageToHistory(messageHistory, 'assistant', answer);
    
    // Salvar estado atualizado com histórico
    if (number) {
      await setConversationState('default', number, {
        etapaAtual: 'mensagem_respondida',
        lastText: text,
        contactInfo,
        messageHistory: updatedHistory,
        slots
      });
    }
    
    return answer;
  } catch {
    return 'Posso te ajudar com informações, horários e agendamentos. Me diga qual serviço deseja, a data e o horário preferidos!';
  }
}