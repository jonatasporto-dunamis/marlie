import { logger } from '../../../utils/logger';
import { httpGetJson, httpPostJson } from './http-tools';
import { injectMockMessage, waitMs, getConversationState, validateResponseContains, validateState } from './router-tools';

interface TestStep {
  action?: string;
  with?: any;
  expect_reply_contains?: string[];
  expect_state?: string;
  save_as?: string;
  assert?: {
    expr?: string;
    any_of?: Array<{ expr: string }>;
  };
}

interface TestSuite {
  name: string;
  steps: TestStep[];
}

interface TestResult {
  success: boolean;
  suite: string;
  steps_passed: number;
  steps_failed: number;
  total_steps: number;
  duration_ms: number;
  errors: string[];
  variables: Record<string, any>;
}

export class TestExecutor {
  private variables: Record<string, any> = {};
  private errors: string[] = [];

  async executeSuite(suite: TestSuite, env: Record<string, string>): Promise<TestResult> {
    const startTime = Date.now();
    let stepsPassed = 0;
    let stepsFailed = 0;

    logger.info(`🧪 Executando suite: ${suite.name}`);

    for (let i = 0; i < suite.steps.length; i++) {
      const step = suite.steps[i];
      const stepNumber = i + 1;

      try {
        logger.debug(`📋 Step ${stepNumber}/${suite.steps.length}:`, step);

        const success = await this.executeStep(step, env);

        if (success) {
          stepsPassed++;
          logger.debug(`✅ Step ${stepNumber} passou`);
        } else {
          stepsFailed++;
          logger.error(`❌ Step ${stepNumber} falhou`);
        }

      } catch (error) {
        stepsFailed++;
        const errorMsg = `Step ${stepNumber} erro: ${error.message}`;
        this.errors.push(errorMsg);
        logger.error(`💥 ${errorMsg}`);
      }
    }

    const duration = Date.now() - startTime;
    const success = stepsFailed === 0;

    logger.info(`📊 Suite ${suite.name}: ${stepsPassed}/${suite.steps.length} steps passaram em ${duration}ms`);

    return {
      success,
      suite: suite.name,
      steps_passed: stepsPassed,
      steps_failed: stepsFailed,
      total_steps: suite.steps.length,
      duration_ms: duration,
      errors: this.errors,
      variables: this.variables
    };
  }

  private async executeStep(step: TestStep, env: Record<string, string>): Promise<boolean> {
    // Executar ação
    if (step.action) {
      const actionResult = await this.executeAction(step.action, step.with, env);
      
      if (step.save_as && actionResult.data) {
        this.variables[step.save_as] = actionResult.data;
        logger.debug(`💾 Salvou resultado em variável: ${step.save_as}`);
      }
      
      if (!actionResult.success) {
        this.errors.push(`Ação ${step.action} falhou: ${actionResult.error}`);
        return false;
      }
    }

    // Validar resposta contém textos esperados
    if (step.expect_reply_contains) {
      const lastResponse = this.getLastResponse();
      if (!lastResponse) {
        this.errors.push('Nenhuma resposta disponível para validação');
        return false;
      }

      const validation = validateResponseContains(lastResponse, step.expect_reply_contains);
      if (!validation.success) {
        this.errors.push(`Resposta não contém textos esperados: ${validation.missing.join(', ')}`);
        return false;
      }
    }

    // Validar estado esperado
    if (step.expect_state) {
      const currentState = await this.getCurrentState();
      if (!validateState(currentState, step.expect_state)) {
        this.errors.push(`Estado esperado: ${step.expect_state}, atual: ${currentState}`);
        return false;
      }
    }

    // Executar assertions
    if (step.assert) {
      const assertResult = await this.executeAssert(step.assert);
      if (!assertResult) {
        this.errors.push('Assertion falhou');
        return false;
      }
    }

    return true;
  }

  private async executeAction(action: string, params: any, env: Record<string, string>): Promise<{
    success: boolean;
    data?: any;
    error?: string;
  }> {
    const resolvedParams = this.resolveVariables(params, env);

    switch (action) {
      case 'http.get_json':
        return await httpGetJson(resolvedParams);

      case 'http.post_json':
        return await httpPostJson(resolvedParams);

      case 'router.inject_mock_message':
        const result = await injectMockMessage(resolvedParams);
        // Salvar última resposta para validações
        if (result.response?.text) {
          this.variables['_last_response'] = result.response.text;
        }
        if (result.response?.state) {
          this.variables['_current_state'] = result.response.state;
        }
        return {
          success: result.success,
          data: result.response,
          error: result.error
        };

      case 'qa.wait':
        const waitResult = await waitMs(resolvedParams.ms);
        return {
          success: waitResult.success
        };

      default:
        return {
          success: false,
          error: `Ação desconhecida: ${action}`
        };
    }
  }

  private async executeAssert(assert: any): Promise<boolean> {
    if (assert.expr) {
      return this.evaluateExpression(assert.expr);
    }

    if (assert.any_of) {
      for (const condition of assert.any_of) {
        if (this.evaluateExpression(condition.expr)) {
          return true;
        }
      }
      return false;
    }

    return false;
  }

  private evaluateExpression(expr: string): boolean {
    try {
      // Substituir variáveis na expressão
      let resolved = expr;
      
      // Substituir referências a variáveis salvas
      for (const [key, value] of Object.entries(this.variables)) {
        const pattern = new RegExp(`\\b${key}\\b`, 'g');
        resolved = resolved.replace(pattern, JSON.stringify(value));
      }
      
      // Substituir funções especiais
      resolved = resolved.replace(/len\(([^)]+)\)/g, (match, varName) => {
        const cleanVarName = varName.trim();
        const value = this.variables[cleanVarName];
        if (Array.isArray(value)) {
          return value.length.toString();
        }
        return '0';
      });
      
      // Avaliar expressão simples (apenas comparações básicas por segurança)
      const result = this.safeEvaluate(resolved);
      
      logger.debug(`🔍 Expressão: ${expr} -> ${resolved} = ${result}`);
      
      return Boolean(result);
      
    } catch (error) {
      logger.error(`❌ Erro ao avaliar expressão: ${expr}`, error);
      return false;
    }
  }

  private safeEvaluate(expr: string): boolean {
    // Implementação segura de avaliação de expressões
    // Apenas operações básicas permitidas
    
    // Comparações de igualdade
    if (expr.includes(' == ')) {
      const [left, right] = expr.split(' == ').map(s => s.trim());
      return this.parseValue(left) === this.parseValue(right);
    }
    
    // Comparações de desigualdade
    if (expr.includes(' != ')) {
      const [left, right] = expr.split(' != ').map(s => s.trim());
      return this.parseValue(left) !== this.parseValue(right);
    }
    
    // Comparações numéricas
    if (expr.includes(' > ')) {
      const [left, right] = expr.split(' > ').map(s => s.trim());
      return Number(this.parseValue(left)) > Number(this.parseValue(right));
    }
    
    if (expr.includes(' < ')) {
      const [left, right] = expr.split(' < ').map(s => s.trim());
      return Number(this.parseValue(left)) < Number(this.parseValue(right));
    }
    
    // Valor booleano direto
    const value = this.parseValue(expr);
    return Boolean(value);
  }

  private parseValue(value: string): any {
    // Remove aspas
    if ((value.startsWith('"') && value.endsWith('"')) || 
        (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    
    // Números
    if (/^\d+(\.\d+)?$/.test(value)) {
      return Number(value);
    }
    
    // Booleanos
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    
    // JSON
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private resolveVariables(obj: any, env: Record<string, string>): any {
    if (typeof obj === 'string') {
      let resolved = obj;
      
      // Substituir variáveis de ambiente
      resolved = resolved.replace(/\{\{env\.([^}]+)\}\}/g, (match, envVar) => {
        return env[envVar] || process.env[envVar] || match;
      });
      
      // Substituir funções especiais
      resolved = resolved.replace(/\{\{today_local_date\(([^)]+)\)\}\}/g, (match, timezone) => {
        const now = new Date();
        return now.toLocaleDateString('pt-BR', { 
          timeZone: timezone.replace(/["']/g, ''),
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        });
      });
      
      return resolved;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.resolveVariables(item, env));
    }
    
    if (obj && typeof obj === 'object') {
      const resolved: any = {};
      for (const [key, value] of Object.entries(obj)) {
        resolved[key] = this.resolveVariables(value, env);
      }
      return resolved;
    }
    
    return obj;
  }

  private getLastResponse(): string | null {
    return this.variables['_last_response'] || null;
  }

  private async getCurrentState(): Promise<string> {
    return this.variables['_current_state'] || 'UNKNOWN';
  }

  public getVariables(): Record<string, any> {
    return { ...this.variables };
  }

  public getErrors(): string[] {
    return [...this.errors];
  }
}