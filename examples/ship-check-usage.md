# Exemplos de Uso - Marlie Ship Check

> Guia prático com exemplos reais de uso do módulo de verificação de entregáveis e deploy

## 🎯 Cenários de Uso

### 1. Verificação Rápida de Entregáveis

**Cenário**: Verificar se todos os entregáveis estão funcionando antes de um deploy.

```bash
# Verificação básica
npm run ship-check:validate

# Verificação com logs detalhados
LOG_LEVEL=debug npm run ship-check -- --dry-run --verbose
```

**Resultado esperado**:
```
🚀 Iniciando verificação de entregáveis
📋 P0.1 - Menu rígido: ✅ PASSOU
📋 P0.2 - Buffer 30s: ✅ PASSOU
📋 P0.4 - Handoff humano: ✅ PASSOU
📋 P1.6 - Dashboards Grafana: ✅ PASSOU
📋 P2.7 - Sync Trinks: ✅ PASSOU
✅ Todos os entregáveis validados com sucesso!
```

### 2. Deploy Staging Completo

**Cenário**: Deploy completo em ambiente de staging após desenvolvimento.

```bash
# Deploy staging com verificação completa
npm run ship-check:staging
```

**Fluxo executado**:
1. ✅ Verificação de entregáveis
2. ✅ Instalação de dependências
3. ✅ Build do projeto
4. ✅ Commit e push para Git
5. ✅ Deploy no Railway (staging)

**Logs de exemplo**:
```
🚀 Iniciando Ship Check - Ambiente: staging
📋 Verificando entregáveis...
🧪 Executando suite: deliverables_checklist
📋 Step 1/15: Testando menu rígido...
✅ Menu rígido funcionando corretamente
📋 Step 5/15: Verificando dashboards Grafana...
✅ Dashboard 'Funil de Agendamento' encontrado
✅ Dashboard 'No-show Shield' encontrado
✅ Dashboard 'Upsell' encontrado
🔧 Executando pipeline CI/CD...
🔄 Instalando dependências...
✅ Dependências instaladas
🔄 Executando build...
✅ Build concluído
🔄 Fazendo commit e push...
✅ Código enviado para repositório
🔄 Fazendo deploy no Railway...
✅ Deploy concluído com sucesso!
🎉 Ship check finalizado - Duração: 2m 15s
```

### 3. Deploy Produção com Validação

**Cenário**: Deploy em produção com validação prévia e confirmação manual.

```bash
# Primeiro: dry-run para validar
npm run ship-check:production

# Depois: deploy real (após confirmação)
npm run ship-check:production:deploy
```

**Dry-run em produção**:
```
🚨 MODO DRY-RUN - PRODUÇÃO 🚨
📋 Verificando entregáveis em produção...
✅ Todos os entregáveis validados
🔧 Simulando pipeline CI/CD...
✅ Build seria executado
✅ Deploy seria executado no Railway
⚠️  Para executar o deploy real, use: npm run ship-check:production:deploy
```

### 4. Verificação de Entregável Específico

**Cenário**: Testar apenas um entregável específico após correção.

```bash
# Via API - testar apenas P0.4 (handoff humano)
curl -X POST "$BASE_URL/admin/ship-check/suite" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "suite": "deliverables_checklist",
    "filter_steps": ["handoff_test"]
  }'
```

**Resposta da API**:
```json
{
  "success": true,
  "suite": "deliverables_checklist",
  "steps_executed": 3,
  "steps_passed": 3,
  "duration_ms": 5200,
  "results": [
    {
      "step": "enable_handoff",
      "action": "http.post_json",
      "status": "passed",
      "duration_ms": 1200
    },
    {
      "step": "test_handoff_message",
      "action": "router.inject_mock_message",
      "status": "passed",
      "duration_ms": 2000
    },
    {
      "step": "disable_handoff",
      "action": "http.post_json",
      "status": "passed",
      "duration_ms": 2000
    }
  ]
}
```

### 5. Monitoramento Contínuo

**Cenário**: Executar verificações periódicas via cron job.

```bash
# Crontab entry - verificar a cada 30 minutos
*/30 * * * * cd /path/to/project && npm run ship-check:validate >> /var/log/ship-check.log 2>&1
```

**Script de monitoramento**:
```bash
#!/bin/bash
# monitor-deliverables.sh

set -e

echo "[$(date)] Iniciando verificação de entregáveis"

# Executar verificação
if npm run ship-check:validate; then
    echo "[$(date)] ✅ Todos os entregáveis OK"
    # Notificar Slack (opcional)
    curl -X POST "$SLACK_WEBHOOK_URL" \
        -d '{"text":"✅ Entregáveis Marlie validados com sucesso"}'
else
    echo "[$(date)] ❌ Falha na verificação de entregáveis"
    # Notificar equipe
    curl -X POST "$SLACK_WEBHOOK_URL" \
        -d '{"text":"🚨 ALERTA: Falha na verificação de entregáveis Marlie!"}'
    exit 1
fi
```

### 6. Integração com GitHub Actions

**Cenário**: Automatizar ship check em pull requests e merges.

```yaml
# .github/workflows/ship-check.yml
name: Ship Check

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  validate-deliverables:
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    steps:
      - name: Checkout
        uses: actions/checkout@v3
        
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Validate deliverables
        run: npm run ship-check:validate
        env:
          BASE_URL: ${{ secrets.STAGING_BASE_URL }}
          ADMIN_TOKEN: ${{ secrets.STAGING_ADMIN_TOKEN }}
          GRAFANA_URL: ${{ secrets.GRAFANA_URL }}
          GRAFANA_TOKEN: ${{ secrets.GRAFANA_TOKEN }}

  deploy-staging:
    runs-on: ubuntu-latest
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    steps:
      - name: Checkout
        uses: actions/checkout@v3
        
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Ship check staging
        run: npm run ship-check:staging
        env:
          BASE_URL: ${{ secrets.STAGING_BASE_URL }}
          ADMIN_TOKEN: ${{ secrets.STAGING_ADMIN_TOKEN }}
          GRAFANA_URL: ${{ secrets.GRAFANA_URL }}
          GRAFANA_TOKEN: ${{ secrets.GRAFANA_TOKEN }}
          RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
```

### 7. Debug de Falhas

**Cenário**: Investigar falha em entregável específico.

```bash
# Executar com logs detalhados
LOG_LEVEL=debug npm run ship-check -- --verbose

# Verificar status via API
curl "$BASE_URL/admin/ship-check/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .
```

**Exemplo de debug - P1.6 (Dashboards)**:
```bash
# Testar conexão Grafana manualmente
curl "$GRAFANA_URL/api/search?type=dash-db&query=Funil" \
  -H "Authorization: Bearer $GRAFANA_TOKEN" | jq .

# Verificar se dashboards existem
curl "$GRAFANA_URL/api/search" \
  -H "Authorization: Bearer $GRAFANA_TOKEN" | jq '.[] | select(.title | contains("Funil"))'
```

**Logs de debug**:
```
[DEBUG] Executando step: verify_grafana_dashboards
[DEBUG] URL: https://grafana.example.com/api/search?type=dash-db&query=Funil%20de%20Agendamento
[DEBUG] Headers: {"Authorization":"Bearer ***"}
[DEBUG] Response status: 200
[DEBUG] Response body: [{"id":123,"title":"Funil de Agendamento","type":"dash-db"}]
[DEBUG] Assertion: len(dash_funnel) > 0 = true
✅ Dashboard 'Funil de Agendamento' encontrado
```

### 8. Configuração Personalizada

**Cenário**: Usar configuração customizada para ambiente específico.

```bash
# Criar configuração personalizada
cp src/modules/marlie-ship-check/config/ship-check.yaml custom-ship-check.yaml

# Editar configuração (ex: adicionar novos testes)
vim custom-ship-check.yaml

# Executar com configuração personalizada
npm run ship-check -- --config custom-ship-check.yaml --environment staging
```

**Exemplo de configuração personalizada**:
```yaml
# custom-ship-check.yaml
module:
  name: "marlie-ship-check-custom"
  description: "Configuração personalizada para testes específicos"

tests:
  suites:
    - name: "custom_deliverables"
      steps:
        # Teste personalizado para P0.1
        - action: "router.inject_mock_message"
          with: { phone: "5573999990000", text: "quero agendar" }
        - expect_reply_contains: ["Que tipo de serviço"]
        
        # Teste adicional de performance
        - action: "http.get_json"
          with:
            url: "{{env.BASE_URL}}/health"
          save_as: "health_check"
        - assert: { expr: "{{health_check.response_time_ms < 500}}" }
```

### 9. Rollback Automático

**Cenário**: Configurar rollback automático em caso de falha.

```bash
# Executar com rollback habilitado
npm run ship-check:production:deploy -- --enable-rollback
```

**Configuração de rollback**:
```yaml
# No ship-check.yaml
ci_cd:
  rollback:
    enabled: true
    trigger_on_failure: true
    strategy: "git_revert"
    notification:
      slack_webhook: "{{env.SLACK_WEBHOOK_URL}}"
      message: "🚨 Rollback executado automaticamente"
```

### 10. Métricas e Relatórios

**Cenário**: Gerar relatório detalhado de execução.

```bash
# Executar com relatório detalhado
npm run ship-check -- --generate-report --output-format json

# Obter métricas via API
curl "$BASE_URL/admin/ship-check/metrics" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .
```

**Exemplo de relatório**:
```json
{
  "execution_id": "ship-check-20240115-143022",
  "timestamp": "2024-01-15T14:30:22Z",
  "environment": "staging",
  "duration_ms": 125000,
  "success": true,
  "deliverables": {
    "P01_menu_rigido": {
      "status": "passed",
      "duration_ms": 3200,
      "details": "Menu rígido respondendo corretamente"
    },
    "P02_buffer_30s": {
      "status": "passed",
      "duration_ms": 35000,
      "details": "Buffer agregando mensagens corretamente"
    },
    "P04_handoff_humano": {
      "status": "passed",
      "duration_ms": 5500,
      "details": "Handoff ativando e desativando corretamente"
    },
    "P16_dashboards_grafana": {
      "status": "passed",
      "duration_ms": 8200,
      "details": "Todos os 3 dashboards encontrados"
    },
    "P27_sync_trinks": {
      "status": "passed",
      "duration_ms": 12000,
      "details": "Sincronismo sem diferenças"
    }
  },
  "ci_cd_stages": {
    "install": { "status": "passed", "duration_ms": 25000 },
    "build": { "status": "passed", "duration_ms": 18000 },
    "git_push": { "status": "passed", "duration_ms": 3000 },
    "deploy_railway": { "status": "passed", "duration_ms": 45000 }
  },
  "metrics": {
    "total_steps": 23,
    "passed_steps": 23,
    "failed_steps": 0,
    "success_rate": 100
  }
}
```

## 🔧 Dicas e Boas Práticas

### 1. Execução Local vs CI/CD

```bash
# Local (desenvolvimento)
npm run ship-check -- --dry-run --verbose

# CI/CD (automatizado)
npm run ship-check:staging
```

### 2. Gerenciamento de Tokens

```bash
# Usar arquivo .env para desenvolvimento
echo "ADMIN_TOKEN=your-token" >> .env.local

# Usar secrets para CI/CD
# GitHub: Settings > Secrets and variables > Actions
# Railway: Settings > Environment Variables
```

### 3. Monitoramento de Performance

```bash
# Executar com métricas de performance
time npm run ship-check:validate

# Verificar logs de performance
tail -f logs/ship-check.log | grep "duration_ms"
```

### 4. Troubleshooting Rápido

```bash
# Verificar conectividade
curl -I "$BASE_URL/health"

# Testar autenticação
curl "$BASE_URL/admin/health" -H "Authorization: Bearer $ADMIN_TOKEN"

# Verificar Railway CLI
railway login && railway status
```

Esses exemplos cobrem os principais cenários de uso do módulo Ship Check, desde verificações simples até pipelines completos de CI/CD com monitoramento e rollback automático.