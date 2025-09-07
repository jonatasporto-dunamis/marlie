import { RedisClientType } from 'redis';
import { logger } from '../utils/logger';

export interface BufferedMessage {
  phone: string;
  content: string;
  timestamp: number;
  messageId: string;
}

export interface BufferConfig {
  windowSeconds: number;
  mergePolicy: 'concat_with_space' | 'concat_with_newline';
}

export class MessageBuffer {
  private redis: RedisClientType;
  private config: BufferConfig;
  private readonly BUFFER_KEY_PREFIX = 'buffer:';
  private readonly LOCK_KEY_PREFIX = 'buffer_lock:';
  private readonly DEFAULT_TTL = 35; // 30s window + 5s grace period

  constructor(redis: RedisClientType, config: BufferConfig = {
    windowSeconds: 30,
    mergePolicy: 'concat_with_space'
  }) {
    this.redis = redis;
    this.config = config;
  }

  /**
   * Adiciona mensagem ao buffer e retorna mensagem consolidada se janela expirou
   */
  async addMessage(message: BufferedMessage): Promise<string | null> {
    const bufferKey = `${this.BUFFER_KEY_PREFIX}${message.phone}`;
    const lockKey = `${this.LOCK_KEY_PREFIX}${message.phone}`;
    
    try {
      // Acquire lock to prevent race conditions
      const lockAcquired = await this.redis.set(lockKey, '1', { EX: 5, NX: true });
      if (!lockAcquired) {
        logger.warn(`Failed to acquire lock for phone ${message.phone}`);
        return null;
      }

      // Get existing buffer
      const existingBuffer = await this.redis.get(bufferKey);
      const now = Date.now();
      
      let bufferedMessages: BufferedMessage[] = [];
      
      if (existingBuffer) {
        try {
          bufferedMessages = JSON.parse(existingBuffer as string);
          
          // Remove messages outside the window
          const windowStart = now - (this.config.windowSeconds * 1000);
          bufferedMessages = bufferedMessages.filter(
            msg => msg.timestamp >= windowStart
          );
        } catch (error) {
          logger.error('Failed to parse existing buffer:', error);
          bufferedMessages = [];
        }
      }

      // Add new message
      bufferedMessages.push(message);
      
      // Update buffer with TTL
      await this.redis.setEx(
        bufferKey, 
        this.DEFAULT_TTL, 
        JSON.stringify(bufferedMessages)
      );

      // Check if we should flush the buffer
      const shouldFlush = await this.shouldFlushBuffer(bufferedMessages, now);
      
      if (shouldFlush) {
        // Clear buffer and return consolidated message
        await this.redis.del(bufferKey);
        const consolidatedMessage = this.consolidateMessages(bufferedMessages);
        
        logger.info(`Buffer flushed for phone ${message.phone}, consolidated ${bufferedMessages.length} messages`);
        
        return consolidatedMessage;
      }

      return null;
    } catch (error) {
      logger.error('Error in message buffer:', error);
      return message.content; // Fallback to original message
    } finally {
      // Release lock
      await this.redis.del(lockKey);
    }
  }

  /**
   * Força o flush do buffer para um telefone específico
   */
  async flushBuffer(phone: string): Promise<string | null> {
    const bufferKey = `${this.BUFFER_KEY_PREFIX}${phone}`;
    
    try {
      const existingBuffer = await this.redis.get(bufferKey);
      
      if (!existingBuffer) {
        return null;
      }

      const bufferedMessages: BufferedMessage[] = JSON.parse(existingBuffer as string);
      await this.redis.del(bufferKey);
      
      return this.consolidateMessages(bufferedMessages);
    } catch (error) {
      logger.error('Error flushing buffer:', error);
      return null;
    }
  }

  /**
   * Verifica se o buffer deve ser liberado
   */
  private async shouldFlushBuffer(messages: BufferedMessage[], now: number): Promise<boolean> {
    if (messages.length === 0) {
      return false;
    }

    // Flush if oldest message is outside the window
    const oldestMessage = messages[0];
    const windowStart = now - (this.config.windowSeconds * 1000);
    
    return oldestMessage.timestamp < windowStart;
  }

  /**
   * Consolida múltiplas mensagens em uma única string
   */
  private consolidateMessages(messages: BufferedMessage[]): string {
    if (messages.length === 0) {
      return '';
    }

    if (messages.length === 1) {
      return messages[0].content;
    }

    // Sort by timestamp to maintain order
    const sortedMessages = messages.sort((a, b) => a.timestamp - b.timestamp);
    
    const separator = this.config.mergePolicy === 'concat_with_newline' ? '\n' : ' ';
    
    return sortedMessages
      .map(msg => msg.content.trim())
      .filter(content => content.length > 0)
      .join(separator)
      .trim();
  }

  /**
   * Limpa buffers expirados (para limpeza periódica)
   */
  async cleanupExpiredBuffers(): Promise<number> {
    try {
      const pattern = `${this.BUFFER_KEY_PREFIX}*`;
      const keys = await this.redis.keys(pattern);
      
      let cleanedCount = 0;
      const now = Date.now();
      const windowStart = now - (this.config.windowSeconds * 1000);
      
      for (const key of keys) {
        const buffer = await this.redis.get(key);
        if (!buffer) continue;
        
        try {
          const messages: BufferedMessage[] = JSON.parse(buffer as string);
          const validMessages = messages.filter(msg => msg.timestamp >= windowStart);
          
          if (validMessages.length === 0) {
            await this.redis.del(key);
            cleanedCount++;
          } else if (validMessages.length < messages.length) {
            // Update buffer with only valid messages
            await this.redis.setEx(key, this.DEFAULT_TTL, JSON.stringify(validMessages));
          }
        } catch (error) {
          // Invalid buffer, delete it
          await this.redis.del(key);
          cleanedCount++;
        }
      }
      
      if (cleanedCount > 0) {
        logger.info(`Cleaned up ${cleanedCount} expired message buffers`);
      }
      
      return cleanedCount;
    } catch (error) {
      logger.error('Error cleaning up expired buffers:', error);
      return 0;
    }
  }

  /**
   * Obtém estatísticas do buffer
   */
  async getBufferStats(phone: string): Promise<{
    messageCount: number;
    oldestTimestamp: number | null;
    newestTimestamp: number | null;
  }> {
    const bufferKey = `${this.BUFFER_KEY_PREFIX}${phone}`;
    
    try {
      const buffer = await this.redis.get(bufferKey);
      
      if (!buffer) {
        return {
          messageCount: 0,
          oldestTimestamp: null,
          newestTimestamp: null
        };
      }

      const messages: BufferedMessage[] = JSON.parse(buffer as string);
      
      if (messages.length === 0) {
        return {
          messageCount: 0,
          oldestTimestamp: null,
          newestTimestamp: null
        };
      }

      const timestamps = messages.map(msg => msg.timestamp);
      
      return {
        messageCount: messages.length,
        oldestTimestamp: Math.min(...timestamps),
        newestTimestamp: Math.max(...timestamps)
      };
    } catch (error) {
      logger.error('Error getting buffer stats:', error);
      return {
        messageCount: 0,
        oldestTimestamp: null,
        newestTimestamp: null
      };
    }
  }
}

// Singleton instance
let messageBufferInstance: MessageBuffer | null = null;

export function getMessageBuffer(redis: RedisClientType, config?: BufferConfig): MessageBuffer {
  if (!messageBufferInstance) {
    messageBufferInstance = new MessageBuffer(redis, config);
  }
  return messageBufferInstance;
}

export function resetMessageBuffer(): void {
  messageBufferInstance = null;
}