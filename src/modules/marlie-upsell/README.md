# Módulo Marlie Upsell

> Sistema inteligente de upsell pós-agendamento com A/B testing e observabilidade completa

## 📋 Visão Geral

O **Marlie Upsell** é um módulo SaaS multi-tenant que implementa ofertas estratégicas de serviços adicionais após confirmações de agendamento. O sistema utiliza inteligência artificial, A/B testing e máquina de estados para maximizar a conversão e receita.

### 🎯 Objetivos de Negócio

- **Meta inicial**: Taxa de aceite ≥ 5% em 14 dias
- **Deduplicação**: 1 oferta por conversa (conversation_id)
- **Personalização**: A/B testing de copy e timing
- **Observabilidade**: Métricas completas de performance e receita

## 🏗️ Arquitetura

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Middleware    │───▶│  Upsell Service  │───▶│ State Machine   │
│   (Triggers)    │    │                  │    │   Integration   │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                        │                        │
         ▼                        ▼                        ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   WhatsApp      │    │   Scheduler      │    │    Database     │
│   Integration   │    │   (Delayed)      │    │   (PostgreSQL)  │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                        │                        │
         ▼                        ▼                        ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Trinks API    │    │   Admin Routes   │    │   Prometheus    │
│   (Catalog)     │    │   (Metrics)      │    │   (Metrics)     │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## 🚀 Funcionalidades

### ✅ Core Features

- **Deduplicação Inteligente**: Evita ofertas repetidas por conversation_id
- **A/B Testing**: Variantes de copy (A/B) e timing (imediato/+10min)
- **Processamento NLP**: Detecção automática de aceite/recusa
- **Agendamento Flexível**: Ofertas com delay configurável
- **Integração Trinks**: Adição automática de serviços ao agendamento
- **Observabilidade**: Métricas Prometheus e logs estruturados

### 🔧 Integrações

- **WhatsApp Business API**: Envio de mensagens e webhooks
- **Trinks API**: Catálogo de serviços e agendamentos
- **PostgreSQL**: Persistência de eventos e métricas
- **Redis**: Cache e deduplicação
- **Prometheus**: Métricas de performance e receita

## 📁 Estrutura do Projeto

```
src/modules/marlie-upsell/
├── index.ts                    # Ponto de entrada principal
├── types.ts                    # Interfaces e tipos TypeScript
├── README.md                   # Esta documentação
├── config/
│   └── upsell-state-machine.yaml  # Configuração da máquina de estados
├── services/
│   ├── upsell-service.ts       # Serviço principal de upsell
│   └── upsell-scheduler.ts     # Agendamento de ofertas
├── middleware/
│   └── upsell-trigger.ts       # Interceptação de eventos
├── integrations/
│   └── upsell-state-machine.ts # Integração com máquina de estados
├── routes/
│   └── upsell-admin.ts         # Rotas administrativas
├── database/
│   ├── upsell-schema.sql       # Schema do banco de dados
│   └── upsell-queries.ts       # Queries e operações de BD
└── tests/
    └── marlie-upsell.test.ts   # Testes automatizados
```

## 🛠️ Instalação e Configuração

### 1. Dependências

```bash
npm install js-yaml ioredis pg prometheus-client
npm install -D @types/js-yaml @types/pg
```

### 2. Variáveis de Ambiente

```env
# Upsell Configuration
UPSELL_ENABLED=true
UPSELL_DELAY_MIN=10
AB_TESTING_ENABLED=true

# Security
PII_MASKING_ENABLED=true
ENCRYPT_STORED_DATA=true
LOG_SENSITIVE_DATA=false

# Database
POSTGRES_URL=postgresql://user:pass@localhost:5432/marlie
REDIS_URL=redis://localhost:6379

# External APIs
TRINKS_API_URL=https://api.trinks.com
TRINKS_API_KEY=your_api_key
WHATSAPP_API_URL=https://api.whatsapp.com
WHATSAPP_TOKEN=your_token
```

### 3. Configuração do Banco de Dados

```sql
-- Executar o schema SQL
\i src/database/upsell-schema.sql
```

### 4. Inicialização

```typescript
import { createMarlieUpsellModule } from './src/modules/marlie-upsell';
import { Pool } from 'pg';
import Redis from 'ioredis';

const pgPool = new Pool({ connectionString: process.env.POSTGRES_URL });
const redis = new Redis(process.env.REDIS_URL);

const tools = {
  catalog: catalogService,
  trinks: trinksService,
  whatsapp: whatsappService,
  scheduler: schedulerService
};

const config = {
  env: {
    upsellEnabled: true,
    upsellDelayMin: 10,
    abTestingEnabled: true
  },
  // ... outras configurações
};

const upsellModule = await createMarlieUpsellModule(config, pgPool, redis, tools);

// Configurar middlewares
upsellModule.setupMiddlewares(app);
upsellModule.setupAdminRoutes(app);
```

## 📊 Métricas e Observabilidade

### Métricas Prometheus

```
# Contadores
upsell_shown_total{service,variant}           # Ofertas exibidas
upsell_accepted_total{service,variant}        # Ofertas aceitas
upsell_declined_total{service,variant}        # Ofertas recusadas
upsell_revenue_brl_total{service}             # Receita em BRL

# Gauges
upsell_active_sessions                        # Sessões ativas
upsell_conversion_rate{variant}               # Taxa de conversão

# Histogramas
upsell_processing_duration_seconds{variant}   # Tempo de processamento
```

### Endpoints Administrativos

```
GET  /admin/upsell/metrics          # Métricas gerais
GET  /admin/upsell/events           # Histórico de eventos
GET  /admin/upsell/revenue          # Relatório de receita
GET  /admin/upsell/performance      # Performance por variante
GET  /admin/upsell/health           # Status de saúde
POST /admin/upsell/test             # Teste manual
```

## 🧪 A/B Testing

### Variantes de Copy

**Variante A (Direta)**:
```
Dica rápida: **{{addon.nome}}** ({{addon.duracao}}min) por **{{addon.preco}}**. 
Quer adicionar ao seu atendimento? Responda **1**.
```

**Variante B (Benefício)**:
```
Potencialize seu resultado: **{{addon.nome}}** ({{addon.duracao}}min). 
Valor **{{addon.preco}}**. Deseja incluir? Responda **1**.
```

### Variantes de Timing

- **IMMEDIATE**: Oferta imediata após confirmação
- **DELAY10**: Oferta após 10 minutos

### Distribuição

- 50% para cada variante de copy
- 50% para cada variante de timing
- Combinações: A-IMMEDIATE, A-DELAY10, B-IMMEDIATE, B-DELAY10

## 🔒 Segurança e Compliance

### Proteção de Dados

- **PII Masking**: Mascaramento automático de dados sensíveis
- **Criptografia**: Dados sensíveis criptografados no banco
- **LGPD**: Compliance com regulamentações de privacidade
- **Logs Seguros**: Exclusão de dados sensíveis dos logs

### Autenticação

- **Admin Routes**: Autenticação obrigatória
- **API Keys**: Validação de chaves para integrações
- **Rate Limiting**: Proteção contra abuso

## 🧪 Testes

### Executar Testes

```bash
# Todos os testes
npm test src/tests/marlie-upsell.test.ts

# Testes específicos
npm test -- --grep "A/B Testing"
npm test -- --grep "Deduplication"
npm test -- --grep "Metrics"
```

### Cobertura de Testes

- ✅ A/B Testing e distribuição de variantes
- ✅ Deduplicação por conversation_id
- ✅ Processamento de respostas NLP
- ✅ Agendamento e retry de ofertas
- ✅ Integração com APIs externas
- ✅ Métricas e observabilidade
- ✅ Tratamento de erros
- ✅ Testes de aceitação end-to-end

## 📈 Monitoramento

### Dashboards Recomendados

1. **Conversão**:
   - Taxa de aceite por variante
   - Receita por período
   - Funil de conversão

2. **Performance**:
   - Tempo de resposta
   - Erros por endpoint
   - Sessões ativas

3. **Negócio**:
   - Receita incremental
   - Serviços mais vendidos
   - Performance por tenant

### Alertas

```yaml
# Prometheus Alerts
groups:
  - name: marlie-upsell
    rules:
      - alert: UpsellConversionLow
        expr: rate(upsell_accepted_total[24h]) / rate(upsell_shown_total[24h]) < 0.05
        for: 1h
        labels:
          severity: warning
        annotations:
          summary: "Taxa de conversão de upsell abaixo da meta"
      
      - alert: UpsellServiceDown
        expr: up{job="marlie-upsell"} == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Serviço de upsell indisponível"
```

## 🚀 Deploy

### Docker

```dockerfile
# Dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

### Docker Compose

```yaml
version: '3.8'
services:
  marlie-upsell:
    build: .
    environment:
      - POSTGRES_URL=postgresql://postgres:password@db:5432/marlie
      - REDIS_URL=redis://redis:6379
    depends_on:
      - db
      - redis
    ports:
      - "3000:3000"
  
  db:
    image: postgres:15
    environment:
      POSTGRES_DB: marlie
      POSTGRES_PASSWORD: password
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./src/database/upsell-schema.sql:/docker-entrypoint-initdb.d/init.sql
  
  redis:
    image: redis:7-alpine
    
volumes:
  postgres_data:
```

### Railway Deploy

```bash
# Instalar Railway CLI
npm install -g @railway/cli

# Login e deploy
railway login
railway link
railway up
```

## 📚 API Reference

### Trigger Manual

```typescript
// Disparar upsell manualmente
const result = await upsellModule.triggerUpsell({
  conversationId: 'conv_123',
  phone: '+5511999999999',
  appointmentId: 'apt_456',
  primaryServiceId: 'svc_789',
  tenantId: 'tenant_001'
});

console.log(result);
// {
//   success: true,
//   addon: {
//     id: 'addon_123',
//     nome: 'Hidratação Capilar',
//     preco: 'R$ 45,00',
//     duracao: 30
//   }
// }
```

### Processar Resposta

```typescript
// Processar resposta do usuário
const response = await upsellModule.processUpsellResponse({
  conversationId: 'conv_123',
  phone: '+5511999999999',
  message: '1',
  timestamp: new Date()
});

console.log(response);
// {
//   success: true,
//   action: 'accepted',
//   message: 'Serviço adicionado com sucesso'
// }
```

### Métricas

```typescript
// Obter métricas
const metrics = await upsellModule.getMetrics();
console.log(metrics);
// {
//   service: { shown: 150, accepted: 12, declined: 45 },
//   database: { events: 207, revenue: 540.00 },
//   scheduler: { active: 3, completed: 204 }
// }
```

## 🤝 Contribuição

### Desenvolvimento

1. Clone o repositório
2. Instale dependências: `npm install`
3. Configure variáveis de ambiente
4. Execute testes: `npm test`
5. Inicie desenvolvimento: `npm run dev`

### Padrões de Código

- **TypeScript**: Tipagem estrita
- **ESLint**: Linting automático
- **Prettier**: Formatação consistente
- **Conventional Commits**: Mensagens padronizadas

## 📄 Licença

Este projeto é propriedade da **SyncBelle** e está licenciado sob termos proprietários.

---

**Versão**: 1.0.0  
**Última atualização**: Janeiro 2025  
**Mantido por**: SyncBelle Dev Team