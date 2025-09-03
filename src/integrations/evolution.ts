import axios from 'axios';
import { logger } from '../logger';

/**
 * Interface for Evolution API message payload
 */
export interface EvolutionMessage {
  number: string;
  text: string;
  delay?: number;
}

/**
 * Evolution API client for sending WhatsApp messages
 */
export class EvolutionAPI {
  private baseUrl: string;
  private apiKey: string;
  private instance: string;

  constructor(
    baseUrl?: string,
    apiKey?: string,
    instance?: string
  ) {
    this.baseUrl = baseUrl || process.env.EVOLUTION_BASE_URL || '';
    this.apiKey = apiKey || process.env.EVOLUTION_API_KEY || '';
    this.instance = instance || process.env.EVOLUTION_INSTANCE || '';
  }

  /**
   * Send a text message via Evolution API
   */
  async sendMessage(message: EvolutionMessage): Promise<boolean> {
    if (!this.baseUrl || !this.apiKey || !this.instance) {
      logger.warn('Evolution API not configured. Skipping message send.', {
        hasBaseUrl: Boolean(this.baseUrl),
        hasApiKey: Boolean(this.apiKey),
        hasInstance: Boolean(this.instance),
      });
      return false;
    }

    try {
      const url = `${this.baseUrl.replace(/\/$/, '')}/message/sendText/${this.instance}`;
      
      const payload = {
        number: message.number,
        text: message.text,
        delay: message.delay || 1200
      };

      const response = await axios.post(url, payload, {
        headers: {
          'apikey': this.apiKey,
          'Content-Type': 'application/json; charset=utf-8'
        },
        timeout: 10000 // 10 second timeout
      });

      logger.info('Message sent via Evolution API', {
        number: this.maskPhone(message.number),
        status: response.status,
        responseStatus: response.data?.status
      });

      return true;
    } catch (error: any) {
      logger.error('Failed to send message via Evolution API', {
        error: error.message,
        number: this.maskPhone(message.number),
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data
      });
      return false;
    }
  }

  /**
   * Send multiple messages with delay between them
   */
  async sendMessages(messages: EvolutionMessage[]): Promise<boolean[]> {
    const results: boolean[] = [];
    
    for (const message of messages) {
      const result = await this.sendMessage(message);
      results.push(result);
      
      // Add delay between messages to avoid rate limiting
      if (messages.indexOf(message) < messages.length - 1) {
        await this.delay(2000); // 2 second delay between messages
      }
    }
    
    return results;
  }

  /**
   * Check if Evolution API is configured and available
   */
  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.apiKey && this.instance);
  }

  /**
   * Get Evolution API configuration status
   */
  getConfigStatus() {
    return {
      hasBaseUrl: Boolean(this.baseUrl),
      hasApiKey: Boolean(this.apiKey),
      hasInstance: Boolean(this.instance),
      isConfigured: this.isConfigured()
    };
  }

  /**
   * Mask phone number for privacy in logs
   */
  private maskPhone(phoneE164: string): string {
    if (phoneE164.length <= 6) return phoneE164;
    
    const start = phoneE164.slice(0, 3);
    const end = phoneE164.slice(-3);
    const middle = '*'.repeat(phoneE164.length - 6);
    
    return `${start}${middle}${end}`;
  }

  /**
   * Simple delay utility
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const evolutionAPI = new EvolutionAPI();