import { chatCompletion, ChatMessage } from '../llm/openai';
import * as trinks from '../integrations/trinks';
import { getConversationState, setConversationState, recordAppointmentAttempt, addMessageToHistory } from '../db/index';
// import { queryRag } from '../utils/rag'; // Temporariamente desabilitado
import logger from '../utils/logger';
import { incrementConversationsStarted, incrementServiceSuggestions, incrementBookingsConfirmed, incrementTrinksErrors } from '../middleware/metrics';
import { suggestProactiveTimeSlots, parseRelativeDateTime, detectShortcuts, convertRelativeDateToISO } from '../utils/proactive-scheduling';
import { resolveCompleteDateTime, combineDateAndTime, formatDateBR, formatTimeBR, isPastDateTime } from '../utils/date-resolver';
import { processShortcut, processShortcutFollowUp } from '../utils/shortcuts';
import { recommendSlots, RecommendedSlot } from '../utils/recommendation-engine';
import { generateBookingSummary, generatePostBookingCTAs as generateComplementaryCTAs, processCTAResponse } from '../utils/post-booking-templates';
import { UpsellEngine, isUpsellResponse } from '../utils/upsell-engine';
import { PreVisitNotificationEngine } from '../utils/pre-visit-notifications';

import { pg, recordPostBookingInteraction } from '../db/index';

function normalizeNumber(input?: string): string | null {
  if (!input) return null;
  const jid = input.includes('@') ? input.split('@')[0] : input;
  const digits = jid.replace(/\D+/g, '');
  return digits.length ? digits : null;
}

type Extracted = {
  intent: 'agendar' | 'remarcar' | 'cancelar' | 'consultar_preco' | 'consultar_endereco' | 'confirmar' | 'negar' | 'saudacao' | 'outros';
  serviceName?: string;
  dateRel?: string; // termos relativos como "amanhã", "hoje"
  dateISO?: string; // formato YYYY-MM-DD
  period?: string; // "manhã", "tarde", "noite"
  timeISO?: string; // formato HH:MM
  professionalName?: string;
  action?: string; // "remarcar", "cancelar", "preço", "endereço"
  // slots persistentes para compatibilidade
  slots?: any;
};

export async function extractIntentAndSlots(text: string): Promise<Extracted> {
  // logger.debug(`Extraindo intenção e slots para texto: ${text}`); // Temporariamente comentado para testes
  // const ragContext = await queryRag('Trinks API endpoints for scheduling and availability'); // Temporariamente desabilitado
  const ragContext = 'API Trinks: endpoints para agendamentos, verificação de disponibilidade, busca de clientes e serviços.';
  const system: ChatMessage = {
    role: 'system',
    content: `Você é Marliê, assistente do Ateliê Marcleia Abade. Extraia informações estruturadas de mensagens em português brasileiro (variações da Bahia) e responda APENAS em JSON válido.

Schema JSON obrigatório:
{
  "intent": "string", // obrigatório: agendar|remarcar|cancelar|consultar_preco|consultar_endereco|confirmar|negar|saudacao|outros
  "serviceName": "string?", // opcional: cutilagem, esmaltação, progressiva, design de sobrancelha, manicure, pedicure, hidratação, escova, corte, coloração, luzes, babyliss, chapinha
  "dateRel": "string?", // opcional: termos relativos como "amanhã", "hoje", "segunda"
  "dateISO": "string?", // opcional: formato YYYY-MM-DD
  "period": "string?", // opcional: "manhã", "tarde", "noite"
  "timeISO": "string?", // opcional: formato HH:MM
  "professionalName": "string?", // opcional
  "action": "string?" // opcional: "remarcar", "cancelar", "preço", "endereço"
}

Mapeamento de períodos:
- manhã: 09:00-12:00
- tarde: 13:30-17:30
- noite: 18:00-20:00

Variações regionais (Bahia):
- "cedinho" = manhã cedo
- "finalzinho" = final do período
- "mais pra" = aproximadamente
- "tá bom" = confirmação
- "dá pra" = é possível

Exemplos:
"Quero fazer uma cutilagem amanhã de tarde" -> {"intent": "agendar", "serviceName": "cutilagem", "dateRel": "amanhã", "period": "tarde"}
"Dá pra amanhã às 14:30?" -> {"intent": "agendar", "dateRel": "amanhã", "timeISO": "14:30"}
"Qual valor da cutilagem?" -> {"intent": "consultar_preco", "serviceName": "cutilagem"}
"Quero remarcar" -> {"intent": "remarcar", "action": "remarcar"}
"Finalzinho da tarde tá bom" -> {"intent": "confirmar", "period": "tarde"}

Contexto da API Trinks: ${ragContext}

RETORNE APENAS JSON VÁLIDO SEM TEXTO ADICIONAL.`
  };
  const user: ChatMessage = { role: 'user', content: text };
  let raw = '';
  try {
    raw = await chatCompletion([system, user]);
  } catch {
    return { intent: 'outros' };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      intent: parsed.intent || 'outros',
      serviceName: parsed.serviceName,
      dateRel: parsed.dateRel,
      dateISO: parsed.dateISO,
      period: parsed.period,
      timeISO: parsed.timeISO,
      professionalName: parsed.professionalName,
      action: parsed.action,
    } as Extracted;
  } catch {
    return { intent: 'outros' };
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
    // Incrementar métrica de erros da API Trinks
    const errorCode = e?.response?.status?.toString() || 'unknown';
    incrementTrinksErrors(errorCode, 'cliente');
    throw new Error('Não foi possível localizar/criar cliente no Trinks');
  }
}

async function resolveServiceInfoByName(nameLike: string): Promise<{ id: number; duracaoEmMinutos: number; valor: number } | null> {
  try {
    const q = (nameLike || '').trim().toLowerCase();
    // Evitar aceitar categorias genéricas (inclui variações comuns)
    const categoriasGenericas = [
      'manicure', 'pedicure', 'unha', 'unhas', 'cabelo', 'cabelos', 'barba', 'sobrancelha', 'sobrancelhas',
      'depilação', 'depilacao', 'depilar', 'depil', 'cílios', 'cilios', 'maquiagem', 'make', 'estética', 'estetica'
    ];
    const isCategoria = categoriasGenericas.includes(q);

    // Primeiro tentar catálogo local para reduzir chamadas externas
    const { getServicosSuggestions } = await import('../db/index');
    const localCandidates = await getServicosSuggestions('default', nameLike, 5);
    if (localCandidates && localCandidates.length > 0) {
      // Caso o usuário tenha passado termo exato de um serviço local
      const exact = localCandidates.find(s => s.servicoNome.toLowerCase() === q);
      const chosen = exact || localCandidates[0];
      if (chosen?.servicoId && chosen?.duracaoMin > 0) {
        return { id: chosen.servicoId, duracaoEmMinutos: chosen.duracaoMin, valor: Number(chosen.valor ?? 0) };
      }
    }

    // Se for claramente categoria e não há match local, evite buscar tudo fora e retorne null
    if (isCategoria) {
      return null;
    }

    // Buscar apenas serviços visíveis ao cliente para evitar categorias/itens ocultos
    const services = await trinks.Trinks.buscarServicos({ nome: nameLike, somenteVisiveisCliente: true });
    const list = services?.data || services || [];
    const arr = Array.isArray(list) ? list : [];
    if (arr.length === 0) return null;

    // Heurísticas para filtrar apenas serviços agendáveis (evitar categorias)
    const isAgendavel = (s: any) => {
      const dur = Number(s.duracaoEmMinutos ?? s.duracao ?? s.duracao_minutos ?? 0);
      const hasChildren = Array.isArray(s.itens) || Array.isArray(s.subitens) || Array.isArray(s.subservicos);
      const tipo = String(s.tipo ?? s.categoria ?? '').toLowerCase();
      const looksCategory = s.isCategoria === true || tipo === 'categoria' || hasChildren === true;
      const hasValidId = Number(s.id ?? s.servicoId ?? s.codigo ?? 0) > 0;
      return hasValidId && dur > 0 && !looksCategory;
    };

    const candidates = arr.filter(isAgendavel);
    if (candidates.length === 0) return null;

    // Tentativa 1: match exato por nome dentro dos candidatos
    let found = candidates.find((s: any) => String(s.nome || s.nomeservico || '').toLowerCase() === q);
    // Tentativa 2: match por inclusão
    if (!found) found = candidates.find((s: any) => String(s.nome || s.nomeservico || '').toLowerCase().includes(q));

    const first = found || candidates[0];
    const id = Number(first.id ?? first.servicoId ?? first.codigo ?? 0);
    const dur = Number(first.duracaoEmMinutos ?? first.duracao ?? first.duracao_minutos ?? 30);
    const val = Number(first.valor ?? first.preco ?? first.precoAtual ?? 0);
    if (!id || !(dur > 0)) return null;
    return { id, duracaoEmMinutos: isNaN(dur) ? 30 : dur, valor: isNaN(val) ? 0 : val };
  } catch (e) {
    return null;
  }
}

// Função removida - agora usando combineDateAndTime do date-resolver

type SchedulingState = 'initial' | 'collecting_service' | 'collecting_date' | 'collecting_time' | 'verifying_availability' | 'confirming' | 'done' | 'error';

export async function replyForMessage(text: string, phoneNumber?: string, contactInfo?: { pushName?: string; firstName?: string; clientSession?: any }): Promise<string> {
  // logger.debug(`Processando mensagem de ${phoneNumber}: ${text}`);
  const number = normalizeNumber(phoneNumber) || undefined;
  const currentState = number ? await getConversationState('default', number) : null;
  let currentSchedulingState: SchedulingState = (currentState?.etapaAtual as SchedulingState) || 'initial';
  // Tenta um fluxo orquestrado para cadastro/agendamento; se não, responde genericamente
  const slots = { ...(currentState?.slots || {}) } as any;
  
  // Adicionar mensagem do usuário ao histórico
  const messageHistory = addMessageToHistory(currentState?.messageHistory, 'user', text);
  
  // Incrementar métrica de conversas iniciadas para novas conversas
  if (!currentState || messageHistory.length <= 2) {
    incrementConversationsStarted('default');
  }

  // Atualizar sessão do cliente com dados da conversa
  const { updateClientSession } = await import('../db/index');
  
  // Recuperar slots persistentes da sessão
  let persistentSlots = currentState?.slots || {};
  
  // Se há slots de agendamento em andamento, manter contexto
  if (persistentSlots.nomeServico || persistentSlots.data || persistentSlots.hora) {
    // logger.debug('Contexto de agendamento detectado:', persistentSlots);
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

  // 0) Verificar se é um atalho primeiro
  if (number) {
    const shortcutResult = await processShortcut(text, number, currentState);
    if (shortcutResult.action !== 'none') {
      // Atualizar estado se necessário
      if (shortcutResult.requiresFollowUp) {
        await setConversationState('default', number, {
          etapaAtual: 'shortcut_followup',
          slots: { ...persistentSlots, shortcutContext: shortcutResult.followUpContext },
          messageHistory
        });
      }
      return shortcutResult.response;
    }
    
    // Verificar se é follow-up de atalho
    if (currentState?.etapaAtual === 'shortcut_followup' && persistentSlots.shortcutContext) {
      const followUpResult = await processShortcutFollowUp(text, number, persistentSlots.shortcutContext);
      if (followUpResult.action !== 'none') {
        // Limpar contexto de atalho se não precisar de mais follow-up
        if (!followUpResult.requiresFollowUp) {
          await setConversationState('default', number, {
            etapaAtual: 'initial',
            slots: { ...persistentSlots, shortcutContext: undefined },
            messageHistory
          });
        } else {
          await setConversationState('default', number, {
            etapaAtual: 'shortcut_followup',
            slots: { ...persistentSlots, shortcutContext: followUpResult.followUpContext },
            messageHistory
          });
        }
        return followUpResult.response;
      }
    }
  }
  
  // Processar respostas aos CTAs pós-agendamento
   if (currentState?.etapaAtual?.startsWith('aguardando_cta_')) {
     const ctaType = currentState.etapaAtual.replace('aguardando_cta_', '');
     const lastBookingId = currentState.slots?.lastAgendamentoId;
     
     if (lastBookingId && number) {
       const ctaResponse = processCTAResponse(
          ctaType as 'reminder' | 'location' | 'paymentMethod',
          text,
          {
            bookingId: lastBookingId,
            serviceName: currentState.slots?.nomeServico || 'Serviço',
            date: currentState.slots?.data || '',
            time: currentState.slots?.hora || '',
            clientName: currentState.slots?.nomeCliente || 'Cliente'
          }
        );
       
       if (ctaResponse) {
         // Limpar estado de CTA
         const updatedSlots = { ...currentState.slots };
         await setConversationState('default', number, {
           ...currentState,
           etapaAtual: 'initial',
           slots: updatedSlots,
           messageHistory
         });
         
         return ctaResponse.response;
       }
     }
   }
   
   // Processar respostas de upsell
   if (currentState?.etapaAtual === 'aguardando_upsell' && number) {
     const upsellEngine = new UpsellEngine('default');
     const serviceName = currentState.slots?.nomeServico;
     const servicePrice = currentState.slots?.servicePrice || 0;
     
     if (serviceName) {
       const upsellResult = await upsellEngine.processUpsellResponse(text, {
         tenantId: 'default',
         phone: number,
         selectedServiceName: serviceName,
         selectedServicePrice: servicePrice
       });
       
       // Atualizar estado para continuar com agendamento
       const updatedSlots = { 
         ...currentState.slots, 
         upsellAccepted: upsellResult.accepted,
         awaiting: 'date'
       };
       
       await setConversationState('default', number, {
         ...currentState,
         etapaAtual: 'aguardando_data',
         slots: updatedSlots,
         messageHistory
       });
       
       return upsellResult.message;
     }
   }
  
  // 1) Usa LLM para detectar intenção/slots
  let extracted = await extractIntentAndSlots(text);
  
  // Mesclar slots extraídos com slots persistentes
  extracted.slots = { ...persistentSlots };
  
  // Atualizar slots com dados extraídos
  if (extracted.serviceName) extracted.slots.nomeServico = extracted.serviceName;
  if (extracted.dateRel || extracted.dateISO) extracted.slots.data = extracted.dateRel || extracted.dateISO;
  if (extracted.timeISO) extracted.slots.hora = extracted.timeISO;
  if (extracted.slots?.name) extracted.slots.nome = extracted.slots.name;
  if (extracted.slots?.phone) extracted.slots.telefone = extracted.slots.phone;

  // 2) Se havia um slot aguardando, prioriza interpretação direta do texto
  const awaiting = slots.awaiting as string | undefined;
  if (awaiting) {
    switch (awaiting) {
      case 'name':
        extracted = { intent: 'outros', slots: { ...extracted.slots, name: text, phone: extracted.slots?.phone } } as Extracted;
        break;
      case 'phone':
        extracted = { intent: 'outros', slots: { ...extracted.slots, name: extracted.slots?.name || slots.name, phone: text } } as Extracted;
        break;
      case 'serviceName': {
        // Permitir o usuário digitar o número da sugestão
        const raw = (text || '').trim();
        const num = parseInt(raw, 10);
        const sugestoes = (slots as any)?.serviceSuggestions as Array<{ id: number; nome: string; duracaoMin: number; valor?: number | null }> | undefined;
        if (Number.isInteger(num) && sugestoes && sugestoes.length > 0) {
          const idx = num - 1;
          const chosen = sugestoes[idx];
          if (chosen) {
            const newSlots = { ...slots, nomeServico: chosen.nome, servicoSelecionado: chosen, serviceSuggestions: undefined } as any;
            await setConversationState('default', number || 'unknown', { slots: newSlots, etapaAtual: currentSchedulingState });
            extracted = { intent: 'agendar', serviceName: chosen.nome, dateRel: extracted.dateRel, timeISO: extracted.timeISO } as Extracted;
            break;
          }
        }
        // Caso contrário, trata como nome livre
        extracted = { intent: 'agendar', serviceName: text, dateRel: extracted.dateRel, timeISO: extracted.timeISO } as Extracted;
        break;
      }
      case 'date':
        extracted = { intent: 'agendar', serviceName: extracted.serviceName || slots.serviceName, dateRel: text, timeISO: extracted.timeISO } as Extracted;
        break;
      case 'time':
        extracted = { intent: 'agendar', serviceName: extracted.serviceName || slots.serviceName, dateRel: extracted.dateRel || slots.date, timeISO: text } as Extracted;
        break;
    }
  }

  if (extracted.intent === 'consultar_endereco') {
    const greeting = contactInfo?.firstName ? `${contactInfo.firstName}, funcionamos` : 'Funcionamos';
    return `${greeting} de terça a sábado, das 10h às 19h. Como posso ajudar no seu atendimento hoje?`;
  }

  if (extracted.slots?.name || extracted.slots?.phone) {
    const name = extracted.slots?.name || slots.name;
    const phone = normalizeNumber(extracted.slots?.phone || number || slots.phone || '');
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
      // logger.error('Erro ao criar usuário:', e);
    // logger.debug(`Falha no cadastro para telefone ${phone}`);
      return 'Tive um problema para criar seu cadastro. Pode tentar novamente em instantes, por favor?';
    }
  }

  if (extracted.intent === 'agendar' || currentSchedulingState !== 'initial') {
    const serviceName = extracted.slots?.nomeServico || extracted.serviceName;
const date = extracted.slots?.data || extracted.dateRel || extracted.dateISO;
const time = extracted.slots?.hora || extracted.timeISO;
// logger.debug(`Estado atual da FSM: ${currentSchedulingState}`);
switch (currentSchedulingState) {
      case 'initial':
        currentSchedulingState = 'collecting_service';
        // fall through
      case 'collecting_service':
        if (serviceName) {
          currentSchedulingState = 'collecting_date';
        } else {
          // lógica para coletar serviceName
          await setConversationState('default', number || 'unknown', { etapaAtual: currentSchedulingState });
          return 'Qual serviço você deseja agendar?';
        }
        break;
      case 'collecting_date':
        if (date) {
          currentSchedulingState = 'collecting_time';
        } else {
          // lógica para coletar date
          await setConversationState('default', number || 'unknown', { etapaAtual: currentSchedulingState });
          return 'Para qual data?';
        }
        break;
      case 'collecting_time':
        if (time) {
          currentSchedulingState = 'verifying_availability';
        } else {
          // lógica para coletar time
          await setConversationState('default', number || 'unknown', { etapaAtual: currentSchedulingState });
          return 'Qual horário?';
        }
        break;
      case 'verifying_availability':
        // lógica de verificação (implementar verificação real aqui)
        const disponibilidade = { disponivel: true }; // Placeholder para compilação
        if (disponibilidade.disponivel) {
          currentSchedulingState = 'confirming';
        } else {
          currentSchedulingState = 'error';
        }
        break;
      case 'confirming':
        // lógica de confirmação
        currentSchedulingState = 'done';
        break;
      case 'done':
      case 'error':
        // reset or handle
        break;
    }

    // logger.debug('Agendamento - Slots atuais:', { serviceName, date, time });

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

    // tentar resolver serviço no Trinks ou local
    // Se já existe um serviço selecionado das sugestões, reutiliza sem nova resolução
    const preSelected = (extracted.slots as any)?.servicoSelecionado as { id: number; nome: string; duracaoMin: number; valor?: number | null } | undefined;
    let info = preSelected ? { id: preSelected.id, duracaoEmMinutos: preSelected.duracaoMin, valor: Number(preSelected.valor ?? 0) } : await resolveServiceInfoByName(serviceName);

    // Se não encontrou, tentar sugerir serviços locais para facilitar escolha
    if (!info) {
      const { getServicosSuggestions } = await import('../db/index');
      const sugs = await getServicosSuggestions('default', serviceName, 5);
      const mapped = sugs.map(s => ({ id: s.servicoId, nome: s.servicoNome, duracaoMin: s.duracaoMin, valor: s.valor ?? null }));
      const updatedSlots = { ...extracted.slots, awaiting: 'serviceName', serviceSuggestions: mapped } as any;
      await setConversationState('default', number || 'unknown', { 
        slots: updatedSlots,
        messageHistory,
        contactInfo,
        etapaAtual: 'aguardando_servico',
        lastText: text
      });
      if (sugs.length > 0) {
        const lista = sugs.map((s, i) => `${i + 1}. ${s.servicoNome}`).join('\n');
        const intro = contactInfo?.firstName ? `${contactInfo.firstName},` : '';
        return `${intro} não identifiquei exatamente o serviço. Veja algumas opções e me diga o número ou o nome exato:\n\n${lista}`;
      }
      const greeting = contactInfo?.firstName ? `${contactInfo.firstName},` : '';
      return `${greeting} entendi que você quer algo em "${serviceName}". Pode me dizer qual serviço específico deseja?`;
    }
    
    // Verificar se deve oferecer upsell após seleção do serviço
    if (serviceName && !currentState?.slots?.upsellOffered && number) {
      const upsellEngine = new UpsellEngine('default');
      const serviceInfo = await resolveServiceInfoByName(serviceName);
      
      if (serviceInfo) {
        const upsellSuggestion = await upsellEngine.generateUpsellSuggestion({
          tenantId: 'default',
          phone: number,
          selectedServiceName: serviceName,
          selectedServicePrice: serviceInfo.valor || 0
        });
        
        if (upsellSuggestion) {
          // Salvar estado aguardando resposta do upsell
          const updatedSlots = { 
            ...extracted.slots, 
            nomeServico: serviceName,
            servicePrice: serviceInfo.valor || 0,
            upsellOffered: true,
            awaiting: 'upsell'
          };
          
          await setConversationState('default', number, {
            slots: updatedSlots,
            messageHistory,
            contactInfo,
            etapaAtual: 'aguardando_upsell',
            lastText: text
          });
          
          return upsellSuggestion;
        }
      }
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
    
    // Verificar se há termos relativos de data/período para sugestão proativa
    if (!time) {
      const relativeDateInfo = parseRelativeDateTime(text);
      
      if (relativeDateInfo.dateRel && relativeDateInfo.period && number) {
        try {
          // Converter data relativa para ISO
          const dateISO = convertRelativeDateToISO(relativeDateInfo.dateRel);
          
          // Usar motor de recomendação para sugestões personalizadas
          const recommendedSlots = await recommendSlots(
            'default',
            number,
            dateISO,
            relativeDateInfo.period === 'manhã' ? 'manha' : relativeDateInfo.period
          );
          
          // Fallback para sugestões proativas padrão se não houver recomendações
          if (recommendedSlots.length > 0) {
            const timeOptions = recommendedSlots.map(slot => slot.time).slice(0, 3).join(', ');
            const dateFormatted = new Date(dateISO).toLocaleDateString('pt-BR');
            const updatedSlots = { 
              ...extracted.slots, 
              nomeServico: serviceName, 
              data: dateISO,
              awaiting: 'time',
              suggestedTimes: recommendedSlots.map(slot => slot.time)
            };
            
            await setConversationState('default', number, { 
              slots: updatedSlots,
              messageHistory,
              contactInfo,
              etapaAtual: 'aguardando_horario_com_sugestoes',
              lastText: text
            });
            
            return `Ótimo! Para ${dateFormatted}, temos estes horários disponíveis:\n\n${timeOptions}\n\nQual prefere?`;
          } else {
            const proactiveSlots = await suggestProactiveTimeSlots(
              info.id,
              info.duracaoEmMinutos,
              dateISO,
              relativeDateInfo.period
            );
            
            if (proactiveSlots.suggestions.length > 0) {
              const timeOptions = proactiveSlots.suggestions.slice(0, 3).join(', ');
              const dateFormatted = new Date(dateISO).toLocaleDateString('pt-BR');
              const updatedSlots = { 
                ...extracted.slots, 
                nomeServico: serviceName, 
                data: dateISO,
                awaiting: 'time',
                suggestedTimes: proactiveSlots.suggestions
              };
              
              await setConversationState('default', number, { 
                slots: updatedSlots,
                messageHistory,
                contactInfo,
                etapaAtual: 'aguardando_horario_com_sugestoes',
                lastText: text
              });
              
              return `Ótimo! Para ${dateFormatted}, temos estes horários disponíveis:\n\n${timeOptions}\n\nQual prefere?`;
            } else if (proactiveSlots.fallbackSuggestions && proactiveSlots.fallbackSuggestions.length > 0) {
              const nextOptions = proactiveSlots.fallbackSuggestions.slice(0, 3).join(', ');
              const dateFormatted = new Date(dateISO).toLocaleDateString('pt-BR');
              const fallbackDateFormatted = new Date(proactiveSlots.fallbackDate + 'T00:00:00').toLocaleDateString('pt-BR');
              const updatedSlots = { 
                ...extracted.slots, 
                nomeServico: serviceName, 
                data: proactiveSlots.fallbackDate,
                awaiting: 'time',
                suggestedTimes: proactiveSlots.fallbackSuggestions
              };
              
              await setConversationState('default', number, { 
                slots: updatedSlots,
                messageHistory,
                contactInfo,
                etapaAtual: 'aguardando_horario_com_sugestoes',
                lastText: text
              });
              
              return `Para ${dateFormatted} não temos disponibilidade. Que tal ${fallbackDateFormatted}?\n\nHorários disponíveis: ${nextOptions}\n\nQual prefere?`;
            }
          }
        } catch (error) {
          // logger.error('Erro ao sugerir horários proativos:', error);
        }
      }
      
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

    const dateTime = combineDateAndTime(date, time);
    const iso = dateTime.toISO();
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

    const clientPhone = number || normalizeNumber(extracted.slots?.phone || '') || undefined;
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
      // Garantir que o serviço existe no catálogo local (economiza e valida)
      const { existsServicoInCatalog } = await import('../db/index');
      const existsLocal = await existsServicoInCatalog('default', info.id);
      if (!existsLocal) {
        const { getServicosSuggestions } = await import('../db/index');
        const sugs = await getServicosSuggestions('default', serviceName, 5);
        const mapped = sugs.map(s => ({ id: s.servicoId, nome: s.servicoNome, duracaoMin: s.duracaoMin, valor: s.valor ?? null }));
        const updatedSlots = { ...extracted.slots, awaiting: 'serviceName', serviceSuggestions: mapped } as any;
        await setConversationState('default', number || 'unknown', { 
          slots: updatedSlots,
          messageHistory,
          contactInfo,
          etapaAtual: 'aguardando_servico',
          lastText: text
        });
        if (sugs.length > 0) {
          // Incrementar métrica de sugestões de serviços
          incrementServiceSuggestions('default', sugs.length);
          const lista = sugs.map((s, i) => `${i + 1}. ${s.servicoNome}`).join('\n');
          return `Antes de prosseguir, preciso que escolha um serviço do nosso catálogo. Algumas opções:\n\n${lista}`;
        }
        return 'O serviço informado não está no nosso catálogo. Pode escolher uma opção específica?';
      }

      // Primeiro, verificar se o horário está disponível
      // logger.debug(`Verificando disponibilidade para serviço ${info.id} em ${date} ${time}`);
const disponibilidade = await trinks.Trinks.verificarHorarioDisponivel({
        data: date,
        hora: time,
        servicoId: info.id,
        duracaoEmMinutos: info.duracaoEmMinutos
      });

      if (disponibilidade.disponivel) {
        // Persistir slots após verificação de disponibilidade bem-sucedida
        await updateClientSession('default', clientPhone, { sessionData: { ...sessionData, slots: { ...extracted.slots, disponibilidadeConfirmada: true } } });
      }

      if (!disponibilidade.disponivel) {
        const updatedSlots = { ...extracted.slots, nomeServico: serviceName, data: date, awaiting: 'time' };
        await setConversationState('default', number || 'unknown', { 
          slots: updatedSlots,
          messageHistory,
          contactInfo,
          etapaAtual: 'aguardando_horario',
          lastText: text
        });
        const motivo = disponibilidade.motivo || 'Horário indisponível';
        return `${motivo}. Pode sugerir outro horário? Se preferir, posso verificar por profissional específico.`;
      }

      const client = await ensureTrinksClientByPhone(clientPhone);
      // Persistir slots após sucesso em ensureTrinksClientByPhone
      await updateClientSession('default', clientPhone, { sessionData: { ...sessionData, slots: extracted.slots } });
      // logger.debug(`Criando agendamento para cliente ${client?.id} em ${iso}`);

      // Idempotência: evitar criar agendamentos duplicados
      const { acquireIdempotencyKey, getIdempotencyResult, setIdempotencyResult } = await import('../db/index');
      const idemKey = `ag:${clientPhone}:${info.id}:${iso}`;
      const existing = await getIdempotencyResult<any>(idemKey);
      if (existing?.id) {
        const finalSlotsExisting = { ...extracted.slots, nomeServico: serviceName, data: date, hora: time, lastAgendamentoId: existing.id, awaiting: undefined };
        await setConversationState('default', number || 'unknown', { slots: finalSlotsExisting });
        await updateClientSession('default', clientPhone, { sessionData: { ...sessionData, slots: finalSlotsExisting } });
        return `Perfeito! Seu agendamento já estava confirmado:

*Serviço:* ${serviceName}
*Data:* ${date}
*Horário:* ${time}
*ID:* ${existing.id}

Se precisar alterar, me avise.`;
      }
      const acquired = await acquireIdempotencyKey(idemKey, 60 * 30);
      if (!acquired) {
        const retry = await getIdempotencyResult<any>(idemKey);
        if (retry?.id) {
          const finalSlotsRetry = { ...extracted.slots, nomeServico: serviceName, data: date, hora: time, lastAgendamentoId: retry.id, awaiting: undefined };
          await setConversationState('default', number || 'unknown', { slots: finalSlotsRetry });
          await updateClientSession('default', clientPhone, { sessionData: { ...sessionData, slots: finalSlotsRetry } });
          return `Perfeito! Seu agendamento já estava confirmado:

*Serviço:* ${serviceName}
*Data:* ${date}
*Horário:* ${time}
*ID:* ${retry.id}`;
        }
      }

      const created = await trinks.Trinks.criarAgendamento({
        servicoId: info.id,
        clienteId: Number(client?.id || client?.clienteId || client?.codigo || 0),
        dataHoraInicio: iso,
        duracaoEmMinutos: info.duracaoEmMinutos,
        valor: info.valor || 0,
        confirmado: true,
      });

      // Persistir resultado idempotente (se houver ID)
      if (created?.id) {
        await setIdempotencyResult(idemKey, created, 60 * 30);
        // Incrementar métrica de agendamentos confirmados
        incrementBookingsConfirmed('default', serviceName);
        
        // Agendar notificações de pré-visita automaticamente
        try {
          const preVisitEngine = new PreVisitNotificationEngine('default');
          const appointmentDate = new Date(iso);
          const clientName = client?.nome || contactInfo?.firstName || 'Cliente';
          
          await preVisitEngine.schedulePreVisitNotifications(
            clientPhone,
            clientName,
            serviceName,
            appointmentDate,
            time,
            undefined
          );
          
          // logger.info(`Notificações de pré-visita agendadas para agendamento ${created.id}`);
      } catch (notificationError) {
        // logger.error('Erro ao agendar notificações de pré-visita:', notificationError);
          // Não falhar o agendamento por erro nas notificações
        }
      }
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
      // Persistir slots após criação de agendamento bem-sucedida
      await updateClientSession('default', clientPhone, { sessionData: { ...sessionData, slots: finalSlots } });
      
      // Gerar resumo pós-agendamento com CTAs
      const bookingData = {
        id: created.id,
        bookingId: created.id,
        serviceName,
        professionalName: undefined,
        date,
        time,
        estimatedValue: info.valor || 0,
        clientName: client?.nome || contactInfo?.firstName || 'Cliente',
        clientPhone
      };
      
      const establishmentConfig = {
        name: 'Ateliê Marcleia Abade',
        address: 'Rua das Flores, 123 - Salvador/BA',
        phone: '(71) 99999-9999',
        lateFeePolicy: 'Tolerância de 15 minutos de atraso',
        noShowPolicy: 'Cancelamento com menos de 2h de antecedência pode gerar taxa',
        arrivalInstructions: 'Chegue 5 minutos antes do horário agendado'
      };
      
      const summary = generateBookingSummary(bookingData, establishmentConfig);
       const ctas = generateComplementaryCTAs();
       
       // Registrar interação pós-agendamento
        await recordPostBookingInteraction({
          tenantId: 'default',
          phone: clientPhone,
          bookingId: created.id,
          interactionType: 'booking_confirmed',
          timestamp: new Date(),
          metadata: { serviceName, date, time }
        });
        
        // Registrar preferências do usuário para recomendações futuras
        // Nota: Sistema de recomendação será implementado quando disponível
       
       return `${summary}\n\n${ctas}`;
    } catch (e: any) {
      // logger.error('Erro no fluxo de agendamento:', e);
      // Incrementar métrica de erros da API Trinks
      const errorCode = e?.response?.status?.toString() || 'unknown';
      incrementTrinksErrors(errorCode, 'agendamento');
      return 'Ops! Houve um erro ao processar seu agendamento. Pode tentar novamente? Ou me diga mais detalhes.';
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
- Nunca confirme agendamentos por conta própria. A confirmação só ocorre quando o sistema retorna um ID de agendamento pela integração. Se não houver ID, informe que irá verificar disponibilidade e peça outro horário/profissional.
- Não invente horários, IDs ou disponibilidade. Se não souber, diga que vai verificar e ofereça ajuda humana.

Exemplos de Agendamento com Trinks:
- User: Quero agendar manicure para amanhã às 10h. -> Assistant: Verificando disponibilidade... Ops, horário indisponível. Qual outro horário?
- User: Confirma o agendamento? -> Assistant: Ainda não confirmei, pois preciso verificar na integração. Me confirme os detalhes.
- User: Agendado! -> Assistant: Só confirmo após ID da API. Vamos verificar agora.

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