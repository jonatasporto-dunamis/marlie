-- Migração para criar tabelas do módulo de catálogo
-- Arquivo: 20240101000000_create_catalog_tables.sql

-- Tabela principal de serviços profissionais sincronizados
CREATE TABLE IF NOT EXISTS servicos_prof (
    id SERIAL PRIMARY KEY,
    profissionalid INTEGER NOT NULL,
    servicoid INTEGER NOT NULL,
    nomeservico VARCHAR(255) NOT NULL,
    categoria VARCHAR(100) NOT NULL,
    nomeservico_normalizado VARCHAR(255) NOT NULL,
    categoria_normalizada VARCHAR(100) NOT NULL,
    preco DECIMAL(10,2),
    duracao INTEGER, -- em minutos
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
    ativo BOOLEAN DEFAULT true,
    sync_timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Constraint de unicidade para idempotência
    CONSTRAINT uk_servicos_prof_ids UNIQUE (profissionalid, servicoid)
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_servicos_prof_normalizado 
    ON servicos_prof USING btree (nomeservico_normalizado);

CREATE INDEX IF NOT EXISTS idx_servicos_prof_categoria_norm 
    ON servicos_prof USING btree (categoria_normalizada);

CREATE INDEX IF NOT EXISTS idx_servicos_prof_ativo 
    ON servicos_prof (ativo) WHERE ativo = true;

CREATE INDEX IF NOT EXISTS idx_servicos_prof_updated_at 
    ON servicos_prof (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_servicos_prof_sync_timestamp 
    ON servicos_prof (sync_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_servicos_prof_profissional 
    ON servicos_prof (profissionalid);

-- Índice composto para busca por popularidade
CREATE INDEX IF NOT EXISTS idx_servicos_prof_categoria_ativo 
    ON servicos_prof (categoria_normalizada, ativo) WHERE ativo = true;

-- Tabela para armazenar watermarks de sincronização
CREATE TABLE IF NOT EXISTS sync_watermarks (
    id SERIAL PRIMARY KEY,
    key VARCHAR(100) NOT NULL UNIQUE,
    value JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_watermarks_key 
    ON sync_watermarks (key);

CREATE INDEX IF NOT EXISTS idx_sync_watermarks_updated_at 
    ON sync_watermarks (updated_at DESC);

-- Tabela para snapshots diários (para relatórios de diff)
CREATE TABLE IF NOT EXISTS trinks_services_snapshot (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    profissionalid INTEGER NOT NULL,
    servicoid INTEGER NOT NULL,
    nomeservico VARCHAR(255) NOT NULL,
    categoria VARCHAR(100) NOT NULL,
    nomeservico_normalizado VARCHAR(255) NOT NULL,
    categoria_normalizada VARCHAR(100) NOT NULL,
    preco DECIMAL(10,2),
    duracao INTEGER,
    ativo BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Constraint de unicidade por data
    CONSTRAINT uk_snapshot_date_ids UNIQUE (snapshot_date, profissionalid, servicoid)
);

CREATE INDEX IF NOT EXISTS idx_snapshot_date 
    ON trinks_services_snapshot (snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_snapshot_prof_service 
    ON trinks_services_snapshot (profissionalid, servicoid);

-- Tabela para logs de sincronização
CREATE TABLE IF NOT EXISTS catalog_sync_logs (
    id SERIAL PRIMARY KEY,
    sync_type VARCHAR(50) NOT NULL, -- 'full', 'incremental', 'diff'
    status VARCHAR(20) NOT NULL, -- 'started', 'completed', 'failed'
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE,
    records_processed INTEGER DEFAULT 0,
    records_inserted INTEGER DEFAULT 0,
    records_updated INTEGER DEFAULT 0,
    records_failed INTEGER DEFAULT 0,
    error_message TEXT,
    watermark_before JSONB,
    watermark_after JSONB,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_type_status 
    ON catalog_sync_logs (sync_type, status);

CREATE INDEX IF NOT EXISTS idx_sync_logs_started_at 
    ON catalog_sync_logs (started_at DESC);

-- Extensão para busca por similaridade (se não existir)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Índice GIN para busca textual avançada
CREATE INDEX IF NOT EXISTS idx_servicos_prof_nome_gin 
    ON servicos_prof USING gin (nomeservico_normalizado gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_servicos_prof_categoria_gin 
    ON servicos_prof USING gin (categoria_normalizada gin_trgm_ops);

-- View para estatísticas rápidas
CREATE OR REPLACE VIEW v_catalog_stats AS
SELECT 
    COUNT(*) as total_services,
    COUNT(DISTINCT profissionalid) as total_professionals,
    COUNT(CASE WHEN ativo = true THEN 1 END) as active_services,
    COUNT(CASE WHEN ativo = false THEN 1 END) as inactive_services,
    COUNT(DISTINCT categoria_normalizada) as total_categories,
    MAX(updated_at) as last_service_update,
    MAX(sync_timestamp) as last_sync,
    MIN(sync_timestamp) as first_sync,
    AVG(preco) as avg_price,
    AVG(duracao) as avg_duration
FROM servicos_prof;

-- View para top categorias
CREATE OR REPLACE VIEW v_top_categories AS
SELECT 
    categoria_normalizada,
    categoria,
    COUNT(*) as service_count,
    COUNT(DISTINCT profissionalid) as professional_count,
    AVG(preco) as avg_price,
    AVG(duracao) as avg_duration
FROM servicos_prof 
WHERE ativo = true
GROUP BY categoria_normalizada, categoria
ORDER BY service_count DESC;

-- Função para normalizar nomes de serviços
CREATE OR REPLACE FUNCTION normalize_servico_nome(input_text TEXT)
RETURNS TEXT AS $$
DECLARE
    normalized TEXT;
BEGIN
    IF input_text IS NULL OR input_text = '' THEN
        RETURN '';
    END IF;
    
    -- Converte para minúsculo e remove acentos
    normalized := lower(unaccent(trim(input_text)));
    
    -- Remove símbolos especiais
    normalized := regexp_replace(normalized, '[/\-_•]', ' ', 'g');
    
    -- Colapsa espaços múltiplos
    normalized := regexp_replace(normalized, '\s+', ' ', 'g');
    
    -- Aplica mapeamento de sinônimos
    normalized := replace(normalized, 'progressiva', 'escova progressiva');
    normalized := replace(normalized, 'luzes', 'mechas/luzes');
    normalized := replace(normalized, 'pé e mão', 'mão e pé');
    normalized := replace(normalized, 'pe e mao', 'mão e pé');
    
    RETURN trim(normalized);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Trigger para atualizar automaticamente campos normalizados
CREATE OR REPLACE FUNCTION update_normalized_fields()
RETURNS TRIGGER AS $$
BEGIN
    NEW.nomeservico_normalizado := normalize_servico_nome(NEW.nomeservico);
    NEW.categoria_normalizada := normalize_servico_nome(NEW.categoria);
    NEW.sync_timestamp := NOW();
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_servicos_prof_normalize
    BEFORE INSERT OR UPDATE ON servicos_prof
    FOR EACH ROW
    EXECUTE FUNCTION update_normalized_fields();

-- Função para criar snapshot diário
CREATE OR REPLACE FUNCTION create_daily_snapshot(snapshot_date DATE DEFAULT CURRENT_DATE)
RETURNS INTEGER AS $$
DECLARE
    inserted_count INTEGER;
BEGIN
    -- Remove snapshot existente para a data
    DELETE FROM trinks_services_snapshot WHERE snapshot_date = $1;
    
    -- Insere novo snapshot
    INSERT INTO trinks_services_snapshot (
        snapshot_date, profissionalid, servicoid, nomeservico, categoria,
        nomeservico_normalizado, categoria_normalizada, preco, duracao, ativo
    )
    SELECT 
        $1, profissionalid, servicoid, nomeservico, categoria,
        nomeservico_normalizado, categoria_normalizada, preco, duracao, ativo
    FROM servicos_prof
    WHERE ativo = true;
    
    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    
    RETURN inserted_count;
END;
$$ LANGUAGE plpgsql;

-- Comentários nas tabelas
COMMENT ON TABLE servicos_prof IS 'Tabela principal de serviços profissionais sincronizados do Trinks';
COMMENT ON TABLE sync_watermarks IS 'Armazena watermarks de sincronização para controle incremental';
COMMENT ON TABLE trinks_services_snapshot IS 'Snapshots diários para relatórios de diferença';
COMMENT ON TABLE catalog_sync_logs IS 'Logs detalhados de operações de sincronização';

COMMENT ON COLUMN servicos_prof.profissionalid IS 'ID do profissional no sistema Trinks';
COMMENT ON COLUMN servicos_prof.servicoid IS 'ID do serviço no sistema Trinks';
COMMENT ON COLUMN servicos_prof.nomeservico_normalizado IS 'Nome do serviço normalizado para busca';
COMMENT ON COLUMN servicos_prof.categoria_normalizada IS 'Categoria normalizada para busca';
COMMENT ON COLUMN servicos_prof.sync_timestamp IS 'Timestamp da última sincronização deste registro';

-- Inserir watermark inicial se não existir
INSERT INTO sync_watermarks (key, value)
VALUES ('catalog:watermark', '{"updated_since_iso": "1970-01-01T00:00:00Z", "last_seen_iso": "1970-01-01T00:00:00Z", "sync_timestamp": "1970-01-01T00:00:00Z"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Commit da migração
COMMIT;