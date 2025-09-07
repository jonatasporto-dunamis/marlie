import { logger } from '../utils/logger';

export interface TemplateContext {
  patient: {
    name: string;
    firstName?: string;
  };
  appointment: {
    id: string;
    date: string;
    time: string;
    dateTime: string;
    formattedDateTime: string;
  };
  professional: {
    name: string;
    firstName?: string;
  };
  service: {
    name: string;
    duration?: number;
  };
  clinic: {
    name: string;
    address?: string;
    phone?: string;
  };
  slots?: Array<{
    id: string;
    date: string;
    time: string;
    formattedDateTime: string;
    professional: {
      name: string;
      firstName?: string;
    };
  }>;
  custom?: Record<string, any>;
}

export interface NotificationTemplate {
  id: string;
  name: string;
  type: 'previsit' | 'noshow' | 'rebook' | 'confirmation' | 'reminder';
  channel: 'whatsapp' | 'sms' | 'email';
  subject?: string;
  content: string;
  variables: string[];
  active: boolean;
  priority: number;
  conditions?: {
    timeBeforeAppointment?: {
      min: number;
      max: number;
      unit: 'hours' | 'days';
    };
    serviceTypes?: string[];
    professionalIds?: string[];
  };
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Templates predefinidos para diferentes tipos de notificação
 */
export const DEFAULT_TEMPLATES: Record<string, NotificationTemplate> = {
  // Templates de Pré-visita
  previsit_standard: {
    id: 'previsit_standard',
    name: 'Pré-visita Padrão',
    type: 'previsit',
    channel: 'whatsapp',
    content: `Olá {{patient.firstName}}! 👋

Lembrando que você tem consulta marcada para:
📅 **{{appointment.formattedDateTime}}**
👩‍⚕️ **{{professional.name}}**
🏥 **{{service.name}}**

Por favor, confirme sua presença respondendo:
✅ **SIM** - para confirmar
❌ **NÃO** - para reagendar

Obrigada! 😊`,
    variables: ['patient.firstName', 'appointment.formattedDateTime', 'professional.name', 'service.name'],
    active: true,
    priority: 1,
    conditions: {
      timeBeforeAppointment: {
        min: 12,
        max: 36,
        unit: 'hours'
      }
    },
    createdAt: new Date(),
    updatedAt: new Date()
  },

  previsit_formal: {
    id: 'previsit_formal',
    name: 'Pré-visita Formal',
    type: 'previsit',
    channel: 'whatsapp',
    content: `Prezado(a) {{patient.name}},

Este é um lembrete de sua consulta agendada:

Data e Hora: {{appointment.formattedDateTime}}
Profissional: {{professional.name}}
Serviço: {{service.name}}
Local: {{clinic.name}}

Para confirmar sua presença, responda SIM.
Caso precise reagendar, responda NÃO.

Atenciosamente,
Equipe {{clinic.name}}`,
    variables: ['patient.name', 'appointment.formattedDateTime', 'professional.name', 'service.name', 'clinic.name'],
    active: true,
    priority: 2,
    conditions: {
      timeBeforeAppointment: {
        min: 24,
        max: 48,
        unit: 'hours'
      }
    },
    createdAt: new Date(),
    updatedAt: new Date()
  },

  // Templates de No-Show
  noshow_offer_rebook: {
    id: 'noshow_offer_rebook',
    name: 'No-Show com Oferta de Reagendamento',
    type: 'noshow',
    channel: 'whatsapp',
    content: `Oi {{patient.firstName}}! 😔

Notamos que você não pôde comparecer à sua consulta de hoje ({{appointment.formattedDateTime}}).

Sem problemas! Aqui estão os próximos horários disponíveis:

{{#each slots}}
{{@index}}. {{this.formattedDateTime}} - {{this.professional.name}}
{{/each}}

Responda com o número da opção desejada (1, 2 ou 3) para reagendar.

Estamos aqui para ajudar! 💙`,
    variables: ['patient.firstName', 'appointment.formattedDateTime', 'slots'],
    active: true,
    priority: 1,
    createdAt: new Date(),
    updatedAt: new Date()
  },

  noshow_simple: {
    id: 'noshow_simple',
    name: 'No-Show Simples',
    type: 'noshow',
    channel: 'whatsapp',
    content: `Olá {{patient.firstName}}!

Você perdeu sua consulta de hoje ({{appointment.formattedDateTime}}).

Para reagendar, entre em contato conosco pelo telefone {{clinic.phone}} ou responda esta mensagem.

Obrigada!`,
    variables: ['patient.firstName', 'appointment.formattedDateTime', 'clinic.phone'],
    active: true,
    priority: 2,
    createdAt: new Date(),
    updatedAt: new Date()
  },

  // Templates de Reagendamento
  rebook_confirmation: {
    id: 'rebook_confirmation',
    name: 'Confirmação de Reagendamento',
    type: 'rebook',
    channel: 'whatsapp',
    content: `Perfeito, {{patient.firstName}}! ✅

Sua consulta foi reagendada para:
📅 **{{appointment.formattedDateTime}}**
👩‍⚕️ **{{professional.name}}**
🏥 **{{service.name}}**

Anote na sua agenda! Até lá! 😊`,
    variables: ['patient.firstName', 'appointment.formattedDateTime', 'professional.name', 'service.name'],
    active: true,
    priority: 1,
    createdAt: new Date(),
    updatedAt: new Date()
  },

  rebook_with_details: {
    id: 'rebook_with_details',
    name: 'Reagendamento com Detalhes',
    type: 'rebook',
    channel: 'whatsapp',
    content: `{{patient.firstName}}, reagendamento confirmado! 🎉

📋 **NOVA CONSULTA:**
📅 Data: {{appointment.date}}
🕐 Horário: {{appointment.time}}
👩‍⚕️ Profissional: {{professional.name}}
🏥 Serviço: {{service.name}}
📍 Local: {{clinic.name}}
{{#if clinic.address}}📍 Endereço: {{clinic.address}}{{/if}}

⏰ Chegue 15 minutos antes do horário.

Qualquer dúvida, estamos aqui! 💙`,
    variables: ['patient.firstName', 'appointment.date', 'appointment.time', 'professional.name', 'service.name', 'clinic.name', 'clinic.address'],
    active: true,
    priority: 2,
    createdAt: new Date(),
    updatedAt: new Date()
  },

  // Templates de Confirmação
  confirmation_simple: {
    id: 'confirmation_simple',
    name: 'Confirmação Simples',
    type: 'confirmation',
    channel: 'whatsapp',
    content: `Obrigada, {{patient.firstName}}! ✨

Sua presença está confirmada para {{appointment.formattedDateTime}}.

Até lá! 😊`,
    variables: ['patient.firstName', 'appointment.formattedDateTime'],
    active: true,
    priority: 1,
    createdAt: new Date(),
    updatedAt: new Date()
  },

  // Templates de Lembrete
  reminder_day_before: {
    id: 'reminder_day_before',
    name: 'Lembrete Dia Anterior',
    type: 'reminder',
    channel: 'whatsapp',
    content: `Oi {{patient.firstName}}! 👋

Lembrando que amanhã você tem consulta:
🕐 {{appointment.time}}
👩‍⚕️ {{professional.name}}

Nos vemos lá! 😊`,
    variables: ['patient.firstName', 'appointment.time', 'professional.name'],
    active: true,
    priority: 1,
    conditions: {
      timeBeforeAppointment: {
        min: 18,
        max: 30,
        unit: 'hours'
      }
    },
    createdAt: new Date(),
    updatedAt: new Date()
  }
};

/**
 * Classe para gerenciar templates de notificação
 */
export class NotificationTemplateService {
  private tenantId: string;
  private templates: Map<string, NotificationTemplate> = new Map();

  constructor(tenantId: string) {
    this.tenantId = tenantId;
    this.loadDefaultTemplates();
  }

  /**
   * Carrega templates padrão
   */
  private loadDefaultTemplates(): void {
    Object.values(DEFAULT_TEMPLATES).forEach(template => {
      this.templates.set(template.id, template);
    });
  }

  /**
   * Renderiza um template com contexto
   */
  renderTemplate(
    templateId: string,
    context: TemplateContext
  ): { subject?: string; content: string } {
    const template = this.templates.get(templateId);
    if (!template) {
      throw new Error(`Template não encontrado: ${templateId}`);
    }

    if (!template.active) {
      throw new Error(`Template inativo: ${templateId}`);
    }

    try {
      const renderedContent = this.processTemplate(template.content, context);
      const renderedSubject = template.subject 
        ? this.processTemplate(template.subject, context)
        : undefined;

      return {
        subject: renderedSubject,
        content: renderedContent
      };
    } catch (error) {
      logger.error('Erro ao renderizar template', {
        templateId,
        error: error.message,
        tenantId: this.tenantId
      });
      throw error;
    }
  }

  /**
   * Processa template substituindo variáveis
   */
  private processTemplate(template: string, context: TemplateContext): string {
    let result = template;

    // Substituir variáveis simples {{variable}}
    result = result.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
      const value = this.getNestedValue(context, path.trim());
      return value !== undefined ? String(value) : match;
    });

    // Processar loops {{#each array}}
    result = result.replace(
      /\{\{#each\s+([^}]+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
      (match, arrayPath, loopContent) => {
        const array = this.getNestedValue(context, arrayPath.trim());
        if (!Array.isArray(array)) {
          return '';
        }

        return array.map((item, index) => {
          let itemContent = loopContent;
          
          // Substituir {{@index}} pelo índice (1-based)
          itemContent = itemContent.replace(/\{\{@index\}\}/g, String(index + 1));
          
          // Substituir {{this.property}} pelas propriedades do item
          itemContent = itemContent.replace(/\{\{this\.([^}]+)\}\}/g, (itemMatch, itemPath) => {
            const itemValue = this.getNestedValue(item, itemPath.trim());
            return itemValue !== undefined ? String(itemValue) : itemMatch;
          });
          
          return itemContent;
        }).join('');
      }
    );

    // Processar condicionais {{#if condition}}
    result = result.replace(
      /\{\{#if\s+([^}]+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
      (match, conditionPath, conditionalContent) => {
        const value = this.getNestedValue(context, conditionPath.trim());
        return value ? conditionalContent : '';
      }
    );

    return result;
  }

  /**
   * Obtém valor aninhado de um objeto usando path (ex: 'patient.name')
   */
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
  }

  /**
   * Seleciona melhor template baseado em condições
   */
  selectBestTemplate(
    type: NotificationTemplate['type'],
    channel: NotificationTemplate['channel'],
    context: TemplateContext
  ): NotificationTemplate | null {
    const candidates = Array.from(this.templates.values())
      .filter(t => t.type === type && t.channel === channel && t.active)
      .filter(t => this.matchesConditions(t, context))
      .sort((a, b) => a.priority - b.priority);

    return candidates[0] || null;
  }

  /**
   * Verifica se template atende às condições
   */
  private matchesConditions(
    template: NotificationTemplate,
    context: TemplateContext
  ): boolean {
    if (!template.conditions) {
      return true;
    }

    // Verificar tempo antes do agendamento
    if (template.conditions.timeBeforeAppointment) {
      const appointmentTime = new Date(context.appointment.dateTime);
      const now = new Date();
      const hoursUntilAppointment = (appointmentTime.getTime() - now.getTime()) / (1000 * 60 * 60);
      
      const { min, max, unit } = template.conditions.timeBeforeAppointment;
      const minHours = unit === 'days' ? min * 24 : min;
      const maxHours = unit === 'days' ? max * 24 : max;
      
      if (hoursUntilAppointment < minHours || hoursUntilAppointment > maxHours) {
        return false;
      }
    }

    // Verificar tipos de serviço
    if (template.conditions.serviceTypes) {
      if (!template.conditions.serviceTypes.includes(context.service.name)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Adiciona template customizado
   */
  addTemplate(template: NotificationTemplate): void {
    this.templates.set(template.id, template);
  }

  /**
   * Lista todos os templates
   */
  listTemplates(type?: NotificationTemplate['type']): NotificationTemplate[] {
    const templates = Array.from(this.templates.values());
    return type ? templates.filter(t => t.type === type) : templates;
  }

  /**
   * Obtém template por ID
   */
  getTemplate(id: string): NotificationTemplate | undefined {
    return this.templates.get(id);
  }

  /**
   * Valida variáveis do template
   */
  validateTemplate(template: NotificationTemplate, context: TemplateContext): {
    valid: boolean;
    missingVariables: string[];
  } {
    const missingVariables: string[] = [];
    
    for (const variable of template.variables) {
      const value = this.getNestedValue(context, variable);
      if (value === undefined) {
        missingVariables.push(variable);
      }
    }
    
    return {
      valid: missingVariables.length === 0,
      missingVariables
    };
  }
}

/**
 * Factory function para criar instância do serviço
 */
export function createNotificationTemplateService(tenantId: string): NotificationTemplateService {
  return new NotificationTemplateService(tenantId);
}

/**
 * Utilitário para formatar data/hora para templates
 */
export function formatDateTimeForTemplate(
  dateTime: string | Date,
  timezone: string = 'America/Sao_Paulo'
): {
  date: string;
  time: string;
  formattedDateTime: string;
} {
  const date = new Date(dateTime);
  
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  };
  
  const formatter = new Intl.DateTimeFormat('pt-BR', options);
  const parts = formatter.formatToParts(date);
  
  const dateStr = `${parts.find(p => p.type === 'day')?.value}/${parts.find(p => p.type === 'month')?.value}/${parts.find(p => p.type === 'year')?.value}`;
  const timeStr = `${parts.find(p => p.type === 'hour')?.value}:${parts.find(p => p.type === 'minute')?.value}`;
  
  return {
    date: dateStr,
    time: timeStr,
    formattedDateTime: `${dateStr} às ${timeStr}`
  };
}