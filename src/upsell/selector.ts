import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { maskPhone } from '../utils/privacy';

export interface UpsellCandidate {
  serviceId: number;
  serviceName: string;
  priceCents: number;
  estimatedDurationMinutes: number;
  description: string;
  compatibility: string[];
}

export interface UpsellSuggestion {
  suggestedServiceId: number;
  suggestedServiceName: string;
  suggestedPriceCents: number;
  baseServiceId: number;
  reason: string;
  source: string;
}

export interface UpsellContext {
  tenantId: string;
  phoneE164: string;
  bookingId?: string;
  baseServiceId: number;
  baseServiceName: string;
  appointmentDateTime: Date;
  conversationId?: string;
}

export class UpsellSelector {
  private db: Pool;
  private enabled: boolean;
  private cooldownDays: number;
  private maxSuggestionsPerConversation: number;

  constructor(db: Pool) {
    this.db = db;
    this.enabled = process.env.UPSELL_ENABLED === 'on';
    this.cooldownDays = parseInt(process.env.UPSELL_COOLDOWN_DAYS || '30');
    this.maxSuggestionsPerConversation = parseInt(process.env.UPSELL_MAX_PER_CONVERSATION || '1');
  }

  /**
   * Selects an appropriate upsell suggestion based on context and business rules
   */
  async selectUpsell(context: UpsellContext): Promise<UpsellSuggestion | null> {
    if (!this.enabled) {
      logger.debug('Upsell disabled via UPSELL_ENABLED flag');
      return null;
    }

    try {
      // Check if user is eligible for upsell
      const isEligible = await this.isUserEligible(context);
      if (!isEligible) {
        logger.debug(`User ${maskPhone(context.phoneE164)} not eligible for upsell`);
        return null;
      }

      // Get compatible services for upsell
      const candidates = await this.getUpsellCandidates(context.baseServiceId);
      if (candidates.length === 0) {
        logger.debug(`No upsell candidates found for service ${context.baseServiceId}`);
        return null;
      }

      // Select best candidate based on business logic
      const selectedCandidate = await this.selectBestCandidate(candidates, context);
      if (!selectedCandidate) {
        logger.debug('No suitable upsell candidate selected');
        return null;
      }

      // Create suggestion
      const suggestion: UpsellSuggestion = {
        suggestedServiceId: selectedCandidate.serviceId,
        suggestedServiceName: selectedCandidate.serviceName,
        suggestedPriceCents: selectedCandidate.priceCents,
        baseServiceId: context.baseServiceId,
        reason: this.generateReason(selectedCandidate, context),
        source: 'contextual'
      };

      logger.info(`Upsell suggestion generated for ${maskPhone(context.phoneE164)}: ${selectedCandidate.serviceName}`);
      return suggestion;

    } catch (error) {
      logger.error('Error selecting upsell:', error);
      return null;
    }
  }

  /**
   * Checks if user is eligible for upsell based on business rules
   */
  private async isUserEligible(context: UpsellContext): Promise<boolean> {
    const client = await this.db.connect();
    try {
      // Check conversation limit (max 1 per conversation)
      if (context.conversationId) {
        const conversationCheck = await client.query(
          `SELECT COUNT(*) as count FROM upsell_events 
           WHERE tenant_id = $1 AND phone_e164 = $2 
           AND booking_id = $3 AND shown_at >= NOW() - INTERVAL '24 hours'`,
          [context.tenantId, context.phoneE164, context.bookingId]
        );
        
        if (parseInt(conversationCheck.rows[0].count) >= this.maxSuggestionsPerConversation) {
          logger.debug(`Max upsells per conversation reached for ${maskPhone(context.phoneE164)}`);
          return false;
        }
      }

      // Check cooldown period (avoid recent rejections)
      const cooldownCheck = await client.query(
        `SELECT COUNT(*) as count FROM upsell_events 
         WHERE tenant_id = $1 AND phone_e164 = $2 
         AND declined_at IS NOT NULL 
         AND declined_at >= NOW() - INTERVAL '${this.cooldownDays} days'`,
        [context.tenantId, context.phoneE164]
      );
      
      if (parseInt(cooldownCheck.rows[0].count) > 0) {
        logger.debug(`User ${maskPhone(context.phoneE164)} in cooldown period`);
        return false;
      }

      // Check for recent successful upsells (avoid overselling)
      const recentSuccessCheck = await client.query(
        `SELECT COUNT(*) as count FROM upsell_events 
         WHERE tenant_id = $1 AND phone_e164 = $2 
         AND accepted_at IS NOT NULL 
         AND accepted_at >= NOW() - INTERVAL '7 days'`,
        [context.tenantId, context.phoneE164]
      );
      
      if (parseInt(recentSuccessCheck.rows[0].count) > 0) {
        logger.debug(`User ${maskPhone(context.phoneE164)} has recent successful upsell`);
        return false;
      }

      return true;

    } finally {
      client.release();
    }
  }

  /**
   * Gets compatible services that can be upsold with the base service
   */
  private async getUpsellCandidates(baseServiceId: number): Promise<UpsellCandidate[]> {
    // This would typically query your services database
    // For now, returning mock data based on common service combinations
    const mockCandidates: UpsellCandidate[] = [
      {
        serviceId: 101,
        serviceName: 'Hidratação Capilar',
        priceCents: 3500, // R$ 35,00
        estimatedDurationMinutes: 30,
        description: 'Tratamento hidratante para cabelos ressecados',
        compatibility: ['corte', 'escova', 'coloracao']
      },
      {
        serviceId: 102,
        serviceName: 'Manicure',
        priceCents: 2500, // R$ 25,00
        estimatedDurationMinutes: 45,
        description: 'Cuidado completo das unhas das mãos',
        compatibility: ['corte', 'escova', 'sobrancelha']
      },
      {
        serviceId: 103,
        serviceName: 'Design de Sobrancelhas',
        priceCents: 3000, // R$ 30,00
        estimatedDurationMinutes: 30,
        description: 'Modelagem e design personalizado das sobrancelhas',
        compatibility: ['corte', 'escova', 'coloracao', 'manicure']
      },
      {
        serviceId: 104,
        serviceName: 'Massagem Relaxante',
        priceCents: 5000, // R$ 50,00
        estimatedDurationMinutes: 60,
        description: 'Massagem terapêutica para relaxamento',
        compatibility: ['corte', 'escova', 'hidratacao']
      }
    ];

    // Filter candidates based on base service compatibility
    // This is a simplified version - in production, you'd query your actual services database
    return mockCandidates.filter(candidate => {
      // Simple compatibility check - in production, this would be more sophisticated
      return candidate.serviceId !== baseServiceId;
    });
  }

  /**
   * Selects the best candidate based on business logic
   */
  private async selectBestCandidate(
    candidates: UpsellCandidate[], 
    context: UpsellContext
  ): Promise<UpsellCandidate | null> {
    if (candidates.length === 0) return null;

    // Business logic for selection:
    // 1. Prefer services with reasonable price point (not too expensive)
    // 2. Consider time compatibility with appointment
    // 3. Prefer popular combinations

    const maxPriceCents = 6000; // R$ 60,00 max for upsell
    const eligibleCandidates = candidates.filter(c => c.priceCents <= maxPriceCents);
    
    if (eligibleCandidates.length === 0) return null;

    // Sort by price (ascending) and duration (ascending) for better acceptance rate
    eligibleCandidates.sort((a, b) => {
      const priceWeight = a.priceCents - b.priceCents;
      const durationWeight = (a.estimatedDurationMinutes - b.estimatedDurationMinutes) * 10;
      return priceWeight + durationWeight;
    });

    return eligibleCandidates[0];
  }

  /**
   * Generates a contextual reason for the upsell suggestion
   */
  private generateReason(candidate: UpsellCandidate, context: UpsellContext): string {
    const reasons = [
      `Combina perfeitamente com ${context.baseServiceName}`,
      `Aproveite para completar seu cuidado`,
      `Oferta especial para hoje`,
      `Muito procurado junto com ${context.baseServiceName}`
    ];

    // Simple selection based on service type
    if (candidate.serviceName.toLowerCase().includes('hidrata')) {
      return `Ideal para manter seu cabelo saudável após ${context.baseServiceName}`;
    }
    if (candidate.serviceName.toLowerCase().includes('manicure')) {
      return `Complete seu visual com cuidado das unhas`;
    }
    if (candidate.serviceName.toLowerCase().includes('sobrancelha')) {
      return `Finalize seu look com design de sobrancelhas`;
    }

    return reasons[Math.floor(Math.random() * reasons.length)];
  }

  /**
   * Records that an upsell was shown to the user
   */
  async recordUpsellShown(
    context: UpsellContext, 
    suggestion: UpsellSuggestion
  ): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query(
        `INSERT INTO upsell_events (
          tenant_id, phone_e164, booking_id, base_service_id, 
          suggested_service_id, suggested_price_cents, source
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (tenant_id, phone_e164, booking_id, suggested_service_id) 
        DO UPDATE SET shown_at = now()`,
        [
          context.tenantId,
          context.phoneE164,
          context.bookingId,
          suggestion.baseServiceId,
          suggestion.suggestedServiceId,
          suggestion.suggestedPriceCents,
          suggestion.source
        ]
      );

      logger.info(`Upsell shown recorded for ${maskPhone(context.phoneE164)}`);
    } catch (error) {
      logger.error('Error recording upsell shown:', error);
    } finally {
      client.release();
    }
  }

  /**
   * Records user's response to upsell (acceptance or decline)
   */
  async recordUpsellResponse(
    context: UpsellContext,
    suggestion: UpsellSuggestion,
    accepted: boolean
  ): Promise<void> {
    const client = await this.db.connect();
    try {
      const updateField = accepted ? 'accepted_at' : 'declined_at';
      
      await client.query(
        `UPDATE upsell_events 
         SET ${updateField} = now() 
         WHERE tenant_id = $1 AND phone_e164 = $2 
         AND suggested_service_id = $3 
         AND booking_id = $4`,
        [
          context.tenantId,
          context.phoneE164,
          suggestion.suggestedServiceId,
          context.bookingId
        ]
      );

      logger.info(
        `Upsell ${accepted ? 'accepted' : 'declined'} recorded for ${maskPhone(context.phoneE164)}`
      );
    } catch (error) {
      logger.error('Error recording upsell response:', error);
    } finally {
      client.release();
    }
  }

  /**
   * Gets upsell statistics for analytics
   */
  async getUpsellStats(tenantId: string, days: number = 30): Promise<any> {
    const client = await this.db.connect();
    try {
      const stats = await client.query(
        `SELECT 
          COUNT(*) as total_shown,
          COUNT(accepted_at) as total_accepted,
          COUNT(declined_at) as total_declined,
          ROUND(COUNT(accepted_at)::numeric / NULLIF(COUNT(*), 0) * 100, 2) as conversion_rate,
          AVG(suggested_price_cents) as avg_suggested_price_cents
         FROM upsell_events 
         WHERE tenant_id = $1 
         AND shown_at >= NOW() - INTERVAL '${days} days'`,
        [tenantId]
      );

      return stats.rows[0];
    } finally {
      client.release();
    }
  }
}

// Export singleton instance
export const upsellSelector = new UpsellSelector(require('../db').pool);