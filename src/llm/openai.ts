import axios from 'axios';
import { z } from 'zod';

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().min(1).optional(),
});
const env = EnvSchema.parse(process.env);

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export async function chatCompletion(messages: ChatMessage[], model?: string) {
  if (!env.OPENAI_API_KEY || !(model || env.OPENAI_MODEL)) {
    throw new Error('OpenAI não configurado corretamente (OPENAI_API_KEY e OPENAI_MODEL)');
  }

  const apiKey = env.OPENAI_API_KEY!;
  const usedModel = model || env.OPENAI_MODEL!;

  const resp = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    { model: usedModel, messages },
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );

  const text = resp.data?.choices?.[0]?.message?.content || '';
  return text;
}

// Alias for backward compatibility
export const callLLM = chatCompletion;