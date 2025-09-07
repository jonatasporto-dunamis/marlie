# Marlie Ship Check

> Módulo de verificação de entregáveis e deploy automatizado para o sistema Marlie

## 📋 Visão Geral

O **Marlie Ship Check** é um módulo especializado que automatiza a verificação de entregáveis críticos do sistema e executa o pipeline completo de CI/CD, incluindo build, testes e deploy.

### Entregáveis Verificados

- **P0.1** - Menu rígido + confirmação de intenção
- **P0.2** - Buffer 30s agregando mensagens por phone+window
- **P0.4** - Handoff humano: endpoint + efeito na conversa
- **P1.6** - Dashboards Grafana (3 telas: Funil, No-show Shield, Upsell)
- **P2.7** - Job de sincronismo Trinks → servicos_prof (diff=0)

### Pipeline CI/CD

1. **Verificação de Entregáveis** - Executa suite de testes automatizados
2. **Instalação** - `pnpm i || npm i`
3. **Build** - `pnpm build || npm run build`
4. **Git Push** - Commit e push das alterações
5. **Deploy Railway** - Deploy automatizado na plataforma

## 🚀 Uso Rápido

### Via NPM Scripts

```bash
# Desenvolvimento (padrão)
npm run ship-check

# Staging
npm run ship-check:staging

# Produção (dry-run)
npm run ship-check:production

# Produção (deploy real)
npm run ship-check:production:deploy

# Validar configuração
npm run ship-check:validate
```

### Via CLI Direto

```bash
# Opções básicas
ts-node scripts/run-ship-check.ts --environment staging
ts-node scripts/run-ship-check.ts --environment production --dry-run
ts-node scripts/run-ship-check.ts --config custom-config.yaml --verbose

# Ajuda
ts-node scripts/run-ship-check.ts --help
```

### Via API REST

```bash
# Executar ship check completo
curl -X POST "$BASE_URL/admin/ship-check/run" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"environment":"staging","dry_run":false}'

# Executar apenas uma suite
curl -X POST "$BASE_URL/admin/ship-check/suite" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"suite":"deliverables_checklist"}'

# Obter status
curl "$BASE_URL/admin/ship-check/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## ⚙️ Configuração

### Variáveis de Ambiente

```bash
# URLs base por ambiente
BASE_URL=https://api.marlie.app
STAGING_BASE_URL=https://staging-api.marlie.app
PRODUCTION_BASE_URL=https://api.marlie.app

# Tokens de autenticação
ADMIN_TOKEN=your-admin-token
STAGING_ADMIN_TOKEN=your-staging-token
PRODUCTION_ADMIN_TOKEN=your-production-token

# Grafana (para verificação de dashboards)
GRAFANA_URL=https://grafana.example.com
GRAFANA_TOKEN=your-grafana-token

# Notificações (opcional)
SLACK_WEBHOOK_URL=https://hooks.slack.com/...
```

### Arquivo de Configuração

O módulo usa o arquivo `src/modules/marlie-ship-check/config/ship-check.yaml` que define:

- **Ferramentas disponíveis** (http.get_json, http.post_json, router.inject_mock_message, qa.wait)
- **Suites de teste** com steps detalhados
- **Estágios do CI/CD** com comandos específicos
- **Configurações de notificação, métricas e rollback**

## 🧪 Testes e Validações

### Suite: deliverables_checklist

A suite principal executa os seguintes testes:

1. **Menu Rígido (P0.1)**
   ```yaml
   - action: "router.inject_mock_message"
     with: { phone: "5573999990000", text: "agenda" }
   - expect_reply_contains: ["Agendar (1)", "Informações (2)"]
   ```

2. **Buffer 30s (P0.2)**
   ```yaml
   - action: "router.inject_mock_message"
     with: { phone: "5573999990001", text: "quero" }
   - action: "qa.wait"
     with: { ms: 5000 }
   - action: "router.inject_mock_message"
     with: { phone: "5573999990001", text: "agendar amanhã" }
   - expect_state: "SCHEDULING_ROUTING"
   ```

3. **Handoff Humano (P0.4)**
   ```yaml
   - action: "http.post_json"
     with:
       url: "{{env.BASE_URL}}/admin/handoff/5573999990002"
       headers: { Authorization: "Bearer {{env.ADMIN_TOKEN}}" }
       body: { enabled: true }
   ```

4. **Dashboards Grafana (P1.6)**
   ```yaml
   - action: "http.get_json"
     with:
       url: "{{env.GRAFANA_URL}}/api/search?type=dash-db&query=Funil%20de%20Agendamento"
   - assert: { expr: "{{len(dash_funnel) > 0}}" }
   ```

5. **Sincronismo Trinks (P2.7)**
   ```yaml
   - action: "http.post_json"
     with:
       url: "{{env.BASE_URL}}/admin/sync/diff"
       body: { as_of_date: "{{today_local_date(env.timezone)}}" }
   - assert:
       any_of:
         - expr: "{{diff.status == 'no_diffs'}}"
         - expr: "{{(diff.count || 0) == 0}}"
   ```

## 📊 Métricas e Monitoramento

### Resultado da Execução

```json
{
  "success": true,
  "deliverables": {
    "P01_menu_rigido": true,
    "P02_buffer_30s": true,
    "P04_handoff_humano": true,
    "P16_dashboards_grafana": true,
    "P27_sync_trinks": true
  },
  "ci_cd": {
    "suite_test": true,
    "install": true,
    "build": true,
    "git_push": true,
    "deploy_railway": true
  },
  "duration_ms": 45000,
  "errors": []
}
```

### Logs Estruturados

```
🚀 Iniciando verificação de entregáveis e deploy
📋 Verificando entregáveis...
🧪 Executando suite: deliverables_checklist
📋 Step 1/15: router.inject_mock_message
✅ Step 1 passou
🔧 Executando pipeline CI/CD...
🔄 Executando estágio: install
✅ Estágio install concluído
✅ Ship check concluído com sucesso!
```

## 🔧 Estrutura do Módulo

```
src/modules/marlie-ship-check/
├── index.ts                    # Serviço principal
├── routes.ts                   # Rotas da API
├── config/
│   └── ship-check.yaml        # Configuração principal
├── tools/
│   ├── http-tools.ts          # Ferramentas HTTP
│   ├── router-tools.ts        # Ferramentas de roteamento
│   └── test-executor.ts       # Executor de testes
└── README.md                  # Esta documentação
```

## 🛡️ Segurança

### Autenticação
- Todas as rotas exigem token de admin válido
- Headers sensíveis são mascarados nos logs
- Validação de ambiente para operações críticas

### Proteções em Produção
- Confirmação manual obrigatória para deploy em produção
- Modo dry-run disponível para validação prévia
- Rollback automático em caso de falha

### Auditoria
- Logs detalhados de todas as operações
- Tracking de métricas de execução
- Histórico de deployments

## 🚨 Troubleshooting

### Problemas Comuns

**1. Falha na verificação de entregáveis**
```bash
# Verificar logs detalhados
npm run ship-check -- --verbose

# Executar apenas a suite de testes
curl -X POST "$BASE_URL/admin/ship-check/suite" \
  -d '{"suite":"deliverables_checklist"}'
```

**2. Erro no pipeline CI/CD**
```bash
# Verificar dependências
npm install

# Testar build local
npm run build

# Verificar configuração Git
git status
git remote -v
```

**3. Falha no deploy Railway**
```bash
# Verificar CLI do Railway
railway --version
railway login

# Deploy manual
railway up
```

### Debug Avançado

```bash
# Logs detalhados
LOG_LEVEL=debug npm run ship-check

# Validar configuração
npm run ship-check:validate

# Executar em modo dry-run
npm run ship-check -- --dry-run --verbose
```

## 🔄 Integração com CI/CD

### GitHub Actions

```yaml
name: Ship Check
on:
  push:
    branches: [main]
    
jobs:
  ship-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - run: npm run ship-check:staging
        env:
          BASE_URL: ${{ secrets.STAGING_BASE_URL }}
          ADMIN_TOKEN: ${{ secrets.STAGING_ADMIN_TOKEN }}
```

### Railway Deploy

O módulo integra automaticamente com Railway através do comando `railway up`, executando deploy após validação bem-sucedida dos entregáveis.

## 📚 Referências

- [Documentação da API](../../../docs/)
- [Módulo de Qualidade](../marlie-quality/README.md)
- [Configuração do Sistema](../../../config/)
- [Scripts de Deploy](../../../scripts/)