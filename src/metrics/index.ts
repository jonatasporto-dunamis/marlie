import { register, Counter, Histogram, collectDefaultMetrics } from 'prom-client';
import logger from '../utils/logger';

// Enable default metrics collection (CPU, memory, etc.)
collectDefaultMetrics({ register });

// Business metrics counters
export const conversationsStartedTotal = new Counter({
  name: 'conversations_started_total',
  help: 'Total number of conversations started',
  labelNames: ['tenant_id', 'channel'] as const,
});

export const serviceSuggestionsShownTotal = new Counter({
  name: 'service_suggestions_shown_total',
  help: 'Total number of service suggestions shown to users',
  labelNames: ['tenant_id', 'suggestion_count'] as const,
});

export const bookingsConfirmedTotal = new Counter({
  name: 'bookings_confirmed_total',
  help: 'Total number of bookings confirmed',
  labelNames: ['tenant_id', 'service_id', 'professional_id'] as const,
});

export const apiTrinksErrorsTotal = new Counter({
  name: 'api_trinks_errors_total',
  help: 'Total number of Trinks API errors',
  labelNames: ['code', 'endpoint', 'method'] as const,
});

export const firstTryBookingTotal = new Counter({
  name: 'first_try_booking_total',
  help: 'Total number of successful bookings on first try (no retries)',
  labelNames: ['tenant_id', 'service_id'] as const,
});

// A/B Test metrics for proactive suggestions
export const proactiveSuggestionsShownTotal = new Counter({
  name: 'proactive_suggestions_shown_total',
  help: 'Total number of proactive suggestions shown (A/B test)',
  labelNames: ['tenant_id', 'ab_variant', 'suggestion_type'] as const,
});

export const proactiveSuggestionsClickedTotal = new Counter({
  name: 'proactive_suggestions_clicked_total',
  help: 'Total number of proactive suggestions clicked (A/B test)',
  labelNames: ['tenant_id', 'ab_variant', 'suggestion_type'] as const,
});

export const conversationStepsTotal = new Counter({
  name: 'conversation_steps_total',
  help: 'Total number of conversation steps until booking',
  labelNames: ['tenant_id', 'ab_variant', 'outcome'] as const,
});

export const abTestConversionsTotal = new Counter({
  name: 'ab_test_conversions_total',
  help: 'Total conversions by A/B test variant',
  labelNames: ['tenant_id', 'ab_variant', 'conversion_type'] as const,
});

// Upsell metrics for revenue optimization
export const upsellShownTotal = new Counter({
  name: 'upsell_shown_total',
  help: 'Total number of upsell offers shown to users',
  labelNames: ['tenant_id', 'base_service_id', 'suggested_service_id'] as const,
});

export const upsellAcceptedTotal = new Counter({
  name: 'upsell_accepted_total',
  help: 'Total number of upsell offers accepted by users',
  labelNames: ['tenant_id', 'base_service_id', 'suggested_service_id'] as const,
});

export const upsellDeclinedTotal = new Counter({
  name: 'upsell_declined_total',
  help: 'Total number of upsell offers declined by users',
  labelNames: ['tenant_id', 'base_service_id', 'suggested_service_id'] as const,
});

export const ticketValueHistogram = new Histogram({
  name: 'ticket_value_cents',
  help: 'Distribution of ticket values in cents',
  labelNames: ['tenant_id', 'has_upsell'] as const,
  buckets: [1000, 2500, 5000, 7500, 10000, 15000, 20000, 30000, 50000, 100000], // R$ 10 to R$ 1000
});

export const upsellConversionRate = new Histogram({
  name: 'upsell_conversion_rate',
  help: 'Upsell conversion rate by service combination',
  labelNames: ['tenant_id', 'base_service_id'] as const,
  buckets: [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1.0],
});

// Pre-visit and No-show metrics
export const preVisitSentTotal = new Counter({
  name: 'pre_visit_sent_total',
  help: 'Total number of pre-visit reminder messages sent',
  labelNames: ['tenant_id'] as const,
});

export const noShowCheckSentTotal = new Counter({
  name: 'no_show_check_sent_total',
  help: 'Total number of no-show check messages sent',
  labelNames: ['tenant_id'] as const,
});

export const noShowPreventedTotal = new Counter({
  name: 'no_show_prevented_total',
  help: 'Total number of no-shows prevented through confirmation',
  labelNames: ['tenant_id'] as const,
});

export const rescheduleRequestedTotal = new Counter({
  name: 'reschedule_requested_total',
  help: 'Total number of reschedule requests from no-show checks',
  labelNames: ['tenant_id'] as const,
});

export const userOptOutTotal = new Counter({
  name: 'user_opt_out_total',
  help: 'Total number of users who opted out of automated messages',
  labelNames: ['tenant_id', 'opt_out_type'] as const,
});

// Performance metrics
export const serviceSuggestionDuration = new Histogram({
  name: 'service_suggestion_duration_seconds',
  help: 'Duration of service suggestion queries',
  labelNames: ['tenant_id', 'cache_hit'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const trinksApiDuration = new Histogram({
  name: 'trinks_api_duration_seconds',
  help: 'Duration of Trinks API calls',
  labelNames: ['endpoint', 'method', 'status_code'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
});

// Cache metrics
export const cacheHitsTotal = new Counter({
  name: 'cache_hits_total',
  help: 'Total number of cache hits',
  labelNames: ['cache_type', 'key_pattern'] as const,
});

export const cacheMissesTotal = new Counter({
  name: 'cache_misses_total',
  help: 'Total number of cache misses',
  labelNames: ['cache_type', 'key_pattern'] as const,
});

// Register all metrics
register.registerMetric(conversationsStartedTotal);
register.registerMetric(serviceSuggestionsShownTotal);
register.registerMetric(bookingsConfirmedTotal);
register.registerMetric(apiTrinksErrorsTotal);
register.registerMetric(firstTryBookingTotal);
register.registerMetric(serviceSuggestionDuration);
register.registerMetric(trinksApiDuration);
register.registerMetric(cacheHitsTotal);
register.registerMetric(cacheMissesTotal);
register.registerMetric(proactiveSuggestionsShownTotal);
register.registerMetric(proactiveSuggestionsClickedTotal);
register.registerMetric(conversationStepsTotal);
register.registerMetric(abTestConversionsTotal);
register.registerMetric(upsellShownTotal);
register.registerMetric(upsellAcceptedTotal);
register.registerMetric(upsellDeclinedTotal);
register.registerMetric(ticketValueHistogram);
register.registerMetric(upsellConversionRate);
register.registerMetric(preVisitSentTotal);
register.registerMetric(noShowCheckSentTotal);
register.registerMetric(noShowPreventedTotal);
register.registerMetric(rescheduleRequestedTotal);
register.registerMetric(userOptOutTotal);

/**
 * Get metrics in Prometheus format
 */
export async function getMetrics(): Promise<string> {
  try {
    return await register.metrics();
  } catch (error) {
    logger.error('Error collecting metrics:', error);
    throw error;
  }
}

/**
 * Clear all metrics (useful for testing)
 */
export function clearMetrics(): void {
  register.clear();
}

/**
 * Helper functions to increment metrics with proper error handling
 */
export const MetricsHelper = {
  incrementConversationsStarted(tenantId: string, channel: string = 'whatsapp') {
    try {
      conversationsStartedTotal.inc({ tenant_id: tenantId, channel });
    } catch (error) {
      logger.warn('Failed to increment conversations_started_total:', error);
    }
  },

  incrementServiceSuggestionsShown(tenantId: string, suggestionCount: number) {
    try {
      serviceSuggestionsShownTotal.inc({ 
        tenant_id: tenantId, 
        suggestion_count: suggestionCount.toString() 
      });
    } catch (error) {
      logger.warn('Failed to increment service_suggestions_shown_total:', error);
    }
  },

  incrementBookingsConfirmed(tenantId: string, serviceId: string, professionalId?: string) {
    try {
      bookingsConfirmedTotal.inc({ 
        tenant_id: tenantId, 
        service_id: serviceId,
        professional_id: professionalId || 'unknown'
      });
    } catch (error) {
      logger.warn('Failed to increment bookings_confirmed_total:', error);
    }
  },

  incrementTrinksErrors(code: string, endpoint: string, method: string = 'GET') {
    try {
      apiTrinksErrorsTotal.inc({ code, endpoint, method });
    } catch (error) {
      logger.warn('Failed to increment api_trinks_errors_total:', error);
    }
  },

  incrementFirstTryBooking(tenantId: string, serviceId: string) {
    try {
      firstTryBookingTotal.inc({ tenant_id: tenantId, service_id: serviceId });
    } catch (error) {
      logger.warn('Failed to increment first_try_booking_total:', error);
    }
  },

  recordServiceSuggestionDuration(tenantId: string, duration: number, cacheHit: boolean = false) {
    try {
      serviceSuggestionDuration.observe(
        { tenant_id: tenantId, cache_hit: cacheHit.toString() },
        duration
      );
    } catch (error) {
      logger.warn('Failed to record service_suggestion_duration:', error);
    }
  },

  recordTrinksApiDuration(endpoint: string, method: string, statusCode: number, duration: number) {
    try {
      trinksApiDuration.observe(
        { endpoint, method, status_code: statusCode.toString() },
        duration
      );
    } catch (error) {
      logger.warn('Failed to record trinks_api_duration:', error);
    }
  },

  incrementCacheHits(cacheType: string, keyPattern: string) {
    try {
      cacheHitsTotal.inc({ cache_type: cacheType, key_pattern: keyPattern });
    } catch (error) {
      logger.warn('Failed to increment cache_hits_total:', error);
    }
  },

  incrementCacheMisses(cacheType: string, keyPattern: string) {
    try {
      cacheMissesTotal.inc({ cache_type: cacheType, key_pattern: keyPattern });
    } catch (error) {
      logger.warn('Failed to increment cache_misses_total:', error);
    }
  },

  // A/B Test metrics helpers
  incrementProactiveSuggestionsShown(tenantId: string, abVariant: string, suggestionType: string) {
    try {
      proactiveSuggestionsShownTotal.inc({ 
        tenant_id: tenantId, 
        ab_variant: abVariant,
        suggestion_type: suggestionType
      });
    } catch (error) {
      logger.warn('Failed to increment proactive_suggestions_shown_total:', error);
    }
  },

  incrementProactiveSuggestionsClicked(tenantId: string, abVariant: string, suggestionType: string) {
    try {
      proactiveSuggestionsClickedTotal.inc({ 
        tenant_id: tenantId, 
        ab_variant: abVariant,
        suggestion_type: suggestionType
      });
    } catch (error) {
      logger.warn('Failed to increment proactive_suggestions_clicked_total:', error);
    }
  },

  incrementConversationSteps(tenantId: string, abVariant: string, outcome: string) {
    try {
      conversationStepsTotal.inc({ 
        tenant_id: tenantId, 
        ab_variant: abVariant,
        outcome
      });
    } catch (error) {
      logger.warn('Failed to increment conversation_steps_total:', error);
    }
  },

  incrementABTestConversions(tenantId: string, abVariant: string, conversionType: string) {
    try {
      abTestConversionsTotal.inc({ 
        tenant_id: tenantId, 
        ab_variant: abVariant,
        conversion_type: conversionType
      });
    } catch (error) {
      logger.warn('Failed to increment ab_test_conversions_total:', error);
    }
  },

  // Upsell metrics helpers
  incrementUpsellShown(tenantId: string, baseServiceId?: string, suggestedServiceId?: string) {
    try {
      upsellShownTotal.inc({ 
        tenant_id: tenantId,
        base_service_id: baseServiceId || 'unknown',
        suggested_service_id: suggestedServiceId || 'unknown'
      });
    } catch (error) {
      logger.warn('Failed to increment upsell_shown_total:', error);
    }
  },

  incrementUpsellAccepted(tenantId: string, baseServiceId?: string, suggestedServiceId?: string) {
    try {
      upsellAcceptedTotal.inc({ 
        tenant_id: tenantId,
        base_service_id: baseServiceId || 'unknown',
        suggested_service_id: suggestedServiceId || 'unknown'
      });
    } catch (error) {
      logger.warn('Failed to increment upsell_accepted_total:', error);
    }
  },

  incrementUpsellDeclined(tenantId: string, baseServiceId?: string, suggestedServiceId?: string) {
    try {
      upsellDeclinedTotal.inc({ 
        tenant_id: tenantId,
        base_service_id: baseServiceId || 'unknown',
        suggested_service_id: suggestedServiceId || 'unknown'
      });
    } catch (error) {
      logger.warn('Failed to increment upsell_declined_total:', error);
    }
  },

  recordTicketValue(tenantId: string, valueCents: number, hasUpsell: boolean = false) {
    try {
      ticketValueHistogram.observe(
        { tenant_id: tenantId, has_upsell: hasUpsell.toString() },
        valueCents
      );
    } catch (error) {
      logger.warn('Failed to record ticket_value:', error);
    }
  },

  recordUpsellConversionRate(tenantId: string, baseServiceId: string, conversionRate: number) {
    try {
      upsellConversionRate.observe(
        { tenant_id: tenantId, base_service_id: baseServiceId },
        conversionRate
      );
    } catch (error) {
      logger.warn('Failed to record upsell_conversion_rate:', error);
    }
  },

  // Pre-visit and No-show metrics helpers
  incrementPreVisitSent(tenantId: string) {
    try {
      preVisitSentTotal.inc({ tenant_id: tenantId });
    } catch (error) {
      logger.warn('Failed to increment pre_visit_sent_total:', error);
    }
  },

  incrementNoShowCheckSent(tenantId: string) {
    try {
      noShowCheckSentTotal.inc({ tenant_id: tenantId });
    } catch (error) {
      logger.warn('Failed to increment no_show_check_sent_total:', error);
    }
  },

  incrementNoShowPrevented(tenantId: string) {
    try {
      noShowPreventedTotal.inc({ tenant_id: tenantId });
    } catch (error) {
      logger.warn('Failed to increment no_show_prevented_total:', error);
    }
  },

  incrementRescheduleRequested(tenantId: string) {
    try {
      rescheduleRequestedTotal.inc({ tenant_id: tenantId });
    } catch (error) {
      logger.warn('Failed to increment reschedule_requested_total:', error);
    }
  },

  incrementUserOptOut(tenantId: string, optOutType: string = 'all') {
    try {
      userOptOutTotal.inc({ tenant_id: tenantId, opt_out_type: optOutType });
    } catch (error) {
      logger.warn('Failed to increment user_opt_out_total:', error);
    }
  },

  recordHttpRequestDuration(method: string, path: string, statusCode: number, duration: number) {
    // This is a placeholder implementation since we don't have an HTTP request duration histogram defined
    // In a real implementation, you would create a histogram metric and record the duration
    try {
      logger.debug(`HTTP ${method} ${path} ${statusCode} took ${duration}ms`);
    } catch (error) {
      logger.warn('Failed to record HTTP request duration:', error);
    }
  },

  recordUpsellRevenue(tenantId: string, revenueCents: number) {
    try {
      ticketValueHistogram.observe(
        { tenant_id: tenantId, has_upsell: 'true' },
        revenueCents
      );
      logger.info(`Recorded upsell revenue: ${revenueCents} cents for tenant ${tenantId}`);
    } catch (error) {
      logger.error('Error recording upsell revenue:', error);
    }
  }
};

export default {
  getMetrics,
  clearMetrics,
  MetricsHelper,
  register
};