# Configuração da Evolution API para SyncBelle

Este guia detalha como configurar corretamente a Evolution API para integração com o sistema SyncBelle.

## 📋 Pré-requisitos

- Evolution API instalada e funcionando
- Acesso administrativo à Evolution API
- URL pública do seu sistema SyncBelle (ex: Railway, VPS)

## 🔧 Configuração das Variáveis de Ambiente

### 1. Variáveis Essenciais da Evolution API

```bash
# URL base da sua Evolution API
EVOLUTION_BASE_URL=https://sua-evolution-api.com

# Chave de API para autenticação
EVOLUTION_API_KEY=sua_chave_api

# Nome da instância do WhatsApp
EVOLUTION_INSTANCE=syncbelle_instance
```

### 2. Configuração do Webhook

```bash
# URL do seu sistema para receber webhooks
WEBHOOK_URL=https://seu-app.railway.app/webhooks/evolution

# URL do servidor para callbacks internos
SERVER_URL=https://seu-app.railway.app
```

### 3. Configurações de Sessão

```bash
# Nome exibido na conexão do smartphone
CONFIG_SESSION_PHONE_CLIENT=Ateliê Marcleia Abade

# Nome do navegador exibido
CONFIG_SESSION_PHONE_NAME=Chrome
```

### 4. Configurações de WebSocket

```bash
# Habilitar WebSocket para eventos em tempo real
WEBSOCKET_ENABLED=true
WEBSOCKET_GLOBAL_EVENTS=true
```

### 5. Configurações de Log

```bash
# Níveis de log recomendados
LOG_LEVEL=ERROR,WARN,DEBUG,INFO,LOG,VERBOSE,DARK,WEBHOOKS
LOG_COLOR=true
LOG_BAILEYS=error
```

### 6. Armazenamento Temporário

```bash
# Configurações para armazenar dados temporariamente
STORE_MESSAGES=true
STORE_MESSAGE_UP=true
STORE_CONTACTS=true
STORE_CHATS=true
```

### 7. Armazenamento Persistente

```bash
# Habilitar persistência no banco de dados
DATABASE_ENABLED=true
DATABASE_SAVE_DATA_INSTANCE=true
DATABASE_SAVE_DATA_NEW_MESSAGE=true
DATABASE_SAVE_MESSAGE_UPDATE=true
DATABASE_SAVE_DATA_CONTACTS=true
DATABASE_SAVE_DATA_CHATS=true
```

### 8. Cache Redis (Opcional)

```bash
# Configuração do Redis para cache
CACHE_REDIS_ENABLED=false  # Desabilitado por padrão
CACHE_REDIS_URI=redis://localhost:6379
CACHE_REDIS_PREFIX_KEY=syncbelle
CACHE_REDIS_TTL=604800

# Cache local como alternativa
CACHE_LOCAL_ENABLED=true
CACHE_LOCAL_TTL=604800
```

## 🚀 Configuração na Evolution API

### 1. Criar Instância

```bash
curl -X POST \
  https://sua-evolution-api.com/instance/create \
  -H 'Content-Type: application/json' \
  -H 'apikey: sua_chave_api' \
  -d '{
    "instanceName": "syncbelle_instance",
    "token": "token_opcional",
    "qrcode": true,
    "webhookUrl": "https://seu-app.railway.app/webhooks/evolution",
    "webhookByEvents": false,
    "webhookBase64": false,
    "events": [
      "APPLICATION_STARTUP",
      "QRCODE_UPDATED",
      "MESSAGES_UPSERT",
      "MESSAGES_UPDATE",
      "MESSAGES_DELETE",
      "SEND_MESSAGE",
      "CONTACTS_SET",
      "CONTACTS_UPSERT",
      "CONTACTS_UPDATE",
      "PRESENCE_UPDATE",
      "CHATS_SET",
      "CHATS_UPSERT",
      "CHATS_UPDATE",
      "CHATS_DELETE",
      "GROUPS_UPSERT",
      "GROUP_UPDATE",
      "GROUP_PARTICIPANTS_UPDATE",
      "CONNECTION_UPDATE"
    ]
  }'
```

### 2. Configurar Webhook

```bash
curl -X POST \
  https://sua-evolution-api.com/webhook/set/syncbelle_instance \
  -H 'Content-Type: application/json' \
  -H 'apikey: sua_chave_api' \
  -d '{
    "url": "https://seu-app.railway.app/webhooks/evolution",
    "enabled": true,
    "events": [
      "MESSAGES_UPSERT",
      "MESSAGES_UPDATE",
      "CONNECTION_UPDATE"
    ]
  }'
```

### 3. Conectar WhatsApp

```bash
# Obter QR Code
curl -X GET \
  https://sua-evolution-api.com/instance/connect/syncbelle_instance \
  -H 'apikey: sua_chave_api'
```

## 📱 Formato de Mensagens Recebidas

O webhook receberá mensagens no seguinte formato:

```json
{
  "event": "messages.upsert",
  "instance": "syncbelle_instance",
  "data": {
    "key": {
      "remoteJid": "5571981533737@s.whatsapp.net",
      "fromMe": false,
      "id": "message_id"
    },
    "message": {
      "conversation": "Olá, gostaria de agendar um horário"
    },
    "messageTimestamp": 1640995200,
    "pushName": "Nome do Cliente"
  }
}
```

## 🔍 Monitoramento e Logs

### Verificar Status da Instância

```bash
curl -X GET \
  https://sua-evolution-api.com/instance/fetchInstances \
  -H 'apikey: sua_chave_api'
```

### Verificar Conexão

```bash
curl -X GET \
  https://sua-evolution-api.com/instance/connectionState/syncbelle_instance \
  -H 'apikey: sua_chave_api'
```

## 🛠️ Troubleshooting

### Problemas Comuns

1. **Webhook não recebe mensagens**
   - Verificar se a URL está acessível publicamente
   - Confirmar se o webhook está configurado corretamente
   - Verificar logs da Evolution API

2. **Instância desconecta frequentemente**
   - Verificar configurações de sessão
   - Confirmar se o telefone está conectado à internet
   - Revisar logs de conexão

3. **Mensagens não são processadas**
   - Verificar formato do payload recebido
   - Confirmar se os eventos estão configurados
   - Verificar logs do sistema SyncBelle

### Logs Úteis

```bash
# Logs da Evolution API
LOG_LEVEL=ERROR,WARN,DEBUG,INFO,LOG,VERBOSE,DARK,WEBHOOKS

# Logs específicos do Baileys (WhatsApp Web)
LOG_BAILEYS=error
```

## 📚 Referências

- [Documentação Evolution API](https://doc.evolution-api.com/v1/pt/env)
- [Repositório GitHub](https://github.com/EvolutionAPI/evolution-api)
- [Arquivo .env.example](https://github.com/EvolutionAPI/evolution-api/blob/main/.env.example)

## 🔐 Segurança

- Mantenha suas chaves de API seguras
- Use HTTPS para todas as comunicações
- Configure rate limiting se necessário
- Monitore logs regularmente para detectar anomalias