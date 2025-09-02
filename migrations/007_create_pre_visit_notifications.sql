-- Migração para sistema de notificações de pré-visita e No-Show Shield
-- Criada em: 2024-01-XX
-- Descrição: Tabelas para gerenciar lembretes automáticos e prevenção de no-show

-- Tabela principal de notificações de pré-visita
CREATE TABLE IF NOT EXISTS pre_visit_notifications (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(50) NOT NULL DEFAULT 'default',
    client_phone VARCHAR(20) NOT NULL,
    client_name VARCHAR(100) NOT NULL,
    service_name VARCHAR(100) NOT NULL,
    appointment_date DATE NOT NULL,
    appointment_time VARCHAR(10) NOT NULL,
    professional_name VARCHAR(100),
    notification_type VARCHAR(30) NOT NULL CHECK (notification_type IN (
        'reminder_24h', 'reminder_2h', 'confirmation', 'no_show_prevention'
    )),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'sent', 'failed', 'cancelled'
    )),
    scheduled_for TIMESTAMP NOT NULL,
    sent_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB DEFAULT '{}',
    
    -- Índices para performance
    INDEX idx_pre_visit_tenant_status (tenant_id, status),
    INDEX idx_pre_visit_scheduled (scheduled_for),
    INDEX idx_pre_visit_client (tenant_id, client_phone),
    INDEX idx_pre_visit_appointment (appointment_date, appointment_time)
);

-- Tabela para histórico de agendamentos (para tracking de no-shows)
CREATE TABLE IF NOT EXISTS appointment_history (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(50) NOT NULL DEFAULT 'default',
    client_phone VARCHAR(20) NOT NULL,
    client_name VARCHAR(100) NOT NULL,
    service_name VARCHAR(100) NOT NULL,
    professional_name VARCHAR(100),
    appointment_date DATE NOT NULL,
    appointment_time VARCHAR(10) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN (
        'scheduled', 'confirmed', 'completed', 'cancelled', 'no_show', 'rescheduled'
    )),
    original_appointment_id INTEGER, -- Para tracking de reagendamentos
    cancellation_reason TEXT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB DEFAULT '{}',
    
    -- Índices para performance
    INDEX idx_appointment_history_tenant_client (tenant_id, client_phone),
    INDEX idx_appointment_history_status (status),
    INDEX idx_appointment_history_date (appointment_date),
    INDEX idx_appointment_history_no_show (tenant_id, client_phone, status) WHERE status = 'no_show'
);

-- Tabela para configurações de No-Show Shield por tenant
CREATE TABLE IF NOT EXISTS no_show_shield_config (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(50) NOT NULL UNIQUE DEFAULT 'default',
    enabled BOOLEAN NOT NULL DEFAULT true,
    reminder_intervals INTEGER[] NOT NULL DEFAULT '{24, 2}', -- horas antes do agendamento
    confirmation_required BOOLEAN NOT NULL DEFAULT true,
    auto_reschedule_on_no_show BOOLEAN NOT NULL DEFAULT false,
    max_no_show_count INTEGER NOT NULL DEFAULT 3,
    prevention_message_template JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_no_show_config_tenant (tenant_id)
);

-- Tabela para tracking de clientes com histórico de no-show
CREATE TABLE IF NOT EXISTS client_no_show_tracking (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(50) NOT NULL DEFAULT 'default',
    client_phone VARCHAR(20) NOT NULL,
    client_name VARCHAR(100) NOT NULL,
    total_no_shows INTEGER NOT NULL DEFAULT 0,
    last_no_show_date DATE,
    prevention_messages_sent INTEGER NOT NULL DEFAULT 0,
    last_prevention_message_date TIMESTAMP,
    risk_level VARCHAR(20) NOT NULL DEFAULT 'low' CHECK (risk_level IN (
        'low', 'medium', 'high', 'critical'
    )),
    special_instructions TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(tenant_id, client_phone),
    INDEX idx_client_no_show_tenant_phone (tenant_id, client_phone),
    INDEX idx_client_no_show_risk (risk_level),
    INDEX idx_client_no_show_count (total_no_shows)
);

-- Função para atualizar timestamp de updated_at automaticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers para atualizar updated_at automaticamente
CREATE TRIGGER update_pre_visit_notifications_updated_at 
    BEFORE UPDATE ON pre_visit_notifications 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_appointment_history_updated_at 
    BEFORE UPDATE ON appointment_history 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_no_show_shield_config_updated_at 
    BEFORE UPDATE ON no_show_shield_config 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_client_no_show_tracking_updated_at 
    BEFORE UPDATE ON client_no_show_tracking 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Inserir configuração padrão para o tenant default
INSERT INTO no_show_shield_config (
    tenant_id, enabled, reminder_intervals, confirmation_required, 
    auto_reschedule_on_no_show, max_no_show_count, prevention_message_template
) VALUES (
    'default', 
    true, 
    '{24, 2}', 
    true, 
    false, 
    3,
    '{
        "baiano": "Oi {clientName}! 😊 Notei que você perdeu alguns agendamentos recentemente. Que tal reagendarmos com um horário que seja mais fácil pra você? Estou aqui para ajudar! 💖",
        "neutro": "Olá {clientName}! 😊 Vamos reagendar seu próximo horário? Quero garantir que você consiga vir. Me diga qual horário funciona melhor! 💖"
    }'
) ON CONFLICT (tenant_id) DO NOTHING;

-- Função para calcular nível de risco de no-show
CREATE OR REPLACE FUNCTION calculate_no_show_risk_level(no_show_count INTEGER)
RETURNS VARCHAR(20) AS $$
BEGIN
    CASE 
        WHEN no_show_count = 0 THEN RETURN 'low';
        WHEN no_show_count BETWEEN 1 AND 2 THEN RETURN 'medium';
        WHEN no_show_count BETWEEN 3 AND 4 THEN RETURN 'high';
        ELSE RETURN 'critical';
    END CASE;
END;
$$ LANGUAGE plpgsql;

-- Função para atualizar tracking de no-show automaticamente
CREATE OR REPLACE FUNCTION update_no_show_tracking()
RETURNS TRIGGER AS $$
BEGIN
    -- Só processa se o status mudou para 'no_show'
    IF NEW.status = 'no_show' AND (OLD.status IS NULL OR OLD.status != 'no_show') THEN
        INSERT INTO client_no_show_tracking (
            tenant_id, client_phone, client_name, total_no_shows, 
            last_no_show_date, risk_level
        ) VALUES (
            NEW.tenant_id, NEW.client_phone, NEW.client_name, 1, 
            NEW.appointment_date, 'medium'
        )
        ON CONFLICT (tenant_id, client_phone) 
        DO UPDATE SET 
            total_no_shows = client_no_show_tracking.total_no_shows + 1,
            last_no_show_date = NEW.appointment_date,
            risk_level = calculate_no_show_risk_level(client_no_show_tracking.total_no_shows + 1),
            updated_at = CURRENT_TIMESTAMP;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para atualizar tracking de no-show automaticamente
CREATE TRIGGER update_no_show_tracking_trigger
    AFTER INSERT OR UPDATE ON appointment_history
    FOR EACH ROW EXECUTE FUNCTION update_no_show_tracking();

-- View para estatísticas de notificações
CREATE OR REPLACE VIEW notification_stats AS
SELECT 
    tenant_id,
    notification_type,
    status,
    COUNT(*) as count,
    DATE(created_at) as date
FROM pre_visit_notifications
GROUP BY tenant_id, notification_type, status, DATE(created_at)
ORDER BY date DESC, tenant_id, notification_type;

-- View para clientes de alto risco
CREATE OR REPLACE VIEW high_risk_clients AS
SELECT 
    t.*,
    CASE 
        WHEN last_no_show_date >= CURRENT_DATE - INTERVAL '7 days' THEN 'recent'
        WHEN last_no_show_date >= CURRENT_DATE - INTERVAL '30 days' THEN 'moderate'
        ELSE 'old'
    END as recency
FROM client_no_show_tracking t
WHERE risk_level IN ('high', 'critical')
ORDER BY total_no_shows DESC, last_no_show_date DESC;

-- Comentários para documentação
COMMENT ON TABLE pre_visit_notifications IS 'Armazena todas as notificações de pré-visita agendadas e enviadas';
COMMENT ON TABLE appointment_history IS 'Histórico completo de agendamentos para tracking de no-shows';
COMMENT ON TABLE no_show_shield_config IS 'Configurações do sistema No-Show Shield por tenant';
COMMENT ON TABLE client_no_show_tracking IS 'Tracking de clientes com histórico de no-show para prevenção';
COMMENT ON VIEW notification_stats IS 'Estatísticas agregadas de notificações por tipo e status';
COMMENT ON VIEW high_risk_clients IS 'Clientes com alto risco de no-show para monitoramento especial';

-- Índices adicionais para performance em consultas específicas
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pre_visit_notifications_processing 
    ON pre_visit_notifications (tenant_id, status, scheduled_for) 
    WHERE status = 'pending';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appointment_history_recent_no_shows 
    ON appointment_history (tenant_id, client_phone, appointment_date) 
    WHERE status = 'no_show' AND appointment_date >= CURRENT_DATE - INTERVAL '90 days';

-- Grants de permissão (ajustar conforme necessário)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
-- GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_user;

COMMIT;