/**
 * Serviço de Testes de Contrato
 * 
 * Responsável por:
 * - Validar contratos de APIs externas (Trinks, Evolution)
 * - Verificar compatibilidade de schemas
 * - Testar autenticação e autorização
 * - Monitorar mudanças em APIs de terceiros
 */

import { logger } from '../utils/logger';
import { MarlieQualityConfig } from '../modules/marlie-quality';
import axios, { AxiosInstance } from 'axios';
import Ajv, { JSONSchemaType } from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Resultado de um teste de contrato
 */
export interface ContractTestResult {
  api: string;
  endpoint: string;
  success: boolean;
  duration: number;
  tests: Array<{
    name: string;
    success: boolean;
    error?: string;
    details?: any;
  }>;
  schema: {
    valid: boolean;
    errors?: string[];
  };
  authentication: {
    valid: boolean;
    method: string;
    error?: string;
  };
}

/**
 * Resultado completo dos testes de contrato
 */
export interface ContractTestSuite {
  success: boolean;
  coverage: number;
  duration: number;
  apis: {
    trinks: ContractTestResult[];
    evolution: ContractTestResult[];
  };
  summary: {
    totalTests: number;
    passedTests: number;
    failedTests: number;
    apisCovered: number;
    endpointsCovered: number;
  };
}

/**
 * Definição de contrato de API
 */
interface ApiContract {
  name: string;
  baseUrl: string;
  authentication: {
    type: 'bearer' | 'basic' | 'apikey' | 'oauth2';
    credentials: Record<string, string>;
  };
  endpoints: Array<{
    path: string;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    description: string;
    requestSchema?: any;
    responseSchema: any;
    headers?: Record<string, string>;
    testCases: Array<{
      name: string;
      input?: any;
      expectedStatus: number;
      expectedResponse?: any;
    }>;
  }>;
}

/**
 * Serviço de Testes de Contrato
 */
export class ContractTestRunner {
  private config: MarlieQualityConfig;
  private ajv: Ajv;
  private trinksClient: AxiosInstance;
  private evolutionClient: AxiosInstance;
  private contracts: Map<string, ApiContract> = new Map();
  private isInitialized: boolean = false;

  constructor(config: MarlieQualityConfig) {
    this.config = config;
    
    // Configurar validador de schema
    this.ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(this.ajv);

    // Configurar clientes HTTP
    this.trinksClient = axios.create({
      baseURL: config.integrations.trinks.base_url,
      timeout: config.tests.contract.timeout,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    this.evolutionClient = axios.create({
      baseURL: config.integrations.evolution.base_url,
      timeout: config.tests.contract.timeout,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Inicializa o runner de testes de contrato
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      logger.info('Initializing ContractTestRunner...');

      // Carregar contratos das APIs
      await this.loadApiContracts();

      // Configurar interceptors
      this.setupHttpInterceptors();

      this.isInitialized = true;
      logger.info('ContractTestRunner initialized successfully');

    } catch (error) {
      logger.error('Failed to initialize ContractTestRunner:', error);
      throw error;
    }
  }

  /**
   * Executa todos os testes de contrato
   */
  async runAllTests(): Promise<ContractTestSuite> {
    if (!this.isInitialized) {
      throw new Error('ContractTestRunner must be initialized before running tests');
    }

    const startTime = Date.now();
    logger.info('Starting contract tests...');

    try {
      const trinksResults = await this.testApiContract('trinks');
      const evolutionResults = await this.testApiContract('evolution');

      const allResults = [...trinksResults, ...evolutionResults];
      const passedTests = allResults.filter(r => r.success).length;
      const failedTests = allResults.filter(r => !r.success).length;
      
      const duration = Date.now() - startTime;
      const coverage = this.calculateCoverage(allResults);

      const suite: ContractTestSuite = {
        success: failedTests === 0,
        coverage,
        duration,
        apis: {
          trinks: trinksResults,
          evolution: evolutionResults
        },
        summary: {
          totalTests: allResults.length,
          passedTests,
          failedTests,
          apisCovered: 2,
          endpointsCovered: allResults.length
        }
      };

      logger.info('Contract tests completed', {
        success: suite.success,
        duration,
        coverage,
        summary: suite.summary
      });

      return suite;

    } catch (error) {
      logger.error('Contract tests failed:', error);
      throw error;
    }
  }

  /**
   * Testa contrato de uma API específica
   */
  private async testApiContract(apiName: string): Promise<ContractTestResult[]> {
    const contract = this.contracts.get(apiName);
    if (!contract) {
      throw new Error(`Contract not found for API: ${apiName}`);
    }

    logger.info(`Testing contract for ${apiName} API`);
    const results: ContractTestResult[] = [];

    for (const endpoint of contract.endpoints) {
      const result = await this.testEndpoint(contract, endpoint);
      results.push(result);
    }

    return results;
  }

  /**
   * Testa um endpoint específico
   */
  private async testEndpoint(
    contract: ApiContract, 
    endpoint: ApiContract['endpoints'][0]
  ): Promise<ContractTestResult> {
    const startTime = Date.now();
    logger.debug(`Testing endpoint: ${endpoint.method} ${endpoint.path}`);

    const result: ContractTestResult = {
      api: contract.name,
      endpoint: `${endpoint.method} ${endpoint.path}`,
      success: false,
      duration: 0,
      tests: [],
      schema: { valid: false },
      authentication: { valid: false, method: contract.authentication.type }
    };

    try {
      // Testar autenticação
      const authResult = await this.testAuthentication(contract);
      result.authentication = authResult;

      if (!authResult.valid) {
        result.duration = Date.now() - startTime;
        return result;
      }

      // Executar casos de teste
      for (const testCase of endpoint.testCases) {
        const testResult = await this.executeTestCase(
          contract, 
          endpoint, 
          testCase
        );
        result.tests.push(testResult);
      }

      // Validar schema da resposta
      const schemaResult = await this.validateResponseSchema(
        contract,
        endpoint
      );
      result.schema = schemaResult;

      // Determinar sucesso geral
      result.success = result.authentication.valid && 
                      result.schema.valid && 
                      result.tests.every(t => t.success);

    } catch (error) {
      logger.error(`Endpoint test failed: ${endpoint.path}`, error);
      result.tests.push({
        name: 'endpoint_execution',
        success: false,
        error: (error as Error).message
      });
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  /**
   * Testa autenticação da API
   */
  private async testAuthentication(contract: ApiContract): Promise<{
    valid: boolean;
    method: string;
    error?: string;
  }> {
    try {
      const client = this.getClientForApi(contract.name);
      
      switch (contract.authentication.type) {
        case 'bearer':
          client.defaults.headers.common['Authorization'] = 
            `Bearer ${contract.authentication.credentials.token}`;
          break;
          
        case 'basic':
          const basicAuth = Buffer.from(
            `${contract.authentication.credentials.username}:${contract.authentication.credentials.password}`
          ).toString('base64');
          client.defaults.headers.common['Authorization'] = `Basic ${basicAuth}`;
          break;
          
        case 'apikey':
          client.defaults.headers.common[contract.authentication.credentials.headerName] = 
            contract.authentication.credentials.apiKey;
          break;
          
        case 'oauth2':
          // Implementar OAuth2 se necessário
          throw new Error('OAuth2 authentication not implemented');
      }

      // Testar endpoint de autenticação ou health check
      await client.get('/health');
      
      return {
        valid: true,
        method: contract.authentication.type
      };

    } catch (error) {
      return {
        valid: false,
        method: contract.authentication.type,
        error: (error as Error).message
      };
    }
  }

  /**
   * Executa um caso de teste
   */
  private async executeTestCase(
    contract: ApiContract,
    endpoint: ApiContract['endpoints'][0],
    testCase: ApiContract['endpoints'][0]['testCases'][0]
  ): Promise<{
    name: string;
    success: boolean;
    error?: string;
    details?: any;
  }> {
    try {
      const client = this.getClientForApi(contract.name);
      
      let response;
      switch (endpoint.method) {
        case 'GET':
          response = await client.get(endpoint.path);
          break;
        case 'POST':
          response = await client.post(endpoint.path, testCase.input);
          break;
        case 'PUT':
          response = await client.put(endpoint.path, testCase.input);
          break;
        case 'PATCH':
          response = await client.patch(endpoint.path, testCase.input);
          break;
        case 'DELETE':
          response = await client.delete(endpoint.path);
          break;
        default:
          throw new Error(`Unsupported HTTP method: ${endpoint.method}`);
      }

      // Verificar status esperado
      if (response.status !== testCase.expectedStatus) {
        return {
          name: testCase.name,
          success: false,
          error: `Expected status ${testCase.expectedStatus}, got ${response.status}`,
          details: { actualStatus: response.status, expectedStatus: testCase.expectedStatus }
        };
      }

      // Verificar resposta esperada se fornecida
      if (testCase.expectedResponse) {
        const responseMatches = this.compareResponses(
          response.data, 
          testCase.expectedResponse
        );
        
        if (!responseMatches) {
          return {
            name: testCase.name,
            success: false,
            error: 'Response does not match expected format',
            details: { 
              actual: response.data, 
              expected: testCase.expectedResponse 
            }
          };
        }
      }

      return {
        name: testCase.name,
        success: true,
        details: {
          status: response.status,
          responseTime: response.headers['x-response-time'] || 'unknown'
        }
      };

    } catch (error: any) {
      return {
        name: testCase.name,
        success: false,
        error: error.message || 'Erro desconhecido',
        details: {
          status: error.response?.status,
          data: error.response?.data
        }
      };
    }
  }

  /**
   * Valida schema da resposta
   */
  private async validateResponseSchema(
    contract: ApiContract,
    endpoint: ApiContract['endpoints'][0]
  ): Promise<{ valid: boolean; errors?: string[] }> {
    try {
      const client = this.getClientForApi(contract.name);
      
      // Fazer uma requisição de exemplo
      let response;
      try {
        response = await client.get(endpoint.path);
      } catch (error) {
        // Se GET falhar, tentar com dados de exemplo
        if (endpoint.method === 'POST' && endpoint.testCases.length > 0) {
          response = await client.post(endpoint.path, endpoint.testCases[0].input);
        } else {
          throw error;
        }
      }

      // Validar contra schema
      const validate = this.ajv.compile(endpoint.responseSchema);
      const valid = validate(response.data);

      if (!valid) {
        const errors = validate.errors?.map((err: any) => 
          `${err.instancePath} ${err.message}`
        ) || ['Unknown schema validation error'];
        
        return { valid: false, errors };
      }

      return { valid: true };

    } catch (error) {
      return {
        valid: false,
        errors: [`Schema validation failed: ${(error as Error).message}`]
      };
    }
  }

  /**
   * Carrega contratos das APIs
   */
  private async loadApiContracts(): Promise<void> {
    // Contrato da API Trinks
    const trinksContract: ApiContract = {
      name: 'trinks',
      baseUrl: this.config.integrations.trinks.base_url,
      authentication: {
        type: 'bearer',
        credentials: {
          token: process.env.TRINKS_API_TOKEN || 'test-token'
        }
      },
      endpoints: [
        {
          path: '/health',
          method: 'GET',
          description: 'Health check endpoint',
          responseSchema: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              timestamp: { type: 'string' }
            },
            required: ['status']
          },
          testCases: [
            {
              name: 'health_check',
              expectedStatus: 200
            }
          ]
        },
        {
          path: '/bookings',
          method: 'POST',
          description: 'Create booking',
          requestSchema: {
            type: 'object',
            properties: {
              clientName: { type: 'string' },
              clientPhone: { type: 'string' },
              service: { type: 'string' },
              date: { type: 'string', format: 'date-time' }
            },
            required: ['clientName', 'clientPhone', 'service', 'date']
          },
          responseSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string' },
              createdAt: { type: 'string', format: 'date-time' }
            },
            required: ['id', 'status']
          },
          testCases: [
            {
              name: 'create_booking',
              input: {
                clientName: 'Test Client',
                clientPhone: '+5571999999999',
                service: 'Corte de Cabelo',
                date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
              },
              expectedStatus: 201
            }
          ]
        }
      ]
    };

    // Contrato da API Evolution
    const evolutionContract: ApiContract = {
      name: 'evolution',
      baseUrl: this.config.integrations.evolution.base_url,
      authentication: {
        type: 'apikey',
        credentials: {
          headerName: 'X-API-Key',
          apiKey: process.env.EVOLUTION_API_KEY || 'test-key'
        }
      },
      endpoints: [
        {
          path: '/instance/status',
          method: 'GET',
          description: 'Get instance status',
          responseSchema: {
            type: 'object',
            properties: {
              instance: { type: 'string' },
              status: { type: 'string' },
              qrcode: { type: 'string' }
            },
            required: ['instance', 'status']
          },
          testCases: [
            {
              name: 'instance_status',
              expectedStatus: 200
            }
          ]
        },
        {
          path: '/message/sendText',
          method: 'POST',
          description: 'Send text message',
          requestSchema: {
            type: 'object',
            properties: {
              number: { type: 'string' },
              text: { type: 'string' }
            },
            required: ['number', 'text']
          },
          responseSchema: {
            type: 'object',
            properties: {
              messageId: { type: 'string' },
              status: { type: 'string' }
            },
            required: ['messageId', 'status']
          },
          testCases: [
            {
              name: 'send_text_message',
              input: {
                number: '+5571999999999',
                text: 'Test message from contract test'
              },
              expectedStatus: 200
            }
          ]
        }
      ]
    };

    this.contracts.set('trinks', trinksContract);
    this.contracts.set('evolution', evolutionContract);

    logger.info('API contracts loaded', {
      apis: Array.from(this.contracts.keys()),
      endpoints: Array.from(this.contracts.values())
        .reduce((sum, contract) => sum + contract.endpoints.length, 0)
    });
  }

  /**
   * Métodos auxiliares
   */
  private getClientForApi(apiName: string): AxiosInstance {
    switch (apiName) {
      case 'trinks':
        return this.trinksClient;
      case 'evolution':
        return this.evolutionClient;
      default:
        throw new Error(`Unknown API: ${apiName}`);
    }
  }

  private compareResponses(actual: any, expected: any): boolean {
    // Implementação simples de comparação
    // Em produção, usar biblioteca como deep-equal
    try {
      return JSON.stringify(actual) === JSON.stringify(expected);
    } catch {
      return false;
    }
  }

  private calculateCoverage(results: ContractTestResult[]): number {
    if (results.length === 0) return 0;
    
    const totalEndpoints = Array.from(this.contracts.values())
      .reduce((sum, contract) => sum + contract.endpoints.length, 0);
    
    return Math.round((results.length / totalEndpoints) * 100);
  }

  private setupHttpInterceptors(): void {
    [this.trinksClient, this.evolutionClient].forEach(client => {
      client.interceptors.request.use(
        (config) => {
          logger.debug(`Contract Test Request: ${config.method?.toUpperCase()} ${config.url}`);
          return config;
        },
        (error) => {
          logger.error('Contract Test Request Error:', error);
          return Promise.reject(error);
        }
      );

      client.interceptors.response.use(
        (response) => {
          logger.debug(`Contract Test Response: ${response.status} ${response.config.url}`);
          return response;
        },
        (error) => {
          logger.debug(`Contract Test Response Error: ${error.response?.status} ${error.config?.url}`);
          return Promise.reject(error);
        }
      );
    });
  }

  /**
   * Finaliza o runner
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down ContractTestRunner...');
    this.contracts.clear();
    this.isInitialized = false;
    logger.info('ContractTestRunner shutdown completed');
  }
}

// Interfaces já exportadas no início do arquivo