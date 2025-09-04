import { logger } from '../utils/logger';
import { ServiceSuggestion } from './validation-service';

export interface TemplateContext {
  user: {
    first_name?: string;
    phone: string;
    full_name?: string;
  };
  top3?: ServiceSuggestion[];
  service?: {
    nome: string;
    duracao: number;
    preco: string;
    categoria: string;
  };
  professional?: {
    nome: string;
    especialidade?: string;
  };
  appointment?: {
    date: string;
    time: string;
    datetime_formatted: string;
  };
  system?: {
    current_time: string;
    business_hours: string;
    contact_info: string;
  };
}

export interface ResponseTemplate {
  id: string;
  name: string;
  content: string;
  variables: string[];
  category: 'menu' | 'confirmation' | 'error' | 'info' | 'handoff';
  priority: number;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface TemplateRenderOptions {
  escapeHtml?: boolean;
  maxLength?: number;
  fallbackValues?: Record<string, string>;
  removeEmptyLines?: boolean;
}

export class ResponseTemplateService {
  private templates: Map<string, ResponseTemplate> = new Map();
  private readonly VARIABLE_PATTERN = /\{\{\s*([^}]+)\s*\}\}/g;
  private readonly MAX_TEMPLATE_LENGTH = 1000;
  
  constructor() {
    this.initializeDefaultTemplates();
  }

  /**
   * Inicializa templates padrão do sistema
   */
  private initializeDefaultTemplates(): void {
    const defaultTemplates: Omit<ResponseTemplate, 'created_at' | 'updated_at'>[] = [
      {
        id: 'menu_welcome',
        name: 'Menu de Boas-vindas',
        content: `Olá, {{user.first_name}}! Sou a Marliê 🌸.
Como posso ajudar hoje?

1) Agendar atendimento
2) Informações

Responda com **1** ou **2**.`,
        variables: ['user.first_name'],
        category: 'menu',
        priority: 1,
        active: true
      },
      {
        id: 'confirm_intent',
        name: 'Confirmação de Intenção',
        content: `Só para confirmar: você quer **Agendar (1)** ou **Informações (2)**?
Por favor, responda com **1** ou **2**.`,
        variables: [],
        category: 'menu',
        priority: 2,
        active: true
      },
      {
        id: 'invalid_option',
        name: 'Opção Inválida',
        content: `Não entendi. Para continuar, responda **1** para Agendar ou **2** para Informações.`,
        variables: [],
        category: 'error',
        priority: 1,
        active: true
      },
      {
        id: 'human_handoff_active',
        name: 'Handoff Humano Ativo',
        content: `Atendimento humano ativo. 👩‍💼 Aguarde, por favor.`,
        variables: [],
        category: 'handoff',
        priority: 1,
        active: true
      },
      {
        id: 'clarify_service',
        name: 'Clarificar Serviço',
        content: `Antes de confirmar, preciso entender melhor o serviço.
Você quis dizer algum destes? Responda com o número:

1) {{top3.0.nome}} — {{top3.0.duracao}}min — {{top3.0.preco}}
2) {{top3.1.nome}} — {{top3.1.duracao}}min — {{top3.1.preco}}
3) {{top3.2.nome}} — {{top3.2.duracao}}min — {{top3.2.preco}}`,
        variables: ['top3.0.nome', 'top3.0.duracao', 'top3.0.preco', 'top3.1.nome', 'top3.1.duracao', 'top3.1.preco', 'top3.2.nome', 'top3.2.duracao', 'top3.2.preco'],
        category: 'confirmation',
        priority: 1,
        active: true
      },
      {
        id: 'validation_failed',
        name: 'Validação Falhou',
        content: `Não posso confirmar ainda porque identifiquei a opção como **categoria** ou **ambígua**.
Selecione uma das opções listadas para seguir.`,
        variables: [],
        category: 'error',
        priority: 1,
        active: true
      },
      {
        id: 'appointment_confirmed',
        name: 'Agendamento Confirmado',
        content: `✅ **Agendamento Confirmado!**

📋 **Serviço:** {{service.nome}}
👩‍💼 **Profissional:** {{professional.nome}}
📅 **Data/Hora:** {{appointment.datetime_formatted}}
⏱️ **Duração:** {{service.duracao}} minutos
💰 **Valor:** {{service.preco}}

Obrigada, {{user.first_name}}! Até breve! 🌸`,
        variables: ['service.nome', 'professional.nome', 'appointment.datetime_formatted', 'service.duracao', 'service.preco', 'user.first_name'],
        category: 'confirmation',
        priority: 1,
        active: true
      },
      {
        id: 'business_info',
        name: 'Informações do Negócio',
        content: `📍 **Ateliê Marcleia Abade**

🕒 **Horário de Funcionamento:**
{{system.business_hours}}

📞 **Contato:**
{{system.contact_info}}

🌸 Estamos sempre prontas para cuidar da sua beleza!`,
        variables: ['system.business_hours', 'system.contact_info'],
        category: 'info',
        priority: 1,
        active: true
      },
      {
        id: 'service_unavailable',
        name: 'Serviço Indisponível',
        content: `😔 Infelizmente o horário solicitado não está disponível.

Gostaria de ver outras opções de horário para **{{service.nome}}**?

Responda **1** para ver horários ou **2** para escolher outro serviço.`,
        variables: ['service.nome'],
        category: 'error',
        priority: 1,
        active: true
      },
      {
        id: 'buffer_processing',
        name: 'Processando Mensagem',
        content: `Aguarde um momento, estou processando sua mensagem... ⏳`,
        variables: [],
        category: 'info',
        priority: 1,
        active: true
      }
    ];

    defaultTemplates.forEach(template => {
      this.addTemplate({
        ...template,
        created_at: new Date(),
        updated_at: new Date()
      });
    });
  }

  /**
   * Adiciona um novo template
   */
  addTemplate(template: ResponseTemplate): void {
    this.validateTemplate(template);
    this.templates.set(template.id, template);
    logger.info(`Template '${template.id}' added successfully`);
  }

  /**
   * Atualiza um template existente
   */
  updateTemplate(id: string, updates: Partial<ResponseTemplate>): boolean {
    const existing = this.templates.get(id);
    if (!existing) {
      logger.warn(`Template '${id}' not found for update`);
      return false;
    }

    const updated = {
      ...existing,
      ...updates,
      updated_at: new Date()
    };

    this.validateTemplate(updated);
    this.templates.set(id, updated);
    logger.info(`Template '${id}' updated successfully`);
    return true;
  }

  /**
   * Remove um template
   */
  removeTemplate(id: string): boolean {
    const deleted = this.templates.delete(id);
    if (deleted) {
      logger.info(`Template '${id}' removed successfully`);
    } else {
      logger.warn(`Template '${id}' not found for removal`);
    }
    return deleted;
  }

  /**
   * Obtém um template por ID
   */
  getTemplate(id: string): ResponseTemplate | null {
    return this.templates.get(id) || null;
  }

  /**
   * Lista todos os templates
   */
  listTemplates(category?: string, activeOnly: boolean = true): ResponseTemplate[] {
    const templates = Array.from(this.templates.values());
    
    return templates
      .filter(template => {
        if (activeOnly && !template.active) return false;
        if (category && template.category !== category) return false;
        return true;
      })
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Renderiza um template com contexto
   */
  render(
    templateId: string, 
    context: TemplateContext, 
    options: TemplateRenderOptions = {}
  ): string {
    const template = this.getTemplate(templateId);
    if (!template) {
      logger.error(`Template '${templateId}' not found`);
      return `[Erro: Template '${templateId}' não encontrado]`;
    }

    if (!template.active) {
      logger.warn(`Template '${templateId}' is inactive`);
      return `[Template '${templateId}' está inativo]`;
    }

    try {
      let rendered = this.processVariables(template.content, context, options.fallbackValues);
      
      if (options.removeEmptyLines) {
        rendered = this.removeEmptyLines(rendered);
      }
      
      if (options.maxLength && rendered.length > options.maxLength) {
        rendered = rendered.substring(0, options.maxLength - 3) + '...';
      }
      
      if (options.escapeHtml) {
        rendered = this.escapeHtml(rendered);
      }
      
      return rendered;
    } catch (error) {
      logger.error(`Error rendering template '${templateId}':`, error);
      return `[Erro ao renderizar template '${templateId}']`;
    }
  }

  /**
   * Processa variáveis no conteúdo do template
   */
  private processVariables(
    content: string, 
    context: TemplateContext, 
    fallbackValues?: Record<string, string>
  ): string {
    return content.replace(this.VARIABLE_PATTERN, (match, variable) => {
      const value = this.getVariableValue(variable.trim(), context);
      
      if (value !== undefined && value !== null) {
        return String(value);
      }
      
      // Tenta fallback
      if (fallbackValues && fallbackValues[variable]) {
        return fallbackValues[variable];
      }
      
      // Fallbacks padrão
      const defaultFallbacks: Record<string, string> = {
        'user.first_name': 'Cliente',
        'user.full_name': 'Cliente',
        'service.preco': 'Consultar',
        'system.business_hours': 'Segunda a Sábado: 9h às 18h',
        'system.contact_info': 'WhatsApp: (11) 99999-9999'
      };
      
      if (defaultFallbacks[variable]) {
        return defaultFallbacks[variable];
      }
      
      logger.warn(`Variable '${variable}' not found in context`);
      return `[${variable}]`;
    });
  }

  /**
   * Obtém valor de uma variável do contexto
   */
  private getVariableValue(variable: string, context: TemplateContext): any {
    const parts = variable.split('.');
    let current: any = context;
    
    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      
      // Handle array access (e.g., top3.0.nome)
      if (/^\d+$/.test(part)) {
        const index = parseInt(part, 10);
        if (Array.isArray(current) && index < current.length) {
          current = current[index];
        } else {
          return undefined;
        }
      } else {
        current = current[part];
      }
    }
    
    return current;
  }

  /**
   * Remove linhas vazias do texto
   */
  private removeEmptyLines(text: string): string {
    return text
      .split('\n')
      .filter(line => line.trim().length > 0)
      .join('\n');
  }

  /**
   * Escapa HTML no texto
   */
  private escapeHtml(text: string): string {
    const htmlEscapes: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    
    return text.replace(/[&<>"']/g, char => htmlEscapes[char]);
  }

  /**
   * Valida um template
   */
  private validateTemplate(template: ResponseTemplate): void {
    if (!template.id || template.id.trim().length === 0) {
      throw new Error('Template ID is required');
    }
    
    if (!template.content || template.content.trim().length === 0) {
      throw new Error('Template content is required');
    }
    
    if (template.content.length > this.MAX_TEMPLATE_LENGTH) {
      throw new Error(`Template content exceeds maximum length of ${this.MAX_TEMPLATE_LENGTH} characters`);
    }
    
    if (!['menu', 'confirmation', 'error', 'info', 'handoff'].includes(template.category)) {
      throw new Error('Invalid template category');
    }
    
    // Valida variáveis
    const foundVariables = this.extractVariables(template.content);
    const declaredVariables = new Set(template.variables);
    
    for (const variable of foundVariables) {
      if (!declaredVariables.has(variable)) {
        logger.warn(`Variable '${variable}' used in template '${template.id}' but not declared`);
      }
    }
  }

  /**
   * Extrai variáveis do conteúdo do template
   */
  private extractVariables(content: string): string[] {
    const variables: string[] = [];
    let match;
    
    while ((match = this.VARIABLE_PATTERN.exec(content)) !== null) {
      variables.push(match[1].trim());
    }
    
    // Reset regex lastIndex
    this.VARIABLE_PATTERN.lastIndex = 0;
    
    return [...new Set(variables)];
  }

  /**
   * Cria contexto básico do usuário
   */
  createUserContext(phone: string, firstName?: string, fullName?: string): TemplateContext {
    return {
      user: {
        phone,
        first_name: firstName || this.extractFirstName(fullName),
        full_name: fullName
      },
      system: {
        current_time: new Date().toLocaleString('pt-BR'),
        business_hours: 'Segunda a Sábado: 9h às 18h',
        contact_info: 'WhatsApp: (11) 99999-9999'
      }
    };
  }

  /**
   * Extrai primeiro nome de um nome completo
   */
  private extractFirstName(fullName?: string): string {
    if (!fullName) return 'Cliente';
    
    const parts = fullName.trim().split(/\s+/);
    return parts[0] || 'Cliente';
  }

  /**
   * Adiciona sugestões de serviços ao contexto
   */
  addServicesToContext(
    context: TemplateContext, 
    services: ServiceSuggestion[]
  ): TemplateContext {
    return {
      ...context,
      top3: services.slice(0, 3)
    };
  }

  /**
   * Adiciona informações de agendamento ao contexto
   */
  addAppointmentToContext(
    context: TemplateContext,
    service: any,
    professional: any,
    dateTime: Date
  ): TemplateContext {
    return {
      ...context,
      service: {
        nome: service.nome,
        duracao: service.duracao,
        preco: service.preco,
        categoria: service.categoria
      },
      professional: {
        nome: professional.nome,
        especialidade: professional.especialidade
      },
      appointment: {
        date: dateTime.toLocaleDateString('pt-BR'),
        time: dateTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        datetime_formatted: dateTime.toLocaleString('pt-BR', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })
      }
    };
  }

  /**
   * Exporta templates para backup
   */
  exportTemplates(): ResponseTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Importa templates de backup
   */
  importTemplates(templates: ResponseTemplate[]): void {
    for (const template of templates) {
      try {
        this.validateTemplate(template);
        this.templates.set(template.id, template);
      } catch (error) {
        logger.error(`Failed to import template '${template.id}':`, error);
      }
    }
    
    logger.info(`Imported ${templates.length} templates`);
  }
}

// Singleton instance
let templateServiceInstance: ResponseTemplateService | null = null;

export function getResponseTemplateService(): ResponseTemplateService {
  if (!templateServiceInstance) {
    templateServiceInstance = new ResponseTemplateService();
  }
  return templateServiceInstance;
}

export function resetResponseTemplateService(): void {
  templateServiceInstance = null;
}