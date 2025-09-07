-- Migração 016: Tabela de auditoria de divergências
-- Criada em: 2024-01-XX
-- Descrição: Sistema de auditoria para detectar divergências entre agenda real e notificações

-- Tabela principal de divergências
CREATE TABLE IF NOT EXISTS audit_divergences (
    id VARCHAR(255) PRIMARY KEY,
    tenant_id VARCHAR(100) NOT NULL,
    audit_date DATE NOT NULL,
    appointment_id VARCHAR(255) NOT NULL,
    patient_phone VARCHAR(20) NOT NULL,
    appointment_start TIMESTAMP NOT NULL,
    professional_name VARCHAR(255) NOT NULL,
    service_name VARCHAR(255) NOT NULL,
    divergence_type VARCHAR(50) NOT NULL CHECK (divergence_type IN ('missing_notification', 'extra_notification', 'wrong_timing')),
    expected_notification VARCHAR(50) NOT NULL,
    actual_notification VARCHAR(50),
    severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
    resolved BOOLEAN DEFAULT FALSE,
    resolved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_audit_divergences_tenant_date ON audit_divergences(tenant_id, audit_date);
CREATE INDEX IF NOT EXISTS idx_audit_divergences_appointment ON audit_divergences(appointment_id);
CREATE INDEX IF NOT EXISTS idx_audit_divergences_type ON audit_divergences(divergence_type);
CREATE INDEX IF NOT EXISTS idx_audit_divergences_severity ON audit_divergences(severity);
CREATE INDEX IF NOT EXISTS idx_audit_divergences_resolved ON audit_divergences(resolved);
CREATE INDEX IF NOT EXISTS idx_audit_divergences_created ON audit_divergences(created_at);

-- Trigger para atualizar updated_at
CREATE OR REPLACE FUNCTION update_audit_divergences_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_audit_divergences_updated_at
    BEFORE UPDATE ON audit_divergences
    FOR EACH ROW
    EXECUTE FUNCTION update_audit_divergences_updated_at();

-- Tabela de estatísticas diárias de auditoria
CREATE TABLE IF NOT EXISTS audit_daily_stats (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(100) NOT NULL,
    audit_date DATE NOT NULL,
    total_appointments INTEGER NOT NULL DEFAULT 0,
    total_notifications INTEGER NOT NULL DEFAULT 0,
    total_divergences INTEGER NOT NULL DEFAULT 0,
    divergence_rate DECIMAL(5,4) NOT NULL DEFAULT 0,
    missing_notifications INTEGER NOT NULL DEFAULT 0,
    extra_notifications INTEGER NOT NULL DEFAULT 0,
    wrong_timing INTEGER NOT NULL DEFAULT 0,
    high_severity INTEGER NOT NULL DEFAULT 0,
    medium_severity INTEGER NOT NULL DEFAULT 0,
    low_severity INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(tenant_id, audit_date)
);

-- Índices para audit_daily_stats
CREATE INDEX IF NOT EXISTS idx_audit_daily_stats_tenant_date ON audit_daily_stats(tenant_id, audit_date);
CREATE INDEX IF NOT EXISTS idx_audit_daily_stats_rate ON audit_daily_stats(divergence_rate);

-- Trigger para atualizar updated_at em audit_daily_stats
CREATE TRIGGER trigger_audit_daily_stats_updated_at
    BEFORE UPDATE ON audit_daily_stats
    FOR EACH ROW
    EXECUTE FUNCTION update_audit_divergences_updated_at();

-- Função para calcular e salvar estatísticas diárias
CREATE OR REPLACE FUNCTION calculate_daily_audit_stats(
    p_tenant_id VARCHAR(100),
    p_audit_date DATE
)
RETURNS VOID AS $$
DECLARE
    v_total_appointments INTEGER;
    v_total_notifications INTEGER;
    v_total_divergences INTEGER;
    v_divergence_rate DECIMAL(5,4);
    v_missing_notifications INTEGER;
    v_extra_notifications INTEGER;
    v_wrong_timing INTEGER;
    v_high_severity INTEGER;
    v_medium_severity INTEGER;
    v_low_severity INTEGER;
BEGIN
    -- Contar divergências por tipo
    SELECT 
        COUNT(*) FILTER (WHERE divergence_type = 'missing_notification'),
        COUNT(*) FILTER (WHERE divergence_type = 'extra_notification'),
        COUNT(*) FILTER (WHERE divergence_type = 'wrong_timing'),
        COUNT(*) FILTER (WHERE severity = 'high'),
        COUNT(*) FILTER (WHERE severity = 'medium'),
        COUNT(*) FILTER (WHERE severity = 'low'),
        COUNT(*)
    INTO 
        v_missing_notifications,
        v_extra_notifications,
        v_wrong_timing,
        v_high_severity,
        v_medium_severity,
        v_low_severity,
        v_total_divergences
    FROM audit_divergences
    WHERE tenant_id = p_tenant_id
    AND audit_date = p_audit_date;

    -- Contar notificações do dia
    SELECT COUNT(*)
    INTO v_total_notifications
    FROM notifications_log
    WHERE tenant_id = p_tenant_id
    AND DATE(sent_at) = p_audit_date;

    -- Estimar total de agendamentos (baseado em divergências + notificações únicas)
    v_total_appointments := GREATEST(v_total_notifications, v_total_divergences);
    
    -- Calcular taxa de divergência
    v_divergence_rate := CASE 
        WHEN v_total_appointments > 0 THEN 
            ROUND(v_total_divergences::DECIMAL / v_total_appointments, 4)
        ELSE 0
    END;

    -- Inserir ou atualizar estatísticas
    INSERT INTO audit_daily_stats (
        tenant_id, audit_date, total_appointments, total_notifications,
        total_divergences, divergence_rate, missing_notifications,
        extra_notifications, wrong_timing, high_severity,
        medium_severity, low_severity
    ) VALUES (
        p_tenant_id, p_audit_date, v_total_appointments, v_total_notifications,
        v_total_divergences, v_divergence_rate, v_missing_notifications,
        v_extra_notifications, v_wrong_timing, v_high_severity,
        v_medium_severity, v_low_severity
    )
    ON CONFLICT (tenant_id, audit_date)
    DO UPDATE SET
        total_appointments = EXCLUDED.total_appointments,
        total_notifications = EXCLUDED.total_notifications,
        total_divergences = EXCLUDED.total_divergences,
        divergence_rate = EXCLUDED.divergence_rate,
        missing_notifications = EXCLUDED.missing_notifications,
        extra_notifications = EXCLUDED.extra_notifications,
        wrong_timing = EXCLUDED.wrong_timing,
        high_severity = EXCLUDED.high_severity,
        medium_severity = EXCLUDED.medium_severity,
        low_severity = EXCLUDED.low_severity,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- View para relatório de divergências
CREATE OR REPLACE VIEW v_audit_divergences_report AS
SELECT 
    ad.*,
    CASE 
        WHEN ad.divergence_type = 'missing_notification' THEN 'Notificação não enviada'
        WHEN ad.divergence_type = 'extra_notification' THEN 'Notificação órfã'
        WHEN ad.divergence_type = 'wrong_timing' THEN 'Timing incorreto'
    END as divergence_type_description,
    CASE 
        WHEN ad.severity = 'high' THEN 'Alta'
        WHEN ad.severity = 'medium' THEN 'Média'
        WHEN ad.severity = 'low' THEN 'Baixa'
    END as severity_description,
    DATE_PART('day', NOW() - ad.created_at) as days_since_created
FROM audit_divergences ad
ORDER BY ad.created_at DESC;

-- View para dashboard de auditoria
CREATE OR REPLACE VIEW v_audit_dashboard AS
SELECT 
    tenant_id,
    audit_date,
    total_appointments,
    total_notifications,
    total_divergences,
    ROUND(divergence_rate * 100, 2) as divergence_rate_percent,
    missing_notifications,
    extra_notifications,
    wrong_timing,
    high_severity,
    medium_severity,
    low_severity,
    CASE 
        WHEN divergence_rate > 0.1 THEN 'Crítico'
        WHEN divergence_rate > 0.05 THEN 'Atenção'
        ELSE 'Normal'
    END as status
FROM audit_daily_stats
ORDER BY audit_date DESC;

-- Função para limpeza de dados antigos
CREATE OR REPLACE FUNCTION cleanup_old_audit_data(
    p_tenant_id VARCHAR(100),
    p_days_to_keep INTEGER DEFAULT 90
)
RETURNS INTEGER AS $$
DECLARE
    v_deleted_count INTEGER;
BEGIN
    -- Deletar divergências antigas resolvidas
    DELETE FROM audit_divergences
    WHERE tenant_id = p_tenant_id
    AND resolved = true
    AND created_at < NOW() - INTERVAL '1 day' * p_days_to_keep;
    
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    
    -- Deletar estatísticas muito antigas
    DELETE FROM audit_daily_stats
    WHERE tenant_id = p_tenant_id
    AND audit_date < CURRENT_DATE - INTERVAL '1 day' * (p_days_to_keep * 2);
    
    RETURN v_deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Política RLS para isolamento de tenants
ALTER TABLE audit_divergences ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_daily_stats ENABLE ROW LEVEL SECURITY;

-- Política para audit_divergences
CREATE POLICY audit_divergences_tenant_isolation ON audit_divergences
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true));

-- Política para audit_daily_stats
CREATE POLICY audit_daily_stats_tenant_isolation ON audit_daily_stats
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true));

-- Comentários para documentação
COMMENT ON TABLE audit_divergences IS 'Registro de divergências detectadas entre agenda real e notificações enviadas';
COMMENT ON TABLE audit_daily_stats IS 'Estatísticas diárias consolidadas de auditoria';
COMMENT ON FUNCTION calculate_daily_audit_stats IS 'Calcula e salva estatísticas diárias de auditoria';
COMMENT ON FUNCTION cleanup_old_audit_data IS 'Remove dados antigos de auditoria para otimização';
COMMENT ON VIEW v_audit_divergences_report IS 'View formatada para relatórios de divergências';
COMMENT ON VIEW v_audit_dashboard IS 'View para dashboard de auditoria com métricas consolidadas';