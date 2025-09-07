import { logger } from '../../../utils/logger';
import { MarlieQualityConfig } from '../types';
import { ContractTestResult, ContractTestSuite, ContractTestStep } from '../types';
import axios from 'axios';
import Joi from 'joi';

// Schemas de contrato para validação
const SCHEMAS = {
  trinks_appointment: Joi.object({
    id: Joi.number().required(),
    status: Joi.object({
      id: Joi.required(),
      nome: Joi.string().required()
    }).required(),
    cliente: Joi.object({
      id: Joi.required(),
      nome: Joi.string().required(),
      telefone: Joi.string().required()
    }).required(),
    servico: Joi.object({
      id: Joi.required(),
      nome: Joi.string().required()
    }).required(),
    profissional: Joi.object({
      id: Joi.required(),
      nome: Joi.string().required()
    }).required(),
    dataHoraInicio: Joi.string().required()
  }),

  trinks_validate_availability: Joi.object({
    ok: Joi.boolean().required(),
    message: Joi.string().optional()
  }),

  evolution_send_message: Joi.object({
    status: Joi.string().valid('SENT', 'QUEUED').required(),
    id: Joi.string().required()
  })
};

// Stubs para testes
class TrinksStub {
  static fetchAppointments(params: { dataInicio: string; dataFim: string }) {
    logger.info('TrinksStub: Simulando fetch de appointments', params);
    
    return {
      items: [
        {
          id: 12345,
          status: { id: 1, nome: 'Confirmado' },
          cliente: { id: 101, nome: 'João Silva', telefone: '5573999887065' },
          servico: { id: 'SVC-001', nome: 'Corte de Cabelo' },
          profissional: { id: 201, nome: 'Maria Santos' },
          dataHoraInicio: '2024-01-15T14:00:00'
        },
        {
          id: 12346,
          status: { id: 1, nome: 'Confirmado' },
          cliente: { id: 102, nome: 'Ana Costa', telefone: '5573999887066' },
          servico: { id: 'SVC-002', nome: 'Manicure' },
          profissional: { id: 202, nome: 'Carla Lima' },
          dataHoraInicio: '2024-01-15T15:30:00'
        }
      ]
    };
  }

  static validateAvailability(params: { service_id: string; start_iso: string }) {
    logger.info('TrinksStub: Simulando validação de disponibilidade', params);
    
    // Simula diferentes cenários baseado no service_id
    if (params.service_id === 'SVC-UNAVAILABLE') {
      return { ok: false, message: 'Horário não disponível' };
    }
    
    return { ok: true, message: 'Horário disponível' };
  }
}

class EvolutionStub {
  static sendMessage(params: { phone: string; text: string }) {
    logger.info('EvolutionStub: Simulando envio de mensagem', params);
    
    return {
      status: 'SENT',
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    };
  }
}

export class ContractTestRunner {
  private config: MarlieQualityConfig;
  private useStubs: boolean;

  constructor(config: MarlieQualityConfig) {
    this.config = config;
    this.useStubs = process.env.USE_TRINKS_STUBS === 'true';
  }

  async runSuite(suiteName: string): Promise<ContractTestResult> {
    const startTime = Date.now();
    logger.info(`Iniciando suite de teste de contrato: ${suiteName}`);

    try {
      const suite = this.config.tests.contract_suites.find(s => s.name === suiteName);
      if (!suite) {
        throw new Error(`Suite de teste não encontrada: ${suiteName}`);
      }

      const stepResults = [];
      const context = {
        env: {
          timezone: this.config.tests.timezone || 'America/Sao_Paulo',
          USE_TRINKS_STUBS: this.useStubs
        },
        slots: {},
        saved_vars: {}
      };

      for (const step of suite.steps) {
        const stepResult = await this.executeStep(step, context);
        stepResults.push(stepResult);
        
        if (!stepResult.success) {
          break;
        }
      }

      const success = stepResults.every(r => r.success);
      const duration = Date.now() - startTime;

      return {
        suite: suiteName,
        success,
        duration,
        steps: stepResults,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      logger.error(`Erro na suite ${suiteName}:`, error);
      return {
        suite: suiteName,
        success: false,
        duration: Date.now() - startTime,
        steps: [],
        error: error instanceof Error ? error.message : 'Erro desconhecido',
        timestamp: new Date().toISOString()
      };
    }
  }

  private async executeStep(step: ContractTestStep, context: any): Promise<any> {
    const stepStart = Date.now();
    
    try {
      if (step.action === 'call_tool') {
        const toolName = this.resolveTemplate(step.with.tool, context);
        const args = this.resolveTemplate(step.with.args, context);
        
        let result;
        
        // Executa tool baseado no nome
        switch (toolName) {
          case 'trinks.stub_fetch_appointments':
            result = TrinksStub.fetchAppointments(args);
            break;
            
          case 'trinks.stub_validate_availability':
            result = TrinksStub.validateAvailability(args);
            break;
            
          case 'evolution.stub_send':
            result = EvolutionStub.sendMessage(args);
            break;
            
          case 'contract.assert_shape':
            result = this.assertShape(args.schema_ref, args.payload);
            break;
            
          case 'trinks.fetch_appointments':
            result = await this.callRealTrinksAPI('fetch_appointments', args);
            break;
            
          case 'trinks.validate_availability':
            result = await this.callRealTrinksAPI('validate_availability', args);
            break;
            
          case 'wa.send_message':
            result = await this.callRealEvolutionAPI('send_message', args);
            break;
            
          default:
            throw new Error(`Tool não reconhecido: ${toolName}`);
        }
        
        // Salva resultado se especificado
        if (step.save_as) {
          context.saved_vars[step.save_as] = result;
        }
        
        return {
          action: step.action,
          success: true,
          duration: Date.now() - stepStart,
          result
        };
        
      } else {
        throw new Error(`Ação não suportada: ${step.action}`);
      }
      
    } catch (error) {
      logger.error('Erro na execução do step:', error);
      return {
        action: step.action,
        success: false,
        duration: Date.now() - stepStart,
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      };
    }
  }

  private assertShape(schemaRef: string, payload: any): { valid: boolean; errors?: string[] } {
    const schema = SCHEMAS[schemaRef as keyof typeof SCHEMAS];
    if (!schema) {
      throw new Error(`Schema não encontrado: ${schemaRef}`);
    }

    const { error } = schema.validate(payload, { abortEarly: false });
    
    if (error) {
      return {
        valid: false,
        errors: error.details.map(d => d.message)
      };
    }

    return { valid: true };
  }

  private async callRealTrinksAPI(endpoint: string, args: any): Promise<any> {
    const baseUrl = this.config.integrations.trinks.base_url;
    const token = this.config.integrations.trinks.token;
    
    const response = await axios({
      method: 'GET',
      url: `${baseUrl}/${endpoint}`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      params: args,
      timeout: this.config.tests.contract.timeout || 10000
    });
    
    return response.data;
  }

  private async callRealEvolutionAPI(endpoint: string, args: any): Promise<any> {
    const baseUrl = this.config.integrations.evolution.base_url;
    const token = this.config.integrations.evolution.token;
    
    const response = await axios({
      method: 'POST',
      url: `${baseUrl}/${endpoint}`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      data: args,
      timeout: this.config.tests.contract.timeout || 10000
    });
    
    return response.data;
  }

  private resolveTemplate(template: any, context: any): any {
    if (typeof template === 'string') {
      // Resolve templates simples como {{env.USE_TRINKS_STUBS}}
      return template.replace(/\{\{([^}]+)\}\}/g, (match, expr) => {
        const parts = expr.trim().split('.');
        let value = context;
        
        for (const part of parts) {
          if (value && typeof value === 'object' && part in value) {
            value = value[part];
          } else {
            return match; // Retorna o template original se não conseguir resolver
          }
        }
        
        return value;
      });
    }
    
    if (typeof template === 'object' && template !== null) {
      const resolved: any = {};
      for (const [key, value] of Object.entries(template)) {
        resolved[key] = this.resolveTemplate(value, context);
      }
      return resolved;
    }
    
    return template;
  }

  async getAllSuites(): Promise<string[]> {
    return this.config.tests.contract_suites.map(suite => suite.name);
  }

  async getHistory(limit: number = 10): Promise<ContractTestResult[]> {
    // Em uma implementação real, isso viria do banco de dados
    // Por agora, retorna array vazio
    return [];
  }

  async cleanup(): Promise<void> {
    logger.info('ContractTestRunner: Limpeza concluída');
  }
}