import { describe, test, expect, beforeAll } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { processNLU } from '../../src/core/nlu';
import logger from '../../src/utils/logger';

interface DatasetSample {
  id: number;
  input: string;
  expected: {
    intent: string;
    serviceName?: string;
    dateRel?: string;
    dateISO?: string;
    period?: string;
    timeISO?: string;
    professionalName?: string;
  };
  category: string;
  dialect_features: string[];
}

interface Dataset {
  name: string;
  description: string;
  version: string;
  total_samples: number;
  samples: DatasetSample[];
}

interface F1Metrics {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

interface NLUEvaluation {
  overall_f1: number;
  field_metrics: Record<string, F1Metrics>;
  intent_accuracy: number;
  json_validity: number;
  total_samples: number;
  passed_samples: number;
  failed_samples: number;
  errors: Array<{
    sample_id: number;
    input: string;
    expected: any;
    actual: any;
    error?: string;
  }>;
}

// Configuração do gate F1 a partir de variável de ambiente
const NLU_F1_TARGET = parseFloat(process.env.NLU_F1_TARGET || '0.90');

describe('NLU F1 Regression Tests', () => {
  let dataset: Dataset;
  
  beforeAll(() => {
    // Carregar dataset de teste
    const datasetPath = path.join(__dirname, '../evals/dataset_bahia.json');
    const datasetContent = fs.readFileSync(datasetPath, 'utf-8');
    dataset = JSON.parse(datasetContent);
    
    logger.info('NLU F1 Tests initialized', {
      dataset_name: dataset.name,
      total_samples: dataset.total_samples,
      f1_target: NLU_F1_TARGET
    });
  });
  
  test('should meet F1 score target for overall NLU performance', async () => {
    const evaluation = await evaluateNLU(dataset.samples);
    
    // Log detalhado dos resultados
    logger.info('NLU Evaluation Results', {
      overall_f1: evaluation.overall_f1,
      intent_accuracy: evaluation.intent_accuracy,
      json_validity: evaluation.json_validity,
      passed_samples: evaluation.passed_samples,
      failed_samples: evaluation.failed_samples,
      f1_target: NLU_F1_TARGET
    });
    
    // Log erros se houver
    if (evaluation.errors.length > 0) {
      logger.warn('NLU Evaluation Errors', {
        error_count: evaluation.errors.length,
        errors: evaluation.errors.slice(0, 5) // Primeiros 5 erros
      });
    }
    
    // Verificar se atende ao gate F1
    expect(evaluation.overall_f1).toBeGreaterThanOrEqual(NLU_F1_TARGET);
    
    // Verificar métricas adicionais
    expect(evaluation.intent_accuracy).toBeGreaterThanOrEqual(0.95); // 95% de acurácia de intent
    expect(evaluation.json_validity).toBeGreaterThanOrEqual(0.98); // 98% de JSON válido
  }, 30000); // Timeout de 30s
  
  test('should extract serviceName with high precision', async () => {
    const samplesWithService = dataset.samples.filter(s => s.expected.serviceName);
    const evaluation = await evaluateNLU(samplesWithService);
    
    const serviceMetrics = evaluation.field_metrics.serviceName;
    expect(serviceMetrics).toBeDefined();
    expect(serviceMetrics.f1).toBeGreaterThanOrEqual(0.85);
    
    logger.info('ServiceName F1 Score', {
      f1: serviceMetrics.f1,
      precision: serviceMetrics.precision,
      recall: serviceMetrics.recall,
      support: serviceMetrics.support
    });
  });
  
  test('should extract temporal information accurately', async () => {
    const samplesWithTime = dataset.samples.filter(s => 
      s.expected.dateRel || s.expected.period || s.expected.timeISO
    );
    const evaluation = await evaluateNLU(samplesWithTime);
    
    // Verificar métricas temporais
    const timeFields = ['dateRel', 'period', 'timeISO'];
    for (const field of timeFields) {
      const metrics = evaluation.field_metrics[field];
      if (metrics && metrics.support > 0) {
        expect(metrics.f1).toBeGreaterThanOrEqual(0.80);
        
        logger.info(`${field} F1 Score`, {
          f1: metrics.f1,
          precision: metrics.precision,
          recall: metrics.recall,
          support: metrics.support
        });
      }
    }
  });
  
  test('should handle Bahian dialect features correctly', async () => {
    const dialectSamples = dataset.samples.filter(s => 
      s.dialect_features && s.dialect_features.length > 0
    );
    
    expect(dialectSamples.length).toBeGreaterThan(30); // Pelo menos 30 amostras com dialeto
    
    const evaluation = await evaluateNLU(dialectSamples);
    
    // Dialeto não deve degradar significativamente a performance
    expect(evaluation.overall_f1).toBeGreaterThanOrEqual(NLU_F1_TARGET - 0.05);
    expect(evaluation.intent_accuracy).toBeGreaterThanOrEqual(0.90);
    
    logger.info('Dialect Features Performance', {
      samples_count: dialectSamples.length,
      overall_f1: evaluation.overall_f1,
      intent_accuracy: evaluation.intent_accuracy
    });
  });
  
  test('should return valid JSON for all inputs', async () => {
    const evaluation = await evaluateNLU(dataset.samples);
    
    // 100% das respostas devem ser JSON válido
    expect(evaluation.json_validity).toBe(1.0);
    
    // Verificar se há erros de parsing JSON
    const jsonErrors = evaluation.errors.filter(e => e.error?.includes('JSON'));
    expect(jsonErrors.length).toBe(0);
  });
  
  test('should not include invalid schema fields', async () => {
    const validFields = new Set([
      'intent', 'serviceName', 'dateRel', 'dateISO', 
      'period', 'timeISO', 'professionalName'
    ]);
    
    let invalidFieldCount = 0;
    
    for (const sample of dataset.samples.slice(0, 10)) { // Testar primeiras 10 amostras
      try {
        const result = await processNLU(sample.input);
        
        // Verificar se todos os campos estão no schema válido
        for (const field of Object.keys(result)) {
          if (!validFields.has(field)) {
            invalidFieldCount++;
            logger.warn('Invalid schema field detected', {
              sample_id: sample.id,
              input: sample.input,
              invalid_field: field,
              result
            });
          }
        }
      } catch (error) {
        logger.error('Error processing sample for schema validation', {
          sample_id: sample.id,
          error
        });
      }
    }
    
    expect(invalidFieldCount).toBe(0);
  });
});

/**
 * Avalia o desempenho do NLU usando métricas F1
 */
async function evaluateNLU(samples: DatasetSample[]): Promise<NLUEvaluation> {
  const results = {
    overall_f1: 0,
    field_metrics: {} as Record<string, F1Metrics>,
    intent_accuracy: 0,
    json_validity: 0,
    total_samples: samples.length,
    passed_samples: 0,
    failed_samples: 0,
    errors: [] as Array<{
      sample_id: number;
      input: string;
      expected: any;
      actual: any;
      error?: string;
    }>
  };
  
  const fieldStats = {
    intent: { tp: 0, fp: 0, fn: 0 },
    serviceName: { tp: 0, fp: 0, fn: 0 },
    dateRel: { tp: 0, fp: 0, fn: 0 },
    period: { tp: 0, fp: 0, fn: 0 },
    timeISO: { tp: 0, fp: 0, fn: 0 },
    professionalName: { tp: 0, fp: 0, fn: 0 }
  };
  
  let correctIntents = 0;
  let validJsonCount = 0;
  
  for (const sample of samples) {
    try {
      const actual = await processNLU(sample.input);
      
      // Verificar se é JSON válido
      if (typeof actual === 'object' && actual !== null) {
        validJsonCount++;
      }
      
      // Verificar intent
      if (actual.intent === sample.expected.intent) {
        correctIntents++;
        results.passed_samples++;
      } else {
        results.failed_samples++;
        results.errors.push({
          sample_id: sample.id,
          input: sample.input,
          expected: sample.expected,
          actual,
          error: `Intent mismatch: expected '${sample.expected.intent}', got '${actual.intent}'`
        });
      }
      
      // Calcular métricas por campo
      for (const [field, stats] of Object.entries(fieldStats)) {
        const expectedValue = (sample.expected as any)[field];
        const actualValue = (actual as any)[field];
        
        if (expectedValue && actualValue && expectedValue === actualValue) {
          stats.tp++; // True Positive
        } else if (expectedValue && !actualValue) {
          stats.fn++; // False Negative
        } else if (!expectedValue && actualValue) {
          stats.fp++; // False Positive
        }
        // True Negative não é contado explicitamente
      }
      
    } catch (error) {
      results.failed_samples++;
      results.errors.push({
        sample_id: sample.id,
        input: sample.input,
        expected: sample.expected,
        actual: null,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
  
  // Calcular métricas finais
  results.intent_accuracy = correctIntents / samples.length;
  results.json_validity = validJsonCount / samples.length;
  
  // Calcular F1 por campo
  let totalF1 = 0;
  let fieldsWithData = 0;
  
  for (const [field, stats] of Object.entries(fieldStats)) {
    const precision = stats.tp / (stats.tp + stats.fp) || 0;
    const recall = stats.tp / (stats.tp + stats.fn) || 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    const support = stats.tp + stats.fn;
    
    if (support > 0) {
      results.field_metrics[field] = {
        precision,
        recall,
        f1,
        support
      };
      
      totalF1 += f1;
      fieldsWithData++;
    }
  }
  
  // F1 geral é a média dos F1s dos campos com dados
  results.overall_f1 = fieldsWithData > 0 ? totalF1 / fieldsWithData : 0;
  
  return results;
}

/**
 * Função auxiliar para executar testes de regressão via CLI
 */
export async function runNLURegressionTest(): Promise<boolean> {
  try {
    const datasetPath = path.join(__dirname, '../evals/dataset_bahia.json');
    const datasetContent = fs.readFileSync(datasetPath, 'utf-8');
    const dataset: Dataset = JSON.parse(datasetContent);
    
    const evaluation = await evaluateNLU(dataset.samples);
    
    console.log('\n=== NLU Regression Test Results ===');
    console.log(`Overall F1 Score: ${evaluation.overall_f1.toFixed(4)}`);
    console.log(`Intent Accuracy: ${evaluation.intent_accuracy.toFixed(4)}`);
    console.log(`JSON Validity: ${evaluation.json_validity.toFixed(4)}`);
    console.log(`Target F1: ${NLU_F1_TARGET}`);
    console.log(`Passed: ${evaluation.passed_samples}/${evaluation.total_samples}`);
    
    if (evaluation.overall_f1 >= NLU_F1_TARGET) {
      console.log('✅ F1 Gate PASSED');
      return true;
    } else {
      console.log('❌ F1 Gate FAILED');
      console.log(`\nFirst 3 errors:`);
      evaluation.errors.slice(0, 3).forEach(error => {
        console.log(`- Sample ${error.sample_id}: ${error.error}`);
      });
      return false;
    }
  } catch (error) {
    console.error('Error running NLU regression test:', error);
    return false;
  }
}