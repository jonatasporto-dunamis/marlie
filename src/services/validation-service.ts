import { logger } from '../utils/logger';
import { CatalogService } from './catalog-service';
import { TrinksService } from './trinks-service';

export interface ValidationResult {
  isValid: boolean;
  reason?: string;
  category?: 'explicit' | 'category' | 'ambiguous' | 'invalid';
  confidence?: number;
  suggestions?: ServiceSuggestion[];
}

export interface ServiceSuggestion {
  id: string;
  nome: string;
  duracao: number;
  preco: string;
  categoria: string;
  confidence: number;
}

export interface ValidationRequest {
  query: string;
  serviceId?: string;
  professionalId?: string;
  startIso?: string;
  tenantId: string;
}

export class ValidationService {
  private catalogService: CatalogService;
  private trinksService: TrinksService;
  
  // Thresholds for validation
  private readonly EXPLICIT_THRESHOLD = 0.85;
  private readonly CATEGORY_THRESHOLD = 0.6;
  private readonly MIN_CONFIDENCE = 0.3;
  
  // Category keywords that indicate general intent
  private readonly CATEGORY_KEYWORDS = [
    'cabelo', 'unha', 'sobrancelha', 'depilação', 'massagem',
    'facial', 'corporal', 'estética', 'beleza', 'tratamento',
    'procedimento', 'serviço', 'atendimento'
  ];
  
  // Ambiguous phrases that need clarification
  private readonly AMBIGUOUS_PATTERNS = [
    /\b(fazer|quero|preciso)\s+(cabelo|unha|sobrancelha)\b/i,
    /\b(alguma coisa|algo)\s+(para|no|na)\b/i,
    /\b(ver|saber)\s+(sobre|dos?)\s+serviços?\b/i,
    /\b(que|quais)\s+(serviços?|procedimentos?)\b/i,
    /\b(tem|vocês fazem)\s+\w+\?$/i
  ];

  constructor(catalogService: CatalogService, trinksService: TrinksService) {
    this.catalogService = catalogService;
    this.trinksService = trinksService;
  }

  /**
   * Valida se um serviço pode ser agendado diretamente
   * Rejeita categorias genéricas e consultas ambíguas
   */
  async validateServiceIntent(request: ValidationRequest): Promise<ValidationResult> {
    try {
      const { query, serviceId, tenantId } = request;
      
      // Se já tem serviceId específico, valida disponibilidade
      if (serviceId) {
        return await this.validateSpecificService(request);
      }
      
      // Analisa a intenção baseada na query
      const intentAnalysis = await this.analyzeIntent(query, tenantId);
      
      return intentAnalysis;
    } catch (error) {
      logger.error('Error validating service intent:', error);
      return {
        isValid: false,
        reason: 'Erro interno na validação',
        category: 'invalid'
      };
    }
  }

  /**
   * Analisa a intenção do usuário baseada na query
   */
  private async analyzeIntent(query: string, tenantId: string): Promise<ValidationResult> {
    const normalizedQuery = query.toLowerCase().trim();
    
    // 1. Verifica se é ambíguo
    if (this.isAmbiguousQuery(normalizedQuery)) {
      const suggestions = await this.catalogService.searchTopServices(query, tenantId, 3);
      return {
        isValid: false,
        reason: 'Consulta muito ambígua, precisa de clarificação',
        category: 'ambiguous',
        confidence: 0.2,
        suggestions: this.formatSuggestions(suggestions)
      };
    }
    
    // 2. Busca serviços correspondentes
    const searchResults = await this.catalogService.searchTopServices(query, tenantId, 5);
    
    if (!searchResults || searchResults.length === 0) {
      return {
        isValid: false,
        reason: 'Nenhum serviço encontrado para esta consulta',
        category: 'invalid',
        confidence: 0
      };
    }
    
    // 3. Analisa a qualidade dos resultados
    const topResult = searchResults[0];
    const confidence = this.calculateConfidence(query, topResult);
    
    // 4. Determina categoria baseada na confiança
    if (confidence >= this.EXPLICIT_THRESHOLD) {
      return {
        isValid: true,
        reason: 'Serviço específico identificado com alta confiança',
        category: 'explicit',
        confidence,
        suggestions: this.formatSuggestions([topResult])
      };
    }
    
    if (confidence >= this.CATEGORY_THRESHOLD || this.isCategoryQuery(normalizedQuery)) {
      return {
        isValid: false,
        reason: 'Consulta muito genérica, precisa especificar o serviço',
        category: 'category',
        confidence,
        suggestions: this.formatSuggestions(searchResults.slice(0, 3))
      };
    }
    
    if (confidence >= this.MIN_CONFIDENCE) {
      return {
        isValid: false,
        reason: 'Múltiplas opções encontradas, precisa escolher uma específica',
        category: 'ambiguous',
        confidence,
        suggestions: this.formatSuggestions(searchResults.slice(0, 3))
      };
    }
    
    return {
      isValid: false,
      reason: 'Não foi possível identificar um serviço específico',
      category: 'invalid',
      confidence
    };
  }

  /**
   * Valida um serviço específico e sua disponibilidade
   */
  private async validateSpecificService(request: ValidationRequest): Promise<ValidationResult> {
    const { serviceId, professionalId, startIso, tenantId } = request;
    
    try {
      // 1. Verifica se o serviço existe no catálogo
      const service = await this.catalogService.getServiceById(serviceId!, tenantId);
      if (!service) {
        return {
          isValid: false,
          reason: 'Serviço não encontrado no catálogo',
          category: 'invalid'
        };
      }
      
      // 2. Se tem data/hora, valida disponibilidade no Trinks
      if (startIso && professionalId) {
        const availability = await this.trinksService.validateAvailability(
          serviceId!,
          professionalId,
          startIso
        );
        
        if (!availability.available) {
          return {
            isValid: false,
            reason: availability.reason || 'Horário não disponível',
            category: 'invalid'
          };
        }
      }
      
      return {
        isValid: true,
        reason: 'Serviço válido e disponível',
        category: 'explicit',
        confidence: 1.0,
        suggestions: [this.formatServiceSuggestion(service)]
      };
    } catch (error) {
      logger.error('Error validating specific service:', error);
      return {
        isValid: false,
        reason: 'Erro ao validar disponibilidade do serviço',
        category: 'invalid'
      };
    }
  }

  /**
   * Verifica se a query é ambígua demais
   */
  private isAmbiguousQuery(query: string): boolean {
    // Queries muito curtas
    if (query.length < 3) {
      return true;
    }
    
    // Patterns ambíguos
    for (const pattern of this.AMBIGUOUS_PATTERNS) {
      if (pattern.test(query)) {
        return true;
      }
    }
    
    // Apenas palavras genéricas
    const words = query.split(/\s+/);
    const genericWords = ['quero', 'fazer', 'preciso', 'tem', 'vocês', 'fazem', 'que', 'qual'];
    const nonGenericWords = words.filter(word => 
      !genericWords.includes(word) && word.length > 2
    );
    
    return nonGenericWords.length === 0;
  }

  /**
   * Verifica se é uma consulta de categoria genérica
   */
  private isCategoryQuery(query: string): boolean {
    const words = query.split(/\s+/);
    
    // Verifica se contém apenas palavras de categoria
    for (const keyword of this.CATEGORY_KEYWORDS) {
      if (words.includes(keyword) && words.length <= 2) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Calcula confiança baseada na similaridade entre query e resultado
   */
  private calculateConfidence(query: string, service: any): number {
    const queryWords = query.toLowerCase().split(/\s+/);
    const serviceWords = service.nome.toLowerCase().split(/\s+/);
    
    // Exact match
    if (query.toLowerCase() === service.nome.toLowerCase()) {
      return 1.0;
    }
    
    // Partial word matches
    let matches = 0;
    for (const queryWord of queryWords) {
      if (queryWord.length < 3) continue;
      
      for (const serviceWord of serviceWords) {
        if (serviceWord.includes(queryWord) || queryWord.includes(serviceWord)) {
          matches++;
          break;
        }
      }
    }
    
    const wordMatchRatio = matches / Math.max(queryWords.length, 1);
    
    // Considera também a categoria
    const categoryMatch = service.categoria && 
      query.toLowerCase().includes(service.categoria.toLowerCase()) ? 0.2 : 0;
    
    return Math.min(wordMatchRatio + categoryMatch, 1.0);
  }

  /**
   * Formata sugestões de serviços
   */
  private formatSuggestions(services: any[]): ServiceSuggestion[] {
    return services.map(service => this.formatServiceSuggestion(service));
  }

  /**
   * Formata uma sugestão de serviço
   */
  private formatServiceSuggestion(service: any): ServiceSuggestion {
    return {
      id: service.servico_id || service.id,
      nome: service.nome,
      duracao: service.duracao || 0,
      preco: service.preco || 'Consultar',
      categoria: service.categoria || 'Geral',
      confidence: service.confidence || 0.8
    };
  }

  /**
   * Valida formato de data/hora ISO
   */
  validateDateTimeFormat(dateTimeIso: string): ValidationResult {
    try {
      const date = new Date(dateTimeIso);
      
      if (isNaN(date.getTime())) {
        return {
          isValid: false,
          reason: 'Formato de data/hora inválido',
          category: 'invalid'
        };
      }
      
      // Verifica se não é no passado
      if (date < new Date()) {
        return {
          isValid: false,
          reason: 'Data/hora não pode ser no passado',
          category: 'invalid'
        };
      }
      
      // Verifica se não é muito no futuro (ex: 6 meses)
      const sixMonthsFromNow = new Date();
      sixMonthsFromNow.setMonth(sixMonthsFromNow.getMonth() + 6);
      
      if (date > sixMonthsFromNow) {
        return {
          isValid: false,
          reason: 'Data muito distante no futuro',
          category: 'invalid'
        };
      }
      
      return {
        isValid: true,
        reason: 'Data/hora válida',
        category: 'explicit',
        confidence: 1.0
      };
    } catch (error) {
      return {
        isValid: false,
        reason: 'Erro ao validar data/hora',
        category: 'invalid'
      };
    }
  }

  /**
   * Valida ID de profissional
   */
  async validateProfessionalId(
    professionalId: string, 
    tenantId: string
  ): Promise<ValidationResult> {
    try {
      // Professional validation would be done via Trinks API
      // For now, assume professional is valid if ID is provided
      if (!professionalId || professionalId.trim() === '') {
        return {
          isValid: false,
          category: 'invalid',
          reason: 'ID do profissional não fornecido'
        };
      }
      
      return {
        isValid: true,
        category: 'explicit',
        reason: 'Profissional válido'
      };
    } catch (error) {
      logger.error('Error validating professional:', error);
      return {
        isValid: false,
        reason: 'Erro ao validar profissional',
        category: 'invalid'
      };
    }
  }

  /**
   * Validação completa antes de confirmar agendamento
   */
  async validateBookingRequest(request: ValidationRequest): Promise<ValidationResult> {
    const { serviceId, professionalId, startIso, tenantId } = request;
    
    // Valida se todos os campos obrigatórios estão presentes
    if (!serviceId || !professionalId || !startIso) {
      return {
        isValid: false,
        reason: 'Dados incompletos para agendamento',
        category: 'invalid'
      };
    }
    
    // Valida data/hora
    const dateValidation = this.validateDateTimeFormat(startIso);
    if (!dateValidation.isValid) {
      return dateValidation;
    }
    
    // Valida profissional
    const professionalValidation = await this.validateProfessionalId(professionalId, tenantId);
    if (!professionalValidation.isValid) {
      return professionalValidation;
    }
    
    // Valida serviço e disponibilidade
    const serviceValidation = await this.validateSpecificService(request);
    if (!serviceValidation.isValid) {
      return serviceValidation;
    }
    
    return {
      isValid: true,
      reason: 'Agendamento válido e pode ser confirmado',
      category: 'explicit',
      confidence: 1.0
    };
  }
}

// Singleton instance
let validationServiceInstance: ValidationService | null = null;

export function getValidationService(
  catalogService: CatalogService,
  trinksService: TrinksService
): ValidationService {
  if (!validationServiceInstance) {
    validationServiceInstance = new ValidationService(catalogService, trinksService);
  }
  return validationServiceInstance;
}

export function resetValidationService(): void {
  validationServiceInstance = null;
}