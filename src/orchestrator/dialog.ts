import { chatCompletion, ChatMessage } from '../llm/openai';

export async function replyForMessage(text: string): Promise<string> {
  const system: ChatMessage = {
    role: 'system',
    content:
      'Você é Marliê, assistente virtual do Ateliê Marcleia Abade. Responda de forma simpática e objetiva. Se a pergunta for sobre horários ou agendamento, peça serviço desejado, data e preferências. Se for cadastro, solicite nome completo e telefone/e-mail. Se não souber, peça para reformular e ofereça falar com um atendente humano.',
  };

  const user: ChatMessage = { role: 'user', content: text };

  const answer = await chatCompletion([system, user]);
  return answer;
}