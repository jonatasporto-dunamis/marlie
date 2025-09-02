# Política de NLU - SyncBelle

## Objetivo
O sistema de NLU (Natural Language Understanding) deve extrair informações estruturadas de mensagens de usuários em português brasileiro, especificamente com variações da Bahia.

## Formato de Resposta
**IMPORTANTE**: O NLU deve retornar **SOMENTE JSON** válido, sem texto adicional para o usuário.

### Schema JSON Obrigatório
```json
{
  "intent": "string", // obrigatório
  "serviceName": "string?", // opcional
  "dateRel": "string?", // opcional - termos relativos como "amanhã", "hoje"
  "dateISO": "string?", // opcional - formato YYYY-MM-DD
  "period": "string?", // opcional - "manhã", "tarde", "noite"
  "timeISO": "string?", // opcional - formato HH:MM
  "professionalName": "string?", // opcional
  "action": "string?" // opcional - "remarcar", "cancelar", "preço", "endereço"
}
```

### Intents Principais
- `agendar` - usuário quer agendar um serviço
- `remarcar` - usuário quer remarcar agendamento existente
- `cancelar` - usuário quer cancelar agendamento
- `consultar_preco` - usuário quer saber preço de serviço
- `consultar_endereco` - usuário quer localização/endereço
- `confirmar` - usuário confirma uma proposta
- `negar` - usuário nega uma proposta
- `saudacao` - cumprimentos iniciais
- `outros` - quando não se encaixa nas categorias acima

### Mapeamento de Períodos
- **manhã**: 09:00-12:00
- **tarde**: 13:30-17:30  
- **noite**: 18:00-20:00

### Serviços Populares (Few-shot)
- cutilagem
- esmaltação
- progressiva
- design de sobrancelha
- manicure
- pedicure
- hidratação
- escova
- corte
- coloração
- luzes
- babyliss
- chapinha

## Exemplos de Entrada e Saída

### Agendamento Básico
**Entrada**: "Quero fazer uma cutilagem amanhã de tarde"
**Saída**:
```json
{
  "intent": "agendar",
  "serviceName": "cutilagem",
  "dateRel": "amanhã",
  "period": "tarde"
}
```

### Horário Específico
**Entrada**: "Dá pra amanhã às 14:30?"
**Saída**:
```json
{
  "intent": "agendar",
  "dateRel": "amanhã",
  "timeISO": "14:30"
}
```

### Gírias Baianas
**Entrada**: "Dá pra amanhã cedinho?"
**Saída**:
```json
{
  "intent": "agendar",
  "dateRel": "amanhã",
  "period": "manhã"
}
```

**Entrada**: "Finalzinho da tarde tá bom"
**Saída**:
```json
{
  "intent": "confirmar",
  "period": "tarde"
}
```

**Entrada**: "Mais pra noitinha"
**Saída**:
```json
{
  "intent": "agendar",
  "period": "noite"
}
```

### Consultas
**Entrada**: "Qual valor da cutilagem?"
**Saída**:
```json
{
  "intent": "consultar_preco",
  "serviceName": "cutilagem"
}
```

**Entrada**: "Onde vocês ficam?"
**Saída**:
```json
{
  "intent": "consultar_endereco"
}
```

### Ações Especiais
**Entrada**: "Quero remarcar"
**Saída**:
```json
{
  "intent": "remarcar",
  "action": "remarcar"
}
```

**Entrada**: "Preciso cancelar"
**Saída**:
```json
{
  "intent": "cancelar",
  "action": "cancelar"
}
```

### Profissional Específico
**Entrada**: "Quero com a Maria amanhã"
**Saída**:
```json
{
  "intent": "agendar",
  "dateRel": "amanhã",
  "professionalName": "Maria"
}
```

## Variações Regionais (Bahia)
- "cedinho" = manhã cedo
- "finalzinho" = final do período
- "mais pra" = aproximadamente
- "tá bom" = confirmação
- "dá pra" = é possível
- "oxe" = expressão de surpresa (ignorar)
- "vixe" = expressão de preocupação (ignorar)

## Regras Importantes
1. **Sempre retornar JSON válido**
2. **Nunca incluir texto explicativo**
3. **Campos opcionais podem ser omitidos se não identificados**
4. **Priorizar intent mais específico quando ambíguo**
5. **Normalizar nomes de serviços para lowercase**
6. **Considerar contexto da conversa quando disponível**

## Tratamento de Ambiguidade
- Se múltiplos serviços mencionados, escolher o primeiro
- Se horário ambíguo, priorizar período sobre horário específico
- Se data ambígua, assumir próxima ocorrência
- Em caso de dúvida, usar intent "outros"