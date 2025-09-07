# Testes de Integração - SyncBelle

Este diretório contém testes de integração completos para validar os fluxos end-to-end do sistema SyncBelle.

## Estrutura dos Testes

### 📁 Arquivos de Teste

- **`complete-flows.test.ts`** - Testes dos fluxos principais completos
- **`edge-cases.test.ts`** - Testes de casos extremos e recuperação de falhas
- **`rls.spec.ts`** - Testes de segurança em nível de linha (RLS)

### 🎯 Cobertura dos Testes

#### Fluxos Principais (`complete-flows.test.ts`)

1. **Menu Determinístico → Agendamento**
   - Apresentação do menu no primeiro contato
   - Processamento de escolhas (1-Agendar, 2-Informações)
   - Desambiguação de serviços
   - Validação de disponibilidade
   - Confirmação de agendamento

2. **Menu Determinístico → Informações**
   - Fornecimento de informações sobre serviços
   - Busca de preços e detalhes
   - Consulta de horários de funcionamento

3. **Validação de Entradas**
   - Rejeição de entradas inválidas
   - Solicitação de opções válidas
   - Validação de escolhas na desambiguação

4. **Buffer Temporal**
   - Agrupamento de mensagens quebradas
   - TTL de 30 segundos no Redis
   - Processamento como mensagem única

5. **Human Handoff**
   - Ativação via flag `HUMAN_OVERRIDE`
   - Transferência para atendente humano
   - Persistência da flag no Redis

6. **Templates de Resposta**
   - Uso de variáveis dinâmicas
   - Personalização com dados do usuário
   - Templates configuráveis

7. **Estado Persistente**
   - Manutenção de estado entre interações
   - Recuperação após reinicialização
   - Isolamento entre usuários

8. **Métricas e Observabilidade**
   - Registro de métricas Prometheus
   - Logs estruturados
   - Monitoramento de performance

#### Casos Extremos (`edge-cases.test.ts`)

1. **Falhas de Infraestrutura**
   - Redis indisponível
   - Banco de dados offline
   - API Trinks com falha
   - OpenAI API limit exceeded

2. **Entradas Maliciosas**
   - JSON malformado
   - Mensagens extremamente longas
   - Caracteres especiais e emojis
   - Tentativas de SQL injection
   - Números de telefone inválidos

3. **Cenários de Concorrência**
   - Múltiplas mensagens simultâneas
   - Isolamento entre usuários
   - Race conditions

4. **Limites e Rate Limiting**
   - Muitas mensagens em sequência
   - Timeout de operações longas
   - Throttling de requisições

5. **Recuperação de Estado**
   - Estado após reinicialização
   - Estado corrompido
   - Fallback para estado inicial

6. **Validação de Dados**
   - Datas inválidas
   - Horários inválidos
   - Formatos incorretos

7. **Monitoramento**
   - Registro de erros
   - Métricas com falhas parciais
   - Alertas de sistema

## 🚀 Como Executar

### Pré-requisitos

```bash
# Instalar dependências
npm install

# Configurar variáveis de ambiente
cp .env.example .env.test
```

### Comandos de Teste

```bash
# Executar todos os testes de integração
npm run test:integration

# Executar com watch mode
npm run test:integration:watch

# Executar com cobertura
npm run test:integration:coverage

# Executar apenas fluxos principais
npm run test:flows

# Executar apenas edge cases
npm run test:edge-cases

# Executar testes unitários + integração
npm run test:all

# Pipeline CI/CD
npm run test:ci
```

### Execução Individual

```bash
# Fluxos completos
jest --config jest.integration.config.js complete-flows.test.ts

# Edge cases
jest --config jest.integration.config.js edge-cases.test.ts

# RLS (segurança)
jest --config jest.integration.config.js rls.spec.ts
```

## 🔧 Configuração

### Variáveis de Ambiente

```env
# Teste
NODE_ENV=test
TENANT_ID=test-tenant
ADMIN_TOKEN=test-admin-token

# Redis (Mock)
REDIS_URL=redis://localhost:6379

# Database (Mock)
DATABASE_URL=postgresql://test:test@localhost:5432/test

# APIs Externas (Mock)
TRINKS_API_URL=https://api.trinks.test
OPENAI_API_KEY=test-key
```

### Jest Configuration

O arquivo `jest.integration.config.js` contém:

- **Timeout**: 30 segundos para operações longas
- **Workers**: 1 (execução sequencial)
- **Setup**: Configuração de mocks globais
- **Coverage**: Relatórios detalhados
- **Sequencer**: Ordem otimizada de execução

## 🎭 Mocks e Simulações

### Redis Mock
- Simula operações Redis em memória
- TTL e expiração de chaves
- Modo de falha configurável
- Listas e operações complexas

### Database Mock
- Tabelas simuladas em memória
- Consultas SQL básicas
- Transações e rollbacks
- Modo de falha configurável

### API Mocks
- **Trinks API**: Serviços, agendamentos, horários
- **OpenAI API**: Respostas e classificações
- **Rate limiting**: Simulação de limites
- **Timeouts**: Operações lentas

## 📊 Métricas e Relatórios

### Cobertura de Código
```bash
# Gerar relatório de cobertura
npm run test:integration:coverage

# Visualizar no navegador
open coverage/integration/lcov-report/index.html
```

### Métricas de Performance
- Tempo de resposta por fluxo
- Throughput de mensagens
- Uso de memória
- Operações de I/O

### Logs Estruturados
```json
{
  "level": "info",
  "message": "Integration test completed",
  "test": "complete-flows",
  "duration": 1250,
  "assertions": 45,
  "timestamp": "2024-01-20T10:30:00.000Z"
}
```

## 🐛 Debugging

### Logs Detalhados
```bash
# Executar com logs verbose
DEBUG=* npm run test:integration

# Logs específicos
DEBUG=marlie:* npm run test:integration
```

### Breakpoints
```bash
# Executar com debugger
node --inspect-brk node_modules/.bin/jest --config jest.integration.config.js --runInBand
```

### Análise de Falhas
```bash
# Executar teste específico com detalhes
jest --config jest.integration.config.js --verbose --no-cache complete-flows.test.ts
```

## 🔄 CI/CD Integration

### GitHub Actions
```yaml
- name: Run Integration Tests
  run: |
    npm ci
    npm run test:ci
  env:
    NODE_ENV: test
    TENANT_ID: test-tenant
```

### Pipeline Local
```bash
# Simular pipeline CI
npm run test:ci
```

## 📈 Monitoramento Contínuo

### Alertas de Falha
- Testes falhando > 5%
- Performance degradada > 2s
- Cobertura < 80%

### Métricas de Qualidade
- **Flakiness**: < 1% de testes instáveis
- **Coverage**: > 85% de cobertura
- **Performance**: < 1.5s por fluxo

## 🤝 Contribuindo

### Adicionando Novos Testes

1. **Fluxos Principais**: Adicionar em `complete-flows.test.ts`
2. **Edge Cases**: Adicionar em `edge-cases.test.ts`
3. **Segurança**: Adicionar em `rls.spec.ts`

### Padrões de Código

```typescript
describe('Novo Fluxo', () => {
  it('deve comportar-se conforme esperado', async () => {
    const phone = '+5511999999999';
    
    const response = await request(app)
      .post('/webhook')
      .send({ phone, message: 'teste' });
    
    expect(response.status).toBe(200);
    expect(response.body.message).toContain('esperado');
  });
});
```

### Checklist de PR

- [ ] Testes passando localmente
- [ ] Cobertura mantida > 85%
- [ ] Performance < 2s por teste
- [ ] Documentação atualizada
- [ ] Mocks apropriados
- [ ] Cleanup adequado

---

**Desenvolvido por SyncBelle Dev Team** 🚀