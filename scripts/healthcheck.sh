#!/bin/bash

# Script de Health Check para Pipeline CI/CD
# Uso: ./healthcheck.sh <URL> [TIMEOUT_SECONDS]

set -e

# Configurações
HEALTH_URL="${1:-http://localhost:3000/health}"
TIMEOUT="${2:-120}"
INTERVAL=5
MAX_ATTEMPTS=$((TIMEOUT / INTERVAL))

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Função para log com timestamp
log() {
    echo -e "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

# Função para verificar se URL está acessível
check_url_accessible() {
    local url="$1"
    if curl -s --head "$url" > /dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

# Função para fazer health check
do_health_check() {
    local url="$1"
    local response
    local http_code
    
    # Fazer requisição HTTP
    response=$(curl -s -w "\n%{http_code}" "$url" 2>/dev/null || echo "ERROR\n000")
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n -1)
    
    # Verificar código HTTP
    if [ "$http_code" != "200" ]; then
        log "${RED}❌ HTTP $http_code - Health check falhou${NC}"
        return 1
    fi
    
    # Verificar se resposta é JSON válido
    if ! echo "$body" | jq . > /dev/null 2>&1; then
        log "${RED}❌ Resposta não é JSON válido${NC}"
        return 1
    fi
    
    # Extrair status geral
    local status
    status=$(echo "$body" | jq -r '.status // "unknown"')
    
    if [ "$status" != "healthy" ]; then
        log "${RED}❌ Status não é 'healthy': $status${NC}"
        return 1
    fi
    
    # Verificar subchecks específicos
    local redis_check
    local postgres_check
    local evolution_check
    local trinks_check
    
    redis_check=$(echo "$body" | jq -r '.checks.redis // "unknown"')
    postgres_check=$(echo "$body" | jq -r '.checks.postgres // "unknown"')
    evolution_check=$(echo "$body" | jq -r '.checks.evolution // "unknown"')
    trinks_check=$(echo "$body" | jq -r '.checks.trinks // "unknown"')
    
    # Validar cada subcheck
    local all_checks_ok=true
    
    if [ "$redis_check" != "ok" ]; then
        log "${RED}❌ Redis check falhou: $redis_check${NC}"
        all_checks_ok=false
    fi
    
    if [ "$postgres_check" != "ok" ]; then
        log "${RED}❌ PostgreSQL check falhou: $postgres_check${NC}"
        all_checks_ok=false
    fi
    
    if [ "$evolution_check" != "ok" ]; then
        log "${YELLOW}⚠️ Evolution API check: $evolution_check${NC}"
        # Evolution API pode estar indisponível temporariamente
    fi
    
    if [ "$trinks_check" != "ok" ]; then
        log "${YELLOW}⚠️ Trinks API check: $trinks_check${NC}"
        # Trinks API pode estar indisponível temporariamente
    fi
    
    if [ "$all_checks_ok" = true ]; then
        log "${GREEN}✅ Health check passou - todos os serviços essenciais OK${NC}"
        return 0
    else
        log "${RED}❌ Health check falhou - serviços essenciais com problema${NC}"
        return 1
    fi
}

# Função principal
main() {
    log "${BLUE}🔍 Iniciando health check...${NC}"
    log "${BLUE}URL: $HEALTH_URL${NC}"
    log "${BLUE}Timeout: ${TIMEOUT}s (máximo $MAX_ATTEMPTS tentativas)${NC}"
    
    local attempt=1
    
    while [ $attempt -le $MAX_ATTEMPTS ]; do
        log "${BLUE}Tentativa $attempt/$MAX_ATTEMPTS...${NC}"
        
        # Verificar se URL está acessível
        if ! check_url_accessible "$HEALTH_URL"; then
            log "${YELLOW}⚠️ URL não acessível, aguardando ${INTERVAL}s...${NC}"
        else
            # Fazer health check
            if do_health_check "$HEALTH_URL"; then
                log "${GREEN}🎉 Health check concluído com sucesso!${NC}"
                exit 0
            else
                log "${YELLOW}⚠️ Health check falhou, aguardando ${INTERVAL}s...${NC}"
            fi
        fi
        
        if [ $attempt -lt $MAX_ATTEMPTS ]; then
            sleep $INTERVAL
        fi
        
        attempt=$((attempt + 1))
    done
    
    log "${RED}💥 Health check falhou após $MAX_ATTEMPTS tentativas (${TIMEOUT}s)${NC}"
    log "${RED}🔄 Iniciando rollback automático...${NC}"
    
    # Executar rollback se configurado
    if [ "$AUTO_ROLLBACK" = "true" ] || [ "$3" = "--auto-rollback" ]; then
        log "${YELLOW}🔄 Executando rollback do deployment...${NC}"
        
        if command -v kubectl > /dev/null 2>&1; then
            kubectl rollout undo deploy/marlie || {
                log "${RED}❌ Erro ao executar rollback via kubectl${NC}"
                exit 2
            }
            
            log "${BLUE}⏳ Aguardando rollback...${NC}"
            kubectl rollout status deploy/marlie --timeout=120s || {
                log "${RED}❌ Timeout no rollback${NC}"
                exit 2
            }
            
            log "${GREEN}✅ Rollback executado com sucesso${NC}"
        else
            log "${RED}❌ kubectl não encontrado - rollback manual necessário${NC}"
        fi
    fi
    
    exit 1
}

# Verificar dependências
if ! command -v curl > /dev/null 2>&1; then
    log "${RED}❌ curl não encontrado${NC}"
    exit 1
fi

if ! command -v jq > /dev/null 2>&1; then
    log "${RED}❌ jq não encontrado${NC}"
    exit 1
fi

# Executar função principal
main "$@"