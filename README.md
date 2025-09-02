# Ateliê Marcleia Abade - Sistema de Agendamento

Sistema de agendamento via WhatsApp integrado com a API Trinks, incluindo funcionalidades de segurança, observabilidade e performance.

## 🚀 Funcionalidades

### Agendamento via WhatsApp
- Processamento de mensagens via Evolution API
- Extração inteligente de intenções usando LLM (OpenAI)
- Fluxo conversacional para coleta de dados de agendamento
- Integração com API Trinks para criação de agendamentos
- Deduplicação de mensagens e idempotência

### Segurança e Autenticação
- **Autenticação Admin**: Middleware `adminAuth` com token `X-Admin-Token`
- **Rate Limiting**: Limitação de 60 requisições por minuto para rotas administrativas
- **Logs de Auditoria**: Registro de tentativas de acesso com IP, User-Agent e resultado

### Observabilidade

#### Logs Estruturados
- **Request ID**: Identificador único para cada requisição
- **Message ID**: Rastreamento de mensagens do WhatsApp
- **Contexto**: Logs com informações de tenant, telefone e etapa do processo

#### Métricas Prometheus
Disponíveis no endpoint `/metrics`:

- `conversations_started_total`: Contador de conversas iniciadas por tenant
- `service_suggestions_shown_total`: Contador de sugestões de serviços mostradas
- `bookings_confirmed_total`: Contador de agendamentos confirmados
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

# Trinks API
TRINKS_BASE_URL=https://api.trinks.com
TRINKS_API_KEY=your_trinks_api_key
TRINKS_ESTABELECIMENTO_ID=your_establishment_id

# OpenAI
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-3.5-turbo

# Segurança
ADMIN_TOKEN=your_secure_admin_token

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
- **Server**: Express.js com middlewares de segurança
- **Dialog Orchestrator**: Lógica conversacional e fluxos
- **Trinks Integration**: Cliente para API Trinks
- **Database**: PostgreSQL com Redis para cache
- **Metrics**: Prometheus para observabilidade
- **Health Checks**: Monitoramento de dependências

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