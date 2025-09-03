import { Pool, Client } from 'pg';
import logger from '../utils/logger';
import { MetricsHelper } from '../metrics';
import { EvolutionAPI } from '../integrations/evolution';

/**
 * Types of opt-out available
 */
export type OptOutType = 'all' | 'pre_visit' | 'no_show_check';

/**
 * Interface for opt-out record
 */
export interface UserOptOut {
  tenantId: string;
  phoneE164: string;
  optOutType: OptOutType;
  optedOutAt: Date;
}

/**
 * Service to handle user opt-outs from automated messages
 */
export class OptOutService {
  constructor(
    private db: Pool | Client,
    private evolutionAPI: EvolutionAPI
  ) {}

  /**
   * Process opt-out request from user message
   * Handles messages like 'PARAR', 'STOP', 'SAIR', etc.
   */
  async processOptOutMessage(
    tenantId: string,
    phoneE164: string,
    message: string
  ): Promise<boolean> {
    const normalizedMessage = this.normalizeMessage(message);
    
    if (!this.isOptOutMessage(normalizedMessage)) {
      return false;
    }

    try {
      // Register opt-out in database
      await this.registerOptOut(tenantId, phoneE164, 'all');
      
      // Send confirmation message
      await this.sendOptOutConfirmation(tenantId, phoneE164);
      
      // Record metrics
      MetricsHelper.incrementUserOptOut(tenantId, 'all');
      
      logger.info('User opted out from automated messages', {
        phone: this.maskPhone(phoneE164),
        tenantId
      });
      
      return true;
    } catch (error) {
      logger.error('Failed to process opt-out request', {
        error,
        phone: this.maskPhone(phoneE164),
        tenantId
      });
      return false;
    }
  }

  /**
   * Register user opt-out in database
   */
  async registerOptOut(
    tenantId: string,
    phoneE164: string,
    optOutType: OptOutType = 'all'
  ): Promise<void> {
    const query = `
      INSERT INTO user_opt_outs (tenant_id, phone_e164, opt_out_type, opted_out_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (tenant_id, phone_e164, opt_out_type) 
      DO UPDATE SET opted_out_at = NOW()
    `;
    
    await this.db.query(query, [tenantId, phoneE164, optOutType]);
  }

  /**
   * Check if user has opted out from specific message type
   */
  async isUserOptedOut(
    tenantId: string,
    phoneE164: string,
    messageType: OptOutType = 'all'
  ): Promise<boolean> {
    const query = `
      SELECT 1 FROM user_opt_outs 
      WHERE tenant_id = $1 
        AND phone_e164 = $2 
        AND (opt_out_type = 'all' OR opt_out_type = $3)
      LIMIT 1
    `;
    
    const result = await this.db.query(query, [tenantId, phoneE164, messageType]);
    return result.rows.length > 0;
  }

  /**
   * Remove user opt-out (allow them to receive messages again)
   */
  async removeOptOut(
    tenantId: string,
    phoneE164: string,
    optOutType: OptOutType = 'all'
  ): Promise<void> {
    const query = `
      DELETE FROM user_opt_outs 
      WHERE tenant_id = $1 
        AND phone_e164 = $2 
        AND opt_out_type = $3
    `;
    
    await this.db.query(query, [tenantId, phoneE164, optOutType]);
    
    logger.info('User opt-out removed', {
      phone: this.maskPhone(phoneE164),
      tenantId,
      optOutType
    });
  }

  /**
   * Get all opt-outs for a user
   */
  async getUserOptOuts(
    tenantId: string,
    phoneE164: string
  ): Promise<UserOptOut[]> {
    const query = `
      SELECT tenant_id, phone_e164, opt_out_type, opted_out_at
      FROM user_opt_outs 
      WHERE tenant_id = $1 AND phone_e164 = $2
      ORDER BY opted_out_at DESC
    `;
    
    const result = await this.db.query(query, [tenantId, phoneE164]);
    
    return result.rows.map(row => ({
      tenantId: row.tenant_id,
      phoneE164: row.phone_e164,
      optOutType: row.opt_out_type,
      optedOutAt: row.opted_out_at
    }));
  }

  /**
   * Send opt-out confirmation message
   */
  private async sendOptOutConfirmation(
    tenantId: string,
    phoneE164: string
  ): Promise<void> {
    const message = this.formatOptOutConfirmation();
    
    await this.evolutionAPI.sendMessage({
      number: phoneE164,
      text: message
    });
  }

  /**
   * Format opt-out confirmation message
   */
  private formatOptOutConfirmation(): string {
    return `✅ *Confirmado!*

Você não receberá mais mensagens automáticas de lembrete e confirmação.

Se precisar reagendar ou tiver dúvidas, entre em contato conosco diretamente.

_Para voltar a receber as mensagens, responda "VOLTAR"._`;
  }

  /**
   * Normalize message for comparison
   */
  private normalizeMessage(message: string): string {
    return message
      .toLowerCase()
      .trim()
      .replace(/[^a-záàâãéêíóôõúç]/g, '');
  }

  /**
   * Check if message is an opt-out request
   */
  private isOptOutMessage(normalizedMessage: string): boolean {
    const optOutKeywords = [
      'parar',
      'stop',
      'sair',
      'cancelar',
      'nao',
      'naoqueromais',
      'pare',
      'remover'
    ];
    
    return optOutKeywords.some(keyword => 
      normalizedMessage.includes(keyword)
    );
  }

  /**
   * Check if message is an opt-in request (to re-enable messages)
   */
  isOptInMessage(message: string): boolean {
    const normalizedMessage = this.normalizeMessage(message);
    const optInKeywords = [
      'voltar',
      'voltarreceber',
      'ativar',
      'sim',
      'quero',
      'reativar'
    ];
    
    return optInKeywords.some(keyword => 
      normalizedMessage.includes(keyword)
    );
  }

  /**
   * Process opt-in request (re-enable messages)
   */
  async processOptInMessage(
    tenantId: string,
    phoneE164: string,
    message: string
  ): Promise<boolean> {
    if (!this.isOptInMessage(message)) {
      return false;
    }

    try {
      // Check if user was opted out
      const wasOptedOut = await this.isUserOptedOut(tenantId, phoneE164);
      
      if (!wasOptedOut) {
        return false; // User wasn't opted out
      }

      // Remove opt-out
      await this.removeOptOut(tenantId, phoneE164, 'all');
      
      // Send confirmation
      await this.sendOptInConfirmation(tenantId, phoneE164);
      
      logger.info('User opted back in for automated messages', {
        phone: this.maskPhone(phoneE164),
        tenantId
      });
      
      return true;
    } catch (error) {
      logger.error('Failed to process opt-in request', {
        error,
        phone: this.maskPhone(phoneE164),
        tenantId
      });
      return false;
    }
  }

  /**
   * Send opt-in confirmation message
   */
  private async sendOptInConfirmation(
    tenantId: string,
    phoneE164: string
  ): Promise<void> {
    const message = `✅ *Perfeito!*

Você voltará a receber nossas mensagens automáticas de lembrete e confirmação.

Isso nos ajuda a oferecer um melhor atendimento! 😊`;
    
    await this.evolutionAPI.sendMessage({
      number: phoneE164,
      text: message
    });
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
   * Static method to check if a message is opt-out related
   */
  static isOptOutRelatedMessage(message: string): boolean {
    const service = new OptOutService(null as any, null as any);
    const normalized = service.normalizeMessage(message);
    
    return service.isOptOutMessage(normalized) || service.isOptInMessage(message);
  }
}

// Export singleton instance
export const optOutService = new OptOutService(
  // These will be injected when the service is used
  null as any,
  null as any
);