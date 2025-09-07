# Exemplos de Uso - Pipeline de Qualidade Marlie

Este documento demonstra como usar o sistema de qualidade e testes do Marlie em diferentes cenários.

## 🚀 Cenários de Uso

### 1. Pipeline Completo para Deploy em Staging

```bash
# Executar pipeline completo para staging
npm run qa:pipeline:staging

# Ou com argumentos customizados
ts-node src/modules/marlie-quality/scripts/run-pipeline.ts \
  --env staging \
  --branch main \
  --stages lint,unit_and_contract_tests,e2e_tests,security_scan,push_and_deploy,post_deploy_healthcheck
```

### 2. Validação Rápida Antes de Commit

```bash
# Dry run para validar mudanças
npm run qa:pipeline:dry-run

# Apenas lint e testes unitários
ts-node src/modules/marlie-quality/scripts/run-pipeline.ts \
  --stages lint,unit_and_contract_tests \
  --dry-run
```

### 3. Testes E2E Isolados

```bash
# Executar suíte específica via API
curl -X POST http://localhost:3000/admin/qa/run \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"suite":"booking_flow_ok"}'

# Executar múltiplas suítes
curl -X POST http://localhost:3000/admin/qa/run \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"suite":"booking_flow_error"}'
```

### 4. Validação de Contratos de API

```bash
# Testar contrato da API Trinks
curl -X POST http://localhost:3000/admin/qa/run \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"suite":"trinks_fetch_contract"}'
```

### 5. Health Check e Monitoramento

```bash
# Verificar saúde do sistema
curl http://localhost:3000/health

# Health check com script
bash scripts/healthcheck.sh http://localhost:3000/health 120

# Verificar métricas
curl http://localhost:3000/admin/marlie-quality/metrics
```

## 📋 Fluxos de Trabalho

### Fluxo de Desenvolvimento

1. **Antes de fazer commit:**
   ```bash
   npm run qa:pipeline:dry-run
   ```

2. **Após push para branch de feature:**
   ```bash
   npm run qa:pipeline -- --env development --branch feature/nova-funcionalidade
   ```

3. **Antes de merge para main:**
   ```bash
   npm run qa:pipeline:staging
   ```

### Fluxo de Deploy

1. **Deploy para staging:**
   ```bash
   npm run qa:pipeline:staging
   ```

2. **Validação em staging:**
   ```bash
   # Executar testes E2E em staging
   HOST=https://staging.marlie.com npm run qa:suite '{"suite":"booking_flow_ok"}'
   ```

3. **Deploy para produção:**
   ```bash
   npm run qa:pipeline:production
   ```

### Fluxo de Troubleshooting

1. **Identificar problema:**
   ```bash
   curl https://marlie.com/health
   ```

2. **Executar diagnósticos:**
   ```bash
   # Health check detalhado
   bash scripts/healthcheck.sh https://marlie.com/health 60
   
   # Testar APIs críticas
   curl -X POST https://marlie.com/admin/qa/run \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -d '{"suite":"trinks_fetch_contract"}'
   ```

3. **Rollback se necessário:**
   ```bash
   kubectl rollout undo deploy/marlie
   ```

## 🔧 Configurações por Ambiente

### Development
```bash
export HOST=http://localhost:3000
export ADMIN_TOKEN=dev-token
export HEALTH_URL=http://localhost:3000/health
export USE_STUBS=true
```

### Staging
```bash
export HOST=https://staging.marlie.com
export ADMIN_TOKEN=$STAGING_ADMIN_TOKEN
export HEALTH_URL=https://staging.marlie.com/health
export USE_STUBS=false
```

### Production
```bash
export HOST=https://marlie.com
export ADMIN_TOKEN=$PROD_ADMIN_TOKEN
export HEALTH_URL=https://marlie.com/health
export USE_STUBS=false
```

## 📊 Interpretando Resultados

### Resultado de Pipeline Bem-sucedido
```json
{
  "status": "success",
  "stages": [
    {
      "stage": "lint",
      "status": "success",
      "duration": 5000,
      "commands": [
        {"command": "pnpm lint", "status": "success"}
      ]
    },
    {
      "stage": "unit_and_contract_tests",
      "status": "success",
      "duration": 15000,
      "commands": [
        {"command": "pnpm test:unit", "status": "success"},
        {"command": "curl -X POST...", "status": "success", "testResult": {...}}
      ]
    }
  ],
  "summary": {
    "total": 6,
    "success": 6,
    "failed": 0
  }
}
```

### Resultado de Teste E2E
```json
{
  "status": "passed",
  "suite": "booking_flow_ok",
  "summary": "Todos os 5 testes passaram",
  "details": {
    "total_tests": 5,
    "passed": 5,
    "failed": 0,
    "duration_ms": 12000,
    "steps": [
      {"step": "send_message", "status": "passed"},
      {"step": "assert_response", "status": "passed"}
    ]
  }
}
```

### Health Check
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00Z",
  "checks": {
    "redis": {"status": "ok", "latency_ms": 2},
    "postgres": {"status": "ok", "latency_ms": 5},
    "evolution_api": {"status": "ok", "latency_ms": 150},
    "trinks_api": {"status": "ok", "latency_ms": 200}
  },
  "metrics": {
    "uptime_seconds": 86400,
    "memory_usage_mb": 256,
    "cpu_usage_percent": 15
  }
}
```

## 🚨 Tratamento de Erros

### Pipeline Falha no Lint
```bash
# Verificar erros específicos
npm run lint

# Corrigir automaticamente quando possível
npm run lint -- --fix
```

### Testes E2E Falham
```bash
# Executar com logs detalhados
DEBUG=marlie:quality npm run qa:suite '{"suite":"booking_flow_ok"}'

# Verificar se APIs externas estão funcionando
curl https://api.trinks.com/health
curl https://evolution.api.url/health
```

### Health Check Falha
```bash
# Verificar componentes individuais
curl http://localhost:3000/health

# Verificar logs do sistema
tail -f logs/marlie.log

# Reiniciar serviços se necessário
docker-compose restart
```

## 📈 Monitoramento Contínuo

### Métricas Importantes
- **Taxa de sucesso dos testes**: > 95%
- **Tempo de execução do pipeline**: < 10 minutos
- **Latência das APIs**: < 500ms
- **Uptime do sistema**: > 99.9%

### Alertas Recomendados
```bash
# Configurar alertas para:
# - Pipeline falhando por mais de 2 execuções consecutivas
# - Health check falhando por mais de 5 minutos
# - Latência de APIs > 1 segundo
# - Taxa de erro > 5%
```

## 🔄 Automação com CI/CD

### GitHub Actions
```yaml
name: Quality Pipeline
on:
  push:
    branches: [main, staging]
  pull_request:
    branches: [main]

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Setup Node.js
        uses: actions/setup-node@v2
        with:
          node-version: '18'
      - name: Install dependencies
        run: npm install
      - name: Run Quality Pipeline
        run: npm run qa:pipeline
        env:
          HOST: ${{ secrets.HOST }}
          ADMIN_TOKEN: ${{ secrets.ADMIN_TOKEN }}
```

### Webhook para Deploy
```bash
# Configurar webhook que executa pipeline após deploy
curl -X POST https://marlie.com/admin/marlie-quality/pipeline/run \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "environment": "production",
    "branch": "main",
    "stages": ["post_deploy_healthcheck"],
    "skipTests": false,
    "dryRun": false
  }'
```

---

**Marlie Quality Pipeline** - Garantindo qualidade em cada deploy 🚀