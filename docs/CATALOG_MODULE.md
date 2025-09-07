# Módulo Marlie-Catalog

## Visão Geral

O **Módulo Marlie-Catalog** é responsável pela sincronização e normalização do catálogo de serviços da API Trinks para a base de dados local. Este módulo garante que os dados estejam sempre atualizados, normalizados e otimizados para busca e seleção pelos usuários.

## Características Principais

- **Sincronização Incremental**: Busca apenas dados modificados desde a última sincronização
- **Normalização Inteligente**: Padroniza nomes de serviços e categorias para melhor busca
- **Idempotência**: Operações seguras que podem ser executadas múltiplas vezes
- **Desambiguação por Popularidade**: Ordena resultados baseado em agendamentos recentes
- **Desambiguação Inteligente**: Resolve entradas ambíguas com opções populares (ver [CATALOG_DISAMBIGUATION.md](./CATALOG_DISAMBIGUATION.md))
- **Integração com Máquina de Estados**: Intercepta automaticamente fluxos que precisam de desambiguação
- **Relatórios de Diferença**: Detecta discrepâncias entre dados locais e remotos
- **Scheduler Automático**: Execução programada de sincronizações e limpezas

## Arquitetura

### Componentes Principais

```
┌─────────────────────────────────────────────────────────────┐
│                    Módulo Marlie-Catalog                   │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │ CatalogScheduler│  │ CatalogSyncServ │  │ CatalogTrinks│ │
│  │                 │  │                 │  │ Service     │ │
│  │ - Cron Jobs     │  │ - Normalização  │  │ - API Client│ │
│  │ - Backfill      │  │ - Upsert        │  │ - Health    │ │
│  │ - Cleanup       │  │ - Watermarks    │  │ - Pagination│ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │ Disambiguation  │  │ StateMachine    │  │ Middleware  │ │
│  │ Service         │  │ Integration     │  │ Integration │ │
│  │ - NLP Patterns  │  │ - Interceptors  │  │ - Auto Hook │ │
│  │ - Top3 Popular  │  │ - State Trans.  │  │ - Session   │ │
│  │ - Session Mgmt  │  │ - Context Pass  │  │ - Response  │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │   PostgreSQL    │  │      Redis      │  │ Trinks API  │ │
│  │                 │  │                 │  │             │ │
│  │ - servicos_prof │  │ - Locks         │  │ - Catálogo  │ │
│  │ - watermarks    │  │ - Cache         │  │ - Serviços  │ │
│  │ - snapshots     │  │ - Metrics       │  │ - Profiss.  │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Estados e Fluxos

```mermaid
graph TD
    A[Inicialização] --> B{Módulo Habilitado?}
    B -->|Não| C[Módulo Desabilitado]
    B -->|Sim| D[Carregar Configuração]
    D --> E[Verificar Dependências]
    E --> F{Dependências OK?}
    F -->|Não| G[Erro de Inicialização]
    F -->|Sim| H[Inicializar Serviços]
    H --> I{Backfill Habilitado?}
    I -->|Sim| J[Executar Backfill]
    I -->|Não| K[Iniciar Scheduler]
    J --> K
    K --> L[Módulo Ativo]
    
    L --> M[Sincronização Incremental]
    M --> N[Normalizar Dados]
    N --> O[Upsert no Banco]
    O --> P[Atualizar Watermark]
    P --> L
    
    L --> Q[Snapshot Diário]
    Q --> R[Gerar Relatório Diff]
    R --> L
    
    L --> S[Limpeza Semanal]
    S --> T[Remover Dados Antigos]
    T --> L
```

## Configuração

### Variáveis de Ambiente

Copie o arquivo `.env.catalog.example` para `.env` e configure:

```bash
# Configurações obrigatórias
CATALOG_MODULE_ENABLED=true
TRINKS_CATALOG_API_URL=https://api.trinks.com.br
TRINKS_CATALOG_API_TOKEN=your_token_here
DATABASE_URL=postgresql://user:pass@localhost:5432/marlie
REDIS_URL=redis://localhost:6379

# Configurações de sincronização
CATALOG_SYNC_CRON="15 */1 * * *"  # A cada hora
CATALOG_SNAPSHOT_CRON="0 2 * * *"  # Diariamente às 2h
CATALOG_CLEANUP_CRON="0 3 * * 0"   # Domingo às 3h

# Configurações de busca
CATALOG_DEFAULT_TOP_N=3
CATALOG_SIMILARITY_THRESHOLD=0.3

# Desambiguação
CATALOG_DISAMBIGUATION_ENABLED=true
CATALOG_DISAMBIGUATION_CACHE_TTL=1800
CATALOG_DISAMBIGUATION_SESSION_TTL=300
CATALOG_DISAMBIGUATION_TOP_N=3
CATALOG_DISAMBIGUATION_POPULARITY_DAYS=30
```

### Configuração YAML

O arquivo `src/config/catalog-config.yaml` contém configurações detalhadas:

```yaml
module:
  name: "marlie-catalog"
  version: "1.0"
  language: "pt-BR"

sync:
  schedule_cron: "15 */1 * * *"
  backfill_on_boot: true
  page_size: 100
  
normalize:
  enabled: true
  synonyms:
    progressiva: "escova progressiva"
    luzes: "mechas/luzes"
```

### Configuração de Desambiguação

Arquivo `src/config/catalog-disambiguation.yaml` (ver [documentação completa](./CATALOG_DISAMBIGUATION.md)):

```yaml
nlp:
  patterns:
    numeric_1_3: ['^\\s*[1-3]\\s*$']
    category_ambiguous:
      - '(?i)\bcabelo(s)?\b'
      - '(?i)\b(unha|manicure|pedicure)\b'
      - '(?i)\bsobrancelh(a|as)\b'

responses:
  top3_prompt: |
    Encontrei estas opções mais populares dos últimos 30 dias:
    1) {{top3.0.nome}} — {{top3.0.duracao}}min — {{top3.0.preco}}
    2) {{top3.1.nome}} — {{top3.1.duracao}}min — {{top3.1.preco}}
    3) {{top3.2.nome}} — {{top3.2.duracao}}min — {{top3.2.preco}}
    Responda com **1**, **2** ou **3**.
```

## Uso

### Inicialização

```typescript
import { 
  initializeCatalog, 
  getCatalogModule,
  createCatalogStateMachineMiddleware 
} from './src/init-catalog';

// Inicializar o módulo (inclui desambiguação)
const result = await initializeCatalog();
if (result.success) {
  console.log('Módulo de catálogo inicializado');
} else {
  console.error('Erro:', result.message);
}

// Obter instância do módulo
const catalogModule = getCatalogModule();
const syncService = catalogModule.getSyncService();
const disambigService = catalogModule.getDisambiguationService();

// Aplicar middleware de integração com máquina de estados
app.use('/api/chat', createCatalogStateMachineMiddleware());
```

### Sincronização Manual

```typescript
// Sincronização completa
const watermark = '2024-01-01T00:00:00Z';
await syncService.triggerFullSync(watermark);

// Buscar serviços por categoria
const topServices = await syncService.getTopServicesByCategory(
  'cabelo', 
  3
);

// Busca textual
const searchResults = await syncService.searchServices(
  'corte progressiva',
  5
);

// Desambiguação de entrada ambígua
if (disambigService.isAmbiguous('cabelo')) {
  const result = await disambigService.startDisambiguation('cabelo', {
    sessionId: 'user-123',
    currentState: 'COLLECT_SERVICE_INFO'
  });
  console.log('Opções de desambiguação:', result.response);
}
```

### Middleware Express

```typescript
import express from 'express';
import { catalogMiddleware } from './src/init-catalog';
import catalogRoutes from './src/routes/admin-catalog';

const app = express();

// Aplicar middleware
app.use('/admin/catalog', catalogMiddleware());
app.use('/admin', catalogRoutes);
```

## API Administrativa

### Endpoints Disponíveis

#### Sincronização

```http
# Sincronização completa
POST /admin/sync/servicos
Authorization: Bearer {CATALOG_ADMIN_TOKEN}
Content-Type: application/json

{
  "updated_since_iso": "2024-01-01T00:00:00Z"
}
```

#### Relatórios

```http
# Relatório de diferenças
POST /admin/sync/diff
Authorization: Bearer {CATALOG_ADMIN_TOKEN}
Content-Type: application/json

{
  "as_of_date": "2024-01-15"
}
```

#### Busca

```http
# Buscar serviços
GET /admin/catalog/search?term=corte&limit=5
Authorization: Bearer {CATALOG_ADMIN_TOKEN}

# Top serviços por categoria
GET /admin/catalog/top-category?category=cabelo&limit=3
Authorization: Bearer {CATALOG_ADMIN_TOKEN}
```

#### Status

```http
# Status da sincronização
GET /admin/sync/status
Authorization: Bearer {CATALOG_ADMIN_TOKEN}

# Estatísticas do catálogo
GET /admin/catalog/stats
Authorization: Bearer {CATALOG_ADMIN_TOKEN}

# Health check
GET /admin/catalog/health
Authorization: Bearer {CATALOG_ADMIN_TOKEN}
```

#### Desambiguação

```http
# Estatísticas de desambiguação
GET /admin/catalog/disambiguation/stats
Authorization: Bearer {CATALOG_ADMIN_TOKEN}

# Testar desambiguação
POST /admin/catalog/disambiguation/test
Authorization: Bearer {CATALOG_ADMIN_TOKEN}
Content-Type: application/json

{
  "input": "cabelo",
  "context": {
    "sessionId": "test-123",
    "currentState": "COLLECT_SERVICE_INFO"
  }
}

# Limpar cache de desambiguação
DELETE /admin/catalog/disambiguation/cache
Authorization: Bearer {CATALOG_ADMIN_TOKEN}

# Limpar sessões ativas
DELETE /admin/catalog/disambiguation/sessions
Authorization: Bearer {CATALOG_ADMIN_TOKEN}

# Categorias populares
GET /admin/catalog/disambiguation/popular-categories?days=30&limit=10
Authorization: Bearer {CATALOG_ADMIN_TOKEN}

# Padrões ambíguos configurados
GET /admin/catalog/disambiguation/ambiguous-patterns
Authorization: Bearer {CATALOG_ADMIN_TOKEN}
```

> **Nota**: Para documentação completa da desambiguação, consulte [CATALOG_DISAMBIGUATION.md](./CATALOG_DISAMBIGUATION.md)

## Normalização de Dados

### Processo de Normalização

1. **Lowercase**: Converte para minúsculas
2. **Trim**: Remove espaços extras
3. **Remove Accents**: Remove acentos e caracteres especiais
4. **Collapse Spaces**: Reduz múltiplos espaços para um
5. **Strip Symbols**: Remove símbolos configurados
6. **Map Synonyms**: Aplica mapeamento de sinônimos

### Exemplos

```
Original: "Escova / Progressiva • Cabelo"
Normalizado: "escova progressiva cabelo"

Original: "Luzes & Mechas"
Normalizado: "mechas/luzes"

Original: "Pé e Mão"
Normalizado: "manicure e pedicure"
```

## Banco de Dados

### Tabelas Principais

#### servicos_prof
```sql
CREATE TABLE servicos_prof (
  id SERIAL PRIMARY KEY,
  profissionalid INTEGER NOT NULL,
  servicoid INTEGER NOT NULL,
  nomeservico VARCHAR(255) NOT NULL,
  nomeservico_normalizado VARCHAR(255),
  categoria VARCHAR(100),
  categoria_normalizada VARCHAR(100),
  preco DECIMAL(10,2),
  duracao INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(profissionalid, servicoid)
);
```

#### sync_watermarks
```sql
CREATE TABLE sync_watermarks (
  id SERIAL PRIMARY KEY,
  sync_type VARCHAR(50) NOT NULL,
  last_sync_at TIMESTAMP NOT NULL,
  watermark_value TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### Índices de Performance

```sql
-- Índices para busca textual
CREATE INDEX idx_servicos_prof_nome_gin 
  ON servicos_prof USING gin(nomeservico_normalizado gin_trgm_ops);

CREATE INDEX idx_servicos_prof_categoria_gin 
  ON servicos_prof USING gin(categoria_normalizada gin_trgm_ops);

-- Índices para consultas frequentes
CREATE INDEX idx_servicos_prof_categoria_btree 
  ON servicos_prof(categoria_normalizada);

CREATE INDEX idx_servicos_prof_updated_at 
  ON servicos_prof(updated_at DESC);
```

## Monitoramento

### Métricas Disponíveis

- **Sincronizações**: Total, sucessos, falhas
- **Performance**: Tempo de sincronização, registros processados
- **Qualidade**: Registros normalizados, duplicatas detectadas
- **API**: Latência, rate limiting, erros

### Health Checks

```typescript
// Verificar saúde do módulo
const health = await getCatalogHealth();

/*
Retorna:
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00Z",
  "services": {
    "database": "healthy",
    "redis": "healthy",
    "trinks_api": "healthy",
    "scheduler": "healthy"
  },
  "config": {
    "module": "marlie-catalog",
    "version": "1.0"
  }
}
*/
```

### Logs

O módulo gera logs estruturados em JSON:

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "level": "info",
  "module": "CatalogSyncService",
  "message": "Sincronização concluída",
  "metadata": {
    "processed_records": 1250,
    "duration_ms": 5432,
    "watermark": "2024-01-15T10:25:00Z"
  }
}
```

## Troubleshooting

### Problemas Comuns

#### Erro de Conexão com API Trinks
```
Erro: ECONNREFUSED - Connection refused
```
**Solução**: Verificar `TRINKS_CATALOG_API_URL` e conectividade de rede.

#### Timeout na Sincronização
```
Erro: Timeout after 30000ms
```
**Solução**: Aumentar `TRINKS_API_TIMEOUT` ou reduzir `CATALOG_SYNC_PAGE_SIZE`.

#### Lock de Sincronização
```
Erro: Sync already in progress
```
**Solução**: Aguardar conclusão ou limpar lock manualmente no Redis.

#### Dados Não Normalizados
```
Warning: Normalization failed for service
```
**Solução**: Verificar configuração de sinônimos e símbolos.

### Comandos de Debug

```bash
# Verificar status do módulo
curl -H "Authorization: Bearer $CATALOG_ADMIN_TOKEN" \
  http://localhost:3000/admin/catalog/health

# Forçar sincronização
curl -X POST -H "Authorization: Bearer $CATALOG_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"updated_since_iso":"2024-01-01T00:00:00Z"}' \
  http://localhost:3000/admin/sync/servicos

# Verificar logs
docker logs marlie-app | grep "CatalogModule"
```

### Limpeza Manual

```sql
-- Limpar dados de sincronização
DELETE FROM sync_watermarks WHERE sync_type = 'catalog';

-- Recriar índices
REINDEX INDEX idx_servicos_prof_nome_gin;

-- Verificar integridade
SELECT COUNT(*) as total, 
       COUNT(DISTINCT profissionalid, servicoid) as unique_pairs
FROM servicos_prof;
```

## Desenvolvimento

### Estrutura de Arquivos

```
src/
├── config/
│   └── catalog-config.yaml      # Configuração YAML
├── services/
│   ├── catalog-sync.ts          # Serviço de sincronização
│   ├── catalog-trinks-service.ts # Cliente API Trinks
│   └── catalog-scheduler.ts     # Agendador de tarefas
├── routes/
│   └── admin-catalog.ts         # Rotas administrativas
├── db/migrations/
│   └── 20240101000000_create_catalog_tables.sql
└── init-catalog.ts              # Inicializador principal
```

### Testes

```typescript
// Teste de sincronização
import { CatalogSyncService } from '../services/catalog-sync';

describe('CatalogSyncService', () => {
  it('should normalize service names', async () => {
    const normalized = await syncService.normalizeServiceName(
      'Escova / Progressiva • Cabelo'
    );
    expect(normalized).toBe('escova progressiva cabelo');
  });
});
```

### Contribuição

1. **Fork** o repositório
2. **Crie** uma branch para sua feature
3. **Implemente** seguindo os padrões do código
4. **Teste** suas alterações
5. **Documente** mudanças na configuração
6. **Submeta** um Pull Request

### Padrões de Código

- Use **TypeScript** com tipagem rigorosa
- Implemente **tratamento de erros** adequado
- Adicione **logs estruturados** para debugging
- Mantenha **compatibilidade** com configurações existentes
- Documente **mudanças na API** administrativa

## Roadmap

### Versão 1.1
- [ ] Cache inteligente com invalidação automática
- [ ] Métricas avançadas com Prometheus
- [ ] Alertas configuráveis via webhook
- [ ] Interface web para administração

### Versão 1.2
- [ ] Sincronização em tempo real via WebSocket
- [ ] Machine Learning para melhor normalização
- [ ] API GraphQL para consultas complexas
- [ ] Backup automático de configurações

### Versão 2.0
- [ ] Suporte a múltiplas fontes de dados
- [ ] Federação de catálogos
- [ ] Versionamento de dados
- [ ] Auditoria completa de mudanças

## Suporte

Para suporte técnico:

- **Documentação**: Este arquivo e comentários no código
- **Logs**: Verificar logs estruturados da aplicação
- **Health Check**: Endpoint `/admin/catalog/health`
- **Issues**: Criar issue no repositório do projeto

---

**Desenvolvido por**: SyncBelle Dev  
**Versão**: 1.0  
**Última atualização**: Janeiro 2024