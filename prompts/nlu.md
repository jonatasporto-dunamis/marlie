# Política de NLU - SyncBelle

## Objetivo
O sistema de NLU (Natural Language Understanding) deve extrair informações estruturadas de mensagens de usuários em português brasileiro, especificamente com variações da Bahia.

## Formato de Resposta
**CRÍTICO**: O NLU deve retornar **EXCLUSIVAMENTE JSON** válido, sem qualquer texto adicional, explicação ou formatação markdown.

### Schema JSON Obrigatório
```json
{
  "intent": "string",
  "serviceName": "string",
  "dateRel": "string",
  "dateISO": "string",
  "period": "string",
  "timeISO": "string",
  "professionalName": "string"
}
```

**REGRAS DE SCHEMA**:
- Todos os campos são opcionais EXCETO `intent`
- Omitir campos não identificados (não incluir null/undefined)
- JSON deve ser válido e parseável
- Sem comentários no JSON de resposta

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

**Entrada**: "Oxe, dá pra entre 14 e 15?"
**Saída**:
```json
{
  "intent": "agendar",
  "timeISO": "14:00"
}
```

**Entrada**: "Beleza, lá pras 16h tá massa"
**Saída**:
```json
{
  "intent": "confirmar",
  "timeISO": "16:00"
}
```

**Entrada**: "Num rola cedim não, mais tardinha"
**Saída**:
```json
{
  "intent": "negar",
  "period": "tarde"
}
```

**Entrada**: "Eita, depois do almoço pode ser?"
**Saída**:
```json
{
  "intent": "agendar",
  "period": "tarde"
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
### Expressões Temporais
- "cedinho" / "cedim" = manhã cedo (period: "manhã")
- "finalzinho" / "finalzim" = final do período
- "mais pra" = aproximadamente
- "noitinha" / "noitim" = início da noite
- "tardinha" / "tardim" = final da tarde
- "entre X e Y" = faixa de horário
- "lá pras" = aproximadamente (ex: "lá pras 14h")
- "ali pelas" = aproximadamente
- "depois do almoço" = tarde
- "antes do almoço" = manhã

### Confirmações e Negações
- "tá bom" / "tá certo" = confirmação
- "dá pra" / "dá pra ser" = é possível
- "pode ser" = confirmação
- "beleza" / "blz" = confirmação
- "massa" = confirmação
- "não rola" / "num rola" = negação
- "não dá" / "num dá" = negação

### Expressões Regionais (ignorar)
- "oxe" / "oxente" = surpresa
- "vixe" / "vish" = preocupação
- "eita" = surpresa
- "rapaz" / "meu rei" / "minha fia" = vocativos
- "sô" = contração de "senhor"
- "véi" = "velho" (amigo)

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