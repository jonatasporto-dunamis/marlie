// Configuração principal do módulo
export interface MarlieQualityConfig {
  database: {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    ssl?: boolean;
  };
  redis: {
    host: string;
    port: number;
    password?: string;
    db?: number;
  };
  tests: {
    timezone: string;
    useTrinksStubs?: boolean;
    e2e: {
      scenarios: E2ETestSuite[];
      timeout: number;
      parallel: boolean;
      retry_attempts: number;
    };
    contract: {
      timeout: number;
      retry_attempts: number;
    };
    e2e_suites: E2ETestSuite[];
    contract_suites: ContractTestSuite[];
  };
  pipeline: {
    stages: string[];
    timeout: number;
    parallel_stages: string[];
    notifications: {
      slack_webhook?: string;
      email_recipients?: string[];
    };
  };
  integrations: {
    trinks: {
      base_url: string;
      token: string;
      timeout: number;
    };
    evolution: {
      base_url: string;
      token: string;
      timeout: number;
    };
  };
  metrics: {
    enabled: boolean;
    retention_days: number;
    export_interval: number;
  };
  logging: {
    level: string;
    file_path?: string;
    max_size: string;
    max_files: number;
  };
  security: {
    admin_token: string;
    rate_limit: {
      window_ms: number;
      max_requests: number;
    };
  };
  cache: {
    ttl: number;
    max_size: number;
  };
  features: {
    auto_rollback: boolean;
    health_checks: boolean;
    performance_monitoring: boolean;
  };
}

// Tipos para testes E2E
export interface E2ETestResult {
  scenario: string;
  success: boolean;
  duration: number;
  steps: E2ETestStep[];
  metrics?: {
    messagesExchanged: number;
    stateTransitions: number;
    apiCalls: number;
  };
  error?: string;
  timestamp: string;
}

export interface E2ETestStep {
  action: string;
  success: boolean;
  duration: number;
  details?: any;
  error?: string;
}

// Tipos para testes de contrato
export interface ContractTestResult {
  suite: string;
  success: boolean;
  duration: number;
  steps: ContractTestStepResult[];
  error?: string;
  timestamp: string;
}

export interface ContractTestStepResult {
  action: string;
  success: boolean;
  duration: number;
  result?: any;
  error?: string;
}

export interface ContractTestSuite {
  name: string;
  description?: string;
  steps: ContractTestStep[];
}

export interface ContractTestStep {
  action: string;
  with: {
    tool: string;
    args: any;
  };
  save_as?: string;
  assert?: {
    expr: string;
  };
}

// Tipos para E2E Test Suites
export interface E2ETestSuite {
  name: string;
  description?: string;
  arrange?: {
    seed?: { rows: number };
    use_trinks_stubs?: boolean;
  };
  steps: E2ETestStepDefinition[];
  cleanup?: E2ETestStepDefinition[];
}

export interface E2ETestStepDefinition {
  action: string;
  with?: any;
  expect_reply_contains?: string[];
  expect_state?: string;
  expect_slot?: {
    name: string;
    not_null?: boolean;
    value?: any;
  };
  save_as?: string;
  assert?: {
    expr: string;
  };
}

// Tipos para pipeline CI/CD
export interface PipelineResult {
  id: string;
  success: boolean;
  duration: number;
  stages: PipelineStageResult[];
  environment: string;
  branch: string;
  commit?: string;
  error?: string;
  timestamp: string;
}

export interface PipelineStageResult {
  name: string;
  success: boolean;
  duration: number;
  output?: string;
  error?: string;
  skipped?: boolean;
}

// Tipos para seeds
export interface SeedResult {
  success: boolean;
  duration: number;
  rowsCreated: number;
  tablesAffected: string[];
  error?: string;
  timestamp: string;
}

// Tipos para métricas
export interface QualityMetrics {
  timestamp: string;
  e2e_tests: {
    total_runs: number;
    success_rate: number;
    avg_duration: number;
    scenarios: {
      [scenario: string]: {
        runs: number;
        success_rate: number;
        avg_duration: number;
      };
    };
  };
  contract_tests: {
    total_runs: number;
    success_rate: number;
    avg_duration: number;
    suites: {
      [suite: string]: {
        runs: number;
        success_rate: number;
        avg_duration: number;
      };
    };
  };
  pipeline: {
    total_runs: number;
    success_rate: number;
    avg_duration: number;
    stages: {
      [stage: string]: {
        runs: number;
        success_rate: number;
        avg_duration: number;
      };
    };
  };
  system: {
    uptime: number;
    memory_usage: number;
    cpu_usage: number;
    disk_usage: number;
  };
}

// Tipos para configuração
export interface ConfigUpdate {
  path: string;
  value: any;
  previous_value?: any;
  timestamp: string;
  user?: string;
}

// Tipos para logs
export interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  module: string;
  metadata?: any;
}

// Tipos para health check
export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  checks: {
    [component: string]: {
      status: 'healthy' | 'degraded' | 'unhealthy';
      response_time?: number;
      error?: string;
      details?: any;
    };
  };
  overall_response_time: number;
}

// Tipos para deploy
export interface DeployResult {
  id: string;
  success: boolean;
  environment: string;
  version: string;
  duration: number;
  rollback_available: boolean;
  error?: string;
  timestamp: string;
}

// Tipos para rollback
export interface RollbackResult {
  id: string;
  success: boolean;
  environment: string;
  from_version: string;
  to_version: string;
  duration: number;
  error?: string;
  timestamp: string;
}