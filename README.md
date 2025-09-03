# Ateliê Marcleia Abade - Sistema de Agendamento

Sistema de agendamento via WhatsApp integrado com a API Trinks, incluindo funcionalidades de segurança, observabilidade e performance.

## 🚀 Funcionalidades

### Agendamento via WhatsApp
- Processamento de mensagens via Evolution API
- Extração inteligente de intenções usando LLM (OpenAI)
- Fluxo conversacional para coleta de dados de agendamento
- Integração com API Trinks para criação de agendamentos
- Deduplicação de mensagens e idempotência

### Sistema de Upsell Inteligente
- **Seleção Contextual**: Máximo 1 upsell por conversa baseado no contexto
- **Timing Otimizado**: Ofertas após confirmação de agendamento
- **Métricas de Conversão**: Tracking de performance e ticket médio
- **CTAs Simples**: Interface amigável para aceitar/recusar ofertas

### Mensagens Automáticas
- **Pré-Visita**: Lembretes enviados 24-40h antes do agendamento
- **No-Show Shield**: Confirmação de presença no dia anterior às 18h
- **Agendamento Inteligente**: Worker/cron para processamento assíncrono
- **Sistema de Opt-out**: Usuários podem parar mensagens com 'PARAR'
- **Opt-in Flexível**: Reativação com 'VOLTAR' ou palavras similares

### Segurança e Autenticação
- **Autenticação Admin**: Middleware `adminAuth` com token `X-Admin-Token`
- **Autenticação Webhook**: Middleware `webhookAuth` com token `X-Webhook-Token`
- **Rate Limiting**: 
  - Admin: 60 req/min por IP
  - Webhook: 300 req/min por IP (5 req/s)
- **Deduplicação Avançada**: Cache em memória para evitar processamento duplicado
- **Mascaramento PII**: Logs automaticamente mascarados (telefones, emails, CPF)
- **Logs de Auditoria**: Registro completo de acessos com contexto de segurança

### Observabilidade

#### Logs Estruturados
- **Request ID**: Identificador único para cada requisição
- **Message ID**: Rastreamento de mensagens do WhatsApp
- **Contexto**: Logs com informações de tenant, telefone e etapa do processo

#### Métricas Prometheus
Disponíveis no endpoint `/metrics`:

**Métricas de Conversação:**
- `conversations_started_total`: Contador de conversas iniciadas por tenant
- `service_suggestions_shown_total`: Contador de sugestões de serviços mostradas
- `bookings_confirmed_total`: Contador de agendamentos confirmados

**Métricas de Upsell:**
- `upsell_offered_total`: Contador de upsells oferecidos
- `upsell_accepted_total`: Contador de upsells aceitos
- `upsell_revenue_total`: Receita total gerada por upsells

**Métricas de Mensagens Automáticas:**
- `pre_visit_sent_total`: Contador de mensagens de pré-visita enviadas
- `no_show_check_sent_total`: Contador de verificações de no-show enviadas
- `no_show_prevented_total`: Contador de no-shows prevenidos
- `reschedule_requested_total`: Contador de solicitações de remarcação
- `user_opt_out_total`: Contador de usuários que optaram por sair

**Métricas de Sistema:**
- `api_trinks_errors_total`: Contador de erros da API Trinks por código e endpoint
- `http_request_duration_seconds`: Histograma de tempo de resposta HTTP
- `active_connections`: Gauge de conexões ativas

#### Health Checks
- `/health`: Status geral do sistema com subchecks
- `/ready`: Verificação de prontidão para receber tráfego

Subchecks incluem:
- PostgreSQL
- Redis
- Evolution API
- Trinks API

### Performance

#### Índices de Banco de Dados
Criados automaticamente via migration `001_create_indexes.sql`:

- `idx_servicos_prof_tenant`: Otimiza consultas por tenant
- `idx_servicos_prof_ativo`: Filtragem por serviços ativos
- `idx_servicos_prof_visivel`: Serviços visíveis ao cliente
- `idx_servicos_prof_servico`: Busca por ID do serviço
- `idx_servicos_prof_profissional`: Busca por profissional
- `idx_servicos_prof_last_synced`: Consultas por data de sincronização
- `idx_servicos_prof_servico_nome_normalized`: Busca otimizada por nome normalizado

#### Normalização de Dados
- **Função SQL**: `normalize_servico_nome()` para padronização automática
- **Trigger**: Aplicação automática da normalização em inserções/atualizações
- **Benefícios**: Reduz duplicatas e melhora a busca de serviços

## 🛠️ Configuração

### Variáveis de Ambiente

```env
# Banco de Dados
DATABASE_URL=postgresql://user:password@localhost:5432/database
DATABASE_SSL=false

# Redis
REDIS_URL=redis://localhost:6379

# Evolution API (WhatsApp)
EVOLUTION_BASE_URL=http://localhost:8080
EVOLUTION_API_KEY=your_api_key
EVOLUTION_INSTANCE=your_instance
EVOLUTION_WEBHOOK_TOKEN=your_webhook_token

# Trinks API
TRINKS_BASE_URL=https://api.trinks.com
TRINKS_API_KEY=your_trinks_api_key
TRINKS_ESTABELECIMENTO_ID=your_establishment_id

# OpenAI
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-3.5-turbo

# Segurança
ADMIN_TOKEN=your_secure_admin_token

# Feature Flags
# Sistema de Upsell
UPSELL_ENABLED=true
UPSELL_MAX_PER_CONVERSATION=1
UPSELL_TIMEOUT_MS=300000

# Mensagens Automáticas
PRE_VISIT_ENABLED=true
PRE_VISIT_HOURS_BEFORE=24
PRE_VISIT_MAX_HOURS_BEFORE=40

# No-Show Shield
NO_SHOW_SHIELD_ENABLED=true
NO_SHOW_CHECK_HOUR=18
NO_SHOW_CHECK_DAYS_BEFORE=1

# Worker de Agendamento
SCHEDULER_ENABLED=true
SCHEDULER_INTERVAL_MS=60000
SCHEDULER_MAX_RETRIES=3
SCHEDULER_RETRY_BACKOFF_MS=300000

# Sistema de Opt-out
OPT_OUT_ENABLED=true
OPT_OUT_KEYWORDS=PARAR,STOP,SAIR,CANCELAR
OPT_IN_KEYWORDS=VOLTAR,ATIVAR,SIM,QUERO

# Privacidade e Segurança
MASK_PII_IN_LOGS=true
LOG_RETENTION_DAYS=30
LOG_LEVEL=info

# Servidor
PORT=3000
NODE_ENV=production
```

### Instalação

```bash
# Instalar dependências
npm install

# Executar migrations
node scripts/run-migration.js

# Iniciar servidor
npm start
```

## 📊 Monitoramento

### Métricas
As métricas estão disponíveis no formato Prometheus em `/metrics` e podem ser coletadas por:
- Prometheus
- Grafana
- DataDog
- New Relic

### Logs
Todos os logs são estruturados em JSON e incluem:
- Timestamp
- Level (info, warn, error, debug)
- Request ID
- Contexto da operação
- Dados relevantes

### Alertas Recomendados
- Taxa de erro > 5%
- Tempo de resposta > 2s
- Falhas na API Trinks
- Conexões de banco indisponíveis

## 🔧 Endpoints Administrativos

Todos os endpoints administrativos requerem autenticação via header `X-Admin-Token`:

- `GET /admin` - Status do sistema
- `GET /admin/state/:phone` - Estado da conversa de um telefone
- `POST /admin/state/:phone` - Atualizar estado da conversa
- `GET /admin/states` - Listar todos os estados de conversa
- `POST /admin/sync-servicos` - Sincronizar serviços do Trinks

## 🏗️ Arquitetura

### Fluxo de Mensagens
1. Evolution API recebe mensagem do WhatsApp
2. Webhook processa e deduplica mensagem
3. Rate limiting e validação
4. Extração de intenção via LLM
5. Orquestração do diálogo
6. Integração com Trinks (se necessário)
7. Resposta via Evolution API

### Componentes
- **Server**: Express.js com middlewares de segurança avançados
- **Dialog Orchestrator**: Lógica conversacional e fluxos
- **Trinks Integration**: Cliente para API Trinks
- **Upsell Engine**: Sistema inteligente de ofertas contextuais
- **Message Scheduler**: Worker para mensagens automáticas
- **No-Show Shield**: Sistema de prevenção de faltas
- **Opt-out Service**: Gerenciamento de preferências do usuário
- **Evolution API Client**: Interface para envio de mensagens WhatsApp
- **Database**: PostgreSQL com Redis para cache
- **Metrics**: Prometheus para observabilidade completa
- **Health Checks**: Monitoramento de dependências
- **Security Layer**: Rate limiting, dedupe e mascaramento PII

## 📝 Desenvolvimento

### Testes
```bash
npm test
```

### Linting
```bash
npm run lint
```

### Build
```bash
npm run build
```

## 🤝 Contribuição

1. Fork o projeto
2. Crie uma branch para sua feature
3. Commit suas mudanças
4. Push para a branch
5. Abra um Pull Request

## 📄 Licença

Este projeto está sob a licença MIT.