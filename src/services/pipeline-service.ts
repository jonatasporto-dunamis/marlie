/**
 * Serviço de Pipeline CI/CD
 * 
 * Responsável por:
 * - Executar pipeline de build, lint, testes, scan e deploy
 * - Gerenciar versionamento e rollback
 * - Monitorar saúde do deploy
 * - Integrar com ferramentas de CI/CD
 */

import { logger } from '../utils/logger';
import { MarlieQualityConfig } from '../modules/marlie-quality';
import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

/**
 * Estágios do pipeline
 */
export type PipelineStage = 
  | 'build'
  | 'lint'
  | 'test'
  | 'scan'
  | 'deploy'
  | 'rollback';

/**
 * Status de execução
 */
export type ExecutionStatus = 
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled';

/**
 * Resultado de execução de um estágio
 */
export interface StageResult {
  stage: PipelineStage;
  status: ExecutionStatus;
  duration: number;
  output: string[];
  errors: string[];
  exitCode?: number;
  artifacts?: string[];
  metrics?: Record<string, any>;
}

/**
 * Resultado completo do pipeline
 */
export interface PipelineResult {
  success: boolean;
  duration: number;
  version?: string;
  stages: StageResult[];
  summary: {
    totalStages: number;
    successfulStages: number;
    failedStages: number;
    skippedStages: number;
  };
  deployment?: {
    environment: string;
    url?: string;
    healthCheck: boolean;
  };
}

/**
 * Configuração de deploy
 */
export interface DeployConfig {
  environment: 'staging' | 'production';
  strategy: 'rolling' | 'blue-green' | 'canary';
  healthCheckUrl?: string;
  healthCheckTimeout: number;
  rollbackOnFailure: boolean;
}

/**
 * Serviço de Pipeline CI/CD
 */
export class PipelineService extends EventEmitter {
  private config: MarlieQualityConfig;
  private currentExecution: Map<string, ChildProcess> = new Map();
  private deployHistory: Array<{
    version: string;
    timestamp: Date;
    environment: string;
    success: boolean;
  }> = [];
  private isInitialized: boolean = false;

  constructor(config: MarlieQualityConfig) {
    super();
    this.config = config;
  }

  /**
   * Inicializa o serviço de pipeline
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      logger.info('Initializing PipelineService...');

      // Verificar ferramentas necessárias
      await this.verifyTools();

      // Carregar histórico de deploy
      await this.loadDeployHistory();

      this.isInitialized = true;
      logger.info('PipelineService initialized successfully');

    } catch (error) {
      logger.error('Failed to initialize PipelineService:', error);
      throw error;
    }
  }

  /**
   * Executa o pipeline completo
   */
  async runFullPipeline(deployConfig?: DeployConfig): Promise<PipelineResult> {
    if (!this.isInitialized) {
      throw new Error('PipelineService must be initialized before running pipeline');
    }

    const startTime = Date.now();
    const executionId = `pipeline-${Date.now()}`;
    
    logger.info(`Starting full pipeline execution: ${executionId}`);
    this.emit('pipeline_started', { executionId });

    const stages: PipelineStage[] = ['build', 'lint', 'test', 'scan'];
    if (deployConfig) {
      stages.push('deploy');
    }

    const stageResults: StageResult[] = [];
    let pipelineSuccess = true;

    try {
      for (const stage of stages) {
        logger.info(`Executing pipeline stage: ${stage}`);
        
        const stageResult = await this.executeStage(stage, executionId, deployConfig);
        stageResults.push(stageResult);
        
        this.emit('stage_completed', { executionId, stage, result: stageResult });

        if (stageResult.status === 'failed') {
          pipelineSuccess = false;
          logger.error(`Pipeline stage ${stage} failed, stopping execution`);
          break;
        }
      }

      // Se deploy falhou e rollback está habilitado
      if (!pipelineSuccess && deployConfig?.rollbackOnFailure && 
          stageResults.some(s => s.stage === 'deploy' && s.status === 'failed')) {
        logger.info('Deploy failed, initiating rollback...');
        const rollbackResult = await this.executeStage('rollback', executionId);
        stageResults.push(rollbackResult);
      }

    } catch (error) {
      logger.error('Pipeline execution failed:', error);
      pipelineSuccess = false;
    }

    const duration = Date.now() - startTime;
    const successfulStages = stageResults.filter(s => s.status === 'success').length;
    const failedStages = stageResults.filter(s => s.status === 'failed').length;
    const skippedStages = stages.length - stageResults.length;

    const result: PipelineResult = {
      success: pipelineSuccess,
      duration,
      stages: stageResults,
      summary: {
        totalStages: stages.length,
        successfulStages,
        failedStages,
        skippedStages
      }
    };

    // Adicionar informações de deploy se aplicável
    const deployStage = stageResults.find(s => s.stage === 'deploy');
    if (deployStage && deployConfig) {
      result.deployment = {
        environment: deployConfig.environment,
        url: deployStage.metrics?.deployUrl,
        healthCheck: deployStage.metrics?.healthCheck || false
      };
      
      if (deployStage.status === 'success') {
        result.version = deployStage.metrics?.version;
      }
    }

    logger.info(`Pipeline execution completed: ${executionId}`, {
      success: pipelineSuccess,
      duration,
      summary: result.summary
    });

    this.emit('pipeline_completed', { executionId, result });
    return result;
  }

  /**
   * Executa um estágio específico
   */
  async executeStage(
    stage: PipelineStage, 
    executionId: string, 
    deployConfig?: DeployConfig
  ): Promise<StageResult> {
    const startTime = Date.now();
    
    logger.info(`Starting stage: ${stage}`);
    this.emit('stage_started', { executionId, stage });

    const result: StageResult = {
      stage,
      status: 'running',
      duration: 0,
      output: [],
      errors: []
    };

    try {
      switch (stage) {
        case 'build':
          await this.executeBuild(result);
          break;
        case 'lint':
          await this.executeLint(result);
          break;
        case 'test':
          await this.executeTest(result);
          break;
        case 'scan':
          await this.executeScan(result);
          break;
        case 'deploy':
          await this.executeDeploy(result, deployConfig);
          break;
        case 'rollback':
          await this.executeRollback(result);
          break;
        default:
          throw new Error(`Unknown pipeline stage: ${stage}`);
      }

      result.status = 'success';
      logger.info(`Stage ${stage} completed successfully`);

    } catch (error) {
      result.status = 'failed';
      result.errors.push((error as Error).message);
      logger.error(`Stage ${stage} failed:`, error);
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  /**
   * Executa build
   */
  private async executeBuild(result: StageResult): Promise<void> {
    const command = 'npm run build';
    const { output, errors, exitCode } = await this.runCommand(command);
    
    result.output = output;
    result.errors = errors;
    result.exitCode = exitCode;
    
    if (exitCode !== 0) {
      throw new Error(`Build failed with exit code ${exitCode}`);
    }

    // Verificar se artefatos foram gerados
    const buildDir = path.join(process.cwd(), 'dist');
    try {
      const files = await fs.readdir(buildDir);
      result.artifacts = files.map(file => path.join(buildDir, file));
      result.metrics = {
        artifactCount: files.length,
        buildSize: await this.calculateDirectorySize(buildDir)
      };
    } catch (error) {
      logger.warn('Could not read build directory:', (error as Error).message);
    }
  }

  /**
   * Executa lint
   */
  private async executeLint(result: StageResult): Promise<void> {
    const command = 'npm run lint';
    const { output, errors, exitCode } = await this.runCommand(command);
    
    result.output = output;
    result.errors = errors;
    result.exitCode = exitCode;
    
    // Extrair métricas de lint
    const issueCount = this.extractLintIssues(output);
    result.metrics = {
      issues: issueCount,
      passed: issueCount === 0
    };
    
    if (exitCode !== 0 && issueCount > 0) {
      throw new Error(`Lint failed with ${issueCount} issues`);
    }
  }

  /**
   * Executa testes
   */
  private async executeTest(result: StageResult): Promise<void> {
    const command = 'npm test';
    const { output, errors, exitCode } = await this.runCommand(command);
    
    result.output = output;
    result.errors = errors;
    result.exitCode = exitCode;
    
    // Extrair métricas de teste
    const testMetrics = this.extractTestMetrics(output);
    result.metrics = testMetrics;
    
    if (exitCode !== 0) {
      throw new Error(`Tests failed: ${testMetrics.failed} failed, ${testMetrics.passed} passed`);
    }
  }

  /**
   * Executa scan de segurança
   */
  private async executeScan(result: StageResult): Promise<void> {
    const command = 'npm audit --audit-level=high';
    const { output, errors, exitCode } = await this.runCommand(command);
    
    result.output = output;
    result.errors = errors;
    result.exitCode = exitCode;
    
    // Extrair vulnerabilidades
    const vulnerabilities = this.extractVulnerabilities(output);
    result.metrics = {
      vulnerabilities: vulnerabilities.length,
      critical: vulnerabilities.filter(v => v.severity === 'critical').length,
      high: vulnerabilities.filter(v => v.severity === 'high').length,
      medium: vulnerabilities.filter(v => v.severity === 'medium').length,
      low: vulnerabilities.filter(v => v.severity === 'low').length
    };
    
    // Falhar se vulnerabilidades críticas encontradas
    if (result.metrics.critical > 0) {
      throw new Error(`Security scan failed: ${result.metrics.critical} critical vulnerabilities found`);
    }
  }

  /**
   * Executa deploy
   */
  private async executeDeploy(result: StageResult, deployConfig?: DeployConfig): Promise<void> {
    if (!deployConfig) {
      throw new Error('Deploy configuration required for deploy stage');
    }

    const command = 'railway up --service production';
    const { output, errors, exitCode } = await this.runCommand(command, {
      DEPLOY_ENV: deployConfig.environment,
      DEPLOY_STRATEGY: deployConfig.strategy
    });
    
    result.output = output;
    result.errors = errors;
    result.exitCode = exitCode;
    
    if (exitCode !== 0) {
      throw new Error(`Deploy failed with exit code ${exitCode}`);
    }

    // Gerar versão
    const version = this.generateVersion();
    
    // Executar health check se configurado
    let healthCheck = true;
    if (deployConfig.healthCheckUrl) {
      healthCheck = await this.performHealthCheck(
        deployConfig.healthCheckUrl,
        deployConfig.healthCheckTimeout
      );
      
      if (!healthCheck && deployConfig.rollbackOnFailure) {
        throw new Error('Health check failed after deployment');
      }
    }

    result.metrics = {
      version,
      environment: deployConfig.environment,
      strategy: deployConfig.strategy,
      healthCheck,
      deployUrl: this.getDeployUrl(deployConfig.environment)
    };

    // Registrar deploy no histórico
    this.deployHistory.push({
      version,
      timestamp: new Date(),
      environment: deployConfig.environment,
      success: true
    });

    await this.saveDeployHistory();
  }

  /**
   * Executa rollback
   */
  private async executeRollback(result: StageResult): Promise<void> {
    // Encontrar última versão bem-sucedida
    const lastSuccessfulDeploy = this.deployHistory
      .filter(d => d.success)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];

    if (!lastSuccessfulDeploy) {
      throw new Error('No successful deployment found for rollback');
    }

    logger.info(`Rolling back to version: ${lastSuccessfulDeploy.version}`);

    const command = `npm run rollback -- --version=${lastSuccessfulDeploy.version}`;
    const { output, errors, exitCode } = await this.runCommand(command);
    
    result.output = output;
    result.errors = errors;
    result.exitCode = exitCode;
    
    if (exitCode !== 0) {
      throw new Error(`Rollback failed with exit code ${exitCode}`);
    }

    result.metrics = {
      previousVersion: lastSuccessfulDeploy.version,
      rollbackTimestamp: new Date().toISOString()
    };
  }

  /**
   * Executa comando shell
   */
  private async runCommand(
    command: string, 
    env?: Record<string, string>
  ): Promise<{
    output: string[];
    errors: string[];
    exitCode: number;
  }> {
    return new Promise((resolve, reject) => {
      const output: string[] = [];
      const errors: string[] = [];
      
      const [cmd, ...args] = command.split(' ');
      const childProcess = spawn(cmd, args, {
        env: { ...process.env, ...env },
        shell: true
      });

      const executionId = `cmd-${Date.now()}`;
      this.currentExecution.set(executionId, childProcess);

      childProcess.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        output.push(...lines);
        logger.debug('Command output:', lines.join('\n'));
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        errors.push(...lines);
        logger.debug('Command error:', lines.join('\n'));
      });

      childProcess.on('close', (code: number | null) => {
        this.currentExecution.delete(executionId);
        resolve({
          output,
          errors,
          exitCode: code || 0
        });
      });

      childProcess.on('error', (error: Error) => {
        this.currentExecution.delete(executionId);
        reject(error);
      });

      // Timeout de segurança
      setTimeout(() => {
        if (this.currentExecution.has(executionId)) {
          childProcess.kill('SIGTERM');
          this.currentExecution.delete(executionId);
          reject(new Error('Command timeout'));
        }
      }, 300000); // 5 minutos
    });
  }

  /**
   * Métodos auxiliares
   */
  private async verifyTools(): Promise<void> {
    const tools = ['npm', 'node'];
    
    for (const tool of tools) {
      try {
        await this.runCommand(`${tool} --version`);
        logger.debug(`Tool verified: ${tool}`);
      } catch (error) {
        throw new Error(`Required tool not found: ${tool}`);
      }
    }
  }

  private extractLintIssues(output: string[]): number {
    // Implementação específica para ESLint/TSLint
    const issueLines = output.filter(line => 
      line.includes('error') || line.includes('warning')
    );
    return issueLines.length;
  }

  private extractTestMetrics(output: string[]): {
    total: number;
    passed: number;
    failed: number;
    coverage: number;
  } {
    // Implementação específica para Jest/Mocha
    const summaryLine = output.find(line => 
      line.includes('Tests:') || line.includes('passing') || line.includes('failing')
    );
    
    if (!summaryLine) {
      return { total: 0, passed: 0, failed: 0, coverage: 0 };
    }

    // Parsing básico - adaptar conforme framework de teste
    const passedMatch = summaryLine.match(/(\d+) passing/);
    const failedMatch = summaryLine.match(/(\d+) failing/);
    
    const passed = passedMatch ? parseInt(passedMatch[1]) : 0;
    const failed = failedMatch ? parseInt(failedMatch[1]) : 0;
    
    // Buscar cobertura
    const coverageLine = output.find(line => line.includes('Coverage:'));
    const coverageMatch = coverageLine?.match(/(\d+(?:\.\d+)?)%/);
    const coverage = coverageMatch ? parseFloat(coverageMatch[1]) : 0;

    return {
      total: passed + failed,
      passed,
      failed,
      coverage
    };
  }

  private extractVulnerabilities(output: string[]): Array<{
    severity: 'critical' | 'high' | 'medium' | 'low';
    package: string;
    vulnerability: string;
  }> {
    // Implementação específica para npm audit/snyk
    const vulnerabilities = [];
    
    for (const line of output) {
      if (line.includes('Critical') || line.includes('High') || 
          line.includes('Medium') || line.includes('Low')) {
        // Parsing básico - adaptar conforme ferramenta de scan
        const severity = line.toLowerCase().includes('critical') ? 'critical' :
                        line.toLowerCase().includes('high') ? 'high' :
                        line.toLowerCase().includes('medium') ? 'medium' : 'low';
        
        vulnerabilities.push({
          severity: severity as any,
          package: 'unknown',
          vulnerability: line.trim()
        });
      }
    }
    
    return vulnerabilities;
  }

  private generateVersion(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const shortHash = Math.random().toString(36).substring(2, 8);
    return `v${timestamp}-${shortHash}`;
  }

  private async performHealthCheck(url: string, timeout: number): Promise<boolean> {
    try {
      const axios = require('axios');
      const response = await axios.get(url, { timeout });
      return response.status === 200;
    } catch (error) {
      logger.error('Health check failed:', (error as Error).message);
      return false;
    }
  }

  private getDeployUrl(environment: string): string {
    switch (environment) {
      case 'staging':
        return 'https://staging.marlie.app';
      case 'production':
        return 'https://marlie.app';
      default:
        return 'http://localhost:3000';
    }
  }

  private async calculateDirectorySize(dirPath: string): Promise<number> {
    try {
      const files = await fs.readdir(dirPath, { withFileTypes: true });
      let size = 0;
      
      for (const file of files) {
        const filePath = path.join(dirPath, file.name);
        if (file.isDirectory()) {
          size += await this.calculateDirectorySize(filePath);
        } else {
          const stats = await fs.stat(filePath);
          size += stats.size;
        }
      }
      
      return size;
    } catch (error) {
      return 0;
    }
  }

  private async loadDeployHistory(): Promise<void> {
    try {
      const historyPath = path.join(process.cwd(), '.deploy-history.json');
      const data = await fs.readFile(historyPath, 'utf-8');
      this.deployHistory = JSON.parse(data).map((item: any) => ({
        ...item,
        timestamp: new Date(item.timestamp)
      }));
      logger.info(`Loaded ${this.deployHistory.length} deploy history entries`);
    } catch (error) {
      logger.info('No deploy history found, starting fresh');
    }
  }

  private async saveDeployHistory(): Promise<void> {
    try {
      const historyPath = path.join(process.cwd(), '.deploy-history.json');
      await fs.writeFile(historyPath, JSON.stringify(this.deployHistory, null, 2));
    } catch (error) {
      logger.error('Failed to save deploy history:', error);
    }
  }

  /**
   * Cancela execução em andamento
   */
  async cancelExecution(executionId?: string): Promise<void> {
    if (executionId) {
      const process = this.currentExecution.get(executionId);
      if (process) {
        process.kill('SIGTERM');
        this.currentExecution.delete(executionId);
        logger.info(`Cancelled execution: ${executionId}`);
      }
    } else {
      // Cancelar todas as execuções
      for (const [id, process] of this.currentExecution) {
        process.kill('SIGTERM');
        this.currentExecution.delete(id);
      }
      logger.info('Cancelled all running executions');
    }
  }

  /**
   * Obtém histórico de deploys
   */
  getDeployHistory(): typeof this.deployHistory {
    return [...this.deployHistory];
  }

  /**
   * Finaliza o serviço
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down PipelineService...');
    
    // Cancelar execuções em andamento
    await this.cancelExecution();
    
    // Salvar histórico
    await this.saveDeployHistory();
    
    this.removeAllListeners();
    this.isInitialized = false;
    logger.info('PipelineService shutdown completed');
  }
}

// Interfaces e tipos já exportados no início do arquivo