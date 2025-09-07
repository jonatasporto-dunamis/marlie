/**
 * Padrões NLP para o agente roteador Marlie
 * Implementa detecção de intenções baseada em regex conforme especificação P0
 */

export interface NLPMatch {
  pattern: string;
  confidence: number;
  matchedText: string;
}

export interface NLPResult {
  intent: 'option_1' | 'option_2' | 'explicit_schedule' | 'ambiguous_schedule' | 'stop' | 'unknown';
  confidence: number;
  matches: NLPMatch[];
  originalText: string;
}

export class NLPPatterns {
  private patterns = {
    // Opção 1: Agendar atendimento
    option_1: [
      /^\s*1\s*$/,
      /\b(op[cç][aã]o\s*1|um|1\.|n[uú]mero\s*1)\b/i,
      /\bquero\s*(agendar|marcar)\b/i,
      /\bmarcar\s*(hor[aá]rio|atendimento)\b/i
    ],
    
    // Opção 2: Informações
    option_2: [
      /^\s*2\s*$/,
      /\b(op[cç][aã]o\s*2|dois|2\.|n[uú]mero\s*2)\b/i,
      /\b(quero|preciso)\s*(de )?informa(c|ç)[aã]o(e?s)?\b/i
    ],
    
    // Agendamento explícito (inequívoco)
    explicit_schedule: [
      /\b(quero\s*agendar|agendar\s*atendimento|marcar\s*agora)\b/i,
      /\b(preciso\s*marcar|vou\s*agendar|quero\s*marcar\s*hor[aá]rio)\b/i,
      /\b(agendar\s*para|marcar\s*para\s*(hoje|amanh[aã]|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo))\b/i
    ],
    
    // Agendamento ambíguo (requer confirmação)
    ambiguous_schedule: [
      /\bagenda(r)?\b/i,
      /\bver\s*agenda\b/i,
      /\bhor[áa]rios?\b/i,
      /\b(quando|que\s*horas?)\b/i,
      /\b(dispon[ií]vel|vaga)\b/i
    ],
    
    // Stop words (cancelar/encerrar)
    stop_words: [
      /\bcancelar\s*atendimento\b/i,
      /\bencerrar\b/i,
      /\b(parar|sair|tchau|obrigad[oa])\b/i,
      /\b(n[aã]o\s*quero|desistir)\b/i
    ]
  };

  /**
   * Analisa o texto e retorna a intenção detectada
   */
  analyze(text: string): NLPResult {
    const normalizedText = this.normalizeText(text);
    const allMatches: NLPMatch[] = [];
    
    // Verifica stop words primeiro (prioridade alta)
    const stopMatches = this.findMatches(normalizedText, this.patterns.stop_words, 'stop');
    if (stopMatches.length > 0) {
      return {
        intent: 'stop',
        confidence: 0.95,
        matches: stopMatches,
        originalText: text
      };
    }

    // Verifica opções específicas do menu
    const option1Matches = this.findMatches(normalizedText, this.patterns.option_1, 'option_1');
    const option2Matches = this.findMatches(normalizedText, this.patterns.option_2, 'option_2');
    
    // Se encontrou opção específica, retorna com alta confiança
    if (option1Matches.length > 0) {
      return {
        intent: 'option_1',
        confidence: 0.9,
        matches: option1Matches,
        originalText: text
      };
    }
    
    if (option2Matches.length > 0) {
      return {
        intent: 'option_2',
        confidence: 0.9,
        matches: option2Matches,
        originalText: text
      };
    }

    // Verifica agendamento explícito
    const explicitMatches = this.findMatches(normalizedText, this.patterns.explicit_schedule, 'explicit_schedule');
    if (explicitMatches.length > 0) {
      return {
        intent: 'explicit_schedule',
        confidence: 0.85,
        matches: explicitMatches,
        originalText: text
      };
    }

    // Verifica agendamento ambíguo
    const ambiguousMatches = this.findMatches(normalizedText, this.patterns.ambiguous_schedule, 'ambiguous_schedule');
    if (ambiguousMatches.length > 0) {
      return {
        intent: 'ambiguous_schedule',
        confidence: 0.6,
        matches: ambiguousMatches,
        originalText: text
      };
    }

    // Nenhum padrão encontrado
    return {
      intent: 'unknown',
      confidence: 0.0,
      matches: [],
      originalText: text
    };
  }

  /**
   * Encontra matches para um conjunto de padrões
   */
  private findMatches(text: string, patterns: RegExp[], patternType: string): NLPMatch[] {
    const matches: NLPMatch[] = [];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        matches.push({
          pattern: pattern.source,
          confidence: this.calculateConfidence(match, text, patternType),
          matchedText: match[0]
        });
      }
    }
    
    return matches;
  }

  /**
   * Calcula confiança baseada no match
   */
  private calculateConfidence(match: RegExpMatchArray, text: string, patternType: string): number {
    const matchLength = match[0].length;
    const textLength = text.length;
    const coverage = matchLength / textLength;
    
    // Ajusta confiança baseada no tipo de padrão
    let baseConfidence = 0.7;
    
    switch (patternType) {
      case 'option_1':
      case 'option_2':
        baseConfidence = 0.9; // Opções específicas têm alta confiança
        break;
      case 'explicit_schedule':
        baseConfidence = 0.85;
        break;
      case 'ambiguous_schedule':
        baseConfidence = 0.6;
        break;
      case 'stop':
        baseConfidence = 0.95;
        break;
    }
    
    // Aumenta confiança se o match cobre boa parte do texto
    if (coverage > 0.5) {
      baseConfidence += 0.1;
    }
    
    return Math.min(baseConfidence, 1.0);
  }

  /**
   * Normaliza texto para análise
   */
  private normalizeText(text: string): string {
    return text
      .toLowerCase()
      .trim()
      // Remove emojis e caracteres especiais, mantém acentos
      .replace(/[^\w\sáàâãéèêíìîóòôõúùûçñ]/g, ' ')
      // Remove espaços múltiplos
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Verifica se o texto é uma resposta válida para o menu (1 ou 2)
   */
  isValidMenuOption(text: string): '1' | '2' | null {
    const result = this.analyze(text);
    
    if (result.intent === 'option_1' && result.confidence >= 0.8) {
      return '1';
    }
    
    if (result.intent === 'option_2' && result.confidence >= 0.8) {
      return '2';
    }
    
    return null;
  }

  /**
   * Verifica se o texto indica intenção de agendamento (explícito ou ambíguo)
   */
  hasSchedulingIntent(text: string): { hasIntent: boolean; isExplicit: boolean; confidence: number } {
    const result = this.analyze(text);
    
    if (result.intent === 'explicit_schedule') {
      return {
        hasIntent: true,
        isExplicit: true,
        confidence: result.confidence
      };
    }
    
    if (result.intent === 'ambiguous_schedule') {
      return {
        hasIntent: true,
        isExplicit: false,
        confidence: result.confidence
      };
    }
    
    return {
      hasIntent: false,
      isExplicit: false,
      confidence: 0
    };
  }

  /**
   * Verifica se o texto indica parada/cancelamento
   */
  isStopIntent(text: string): boolean {
    const result = this.analyze(text);
    return result.intent === 'stop' && result.confidence >= 0.8;
  }

  /**
   * Adiciona novos padrões dinamicamente
   */
  addPattern(category: keyof typeof this.patterns, pattern: RegExp): void {
    if (this.patterns[category]) {
      this.patterns[category].push(pattern);
    }
  }

  /**
   * Remove padrão específico
   */
  removePattern(category: keyof typeof this.patterns, patternSource: string): boolean {
    if (this.patterns[category]) {
      const index = this.patterns[category].findIndex(p => p.source === patternSource);
      if (index !== -1) {
        this.patterns[category].splice(index, 1);
        return true;
      }
    }
    return false;
  }

  /**
   * Lista todos os padrões de uma categoria
   */
  getPatterns(category: keyof typeof this.patterns): string[] {
    return this.patterns[category]?.map(p => p.source) || [];
  }
}

// Singleton instance
let nlpPatternsInstance: NLPPatterns | null = null;

export function getNLPPatterns(): NLPPatterns {
  if (!nlpPatternsInstance) {
    nlpPatternsInstance = new NLPPatterns();
  }
  return nlpPatternsInstance;
}

export function resetNLPPatterns(): void {
  nlpPatternsInstance = null;
}