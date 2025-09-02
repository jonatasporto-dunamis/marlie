-- Tabelas para o motor de recomendação e funcionalidades avançadas

-- Tabela para preferências de horário por usuário
CREATE TABLE IF NOT EXISTS user_time_preferences (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) NOT NULL,
    time_slot TIME NOT NULL,
    frequency INTEGER DEFAULT 1,
    last_used TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(phone_number, time_slot)
);

-- Tabela para preferências de serviço por usuário
CREATE TABLE IF NOT EXISTS user_service_preferences (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) NOT NULL,
    service_name VARCHAR(255) NOT NULL,
    frequency INTEGER DEFAULT 1,
    last_used TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(phone_number, service_name)
);

-- Tabela para preferências de profissional por usuário
CREATE TABLE IF NOT EXISTS user_professional_preferences (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) NOT NULL,
    professional_name VARCHAR(255) NOT NULL,
    frequency INTEGER DEFAULT 1,
    last_used TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(phone_number, professional_name)
);

-- Tabela para rastrear interações pós-agendamento
CREATE TABLE IF NOT EXISTS post_booking_interactions (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) NOT NULL,
    booking_id VARCHAR(255),
    interaction_type VARCHAR(50) NOT NULL, -- 'reminder_request', 'location_request', 'payment_preference', etc.
    interaction_data JSONB,
    response_received BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    responded_at TIMESTAMP
);

-- Tabela para rastrear upsells oferecidos e aceitos
CREATE TABLE IF NOT EXISTS upsell_tracking (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) NOT NULL,
    original_service VARCHAR(255) NOT NULL,
    suggested_service VARCHAR(255) NOT NULL,
    additional_price DECIMAL(10,2),
    offered_at TIMESTAMP DEFAULT NOW(),
    accepted BOOLEAN DEFAULT FALSE,
    accepted_at TIMESTAMP,
    booking_id VARCHAR(255)
);

-- Tabela para mensagens de pré-visita e no-show shield
CREATE TABLE IF NOT EXISTS pre_visit_messages (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) NOT NULL,
    booking_id VARCHAR(255) NOT NULL,
    message_type VARCHAR(50) NOT NULL, -- 'pre_visit', 'no_show_shield'
    scheduled_for TIMESTAMP NOT NULL,
    sent_at TIMESTAMP,
    response_received BOOLEAN DEFAULT FALSE,
    response_content TEXT,
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'sent', 'delivered', 'failed'
    created_at TIMESTAMP DEFAULT NOW()
);

-- Tabela para rastrear first-try bookings (métricas de recomendação)
CREATE TABLE IF NOT EXISTS booking_metrics (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) NOT NULL,
    booking_id VARCHAR(255) NOT NULL,
    first_try_booking BOOLEAN DEFAULT FALSE,
    suggestions_offered INTEGER DEFAULT 0,
    suggestion_accepted_position INTEGER, -- qual posição da sugestão foi aceita (1, 2, 3)
    total_messages_to_book INTEGER DEFAULT 0,
    upsell_offered BOOLEAN DEFAULT FALSE,
    upsell_accepted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Tabela para configurações A/B testing
CREATE TABLE IF NOT EXISTS ab_test_assignments (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) NOT NULL,
    test_name VARCHAR(100) NOT NULL,
    variant VARCHAR(50) NOT NULL, -- 'control', 'treatment'
    assigned_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(phone_number, test_name)
);

-- Tabela para logs de atalhos utilizados
CREATE TABLE IF NOT EXISTS shortcut_usage (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) NOT NULL,
    shortcut_type VARCHAR(50) NOT NULL, -- 'remarcar', 'cancelar', 'preco', 'endereco'
    context_data JSONB,
    successful BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Tabela para rastrear cancelamentos e motivos
CREATE TABLE IF NOT EXISTS cancellation_tracking (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) NOT NULL,
    booking_id VARCHAR(255) NOT NULL,
    original_service VARCHAR(255),
    original_date_time TIMESTAMP,
    cancellation_reason TEXT,
    cancelled_at TIMESTAMP DEFAULT NOW(),
    rescheduled BOOLEAN DEFAULT FALSE,
    new_booking_id VARCHAR(255)
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_user_time_preferences_phone ON user_time_preferences(phone_number);
CREATE INDEX IF NOT EXISTS idx_user_time_preferences_frequency ON user_time_preferences(frequency DESC, last_used DESC);

CREATE INDEX IF NOT EXISTS idx_user_service_preferences_phone ON user_service_preferences(phone_number);
CREATE INDEX IF NOT EXISTS idx_user_service_preferences_frequency ON user_service_preferences(frequency DESC, last_used DESC);

CREATE INDEX IF NOT EXISTS idx_user_professional_preferences_phone ON user_professional_preferences(phone_number);
CREATE INDEX IF NOT EXISTS idx_user_professional_preferences_frequency ON user_professional_preferences(frequency DESC, last_used DESC);

CREATE INDEX IF NOT EXISTS idx_post_booking_interactions_phone ON post_booking_interactions(phone_number);
CREATE INDEX IF NOT EXISTS idx_post_booking_interactions_type ON post_booking_interactions(interaction_type);
CREATE INDEX IF NOT EXISTS idx_post_booking_interactions_created ON post_booking_interactions(created_at);

CREATE INDEX IF NOT EXISTS idx_upsell_tracking_phone ON upsell_tracking(phone_number);
CREATE INDEX IF NOT EXISTS idx_upsell_tracking_offered ON upsell_tracking(offered_at);
CREATE INDEX IF NOT EXISTS idx_upsell_tracking_accepted ON upsell_tracking(accepted);

CREATE INDEX IF NOT EXISTS idx_pre_visit_messages_phone ON pre_visit_messages(phone_number);
CREATE INDEX IF NOT EXISTS idx_pre_visit_messages_scheduled ON pre_visit_messages(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_pre_visit_messages_status ON pre_visit_messages(status);

CREATE INDEX IF NOT EXISTS idx_booking_metrics_phone ON booking_metrics(phone_number);
CREATE INDEX IF NOT EXISTS idx_booking_metrics_first_try ON booking_metrics(first_try_booking);
CREATE INDEX IF NOT EXISTS idx_booking_metrics_created ON booking_metrics(created_at);

CREATE INDEX IF NOT EXISTS idx_ab_test_assignments_phone ON ab_test_assignments(phone_number);
CREATE INDEX IF NOT EXISTS idx_ab_test_assignments_test ON ab_test_assignments(test_name);

CREATE INDEX IF NOT EXISTS idx_shortcut_usage_phone ON shortcut_usage(phone_number);
CREATE INDEX IF NOT EXISTS idx_shortcut_usage_type ON shortcut_usage(shortcut_type);
CREATE INDEX IF NOT EXISTS idx_shortcut_usage_created ON shortcut_usage(created_at);

CREATE INDEX IF NOT EXISTS idx_cancellation_tracking_phone ON cancellation_tracking(phone_number);
CREATE INDEX IF NOT EXISTS idx_cancellation_tracking_cancelled ON cancellation_tracking(cancelled_at);

-- Triggers para atualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_user_time_preferences_updated_at
    BEFORE UPDATE ON user_time_preferences
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_service_preferences_updated_at
    BEFORE UPDATE ON user_service_preferences
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_professional_preferences_updated_at
    BEFORE UPDATE ON user_professional_preferences
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Views para análises e métricas

-- View para estatísticas de first-try booking
CREATE OR REPLACE VIEW first_try_booking_stats AS
SELECT 
    DATE_TRUNC('day', created_at) as date,
    COUNT(*) as total_bookings,
    COUNT(CASE WHEN first_try_booking = true THEN 1 END) as first_try_bookings,
    ROUND(
        (COUNT(CASE WHEN first_try_booking = true THEN 1 END)::DECIMAL / COUNT(*)) * 100, 
        2
    ) as first_try_rate
FROM booking_metrics
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY DATE_TRUNC('day', created_at)
ORDER BY date DESC;

-- View para análise de upsells
CREATE OR REPLACE VIEW upsell_performance AS
SELECT 
    original_service,
    suggested_service,
    COUNT(*) as times_offered,
    COUNT(CASE WHEN accepted = true THEN 1 END) as times_accepted,
    ROUND(
        (COUNT(CASE WHEN accepted = true THEN 1 END)::DECIMAL / COUNT(*)) * 100, 
        2
    ) as acceptance_rate,
    AVG(additional_price) as avg_additional_price
FROM upsell_tracking
WHERE offered_at >= NOW() - INTERVAL '30 days'
GROUP BY original_service, suggested_service
ORDER BY acceptance_rate DESC, times_offered DESC;

-- View para análise de horários mais populares
CREATE OR REPLACE VIEW popular_time_slots AS
SELECT 
    time_slot,
    COUNT(*) as total_bookings,
    COUNT(DISTINCT phone_number) as unique_users,
    AVG(frequency) as avg_frequency
FROM user_time_preferences
GROUP BY time_slot
ORDER BY total_bookings DESC, avg_frequency DESC;

-- View para análise de uso de atalhos
CREATE OR REPLACE VIEW shortcut_usage_stats AS
SELECT 
    shortcut_type,
    COUNT(*) as total_usage,
    COUNT(DISTINCT phone_number) as unique_users,
    COUNT(CASE WHEN successful = true THEN 1 END) as successful_usage,
    ROUND(
        (COUNT(CASE WHEN successful = true THEN 1 END)::DECIMAL / COUNT(*)) * 100, 
        2
    ) as success_rate
FROM shortcut_usage
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY shortcut_type
ORDER BY total_usage DESC;

-- Inserir dados de exemplo para testes (opcional)
-- Descomente as linhas abaixo se quiser dados de exemplo

/*
-- Exemplo de preferências de horário
INSERT INTO user_time_preferences (phone_number, time_slot, frequency, last_used) VALUES
('5571999999999', '14:00', 5, NOW() - INTERVAL '2 days'),
('5571999999999', '15:30', 3, NOW() - INTERVAL '1 week'),
('5571888888888', '10:00', 4, NOW() - INTERVAL '3 days'),
('5571888888888', '16:00', 2, NOW() - INTERVAL '2 weeks');

-- Exemplo de preferências de serviço
INSERT INTO user_service_preferences (phone_number, service_name, frequency, last_used) VALUES
('5571999999999', 'Cutilagem', 8, NOW() - INTERVAL '1 day'),
('5571999999999', 'Esmaltação', 3, NOW() - INTERVAL '1 week'),
('5571888888888', 'Manicure Completa', 5, NOW() - INTERVAL '2 days');

-- Exemplo de configuração A/B test
INSERT INTO ab_test_assignments (phone_number, test_name, variant) VALUES
('5571999999999', 'proactive_suggestions', 'treatment'),
('5571888888888', 'proactive_suggestions', 'control');
*/

-- Comentários sobre as tabelas:
-- 
-- user_time_preferences: Armazena os horários que cada usuário mais escolhe
-- user_service_preferences: Armazena os serviços que cada usuário mais agenda
-- user_professional_preferences: Armazena os profissionais preferidos de cada usuário
-- post_booking_interactions: Rastreia CTAs pós-agendamento (lembrete, localização, etc.)
-- upsell_tracking: Rastreia ofertas de upsell e suas taxas de aceitação
-- pre_visit_messages: Gerencia mensagens automáticas de pré-visita e no-show shield
-- booking_metrics: Métricas de performance do sistema de recomendação
-- ab_test_assignments: Controla testes A/B para diferentes funcionalidades
-- shortcut_usage: Rastreia uso de atalhos (remarcar, cancelar, preço, endereço)
-- cancellation_tracking: Rastreia cancelamentos e seus motivos