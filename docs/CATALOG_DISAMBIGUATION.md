# Desambiguação Orientada por Catálogo

## Visão Geral

O sistema de **Desambiguação Orientada por Catálogo** é uma extensão do módulo Marlie-Catalog que resolve entradas ambíguas do usuário usando dados de popularidade dos serviços. Quando um usuário digita termos como "cabelo" ou "unha", o sistema apresenta as opções mais populares dos últimos 30 dias para facilitar a escolha.

## 🎯 Características Principais

- **Detecção Automática de Ambiguidade**: Usa padrões NLP para identificar entradas ambíguas
- **Popularidade Baseada em Dados**: Ordena opções por agendamentos dos últimos 30 dias
- **Integração com Máquina de Estados**: Intercepta automaticamente fluxos que precisam de desambiguação
- **Sessões Persistentes**: Mantém contexto da desambiguação no Redis
- **Escolhas Numéricas**: Interface simples com opções 1, 2, 3
- **Fallback Inteligente**: Permite entrada manual quando necessário
- **Métricas Completas**: Observabilidade via Prometheus

## 🏗️ Arquitetura

### Componentes

```
┌─────────────────────────────────────────────────────────────────┐
│                    Sistema de Desambiguação                    │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────┐  ┌─────────────────────────────────┐  │
│  │ DisambiguationServ  │  │ DisambiguationMiddleware        │  │
│  │                     │  │                                 │  │
│  │ - Padrões NLP       │  │ - Sessões Redis                 │  │
│  │ - Busca Popularidade│  │ - Estados da Máquina            │  │
│  │ - Normalização      │  │ - Persistência de Slots         │  │
│  │ - Cache             │  │ - Métricas                      │  │
│  └─────────────────────┘  └─────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────┐  ┌─────────────────────────────────┐  │
│  │ StateMachineInteg   │  │ Admin API                       │  │
│  │                     │  │                                 │  │
│  │ - Interceptação     │  │ - Testes de Desambiguação       │  │
│  │ - Transições        │  │ - Estatísticas                  │  │
│  │ - Contexto          │  │ - Limpeza de Cache/Sessões      │  │
│  │ - Métricas          │  │ - Padrões Ambíguos             │  │
│  └─────────────────────┘  └─────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Fluxo de Desambiguação

```mermaid
graph TD
    A[Usuário: "cabelo"] --> B{É Ambíguo?}
    B -->|Não| C[Continuar Fluxo Normal]
    B -->|Sim| D[Buscar Top-3 por Popularidade]
    D --> E[Apresentar Opções Numeradas]
    E --> F[Estado: CATALOG_WAIT_CHOICE]
    F --> G{Escolha Válida?}
    G -->|Não| H[Erro: "Responda 1, 2 ou 3"]
    H --> F
    G -->|Sim| I[Persistir Escolha em Slots]
    I --> J[Confirmar: "Anotei X para seguirmos"]
    J --> K[Retornar ao Fluxo Principal]
    
    style A fill:#e1f5fe
    style E fill:#fff3e0
    style I fill:#e8f5e8
    style K fill:#f3e5f5
```

## 🔧 Configuração

### Variáveis de Ambiente

```bash
# Habilitar desambiguação
CATALOG_DISAMBIGUATION_ENABLED=true

# Cache e sessões
CATALOG_DISAMBIGUATION_CACHE_TTL=1800  # 30 minutos
CATALOG_DISAMBIGUATION_SESSION_TTL=300 # 5 minutos

# Busca
CATALOG_DISAMBIGUATION_TOP_N=3
CATALOG_DISAMBIGUATION_POPULARITY_DAYS=30
```

### Configuração YAML

Arquivo `src/config/catalog-disambiguation.yaml`:

```yaml
nlp:
  patterns:
    numeric_1_3: ['^\s*[1-3]\s*$']
    category_ambiguous:
      - '(?i)\bcabelo(s)?\b'
      - '(?i)\b(unha|manicure|pedicure)\b'
      - '(?i)\bsobrancelh(a|as)\b'
      - '(?i)\bmaquiagem\b'
      - '(?i)\bescova(s)?\b'

responses:
  top3_prompt: |
    Encontrei estas opções mais populares dos últimos 30 dias:
    1) {{top3.0.nome}} — {{top3.0.duracao}}min — {{top3.0.preco}}
    2) {{top3.1.nome}} — {{top3.1.duracao}}min — {{top3.1.preco}}
    3) {{top3.2.nome}} — {{top3.2.duracao}}min — {{top3.2.preco}}
    Responda com **1**, **2** ou **3**.
    
  invalid_choice: "Não entendi. Responda com **1**, **2** ou **3**."
  persisted_ok: "Perfeito! Anotei **{{slots.service_name}}** para seguirmos. ✅"

state_machine:
  states:
    CATALOG_DISAMBIGUATION:
      description: "Resolve entradas ambíguas com base em popularidade (30d)."
      on_enter:
        - set:
            cat_norm: "{{normalize_servico_nome(input.text || slots.category || '')}}"
        - if: "{{nlp.match(patterns.category_ambiguous, input.text)}}"
          then:
            - tool: "db.topn_by_category_30d"
              args: { categoria_norm: "{{cat_norm}}", n: 3 }
              save_as: "top3"
          else:
            - tool: "db.search_like"
              args: { term_norm: "{{cat_norm}}", n: 3 }
              save_as: "top3"
        - reply: { template: "top3_prompt" }
        - transition: "CATALOG_WAIT_CHOICE"

    CATALOG_WAIT_CHOICE:
      on_user_message:
        - if: "{{nlp.match(patterns.numeric_1_3, input.text)}}"
          then:
            - set:
                idx: "{{to_int(trim(input.text)) - 1}}"
                choice: "{{top3[idx]}}"
            - set_slots:
                service_id: "{{choice.id}}"
                service_name: "{{choice.nome}}"
                service_norm: "{{normalize_servico_nome(choice.nome)}}"
            - reply: { template: "persisted_ok" }
            - transition: "RETURN_TO_FLOW"
          else:
            - reply: { template: "invalid_choice" }
            - stay: true
```

## 🚀 Uso

### Inicialização

```typescript
import { 
  initializeCatalogModule,
  createCatalogStateMachineMiddleware 
} from './src/init-catalog';

// Inicializar módulo completo (inclui desambiguação)
await initializeCatalogModule();

// Aplicar middleware de integração
app.use('/api/chat', createCatalogStateMachineMiddleware());
```

### Uso Direto do Serviço

```typescript
import { getCatalogDisambiguationService } from './src/services/catalog-disambiguation-service';

const service = getCatalogDisambiguationService();

// Verificar se entrada é ambígua
const isAmbiguous = service.isAmbiguous('cabelo');
console.log(isAmbiguous); // true

// Iniciar desambiguação
if (isAmbiguous) {
  const result = await service.startDisambiguation('cabelo', {
    sessionId: 'user-123',
    currentState: 'COLLECT_SERVICE_INFO'
  });
  
  console.log(result.response);
  // "Encontrei estas opções mais populares dos últimos 30 dias:
  //  1) Corte Feminino — 45min — R$ 35,00
  //  2) Escova Progressiva — 120min — R$ 80,00
  //  3) Hidratação Capilar — 60min — R$ 25,00
  //  Responda com **1**, **2** ou **3**."
  
  // Processar escolha
  const choice = await service.processNumericChoice(
    'user-123',
    '2', // Usuário escolheu opção 2
    result.options
  );
  
  console.log(choice.selectedService.nome); // "Escova Progressiva"
}
```

### Integração com Middleware

```typescript
import { getDisambiguationMiddleware } from './src/middleware/catalog-disambiguation-middleware';

const middleware = getDisambiguationMiddleware();

// Verificar sessão ativa
const hasSession = await middleware.hasActiveSession('user-123');

if (hasSession) {
  // Processar no contexto da desambiguação
  const result = await middleware.processDisambiguationState(
    'user-123',
    '2', // Escolha do usuário
    {
      currentState: 'CATALOG_WAIT_CHOICE',
      slots: { category: 'cabelo' },
      metadata: {}
    }
  );
  
  console.log(result.nextState); // 'RETURN_TO_FLOW'
  console.log(result.slots.service_name); // 'Escova Progressiva'
}
```

## 📊 API Administrativa

### Endpoints de Desambiguação

```bash
# Estatísticas
GET /admin/catalog/disambiguation/stats

# Testar desambiguação
POST /admin/catalog/disambiguation/test
{
  "input": "cabelo",
  "context": { "sessionId": "test-123" }
}

# Limpar cache
DELETE /admin/catalog/disambiguation/cache?pattern=disambiguation:*

# Limpar sessões
DELETE /admin/catalog/disambiguation/sessions

# Categorias populares
GET /admin/catalog/disambiguation/popular-categories?days=30&limit=10

# Padrões ambíguos
GET /admin/catalog/disambiguation/ambiguous-patterns
```

### Exemplos de Uso da API

```bash
# Testar entrada ambígua
curl -X POST http://localhost:3000/admin/catalog/disambiguation/test \
  -H "Authorization: Bearer admin_token" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "cabelo",
    "context": {
      "sessionId": "test-session-123",
      "currentState": "COLLECT_SERVICE_INFO"
    }
  }'

# Resposta:
{
  "status": "success",
  "data": {
    "input": {
      "original": "cabelo",
      "normalized": "cabelo",
      "is_ambiguous": true
    },
    "search_results": [
      {
        "id": "srv_001",
        "nome": "Corte Feminino",
        "duracao": 45,
        "preco": "35.00",
        "popularity_score": 0.85
      }
    ],
    "disambiguation_result": {
      "response": "Encontrei estas opções...",
      "options": [...],
      "sessionId": "test-session-123"
    }
  }
}

# Obter estatísticas
curl "http://localhost:3000/admin/catalog/disambiguation/stats" \
  -H "Authorization: Bearer admin_token"

# Resposta:
{
  "status": "success",
  "data": {
    "service": {
      "cache_hits": 1250,
      "cache_misses": 180,
      "total_disambiguations": 430,
      "avg_options_presented": 2.8
    },
    "middleware": {
      "active_sessions": 12,
      "total_sessions_created": 890,
      "avg_session_duration_ms": 45000
    }
  }
}
```

## 🔍 Processo de Normalização

O sistema aplica normalização em várias etapas:

### 1. Limpeza Básica
```typescript
// Remove acentos e caracteres especiais
"Côrte de cabêlo!" → "corte de cabelo"
```

### 2. Aplicação de Sinônimos
```typescript
// Baseado em catalog-config.yaml
"progressiva" → "escova progressiva"
"luzes" → "mechas/luzes"
```

### 3. Remoção de Stop Words
```typescript
// Remove palavras comuns
"fazer uma escova" → "escova"
"corte de cabelo" → "corte cabelo"
```

### 4. Normalização de Categoria
```typescript
// Padroniza para busca
"CABELO" → "cabelo"
"Unha/Manicure" → "unha manicure"
```

## 📈 Métricas e Observabilidade

### Métricas Prometheus

```yaml
# Contadores
catalog_disambig_prompts_total{category="cabelo"} 45
catalog_numeric_choices_total{index="2"} 28
catalog_choice_persisted_total 42

# Gauges
catalog_disambiguation_active_sessions 8
catalog_last_watermark_seconds 1234567890

# Summaries
catalog_search_match_ratio_sum 0.85
catalog_disambiguation_duration_seconds_sum 2.3
```

### Logs Estruturados

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "level": "info",
  "message": "Desambiguação iniciada",
  "sessionId": "user-123",
  "input": "cabelo",
  "normalized": "cabelo",
  "optionsFound": 3,
  "popularityPeriod": "30d"
}

{
  "timestamp": "2024-01-15T10:30:15Z",
  "level": "info",
  "message": "Escolha processada",
  "sessionId": "user-123",
  "choice": "2",
  "selectedService": "Escova Progressiva",
  "duration_ms": 15000
}
```

## 🧪 Testes

### Testes de Aceitação

```typescript
// Teste: Entrada ambígua gera top-3
const result = await service.startDisambiguation('cabelo', context);
assert(result.options.length === 3);
assert(result.response.includes('1)'));
assert(result.response.includes('2)'));
assert(result.response.includes('3)'));

// Teste: Escolha numérica persiste slots
const choice = await service.processNumericChoice('session', '2', options);
assert(choice.slots.service_id !== null);
assert(choice.slots.service_name !== '');

// Teste: Entrada inválida mantém estado
const invalid = await middleware.processDisambiguationState(
  'session', 
  'abc', 
  { currentState: 'CATALOG_WAIT_CHOICE' }
);
assert(invalid.nextState === 'CATALOG_WAIT_CHOICE');
assert(invalid.response.includes('Responda com'));
```

### Cenários de Teste

| Entrada | Esperado | Resultado |
|---------|----------|----------|
| "cabelo" | 3 opções populares | ✅ |
| "corte masculino" | Busca específica | ✅ |
| "2" (em contexto) | Escolha da opção 2 | ✅ |
| "xyz" | Entrada inválida | ✅ |
| "unha" | 3 opções de manicure | ✅ |

## 🔧 Troubleshooting

### Problemas Comuns

**1. Desambiguação não ativa**
```bash
# Verificar configuração
curl /admin/catalog/health

# Verificar logs
tail -f logs/catalog.log | grep disambiguation
```

**2. Sessões não persistem**
```bash
# Verificar Redis
redis-cli keys "disambiguation:*"

# Verificar TTL
redis-cli ttl "disambiguation:session:user-123"
```

**3. Padrões não funcionam**
```bash
# Testar padrão específico
curl -X POST /admin/catalog/disambiguation/test \
  -d '{"input": "cabelo"}'

# Verificar configuração YAML
cat src/config/catalog-disambiguation.yaml
```

### Comandos de Debug

```bash
# Limpar tudo e reiniciar
curl -X DELETE /admin/catalog/disambiguation/cache
curl -X DELETE /admin/catalog/disambiguation/sessions

# Verificar métricas
curl /metrics | grep catalog_disambig

# Testar entrada específica
node -e "
  const service = require('./src/services/catalog-disambiguation-service');
  console.log(service.getCatalogDisambiguationService().isAmbiguous('cabelo'));
"
```

## 🚀 Roadmap

### Versão 1.1
- [ ] Suporte a múltiplas línguas
- [ ] Aprendizado de padrões via ML
- [ ] Cache distribuído

### Versão 1.2
- [ ] Desambiguação por localização
- [ ] Integração com histórico do usuário
- [ ] A/B testing de templates

### Versão 2.0
- [ ] Desambiguação por voz
- [ ] Sugestões proativas
- [ ] Analytics avançados

## 📞 Suporte

- **Documentação**: `/docs/CATALOG_MODULE.md`
- **Exemplos**: `/examples/catalog-disambiguation-usage.ts`
- **Issues**: GitHub Issues
- **Logs**: `logs/catalog-disambiguation.log`
- **Métricas**: `/metrics` (Prometheus)
- **Health Check**: `/admin/catalog/health`