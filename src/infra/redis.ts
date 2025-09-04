// src/infra/redis.ts
import { createClient, RedisClientType } from 'redis';

let client: RedisClientType | null = null;

export async function getRedis(): Promise<RedisClientType> {
  if (client && client.isOpen) return client;

  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL not set');

  client = createClient({
    url,
    socket: {
      connectTimeout: 10_000, // 10s
      keepAlive: true,
      reconnectStrategy: (retries) => Math.min(1000 * 2 ** retries, 10_000),
    },
  });

  client.on('error', (err) => {
    console.error('redis_error', { msg: err?.message });
  });

  await client.connect();
  return client;
}

export async function pingRedis(): Promise<boolean> {
  const c = await getRedis();
  const r = await c.ping();
  return r === 'PONG';
}

// encerramento limpo ao finalizar o processo
process.on('beforeExit', () => {
  client?.quit().catch(() => {});
});