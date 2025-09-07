-- Schema do banco de dados para o módulo marlie-upsell
-- Versão: 1.0
-- Descrição: Tabelas para tracking de eventos, agendamentos e métricas de upsell

-- Extensões necessárias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Tabela principal de eventos de upsell
CREATE TABLE IF NOT EXISTS upsell_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id VARCHAR(50) NOT NULL,
    conversation_id VARCHAR(255) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    event VARCHAR(50) NOT NULL CHECK (event IN ('shown', 'accepted', 'declined', 'scheduled', 'error')),
    
    -- Dados do addon oferecido
    addon_id VARCHAR(100),
    addon_name VARCHAR(255),
    addon_price_brl DECIMAL(10,2),
    addon_duration_min INTEGER,
    
    -- Dados do agendamento principal
    appointment_id VARCHAR(100),
    primary_service_id VARCHAR(100),
    customer_name VARCHAR(255),
    
    -- Variantes do teste A/B
    variant_copy VARCHAR(10) CHECK (variant_copy IN ('A', 'B')),
    variant_position VARCHAR(20) CHECK (variant_position IN ('IMMEDIATE', 'DELAY10')),
    
    -- Metadados
    response_text TEXT, -- Resposta do cliente (para análise)
    processing_time_ms INTEGER, -- Tempo de processamento
    error_message TEXT, -- Mensagem de erro se aplicável
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE,
    
    -- Índices para performance
    CONSTRAINT upsell_events_tenant_conversation_idx UNIQUE (tenant_id, conversation_id, event, created_at)
);

-- Índices para otimização de consultas
CREATE INDEX IF NOT EXISTS idx_upsell_events_tenant_date ON upsell_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_upsell_events_conversation ON upsell_events (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_upsell_events_phone ON upsell_events (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_upsell_events_event_variant ON upsell_events (event, variant_copy, variant_position);
CREATE INDEX IF NOT EXISTS idx_upsell_events_addon ON upsell_events (addon_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_upsell_events_service ON upsell_events (primary_service_id, created_at DESC);

-- Tabela de jobs agendados
CREATE TABLE IF NOT EXISTS upsell_scheduled_jobs (
    id VARCHAR(100) PRIMARY KEY,
    tenant_id VARCHAR(50) NOT NULL,
    conversation_id VARCHAR(255) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    
    -- Dados do agendamento
    appointment_id VARCHAR(100) NOT NULL,
    primary_service_id VARCHAR(100) NOT NULL,
    customer_name VARCHAR(255),
    
    -- Agendamento
    scheduled_for TIMESTAMP WITH TIME ZONE NOT NULL,
    
    -- Variantes
    variant_copy VARCHAR(10) NOT NULL CHECK (variant_copy IN ('A', 'B')),
    variant_position VARCHAR(20) NOT NULL CHECK (variant_position IN ('IMMEDIATE', 'DELAY10')),
    
    -- Controle de execução
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_attempt_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    
    -- Erro
    error_message TEXT
);

-- Índices para jobs agendados
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_tenant_status ON upsell_scheduled_jobs (tenant_id, status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_conversation ON upsell_scheduled_jobs (conversation_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_scheduled_for ON upsell_scheduled_jobs (scheduled_for) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_cleanup ON upsell_scheduled_jobs (created_at, status);

-- Tabela de configurações por tenant
CREATE TABLE IF NOT EXISTS upsell_config (
    tenant_id VARCHAR(50) PRIMARY KEY,
    
    -- Configurações gerais
    enabled BOOLEAN DEFAULT true,
    delay_min INTEGER DEFAULT 10,
    
    -- Pesos do teste A/B
    copy_a_weight DECIMAL(3,2) DEFAULT 0.5 CHECK (copy_a_weight >= 0 AND copy_a_weight <= 1),
    position_immediate_weight DECIMAL(3,2) DEFAULT 0.5 CHECK (position_immediate_weight >= 0 AND position_immediate_weight <= 1),
    
    -- Configurações de segurança
    auth_token_hash VARCHAR(255),
    pii_masking_enabled BOOLEAN DEFAULT true,
    
    -- Templates de resposta
    copy_a_template TEXT,
    copy_b_template TEXT,
    confirm_added_template TEXT,
    added_pending_template TEXT,
    declined_template TEXT,
    
    -- Padrões NLP
    accept_patterns JSONB,
    decline_patterns JSONB,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tabela de métricas agregadas (para performance)
CREATE TABLE IF NOT EXISTS upsell_metrics_daily (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id VARCHAR(50) NOT NULL,
    date DATE NOT NULL,
    
    -- Métricas por variante
    variant_copy VARCHAR(10),
    variant_position VARCHAR(20),
    
    -- Contadores
    total_shown INTEGER DEFAULT 0,
    total_accepted INTEGER DEFAULT 0,
    total_declined INTEGER DEFAULT 0,
    total_scheduled INTEGER DEFAULT 0,
    total_errors INTEGER DEFAULT 0,
    
    -- Receita
    total_revenue_brl DECIMAL(12,2) DEFAULT 0,
    avg_addon_price_brl DECIMAL(10,2),
    
    -- Performance
    avg_processing_time_ms INTEGER,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT upsell_metrics_daily_unique UNIQUE (tenant_id, date, variant_copy, variant_position)
);

-- Índices para métricas
CREATE INDEX IF NOT EXISTS idx_metrics_daily_tenant_date ON upsell_metrics_daily (tenant_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_daily_variant ON upsell_metrics_daily (variant_copy, variant_position, date DESC);

-- Tabela de deduplicação (evitar múltiplos upsells por conversa)
CREATE TABLE IF NOT EXISTS upsell_conversation_state (
    conversation_id VARCHAR(255) PRIMARY KEY,
    tenant_id VARCHAR(50) NOT NULL,
    
    -- Estado da conversa
    has_upsell_shown BOOLEAN DEFAULT false,
    upsell_shown_at TIMESTAMP WITH TIME ZONE,
    
    -- Último evento
    last_event VARCHAR(50),
    last_event_at TIMESTAMP WITH TIME ZONE,
    
    -- Dados do último upsell
    last_addon_id VARCHAR(100),
    last_variant_copy VARCHAR(10),
    last_variant_position VARCHAR(20),
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Índices para estado da conversa
CREATE INDEX IF NOT EXISTS idx_conversation_state_tenant ON upsell_conversation_state (tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_state_shown ON upsell_conversation_state (has_upsell_shown, upsell_shown_at);

-- Views para relatórios

-- View de conversão por período
CREATE OR REPLACE VIEW upsell_conversion_report AS
SELECT 
    tenant_id,
    DATE_TRUNC('day', created_at) as date,
    variant_copy,
    variant_position,
    COUNT(*) FILTER (WHERE event = 'shown') as shown_count,
    COUNT(*) FILTER (WHERE event = 'accepted') as accepted_count,
    COUNT(*) FILTER (WHERE event = 'declined') as declined_count,
    ROUND(
        (COUNT(*) FILTER (WHERE event = 'accepted')::DECIMAL / 
         NULLIF(COUNT(*) FILTER (WHERE event = 'shown'), 0)) * 100, 2
    ) as conversion_rate_percent,
    SUM(addon_price_brl) FILTER (WHERE event = 'accepted') as total_revenue_brl,
    AVG(addon_price_brl) FILTER (WHERE event = 'accepted') as avg_addon_price_brl
FROM upsell_events 
WHERE event IN ('shown', 'accepted', 'declined')
GROUP BY tenant_id, DATE_TRUNC('day', created_at), variant_copy, variant_position
ORDER BY date DESC, tenant_id;

-- View de performance por serviço
CREATE OR REPLACE VIEW upsell_service_performance AS
SELECT 
    tenant_id,
    primary_service_id,
    addon_id,
    addon_name,
    COUNT(*) FILTER (WHERE event = 'shown') as shown_count,
    COUNT(*) FILTER (WHERE event = 'accepted') as accepted_count,
    ROUND(
        (COUNT(*) FILTER (WHERE event = 'accepted')::DECIMAL / 
         NULLIF(COUNT(*) FILTER (WHERE event = 'shown'), 0)) * 100, 2
    ) as conversion_rate_percent,
    SUM(addon_price_brl) FILTER (WHERE event = 'accepted') as total_revenue_brl,
    AVG(processing_time_ms) as avg_processing_time_ms
FROM upsell_events 
WHERE event IN ('shown', 'accepted', 'declined')
  AND primary_service_id IS NOT NULL
  AND addon_id IS NOT NULL
GROUP BY tenant_id, primary_service_id, addon_id, addon_name
HAVING COUNT(*) FILTER (WHERE event = 'shown') >= 5 -- Mínimo de 5 exibições
ORDER BY conversion_rate_percent DESC, total_revenue_brl DESC;

-- Triggers para atualização automática de métricas

-- Função para atualizar métricas diárias
CREATE OR REPLACE FUNCTION update_upsell_daily_metrics()
RETURNS TRIGGER AS $$
BEGIN
    -- Atualizar métricas diárias
    INSERT INTO upsell_metrics_daily (
        tenant_id, date, variant_copy, variant_position,
        total_shown, total_accepted, total_declined, total_scheduled, total_errors,
        total_revenue_brl, avg_addon_price_brl, avg_processing_time_ms
    )
    SELECT 
        NEW.tenant_id,
        DATE(NEW.created_at),
        NEW.variant_copy,
        NEW.variant_position,
        COUNT(*) FILTER (WHERE event = 'shown'),
        COUNT(*) FILTER (WHERE event = 'accepted'),
        COUNT(*) FILTER (WHERE event = 'declined'),
        COUNT(*) FILTER (WHERE event = 'scheduled'),
        COUNT(*) FILTER (WHERE event = 'error'),
        SUM(addon_price_brl) FILTER (WHERE event = 'accepted'),
        AVG(addon_price_brl) FILTER (WHERE event = 'accepted'),
        AVG(processing_time_ms)
    FROM upsell_events
    WHERE tenant_id = NEW.tenant_id
      AND DATE(created_at) = DATE(NEW.created_at)
      AND variant_copy = NEW.variant_copy
      AND variant_position = NEW.variant_position
    GROUP BY tenant_id, DATE(created_at), variant_copy, variant_position
    ON CONFLICT (tenant_id, date, variant_copy, variant_position)
    DO UPDATE SET
        total_shown = EXCLUDED.total_shown,
        total_accepted = EXCLUDED.total_accepted,
        total_declined = EXCLUDED.total_declined,
        total_scheduled = EXCLUDED.total_scheduled,
        total_errors = EXCLUDED.total_errors,
        total_revenue_brl = EXCLUDED.total_revenue_brl,
        avg_addon_price_brl = EXCLUDED.avg_addon_price_brl,
        avg_processing_time_ms = EXCLUDED.avg_processing_time_ms,
        updated_at = NOW();
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para atualizar métricas
CREATE TRIGGER trigger_update_upsell_metrics
    AFTER INSERT ON upsell_events
    FOR EACH ROW
    EXECUTE FUNCTION update_upsell_daily_metrics();

-- Função para atualizar estado da conversa
CREATE OR REPLACE FUNCTION update_conversation_state()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO upsell_conversation_state (
        conversation_id, tenant_id, has_upsell_shown, upsell_shown_at,
        last_event, last_event_at, last_addon_id, last_variant_copy, last_variant_position
    )
    VALUES (
        NEW.conversation_id, NEW.tenant_id, 
        (NEW.event = 'shown'), 
        CASE WHEN NEW.event = 'shown' THEN NEW.created_at ELSE NULL END,
        NEW.event, NEW.created_at, NEW.addon_id, NEW.variant_copy, NEW.variant_position
    )
    ON CONFLICT (conversation_id)
    DO UPDATE SET
        has_upsell_shown = CASE 
            WHEN NEW.event = 'shown' THEN true 
            ELSE upsell_conversation_state.has_upsell_shown 
        END,
        upsell_shown_at = CASE 
            WHEN NEW.event = 'shown' THEN NEW.created_at 
            ELSE upsell_conversation_state.upsell_shown_at 
        END,
        last_event = NEW.event,
        last_event_at = NEW.created_at,
        last_addon_id = NEW.addon_id,
        last_variant_copy = NEW.variant_copy,
        last_variant_position = NEW.variant_position,
        updated_at = NOW();
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para atualizar estado da conversa
CREATE TRIGGER trigger_update_conversation_state
    AFTER INSERT ON upsell_events
    FOR EACH ROW
    EXECUTE FUNCTION update_conversation_state();

-- Função para limpeza de dados antigos
CREATE OR REPLACE FUNCTION cleanup_old_upsell_data(days_to_keep INTEGER DEFAULT 90)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER := 0;
    cutoff_date TIMESTAMP WITH TIME ZONE;
BEGIN
    cutoff_date := NOW() - (days_to_keep || ' days')::INTERVAL;
    
    -- Limpar jobs antigos
    DELETE FROM upsell_scheduled_jobs 
    WHERE created_at < cutoff_date 
      AND status IN ('completed', 'failed', 'cancelled');
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    -- Limpar eventos antigos (manter apenas métricas agregadas)
    DELETE FROM upsell_events 
    WHERE created_at < cutoff_date;
    
    GET DIAGNOSTICS deleted_count = deleted_count + ROW_COUNT;
    
    -- Limpar estados de conversa antigos
    DELETE FROM upsell_conversation_state 
    WHERE updated_at < cutoff_date;
    
    GET DIAGNOSTICS deleted_count = deleted_count + ROW_COUNT;
    
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Inserir configuração padrão para tenant 'default'
INSERT INTO upsell_config (tenant_id, enabled, delay_min, copy_a_weight, position_immediate_weight)
VALUES ('default', true, 10, 0.5, 0.5)
ON CONFLICT (tenant_id) DO NOTHING;

-- Comentários nas tabelas
COMMENT ON TABLE upsell_events IS 'Eventos de upsell para tracking e análise';
COMMENT ON TABLE upsell_scheduled_jobs IS 'Jobs agendados para execução futura de upsells';
COMMENT ON TABLE upsell_config IS 'Configurações por tenant do módulo de upsell';
COMMENT ON TABLE upsell_metrics_daily IS 'Métricas agregadas diárias para performance';
COMMENT ON TABLE upsell_conversation_state IS 'Estado de cada conversa para deduplicação';

COMMENT ON VIEW upsell_conversion_report IS 'Relatório de conversão por período e variante';
COMMENT ON VIEW upsell_service_performance IS 'Performance de upsell por serviço e addon';