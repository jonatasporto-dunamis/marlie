# Marlie Quality Module

Módulo de qualidade e testes para o sistema Marlie, implementando pipeline CI/CD completo com testes E2E, contratos, seeds e health checks.

## 🚀 Funcionalidades

### Pipeline CI/CD
- **Lint**: Verificação de código e Dockerfile
- **Testes Unitários e de Contrato**: Validação de APIs e schemas
- **Testes E2E**: Fluxos completos de WhatsApp → diálogo → confirmação → Trinks
- **Security Scan**: Análise de vulnerabilidades com Trivy
- **Deploy**: Build e deploy automatizado
- **Health Check**: Verificação pós-deploy
- **Auto Rollback**: Rollback automático em caso de falha

### Ferramentas de QA
- **qa.run_suite**: Executa suítes de testes por nome
- **Seeds**: Criação e reset de dados de teste
- **Stubs**: Simulação de APIs externas
- **Métricas**: Coleta de dados de performance e qualidade

## 📋 Configuração

### Arquivos de Configuração
- `config/marlie-quality.yaml`: Configurações gerais do módulo
- `config/pipeline.yaml`: Configuração específica do pipeline CI/CD

### Variáveis de Ambiente
```bash
# URLs e tokens
HOST=http://localhost:3000
ADMIN_TOKEN=your-admin-token
HEALTH_URL=http://localhost:3000/health

# Banco de dados
DATABASE_URL=postgresql://user:pass@localhost:5432/marlie
REDIS_URL=redis://localhost:6379

# APIs externas
EVOLUTION_API_URL=https://evolution.api.url
TRINKS_API_URL=https://trinks.api.url
TRINKS_API_TOKEN=your-trinks-token
```

## 🛠️ Uso

### Scripts NPM

```bash
# Pipeline completo
npm run qa:pipeline

# Pipeline para staging
npm run qa:pipeline:staging

# Pipeline para production
npm run qa:pipeline:production

# Dry run (simulação)
npm run qa:pipeline:dry-run

# Health check
npm run qa:health
```

### Execução Manual

```bash
# Pipeline com argumentos customizados
ts-node src/modules/marlie-quality/scripts/run-pipeline.ts \
  --env staging \
  --branch main \
  --stages lint,test,deploy

# Executar suíte específica
curl -X POST $HOST/admin/qa/run \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"suite":"booking_flow_ok"}'
```

### API Endpoints

#### Executar Pipeline
```http
POST /admin/marlie-quality/pipeline/run
Authorization: Bearer {ADMIN_TOKEN}
Content-Type: application/json

{
  "environment": "staging",
  "branch": "main",
  "stages": ["lint", "test", "deploy"],
  "skipTests": false,
  "dryRun": false
}
```

#### Executar Suíte de Testes
```http
POST /admin/qa/run
Authorization: Bearer {ADMIN_TOKEN}
Content-Type: application/json

{
  "suite": "booking_flow_ok"
}
```

#### Health Check
```http
GET /health
```

## 🧪 Suítes de Testes Disponíveis

### Testes E2E
- `booking_flow_ok`: Fluxo completo de agendamento bem-sucedido
- `booking_flow_error`: Fluxo com tratamento de erros
- `whatsapp_integration`: Testes de integração com WhatsApp

### Testes de Contrato
- `trinks_fetch_contract`: Validação da API Trinks
- `evolution_contract`: Validação da API Evolution

## 📊 Métricas e Monitoramento

### Métricas Coletadas
- **Performance**: Tempo de resposta, throughput
- **Qualidade**: Taxa de sucesso dos testes, cobertura
- **Infraestrutura**: CPU, memória, conexões de banco
- **Negócio**: Taxa de conversão, agendamentos por hora

### Dashboards
- Grafana: `http://localhost:3001/dashboards/marlie-quality`
- Métricas em tempo real via `/admin/marlie-quality/metrics`

## 🔧 Desenvolvimento

### Estrutura do Módulo
```
src/modules/marlie-quality/
├── config/
│   ├── pipeline.yaml          # Configuração do pipeline
│   └── environments/          # Configs por ambiente
├── scripts/
│   ├── run-pipeline.ts        # Executor principal
│   ├── run-e2e-tests.ts      # Testes E2E
│   ├── run-contract-tests.ts  # Testes de contrato
│   └── run-seeds.ts          # Gerenciamento de seeds
├── tools/
│   └── qa-run-suite.ts       # Ferramenta qa.run_suite
├── routes.ts                 # Rotas da API
└── index.ts                  # Módulo principal
```

### Adicionando Novos Testes

1. **Teste E2E**: Adicione configuração em `marlie-quality.yaml`
```yaml
e2e_tests:
  suites:
    - name: "meu_novo_teste"
      description: "Descrição do teste"
      steps:
        - type: "send_message"
          content: "Olá"
        - type: "assert_response"
          contains: "Como posso ajudar?"
```

2. **Teste de Contrato**: Configure validação de schema
```yaml
contract_tests:
  suites:
    - name: "nova_api_contract"
      api_url: "https://api.exemplo.com"
      endpoints:
        - path: "/users"
          method: "GET"
          expected_schema: "user_list_schema"
```

### Debugging

```bash
# Logs detalhados
DEBUG=marlie:quality npm run qa:pipeline

# Modo dry-run para testar configurações
npm run qa:pipeline:dry-run

# Verificar health checks
npm run qa:health
```

## 🚨 Troubleshooting

### Problemas Comuns

1. **Pipeline falha no health check**
   - Verifique se todos os serviços estão rodando
   - Execute `npm run qa:health` para diagnóstico

2. **Testes E2E falham**
   - Verifique se as APIs externas estão acessíveis
   - Configure stubs se necessário

3. **Erro de autenticação**
   - Verifique se `ADMIN_TOKEN` está configurado
   - Confirme permissões de acesso

### Logs e Monitoramento

```bash
# Logs do pipeline
tail -f logs/marlie-quality.log

# Métricas em tempo real
curl $HOST/admin/marlie-quality/metrics

# Status dos serviços
curl $HOST/health
```

## 📚 Referências

- [Configuração do Pipeline](./config/pipeline.yaml)
- [Documentação da API](../../routes/health.ts)
- [Scripts de Health Check](../../../scripts/healthcheck.sh)
- [Runbooks Operacionais](./config/runbooks/)

---

**Marlie Quality Module** - Garantindo qualidade e confiabilidade em produção 🚀